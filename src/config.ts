import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { OpenClawPluginConfigSchema } from "openclaw/plugin-sdk/plugin-entry";
import type { PluginConfig } from "./types.js";

export const DEFAULT_IMAGE_EXTENSIONS = [
  ".jpg",
  ".jpeg",
  ".png",
  ".webp",
  ".gif",
  ".heic",
];
export const DEFAULT_AUDIO_EXTENSIONS = [
  ".wav",
  ".mp3",
  ".m4a",
  ".ogg",
  ".flac",
  ".aac",
];
export const DEFAULT_DOCUMENT_EXTENSIONS = [
  ".pdf",
  ".docx",
  ".xlsx",
  ".pptx",
  ".txt",
  ".md",
  ".markdown",
  ".html",
  ".htm",
];
export const DEFAULT_OLLAMA_BASE_URL = "http://127.0.0.1:11434";
export const DEFAULT_VISION_MODEL = "qwen3-vl:2b";
export const DEFAULT_EMBED_MODEL = "qwen3-embedding:latest";
export const DEFAULT_OPENAI_EMBED_MODEL = "text-embedding-3-small";
export const DEFAULT_DB_PATH = "~/.openclaw/multimodal-rag.lance";
export const DEFAULT_WATCH_DEBOUNCE_MS = 1000;
export const DEFAULT_NOTIFICATION_QUIET_WINDOW_MS = 30000;
export const DEFAULT_NOTIFICATION_BATCH_TIMEOUT_MS = 600000;
export const DEFAULT_NOTIFICATION_CHANNEL = "last";
export const DEFAULT_WHISPER_PROVIDER = "local";
export const DEFAULT_EMBEDDING_PROVIDER = "ollama";
export const DEFAULT_WHISPER_MODEL = "glm-asr-2512";
export const DEFAULT_WHISPER_LANGUAGE = "zh";
export const DEFAULT_CHUNK_SIZE = 800;
export const DEFAULT_CHUNK_OVERLAP = 120;
export const DEFAULT_OCR_TRIGGER_CHARS = 30;
export const DEFAULT_OCR_ENABLED = true;

