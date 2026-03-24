/**
 * 多模态 RAG 插件类型定义
 */

export type MediaType = "image" | "audio";

/**
 * 媒体条目（存储在 LanceDB 中）
 */
export type MediaEntry = {
  id: string; // UUID
  filePath: string; // 原始文件路径
  fileName: string; // 文件名
  fileType: MediaType; // 媒体类型
  description: string; // 图像描述或音频转录
  vector: number[]; // 嵌入向量
  fileHash: string; // 文件 hash（用于去重和变更检测）
  fileSize: number; // 文件大小（字节）
  // 时间信息
  fileCreatedAt: number; // 文件创建时间 (Unix ms)
  fileModifiedAt: number; // 文件修改时间 (Unix ms)
  indexedAt: number; // 索引时间 (Unix ms)
};

/**
 * 搜索结果
 */
export type MediaSearchResult = {
  entry: Omit<MediaEntry, "vector">; // 不返回向量数据
  score: number; // 相似度分数 (0-1)
};

/**
 * 通知配置
 */
export type NotificationConfig = {
  enabled: boolean; // 是否启用通知，默认 false
  agentId?: string; // 用于触发通知回复的 agent，默认 main（或配置中的默认 agent）
  quietWindowMs: number; // 静默窗口（毫秒），默认 30000
  batchTimeoutMs: number; // 批次最大超时（毫秒），默认 600000
  channel?: string; // agent 回复投递渠道，默认 "last"
  to?: string; // agent 回复投递目标（可选）
  targets: Array<{
    channel: string; // 回复目标渠道（agent --reply-channel）
    to: string; // 回复目标（agent --reply-to）
    accountId?: string; // 可选账号（agent --reply-account）
  }>;
};

/**
 * 索引事件回调接口（用于 watcher -> notifier 通信）
 */
export type IndexEventCallbacks = {
  onFileQueued: (filePath: string) => void;
  onFileIndexed: (filePath: string, fileType: MediaType) => void;
  onFileSkipped?: (filePath: string, fileType: MediaType, reason?: string) => void;
  onFileFailed: (filePath: string, error: string) => void;
  dispose?: () => void;
};

/**
 * 插件配置
 */
export type PluginConfig = {
  watchPaths: string[];
  fileTypes: {
    image: string[];
    audio: string[];
  };
  ollama: {
    baseUrl: string;
    apiKey?: string;
    visionModel: string;
    embedModel: string;
  };
  embedding: {
    provider: "ollama" | "openai";
    openaiApiKey?: string;
    openaiModel: string;
  };
  whisper: {
    provider: "local" | "zhipu";
    zhipuApiKey?: string;
    zhipuApiBaseUrl?: string;
    zhipuModel: string;
    language: string;
  };
  dbPath: string;
  watchDebounceMs: number;
  indexExistingOnStart: boolean;
  notifications: NotificationConfig;
};

/**
 * 嵌入提供者接口
 */
export interface IEmbeddingProvider {
  embed(text: string): Promise<number[]>;
  getDimension(): number;
}

/**
 * 媒体处理器接口
 */
export interface IMediaProcessor {
  processImage(imagePath: string): Promise<string>; // 返回描述
  processAudio(audioPath: string): Promise<string>; // 返回转录
}
