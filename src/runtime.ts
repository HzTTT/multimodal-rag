import type { Server } from "node:http";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-runtime";
import {
  createEmbeddingProvider,
  IndexNotifier,
  createMediaProcessor,
  createOllamaVlmOcrProvider,
  MediaStorage,
  MediaWatcher,
  resolveWhisperBin,
} from "../plugin-runtime.js";
import { startHttpServer } from "./http-server.js";
import {
  collectDeferredConfigWarnings,
  collectWatcherStartupBlockers,
  normalizePluginConfig,
} from "./config.js";
import {
  createMediaDescribeTool,
  createMediaListTool,
  createMediaSearchTool,
  createMediaStatsTool,
} from "./tools.js";
import type {
  IEmbeddingProvider,
  IMediaProcessor,
  IOcrProvider,
  PluginConfig,
} from "./types.js";

export type MultimodalRagRuntime = {
  config: PluginConfig;
  resolvedDbPath: string;
  whisperBin?: string;
  embeddings: IEmbeddingProvider;
  storage: MediaStorage;
  processor: IMediaProcessor;
  ocr?: IOcrProvider;
  watcher: MediaWatcher;
  notifier?: IndexNotifier;
  vectorDim: number;
  deferredWarnings: string[];
  watcherStartupBlockers: string[];
  httpServer?: Server; // 由 http service 在 start 时填充、stop 时清空
};

const runtimeCache = new WeakMap<object, MultimodalRagRuntime>();

function resolveEmbeddingVectorDim(config: PluginConfig): number {
  if (config.embedding.provider === "openai") {
    return config.embedding.openaiModel.includes("large") ? 3072 : 1536;
  }

  return config.ollama.embedModel.includes("0.6b") ? 2048 : 4096;
}

function createDeferredEmbeddingProvider(config: PluginConfig): IEmbeddingProvider {
  let provider: IEmbeddingProvider | undefined;

  const getProvider = (): IEmbeddingProvider => {
    if (!provider) {
      provider = createEmbeddingProvider({
        provider: config.embedding.provider,
        ollamaBaseUrl: config.ollama.baseUrl,
        ollamaApiKey: config.ollama.apiKey,
        ollamaModel: config.ollama.embedModel,
        openaiApiKey: config.embedding.openaiApiKey,
        openaiModel: config.embedding.openaiModel,
      });
    }
    return provider;
  };

  return {
    embed(text: string) {
      return getProvider().embed(text);
    },
    getDimension() {
      return resolveEmbeddingVectorDim(config);
    },
  };
}

/**
 * 构造 OCR provider：默认复用 Ollama VLM（visionModel 或自定义 ocrModel）
 */
function createOcrProviderIfEnabled(config: PluginConfig): IOcrProvider | undefined {
  if (!config.document.ocrEnabled) {
    return undefined;
  }
  const model = config.ollama.ocrModel || config.ollama.visionModel;
  if (!model) {
    return undefined;
  }
  return createOllamaVlmOcrProvider({
    baseUrl: config.ollama.baseUrl,
    apiKey: config.ollama.apiKey,
    model,
  });
}

