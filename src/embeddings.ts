/**
 * 嵌入提供者实现
 */

import type { IEmbeddingProvider } from "./types.js";

/**
 * Ollama 嵌入提供者
 */
export class OllamaEmbeddingProvider implements IEmbeddingProvider {
  private dimension: number;

  constructor(
    private readonly baseUrl: string,
    private readonly model: string,
    private readonly apiKey?: string,
  ) {
    // qwen3-embedding:latest 的维度是 4096
    // qwen3-embedding:0.6b 的维度需要测试确认
    this.dimension = model.includes("0.6b") ? 2048 : 4096; // 暂定，需要实测
  }

  async embed(text: string): Promise<number[]> {
    const maxRetries = 3;
    const retryDelay = 1000;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const headers: Record<string, string> = { "Content-Type": "application/json" };
        if (this.apiKey) {
          headers["Authorization"] = `Bearer ${this.apiKey}`;
          headers["api-key"] = this.apiKey;
        }
        // 使用新版 /api/embed（兼容 Ollama ≥0.4 和 user-center 负载均衡代理）
        const response = await fetch(`${this.baseUrl}/api/embed`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            model: this.model,
            input: text,
          }),
        });

        if (!response.ok) {
          const errorText = await response.text().catch(() => response.statusText);
          if (response.status >= 500 && attempt < maxRetries) {
            console.warn(`[multimodal-rag] Ollama embedding failed (attempt ${attempt}/${maxRetries}): ${response.status} ${response.statusText}`);
            await new Promise(resolve => setTimeout(resolve, retryDelay * attempt));
            continue;
          }
          throw new Error(`Ollama embedding failed: ${response.status} ${errorText}`);
        }

        const data = await response.json();
        // 新版 /api/embed 返回 { embeddings: number[][] }
        if (data.embeddings && Array.isArray(data.embeddings) && data.embeddings.length > 0) {
          return data.embeddings[0];
        }
        // 兼容旧版 /api/embeddings 返回 { embedding: number[] }
        if (data.embedding && Array.isArray(data.embedding)) {
          return data.embedding;
        }
        throw new Error("Invalid embedding response: missing embeddings array");
      } catch (error) {
        if (attempt < maxRetries && (error as NodeJS.ErrnoException).code === "ECONNRESET") {
          console.warn(`[multimodal-rag] Ollama connection error (attempt ${attempt}/${maxRetries}): ${(error as Error).message}`);
          await new Promise(resolve => setTimeout(resolve, retryDelay * attempt));
          continue;
        }
        throw error;
      }
    }

    throw new Error(`Ollama embedding failed after ${maxRetries} attempts`);
  }

  getDimension(): number {
    return this.dimension;
  }
}

/**
 * OpenAI 嵌入提供者（备选）
 */
export class OpenAIEmbeddingProvider implements IEmbeddingProvider {
  private dimension: number;

  constructor(
    private readonly apiKey: string,
    private readonly model: string = "text-embedding-3-small",
  ) {
    // text-embedding-3-small: 1536
    // text-embedding-3-large: 3072
    this.dimension = model.includes("large") ? 3072 : 1536;
  }

  async embed(text: string): Promise<number[]> {
    const response = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        input: text,
      }),
    });

    if (!response.ok) {
      throw new Error(`OpenAI embedding failed: ${response.statusText}`);
    }

    const data = await response.json();
    return data.data[0].embedding;
  }

  getDimension(): number {
    return this.dimension;
  }
}

/**
 * 创建嵌入提供者工厂函数
 */
export function createEmbeddingProvider(config: {
  provider: "ollama" | "openai";
  ollamaBaseUrl?: string;
  ollamaModel?: string;
  ollamaApiKey?: string;
  openaiApiKey?: string;
  openaiModel?: string;
}): IEmbeddingProvider {
  if (config.provider === "ollama") {
    return new OllamaEmbeddingProvider(
      config.ollamaBaseUrl ?? "http://127.0.0.1:11434",
      config.ollamaModel ?? "qwen3-embedding:latest",
      config.ollamaApiKey,
    );
  }

  if (!config.openaiApiKey) {
    throw new Error("OpenAI API key is required when provider=openai");
  }

  return new OpenAIEmbeddingProvider(
    config.openaiApiKey,
    config.openaiModel ?? "text-embedding-3-small",
  );
}
