import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-runtime";
import { stat } from "node:fs/promises";
import { buildMultimodalRagDoctorReport } from "./doctor.js";
import { startHttpServer } from "./http-server.js";
import type { MultimodalRagRuntime } from "./runtime.js";

function isMissingPathError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

export async function splitCliExistingAndMissingCandidates(
  candidates: Array<{ id: string; filePath: string }>,
): Promise<{ existingIds: Set<string>; missingCandidates: Array<{ id: string; filePath: string }> }> {
  const checks = await Promise.all(
    candidates.map(async (candidate) => {
      try {
        await stat(candidate.filePath);
        return { ...candidate, missing: false };
      } catch (error) {
        return { ...candidate, missing: isMissingPathError(error) };
      }
    }),
  );

  const existingIds = new Set<string>();
  const missingCandidates: Array<{ id: string; filePath: string }> = [];
  for (const item of checks) {
    if (item.missing) {
      missingCandidates.push({ id: item.id, filePath: item.filePath });
      continue;
    }
    existingIds.add(item.id);
  }

  return { existingIds, missingCandidates };
}

export function parseCliDate(value: unknown, label: string): number | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error(`${label} 必须是 ISO 日期字符串`);
  }
  const ts = new Date(value).getTime();
  if (!Number.isFinite(ts)) {
    throw new Error(`${label} 不是合法日期，示例：2026-02-05T23:59:59`);
  }
  return ts;
}

export function parseCliInteger(
  value: unknown,
  label: string,
  options: { min: number; defaultValue?: number },
): number {
  if (value === undefined || value === null || value === "") {
    if (options.defaultValue === undefined) {
      throw new Error(`${label} 缺失`);
    }
    return options.defaultValue;
  }
  const n = Number(value);
  if (!Number.isInteger(n) || n < options.min) {
    throw new Error(`${label} 必须是 >= ${options.min} 的整数`);
  }
  return n;
}

