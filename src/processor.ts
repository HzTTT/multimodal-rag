/**
 * 多模态处理器实现
 */

import { readFile } from "node:fs/promises";
import type { IMediaProcessor } from "./types.js";
import { resolveWhisperBin } from "./whisper-bin.js";

const AUDIO_FAILURE_PATTERN = /^[（(]\s*转录失败[:：]/;

export class AudioTranscriptionError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = "AudioTranscriptionError";
  }
}

/**
 * Qwen3-VL 图像处理器
 */
export class Qwen3VLProcessor implements IMediaProcessor {
  constructor(
    private readonly baseUrl: string,
    private readonly model: string,
  ) {}

  /**
   * 处理图像，返回详细描述
   */
  async processImage(imagePath: string): Promise<string> {
    // 读取图像并转换为 base64
    const imageBuffer = await readFile(imagePath);
    const base64Image = imageBuffer.toString("base64");

    // 构建优化的 prompt
    const prompt = `请详细描述这张图片，包含：
1. 主要场景和地点（如果能识别，例如：东方明珠、故宫、黄山等）
2. 图中的人物、物体、建筑
3. 图中出现的任何文字或标识
4. 时间线索（白天/夜晚、季节、天气等）
5. 情感或氛围

用中文回答，描述要具体详细，便于后续搜索。`;

    // 调用 Ollama API
    const response = await fetch(`${this.baseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: this.model,
        messages: [
          {
            role: "user",
            content: prompt,
            images: [base64Image],
          },
        ],
        stream: false,
      }),
    });

    if (!response.ok) {
      throw new Error(
        `Qwen3-VL processing failed: ${response.statusText}`,
      );
    }

    const data = await response.json();
    const description = data.message?.content || "";

    if (!description) {
      throw new Error("Empty description from Qwen3-VL");
    }

    return description.trim();
  }

  /**
   * 处理音频（使用 whisper CLI）
   */
  async processAudio(audioPath: string): Promise<string> {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execFileAsync = promisify(execFile);
    const { mkdtemp, rm, readFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join, basename } = await import("node:path");

    // 创建临时目录存放转录结果
    const tempDir = await mkdtemp(join(tmpdir(), "whisper-"));

    try {
      const whisperBin = resolveWhisperBin();
      const args = [
        audioPath,
        "--model",
        "base",
        "--language",
        "zh",
        "--output_format",
        "txt",
        "--output_dir",
        tempDir,
      ];

      const { stdout, stderr } = await execFileAsync(whisperBin, args, {
        maxBuffer: 10 * 1024 * 1024,
      });

      // 读取转录结果（whisper 会创建 .txt 文件）
      const baseFileName = basename(audioPath).replace(/\.[^.]+$/, "");
      const txtPath = join(tempDir, `${baseFileName}.txt`);

      let transcription: string;
      try {
        transcription = await readFile(txtPath, "utf-8");
      } catch {
        // 如果读取失败，尝试从 stdout 获取
        transcription = `${stdout || ""}\n${stderr || ""}`.trim();
      }

      const normalized = transcription.trim();
      if (!normalized) {
        throw new AudioTranscriptionError("Whisper 未输出有效转录文本");
      }
      if (AUDIO_FAILURE_PATTERN.test(normalized)) {
        throw new AudioTranscriptionError("Whisper 返回了失败标记文本");
      }

      return normalized;
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err?.code === "ENOENT") {
        throw new AudioTranscriptionError(
          "找不到 whisper 命令，请先安装 whisper 并确保 ffmpeg 可用",
          error,
        );
      }
      throw new AudioTranscriptionError(
        `Whisper 转录失败: ${error instanceof Error ? error.message : String(error)}`,
        error,
      );
    } finally {
      // 清理临时目录
      try {
        await rm(tempDir, { recursive: true, force: true });
      } catch {}
    }
  }
}

/**
 * 创建媒体处理器工厂函数
 */
export function createMediaProcessor(config: {
  ollamaBaseUrl: string;
  visionModel: string;
}): IMediaProcessor {
  return new Qwen3VLProcessor(config.ollamaBaseUrl, config.visionModel);
}
