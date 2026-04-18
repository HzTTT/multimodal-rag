/**
 * LanceDB 向量存储实现（双表：media + doc_chunks）
 */

import * as lancedb from "@lancedb/lancedb";
import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import type {
  DocChunkEntry,
  DocChunkSearchResult,
  DocSummary,
  MediaEntry,
  MediaSearchResult,
  MediaType,
  UnifiedSearchResult,
} from "./types.js";

const TABLE_NAME = "media";
const DOC_CHUNKS_TABLE = "doc_chunks";
const SCALAR_FILTER_INDICES = [
  { column: "fileType", factory: () => lancedb.Index.bitmap() },
  { column: "fileCreatedAt", factory: () => lancedb.Index.btree() },
] as const;
const DOC_CHUNKS_SCALAR_INDICES = [
  { column: "fileExt", factory: () => lancedb.Index.bitmap() },
  { column: "fileCreatedAt", factory: () => lancedb.Index.btree() },
] as const;
const DEFAULT_AUTO_OPTIMIZE_THRESHOLD = 20;
const DEFAULT_AUTO_OPTIMIZE_IDLE_MS = 5 * 60 * 1000;
const FAILED_MEDIA_DESCRIPTION_PATTERNS = [
  /^[（(]\s*转录失败[:：]/,
  /^Whisper 转录失败[:：]/,
  /^GLM-ASR 转录失败[:：]/,
  /^Qwen3-VL processing failed:/,
  /^Empty description from Qwen3-VL$/,
];

type MediaStorageOptions = {
  autoOptimizeThreshold?: number;
  autoOptimizeIdleMs?: number;
};

/**
 * 搜索选项
 */
export type SearchOptions = {
  type?: MediaType | "all";
  after?: number;
  before?: number;
  limit?: number;
  minScore?: number;
  dedupeByHash?: boolean;
};

export type DocSearchOptions = {
  after?: number;
  before?: number;
  limit?: number;
  minScore?: number;
  fileExt?: string;
};

export type CleanupMissingOptions = {
  dryRun?: boolean;
  limit?: number;
  candidates?: Array<{ id: string; filePath: string }>;
};

export type CleanupMissingResult = {
  scanned: number;
  missing: number;
  removed: number;
  missingIds: string[];
};

export type CleanupMissingDocsResult = {
  scanned: number;
  missingPaths: number;
  removedChunks: number;
  missingFilePaths: string[];
};

/**
 * LanceDB 媒体存储（同时管理 media 和 doc_chunks 两张表）
 */
export class MediaStorage {
  private db: lancedb.Connection | null = null;
  private table: lancedb.Table | null = null;
  private docTable: lancedb.Table | null = null;
  private initPromise: Promise<void> | null = null;
  private scalarIndicesReady = false;
  private docScalarIndicesReady = false;
  private autoOptimizeTimer: NodeJS.Timeout | null = null;
  private autoOptimizeRunning = false;
  private autoOptimizeDirtyOperations = 0;
  private autoOptimizePendingRun = false;

  constructor(
    private readonly dbPath: string,
    private readonly vectorDim: number,
    private readonly options: MediaStorageOptions = {},
  ) {}

  private async ensureInitialized(): Promise<void> {
    if (this.table && this.docTable) {
      return;
    }
    if (this.initPromise) {
      return this.initPromise;
    }

    this.initPromise = this.doInitialize();
    return this.initPromise;
  }

  /**
   * 刷新两张表到最新版本
   */
  private async refreshToLatest(): Promise<void> {
    for (const tbl of [this.table, this.docTable]) {
      if (!tbl) continue;
      try {
        await tbl.checkoutLatest();
      } catch (error) {
        console.debug?.(`[multimodal-rag] checkoutLatest skipped: ${String(error)}`);
      }
    }
  }

  private async doInitialize(): Promise<void> {
    this.db = await lancedb.connect(this.dbPath);
    const tables = await this.db.tableNames();

    if (tables.includes(TABLE_NAME)) {
      this.table = await this.db.openTable(TABLE_NAME);
    } else {
      this.table = await this.db.createTable(TABLE_NAME, [
        {
          id: "__schema__",
          filePath: "",
          fileName: "",
          fileType: "image",
          description: "",
          vector: Array.from({ length: this.vectorDim }).fill(0),
          fileHash: "",
          fileSize: 0,
          fileCreatedAt: 0,
          fileModifiedAt: 0,
          indexedAt: 0,
        } as MediaEntry,
      ]);
      await this.table.delete('id = "__schema__"');
    }

    if (tables.includes(DOC_CHUNKS_TABLE)) {
      this.docTable = await this.db.openTable(DOC_CHUNKS_TABLE);
    } else {
      this.docTable = await this.db.createTable(DOC_CHUNKS_TABLE, [
        {
          id: "__schema__",
          docId: "",
          filePath: "",
          fileName: "",
          fileExt: "",
          chunkIndex: 0,
          totalChunks: 0,
          pageNumber: 0,
          heading: "",
          chunkText: "",
          vector: Array.from({ length: this.vectorDim }).fill(0),
          fileHash: "",
          fileSize: 0,
          fileCreatedAt: 0,
          fileModifiedAt: 0,
          indexedAt: 0,
        } as DocChunkEntry,
      ]);
      await this.docTable.delete('id = "__schema__"');
    }

    await this.ensureScalarFilterIndices();
    await this.ensureDocScalarFilterIndices();
  }

  private async ensureScalarFilterIndices(): Promise<void> {
    if (!this.table || this.scalarIndicesReady) {
      return;
    }

    try {
      const totalRows = await this.table.countRows();
      if (totalRows === 0) {
        return;
      }

      const existingIndices = await this.table.listIndices();
      const indexedColumns = new Set(
        existingIndices.flatMap((index) => index.columns.map((column) => String(column))),
      );

      for (const spec of SCALAR_FILTER_INDICES) {
        if (indexedColumns.has(spec.column)) {
          continue;
        }

        await this.table.createIndex(spec.column, {
          config: spec.factory(),
          replace: false,
        });
      }

      this.scalarIndicesReady = true;
    } catch (error) {
      console.warn(`[multimodal-rag] ensureScalarFilterIndices failed: ${String(error)}`);
    }
  }

  private async ensureDocScalarFilterIndices(): Promise<void> {
    if (!this.docTable || this.docScalarIndicesReady) {
      return;
    }

    try {
      const totalRows = await this.docTable.countRows();
      if (totalRows === 0) {
        return;
      }

      const existingIndices = await this.docTable.listIndices();
      const indexedColumns = new Set(
        existingIndices.flatMap((index) => index.columns.map((column) => String(column))),
      );

      for (const spec of DOC_CHUNKS_SCALAR_INDICES) {
        if (indexedColumns.has(spec.column)) {
          continue;
        }

        await this.docTable.createIndex(spec.column, {
          config: spec.factory(),
          replace: false,
        });
      }

      this.docScalarIndicesReady = true;
    } catch (error) {
      console.warn(
        `[multimodal-rag] ensureDocScalarFilterIndices failed: ${String(error)}`,
      );
    }
  }

  private getAutoOptimizeThreshold(): number {
    const value = this.options.autoOptimizeThreshold;
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
      return Math.floor(value);
    }
    return DEFAULT_AUTO_OPTIMIZE_THRESHOLD;
  }

  private getAutoOptimizeIdleMs(): number {
    const value = this.options.autoOptimizeIdleMs;
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
      return Math.floor(value);
    }
    return DEFAULT_AUTO_OPTIMIZE_IDLE_MS;
  }

  private markAutoOptimizeDirty(): void {
    this.autoOptimizeDirtyOperations++;

    if (this.autoOptimizeRunning) {
      this.autoOptimizePendingRun = true;
      return;
    }

    const delayMs =
      this.autoOptimizeDirtyOperations >= this.getAutoOptimizeThreshold()
        ? 0
        : this.getAutoOptimizeIdleMs();
    this.scheduleAutoOptimize(delayMs);
  }

  private scheduleAutoOptimize(delayMs: number): void {
    if (this.autoOptimizeTimer) {
      clearTimeout(this.autoOptimizeTimer);
    }

    this.autoOptimizeTimer = setTimeout(() => {
      this.autoOptimizeTimer = null;
      void this.runAutoOptimize();
    }, delayMs);
    this.autoOptimizeTimer.unref?.();
  }

  private async runAutoOptimize(): Promise<void> {
    if (
      !this.table ||
      !this.docTable ||
      this.autoOptimizeRunning ||
      this.autoOptimizeDirtyOperations === 0
    ) {
      return;
    }

    const dirtyOperations = this.autoOptimizeDirtyOperations;
    this.autoOptimizeDirtyOperations = 0;
    this.autoOptimizePendingRun = false;
    this.autoOptimizeRunning = true;

    try {
      await this.refreshToLatest();
      const mediaStats = await this.table.optimize();
      const docStats = await this.docTable.optimize();
      await this.refreshToLatest();
      console.info?.(
        `[multimodal-rag] auto optimize completed after ${dirtyOperations} modification(s): media=${JSON.stringify(mediaStats)} doc=${JSON.stringify(docStats)}`,
      );
    } catch (error) {
      console.warn(`[multimodal-rag] auto optimize failed: ${String(error)}`);
    } finally {
      this.autoOptimizeRunning = false;

      if (this.autoOptimizePendingRun || this.autoOptimizeDirtyOperations > 0) {
        this.scheduleAutoOptimize(this.getAutoOptimizeIdleMs());
      }
    }
  }

  // ============================================================
  // media 表 API（image/audio）
  // ============================================================

  /**
   * 存储媒体条目
   */
  async store(entry: Omit<MediaEntry, "id" | "indexedAt">): Promise<MediaEntry> {
    await this.ensureInitialized();

    const fullEntry: MediaEntry = {
      ...entry,
      id: randomUUID(),
      indexedAt: Date.now(),
    };

    await this.table!.add([fullEntry]);
    await this.ensureScalarFilterIndices();
    this.markAutoOptimizeDirty();
    return fullEntry;
  }

  /**
   * 按文件路径替换条目（先删后插）
   */
  async replaceByPath(entry: Omit<MediaEntry, "id" | "indexedAt">): Promise<MediaEntry> {
    await this.ensureInitialized();
    await this.refreshToLatest();
    await this.deleteByPath(entry.filePath);
    return this.store(entry);
  }

  /**
   * 搜索媒体（支持时间过滤）
   */
  async search(
    vector: number[],
    options: SearchOptions = {},
  ): Promise<MediaSearchResult[]> {
    await this.ensureInitialized();
    await this.refreshToLatest();

    const {
      type = "all",
      after,
      before,
      limit = 5,
      minScore = 0.5,
      dedupeByHash = true,
    } = options;

    // document 类型走 doc_chunks 表，不在此方法返回
    if (type === "document") {
      return [];
    }

    const candidateLimit = Math.max(limit * (dedupeByHash ? 8 : 2), limit);
    let query = this.table!.vectorSearch(vector).limit(candidateLimit);

    if (after || before || type !== "all") {
      const conditions: string[] = [];

      if (type !== "all") {
        conditions.push("`fileType` = '" + type + "'");
      }

      if (after) {
        conditions.push("`fileCreatedAt` >= " + after);
      }

      if (before) {
        conditions.push("`fileCreatedAt` <= " + before);
      }

      if (conditions.length > 0) {
        query = query.where(conditions.join(" AND "));
      }
    }

    const results = await query.toArray();

    const mapped = results.map((row) => {
      const distance = row._distance ?? 0;
      const score = 1 / (1 + distance);
      return {
        entry: {
          id: row.id as string,
          filePath: row.filePath as string,
          fileName: row.fileName as string,
          fileType: row.fileType as Extract<MediaType, "image" | "audio">,
          description: row.description as string,
          fileHash: row.fileHash as string,
          fileSize: row.fileSize as number,
          fileCreatedAt: row.fileCreatedAt as number,
          fileModifiedAt: row.fileModifiedAt as number,
          indexedAt: row.indexedAt as number,
        },
        score,
      };
    });

    const filtered = mapped.filter((r) => r.score >= minScore);

    if (!dedupeByHash) {
      return filtered.slice(0, limit);
    }

    const seenHashes = new Set<string>();
    const deduped: MediaSearchResult[] = [];
    for (const item of filtered) {
      const hash = String(item.entry.fileHash ?? "");
      const dedupeKey = hash || item.entry.id;
      if (seenHashes.has(dedupeKey)) {
        continue;
      }
      seenHashes.add(dedupeKey);
      deduped.push(item);
      if (deduped.length >= limit) {
        break;
      }
    }
    return deduped;
  }

  private rowToFullEntry(row: any): MediaEntry {
    return {
      ...this.rowToEntry(row),
      vector: row.vector as number[],
    };
  }

  /**
   * 通过文件路径查找
   */
  async findByPath(filePath: string): Promise<MediaEntry | null> {
    await this.ensureInitialized();
    await this.refreshToLatest();

    try {
      const results = await this.table!
        .query()
        .where("`filePath` = '" + filePath.replace(/'/g, "''") + "'")
        .limit(1)
        .toArray();

      if (results && results.length > 0) {
        return this.rowToFullEntry(results[0]);
      }
    } catch {
      // where 查询失败，回退到全量扫描
    }

    const allRows = await this.getAllRows();
    const row = allRows.find((r) => r.filePath === filePath);
    return row ? this.rowToFullEntry(row) : null;
  }

  async findByHash(fileHash: string): Promise<MediaEntry | null> {
    const matches = await this.findEntriesByHash(fileHash, 1);
    return matches[0] ?? null;
  }

  async findEntriesByHash(fileHash: string, limit = 1000): Promise<MediaEntry[]> {
    await this.ensureInitialized();
    await this.refreshToLatest();

    const escapedHash = fileHash.replace(/'/g, "''");
    const safeLimit =
      typeof limit === "number" && Number.isFinite(limit) && limit > 0
        ? Math.floor(limit)
        : 1000;

    try {
      const results = await this.table!
        .query()
        .where("`fileHash` = '" + escapedHash + "'")
        .limit(safeLimit)
        .toArray();

      if (results && results.length > 0) {
        return results.map((row) => this.rowToFullEntry(row));
      }
    } catch {
      // where 查询失败，回退到全量扫描
    }

    const allRows = await this.getAllRows();
    const filtered = allRows
      .filter((row) => row.fileHash === fileHash)
      .slice(0, safeLimit)
      .map((row) => this.rowToFullEntry(row));
    return filtered;
  }

  async delete(id: string): Promise<boolean> {
    await this.ensureInitialized();

    const uuidRegex =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(id)) {
      throw new Error(`Invalid ID format: ${id}`);
    }

    await this.table!.delete(`id = '${id}'`);
    this.markAutoOptimizeDirty();
    return true;
  }

  async deleteByPath(filePath: string): Promise<number> {
    await this.ensureInitialized();
    await this.refreshToLatest();

    const matches = await this.findEntriesByPath(filePath);
    if (matches.length === 0) {
      return 0;
    }

    let removed = 0;
    for (const entry of matches) {
      try {
        if (await this.delete(entry.id)) {
          removed++;
        }
      } catch {
        // 忽略异常 ID，继续处理其余条目
      }
    }
    return removed;
  }

  private async getAllRows(): Promise<any[]> {
    await this.ensureInitialized();
    await this.refreshToLatest();

    try {
      const totalRows = await this.table!.countRows();
      if (totalRows === 0) {
        return [];
      }
      const results = await this.table!.query().limit(totalRows).toArray();
      return Array.isArray(results) ? results : [];
    } catch (error) {
      console.warn(`[multimodal-rag] getAllRows failed: ${String(error)}`);
      return [];
    }
  }

  private async findEntriesByPath(filePath: string): Promise<MediaEntry[]> {
    try {
      const results = await this.table!
        .query()
        .where("`filePath` = '" + filePath.replace(/'/g, "''") + "'")
        .limit(1000)
        .toArray();
      if (Array.isArray(results) && results.length > 0) {
        return results.map((row) => this.rowToFullEntry(row));
      }
    } catch {
      // where 查询失败，回退到全量扫描
    }

    const allRows = await this.getAllRows();
    return allRows
      .filter((r) => r.filePath === filePath)
      .map((row) => this.rowToFullEntry(row));
  }

  async listAllEntries(): Promise<Omit<MediaEntry, "vector">[]> {
    const rows = await this.getAllRows();
    return rows.map((row) => this.rowToEntry(row));
  }

  private rowToEntry(row: any): Omit<MediaEntry, "vector"> {
    return {
      id: row.id as string,
      filePath: row.filePath as string,
      fileName: row.fileName as string,
      fileType: row.fileType as Extract<MediaType, "image" | "audio">,
      description: row.description as string,
      fileHash: row.fileHash as string,
      fileSize: row.fileSize as number,
      fileCreatedAt: row.fileCreatedAt as number,
      fileModifiedAt: row.fileModifiedAt as number,
      indexedAt: row.indexedAt as number,
    };
  }

  async list(
    options: {
      type?: MediaType | "all";
      after?: number;
      before?: number;
      limit?: number;
      offset?: number;
    } = {},
  ): Promise<{ total: number; entries: Omit<MediaEntry, "vector">[] }> {
    const { type = "all", after, before, limit = 20, offset = 0 } = options;

    if (type === "document") {
      return { total: 0, entries: [] };
    }

    let allResults = await this.getAllRows();

    if (type !== "all") {
      allResults = allResults.filter((r) => r.fileType === type);
    }

    if (after || before) {
      allResults = allResults.filter((r) => {
        const ts = r.fileCreatedAt;
        if (after && ts < after) return false;
        if (before && ts > before) return false;
        return true;
      });
    }

    allResults.sort((a, b) => (b.fileCreatedAt as number) - (a.fileCreatedAt as number));

    const total = allResults.length;
    const paged = allResults.slice(offset, offset + limit);
    const entries = paged.map((row) => this.rowToEntry(row));

    return { total, entries };
  }

  async count(type?: MediaType | "all"): Promise<number> {
    const allRows = await this.getAllRows();
    if (!type || type === "all") {
      return allRows.length;
    }
    if (type === "document") {
      return 0;
    }
    return allRows.filter((r) => r.fileType === type).length;
  }

  private isFailedMediaDescription(description: string): boolean {
    return FAILED_MEDIA_DESCRIPTION_PATTERNS.some((pattern) => pattern.test(description));
  }

  async cleanupFailedMediaEntries(): Promise<{ removed: number; candidates: number }> {
    await this.ensureInitialized();
    await this.refreshToLatest();

    const rows = await this.getAllRows();
    const candidates = rows.filter((row) => {
      const fileType = String(row.fileType ?? "");
      if (fileType !== "audio" && fileType !== "image") {
        return false;
      }
      const description = String(row.description ?? "").trim();
      return this.isFailedMediaDescription(description);
    });

    let removed = 0;
    for (const row of candidates) {
      const id = String(row.id ?? "");
      if (!id) {
        continue;
      }
      await this.table!.delete(`id = '${id.replace(/'/g, "''")}'`);
      removed++;
    }

    if (removed > 0) {
      this.markAutoOptimizeDirty();
    }

    return { removed, candidates: candidates.length };
  }

  async cleanupFailedAudioEntries(): Promise<{ removed: number; candidates: number }> {
    return this.cleanupFailedMediaEntries();
  }

  async cleanupMissingEntries(
    options: CleanupMissingOptions = {},
  ): Promise<CleanupMissingResult> {
    const startedAt = Date.now();
    await this.ensureInitialized();
    await this.refreshToLatest();

    const { dryRun = false, limit, candidates } = options;
    let scanPool: Array<{ id: string; filePath: string }> = [];

    if (Array.isArray(candidates) && candidates.length > 0) {
      scanPool = candidates
        .map((c) => ({ id: String(c.id ?? ""), filePath: String(c.filePath ?? "") }))
        .filter((c) => c.id && c.filePath);
    } else {
      const rows = await this.getAllRows();
      const limitedRows =
        typeof limit === "number" && Number.isFinite(limit) && limit > 0
          ? rows.slice(0, Math.floor(limit))
          : rows;
      scanPool = limitedRows
        .map((row) => ({
          id: String(row.id ?? ""),
          filePath: String(row.filePath ?? ""),
        }))
        .filter((row) => row.id && row.filePath);
    }

    const scanned = scanPool.length;
    const missingIds: string[] = [];
    for (const item of scanPool) {
      if (await this.isPathMissing(item.filePath)) {
        missingIds.push(item.id);
      }
    }

    const uniqueMissingIds = [...new Set(missingIds)];
    let removed = 0;
    if (!dryRun) {
      for (const id of uniqueMissingIds) {
        try {
          if (await this.delete(id)) {
            removed++;
          }
        } catch {
          // 忽略异常 ID，继续处理其余条目
        }
      }
    }

    const result = {
      scanned,
      missing: uniqueMissingIds.length,
      removed,
      missingIds: uniqueMissingIds,
    };
    const durationMs = Date.now() - startedAt;
    const hitRate = scanned > 0 ? result.missing / scanned : 0;
    console.info(
      JSON.stringify({
        event: "cleanup_missing_entries_completed",
        scanned: result.scanned,
        missing: result.missing,
        removed: result.removed,
        durationMs,
        hitRate: Number.parseFloat(hitRate.toFixed(4)),
        dryRun,
      }),
    );
    return result;
  }

  private async isPathMissing(filePath: string): Promise<boolean> {
    try {
      await stat(filePath);
      return false;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      return code === "ENOENT" || code === "ENOTDIR";
    }
  }

  async clear(): Promise<void> {
    await this.ensureInitialized();
    await this.table!.delete("id IS NOT NULL");
    await this.docTable!.delete("id IS NOT NULL");
    this.markAutoOptimizeDirty();
  }

  // ============================================================
  // doc_chunks 表 API（document）
  // ============================================================

  /**
   * 批量存储文档 chunks
   */
  async storeDocChunks(
    chunks: Array<Omit<DocChunkEntry, "id" | "indexedAt">>,
  ): Promise<DocChunkEntry[]> {
    await this.ensureInitialized();

    if (chunks.length === 0) {
      return [];
    }

    const now = Date.now();
    const fullChunks: DocChunkEntry[] = chunks.map((chunk) => ({
      ...chunk,
      id: randomUUID(),
      indexedAt: now,
    }));

    await this.docTable!.add(fullChunks);
    await this.ensureDocScalarFilterIndices();
    this.markAutoOptimizeDirty();
    return fullChunks;
  }

  /**
   * 按文件路径替换文档 chunks（先删光旧的，再插入新的）
   */
  async replaceDocChunksByPath(
    filePath: string,
    chunks: Array<Omit<DocChunkEntry, "id" | "indexedAt">>,
  ): Promise<DocChunkEntry[]> {
    await this.ensureInitialized();
    await this.refreshToLatest();
    await this.deleteDocChunksByPath(filePath);
    return this.storeDocChunks(chunks);
  }

  /**
   * 查找某文件路径下的所有 chunks（按 chunkIndex 升序）
   */
  async findDocChunksByPath(filePath: string): Promise<DocChunkEntry[]> {
    await this.ensureInitialized();
    await this.refreshToLatest();

    try {
      const results = await this.docTable!
        .query()
        .where("`filePath` = '" + filePath.replace(/'/g, "''") + "'")
        .limit(10000)
        .toArray();
      if (Array.isArray(results) && results.length > 0) {
        return results
          .map((row) => this.rowToFullDocChunk(row))
          .sort((a, b) => a.chunkIndex - b.chunkIndex);
      }
    } catch {
      // where 查询失败，回退到全量扫描
    }

    const allRows = await this.getAllDocChunkRows();
    return allRows
      .filter((r) => r.filePath === filePath)
      .map((row) => this.rowToFullDocChunk(row))
      .sort((a, b) => a.chunkIndex - b.chunkIndex);
  }

  /**
   * 按 hash 查找文档 chunks（只返回 path 存在的第一份文件的全量 chunks）
   */
  async findDocChunksByHash(
    fileHash: string,
    limit = 10000,
  ): Promise<DocChunkEntry[]> {
    await this.ensureInitialized();
    await this.refreshToLatest();

    const escaped = fileHash.replace(/'/g, "''");
    const safeLimit =
      typeof limit === "number" && Number.isFinite(limit) && limit > 0
        ? Math.floor(limit)
        : 10000;

    try {
      const results = await this.docTable!
        .query()
        .where("`fileHash` = '" + escaped + "'")
        .limit(safeLimit)
        .toArray();
      if (Array.isArray(results) && results.length > 0) {
        return results.map((row) => this.rowToFullDocChunk(row));
      }
    } catch {
      // where 查询失败，回退到全量扫描
    }

    const allRows = await this.getAllDocChunkRows();
    return allRows
      .filter((r) => r.fileHash === fileHash)
      .slice(0, safeLimit)
      .map((row) => this.rowToFullDocChunk(row));
  }

  /**
   * 按路径删除所有 chunks
   */
  async deleteDocChunksByPath(filePath: string): Promise<number> {
    await this.ensureInitialized();
    await this.refreshToLatest();

    const escaped = filePath.replace(/'/g, "''");
    try {
      await this.docTable!.delete(`\`filePath\` = '${escaped}'`);
      this.markAutoOptimizeDirty();
      // 无法直接拿到删除数量（LanceDB delete 不返回 count），返回近似值
      return 1;
    } catch {
      // 回退：逐行删
      const matches = await this.findDocChunksByPath(filePath);
      let removed = 0;
      for (const chunk of matches) {
        try {
          await this.docTable!.delete(`id = '${chunk.id}'`);
          removed++;
        } catch {
          // 忽略
        }
      }
      if (removed > 0) {
        this.markAutoOptimizeDirty();
      }
      return removed;
    }
  }

  /**
   * 在 doc_chunks 里做向量搜索
   */
  async searchDocChunks(
    vector: number[],
    options: DocSearchOptions = {},
  ): Promise<DocChunkSearchResult[]> {
    await this.ensureInitialized();
    await this.refreshToLatest();

    const { after, before, limit = 5, minScore = 0.25, fileExt } = options;

    const candidateLimit = Math.max(limit * 4, 20);
    let query = this.docTable!.vectorSearch(vector).limit(candidateLimit);

    const conditions: string[] = [];
    if (fileExt) {
      conditions.push("`fileExt` = '" + fileExt.replace(/'/g, "''") + "'");
    }
    if (after) {
      conditions.push("`fileCreatedAt` >= " + after);
    }
    if (before) {
      conditions.push("`fileCreatedAt` <= " + before);
    }
    if (conditions.length > 0) {
      query = query.where(conditions.join(" AND "));
    }

    const results = await query.toArray();

    const mapped: DocChunkSearchResult[] = results.map((row) => {
      const distance = row._distance ?? 0;
      const score = 1 / (1 + distance);
      return {
        chunk: this.rowToDocChunk(row),
        score,
      };
    });

    return mapped.filter((r) => r.score >= minScore).slice(0, limit);
  }

  /**
   * 按 docId(=fileHash) 聚合 chunk 搜索结果 → 每文件一条 + snippet
   */
  async searchDocsAggregated(
    vector: number[],
    options: DocSearchOptions & { snippetMaxChars?: number } = {},
  ): Promise<Array<{ doc: DocSummary; bestChunk: Omit<DocChunkEntry, "vector">; score: number }>> {
    const { snippetMaxChars = 120, ...rest } = options;
    // 多取一些 chunk，聚合后可能不够
    const limit = rest.limit ?? 5;
    const chunkResults = await this.searchDocChunks(vector, {
      ...rest,
      limit: Math.max(limit * 4, 20),
    });

    // 按 docId 聚合，保留最高分
    const bestByDoc = new Map<string, DocChunkSearchResult>();
    for (const item of chunkResults) {
      const docId = item.chunk.docId;
      const existing = bestByDoc.get(docId);
      if (!existing || item.score > existing.score) {
        bestByDoc.set(docId, item);
      }
    }

    const aggregated = [...bestByDoc.values()].sort((a, b) => b.score - a.score).slice(0, limit);

    return aggregated.map((item) => {
      const chunk = item.chunk;
      const snippet = makeSnippet(chunk.chunkText, snippetMaxChars);
      const summary: DocSummary = {
        docId: chunk.docId,
        filePath: chunk.filePath,
        fileName: chunk.fileName,
        fileExt: chunk.fileExt,
        totalChunks: chunk.totalChunks,
        fileSize: chunk.fileSize,
        fileCreatedAt: chunk.fileCreatedAt,
        fileModifiedAt: chunk.fileModifiedAt,
        indexedAt: chunk.indexedAt,
        snippet,
        topPageNumber: chunk.pageNumber,
        topHeading: chunk.heading,
      };
      return { doc: summary, bestChunk: chunk, score: item.score };
    });
  }

  /**
   * 列出所有文档（按 docId/filePath 聚合）
   */
  async listDocSummaries(
    options: {
      after?: number;
      before?: number;
      limit?: number;
      offset?: number;
      fileExt?: string;
    } = {},
  ): Promise<{ total: number; docs: DocSummary[] }> {
    const { after, before, limit = 20, offset = 0, fileExt } = options;

    let rows = await this.getAllDocChunkRows();

    if (fileExt) {
      rows = rows.filter((r) => r.fileExt === fileExt);
    }
    if (after) {
      rows = rows.filter((r) => (r.fileCreatedAt as number) >= after);
    }
    if (before) {
      rows = rows.filter((r) => (r.fileCreatedAt as number) <= before);
    }

    // 按 filePath 分组，每组取 chunkIndex=0 或第 1 段作为 snippet
    const groups = new Map<string, any[]>();
    for (const row of rows) {
      const key = String(row.filePath ?? "");
      if (!key) continue;
      const bucket = groups.get(key) ?? [];
      bucket.push(row);
      groups.set(key, bucket);
    }

    const docs: DocSummary[] = [];
    for (const [filePath, bucket] of groups.entries()) {
      bucket.sort((a, b) => (a.chunkIndex as number) - (b.chunkIndex as number));
      const first = bucket[0];
      const summary: DocSummary = {
        docId: String(first.docId ?? ""),
        filePath,
        fileName: String(first.fileName ?? ""),
        fileExt: String(first.fileExt ?? ""),
        totalChunks: Number(first.totalChunks ?? bucket.length),
        fileSize: Number(first.fileSize ?? 0),
        fileCreatedAt: Number(first.fileCreatedAt ?? 0),
        fileModifiedAt: Number(first.fileModifiedAt ?? 0),
        indexedAt: Number(first.indexedAt ?? 0),
        snippet: makeSnippet(String(first.chunkText ?? ""), 120),
        topPageNumber: Number(first.pageNumber ?? 0),
        topHeading: String(first.heading ?? ""),
      };
      docs.push(summary);
    }

    docs.sort((a, b) => b.fileCreatedAt - a.fileCreatedAt);

    const total = docs.length;
    const paged = docs.slice(offset, offset + limit);
    return { total, docs: paged };
  }

  /**
   * 文档文件数（去重按 filePath）
   */
  async countDocs(): Promise<number> {
    const paths = await this.listIndexedDocPaths();
    return paths.length;
  }

  /**
   * 列出 doc_chunks 表里所有唯一的文件路径（供启动扫描比对使用）
   */
  async listIndexedDocPaths(): Promise<string[]> {
    const rows = await this.getAllDocChunkRows();
    const paths = new Set<string>();
    for (const row of rows) {
      const p = String(row.filePath ?? "");
      if (p) paths.add(p);
    }
    return [...paths];
  }

  /**
   * chunk 总条数
   */
  async countDocChunks(): Promise<number> {
    await this.ensureInitialized();
    await this.refreshToLatest();
    try {
      return await this.docTable!.countRows();
    } catch {
      const rows = await this.getAllDocChunkRows();
      return rows.length;
    }
  }

  /**
   * 清理"索引存在但源文档文件已丢失"的条目（按 filePath 去重扫描）
   */
  async cleanupMissingDocChunks(
    options: { dryRun?: boolean; candidates?: string[] } = {},
  ): Promise<CleanupMissingDocsResult> {
    const startedAt = Date.now();
    await this.ensureInitialized();
    await this.refreshToLatest();

    const { dryRun = false, candidates } = options;

    // 候选集合：按 filePath 去重
    let candidatePaths: string[];
    if (Array.isArray(candidates) && candidates.length > 0) {
      candidatePaths = [...new Set(candidates.filter((p) => typeof p === "string" && p))];
    } else {
      const rows = await this.getAllDocChunkRows();
      const set = new Set<string>();
      for (const row of rows) {
        const p = String(row.filePath ?? "");
        if (p) set.add(p);
      }
      candidatePaths = [...set];
    }

    const missingPaths: string[] = [];
    for (const p of candidatePaths) {
      if (await this.isPathMissing(p)) {
        missingPaths.push(p);
      }
    }

    let removedChunks = 0;
    if (!dryRun) {
      for (const p of missingPaths) {
        const removed = await this.deleteDocChunksByPath(p);
        removedChunks += removed;
      }
    }

    const result = {
      scanned: candidatePaths.length,
      missingPaths: missingPaths.length,
      removedChunks,
      missingFilePaths: missingPaths,
    };

    const durationMs = Date.now() - startedAt;
    console.info(
      JSON.stringify({
        event: "cleanup_missing_doc_chunks_completed",
        scanned: result.scanned,
        missingPaths: result.missingPaths,
        removedChunks: result.removedChunks,
        durationMs,
        dryRun,
      }),
    );

    return result;
  }

  /**
   * 列出所有 doc chunk 行（内部）
   */
  private async getAllDocChunkRows(): Promise<any[]> {
    await this.ensureInitialized();
    await this.refreshToLatest();

    try {
      const totalRows = await this.docTable!.countRows();
      if (totalRows === 0) {
        return [];
      }
      const results = await this.docTable!.query().limit(totalRows).toArray();
      return Array.isArray(results) ? results : [];
    } catch (error) {
      console.warn(`[multimodal-rag] getAllDocChunkRows failed: ${String(error)}`);
      return [];
    }
  }

  private rowToFullDocChunk(row: any): DocChunkEntry {
    return {
      ...this.rowToDocChunk(row),
      vector: row.vector as number[],
    };
  }

  private rowToDocChunk(row: any): Omit<DocChunkEntry, "vector"> {
    return {
      id: row.id as string,
      docId: row.docId as string,
      filePath: row.filePath as string,
      fileName: row.fileName as string,
      fileExt: row.fileExt as string,
      chunkIndex: Number(row.chunkIndex ?? 0),
      totalChunks: Number(row.totalChunks ?? 0),
      pageNumber: Number(row.pageNumber ?? 0),
      heading: String(row.heading ?? ""),
      chunkText: String(row.chunkText ?? ""),
      fileHash: row.fileHash as string,
      fileSize: Number(row.fileSize ?? 0),
      fileCreatedAt: Number(row.fileCreatedAt ?? 0),
      fileModifiedAt: Number(row.fileModifiedAt ?? 0),
      indexedAt: Number(row.indexedAt ?? 0),
    };
  }

  // ============================================================
  // 统一聚合 API（供 media_search 工具使用）
  // ============================================================

  /**
   * 统一搜索：media + doc_chunks，按 score 合并
   * 注：调用方已持有一个 query vector
   */
  async unifiedSearch(
    vector: number[],
    options: {
      type?: MediaType | "all";
      after?: number;
      before?: number;
      limit?: number;
      minScore?: number;
      dedupeByHash?: boolean;
    } = {},
  ): Promise<UnifiedSearchResult[]> {
    const {
      type = "all",
      after,
      before,
      limit = 5,
      minScore = 0.25,
      dedupeByHash = true,
    } = options;

    const wantMedia = type === "all" || type === "image" || type === "audio";
    const wantDocs = type === "all" || type === "document";

    const tasks: Promise<unknown>[] = [];
    let mediaResults: MediaSearchResult[] = [];
    let docResults: Array<{
      doc: DocSummary;
      bestChunk: Omit<DocChunkEntry, "vector">;
      score: number;
    }> = [];

    if (wantMedia) {
      tasks.push(
        (async () => {
          mediaResults = await this.search(vector, {
            // search() 内部对 "document" 会早退返回 []，这里无需三元
            type,
            after,
            before,
            limit,
            minScore,
            dedupeByHash,
          });
        })(),
      );
    }
    if (wantDocs) {
      tasks.push(
        (async () => {
          docResults = await this.searchDocsAggregated(vector, {
            after,
            before,
            limit,
            minScore,
          });
        })(),
      );
    }

    await Promise.all(tasks);

    const unified: UnifiedSearchResult[] = [
      ...mediaResults.map<UnifiedSearchResult>((r) => ({
        kind: "media",
        entry: r.entry,
        score: r.score,
      })),
      ...docResults.map<UnifiedSearchResult>((r) => ({
        kind: "document",
        doc: r.doc,
        bestChunk: r.bestChunk,
        score: r.score,
      })),
    ];

    unified.sort((a, b) => b.score - a.score);
    return unified.slice(0, limit);
  }
}

/**
 * 从 chunkText 构造 snippet：优先保留开头，截断时追加省略号
 */
function makeSnippet(text: string, maxChars: number): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return normalized.slice(0, Math.max(0, maxChars - 1)) + "…";
}
