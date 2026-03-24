import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-runtime";
import { stat } from "node:fs/promises";
import { buildMultimodalRagDoctorReport } from "./doctor.js";
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
      .description("搜索媒体文件")
      .argument("<query>", "搜索查询")
      .option("--type <type>", "媒体类型: image, audio, all", "all")
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

          const results = await storage.search(vector, {
            type: opts.type,
            after: afterTs,
            before: beforeTs,
            limit,
            minScore: 0.3,
          });

          const { existingIds, missingCandidates } = await splitCliExistingAndMissingCandidates(
            results.map((r) => ({ id: r.entry.id, filePath: r.entry.filePath })),
          );
          let cleanedMissing = 0;
          if (missingCandidates.length > 0) {
            const cleanupResult = await storage.cleanupMissingEntries({
              candidates: missingCandidates,
              dryRun: false,
            });
            cleanedMissing = cleanupResult.removed;
          }
          const visibleResults = results.filter((r) => existingIds.has(r.entry.id));

          if (visibleResults.length === 0) {
            if (cleanedMissing > 0) {
              console.log(`未找到相关媒体文件（已自动清理 ${cleanedMissing} 条失效索引）`);
            } else {
              console.log("未找到相关媒体文件");
            }
            return;
          }

          console.log(`找到 ${visibleResults.length} 个相关媒体文件:\n`);
          for (const r of visibleResults) {
            const date = new Date(r.entry.fileCreatedAt).toLocaleString("zh-CN");
            const score = (r.score * 100).toFixed(0);
            console.log(`[${r.entry.fileType}] ${r.entry.fileName} (${score}%)`);
            console.log(`  路径: ${r.entry.filePath}`);
            console.log(`  时间: ${date}`);
            console.log(`  描述: ${r.entry.description.slice(0, 100)}...\n`);
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
          const total = await storage.count();
          const imageCount = await storage.count("image");
          const audioCount = await storage.count("audio");

          console.log("媒体库统计:");
          console.log(`  总计: ${total} 个文件`);
          console.log(`  图片: ${imageCount} 个`);
          console.log(`  音频: ${audioCount} 个`);
          if (total !== imageCount + audioCount) {
            console.log(`  警告: 总数不匹配 (${total} ≠ ${imageCount} + ${audioCount})`);
          }
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
      .description("列出已索引的媒体文件")
      .option("--type <type>", "媒体类型: image, audio, all", "all")
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

    // openclaw multimodal-rag cleanup-failed-audio
    rag
      .command("cleanup-failed-audio")
      .description("清理历史转录失败导致的脏音频索引")
      .option("--confirm", "确认清理")
      .action(async (opts: any) => {
        if (!opts.confirm) {
          console.error("请使用 --confirm 确认清理操作");
          process.exit(1);
        }

        try {
          const result = await storage.cleanupFailedAudioEntries();
          console.log(
            `✓ 清理完成：删除 ${result.removed} 条脏音频记录（候选 ${result.candidates} 条）`,
          );
        } catch (error) {
          console.error(`清理失败: ${String(error)}`);
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
