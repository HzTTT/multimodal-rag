/**
 * OpenClaw Multimodal RAG Plugin
 *
 * 多模态 RAG 插件，支持图像和音频的语义索引与时间感知搜索。
 */

import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { registerMultimodalRagCli } from "./src/cli.js";
import { multimodalRagConfigSchema } from "./src/config.js";
import { logMultimodalRagDoctorReport } from "./src/doctor.js";
import {
  createMultimodalRagRuntime,
  registerMultimodalRagService,
  registerMultimodalRagTools,
} from "./src/runtime.js";

const multimodalRagPlugin = definePluginEntry({
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