export function createMultimodalRagRuntime(api: OpenClawPluginApi): MultimodalRagRuntime {
  const cached = runtimeCache.get(api as object);
  if (cached) {
    return cached;
  }

  const config = normalizePluginConfig((api.pluginConfig || {}) as Partial<PluginConfig>);
  const resolvedDbPath = api.resolvePath(config.dbPath);
  const whisperBin = config.whisper.provider === "local" ? resolveWhisperBin() : undefined;
  const embeddings = createDeferredEmbeddingProvider(config);
  const vectorDim = resolveEmbeddingVectorDim(config);
  const deferredWarnings = collectDeferredConfigWarnings(config);
  const watcherStartupBlockers = collectWatcherStartupBlockers(config);
  const storage = new MediaStorage(resolvedDbPath, vectorDim);
  const ocr = createOcrProviderIfEnabled(config);
  const processor = createMediaProcessor({
    ollamaBaseUrl: config.ollama.baseUrl,
    ollamaApiKey: config.ollama.apiKey,
    visionModel: config.ollama.visionModel,
    whisper: config.whisper,
    document: {
      chunkSize: config.document.chunkSize,
      chunkOverlap: config.document.chunkOverlap,
      ocrTriggerChars: config.document.ocrTriggerChars,
    },
    ocr,
  });
  const notifier = config.notifications?.enabled
    ? new IndexNotifier(config.notifications, api.runtime, api.logger, api.config)
    : undefined;
  const watcher = new MediaWatcher(
    config,
    storage,
    embeddings,
    processor,
    api.logger,
    notifier,
  );

  const runtime: MultimodalRagRuntime = {
    config,
    resolvedDbPath,
    whisperBin,
    embeddings,
    storage,
    processor,
    ocr,
    watcher,
    notifier,
    vectorDim,
    deferredWarnings,
    watcherStartupBlockers,
  };
  runtimeCache.set(api as object, runtime);
  return runtime;
}

export function registerMultimodalRagTools(api: OpenClawPluginApi, runtime: MultimodalRagRuntime): void {
  api.registerTool(createMediaStatsTool(runtime.storage, runtime.watcher), {
    name: "media_stats",
  });
  api.registerTool(createMediaSearchTool(runtime.storage, runtime.embeddings), {
    name: "media_search",
  });
  api.registerTool(createMediaListTool(runtime.storage, runtime.config), {
    name: "media_list",
  });
  api.registerTool(
    createMediaDescribeTool(runtime.storage, runtime.processor, runtime.embeddings, runtime.watcher),
    {
      name: "media_describe",
    },
  );
}

export function registerMultimodalRagService(
  api: OpenClawPluginApi,
  runtime: MultimodalRagRuntime,
): void {
  api.registerService({
    id: "multimodal-rag-watcher",
    start: async () => {
      const started = await runtime.watcher.start();
      if (started) {
        api.logger.info?.("multimodal-rag: File watcher started");
      }
    },
    stop: async () => {
      await runtime.watcher.stop();
      api.logger.info?.("multimodal-rag: File watcher stopped");
    },
  });
}

/**
 * 注册 HTTP 服务（/get_file_info + /search_file），随 gateway 生命周期自动启停。
 * 仅当 config.http.enabled === true 时实际监听端口；否则 start 直接返回。
 */
export function registerMultimodalRagHttpService(
  api: OpenClawPluginApi,
  runtime: MultimodalRagRuntime,
): void {
  api.registerService({
    id: "multimodal-rag-http",
    start: async () => {
      const httpCfg = runtime.config.http;
      if (!httpCfg.enabled) {
        api.logger.info?.(
          "multimodal-rag: HTTP service disabled (config.http.enabled=false)",
        );
        return;
      }
      try {
        runtime.httpServer = await startHttpServer({
          host: httpCfg.host,
          port: httpCfg.port,
          storage: runtime.storage,
          embeddings: runtime.embeddings,
          watcher: httpCfg.enableIndexOnDemand ? runtime.watcher : undefined,
          searchLimit: httpCfg.searchLimit,
          searchMinScore: httpCfg.searchMinScore,
        });
        api.logger.info?.(
          `multimodal-rag: HTTP service listening on http://${httpCfg.host}:${httpCfg.port}`,
        );
      } catch (error) {
        const message =
          error instanceof Error ? error.message : String(error);
        api.logger.warn?.(
          `multimodal-rag: HTTP service failed to start (${httpCfg.host}:${httpCfg.port}): ${message}`,
        );
      }
    },
    stop: async () => {
      const server = runtime.httpServer;
      if (!server) {
        return;
      }
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        // node 的 server.close 只会拒绝新连接，保留现有连接
        // setTimeout 5s 兜底，避免关闭时被长连接拖住
        setTimeout(() => resolve(), 5000).unref?.();
      });
      runtime.httpServer = undefined;
      api.logger.info?.("multimodal-rag: HTTP service stopped");
    },
  });
}