export function registerMultimodalRagCli(
  api: OpenClawPluginApi,
  runtime: MultimodalRagRuntime,
): void {
  const { embeddings, storage, watcher } = runtime;
  api.registerCli(({ program }) => {
    const rag = program
      .command("multimodal-rag")
      .description("Multimodal RAG plugin commands");

    // openclaw multimodal-rag index <path>
    rag
      .command("index")
      .description("手动索引指定路径的媒体文件")
      .argument("<path>", "文件或文件夹路径")
      .action(async (path: string) => {
        try {
          await watcher.indexPath(path);
          console.log(`✓ 索引完成: ${path}`);
        } catch (error) {
          console.error(`✗ 索引失败: ${String(error)}`);
          process.exit(1);
        }
      });

    // openclaw multimodal-rag search <query>
    rag
      .command("search")
      .description("搜索媒体/文档")
      .argument("<query>", "搜索查询")
      .option("--type <type>", "类型: image, audio, document, all", "all")
      .option("--after <date>", "开始时间 (ISO 格式)")
      .option("--before <date>", "结束时间 (ISO 格式)")
      .option("--limit <n>", "返回数量", "5")
      .action(async (query: string, opts: any) => {
        try {
          const normalizedQuery = typeof query === "string" ? query.trim() : "";
          if (!normalizedQuery) {
            throw new Error("query 不能为空");
          }
          const afterTs = parseCliDate(opts.after, "after");
          const beforeTs = parseCliDate(opts.before, "before");
          if (
            afterTs !== undefined &&
            beforeTs !== undefined &&
            afterTs > beforeTs
          ) {
            throw new Error("after 不能晚于 before");
          }
          const limit = parseCliInteger(opts.limit, "limit", {
            min: 1,
            defaultValue: 5,
          });

          const vector = await embeddings.embed(normalizedQuery);

          const unified = await storage.unifiedSearch(vector, {
            type: opts.type,
            after: afterTs,
            before: beforeTs,
            limit,
            minScore: 0.3,
          });

          // 媒体结果存在性检查 + 清理
          const mediaCandidates = unified
            .filter((r): r is Extract<typeof unified[number], { kind: "media" }> => r.kind === "media")
            .map((r) => ({ id: r.entry.id, filePath: r.entry.filePath }));
          const { existingIds, missingCandidates } =
            await splitCliExistingAndMissingCandidates(mediaCandidates);
          let cleanedMissing = 0;
          if (missingCandidates.length > 0) {
            const mediaCleanup = await storage.cleanupMissingEntries({
              candidates: missingCandidates,
              dryRun: false,
            });
            cleanedMissing += mediaCleanup.removed;
          }

          // 文档结果存在性检查 + 清理
          const docPaths = unified
            .filter((r): r is Extract<typeof unified[number], { kind: "document" }> => r.kind === "document")
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
          if (missingDocPaths.length > 0) {
            const docCleanup = await storage.cleanupMissingDocChunks({
              candidates: missingDocPaths,
              dryRun: false,
            });
            cleanedMissing += docCleanup.removedChunks;
          }

          const visible = unified.filter((r) => {
            if (r.kind === "media") return existingIds.has(r.entry.id);
            return existingDocPaths.has(r.doc.filePath);
          });

          if (visible.length === 0) {
            if (cleanedMissing > 0) {
              console.log(`未找到相关内容（已自动清理 ${cleanedMissing} 条失效索引）`);
            } else {
              console.log("未找到相关内容");
            }
            return;
          }

          console.log(`找到 ${visible.length} 条相关结果:\n`);
          for (const r of visible) {
            if (r.kind === "media") {
              const date = new Date(r.entry.fileCreatedAt).toLocaleString("zh-CN");
              const score = (r.score * 100).toFixed(0);
              console.log(`[${r.entry.fileType}] ${r.entry.fileName} (${score}%)`);
              console.log(`  路径: ${r.entry.filePath}`);
              console.log(`  时间: ${date}`);
              console.log(`  描述: ${r.entry.description.slice(0, 100)}...\n`);
            } else {
              const doc = r.doc;
              const date = new Date(doc.fileCreatedAt).toLocaleString("zh-CN");
              const score = (r.score * 100).toFixed(0);
              const loc: string[] = [];
              if (doc.topPageNumber > 0) loc.push(`p.${doc.topPageNumber}`);
              if (doc.topHeading) loc.push(doc.topHeading);
              const locSuffix = loc.length > 0 ? `  (${loc.join(" · ")})` : "";
              console.log(`[document${doc.fileExt}] ${doc.fileName} (${score}%)`);
              console.log(`  路径: ${doc.filePath}`);
              console.log(`  时间: ${date}`);
              console.log(`  段数: ${doc.totalChunks}${locSuffix}`);
              console.log(`  摘录: ${doc.snippet}\n`);
            }
          }
          if (cleanedMissing > 0) {
            console.log(`已自动清理 ${cleanedMissing} 条失效索引。`);
          }
        } catch (error) {
          console.error(`搜索失败: ${String(error)}`);
          process.exit(1);
        }
      });

    // openclaw multimodal-rag stats
    rag
      .command("stats")
      .description("显示索引统计")
      .action(async () => {
        try {
          const [imageCount, audioCount, docCount, docChunksCount] = await Promise.all([
            storage.count("image"),
            storage.count("audio"),
            storage.countDocs(),
            storage.countDocChunks(),
          ]);
          const mediaTotal = imageCount + audioCount;
          const total = mediaTotal + docCount;

          console.log("知识库统计:");
          console.log(`  总计: ${total} 份`);
          console.log(`  图片: ${imageCount} 个`);
          console.log(`  音频: ${audioCount} 个`);
          console.log(`  文档: ${docCount} 份 (${docChunksCount} 个切片)`);
        } catch (error) {
          console.error(`统计失败: ${String(error)}`);
          process.exit(1);
        }
      });

    // openclaw multimodal-rag doctor
    rag
      .command("doctor")
      .description("显示当前配置与依赖诊断信息")
      .action(async () => {
        try {
          const report = buildMultimodalRagDoctorReport(runtime);
          console.log(JSON.stringify(report, null, 2));
        } catch (error) {
          console.error(`诊断失败: ${String(error)}`);
          process.exit(1);
        }
      });

    // openclaw multimodal-rag list
    rag
      .command("list")
      .description("列出已索引的媒体/文档")
      .option("--type <type>", "类型: image, audio, document, all", "all")
      .option("--after <date>", "开始时间 (ISO 格式)")
      .option("--before <date>", "结束时间 (ISO 格式)")
      .option("--limit <n>", "返回数量", "20")
      .option("--offset <n>", "偏移量", "0")
      .action(async (opts: any) => {
        try {
          const afterTs = parseCliDate(opts.after, "after");
          const beforeTs = parseCliDate(opts.before, "before");
          if (
            afterTs !== undefined &&
            beforeTs !== undefined &&
            afterTs > beforeTs
          ) {
            throw new Error("after 不能晚于 before");
          }
          const limit = parseCliInteger(opts.limit, "limit", {
            min: 1,
            defaultValue: 20,
          });
          const offset = parseCliInteger(opts.offset, "offset", {
            min: 0,
            defaultValue: 0,
          });

          // type=document 独立走 doc_chunks 表
          if (opts.type === "document") {
            const { total, docs } = await storage.listDocSummaries({
              after: afterTs,
              before: beforeTs,
              limit,
              offset,
            });

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
              if (cleanedMissing > 0) {
                console.log(`没有找到符合条件的文档（已自动清理 ${cleanedMissing} 条失效索引）`);
              } else {
                console.log("没有找到符合条件的文档");
              }
              return;
            }

            console.log(`已索引 ${total} 份文档:\n`);
            for (let i = 0; i < existingDocs.length; i++) {
              const d = existingDocs[i];
              const date = new Date(d.fileCreatedAt).toLocaleString("zh-CN");
              const loc: string[] = [];
              if (d.topPageNumber > 0) loc.push(`p.${d.topPageNumber}`);
              if (d.topHeading) loc.push(d.topHeading);
              const locSuffix = loc.length > 0 ? `  (${loc.join(" · ")})` : "";
              console.log(`${offset + i + 1}. [document${d.fileExt}] ${d.fileName}`);
              console.log(`   路径: ${d.filePath}`);
              console.log(`   时间: ${date}`);
              console.log(`   段数: ${d.totalChunks}${locSuffix}`);
              console.log(`   摘录: ${d.snippet}\n`);
            }
            if (total > offset + existingDocs.length) {
              console.log(`（显示 ${offset + 1}-${offset + existingDocs.length}，共 ${total} 份）`);
            }
            if (cleanedMissing > 0) {
              console.log(`已自动清理 ${cleanedMissing} 条失效索引。`);
            }
            return;
          }

          const { total, entries } = await storage.list({
            type: opts.type,
            after: afterTs,
            before: beforeTs,
            limit,
            offset,
          });

          const { existingIds, missingCandidates } = await splitCliExistingAndMissingCandidates(
            entries.map((e) => ({ id: e.id, filePath: e.filePath })),
          );
          let cleanedMissing = 0;
          if (missingCandidates.length > 0) {
            const cleanupResult = await storage.cleanupMissingEntries({
              candidates: missingCandidates,
              dryRun: false,
            });
            cleanedMissing = cleanupResult.removed;
          }
          const visibleEntries = entries.filter((e) => existingIds.has(e.id));

          if (visibleEntries.length === 0) {
            if (cleanedMissing > 0) {
              console.log(`没有找到符合条件的媒体文件（已自动清理 ${cleanedMissing} 条失效索引）`);
            } else {
              console.log("没有找到符合条件的媒体文件");
            }
            return;
          }

          console.log(`已索引 ${total} 个媒体文件:\n`);
          for (let i = 0; i < visibleEntries.length; i++) {
            const e = visibleEntries[i];
            const date = new Date(e.fileCreatedAt).toLocaleString("zh-CN");
            console.log(`${offset + i + 1}. [${e.fileType}] ${e.fileName}`);
            console.log(`   路径: ${e.filePath}`);
            console.log(`   时间: ${date}`);
            console.log(
              `   描述: ${e.description.slice(0, 80)}${e.description.length > 80 ? "..." : ""}\n`,
            );
          }

          if (total > offset + visibleEntries.length) {
            console.log(`（显示 ${offset + 1}-${offset + visibleEntries.length}，共 ${total} 个）`);
          }
          if (cleanedMissing > 0) {
            console.log(`已自动清理 ${cleanedMissing} 条失效索引。`);
          }
        } catch (error) {
          console.error(`列表失败: ${String(error)}`);
          process.exit(1);
        }
      });

    // openclaw multimodal-rag cleanup-missing
    rag
      .command("cleanup-missing")
      .description("清理索引中“源文件已不存在”的失效记录")
      .option("--confirm", "确认执行删除（非 dry-run 模式必填）")
      .option("--dry-run", "仅扫描并显示候选，不实际删除")
      .option("--limit <n>", "最多扫描条数（默认全部）")
      .action(async (opts: any) => {
        const dryRun = !!opts.dryRun;
        if (!dryRun && !opts.confirm) {
          console.error("请使用 --confirm 确认清理操作，或使用 --dry-run 仅预览");
          process.exit(1);
        }

        let limit: number | undefined;
        if (opts.limit !== undefined) {
          limit = parseCliInteger(opts.limit, "limit", { min: 1 });
        }

        try {
          const result = await storage.cleanupMissingEntries({
            dryRun,
            limit,
          });
          if (dryRun) {
            console.log(
              `✓ 预览完成：扫描 ${result.scanned} 条，命中缺失 ${result.missing} 条（未执行删除）`,
            );
          } else {
            console.log(
              `✓ 清理完成：扫描 ${result.scanned} 条，命中缺失 ${result.missing} 条，已删除 ${result.removed} 条`,
            );
          }
        } catch (error) {
          console.error(`清理失败: ${String(error)}`);
          process.exit(1);
        }
      });

    const registerCleanupFailedMediaCommand = (
      commandName: string,
      description: string,
    ): void => {
      rag
        .command(commandName)
        .description(description)
        .option("--confirm", "确认清理")
        .action(async (opts: any) => {
          if (!opts.confirm) {
            console.error("请使用 --confirm 确认清理操作");
            process.exit(1);
          }

          try {
            const result = await storage.cleanupFailedMediaEntries();
            const clearedMarkers = await watcher.clearBrokenFileMarkers();
            console.log(
              `✓ 清理完成：删除 ${result.removed} 条失败媒体记录（候选 ${result.candidates} 条），清除 ${clearedMarkers.removed} 个 broken-file 标记`,
            );
          } catch (error) {
            console.error(`清理失败: ${String(error)}`);
            process.exit(1);
          }
        });
    };

    // openclaw multimodal-rag cleanup-failed-media
    registerCleanupFailedMediaCommand(
      "cleanup-failed-media",
      "清理历史失败导致的脏媒体索引（音频/图片）",
    );

    // openclaw multimodal-rag cleanup-failed-audio
    registerCleanupFailedMediaCommand(
      "cleanup-failed-audio",
      "兼容旧命令：清理历史失败导致的脏媒体索引（音频/图片）",
    );

    // openclaw multimodal-rag serve
    rag
      .command("serve")
      .description("启动本地 HTTP 接口：POST /get_file_info、GET /search_file")
      .option("--host <host>", "绑定地址，默认 127.0.0.1", "127.0.0.1")
      .option("--port <port>", "监听端口，默认 7749", "7749")
      .option("--search-limit <n>", "/search_file 返回条数上限", "20")
      .option("--search-min-score <n>", "/search_file 最低匹配分数 0-1", "0.25")
      .option(
        "--enable-index-on-demand",
        "当 /get_file_info 遇到未索引文件时，允许同步调用 watcher.indexPath（会拖慢响应）",
        false,
      )
      .action(async (opts: any) => {
        const port = parseCliInteger(opts.port, "port", { min: 1, defaultValue: 7749 });
        const host = typeof opts.host === "string" && opts.host.trim() ? opts.host.trim() : "127.0.0.1";
        const searchLimit = parseCliInteger(opts.searchLimit, "search-limit", {
          min: 1,
          defaultValue: 20,
        });
        const rawMinScore = Number(opts.searchMinScore ?? 0.25);
        if (!Number.isFinite(rawMinScore) || rawMinScore < 0 || rawMinScore > 1) {
          console.error("search-min-score 必须是 0-1 之间的数字");
          process.exit(1);
        }

        try {
          const server = await startHttpServer({
            host,
            port,
            storage,
            embeddings,
            watcher: opts.enableIndexOnDemand ? watcher : undefined,
            searchLimit,
            searchMinScore: rawMinScore,
          });
          console.log(`✓ multimodal-rag HTTP 服务已启动: http://${host}:${port}`);
          console.log("  POST /get_file_info  入参: JSON 路径数组");
          console.log("  GET  /search_file?q=<keyword>");
          if (opts.enableIndexOnDemand) {
            console.log("  (已启用 --enable-index-on-demand：未索引文件会同步触发索引)");
          }

          const shutdown = () => {
            console.log("\n正在关闭 HTTP 服务…");
            server.close(() => process.exit(0));
            setTimeout(() => process.exit(0), 3000).unref();
          };
          process.once("SIGINT", shutdown);
          process.once("SIGTERM", shutdown);
        } catch (error) {
          console.error(`HTTP 服务启动失败: ${String(error)}`);
          process.exit(1);
        }
      });

    // openclaw multimodal-rag reindex
    rag
      .command("reindex")
      .description("完整重新索引（清空数据库并重新扫描所有文件）")
      .option("--confirm", "确认重新索引")
      .action(async (opts: any) => {
        if (!opts.confirm) {
          console.error("请使用 --confirm 确认重新索引操作");
          console.error("警告: 此操作会清空现有索引并重新扫描所有文件");
          process.exit(1);
        }

        try {
          console.log("开始完整重新索引...");
          await watcher.reindexAll();
          console.log("✓ 重新索引完成");
          console.log("提示: 使用 'openclaw multimodal-rag stats' 查看进度");
        } catch (error) {
          console.error(`重新索引失败: ${String(error)}`);
          process.exit(1);
        }
      });
  }, { commands: ["multimodal-rag"] });
}
