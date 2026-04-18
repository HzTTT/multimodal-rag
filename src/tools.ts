/**
 * Agent 工具定义
 */

import { Type } from "@sinclair/typebox";
import { readdir, stat } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { homedir } from "node:os";
import { basename, extname, join, resolve } from "node:path";
import type { MediaStorage } from "./storage.js";
import type {
  DocSummary,
  IEmbeddingProvider,
  IMediaProcessor,
  MediaType,
  PluginConfig,
  UnifiedSearchResult,
} from "./types.js";
import type { MediaWatcher } from "./watcher.js";

type UnindexedFile = {
  filePath: string;
  fileName: string;
  fileType: MediaType;
  fileCreatedAt: number;
  fileModifiedAt: number;
};

type IndexedCandidate = {
  id: string;
  filePath: string;
};

function makeTextContent(text: string): Array<{ type: "text"; text: string }> {
  return [{ type: "text", text }];
}

function parseIsoDate(value: unknown, field: string): { value?: number; error?: string } {
  if (value === undefined || value === null || value === "") {
    return { value: undefined };
  }
  if (typeof value !== "string") {
    return { error: `${field} 必须是 ISO 日期字符串` };
  }
  const ts = new Date(value).getTime();
  if (!Number.isFinite(ts)) {
    return { error: `${field} 不是合法日期，示例：2026-02-05T23:59:59` };
  }
  return { value: ts };
}

function parsePositiveInt(
  value: unknown,
  field: string,
  options: { min?: number; defaultValue: number },
): { value: number; error?: string } {
  const { min = 1, defaultValue } = options;
  if (value === undefined || value === null || value === "") {
    return { value: defaultValue };
  }
  const n = Number(value);
  if (!Number.isInteger(n) || n < min) {
    return { value: defaultValue, error: `${field} 必须是 >= ${min} 的整数` };
  }
  return { value: n };
}

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

function isMissingPathError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

async function splitExistingAndMissingCandidates(candidates: IndexedCandidate[]): Promise<{
  existingIds: Set<string>;
  missingCandidates: IndexedCandidate[];
}> {
  const checks = await Promise.all(
    candidates.map(async (candidate) => {
      try {
        await stat(candidate.filePath);
        return { ...candidate, missing: false };
      } catch (error) {
        return {
          ...candidate,
          missing: isMissingPathError(error),
        };
      }
    }),
  );

  const existingIds = new Set<string>();
  const missingCandidates: IndexedCandidate[] = [];
  for (const item of checks) {
    if (item.missing) {
      missingCandidates.push({ id: item.id, filePath: item.filePath });
      continue;
    }
    existingIds.add(item.id);
  }

  return { existingIds, missingCandidates };
}

/**
 * 扫描目录下的媒体文件（递归），返回 mtime 倒序的前 maxFiles 个。
 * 用于“文件已存在但尚未完成索引”的兜底场景。
 */
async function scanDirectoryForMediaFiles(options: {
  dirPath: string;
  imageExts: string[];
  audioExts: string[];
  type: MediaType | "all";
  maxFiles: number;
}): Promise<UnindexedFile[]> {
  const { dirPath, imageExts, audioExts, type, maxFiles } = options;

  const supportedExts =
    type === "image"
      ? imageExts
      : type === "audio"
        ? audioExts
        : [...imageExts, ...audioExts];

  const results: UnindexedFile[] = [];

  const walk = async (p: string): Promise<void> => {
    // 粗暴上限：避免在超大目录里无限扫描
    if (results.length >= maxFiles * 20) {
      return;
    }

    let entries: Dirent[];
    try {
      entries = await readdir(p, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry.name.startsWith(".")) {
        continue;
      }
      const fullPath = join(p, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }

      const ext = extname(entry.name).toLowerCase();
      if (!supportedExts.includes(ext)) {
        continue;
      }

      let s: Awaited<ReturnType<typeof stat>>;
      try {
        s = await stat(fullPath);
      } catch {
        continue;
      }

      const fileType: MediaType = imageExts.includes(ext) ? "image" : "audio";
      results.push({
        filePath: fullPath,
        fileName: basename(fullPath),
        fileType,
        // 与已索引条目口径一致：统一使用 mtime 作为时间基准
        fileCreatedAt: s.mtimeMs,
        fileModifiedAt: s.mtimeMs,
      });
    }
  };

  await walk(dirPath);

  results.sort((a, b) => b.fileModifiedAt - a.fileModifiedAt);
  return results.slice(0, maxFiles);
}

