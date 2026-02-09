/**
 * LanceDB 向量存储实现
 */

import * as lancedb from "@lancedb/lancedb";
import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import type { MediaEntry, MediaSearchResult, MediaType } from "./types.js";

const TABLE_NAME = "media";
const FAILED_AUDIO_DESCRIPTION_PATTERN = /^[（(]\s*转录失败[:：]/;

/**
 * 搜索选项
 */
export type SearchOptions = {
  type?: MediaType | "all";
  after?: number; // Unix timestamp (ms)
  before?: number; // Unix timestamp (ms)
  limit?: number;
  minScore?: number;
  dedupeByHash?: boolean;
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

/**
 * LanceDB 媒体存储
 */
export class MediaStorage {
  private db: lancedb.Connection | null = null;
  private table: lancedb.Table | null = null;
  private initPromise: Promise<void> | null = null;

  constructor(
    private readonly dbPath: string,
    private readonly vectorDim: number,
  ) {}

  private async ensureInitialized(): Promise<void> {
    if (this.table) {
      return;
    }
    if (this.initPromise) {
      return this.initPromise;
    }

    this.initPromise = this.doInitialize();
    return this.initPromise;
  }

  /**
   * 刷新表到最新版本
   * LanceDB 的表在 openTable() 后会保持在当时的版本，
   * 需要调用 checkoutLatest() 来刷新到最新数据。
   * 这对于多实例场景（不同渠道可能使用不同的插件实例）非常重要。
   */
  private async refreshToLatest(): Promise<void> {
    if (this.table) {
      try {
        await this.table.checkoutLatest();
      } catch (error) {
        // 忽略 checkoutLatest 错误（可能是表从未进入 time-travel 模式）
        // LanceDB 0.11+ 可能不需要显式调用此方法
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
      // 创建表并定义 schema
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
      // 删除 schema 占位行
      await this.table.delete('id = "__schema__"');
    }
  }

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
    // 刷新到最新版本，确保跨渠道数据一致性
    await this.refreshToLatest();

    const {
      type = "all",
      after,
      before,
      limit = 5,
      minScore = 0.5,
      dedupeByHash = true,
    } = options;

    // 构建查询
    const candidateLimit = Math.max(limit * (dedupeByHash ? 8 : 2), limit);
    let query = this.table!.vectorSearch(vector).limit(candidateLimit); // 多获取一些，过滤后可能不够

    // 时间过滤（LanceDB 字段名需要反引号包裹，大小写敏感）
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

    // LanceDB 使用 L2 距离，转换为相似度分数
    const mapped = results.map((row) => {
      const distance = row._distance ?? 0;
      // 转换: score = 1 / (1 + distance)
      const score = 1 / (1 + distance);
      return {
        entry: {
          id: row.id as string,
          filePath: row.filePath as string,
          fileName: row.fileName as string,
          fileType: row.fileType as MediaType,
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

    // 过滤低分结果
    const filtered = mapped.filter((r) => r.score >= minScore);

    // 默认按内容 hash 去重展示：只保留每个 hash 的首条（分数最高）
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

  /**
   * 将行数据转换为完整 MediaEntry（含 vector）
   */
  private rowToFullEntry(row: any): MediaEntry {
    return {
      ...this.rowToEntry(row),
      vector: row.vector as number[],
    };
  }

  /**
   * 通过文件路径查找
   * 先尝试 where() 查询（快速路径），失败或无结果时回退到全量扫描
   */
  async findByPath(filePath: string): Promise<MediaEntry | null> {
    await this.ensureInitialized();
    await this.refreshToLatest();

    // 快速路径：where 查询
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

    // 回退：全量扫描（处理 LanceDB fragment 不一致问题）
    const allRows = await this.getAllRows();
    const row = allRows.find((r) => r.filePath === filePath);
    return row ? this.rowToFullEntry(row) : null;
  }

  /**
   * 通过 hash 查找（去重）
   * 先尝试 where() 查询（快速路径），失败或无结果时回退到全量扫描
   */
  async findByHash(fileHash: string): Promise<MediaEntry | null> {
    await this.ensureInitialized();
    await this.refreshToLatest();

    // 快速路径：where 查询
    try {
      const results = await this.table!
        .query()
        .where("`fileHash` = '" + fileHash + "'")
        .limit(1)
        .toArray();

      if (results && results.length > 0) {
        return this.rowToFullEntry(results[0]);
      }
    } catch {
      // where 查询失败，回退到全量扫描
    }

    // 回退：全量扫描（处理 LanceDB fragment 不一致问题）
    const allRows = await this.getAllRows();
    const row = allRows.find((r) => r.fileHash === fileHash);
    return row ? this.rowToFullEntry(row) : null;
  }

  /**
   * 删除条目
   */
  async delete(id: string): Promise<boolean> {
    await this.ensureInitialized();

    // UUID 格式验证（防注入）
    const uuidRegex =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(id)) {
      throw new Error(`Invalid ID format: ${id}`);
    }

    await this.table!.delete(`id = '${id}'`);
    return true;
  }

  /**
   * 按路径删除条目
   */
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

  /**
   * 获取所有行（不使用 where 过滤，避免 LanceDB 查询 bug）
   *
   * 重要: LanceDB query().toArray() 有一个隐含的默认 limit（约 10 行），
   * 必须显式调用 .limit() 才能获取全部数据。这里使用 countRows() 获取
   * 准确行数，然后传给 limit() 确保一次性取回所有行。
   */
  private async getAllRows(): Promise<any[]> {
    await this.ensureInitialized();
    await this.refreshToLatest();

    try {
      // 先获取准确行数，再用 limit 取全部
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

  /**
   * 列出全部条目（不分页）
   */
  async listAllEntries(): Promise<Omit<MediaEntry, "vector">[]> {
    const rows = await this.getAllRows();
    return rows.map((row) => this.rowToEntry(row));
  }

  /**
   * 将行数据转换为 MediaEntry（不含 vector）
   */
  private rowToEntry(row: any): Omit<MediaEntry, "vector"> {
    return {
      id: row.id as string,
      filePath: row.filePath as string,
      fileName: row.fileName as string,
      fileType: row.fileType as MediaType,
      description: row.description as string,
      fileHash: row.fileHash as string,
      fileSize: row.fileSize as number,
      fileCreatedAt: row.fileCreatedAt as number,
      fileModifiedAt: row.fileModifiedAt as number,
      indexedAt: row.indexedAt as number,
    };
  }

  /**
   * 列出所有条目（支持分页和过滤）
   */
  async list(options: {
    type?: MediaType | "all";
    after?: number;
    before?: number;
    limit?: number;
    offset?: number;
  } = {}): Promise<{ total: number; entries: Omit<MediaEntry, "vector">[] }> {
    const {
      type = "all",
      after,
      before,
      limit = 20,
      offset = 0,
    } = options;

    // 获取所有行（不用 where，避免 LanceDB fragment 不一致 bug）
    let allResults = await this.getAllRows();

    // 内存中按类型过滤
    if (type !== "all") {
      allResults = allResults.filter((r) => r.fileType === type);
    }

    // 内存中按时间过滤
    if (after || before) {
      allResults = allResults.filter((r) => {
        const ts = r.fileCreatedAt;
        if (after && ts < after) return false;
        if (before && ts > before) return false;
        return true;
      });
    }

    // 按时间倒序排序（最新在前）
    allResults.sort((a, b) => (b.fileCreatedAt as number) - (a.fileCreatedAt as number));

    const total = allResults.length;

    // 分页
    const paged = allResults.slice(offset, offset + limit);

    const entries = paged.map((row) => this.rowToEntry(row));

    return { total, entries };
  }

  /**
   * 统计信息（使用全量扫描，确保和 list() 结果一致）
   */
  async count(type?: MediaType | "all"): Promise<number> {
    const allRows = await this.getAllRows();
    if (!type || type === "all") {
      return allRows.length;
    }
    return allRows.filter((r) => r.fileType === type).length;
  }

  /**
   * 清理历史版本写入的音频脏数据（转录失败文本）
   */
  async cleanupFailedAudioEntries(): Promise<{ removed: number; candidates: number }> {
    await this.ensureInitialized();
    await this.refreshToLatest();

    const rows = await this.getAllRows();
    const candidates = rows.filter((row) => {
      if (row.fileType !== "audio") {
        return false;
      }
      const description = String(row.description ?? "").trim();
      return FAILED_AUDIO_DESCRIPTION_PATTERN.test(description);
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

    return { removed, candidates: candidates.length };
  }

  /**
   * 清理“索引存在但原文件已丢失”的条目
   */
  async cleanupMissingEntries(
    options: CleanupMissingOptions = {},
  ): Promise<CleanupMissingResult> {
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

    return {
      scanned,
      missing: uniqueMissingIds.length,
      removed,
      missingIds: uniqueMissingIds,
    };
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

  /**
   * 清空所有数据
   */
  async clear(): Promise<void> {
    await this.ensureInitialized();
    await this.table!.delete("id IS NOT NULL");
  }
}
