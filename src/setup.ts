/**
 * 交互式引导配置
 *
 * 运行 `openclaw multimodal-rag setup` 时调用，
 * 引导用户完成必要配置并写入 openclaw 配置文件。
 */

import * as readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

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
    dbPath: "/home/lucy/.openclaw/multimodal-rag.lance",
    indexExistingOnStart: true,
  };

  // ================================================================
  // 1. 监听路径 - 唯一需要用户配置的项
  // ================================================================
  console.log("── 文件监听路径配置 ──\n");
  console.log("设置需要监听的文件夹，插件会自动索引其中的图片和音频文件。");
  console.log("多个路径用逗号分隔，支持 ~ 展开。\n");

  const defaultPaths = existing.watchPaths?.join(", ") || "~/mic-recordings, /home/lucy/usb_data";
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

  // 深合并到 openclaw 配置
  const plugins = (config.plugins || {}) as Record<string, unknown>;
  const entries = (plugins.entries || {}) as Record<string, unknown>;
  const pluginEntry = (entries["multimodal-rag"] || {}) as Record<string, unknown>;

  pluginEntry.enabled = true;
  pluginEntry.config = pluginConfig;

  entries["multimodal-rag"] = pluginEntry;
  plugins.entries = entries;
  config.plugins = plugins;

  saveOpenClawConfig(config);

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
