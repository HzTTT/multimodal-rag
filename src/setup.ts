/**
 * 引导配置（交互式 & 非交互式）
 *
 * 交互式: `openclaw multimodal-rag setup`
 * 非交互式: `openclaw multimodal-rag setup --watch ~/photos,~/audio --non-interactive`
 */

import * as readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { resolveWhisperBin } from "./whisper-bin.js";

// 配置文件路径
const CONFIG_DIR = path.join(os.homedir(), ".openclaw");
const CONFIG_FILE = path.join(CONFIG_DIR, "openclaw.json");

type PluginConfigPartial = {
  watchPaths?: string[];
  ollama?: {
    baseUrl?: string;
    visionModel?: string;
    embedModel?: string;
  };
  embedding?: {
    provider?: "ollama" | "openai";
    openaiApiKey?: string;
    openaiModel?: string;
  };
  dbPath?: string;
  indexExistingOnStart?: boolean;
  notifications?: {
    enabled?: boolean;
    agentId?: string;
    quietWindowMs?: number;
    batchTimeoutMs?: number;
    channel?: string;
    to?: string;
    targets?: Array<{
      channel?: string;
      to?: string;
      accountId?: string;
    }>;
  };
};

/** 非交互式 setup 的选项 */
export type NonInteractiveSetupOpts = {
  watch: string[];
  ollamaUrl?: string;
  visionModel?: string;
  embedModel?: string;
  embeddingProvider?: "ollama" | "openai";
  openaiApiKey?: string;
  openaiModel?: string;
  dbPath?: string;
  noIndexOnStart?: boolean;
  notifyEnabled?: boolean;
  notifyQuietWindowMs?: number;
  notifyBatchTimeoutMs?: number;
};

function loadOpenClawConfig(): Record<string, unknown> {
  if (!fs.existsSync(CONFIG_FILE)) {
    return {};
  }
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function saveOpenClawConfig(config: Record<string, unknown>): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2) + "\n", "utf-8");
}

function getExistingPluginConfig(config: Record<string, unknown>): PluginConfigPartial {
  const plugins = config.plugins as Record<string, unknown> | undefined;
  const entries = plugins?.entries as Record<string, unknown> | undefined;
  const entry = entries?.["multimodal-rag"] as Record<string, unknown> | undefined;
  return (entry?.config as PluginConfigPartial) || {};
}

/**
 * 将插件配置写入 openclaw.json
 */
function writePluginConfig(pluginConfig: PluginConfigPartial): void {
  const config = loadOpenClawConfig();
  const plugins = (config.plugins || {}) as Record<string, unknown>;
  const entries = (plugins.entries || {}) as Record<string, unknown>;
  const pluginEntry = (entries["multimodal-rag"] || {}) as Record<string, unknown>;

  pluginEntry.enabled = true;
  pluginEntry.config = pluginConfig;

  entries["multimodal-rag"] = pluginEntry;
  plugins.entries = entries;
  config.plugins = plugins;

  saveOpenClawConfig(config);
}

function printDependencyHints(pluginConfig: PluginConfigPartial): void {
  const provider = pluginConfig.embedding?.provider || "ollama";
  const openaiConfigured = !!pluginConfig.embedding?.openaiApiKey;
  console.log("依赖提示:");
  console.log(`  Whisper 命令:  ${resolveWhisperBin()}`);
  console.log("  ffmpeg:        必需（音频转录）");
  console.log(
    `  Ollama:        ${
      provider === "ollama" ? "必需（图像描述 + 嵌入）" : "必需（图像描述）"
    }`,
  );
  if (provider === "openai") {
    console.log(`  OpenAI API Key: ${openaiConfigured ? "已配置" : "未配置（必需）"}`);
  }
}

/**
 * 非交互式配置
 *
 * 适用于脚本自动化、SSH 远程部署等场景。
 * 所有参数通过命令行选项传入，不读取 stdin。
 *
 * 用法:
 *   openclaw multimodal-rag setup --non-interactive --watch ~/photos,~/audio
 *   openclaw multimodal-rag setup -n -w ~/photos -w ~/audio --ollama-url http://host:11434
 */
