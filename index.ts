/**
 * OpenClaw Multimodal RAG Plugin
 *
 * 多模态 RAG 插件，支持图像和音频的语义索引与时间感知搜索。
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { stat } from "node:fs/promises";
import { MediaStorage } from "./src/storage.js";
import { createEmbeddingProvider } from "./src/embeddings.js";
import { createMediaProcessor } from "./src/processor.js";
import { MediaWatcher } from "./src/watcher.js";
import { IndexNotifier } from "./src/notifier.js";
import {
  createMediaSearchTool,
  createMediaDescribeTool,
  createMediaListTool,
  createMediaStatsTool,
} from "./src/tools.js";
import { runSetup, runNonInteractiveSetup } from "./src/setup.js";
import type { PluginConfig } from "./src/types.js";

function isMissingPathError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

async function splitCliExistingAndMissingCandidates(
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

const multimodalRagPlugin = {
  id: "multimodal-rag",
  name: "Multimodal RAG",
  description:
    "多模态 RAG 插件，支持图像和音频的语义索引与时间感知搜索",
  kind: "rag" as const,

  register(api: OpenClawPluginApi) {
    // 解析配置（合并默认值）
    const userConfig = (api.pluginConfig || {}) as Partial<PluginConfig>;
    
    const cfg: PluginConfig = {
      watchPaths: userConfig.watchPaths || [],
      fileTypes: {
        image: userConfig.fileTypes?.image || [".jpg", ".jpeg", ".png", ".webp", ".gif", ".heic"],
        audio: userConfig.fileTypes?.audio || [".wav", ".mp3", ".m4a", ".ogg", ".flac", ".aac"],
      },
      ollama: {
        baseUrl: userConfig.ollama?.baseUrl || "http://127.0.0.1:11434",
        visionModel: userConfig.ollama?.visionModel || "qwen3-vl:2b",
        embedModel: userConfig.ollama?.embedModel || "qwen3-embedding:latest",
      },
      embedding: {
        provider: userConfig.embedding?.provider || "ollama",
        openaiApiKey: userConfig.embedding?.openaiApiKey,
        openaiModel: userConfig.embedding?.openaiModel || "text-embedding-3-small",
      },
      dbPath: userConfig.dbPath || "~/.openclaw/multimodal-rag.lance",
      watchDebounceMs: userConfig.watchDebounceMs || 1000,
      indexExistingOnStart: userConfig.indexExistingOnStart !== false,
      notifications: {
        enabled: userConfig.notifications?.enabled ?? false,
        agentId: userConfig.notifications?.agentId,
        quietWindowMs: userConfig.notifications?.quietWindowMs ?? 30000,
        batchTimeoutMs: userConfig.notifications?.batchTimeoutMs ?? 600000,
        channel: userConfig.notifications?.channel || "last",
        to: userConfig.notifications?.to,
        targets: userConfig.notifications?.targets || [],
      },
    };

    // 解析数据库路径
    const resolvedDbPath = api.resolvePath(cfg.dbPath);

    // 创建嵌入提供者
    const embeddings = createEmbeddingProvider({
      provider: cfg.embedding.provider,
      ollamaBaseUrl: cfg.ollama.baseUrl,
      ollamaModel: cfg.ollama.embedModel,
      openaiApiKey: cfg.embedding.openaiApiKey,
      openaiModel: cfg.embedding.openaiModel,
    });

    const vectorDim = embeddings.getDimension();
    api.logger.info?.(
      `multimodal-rag: Using ${cfg.embedding.provider} embeddings (dim=${vectorDim})`,
    );

    // 创建存储
    const storage = new MediaStorage(resolvedDbPath, vectorDim);

    // 创建媒体处理器
    const processor = createMediaProcessor({
      ollamaBaseUrl: cfg.ollama.baseUrl,
      visionModel: cfg.ollama.visionModel,
    });

    // 创建通知器（如果启用）
    let notifier: IndexNotifier | undefined;
    if (cfg.notifications?.enabled) {
      notifier = new IndexNotifier(
        cfg.notifications,
        api.runtime,
        api.logger,
        api.config,
      );
      api.logger.info?.("multimodal-rag: Notifications enabled");
    }

    // 创建文件监听器
    const watcher = new MediaWatcher(cfg, storage, embeddings, processor, api.logger, notifier);

    // ========================================================================
    // 注册工具
    // ========================================================================

    // 1. 统计工具 - 让 Agent 了解媒体库状态
    api.registerTool(createMediaStatsTool(storage, watcher), {
      name: "media_stats",
    });

    // 2. 搜索工具 - 主要的内容查找工具
    api.registerTool(createMediaSearchTool(storage, embeddings), {
      name: "media_search",
    });

    // 3. 列表工具 - 浏览和按时间过滤
    api.registerTool(createMediaListTool(storage, cfg), {
      name: "media_list",
    });

    // 4. 描述工具 - 查看单个文件详情
    api.registerTool(createMediaDescribeTool(storage, processor, embeddings, watcher), {
      name: "media_describe",
    });

    api.logger.info?.("multimodal-rag: Registered 4 agent tools");

    // ========================================================================
    // 注册 CLI 命令
    // ========================================================================

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
            const vector = await embeddings.embed(query);
            const afterTs = opts.after ? new Date(opts.after).getTime() : undefined;
            const beforeTs = opts.before ? new Date(opts.before).getTime() : undefined;

            const results = await storage.search(vector, {
              type: opts.type,
              after: afterTs,
              before: beforeTs,
              limit: Number.parseInt(opts.limit),
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
            // 使用 count() 统一查询逻辑（全量扫描 + 内存过滤）
            const total = await storage.count();
            const imageCount = await storage.count("image");
            const audioCount = await storage.count("audio");

            console.log("媒体库统计:");
            console.log(`  总计: ${total} 个文件`);
            console.log(`  图片: ${imageCount} 个`);
            console.log(`  音频: ${audioCount} 个`);
            
            // 数据完整性检查
            if (total !== imageCount + audioCount) {
              console.log(`  警告: 总数不匹配 (${total} ≠ ${imageCount} + ${audioCount})`);
            }
          } catch (error) {
            console.error(`统计失败: ${String(error)}`);
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
            const afterTs = opts.after ? new Date(opts.after).getTime() : undefined;
            const beforeTs = opts.before ? new Date(opts.before).getTime() : undefined;

            const { total, entries } = await storage.list({
              type: opts.type,
              after: afterTs,
              before: beforeTs,
              limit: Number.parseInt(opts.limit),
              offset: Number.parseInt(opts.offset),
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
            const offset = Number.parseInt(opts.offset);
            for (let i = 0; i < visibleEntries.length; i++) {
              const e = visibleEntries[i];
              const date = new Date(e.fileCreatedAt).toLocaleString("zh-CN");
              console.log(`${offset + i + 1}. [${e.fileType}] ${e.fileName}`);
              console.log(`   路径: ${e.filePath}`);
              console.log(`   时间: ${date}`);
              console.log(`   描述: ${e.description.slice(0, 80)}${e.description.length > 80 ? "..." : ""}\n`);
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
            limit = Number.parseInt(String(opts.limit), 10);
            if (!Number.isFinite(limit) || limit <= 0) {
              console.error("--limit 必须是大于 0 的整数");
              process.exit(1);
            }
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

      // openclaw multimodal-rag clear
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

      // openclaw multimodal-rag clear
      rag
        .command("clear")
        .description("清空索引（谨慎使用）")
        .option("--confirm", "确认清空")
        .action(async (opts: any) => {
          if (!opts.confirm) {
            console.error("请使用 --confirm 确认清空操作");
            process.exit(1);
          }

          try {
            await storage.clear();
            console.log("✓ 索引已清空");
          } catch (error) {
            console.error(`清空失败: ${String(error)}`);
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

      // openclaw multimodal-rag setup
      // 支持交互式和非交互式两种模式：
      //   交互式: openclaw multimodal-rag setup
      //   非交互式: openclaw multimodal-rag setup -n --watch ~/photos --watch ~/audio
      rag
        .command("setup")
        .description("配置插件（支持交互式和非交互式模式）")
        .option("-n, --non-interactive", "非交互式模式（需配合 --watch 使用）")
        .option("-w, --watch <paths...>", "监听路径（可多次指定或逗号分隔）")
        .option("--ollama-url <url>", "Ollama 服务地址", "http://127.0.0.1:11434")
        .option("--vision-model <model>", "视觉模型名称", "qwen3-vl:2b")
        .option("--embed-model <model>", "嵌入模型名称", "qwen3-embedding:latest")
        .option("--embedding-provider <provider>", "嵌入提供者: ollama 或 openai", "ollama")
        .option("--openai-api-key <key>", "OpenAI API Key（仅 openai 时需要）")
        .option("--openai-model <model>", "OpenAI 嵌入模型")
        .option("--db-path <path>", "LanceDB 数据库路径")
        .option("--no-index-on-start", "启动时不索引已有文件")
        .option("--notify-enabled", "启用索引完成通知")
        .option("--notify-quiet-window <ms>", "通知静默窗口（毫秒）", "30000")
        .option("--notify-batch-timeout <ms>", "通知批次超时（毫秒）", "600000")
        .action(async (opts: {
          nonInteractive?: boolean;
          watch?: string[];
          ollamaUrl?: string;
          visionModel?: string;
          embedModel?: string;
          embeddingProvider?: string;
          openaiApiKey?: string;
          openaiModel?: string;
          dbPath?: string;
          noIndexOnStart?: boolean;
          notifyEnabled?: boolean;
          notifyQuietWindow?: string;
          notifyBatchTimeout?: string;
        }) => {
          if (opts.nonInteractive) {
            // 非交互式模式：展开逗号分隔的路径
            const watchPaths = (opts.watch || []).flatMap((p) => p.split(",").map((s) => s.trim()).filter(Boolean));
            await runNonInteractiveSetup({
              watch: watchPaths,
              ollamaUrl: opts.ollamaUrl,
              visionModel: opts.visionModel,
              embedModel: opts.embedModel,
              embeddingProvider: opts.embeddingProvider as "ollama" | "openai" | undefined,
              openaiApiKey: opts.openaiApiKey,
              openaiModel: opts.openaiModel,
              dbPath: opts.dbPath,
              noIndexOnStart: opts.noIndexOnStart,
              notifyEnabled: opts.notifyEnabled,
              notifyQuietWindowMs: opts.notifyQuietWindow ? Number.parseInt(opts.notifyQuietWindow) : undefined,
              notifyBatchTimeoutMs: opts.notifyBatchTimeout ? Number.parseInt(opts.notifyBatchTimeout) : undefined,
            });
          } else {
            await runSetup();
          }
        });
    }, { commands: ["multimodal-rag"] });

    // ========================================================================
    // 注册服务（文件监听）
    // ========================================================================

    api.registerService({
      id: "multimodal-rag-watcher",
      start: async () => {
        await watcher.start();
        api.logger.info?.("multimodal-rag: File watcher started");
      },
      stop: async () => {
        await watcher.stop();
        api.logger.info?.("multimodal-rag: File watcher stopped");
      },
    });

    api.logger.info?.(
      `multimodal-rag: Plugin initialized (db: ${resolvedDbPath})`,
    );
  },
};

export default multimodalRagPlugin;
