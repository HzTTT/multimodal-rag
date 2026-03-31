/**
 * 文件监听服务
 */

import chokidar, { type FSWatcher } from "chokidar";
import { stat, readdir, realpath, readFile, writeFile, mkdir } from "node:fs/promises";
import { basename, extname, resolve, join, dirname } from "node:path";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { resolveMediaCreatedAt } from "./media-timestamps.js";
import type {
  MediaType,
  PluginConfig,
  IndexEventCallbacks,
  MediaEntry,
  IEmbeddingProvider,
  IMediaProcessor,
} from "./types.js";
import type { MediaStorage } from "./storage.js";

const AUDIO_FAILURE_PATTERN = /^[（(]\s*转录失败[:：]/;
const BROKEN_FILES_STATE_SUFFIX = ".broken-files.json";
const RECENTLY_DELETED_ENTRY_TTL_MS = 60_000;

type BrokenFileRecord = {
  mtimeMs: number;
  size: number;
  error: string;
  markedAt: number;
};

type RecentlyDeletedEntrySnapshot = {
  entry: MediaEntry;
  deletedAt: number;
  sourcePath: string;
};

type MovedSourceCandidate = {
  entry: MediaEntry;
  source: "cache" | "storage";
};

type FileStatSnapshot = {
  size: number;
  mtimeMs: number;
  birthtimeMs: number;
};

/**
 * 扩展路径中的 ~ 为用户主目录
 */
function expandPath(p: string): string {
  if (p.startsWith("~/")) {
    return resolve(homedir(), p.slice(2));
  }
  if (p === "~") {
    return homedir();
  }
  return p;
}

/**
 * 文件监听器
 */
export class MediaWatcher {
  private watcher: FSWatcher | null = null;
  private processQueue: Set<string> = new Set();
  private processing = false;
  private processingFilePath: string | null = null;
  private debounceTimers: Map<string, NodeJS.Timeout> = new Map();
  private retryTimers: Set<NodeJS.Timeout> = new Set();
  private failedFiles: Map<string, { attempts: number; lastError: string }> = new Map();
  private brokenFiles: Map<string, BrokenFileRecord> = new Map();
  private recentlyDeletedEntriesByHash: Map<string, RecentlyDeletedEntrySnapshot[]> = new Map();
  private readonly recentlyDeletedEntryTtlMs = RECENTLY_DELETED_ENTRY_TTL_MS;
  private readonly brokenFilesStatePath: string;
  private ollamaHealthy = true;
  private lastOllamaCheck = 0;

  constructor(
    private readonly config: PluginConfig,
    private readonly storage: MediaStorage,
    private readonly embeddings: IEmbeddingProvider,
    private readonly processor: IMediaProcessor,
    private readonly logger: { info?: (msg: string) => void; warn?: (msg: string) => void },
    private readonly callbacks?: IndexEventCallbacks,
  ) {
    const resolvedDbPath = resolve(expandPath(this.config.dbPath));
    this.brokenFilesStatePath = `${resolvedDbPath}${BROKEN_FILES_STATE_SUFFIX}`;
  }

  /**
   * 启动监听
   */
  async start(): Promise<boolean> {
    if (this.watcher) {
      return true;
    }

    const { watchPaths, fileTypes, watchDebounceMs } = this.config;

    if (this.config.embedding.provider === "openai" && !this.config.embedding.openaiApiKey) {
      this.logger.warn?.(
        "Background indexing disabled: embedding.provider=openai 但未配置 embedding.openaiApiKey",
      );
      return false;
    }

    if (watchPaths.length === 0) {
      this.logger.warn?.("No watch paths configured, file watching disabled");
      return false;
    }

    await this.loadBrokenFilesState();

    // 扩展 ~ 为用户主目录
    const expandedPaths = watchPaths.map(expandPath);
    this.logger.info?.(`Expanded watch paths: ${expandedPaths.join(", ")}`);

    // 支持的文件扩展名
    const supportedExts = [...fileTypes.image, ...fileTypes.audio];

    this.watcher = chokidar.watch(expandedPaths, {
      // 忽略隐藏文件，但不忽略 watchPaths 本身及其父目录
      // 原因：watchPaths 可能在 ~/.openclaw 这类隐藏目录下，正则 /\../ 会误匹配父路径
      ignored: (filePath: string) => {
        const base = filePath.split("/").pop() ?? "";
        if (!base.startsWith(".")) return false;
        // 如果这条路径是某个 watchPath 的前缀（父目录或本身），不忽略
        for (const wp of expandedPaths) {
          if (wp.startsWith(filePath)) return false;
        }
        return true;
      },
      persistent: true,
      ignoreInitial: !this.config.indexExistingOnStart,
      awaitWriteFinish: {
        stabilityThreshold: 2000,
        pollInterval: 100,
      },
    });

    this.watcher.on("add", (filePath: string) => {
      const ext = extname(filePath).toLowerCase();
      if (!supportedExts.includes(ext)) {
        return;
      }

      // 去抖动：避免重复处理
      const existingTimer = this.debounceTimers.get(filePath);
      if (existingTimer) {
        clearTimeout(existingTimer);
      }

      const timer = setTimeout(() => {
        this.debounceTimers.delete(filePath);
        void this.enqueueFileWithBrokenFileGuard(filePath);
      }, watchDebounceMs);

      this.debounceTimers.set(filePath, timer);
    });

    this.watcher.on("change", (filePath: string) => {
      const ext = extname(filePath).toLowerCase();
      if (!supportedExts.includes(ext)) {
        return;
      }

      // 文件变更：重新索引
      const existingTimer = this.debounceTimers.get(filePath);
      if (existingTimer) {
        clearTimeout(existingTimer);
      }

      const timer = setTimeout(() => {
        this.debounceTimers.delete(filePath);
        void this.enqueueFileWithBrokenFileGuard(filePath);
      }, watchDebounceMs);

      this.debounceTimers.set(filePath, timer);
    });

    this.watcher.on("unlink", (filePath: string) => {
      const ext = extname(filePath).toLowerCase();
      if (!supportedExts.includes(ext)) {
        return;
      }
      void this.handleFileDeleted(filePath);
    });

    this.watcher.on("ready", () => {
      this.logger.info?.(
        `Watching ${watchPaths.length} path(s) for media files`,
      );

      // 启动后先做一次“索引存在但源文件缺失”的自愈清理（异步执行，不阻塞）
      this.cleanupMissingIndexedFiles().catch((error) => {
        this.logger.warn?.(`Cleanup missing indexed files failed: ${String(error)}`);
      });

      // 启动时扫描并索引缺失的文件（异步执行，不阻塞）
      this.scanAndIndexMissingFiles(expandedPaths, supportedExts).catch((error) => {
        this.logger.warn?.(`Scan failed: ${String(error)}`);
      });
    });

    this.watcher.on("error", (error: unknown) => {
      this.logger.warn?.(`Watcher error: ${String(error)}`);
    });

    return true;
  }

  /**
   * 停止监听
   */
  async stop(): Promise<void> {
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }

    this.callbacks?.dispose?.();

    // 清理去抖动定时器
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();
    for (const timer of this.retryTimers.values()) {
      clearTimeout(timer);
    }
    this.retryTimers.clear();
    this.processQueue.clear();
    this.failedFiles.clear();
    this.recentlyDeletedEntriesByHash.clear();
    this.processing = false;
    this.processingFilePath = null;
  }

  /**
   * 将文件加入处理队列
   */
  private enqueueFile(filePath: string): void {
    this.processQueue.add(filePath);
    // 通知回调：文件已入队
    this.callbacks?.onFileQueued(filePath);
    this.processNextFile();
  }

  private async enqueueFileWithBrokenFileGuard(filePath: string): Promise<void> {
    if (await this.shouldSkipBrokenFile(filePath)) {
      const ext = extname(filePath).toLowerCase();
      const fileType: MediaType = this.config.fileTypes.image.includes(ext) ? "image" : "audio";
      this.callbacks?.onFileSkipped?.(filePath, fileType, "broken");
      this.logger.info?.(`Skipping previously broken file: ${filePath}`);
      return;
    }
    this.enqueueFile(filePath);
  }

  private async handleFileDeleted(filePath: string): Promise<void> {
    this.pruneRecentlyDeletedEntries();
    const ext = extname(filePath).toLowerCase();
    const fileType: MediaType = this.config.fileTypes.image.includes(ext) ? "image" : "audio";
    const timer = this.debounceTimers.get(filePath);
    if (timer) {
      clearTimeout(timer);
      this.debounceTimers.delete(filePath);
    }
    const removedFromQueue = this.processQueue.delete(filePath);
    this.failedFiles.delete(filePath);
    if (removedFromQueue) {
      this.callbacks?.onFileSkipped?.(filePath, fileType, "deleted");
    }

    const indexedEntry = await this.storage.findByPath(filePath);
    if (indexedEntry) {
      this.rememberRecentlyDeletedEntry(indexedEntry, filePath);
    }

    const removed = await this.removeIndexedEntryForDeletedFile(filePath);
    if (removed > 0) {
      this.logger.info?.(`Removed ${removed} indexed entr${removed > 1 ? "ies" : "y"} for deleted file: ${filePath}`);
    } else {
      this.logger.info?.(`Deleted file not found in index: ${filePath}`);
    }
  }

  private logEvent(
    level: "info" | "warn",
    event: string,
    fields: Record<string, unknown>,
  ): void {
    const payload = { event, ...fields };
    if (level === "warn") {
      this.logger.warn?.(JSON.stringify(payload));
      return;
    }
    this.logger.info?.(JSON.stringify(payload));
  }

  private classifyError(errorMsg: string): string {
    const normalized = errorMsg.toLowerCase();
    if (normalized.includes("enoent") || normalized.includes("enotdir")) {
      return "missing_file";
    }
    if (this.isTransientIndexingError(errorMsg)) {
      return "transient";
    }
    if (normalized.includes("whisper")) {
      return "whisper";
    }
    if (normalized.includes("ollama")) {
      return "ollama";
    }
    return "unknown";
  }

  private pruneRecentlyDeletedEntries(now = Date.now()): void {
    for (const [fileHash, snapshots] of this.recentlyDeletedEntriesByHash.entries()) {
      const validSnapshots = snapshots.filter(
        (snapshot) => now - snapshot.deletedAt <= this.recentlyDeletedEntryTtlMs,
      );
      if (validSnapshots.length === 0) {
        this.recentlyDeletedEntriesByHash.delete(fileHash);
        continue;
      }
      this.recentlyDeletedEntriesByHash.set(fileHash, validSnapshots);
    }
  }

  private rememberRecentlyDeletedEntry(entry: MediaEntry, sourcePath: string): void {
    if (!entry.fileHash) {
      return;
    }
    const snapshots = this.recentlyDeletedEntriesByHash.get(entry.fileHash) ?? [];
    snapshots.push({
      entry,
      deletedAt: Date.now(),
      sourcePath,
    });
    this.recentlyDeletedEntriesByHash.set(entry.fileHash, snapshots);
  }

  private consumeRecentlyDeletedEntry(fileHash: string, entryId: string, sourcePath: string): void {
    const snapshots = this.recentlyDeletedEntriesByHash.get(fileHash);
    if (!snapshots || snapshots.length === 0) {
      return;
    }
    const nextSnapshots = snapshots.filter(
      (snapshot) => snapshot.entry.id !== entryId && snapshot.sourcePath !== sourcePath,
    );
    if (nextSnapshots.length === 0) {
      this.recentlyDeletedEntriesByHash.delete(fileHash);
      return;
    }
    this.recentlyDeletedEntriesByHash.set(fileHash, nextSnapshots);
  }

  private async isPathMissing(filePath: string): Promise<boolean> {
    try {
      await stat(filePath);
      return false;
    } catch (error) {
      if (this.isFileMissingError(error)) {
        return true;
      }
      return false;
    }
  }

  private async findMovedSourceByHash(
    fileHash: string,
    fileType: MediaType,
  ): Promise<MovedSourceCandidate | null> {
    this.pruneRecentlyDeletedEntries();

    const cachedCandidates = this.recentlyDeletedEntriesByHash.get(fileHash) ?? [];
    for (let i = cachedCandidates.length - 1; i >= 0; i--) {
      const candidate = cachedCandidates[i];
      if (candidate.entry.fileType !== fileType) {
        continue;
      }
      if (await this.isPathMissing(candidate.entry.filePath)) {
        return {
          entry: candidate.entry,
          source: "cache",
        };
      }
    }

    const indexedCandidates = await this.storage.findEntriesByHash(fileHash);
    for (const candidate of indexedCandidates) {
      if (candidate.fileType !== fileType) {
        continue;
      }
      if (await this.isPathMissing(candidate.filePath)) {
        return {
          entry: candidate,
          source: "storage",
        };
      }
    }
    return null;
  }

  private scheduleRetry(filePath: string, delayMs: number): void {
    const timer = setTimeout(() => {
      this.retryTimers.delete(timer);
      this.enqueueFile(filePath);
    }, delayMs);
    this.retryTimers.add(timer);
  }

  private requiresOllamaForFile(fileType: MediaType): boolean {
    if (fileType === "image") {
      return true;
    }
    return this.config.embedding.provider === "ollama";
  }

  /**
   * 处理队列中的下一个文件
   */
  private async processNextFile(): Promise<void> {
    if (this.processing || this.processQueue.size === 0) {
      return;
    }

    this.processing = true;

    const filePath = this.processQueue.values().next().value;
    if (!filePath) {
      // 理论上不会发生（size 已检查），但这里做防御，避免 undefined 传播
      this.processing = false;
      this.processingFilePath = null;
      return;
    }
    this.processQueue.delete(filePath);
    this.processingFilePath = filePath;

    try {
      await this.indexFile(filePath);
    } catch (error) {
      this.logger.warn?.(`Failed to index ${filePath}: ${String(error)}`);
    } finally {
      this.processing = false;
      this.processingFilePath = null;
      // 继续处理队列
      if (this.processQueue.size > 0) {
        this.processNextFile();
      }
    }
  }

  private async reuseMovedEntryWithoutReindex(params: {
    filePath: string;
    fileName: string;
    fileType: MediaType;
    fileHash: string;
    stats: FileStatSnapshot;
    mediaCreatedAt: number;
    source: MovedSourceCandidate;
    startedAt: number;
  }): Promise<void> {
    const { filePath, fileName, fileType, fileHash, stats, mediaCreatedAt, source, startedAt } =
      params;
    const sourceEntry = source.entry;

    if (sourceEntry.filePath !== filePath) {
      try {
        await this.storage.delete(sourceEntry.id);
      } catch {
        await this.storage.deleteByPath(sourceEntry.filePath);
      }
    }

    await this.storage.replaceByPath({
      filePath,
      fileName,
      fileType,
      description: sourceEntry.description,
      vector: sourceEntry.vector,
      fileHash,
      fileSize: stats.size,
      fileCreatedAt: mediaCreatedAt,
      fileModifiedAt: stats.mtimeMs,
    });

    this.consumeRecentlyDeletedEntry(fileHash, sourceEntry.id, sourceEntry.filePath);
    this.failedFiles.delete(filePath);
    await this.clearBrokenFileMark(filePath);
    this.callbacks?.onFileSkipped?.(filePath, fileType, "moved");

    this.logEvent("info", "index_file_moved_reused", {
      filePath,
      fileType,
      reusedFromPath: sourceEntry.filePath,
      source: source.source,
      durationMs: Date.now() - startedAt,
    });
  }

  /**
   * 索引单个文件（带错误处理和重试）
   */
  async indexFile(filePath: string): Promise<boolean> {
    const ext = extname(filePath).toLowerCase();
    const fileName = basename(filePath);
    const startedAt = Date.now();
    let fileType: MediaType | null = null;

    try {
      // 判断文件类型
      if (this.config.fileTypes.image.includes(ext)) {
        fileType = "image";
      } else if (this.config.fileTypes.audio.includes(ext)) {
        fileType = "audio";
      } else {
        return false; // 不支持的类型
      }

      this.logEvent("info", "index_file_start", {
        filePath,
        fileType,
        provider: this.config.embedding.provider,
      });

      if (await this.shouldSkipBrokenFile(filePath)) {
        this.callbacks?.onFileSkipped?.(filePath, fileType, "broken");
        this.logger.info?.(`Skipping unchanged broken file: ${fileName}`);
        return true;
      }

      // 仅在当前文件路径确实依赖 Ollama 时检查健康状态
      if (this.requiresOllamaForFile(fileType)) {
        const ollamaHealthy = await this.checkOllamaHealth();
        if (!ollamaHealthy) {
          const failedInfo = this.failedFiles.get(filePath) || { attempts: 0, lastError: "" };
          failedInfo.attempts++;
          failedInfo.lastError = "Ollama service unavailable";
          this.failedFiles.set(filePath, failedInfo);

          if (failedInfo.attempts < 3) {
            this.logEvent("warn", "index_file_retry_scheduled", {
              filePath,
              fileType,
              stage: "dependency_check",
              retryAttempt: failedInfo.attempts,
              reason: "ollama_unavailable",
              retryDelayMs: 60000,
            });
            this.scheduleRetry(filePath, 60000);
          } else {
            this.logger.warn?.(
              `Failed to index ${fileName} after 3 attempts: Ollama unavailable`,
            );
            this.callbacks?.onFileFailed(filePath, "Ollama service unavailable");
          }
          return false;
        }
      }

      // 获取文件元数据
      const stats = await stat(filePath);
      const fileBuffer = await readFile(filePath);
      const fileHash = createHash("sha256").update(fileBuffer).digest("hex");
      const mediaCreatedAt = await resolveMediaCreatedAt(filePath, fileType, stats);

      // 检查同路径记录：路径级一致性（不再做全局 hash 去重）
      const existingByPath = await this.storage.findByPath(filePath);
      if (existingByPath && existingByPath.fileHash === fileHash) {
        const unchanged =
          existingByPath.fileSize === stats.size &&
          existingByPath.fileModifiedAt === stats.mtimeMs;

        if (unchanged) {
          this.logger.info?.(`Skipping unchanged file: ${fileName}`);
          this.failedFiles.delete(filePath);
          await this.clearBrokenFileMark(filePath);
          this.callbacks?.onFileSkipped?.(filePath, fileType, "unchanged");
          return true;
        }

        // 内容 hash 未变，仅元数据变化：复用旧 description/vector 做路径替换
        await this.storage.replaceByPath({
          filePath,
          fileName,
          fileType,
          description: existingByPath.description,
          vector: existingByPath.vector,
          fileHash,
          fileSize: stats.size,
          fileCreatedAt: mediaCreatedAt,
          fileModifiedAt: stats.mtimeMs,
        });
        this.logger.info?.(`Updated metadata without reprocessing: ${fileName}`);
        this.failedFiles.delete(filePath);
        await this.clearBrokenFileMark(filePath);
        this.callbacks?.onFileSkipped?.(filePath, fileType, "metadata-updated");
        return true;
      }

      if (!existingByPath) {
        const movedSource = await this.findMovedSourceByHash(fileHash, fileType);
        if (movedSource) {
          await this.reuseMovedEntryWithoutReindex({
            filePath,
            fileName,
            fileType,
            fileHash,
            stats,
            mediaCreatedAt,
            source: movedSource,
            startedAt,
          });
          return true;
        }
      }

      // 处理媒体内容
      let description: string;
      if (fileType === "image") {
        description = await this.processor.processImage(filePath);
      } else {
        description = await this.processor.processAudio(filePath);
        // 防御性检查：历史版本可能把失败信息当正常描述写入
        if (AUDIO_FAILURE_PATTERN.test(description.trim())) {
          throw new Error("Audio transcription contains failure marker");
        }
      }

      // 生成嵌入向量
      const vector = await this.embeddings.embed(description);

      // 存储
      const entryPayload = {
        filePath,
        fileName,
        fileType,
        description,
        vector,
        fileHash,
        fileSize: stats.size,
        fileCreatedAt: mediaCreatedAt,
        fileModifiedAt: stats.mtimeMs,
      };
      if (existingByPath) {
        await this.storage.replaceByPath(entryPayload);
      } else {
        await this.storage.store(entryPayload);
      }

      this.logger.info?.(`Indexed ${fileType}: ${fileName}`);
      this.logEvent("info", "index_file_success", {
        filePath,
        fileType,
        stage: "stored",
        durationMs: Date.now() - startedAt,
      });
      
      // 索引成功，清除失败记录
      this.failedFiles.delete(filePath);
      await this.clearBrokenFileMark(filePath);
      
      // 通知回调：文件索引成功
      this.callbacks?.onFileIndexed(filePath, fileType);
      return true;
    } catch (error) {
      const errorMsg = String(error);
      if (this.isFileMissingError(error)) {
        await this.removeIndexedEntryForDeletedFile(filePath);
        await this.clearBrokenFileMark(filePath);
        this.failedFiles.delete(filePath);
        if (fileType) {
          this.callbacks?.onFileSkipped?.(filePath, fileType, "deleted");
        }
        this.logger.info?.(`Skipped deleted file during indexing: ${filePath}`);
        return true;
      }

      this.logger.warn?.(`Failed to index ${filePath}: ${errorMsg}`);
      const errorClass = this.classifyError(errorMsg);

      // 记录失败，稍后重试
      const failedInfo = this.failedFiles.get(filePath) || { attempts: 0, lastError: "" };
      failedInfo.attempts++;
      failedInfo.lastError = errorMsg;
      this.failedFiles.set(filePath, failedInfo);

      // 如果是 Ollama 相关错误且未超过重试次数，稍后重试
      if (
        failedInfo.attempts < 3 &&
        this.isTransientIndexingError(errorMsg)
      ) {
        this.logEvent("warn", "index_file_retry_scheduled", {
          filePath,
          fileType,
          stage: "indexing",
          retryAttempt: failedInfo.attempts,
          errorClass,
          retryDelayMs: 60000,
        });
        this.scheduleRetry(filePath, 60000);
      } else {
        if (this.shouldMarkFileAsBroken(errorMsg)) {
          await this.markFileAsBroken(filePath, errorMsg);
        }
        // 达到最大重试次数或非临时错误，通知回调：文件索引失败
        this.callbacks?.onFileFailed(filePath, errorMsg);
      }
      this.logEvent("warn", "index_file_failed", {
        filePath,
        fileType,
        stage: "indexing",
        durationMs: Date.now() - startedAt,
        retryAttempt: failedInfo.attempts,
        errorClass,
      });
      return false;
    }
  }

  /**
   * 手动触发索引（用于初始化或强制重新索引）
   */
  async indexPath(path: string): Promise<void> {
    const resolvedPath = expandPath(path);
    const pathStats = await stat(resolvedPath);

    if (pathStats.isDirectory()) {
      const supportedExts = [...this.config.fileTypes.image, ...this.config.fileTypes.audio];
      const files = await this.scanDirectory(resolvedPath, supportedExts);
      const failures: string[] = [];

      for (const filePath of files) {
        try {
          const ok = await this.indexFile(filePath);
          if (!ok) {
            const reason = this.failedFiles.get(filePath)?.lastError;
            failures.push(reason ? `索引失败: ${filePath} (${reason})` : `索引失败: ${filePath}`);
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          failures.push(`索引失败: ${filePath} (${message})`);
        }
      }

      if (failures.length > 0) {
        throw new Error(
          `目录索引完成，但以下 ${failures.length} 个文件失败:\n- ${failures.join("\n- ")}`,
        );
      }
      return;
    }

    const ok = await this.indexFile(resolvedPath);
    if (!ok) {
      throw new Error(this.failedFiles.get(resolvedPath)?.lastError || `索引失败: ${resolvedPath}`);
    }
  }

  /**
   * 获取当前处理队列状态（用于调试/展示进度）
   */
  getQueueStatus(): { pending: string[]; processing: string | null } {
    return {
      pending: Array.from(this.processQueue.values()),
      processing: this.processingFilePath,
    };
  }

  /**
   * 扫描目录并索引缺失的文件（优化版：批量查询）
   */
  private async scanAndIndexMissingFiles(
    watchPaths: string[],
    supportedExts: string[],
  ): Promise<void> {
    this.logger.info?.("Scanning directories for missing files...");
    
    // 收集所有文件路径
    const allFiles: string[] = [];
    for (const watchPath of watchPaths) {
      try {
        const files = await this.scanDirectory(watchPath, supportedExts);
        allFiles.push(...files);
      } catch (error) {
        this.logger.warn?.(`Failed to scan ${watchPath}: ${String(error)}`);
      }
    }

    if (allFiles.length === 0) {
      this.logger.info?.("No media files found in watched directories");
      return;
    }

    // 批量获取所有已索引文件路径（性能优化：一次查询）
    const indexedFiles = await this.storage.listAllEntries();
    const indexedPathsSet = new Set(indexedFiles.map((f) => f.filePath));

    // 用 realpath 归一化，避免因为软链/路径别名导致“已索引文件被误判为缺失”
    const normalizedIndexedPaths = await Promise.all(
      indexedFiles.map(async (file) => await this.normalizeComparablePath(file.filePath)),
    );
    for (const normalized of normalizedIndexedPaths) {
      indexedPathsSet.add(normalized);
    }

    const comparableAllFiles = await Promise.all(
      allFiles.map(async (filePath) => ({
        filePath,
        comparablePath: await this.normalizeComparablePath(filePath),
      })),
    );

    // 找出缺失的文件
    let missingFiles = 0;
    let skippedBrokenFiles = 0;
    for (const { filePath, comparablePath } of comparableAllFiles) {
      if (!indexedPathsSet.has(filePath) && !indexedPathsSet.has(comparablePath)) {
        if (await this.shouldSkipBrokenFile(filePath, comparablePath)) {
          skippedBrokenFiles++;
          continue;
        }
        missingFiles++;
        this.enqueueFile(filePath);
      }
    }

    if (missingFiles > 0) {
      this.logger.info?.(
        `Found ${missingFiles} missing files out of ${allFiles.length} total (queued for indexing)`,
      );
    } else {
      this.logger.info?.(`All ${allFiles.length} files are already indexed`);
    }

    if (skippedBrokenFiles > 0) {
      this.logger.info?.(
        `Skipped ${skippedBrokenFiles} unchanged broken file(s) during startup scan`,
      );
    }
  }

  private async removeIndexedEntryForDeletedFile(filePath: string): Promise<number> {
    let removed = await this.storage.deleteByPath(filePath);
    const normalizedPath = await this.normalizeComparablePath(filePath);

    // fallback：处理软链/路径别名导致的“字符串不等但实际同一路径”
    if (removed === 0) {
      const entries = await this.storage.listAllEntries();
      for (const entry of entries) {
        const entryComparable = await this.normalizeComparablePath(entry.filePath);
        if (entryComparable !== normalizedPath) {
          continue;
        }
        try {
          if (await this.storage.delete(entry.id)) {
            removed++;
          }
        } catch {
          // 单条删除失败不影响后续候选清理
        }
      }
    }

    await this.clearBrokenFileMark(filePath, normalizedPath);
    return removed;
  }

  private async normalizeComparablePath(filePath: string): Promise<string> {
    const resolved = resolve(filePath);
    try {
      return await realpath(resolved);
    } catch {
      return resolved;
    }
  }

  /**
   * 递归扫描目录获取所有支持的文件
   */
  private async scanDirectory(
    dirPath: string,
    supportedExts: string[],
  ): Promise<string[]> {
    const results: string[] = [];

    try {
      const entries = await readdir(dirPath, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = join(dirPath, entry.name);

        // 跳过隐藏文件
        if (entry.name.startsWith(".")) {
          continue;
        }

        if (entry.isDirectory()) {
          // 递归扫描子目录
          const subFiles = await this.scanDirectory(fullPath, supportedExts);
          results.push(...subFiles);
        } else if (entry.isFile()) {
          const ext = extname(entry.name).toLowerCase();
          if (supportedExts.includes(ext)) {
            results.push(fullPath);
          }
        }
      }
    } catch (error) {
      this.logger.warn?.(`Error scanning ${dirPath}: ${String(error)}`);
    }

    return results;
  }

  /**
   * 检查 Ollama 健康状态
   */
  private async checkOllamaHealth(): Promise<boolean> {
    const now = Date.now();
    if (now - this.lastOllamaCheck < 60000 && this.ollamaHealthy) {
      return this.ollamaHealthy;
    }

    this.lastOllamaCheck = now;

    try {
      const ollamaUrl = this.config.ollama?.baseUrl || "http://localhost:11434";
      const headers: Record<string, string> = {};
      if (this.config.ollama?.apiKey) {
        headers["Authorization"] = `Bearer ${this.config.ollama.apiKey}`;
        headers["api-key"] = this.config.ollama.apiKey;
      }

      // 先尝试 /api/tags（原生 Ollama），404 时回退到 /v1/models（user-center 代理）
      const tagsRes = await fetch(`${ollamaUrl}/api/tags`, {
        signal: AbortSignal.timeout(5000),
        headers,
      });
      if (tagsRes.ok) {
        this.ollamaHealthy = true;
        return true;
      }
      if (tagsRes.status === 404) {
        const modelsRes = await fetch(`${ollamaUrl}/v1/models`, {
          signal: AbortSignal.timeout(5000),
          headers,
        });
        this.ollamaHealthy = modelsRes.ok;
        if (!this.ollamaHealthy) {
          this.logger.warn?.(`Ollama health check failed: /v1/models HTTP ${modelsRes.status}`);
        }
        return this.ollamaHealthy;
      }

      this.ollamaHealthy = false;
      this.logger.warn?.(`Ollama health check failed: HTTP ${tagsRes.status}`);
    } catch (error) {
      this.ollamaHealthy = false;
      this.logger.warn?.(`Ollama is not responding: ${String(error)}`);
    }

    return this.ollamaHealthy;
  }

  /**
   * 完整重新索引（清空数据库并重新扫描所有文件）
   */
  async reindexAll(): Promise<void> {
    this.logger.info?.("Starting full reindex...");
    
    // 清空数据库
    await this.storage.clear();
    this.logger.info?.("Database cleared");

    // 清空处理队列和失败记录
    this.processQueue.clear();
    this.failedFiles.clear();
    this.recentlyDeletedEntriesByHash.clear();

    // 重新扫描所有文件
    const { watchPaths, fileTypes } = this.config;
    const expandedPaths = watchPaths.map(expandPath);
    const supportedExts = [...fileTypes.image, ...fileTypes.audio];

    await this.scanAndIndexMissingFiles(expandedPaths, supportedExts);
  }

  async cleanupMissingIndexedFiles(limit?: number): Promise<{
    scanned: number;
    missing: number;
    removed: number;
  }> {
    const startedAt = Date.now();
    const result = await this.storage.cleanupMissingEntries({
      limit,
      dryRun: false,
    });
    const durationMs = Date.now() - startedAt;
    this.logger.info?.(
      `Cleanup missing indexed files completed: scanned=${result.scanned}, missing=${result.missing}, removed=${result.removed}, durationMs=${durationMs}`,
    );
    return {
      scanned: result.scanned,
      missing: result.missing,
      removed: result.removed,
    };
  }

  async clearBrokenFileMarkers(filePaths?: string[]): Promise<{ removed: number }> {
    if (this.brokenFiles.size === 0) {
      await this.loadBrokenFilesState();
    }

    if (!Array.isArray(filePaths) || filePaths.length === 0) {
      const removed = this.brokenFiles.size;
      if (removed === 0) {
        return { removed: 0 };
      }
      this.brokenFiles.clear();
      await this.saveBrokenFilesState();
      this.logger.info?.(`Cleared ${removed} broken file marker(s)`);
      return { removed };
    }

    const normalizedTargets = new Set(
      await Promise.all(filePaths.map(async (filePath) => await this.normalizeComparablePath(filePath))),
    );

    let removed = 0;
    for (const target of normalizedTargets) {
      if (this.brokenFiles.delete(target)) {
        removed++;
      }
    }

    if (removed > 0) {
      await this.saveBrokenFilesState();
      this.logger.info?.(`Cleared ${removed} broken file marker(s)`);
    }

    return { removed };
  }

  private isTransientIndexingError(errorMsg: string): boolean {
    const normalized = errorMsg.toLowerCase();
    return (
      normalized.includes("internal server error") ||
      normalized.includes("ollama") ||
      normalized.includes("econnrefused") ||
      normalized.includes("econnreset") ||
      normalized.includes("etimedout") ||
      normalized.includes("fetch failed") ||
      normalized.includes("timeout") ||
      normalized.includes("aborted")
    );
  }

  private shouldMarkFileAsBroken(errorMsg: string): boolean {
    return !this.isTransientIndexingError(errorMsg);
  }

  private isFileMissingError(error: unknown): boolean {
    const code = (error as NodeJS.ErrnoException)?.code;
    return code === "ENOENT" || code === "ENOTDIR";
  }

  private async loadBrokenFilesState(): Promise<void> {
    try {
      const raw = await readFile(this.brokenFilesStatePath, "utf-8");
      const parsed = JSON.parse(raw) as Record<string, Partial<BrokenFileRecord>>;
      this.brokenFiles.clear();

      for (const [filePath, value] of Object.entries(parsed || {})) {
        if (!value || typeof value !== "object") {
          continue;
        }
        const mtimeMs = Number(value.mtimeMs);
        const size = Number(value.size);
        const error = String(value.error ?? "");
        const markedAt = Number(value.markedAt ?? Date.now());
        if (!Number.isFinite(mtimeMs) || !Number.isFinite(size)) {
          continue;
        }
        this.brokenFiles.set(filePath, { mtimeMs, size, error, markedAt });
      }

      if (this.brokenFiles.size > 0) {
        this.logger.info?.(`Loaded ${this.brokenFiles.size} broken file marker(s)`);
      }
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err?.code !== "ENOENT") {
        this.logger.warn?.(`Failed to load broken file markers: ${String(error)}`);
      }
    }
  }

  private async saveBrokenFilesState(): Promise<void> {
    const output: Record<string, BrokenFileRecord> = {};
    for (const [filePath, info] of this.brokenFiles.entries()) {
      output[filePath] = info;
    }

    await mkdir(dirname(this.brokenFilesStatePath), { recursive: true });
    await writeFile(
      this.brokenFilesStatePath,
      `${JSON.stringify(output, null, 2)}\n`,
      "utf-8",
    );
  }

  private async markFileAsBroken(filePath: string, error: string): Promise<void> {
    const key = await this.normalizeComparablePath(filePath);
    let size = 0;
    let mtimeMs = 0;

    try {
      const fileStat = await stat(filePath);
      size = fileStat.size;
      mtimeMs = fileStat.mtimeMs;
    } catch {}

    const existing = this.brokenFiles.get(key);
    if (
      existing &&
      existing.size === size &&
      existing.mtimeMs === mtimeMs &&
      existing.error === error
    ) {
      return;
    }

    this.brokenFiles.set(key, { size, mtimeMs, error, markedAt: Date.now() });
    await this.saveBrokenFilesState();
    this.logger.warn?.(`Marked broken file to skip unchanged retries: ${filePath}`);
  }

  private async clearBrokenFileMark(filePath: string, normalizedPath?: string): Promise<void> {
    const key = normalizedPath ?? (await this.normalizeComparablePath(filePath));
    if (!this.brokenFiles.delete(key)) {
      return;
    }
    await this.saveBrokenFilesState();
    this.logger.info?.(`Removed broken file marker: ${filePath}`);
  }

  private async shouldSkipBrokenFile(filePath: string, normalizedPath?: string): Promise<boolean> {
    const key = normalizedPath ?? (await this.normalizeComparablePath(filePath));
    const marker = this.brokenFiles.get(key);
    if (!marker) {
      return false;
    }

    try {
      const fileStat = await stat(filePath);
      const unchanged = fileStat.size === marker.size && fileStat.mtimeMs === marker.mtimeMs;
      if (unchanged) {
        return true;
      }
    } catch {}

    await this.clearBrokenFileMark(filePath, key);
    return false;
  }
}