/**
 * 创建 media_search 工具
 */
export function createMediaSearchTool(
  storage: MediaStorage,
  embeddings: IEmbeddingProvider,
) {
  return {
    name: "media_search",
    label: "Media Search",
    description:
      "对已索引的本地知识库做语义搜索（图片描述 / 音频转录 / 文档内容）。\n\n" +
      "能力边界：\n" +
      "- 仅能搜索“已完成索引”的数据（即数据库里已有 description/chunk + embedding 的条目）\n" +
      "- 如果文件刚产生、尚未索引完，语义搜索可能搜不到；此时可用 `media_list`（includeUnindexed=true）从磁盘侧拿到真实文件路径\n" +
      "- 文档结果按文件聚合展示：每个文件一行 + 最高分 chunk 的摘录（snippet），便于 agent 判断相关性\n\n" +
      "搜索类型：\n" +
      "- type='audio': 搜索录音转录文本\n" +
      "- type='image': 搜索图片描述\n" +
      "- type='document': 搜索文档内容（PDF / Word / Excel / PPT / 纯文本）\n" +
      "- type='all': 同时搜索（默认）\n\n" +
      "**【强制要求】立即响应用户**：\n" +
      "⚠️ 搜到 image/audio 文件时，必须立即将媒体文件发送给用户（根据当前渠道）。\n" +
      "⚠️ 搜到 document 时，至少在回复里给出文件路径和 snippet，方便用户定位原文。\n" +
      "发送最匹配的 1-3 个结果，同时简要说明每个结果的内容。",
    parameters: Type.Object({
      query: Type.String({
        description: "搜索关键词或内容描述。应该是简短的关键词，如'东方明珠'、'会议'、'食物'、'季度财报'，而不是完整问句",
      }),
      type: Type.Optional(
        Type.Union([
          Type.Literal("image"),
          Type.Literal("audio"),
          Type.Literal("document"),
          Type.Literal("all"),
        ]),
      ),
      after: Type.Optional(
        Type.String({
          description: "开始时间，ISO 格式如 2026-01-29T00:00:00",
        }),
      ),
      before: Type.Optional(
        Type.String({
          description: "结束时间，ISO 格式如 2026-02-05T23:59:59",
        }),
      ),
      limit: Type.Optional(
        Type.Number({
          description: "返回数量，默认 5，建议 3-10",
          default: 5,
        }),
      ),
    }),
    async execute(_toolCallId: string, params: any) {
      const { query, type = "all", after, before, limit = 5 } = params;
      const normalizedQuery = typeof query === "string" ? query.trim() : "";
      if (!normalizedQuery) {
        return {
          content: makeTextContent("query 不能为空，请提供搜索关键词。"),
          details: { count: 0, error: "invalid_query" },
        };
      }

      const parsedAfter = parseIsoDate(after, "after");
      if (parsedAfter.error) {
        return {
          content: makeTextContent(parsedAfter.error),
          details: { count: 0, error: "invalid_after" },
        };
      }
      const parsedBefore = parseIsoDate(before, "before");
      if (parsedBefore.error) {
        return {
          content: makeTextContent(parsedBefore.error),
          details: { count: 0, error: "invalid_before" },
        };
      }
      if (
        parsedAfter.value !== undefined &&
        parsedBefore.value !== undefined &&
        parsedAfter.value > parsedBefore.value
      ) {
        return {
          content: makeTextContent("after 不能晚于 before。"),
          details: { count: 0, error: "invalid_date_range" },
        };
      }

      const parsedLimit = parsePositiveInt(limit, "limit", {
        min: 1,
        defaultValue: 5,
      });
      if (parsedLimit.error) {
        return {
          content: makeTextContent(parsedLimit.error),
          details: { count: 0, error: "invalid_limit" },
        };
      }

      console.log(
        `[multimodal-rag] media_search called with query: "${normalizedQuery}" type=${type}`,
      );

      try {
        const vector = await embeddings.embed(normalizedQuery);
        const afterTs = parsedAfter.value;
        const beforeTs = parsedBefore.value;

        const unified = await storage.unifiedSearch(vector, {
          type: type as MediaType | "all",
          after: afterTs,
          before: beforeTs,
          limit: parsedLimit.value,
          minScore: 0.25,
        });
        console.log(
          `[multimodal-rag] unifiedSearch returned ${unified.length} results`,
        );

        // 媒体结果：过滤已删除文件，并清理失效索引
        const mediaCandidates = unified
          .filter((r): r is Extract<UnifiedSearchResult, { kind: "media" }> => r.kind === "media")
          .map((r) => ({ id: r.entry.id, filePath: r.entry.filePath }));
        const { existingIds, missingCandidates } =
          await splitExistingAndMissingCandidates(mediaCandidates);
        let cleanedMissingMedia = 0;
        if (missingCandidates.length > 0) {
          const cleanup = await storage.cleanupMissingEntries({
            candidates: missingCandidates,
            dryRun: false,
          });
          cleanedMissingMedia = cleanup.removed;
        }

        // 文档结果：过滤已删除原文件，并清理失效 chunks
        const docPaths = unified
          .filter((r): r is Extract<UnifiedSearchResult, { kind: "document" }> => r.kind === "document")
          .map((r) => r.doc.filePath);
        const existingDocPaths = new Set<string>();
        const missingDocPaths: string[] = [];
        for (const p of docPaths) {
          try {
            await stat(p);
            existingDocPaths.add(p);
          } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (code === "ENOENT" || code === "ENOTDIR") {
              missingDocPaths.push(p);
            } else {
              existingDocPaths.add(p);
            }
          }
        }
        let cleanedMissingDocs = 0;
        if (missingDocPaths.length > 0) {
          const cleanup = await storage.cleanupMissingDocChunks({
            candidates: missingDocPaths,
            dryRun: false,
          });
          cleanedMissingDocs = cleanup.removedChunks;
        }

        const visible = unified.filter((r) => {
          if (r.kind === "media") return existingIds.has(r.entry.id);
          return existingDocPaths.has(r.doc.filePath);
        });

        const cleanedMissing = cleanedMissingMedia + cleanedMissingDocs;

        if (visible.length === 0) {
          const totalCount = await storage.count();
          const docCount = await storage.countDocs();
          const cleanupHint =
            cleanedMissing > 0
              ? `\n\n已自动清理 ${cleanedMissing} 条“源文件已删除”的失效索引。`
              : "";
          return {
            content: makeTextContent(
              `未找到与「${normalizedQuery}」相关的内容。\n\n知识库中共有 ${totalCount} 个媒体文件 + ${docCount} 个文档。建议：\n1. 尝试使用更通用的关键词\n2. 使用 media_list 浏览文件列表\n3. 调整时间范围（如果设置了 after/before）${cleanupHint}`,
            ),
            details: {
              count: 0,
              query: normalizedQuery,
              totalMediaInDatabase: totalCount,
              totalDocsInDatabase: docCount,
              cleanedMissing,
              suggestion: "try_broader_keywords_or_use_media_list",
            },
          };
        }

        const text = visible
          .map((r, i) => formatUnifiedHit(r, i + 1))
          .join("\n\n");

        const sanitized = visible.map((r) => {
          if (r.kind === "media") {
            return {
              kind: "media" as const,
              filePath: r.entry.filePath,
              fileName: r.entry.fileName,
              type: r.entry.fileType,
              description: r.entry.description,
              matchScore: Number.parseFloat((r.score * 100).toFixed(1)),
              fileCreatedAt: new Date(r.entry.fileCreatedAt).toISOString(),
              fileModifiedAt: new Date(r.entry.fileModifiedAt).toISOString(),
            };
          }
          const doc = r.doc;
          return {
            kind: "document" as const,
            filePath: doc.filePath,
            fileName: doc.fileName,
            type: "document" as const,
            fileExt: doc.fileExt,
            snippet: doc.snippet,
            topPageNumber: doc.topPageNumber || undefined,
            topHeading: doc.topHeading || undefined,
            totalChunks: doc.totalChunks,
            matchScore: Number.parseFloat((r.score * 100).toFixed(1)),
            fileCreatedAt: new Date(doc.fileCreatedAt).toISOString(),
            fileModifiedAt: new Date(doc.fileModifiedAt).toISOString(),
          };
        });

        const maxScore = visible[0].score * 100;
        const confidence = maxScore > 60 ? "高" : maxScore > 40 ? "中" : "低";

        return {
          content: makeTextContent(
            `✅ 找到 ${visible.length} 条相关结果（置信度: ${confidence}）：\n\n${text}\n\n⚠️ 若是 image/audio，请立即使用当前渠道把文件发送给用户；若是 document，请在回复里附上路径与 snippet。`,
          ),
          details: {
            count: visible.length,
            query: normalizedQuery,
            maxMatchScore: Number.parseFloat(maxScore.toFixed(1)),
            confidence,
            cleanedMissing,
            cleanedMissingMedia,
            cleanedMissingDocs,
            results: sanitized,
          },
        };
      } catch (error) {
        console.error(
          `[multimodal-rag] Search error for query "${normalizedQuery}":`,
          error,
        );
        const totalCount = await storage.count().catch(() => 0);
        return {
          content: makeTextContent(
            `搜索时遇到技术问题，请稍后重试。\n\n数据库中共有 ${totalCount} 个已索引媒体文件。\n错误详情: ${error instanceof Error ? error.message : String(error)}`,
          ),
          details: {
            count: 0,
            query: normalizedQuery,
            error: error instanceof Error ? error.message : String(error),
            totalInDatabase: totalCount,
          },
        };
      }
    },
  };
}

