/**
 * OpenClaw Multimodal RAG Plugin
 *
 * 多模态 RAG 插件，支持图像和音频的语义索引与时间感知搜索。
 */

import { registerMultimodalRagCli } from "./src/cli.js";
import { multimodalRagConfigSchema } from "./src/config.js";
import { logMultimodalRagDoctorReport } from "./src/doctor.js";
import {
  createMultimodalRagRuntime,
  registerMultimodalRagService,
  registerMultimodalRagTools,
} from "./src/runtime.js";

type PluginConfigSchema = {
  safeParse?: (value: unknown) => {
    success: boolean;
    data?: unknown;
    error?: {
      issues?: Array<{
        path: Array<string | number>;
        message: string;
      }>;
    };
  };
  parse?: (value: unknown) => unknown;
  validate?: (value: unknown) => unknown;
  jsonSchema?: Record<string, unknown>;
};

type NativePluginEntry = {
  id: string;
  name: string;
  description: string;
  kind?: string;
  configSchema: PluginConfigSchema;
  register: (api: any) => void;
};

function emptyPluginConfigSchema(): PluginConfigSchema {
  return {
    safeParse(value) {
      if (value === undefined || (value && typeof value === "object" && !Array.isArray(value))) {
        return { success: true, data: value ?? {} };
      }
      return {
        success: false,
        error: {
          issues: [{ path: [], message: "expected config object" }],
        },
      };
    },
    jsonSchema: {
      type: "object",
      additionalProperties: false,
      properties: {},
    },
  };
}

function definePluginEntryCompat(options: {
  id: string;
  name: string;
  description: string;
  kind?: string;
  configSchema?: PluginConfigSchema | (() => PluginConfigSchema);
  register: (api: any) => void;
}): NativePluginEntry {
  const resolvedConfigSchema =
    typeof options.configSchema === "function"
      ? options.configSchema()
      : options.configSchema ?? emptyPluginConfigSchema();

  return {
    id: options.id,
    name: options.name,
    description: options.description,
    ...(options.kind ? { kind: options.kind } : {}),
    configSchema: resolvedConfigSchema,
    register: options.register,
  };
}

const multimodalRagPlugin = definePluginEntryCompat({
  id: "multimodal-rag",
  name: "Multimodal RAG",
  description:
    "多模态 RAG 插件，支持图像和音频的语义索引与时间感知搜索",
  configSchema: multimodalRagConfigSchema,

  register(api) {
    const runtime = createMultimodalRagRuntime(api);
    for (const warning of runtime.deferredWarnings) {
      api.logger.warn?.(`multimodal-rag: ${warning}`);
    }
    logMultimodalRagDoctorReport(runtime, api.logger);
    const { resolvedDbPath } = runtime;

    // ========================================================================
    // 注册工具
    // ========================================================================

    registerMultimodalRagTools(api, runtime);

    // ========================================================================
    // 注册 CLI 命令
    // ========================================================================

    registerMultimodalRagCli(api, runtime);

    // ========================================================================
    // 注册服务（文件监听）
    // ========================================================================

    registerMultimodalRagService(api, runtime);

    api.logger.info?.(
      `multimodal-rag: Plugin initialized (db: ${resolvedDbPath})`,
    );
  },
});

export default multimodalRagPlugin;