export async function runNonInteractiveSetup(opts: NonInteractiveSetupOpts): Promise<void> {
  if (opts.watch.length === 0) {
    console.error("✗ 非交互式模式必须通过 --watch 指定至少一个监听路径");
    console.error("  示例: openclaw multimodal-rag setup --non-interactive --watch ~/photos");
    process.exit(1);
  }

  const existing = getExistingPluginConfig(loadOpenClawConfig());

  const pluginConfig: PluginConfigPartial = {
    watchPaths: opts.watch,
    ollama: {
      baseUrl: opts.ollamaUrl || existing.ollama?.baseUrl || "http://127.0.0.1:11434",
      visionModel: opts.visionModel || existing.ollama?.visionModel || "qwen3-vl:2b",
      embedModel: opts.embedModel || existing.ollama?.embedModel || "qwen3-embedding:latest",
    },
    embedding: {
      provider: opts.embeddingProvider || existing.embedding?.provider || "ollama",
      ...(opts.openaiApiKey && { openaiApiKey: opts.openaiApiKey }),
      ...(opts.openaiModel && { openaiModel: opts.openaiModel }),
      ...(existing.embedding?.openaiApiKey &&
        !opts.openaiApiKey && { openaiApiKey: existing.embedding.openaiApiKey }),
      ...(existing.embedding?.openaiModel &&
        !opts.openaiModel && { openaiModel: existing.embedding.openaiModel }),
    },
    dbPath: opts.dbPath || existing.dbPath || "~/.openclaw/multimodal-rag.lance",
    indexExistingOnStart: opts.noIndexOnStart ? false : (existing.indexExistingOnStart !== false),
    notifications: {
      enabled: opts.notifyEnabled ?? existing.notifications?.enabled ?? false,
      agentId: existing.notifications?.agentId,
      quietWindowMs: opts.notifyQuietWindowMs ?? existing.notifications?.quietWindowMs ?? 30000,
      batchTimeoutMs: opts.notifyBatchTimeoutMs ?? existing.notifications?.batchTimeoutMs ?? 600000,
      channel: existing.notifications?.channel ?? "last",
      to: existing.notifications?.to,
      targets: existing.notifications?.targets ?? [],
    },
  };

  writePluginConfig(pluginConfig);

  console.log("✓ 配置已保存到 ~/.openclaw/openclaw.json\n");
  console.log("配置摘要:");
  console.log(`  监听路径:     ${pluginConfig.watchPaths!.join(", ")}`);
  console.log(`  Ollama 地址:  ${pluginConfig.ollama!.baseUrl}`);
  console.log(`  视觉模型:     ${pluginConfig.ollama!.visionModel}`);
  console.log(`  嵌入模型:     ${pluginConfig.ollama!.embedModel}`);
  console.log(`  嵌入提供者:   ${pluginConfig.embedding!.provider}`);
  console.log(`  数据库路径:   ${pluginConfig.dbPath}`);
  console.log(`  启动时索引:   ${pluginConfig.indexExistingOnStart ? "是" : "否"}`);
  console.log(`  索引通知:     ${pluginConfig.notifications!.enabled ? "已启用" : "已禁用"}`);
  if (pluginConfig.notifications!.enabled) {
    if (pluginConfig.notifications!.agentId) {
      console.log(`    Agent ID:   ${pluginConfig.notifications!.agentId}`);
    }
    console.log(`    静默窗口:   ${pluginConfig.notifications!.quietWindowMs}ms`);
    console.log(`    批次超时:   ${pluginConfig.notifications!.batchTimeoutMs}ms`);
    console.log(`    通知渠道:   ${pluginConfig.notifications!.channel || "last"}`);
    if (pluginConfig.notifications!.to) {
      console.log(`    通知目标:   ${pluginConfig.notifications!.to}`);
    }
    if ((pluginConfig.notifications!.targets?.length ?? 0) > 0) {
      console.log(`    通知目标:   ${pluginConfig.notifications!.targets!.length} 个`);
    }
  }
  printDependencyHints(pluginConfig);
  console.log();
  console.log("提示: 重启 OpenClaw Gateway 以加载新配置");
}

async function checkOllamaHealth(baseUrl: string): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(5000) });
    return res.ok;
  } catch {
    return false;
  }
}

