/**
 * OCR 抽象：把图片 → 纯文本
 *
 * 默认实现走 Ollama 的 /api/chat，把视觉模型当 OCR 用（prompt 明确要求"仅提取文字"）。
 * 未来可以再加 PaddleOCR / RapidOCR 等 provider，不影响上层。
 */

import { readFile } from "node:fs/promises";
import type { IOcrProvider } from "./types.js";
import { OcrError } from "./types.js";

const OCR_PROMPT = [
  "你是一个 OCR 工具。请严格提取图片里的所有文字。",
  "",
  "要求:",
  "1. 仅输出图片里出现的原文，不要添加任何描述、解释、总结或猜测。",
  "2. 保持原文的阅读顺序：从上到下、从左到右。",
  "3. 分栏/多列布局时按列依次输出。",
  "4. 保留换行，段落之间用空行分隔。",
  "5. 表格逐行输出，单元格之间用制表符分隔。",
  "6. 如果图片里没有任何文字，输出空字符串，不要说明。",
].join("\n");

type OllamaChatResponse = {
  code?: number | string;
  msg?: string;
  error?: string;
  message?: { content?: string } | string;
  data?: { message?: { content?: string } | string };
  choices?: Array<{ message?: { content?: string } }>;
};

export type OllamaVlmOcrConfig = {
  baseUrl: string;
  apiKey?: string;
  model: string;
  timeoutMs?: number;
};

/**
 * 基于 Ollama VLM 的 OCR 实现
 */
export class OllamaVlmOcrProvider implements IOcrProvider {
  constructor(private readonly config: OllamaVlmOcrConfig) {}

  async extractText(imagePath: string): Promise<string> {
    const buffer = await readFile(imagePath);
    const base64 = buffer.toString("base64");

    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.config.apiKey) {
      headers["Authorization"] = `Bearer ${this.config.apiKey}`;
      headers["api-key"] = this.config.apiKey;
    }

    const controller = this.config.timeoutMs
      ? new AbortController()
      : undefined;
    const timer = controller
      ? setTimeout(() => controller.abort(), this.config.timeoutMs)
      : null;

    let response: Response;
    try {
      response = await fetch(`${this.config.baseUrl}/api/chat`, {
        method: "POST",
        headers,
        signal: controller?.signal,
        body: JSON.stringify({
          model: this.config.model,
          messages: [
            {
              role: "user",
              content: OCR_PROMPT,
              images: [base64],
            },
          ],
          stream: false,
        }),
      });
    } catch (error) {
      if (timer) clearTimeout(timer);
      throw new OcrError(
        `OCR 请求失败: ${error instanceof Error ? error.message : String(error)}`,
        error,
      );
    } finally {
      if (timer) clearTimeout(timer);
    }

    if (!response.ok) {
      const detail = (await response.text().catch(() => "")).trim();
      const suffix = detail ? `, detail=${detail.slice(0, 240)}` : "";
      throw new OcrError(`OCR HTTP ${response.status}${suffix}`);
    }

    const data = (await response.json()) as OllamaChatResponse;
    const businessCode = data?.code;
    const businessMessage =
      typeof data?.msg === "string"
        ? data.msg.trim()
        : typeof data?.error === "string"
          ? data.error.trim()
          : "";

    if (
      businessCode !== undefined &&
      businessCode !== null &&
      String(businessCode) !== "0"
    ) {
      const suffix = businessMessage ? `, msg=${businessMessage}` : "";
      throw new OcrError(`OCR business error code=${businessCode}${suffix}`);
    }

    const content =
      (typeof data?.message === "object" && typeof data.message?.content === "string"
        ? data.message.content
        : "") ||
      (typeof data?.data?.message === "object" &&
      typeof data.data.message?.content === "string"
        ? data.data.message.content
        : "") ||
      (Array.isArray(data?.choices) &&
      typeof data.choices[0]?.message?.content === "string"
        ? data.choices[0].message.content
        : "");

    return (content || "").trim();
  }
}

export function createOllamaVlmOcrProvider(
  config: OllamaVlmOcrConfig,
): IOcrProvider {
  return new OllamaVlmOcrProvider(config);
}