const notificationTargetSchema = Type.Object(
  {
    channel: Type.String(),
    to: Type.String(),
    accountId: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

const configSchema = Type.Object(
  {
    watchPaths: Type.Optional(Type.Array(Type.String(), { default: [] })),
    fileTypes: Type.Optional(
      Type.Object(
        {
          image: Type.Optional(
            Type.Array(Type.String(), { default: DEFAULT_IMAGE_EXTENSIONS }),
          ),
          audio: Type.Optional(
            Type.Array(Type.String(), { default: DEFAULT_AUDIO_EXTENSIONS }),
          ),
          document: Type.Optional(
            Type.Array(Type.String(), { default: DEFAULT_DOCUMENT_EXTENSIONS }),
          ),
        },
        { additionalProperties: false, default: {} },
      ),
    ),
    ollama: Type.Optional(
      Type.Object(
        {
          baseUrl: Type.Optional(Type.String({ default: DEFAULT_OLLAMA_BASE_URL })),
          apiKey: Type.Optional(Type.String()),
          visionModel: Type.Optional(Type.String({ default: DEFAULT_VISION_MODEL })),
          embedModel: Type.Optional(Type.String({ default: DEFAULT_EMBED_MODEL })),
          ocrModel: Type.Optional(Type.String()),
        },
        { additionalProperties: false, default: {} },
      ),
    ),
    embedding: Type.Optional(
      Type.Object(
        {
          provider: Type.Optional(
            Type.Union([Type.Literal("ollama"), Type.Literal("openai")], {
              default: DEFAULT_EMBEDDING_PROVIDER,
            }),
          ),
          openaiApiKey: Type.Optional(Type.String()),
          openaiModel: Type.Optional(
            Type.String({ default: DEFAULT_OPENAI_EMBED_MODEL }),
          ),
        },
        { additionalProperties: false, default: {} },
      ),
    ),
    whisper: Type.Optional(
      Type.Object(
        {
          provider: Type.Optional(
            Type.Union([Type.Literal("local"), Type.Literal("zhipu")], {
              default: DEFAULT_WHISPER_PROVIDER,
            }),
          ),
          zhipuApiKey: Type.Optional(Type.String()),
          zhipuApiBaseUrl: Type.Optional(Type.String()),
          zhipuModel: Type.Optional(Type.String({ default: DEFAULT_WHISPER_MODEL })),
          language: Type.Optional(Type.String({ default: DEFAULT_WHISPER_LANGUAGE })),
        },
        { additionalProperties: false, default: {} },
      ),
    ),
    document: Type.Optional(
      Type.Object(
        {
          chunkSize: Type.Optional(Type.Number({ default: DEFAULT_CHUNK_SIZE })),
          chunkOverlap: Type.Optional(Type.Number({ default: DEFAULT_CHUNK_OVERLAP })),
          ocrTriggerChars: Type.Optional(
            Type.Number({ default: DEFAULT_OCR_TRIGGER_CHARS }),
          ),
          ocrEnabled: Type.Optional(Type.Boolean({ default: DEFAULT_OCR_ENABLED })),
        },
        { additionalProperties: false, default: {} },
      ),
    ),
    dbPath: Type.Optional(Type.String({ default: DEFAULT_DB_PATH })),
    watchDebounceMs: Type.Optional(
      Type.Number({ default: DEFAULT_WATCH_DEBOUNCE_MS }),
    ),
    indexExistingOnStart: Type.Optional(Type.Boolean({ default: true })),
    notifications: Type.Optional(
      Type.Object(
        {
          enabled: Type.Optional(Type.Boolean({ default: false })),
          agentId: Type.Optional(Type.String()),
          quietWindowMs: Type.Optional(
            Type.Number({ default: DEFAULT_NOTIFICATION_QUIET_WINDOW_MS }),
          ),
          batchTimeoutMs: Type.Optional(
            Type.Number({ default: DEFAULT_NOTIFICATION_BATCH_TIMEOUT_MS }),
          ),
          channel: Type.Optional(
            Type.String({ default: DEFAULT_NOTIFICATION_CHANNEL }),
          ),
          to: Type.Optional(Type.String()),
          targets: Type.Optional(Type.Array(notificationTargetSchema, { default: [] })),
        },
        { additionalProperties: false, default: {} },
      ),
    ),
  },
  { additionalProperties: false },
);

function toIssuePath(path: string): Array<string | number> {
  if (!path || path === "/") {
    return [];
  }

  return path
    .split("/")
    .slice(1)
    .map((segment) => segment.replace(/~1/g, "/").replace(/~0/g, "~"))
    .map((segment) => {
      const index = Number(segment);
      return Number.isInteger(index) && String(index) === segment ? index : segment;
    });
}

export const multimodalRagConfigJsonSchema = configSchema;

export const multimodalRagConfigSchema: OpenClawPluginConfigSchema = {
  safeParse(value) {
    const candidate = value === undefined ? {} : value;
    if (Value.Check(configSchema, candidate)) {
      return { success: true, data: candidate };
    }

    return {
      success: false,
      error: {
        issues: [...Value.Errors(configSchema, candidate)].map((issue) => ({
          path: toIssuePath(issue.path),
          message: issue.message,
        })),
      },
    };
  },
  jsonSchema: multimodalRagConfigJsonSchema,
};

export function normalizePluginConfig(
  userConfig: Partial<PluginConfig> = {},
): PluginConfig {
  const watchPaths = Array.isArray(userConfig.watchPaths) ? userConfig.watchPaths : [];

  return {
    watchPaths,
    fileTypes: {
      image: userConfig.fileTypes?.image || DEFAULT_IMAGE_EXTENSIONS,
      audio: userConfig.fileTypes?.audio || DEFAULT_AUDIO_EXTENSIONS,
      document: userConfig.fileTypes?.document || DEFAULT_DOCUMENT_EXTENSIONS,
    },
    ollama: {
      baseUrl: userConfig.ollama?.baseUrl || DEFAULT_OLLAMA_BASE_URL,
      apiKey: userConfig.ollama?.apiKey,
      visionModel: userConfig.ollama?.visionModel || DEFAULT_VISION_MODEL,
      embedModel: userConfig.ollama?.embedModel || DEFAULT_EMBED_MODEL,
      ocrModel: userConfig.ollama?.ocrModel,
    },
    embedding: {
      provider: userConfig.embedding?.provider || DEFAULT_EMBEDDING_PROVIDER,
      openaiApiKey: userConfig.embedding?.openaiApiKey,
      openaiModel: userConfig.embedding?.openaiModel || DEFAULT_OPENAI_EMBED_MODEL,
    },
    whisper: {
      provider: userConfig.whisper?.provider || DEFAULT_WHISPER_PROVIDER,
      zhipuApiKey: userConfig.whisper?.zhipuApiKey,
      zhipuApiBaseUrl: userConfig.whisper?.zhipuApiBaseUrl,
      zhipuModel: userConfig.whisper?.zhipuModel || DEFAULT_WHISPER_MODEL,
      language: userConfig.whisper?.language || DEFAULT_WHISPER_LANGUAGE,
    },
    document: {
      chunkSize: userConfig.document?.chunkSize ?? DEFAULT_CHUNK_SIZE,
      chunkOverlap: userConfig.document?.chunkOverlap ?? DEFAULT_CHUNK_OVERLAP,
      ocrTriggerChars:
        userConfig.document?.ocrTriggerChars ?? DEFAULT_OCR_TRIGGER_CHARS,
      ocrEnabled: userConfig.document?.ocrEnabled ?? DEFAULT_OCR_ENABLED,
    },
    dbPath: userConfig.dbPath || DEFAULT_DB_PATH,
    watchDebounceMs: userConfig.watchDebounceMs || DEFAULT_WATCH_DEBOUNCE_MS,
    indexExistingOnStart: userConfig.indexExistingOnStart !== false,
    notifications: {
      enabled: userConfig.notifications?.enabled ?? false,
      agentId: userConfig.notifications?.agentId,
      quietWindowMs:
        userConfig.notifications?.quietWindowMs ??
        DEFAULT_NOTIFICATION_QUIET_WINDOW_MS,
      batchTimeoutMs:
        userConfig.notifications?.batchTimeoutMs ??
        DEFAULT_NOTIFICATION_BATCH_TIMEOUT_MS,
      channel: userConfig.notifications?.channel || DEFAULT_NOTIFICATION_CHANNEL,
      to: userConfig.notifications?.to,
      targets: userConfig.notifications?.targets || [],
    },
  };
}

export function buildDependencyHints(
  config: PluginConfig,
  whisperBin?: string,
): Record<string, unknown> {
  return {
    whisperProvider: config.whisper.provider,
    ...(whisperBin ? { whisperBin } : {}),
    ...(config.whisper.provider === "zhipu"
      ? {
          zhipuApiKeyConfigured: !!config.whisper.zhipuApiKey,
          zhipuModel: config.whisper.zhipuModel,
        }
      : {}),
    ffmpegRequired: true,
    pdfRenderRequired: config.document.ocrEnabled,
    ollamaRequiredForImage: true,
    ollamaRequiredForEmbedding: config.embedding.provider === "ollama",
    ollamaRequiredForOcr:
      config.document.ocrEnabled && (config.ollama.ocrModel || config.ollama.visionModel)
        ? true
        : false,
    ocrModel: config.ollama.ocrModel || config.ollama.visionModel,
    openaiKeyConfigured:
      config.embedding.provider !== "openai" || !!config.embedding.openaiApiKey,
  };
}

export function collectDeferredConfigWarnings(config: PluginConfig): string[] {
  const warnings: string[] = [];

  if (config.embedding.provider === "openai" && !config.embedding.openaiApiKey) {
    warnings.push(
      "embedding.provider=openai 但未配置 embedding.openaiApiKey；插件已加载，但语义搜索和索引会在执行时失败",
    );
  }

  if (config.whisper.provider === "zhipu" && !config.whisper.zhipuApiKey) {
    warnings.push(
      "whisper.provider=zhipu 但未配置 whisper.zhipuApiKey；插件已加载，但音频转录会在执行时失败",
    );
  }

  if (config.document.chunkOverlap >= config.document.chunkSize) {
    warnings.push(
      `document.chunkOverlap (${config.document.chunkOverlap}) 必须小于 document.chunkSize (${config.document.chunkSize})；将按 0 overlap 处理`,
    );
  }

  return warnings;
}

export function collectWatcherStartupBlockers(config: PluginConfig): string[] {
  const blockers: string[] = [];

  if (config.embedding.provider === "openai" && !config.embedding.openaiApiKey) {
    blockers.push(
      "embedding.provider=openai 但未配置 embedding.openaiApiKey，后台索引已禁用",
    );
  }

  return blockers;
}