async function listOllamaModels(baseUrl: string): Promise<string[]> {
  try {
    const res = await fetch(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return [];
    const data = (await res.json()) as { models?: Array<{ name: string }> };
    return data.models?.map((m) => m.name) ?? [];
  } catch {
    return [];
  }
}

export async function runSetup(): Promise<void> {
  const rl = readline.createInterface({ input, output });

  console.log("\n🔧 Multimodal RAG 插件配置向导\n");
  console.log("本向导将引导你完成插件的基本配置。");
  console.log("直接按 Enter 使用 [默认值]。\n");

  const config = loadOpenClawConfig();
  const existing = getExistingPluginConfig(config);
  
  // 使用默认配置
  const pluginConfig: PluginConfigPartial = {
    ollama: {
      baseUrl: "http://127.0.0.1:11434",
      visionModel: "qwen3-vl:2b",
      embedModel: "qwen3-embedding:latest",
    },
    embedding: {
      provider: "ollama",
    },
    dbPath: "~/.openclaw/multimodal-rag.lance",
    indexExistingOnStart: true,
    notifications: {
      enabled: existing.notifications?.enabled ?? false,
      agentId: existing.notifications?.agentId,
      quietWindowMs: existing.notifications?.quietWindowMs ?? 30000,
      batchTimeoutMs: existing.notifications?.batchTimeoutMs ?? 600000,
      channel: existing.notifications?.channel ?? "last",
      to: existing.notifications?.to,
      targets: existing.notifications?.targets ?? [],
    },
  };

  // ================================================================
  // 1. 监听路径 - 唯一需要用户配置的项
  // ================================================================
  console.log("── 文件监听路径配置 ──\n");
  console.log("设置需要监听的文件夹，插件会自动索引其中的图片和音频文件。");
  console.log("多个路径用逗号分隔，支持 ~ 展开。\n");

  const defaultPaths = existing.watchPaths?.join(", ") || "~/mic-recordings, ~/usb_data";
  const pathsInput = await rl.question(`监听路径 [${defaultPaths}]: `);
  const watchPaths = (pathsInput.trim() || defaultPaths)
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  pluginConfig.watchPaths = watchPaths;
  console.log(`  ✓ 将监听: ${watchPaths.join(", ")}\n`);

  // ================================================================
  // 检查 Ollama 连接状态（仅用于提示）
  // ================================================================
  const ollamaUrl = pluginConfig.ollama!.baseUrl!;
  process.stdout.write("检查 Ollama 连接...");
  const ollamaOk = await checkOllamaHealth(ollamaUrl);
  if (ollamaOk) {
    console.log(" ✓ 已连接\n");
  } else {
    console.log(" ✗ 无法连接\n");
    console.log("  ⚠ 请确保 Ollama 已安装并启动 (ollama serve)");
    console.log("  ⚠ 安装: https://ollama.ai\n");
  }

  // 列出可用模型（仅用于提示）
  let availableModels: string[] = [];
  if (ollamaOk) {
    availableModels = await listOllamaModels(ollamaUrl);
    if (availableModels.length > 0) {
      console.log("  已安装的模型:");
      for (const model of availableModels) {
        console.log(`    - ${model}`);
      }
      console.log();
    }
  }

  rl.close();

  // ================================================================
  // 写入配置
  // ================================================================
  console.log("\n── 保存配置 ──\n");

  writePluginConfig(pluginConfig);

  console.log("✓ 配置已保存到 ~/.openclaw/openclaw.json\n");

  // 打印摘要
  console.log("── 配置摘要 ──\n");
  console.log(`  监听路径:     ${watchPaths.join(", ")}`);
  console.log(`  Ollama 地址:  ${pluginConfig.ollama!.baseUrl}`);
  console.log(`  视觉模型:     ${pluginConfig.ollama!.visionModel}`);
  console.log(`  嵌入模型:     ${pluginConfig.ollama!.embedModel}`);
  console.log(`  嵌入提供者:   ${pluginConfig.embedding!.provider}`);
  console.log(`  数据库路径:   ${pluginConfig.dbPath}`);
  console.log(`  启动时索引:   ${pluginConfig.indexExistingOnStart ? "是" : "否"}`);
  console.log(`  索引通知:     ${pluginConfig.notifications!.enabled ? "已启用" : "已禁用"}`);
  if (pluginConfig.notifications!.enabled) {
    console.log(`    静默窗口:   ${pluginConfig.notifications!.quietWindowMs}ms`);
    console.log(`    批次超时:   ${pluginConfig.notifications!.batchTimeoutMs}ms`);
    console.log(`    通知渠道:   ${pluginConfig.notifications!.channel || "last"}`);
    if (pluginConfig.notifications!.to) {
      console.log(`    通知目标:   ${pluginConfig.notifications!.to}`);
    }
    if ((pluginConfig.notifications!.targets?.length ?? 0) > 0) {
      console.log(`    通知目标:   ${pluginConfig.notifications!.targets!.length} 个`);
    }
  }
  console.log();
  printDependencyHints(pluginConfig);
  console.log();

  // 前置条件检查
  console.log("── 前置条件检查 ──\n");

  if (!ollamaOk) {
    console.log("  ✗ Ollama 未运行");
    console.log("    → 安装: https://ollama.ai");
    console.log("    → 启动: ollama serve\n");
  } else {
    console.log("  ✓ Ollama 已连接");
    const missingModels: string[] = [];
    const visionModel = pluginConfig.ollama!.visionModel!;
    const embedModel = pluginConfig.ollama!.embedModel!;
    
    if (!availableModels.some((m) => m.startsWith(visionModel.split(":")[0]))) {
      missingModels.push(visionModel);
    }
    if (!availableModels.some((m) => m.startsWith(embedModel.split(":")[0]))) {
      missingModels.push(embedModel);
    }
    
    if (missingModels.length > 0) {
      console.log("  ⚠ 缺少以下模型，请手动拉取:");
      for (const model of missingModels) {
        console.log(`    → ollama pull ${model}`);
      }
    } else {
      console.log("  ✓ 所需模型已安装");
    }
    console.log();
  }

  console.log("── 下一步 ──\n");
  console.log("  1. 确保 Ollama 已启动并已拉取所需模型");
  console.log("  2. 重启 OpenClaw Gateway 以加载插件");
  console.log("  3. 使用 `openclaw multimodal-rag stats` 查看索引状态");
  console.log("  4. 通过 Agent 使用语义搜索: '帮我找一张...的照片'\n");
}
