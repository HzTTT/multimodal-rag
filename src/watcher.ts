/**
 * 文件监听服务
 */

import chokidar from "chokidar";
import { stat, readdir } from "node:fs/promises";
import { basename, extname, resolve, join } from "node:path";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import type { MediaType, PluginConfig } from "./types.js";
import type { MediaStorage } from "./storage.js";
import type { IEmbeddingProvider } from "./types.js";
import type { IMediaProcessor } from "./types.js";

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
  private watcher: chokidar.FSWatcher | null = null;
  private processQueue: Set<string> = new Set();
  private processing = false;
  private processingFilePath: string | null = null;
  private debounceTimers: Map<string, NodeJS.Timeout> = new Map();
  private failedFiles: Map<string, { attempts: number; lastError: string }> = new Map();
  private ollamaHealthy = true;
  private lastOllamaCheck = 0;

  constructor(
    private readonly config: PluginConfig,
    private readonly storage: MediaStorage,
    private readonly embeddings: IEmbeddingProvider,
    private readonly processor: IMediaProcessor,
    private readonly logger: { info?: (msg: string) => void; warn?: (msg: string) => void },
  ) {}

  /**
   * 启动监听
   */
  async start(): Promise<void> {
    if (this.watcher) {
      return;
    }

    const { watchPaths, fileTypes, watchDebounceMs } = this.config;

    if (watchPaths.length === 0) {
      this.logger.warn?.("No watch paths configured, file watching disabled");
      return;
    }

    // 扩展 ~ 为用户主目录
    const expandedPaths = watchPaths.map(expandPath);
    this.logger.info?.(`Expanded watch paths: ${expandedPaths.join(", ")}`);

    // 支持的文件扩展名
    const supportedExts = [...fileTypes.image, ...fileTypes.audio];

    this.watcher = chokidar.watch(expandedPaths, {
      ignored: /(^|[\/\\])\../, // 忽略隐藏文件
      persistent: true,
      ignoreInitial: !this.config.indexExistingOnStart, // 是否索引现有文件
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
        this.enqueueFile(filePath);
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
        this.enqueueFile(filePath);
      }, watchDebounceMs);

      this.debounceTimers.set(filePath, timer);
    });

    this.watcher.on("ready", () => {
      this.logger.info?.(
        `Watching ${watchPaths.length} path(s) for media files`,
      );
      
      // 启动时扫描并索引缺失的文件（异步执行，不阻塞）
      this.scanAndIndexMissingFiles(expandedPaths, supportedExts).catch((error) => {
        this.logger.warn?.(`Scan failed: ${String(error)}`);
      });
    });

    this.watcher.on("error", (error) => {
      this.logger.warn?.(`Watcher error: ${String(error)}`);
    });
  }

  /**
   * 停止监听
   */
  async stop(): Promise<void> {
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }

    // 清理去抖动定时器
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();
  }

  /**
   * 将文件加入处理队列
   */
  private enqueueFile(filePath: string): void {
    this.processQueue.add(filePath);
    this.processNextFile();
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

  /**
   * 索引单个文件（带错误处理和重试）
   */
  async indexFile(filePath: string): Promise<void> {
    const ext = extname(filePath).toLowerCase();
    const fileName = basename(filePath);

    try {
      // 判断文件类型
      let fileType: MediaType;
      if (this.config.fileTypes.image.includes(ext)) {
        fileType = "image";
      } else if (this.config.fileTypes.audio.includes(ext)) {
        fileType = "audio";
      } else {
        return; // 不支持的类型
      }

      // 检查 Ollama 健康状态
      const ollamaHealthy = await this.checkOllamaHealth();
      if (!ollamaHealthy) {
        // Ollama 不可用，记录失败并稍后重试
        const failedInfo = this.failedFiles.get(filePath) || { attempts: 0, lastError: "" };
        failedInfo.attempts++;
        failedInfo.lastError = "Ollama service unavailable";
        this.failedFiles.set(filePath, failedInfo);

        if (failedInfo.attempts < 3) {
          this.logger.warn?.(
            `Ollama unavailable, will retry ${fileName} (attempt ${failedInfo.attempts}/3)`,
          );
          // 60 秒后重试
          setTimeout(() => {
            this.enqueueFile(filePath);
          }, 60000);
        } else {
          this.logger.warn?.(
            `Failed to index ${fileName} after 3 attempts: Ollama unavailable`,
          );
        }
        return;
      }

      // 获取文件元数据
      const stats = await stat(filePath);
      const fileBuffer = await readFile(filePath);
      const fileHash = createHash("sha256").update(fileBuffer).digest("hex");

      // 检查是否已索引（基于 hash 去重）
      const existing = await this.storage.findByHash(fileHash);
      if (existing) {
        this.logger.info?.(`Skipping duplicate: ${fileName}`);
        // 索引成功（已存在），清除失败记录
        this.failedFiles.delete(filePath);
        return;
      }

      // 处理媒体内容
      let description: string;
      if (fileType === "image") {
        description = await this.processor.processImage(filePath);
      } else {
        description = await this.processor.processAudio(filePath);
      }

      // 生成嵌入向量
      const vector = await this.embeddings.embed(description);

      // 存储
      await this.storage.store({
        filePath,
        fileName,
        fileType,
        description,
        vector,
        fileHash,
        fileSize: stats.size,
        fileCreatedAt: stats.birthtimeMs,
        fileModifiedAt: stats.mtimeMs,
      });

      this.logger.info?.(`Indexed ${fileType}: ${fileName}`);
      
      // 索引成功，清除失败记录
      this.failedFiles.delete(filePath);
    } catch (error) {
      const errorMsg = String(error);
      this.logger.warn?.(`Failed to index ${filePath}: ${errorMsg}`);

      // 记录失败，稍后重试
      const failedInfo = this.failedFiles.get(filePath) || { attempts: 0, lastError: "" };
      failedInfo.attempts++;
      failedInfo.lastError = errorMsg;
      this.failedFiles.set(filePath, failedInfo);

      // 如果是 Ollama 相关错误且未超过重试次数，稍后重试
      if (
        failedInfo.attempts < 3 &&
        (errorMsg.includes("Internal Server Error") ||
          errorMsg.includes("Ollama") ||
          errorMsg.includes("ECONNREFUSED"))
      ) {
        this.logger.warn?.(
          `Will retry ${fileName} in 60s (attempt ${failedInfo.attempts}/3)`,
        );
        setTimeout(() => {
          this.enqueueFile(filePath);
        }, 60000);
      }
    }
  }

  /**
   * 手动触发索引（用于初始化或强制重新索引）
   */
  async indexPath(path: string): Promise<void> {
    await this.indexFile(path);
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
    const { entries: indexedFiles } = await this.storage.list({ 
      limit: 10000  // 获取所有文件
    });
    const indexedPathsSet = new Set(indexedFiles.map(f => f.filePath));

    // 找出缺失的文件
    let missingFiles = 0;
    for (const filePath of allFiles) {
      if (!indexedPathsSet.has(filePath)) {
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
    // 每 60 秒检查一次
    if (now - this.lastOllamaCheck < 60000 && this.ollamaHealthy) {
      return this.ollamaHealthy;
    }

    this.lastOllamaCheck = now;

    try {
      const ollamaUrl = this.config.ollama?.baseUrl || "http://localhost:11434";
      const response = await fetch(`${ollamaUrl}/api/tags`, {
        signal: AbortSignal.timeout(5000),
      });

      this.ollamaHealthy = response.ok;

      if (!this.ollamaHealthy) {
        this.logger.warn?.(`Ollama health check failed: HTTP ${response.status}`);
      }
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

    // 重新扫描所有文件
    const { watchPaths, fileTypes } = this.config;
    const expandedPaths = watchPaths.map(expandPath);
    const supportedExts = [...fileTypes.image, ...fileTypes.audio];

    await this.scanAndIndexMissingFiles(expandedPaths, supportedExts);
  }
}