function formatDocSummary(doc: DocSummary, rank: number): string {
  const date = new Date(doc.fileCreatedAt).toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
  const locationHints: string[] = [];
  if (doc.topPageNumber > 0) locationHints.push(`p.${doc.topPageNumber}`);
  if (doc.topHeading) locationHints.push(doc.topHeading);
  const locationSuffix =
    locationHints.length > 0 ? `  （${locationHints.join(" · ")}）` : "";
  return `${rank}. [document${doc.fileExt ? doc.fileExt : ""}] ${doc.fileName}\n   📁 ${doc.filePath}\n   📅 ${date}\n   🧩 段数: ${doc.totalChunks}${locationSuffix}\n   📝 ${doc.snippet}`;
}

function formatUnifiedHit(result: UnifiedSearchResult, rank: number): string {
  const scorePercent = (result.score * 100).toFixed(0);
  if (result.kind === "media") {
    const entry = result.entry;
    const date = new Date(entry.fileCreatedAt).toLocaleString("zh-CN", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
    return `${rank}. [${entry.fileType}] ${entry.fileName} (匹配度: ${scorePercent}%)\n   📁 路径: ${entry.filePath}\n   📅 时间: ${date}\n   📝 描述: ${entry.description}`;
  }
  const doc = result.doc;
  const date = new Date(doc.fileCreatedAt).toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
  const locationHints: string[] = [];
  if (doc.topPageNumber > 0) locationHints.push(`p.${doc.topPageNumber}`);
  if (doc.topHeading) locationHints.push(doc.topHeading);
  const locationSuffix =
    locationHints.length > 0 ? `  （${locationHints.join(" · ")}）` : "";
  return `${rank}. [document${doc.fileExt ? doc.fileExt : ""}] ${doc.fileName} (匹配度: ${scorePercent}%)\n   📁 路径: ${doc.filePath}\n   📅 时间: ${date}\n   🧩 段数: ${doc.totalChunks}${locationSuffix}\n   📝 摘录: ${doc.snippet}`;
}

/**
 * 创建 media_describe 工具
 */
export function createMediaDescribeTool(
  storage: MediaStorage,
  _processor: IMediaProcessor,
  _embeddings: IEmbeddingProvider,
  watcher: MediaWatcher,
) {
  return {
    name: "media_describe",
    label: "Media Describe",
    description:
      "获取指定媒体文件的详细描述。如果文件未索引，会自动分析并索引。可用于强制刷新描述。\n\n**用途**：\n- 当 media_list 或 media_search 返回的结果描述不够详细，无法回答用户具体问题（如“数数有几个人”）时，调用此工具获取完整分析结果。",
    parameters: Type.Object({
      filePath: Type.String({
        description: "媒体文件路径",
      }),
      refresh: Type.Optional(
        Type.Boolean({
          description: "强制重新分析（即使已索引）",
          default: false,
        }),
      ),
    }),
    async execute(_toolCallId: string, params: any) {
      const { filePath, refresh = false } = params;
      const normalizedPath = typeof filePath === "string" ? filePath.trim() : "";
      if (!normalizedPath) {
        return {
          content: makeTextContent("filePath 不能为空"),
          details: { error: "invalid_file_path" },
        };
      }

      let entry = await storage.findByPath(normalizedPath);
      let docChunks = entry ? [] : await storage.findDocChunksByPath(normalizedPath);

      if ((!entry && docChunks.length === 0) || refresh) {
        try {
          await watcher.indexPath(normalizedPath);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return {
            content: makeTextContent(`无法索引文件: ${message}`),
            details: { error: "indexing_failed", message },
          };
        }
        entry = await storage.findByPath(normalizedPath);
        docChunks = entry
          ? []
          : await storage.findDocChunksByPath(normalizedPath);

        if (!entry && docChunks.length === 0) {
          return {
            content: makeTextContent(
              `无法索引文件: ${normalizedPath}。请检查文件是否存在且为支持的格式。`,
            ),
            details: { error: "indexing_failed" },
          };
        }
      }

      if (entry) {
        const date = new Date(entry.fileCreatedAt).toLocaleString("zh-CN");
        const indexedDate = new Date(entry.indexedAt).toLocaleString("zh-CN");
        return {
          content: makeTextContent(
            `文件: ${entry.fileName}\n类型: ${entry.fileType}\n路径: ${entry.filePath}\n创建时间: ${date}\n索引时间: ${indexedDate}\n\n描述:\n${entry.description}`,
          ),
          details: {
            filePath: entry.filePath,
            fileName: entry.fileName,
            type: entry.fileType,
            description: entry.description,
            fileCreatedAt: new Date(entry.fileCreatedAt).toISOString(),
            indexedAt: new Date(entry.indexedAt).toISOString(),
          },
        };
      }

      // document 分支
      const sorted = docChunks.slice().sort((a, b) => a.chunkIndex - b.chunkIndex);
      const sample = sorted[0];
      const date = new Date(sample.fileCreatedAt).toLocaleString("zh-CN");
      const indexedDate = new Date(sample.indexedAt).toLocaleString("zh-CN");
      const totalChars = sorted.reduce((n, c) => n + c.chunkText.length, 0);

      // 预览前 3 段，每段最多 300 字
      const preview = sorted
        .slice(0, 3)
        .map((c, i) => {
          const loc: string[] = [];
          if (c.pageNumber > 0) loc.push(`p.${c.pageNumber}`);
          if (c.heading) loc.push(c.heading);
          const locSuffix = loc.length > 0 ? ` (${loc.join(" · ")})` : "";
          const snippet =
            c.chunkText.length > 300 ? c.chunkText.slice(0, 300) + "…" : c.chunkText;
          return `【第 ${c.chunkIndex + 1}/${sample.totalChunks} 段${locSuffix}】\n${snippet}`;
        })
        .join("\n\n");
      const tailHint =
        sample.totalChunks > 3
          ? `\n\n…共 ${sample.totalChunks} 段，此处仅预览前 3 段。若要精确定位，用 media_search type='document' 做语义搜索。`
          : "";

      return {
        content: makeTextContent(
          `文件: ${sample.fileName}\n类型: document (${sample.fileExt})\n路径: ${sample.filePath}\n创建时间: ${date}\n索引时间: ${indexedDate}\n段数: ${sample.totalChunks}  字符数: ${totalChars}\n\n预览:\n${preview}${tailHint}`,
        ),
        details: {
          filePath: sample.filePath,
          fileName: sample.fileName,
          type: "document" as const,
          fileExt: sample.fileExt,
          totalChunks: sample.totalChunks,
          totalChars,
          fileCreatedAt: new Date(sample.fileCreatedAt).toISOString(),
          indexedAt: new Date(sample.indexedAt).toISOString(),
        },
      };
    },
  };
}

/**
 * 创建 media_stats 工具
 */
export function createMediaStatsTool(storage: MediaStorage, watcher?: MediaWatcher) {
  return {
    name: "media_stats",
    label: "Media Statistics",
    description:
      "获取用户个人知识库的统计信息（照片/录音/文档数量）。当用户询问'有多少照片'、'有哪些文件'、'录了多少音'、'有多少份 PDF'或想了解数据概况时使用。",
    parameters: Type.Object({}),
    async execute(_toolCallId: string, _params: any) {
      const [imageCount, audioCount, docCount, docChunksCount] = await Promise.all([
        storage.count("image"),
        storage.count("audio"),
        storage.countDocs(),
        storage.countDocChunks(),
      ]);
      const mediaTotal = imageCount + audioCount;
      const total = mediaTotal + docCount;
      const queue = watcher?.getQueueStatus();

      if (total === 0) {
        return {
          content: makeTextContent(
            "知识库为空。\n\n" +
              (queue
                ? `当前索引队列：处理中: ${queue.processing ?? "无"}，等待: ${queue.pending.length} 个\n\n`
                : "") +
              "新文件会在添加到监听目录后自动索引。",
          ),
          details: {
            total: 0,
            imageCount: 0,
            audioCount: 0,
            docCount: 0,
            docChunksCount: 0,
          },
        };
      }

      return {
        content: makeTextContent(
          `📊 知识库统计:\n\n总计: ${total} 份\n图片: ${imageCount} 个\n音频: ${audioCount} 个\n文档: ${docCount} 份 (${docChunksCount} 个切片)\n` +
            (queue
              ? `\n索引队列:\n- 处理中: ${queue.processing ?? "无"}\n- 等待: ${queue.pending.length} 个`
              : "") +
            "\n\n💡 使用 media_search 搜索内容，或 media_list 浏览文件列表。",
        ),
        details: {
          total,
          imageCount,
          audioCount,
          docCount,
          docChunksCount,
          queue,
        },
      };
    },
  };
}

/**
 * 创建 media_list 工具
 */
export function createMediaListTool(
  storage: MediaStorage,
  config: Pick<PluginConfig, "watchPaths" | "fileTypes">,
) {
  return {
    name: "media_list",
    label: "Media List",
    description:
      "按时间倒序列出媒体/文档文件。\n\n" +
      "数据来源：\n" +
      "- 已索引文件：来自本插件的向量数据库（image/audio 含 description，document 含最高分 chunk 的 snippet）\n" +
      "- 未索引文件：当 includeUnindexed=true 时，会额外扫描监听目录返回磁盘上存在但尚未完成索引的 image/audio（document 不走未索引兜底）\n\n" +
      "查询类型：\n" +
      "- type='image' / 'audio' / 'all'：走 media 表\n" +
      "- type='document'：走 doc_chunks 表（按 filePath 聚合，每文件一条）",
    parameters: Type.Object({
      type: Type.Optional(
        Type.Union([
          Type.Literal("image"),
          Type.Literal("audio"),
          Type.Literal("document"),
          Type.Literal("all"),
        ]),
      ),
      after: Type.Optional(
        Type.String({
          description: "开始时间，ISO 格式",
        }),
      ),
      before: Type.Optional(
        Type.String({
          description: "结束时间，ISO 格式",
        }),
      ),
      limit: Type.Optional(
        Type.Number({
          description: "返回数量，默认 20",
          default: 20,
        }),
      ),
      offset: Type.Optional(
        Type.Number({
          description: "偏移量（用于分页）",
          default: 0,
        }),
      ),
      includeUnindexed: Type.Optional(
        Type.Boolean({
          description:
            "是否包含磁盘上存在但尚未完成索引的文件（indexed=false）。默认 true。",
          default: true,
        }),
      ),
    }),
    async execute(_toolCallId: string, params: any) {
      const {
        type = "all",
        after,
        before,
        limit = 20,
        offset = 0,
        includeUnindexed = true,
      } = params;

      // 解析时间参数
      const parsedAfter = parseIsoDate(after, "after");
      if (parsedAfter.error) {
        return {
          content: makeTextContent(parsedAfter.error),
          details: { total: 0, error: "invalid_after", files: [] },
        };
      }
      const parsedBefore = parseIsoDate(before, "before");
      if (parsedBefore.error) {
        return {
          content: makeTextContent(parsedBefore.error),
          details: { total: 0, error: "invalid_before", files: [] },
        };
      }
      if (
        parsedAfter.value !== undefined &&
        parsedBefore.value !== undefined &&
        parsedAfter.value > parsedBefore.value
      ) {
        return {
          content: makeTextContent("after 不能晚于 before。"),
          details: { total: 0, error: "invalid_date_range", files: [] },
        };
      }
      const parsedLimit = parsePositiveInt(limit, "limit", { min: 1, defaultValue: 20 });
      if (parsedLimit.error) {
        return {
          content: makeTextContent(parsedLimit.error),
          details: { total: 0, error: "invalid_limit", files: [] },
        };
      }
      const parsedOffset = parsePositiveInt(offset, "offset", { min: 0, defaultValue: 0 });
      if (parsedOffset.error) {
        return {
          content: makeTextContent(parsedOffset.error),
          details: { total: 0, error: "invalid_offset", files: [] },
        };
      }

      const afterTs = parsedAfter.value;
      const beforeTs = parsedBefore.value;

      // type='document' 独立走 doc_chunks 表（按 filePath 聚合）
      if (type === "document") {
        const { total, docs } = await storage.listDocSummaries({
          after: afterTs,
          before: beforeTs,
          limit: parsedLimit.value,
          offset: parsedOffset.value,
        });

        // 过滤已删除的原文件
        const existingDocs: typeof docs = [];
        const missingDocPaths: string[] = [];
        for (const d of docs) {
          try {
            await stat(d.filePath);
            existingDocs.push(d);
          } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (code === "ENOENT" || code === "ENOTDIR") {
              missingDocPaths.push(d.filePath);
            } else {
              existingDocs.push(d);
            }
          }
        }
        let cleanedMissing = 0;
        if (missingDocPaths.length > 0) {
          const cleanup = await storage.cleanupMissingDocChunks({
            candidates: missingDocPaths,
            dryRun: false,
          });
          cleanedMissing = cleanup.removedChunks;
        }

        if (existingDocs.length === 0) {
          const totalDocs = await storage.countDocs();
          const cleanupHint =
            cleanedMissing > 0
              ? `\n\n已自动清理 ${cleanedMissing} 条失效文档索引。`
              : "";
          return {
            content: makeTextContent(
              `没有找到符合条件的文档。\n\n知识库中共有 ${totalDocs} 份文档。${cleanupHint}`,
            ),
            details: {
              total: 0,
              totalInDatabase: totalDocs,
              cleanedMissing,
              files: [],
            },
          };
        }

        const text = existingDocs
          .map((d, i) => formatDocSummary(d, parsedOffset.value + i + 1))
          .join("\n\n");
        const sanitized = existingDocs.map((d) => ({
          filePath: d.filePath,
          path: d.filePath,
          fileName: d.fileName,
          type: "document" as const,
          fileExt: d.fileExt,
          indexed: true as const,
          snippet: d.snippet,
          totalChunks: d.totalChunks,
          fileCreatedAt: new Date(d.fileCreatedAt).toISOString(),
          fileModifiedAt: new Date(d.fileModifiedAt).toISOString(),
          indexedAt: d.indexedAt ? new Date(d.indexedAt).toISOString() : "",
        }));
        const pageInfo =
          total > parsedOffset.value + parsedLimit.value
            ? `\n\n（显示 ${parsedOffset.value + 1}-${parsedOffset.value + existingDocs.length}，共 ${total} 份。使用 offset 参数查看更多）`
            : `\n\n（共 ${total} 份文档）`;
        return {
          content: makeTextContent(
            `📋 文档列表：\n\n${text}${pageInfo}\n\n💡 用 media_search type='document' 做语义搜索定位到具体段落。`,
          ),
          details: {
            total,
            showing: existingDocs.length,
            indexedTotal: total,
            unindexedCount: 0,
            cleanedMissing,
            files: sanitized,
          },
        };
      }

      // 数据库查询（已索引）
      const { entries: indexedEntries } = await storage.list({
        type: type as MediaType | "all",
        after: afterTs,
        before: beforeTs,
        // 先多取一些，后续可能与未索引文件合并再分页
        limit: Math.max(parsedLimit.value + parsedOffset.value, 100),
        offset: 0,
      });

      const { existingIds, missingCandidates } = await splitExistingAndMissingCandidates(
        indexedEntries.map((e) => ({ id: e.id, filePath: e.filePath })),
      );
      let cleanedMissing = 0;
      if (missingCandidates.length > 0) {
        const cleanupResult = await storage.cleanupMissingEntries({
          candidates: missingCandidates,
          dryRun: false,
        });
        cleanedMissing = cleanupResult.removed;
      }
      const validIndexedEntries = indexedEntries.filter((e) => existingIds.has(e.id));
      const indexedPaths = new Set(validIndexedEntries.map((e) => e.filePath));

      // 磁盘兜底（未索引）
      const unindexedFiles: UnindexedFile[] = [];
      if (includeUnindexed) {
        const imageExts = config.fileTypes.image.map((e) => e.toLowerCase());
        const audioExts = config.fileTypes.audio.map((e) => e.toLowerCase());
        const expandedPaths = config.watchPaths.map(expandPath);

        // 扫描每个 watchPath，取一定数量的“最新文件”用于兜底
        const perDirMax = Math.max(parsedLimit.value + parsedOffset.value, 20);
        for (const p of expandedPaths) {
          const scanned = await scanDirectoryForMediaFiles({
            dirPath: p,
            imageExts,
            audioExts,
            type: type as MediaType | "all",
            maxFiles: perDirMax,
          });
          for (const f of scanned) {
            if (indexedPaths.has(f.filePath)) {
              continue;
            }
            // 时间过滤：与索引条目保持一致，统一以 mtime 为准
            if (afterTs && f.fileCreatedAt < afterTs) {
              continue;
            }
            if (beforeTs && f.fileCreatedAt > beforeTs) {
              continue;
            }
            unindexedFiles.push(f);
          }
        }
      }

      // 合并结果：统一按 fileCreatedAt 倒序，然后再分页
      const combined = [
        ...validIndexedEntries.map((e) => ({
          indexed: true as const,
          filePath: e.filePath,
          fileName: e.fileName,
          fileType: e.fileType as MediaType,
          description: e.description,
          fileCreatedAt: e.fileCreatedAt,
          indexedAt: e.indexedAt,
        })),
        ...unindexedFiles.map((f) => ({
          indexed: false as const,
          filePath: f.filePath,
          fileName: f.fileName,
          fileType: f.fileType,
          description: "",
          fileCreatedAt: f.fileCreatedAt,
          indexedAt: 0,
        })),
      ].sort((a, b) => b.fileCreatedAt - a.fileCreatedAt);

      const total = combined.length;
      const paged = combined.slice(parsedOffset.value, parsedOffset.value + parsedLimit.value);

      if (paged.length === 0) {
        const totalCount = await storage.count();
        const cleanupHint =
          cleanedMissing > 0 ? `\n\n已自动清理 ${cleanedMissing} 条失效索引。` : "";
        return {
          content: makeTextContent(
            `没有找到符合条件的媒体文件。\n\n数据库中共有 ${totalCount} 个文件。建议调整过滤条件或使用 media_stats 查看总体情况。${cleanupHint}`,
          ),
          details: { total: 0, totalInDatabase: totalCount, cleanedMissing, files: [] },
        };
      }

      // 格式化结果（包含完整描述）
      const text = paged
        .map((e, i) => {
          const date = new Date(e.fileCreatedAt).toLocaleString("zh-CN", {
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
          });
          const indexedFlag = e.indexed ? "" : " ⏳(未索引)";
          const previewLine = e.indexed
            ? `   📝 ${e.description}`
            : "   📝 （未索引，description 为空，可用 media_describe 触发分析）";
          return `${parsedOffset.value + i + 1}. [${e.fileType}] ${e.fileName}${indexedFlag}\n   📅 ${date}\n   📁 ${e.filePath}\n${previewLine}`;
        })
        .join("\n\n");

      // 清理结果
      const sanitizedFiles = paged.map((e) => ({
        filePath: e.filePath,
        path: e.filePath,
        fileName: e.fileName,
        type: e.fileType,
        indexed: e.indexed,
        description: e.description || "",
        fileCreatedAt: new Date(e.fileCreatedAt).toISOString(),
        indexedAt: e.indexedAt ? new Date(e.indexedAt).toISOString() : "",
      }));

      const pageInfo =
        total > parsedOffset.value + parsedLimit.value
          ? `\n\n（显示 ${parsedOffset.value + 1}-${parsedOffset.value + paged.length}，共 ${total} 个。使用 offset 参数查看更多）`
          : `\n\n（共 ${total} 个文件）`;

      return {
        content: makeTextContent(
          `📋 媒体文件列表：\n\n${text}${pageInfo}\n\n💡 indexed=false 的文件说明还没索引完；需要分析时可用 media_describe 触发索引并获取详细描述。`,
        ),
        details: {
          total,
          showing: paged.length,
          indexedTotal: validIndexedEntries.length,
          unindexedCount: unindexedFiles.length,
          cleanedMissing,
          files: sanitizedFiles,
        },
      };
    },
  };
}
