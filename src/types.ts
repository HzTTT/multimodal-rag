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
    visionModel: string;
    embedModel: string;
  };
  embedding: {
    provider: "ollama" | "openai";
    openaiApiKey?: string;
    openaiModel: string;
  };
  dbPath: string;
  watchDebounceMs: number;
  indexExistingOnStart: boolean;
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
