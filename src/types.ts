/**
 * 多模态 RAG 插件类型定义
 */

export type MediaType = "image" | "audio" | "document";

/**
 * 媒体条目（image/audio，存储在 LanceDB media 表中）
 *
 * 注：document 类型使用 DocChunkEntry 存在独立的 doc_chunks 表里，
 * 每个文档会被拆分成若干 chunk，分别存成多行。
 */
export type MediaEntry = {
  id: string;
  filePath: string;
  fileName: string;
  fileType: Extract<MediaType, "image" | "audio">;
  description: string;
  vector: number[];
  fileHash: string;
  fileSize: number;
  fileCreatedAt: number;
  fileModifiedAt: number;
  indexedAt: number;
};

/**
 * 文档 chunk 条目（document，存储在 LanceDB doc_chunks 表中）
 *
 * 语义：一个文档文件 → N 条 chunk，通过 docId 聚合。
 * 文件路径/hash/时间冗余存在每条 chunk 上，方便路径过滤与自愈。
 */
export type DocChunkEntry = {
  id: string; // UUID，单行主键
  docId: string; // 同一文档的 chunks 共享（当前等于文件的 sha256）
  filePath: string;
  fileName: string;
  fileExt: string; // ".pdf" / ".docx" / ...
  chunkIndex: number; // 0-based
  totalChunks: number; // 文档总段数（冗余，便于聚合展示）
  pageNumber: number; // PDF 页码（1-based），非 PDF 用 0
  heading: string; // 所属标题链（空串表示未知）
  chunkText: string;
  vector: number[];
  fileHash: string;
  fileSize: number;
  fileCreatedAt: number;
  fileModifiedAt: number;
  indexedAt: number;
};

/**
 * 搜索结果（image/audio）
 */
export type MediaSearchResult = {
  entry: Omit<MediaEntry, "vector">;
  score: number;
};

/**
 * 搜索结果（document chunk 级）
 */
export type DocChunkSearchResult = {
  chunk: Omit<DocChunkEntry, "vector">;
  score: number;
};

/**
 * 文档摘要（按 docId 聚合后的展示单位）
 */
export type DocSummary = {
  docId: string;
  filePath: string;
  fileName: string;
  fileExt: string;
  totalChunks: number;
  fileSize: number;
  fileCreatedAt: number;
  fileModifiedAt: number;
  indexedAt: number;
  snippet: string; // 最高分 chunk 的摘录（或第 1 段）
  topPageNumber: number; // 最高分 chunk 的页码，0 代表无
  topHeading: string;
};

/**
 * 统一搜索结果：image/audio 与 document 放在同一个列表里
 */
export type UnifiedSearchResult =
  | {
      kind: "media";
      entry: Omit<MediaEntry, "vector">;
      score: number;
    }
  | {
      kind: "document";
      doc: DocSummary;
      bestChunk: Omit<DocChunkEntry, "vector">;
      score: number;
    };

/**
 * 通知配置
 */
export type NotificationConfig = {
  enabled: boolean;
  agentId?: string;
  quietWindowMs: number;
  batchTimeoutMs: number;
  channel?: string;
  to?: string;
  targets: Array<{
    channel: string;
    to: string;
    accountId?: string;
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
 * 文档 chunk 的原始输入（parser + chunker 产出，尚未 embed）
 */
export type DocumentChunkInput = {
  chunkIndex: number;
  pageNumber: number; // 0 表示无
  heading: string;
  chunkText: string;
};

/**
 * 文档处理结果：processor.processDocument 的返回
 */
export type DocumentProcessResult = {
  chunks: DocumentChunkInput[];
  totalChunks: number;
};

/**
 * 文档解析配置（一次解析用的参数快照）
 */
export type DocumentParseContext = {
  filePath: string;
  fileExt: string; // 小写，带点
  ocrTriggerChars: number;
  chunkSize: number;
  chunkOverlap: number;
  ocr?: IOcrProvider; // 可选：用于扫描件 PDF 的回落
};

/**
 * 插件配置
 */
export type PluginConfig = {
  watchPaths: string[];
  fileTypes: {
    image: string[];
    audio: string[];
    document: string[];
  };
  ollama: {
    baseUrl: string;
    apiKey?: string;
    visionModel: string;
    embedModel: string;
    ocrModel?: string; // 空则复用 visionModel
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
  document: {
    chunkSize: number; // 目标字符数
    chunkOverlap: number; // 字符数
    ocrTriggerChars: number; // PDF 一页字数 < 该值则触发 OCR
    ocrEnabled: boolean; // 全局开关
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
  processImage(imagePath: string): Promise<string>;
  processAudio(audioPath: string): Promise<string>;
  processDocument(filePath: string): Promise<DocumentProcessResult>;
}

/**
 * OCR 提供者接口（用于扫描件 PDF / 图像里的文字提取）
 */
export interface IOcrProvider {
  /** 对单张图片做"仅提取文字"的 OCR；失败应抛 OcrError */
  extractText(imagePath: string): Promise<string>;
}

export class OcrError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = "OcrError";
  }
}
