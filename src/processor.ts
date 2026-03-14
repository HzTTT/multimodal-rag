/**
 * 多模态处理器实现
 */

import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import type { IMediaProcessor } from "./types.js";
import { resolveWhisperBin } from "./whisper-bin.js";

const AUDIO_FAILURE_PATTERN = /^[（(]\s*转录失败[:：]/;

type HeicTile = {
  streamIndex: number;
  x: number;
  y: number;
};

type HeicTileGrid = {
  width: number;
  height: number;
  tiles: HeicTile[];
};

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
    const prepared = await this.prepareImageForVision(imagePath);

    try {
      // 读取图像并转换为 base64
      const imageBuffer = await readFile(prepared.path);
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
        const detail = (await response.text().catch(() => "")).trim();
        const suffix = detail ? `, detail=${detail.slice(0, 240)}` : "";
        throw new Error(`Qwen3-VL processing failed: HTTP ${response.status}${suffix}`);
      }

      const data = await response.json();
      const description = data.message?.content || "";

      if (!description) {
        throw new Error("Empty description from Qwen3-VL");
      }

      return description.trim();
    } finally {
      await prepared.cleanup();
    }
  }

  private async prepareImageForVision(
    imagePath: string,
  ): Promise<{ path: string; cleanup: () => Promise<void> }> {
    const ext = extname(imagePath).toLowerCase();
    if (ext !== ".heic" && ext !== ".heif") {
      return { path: imagePath, cleanup: async () => {} };
    }

    const { mkdtemp, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execFileAsync = promisify(execFile);

    const tempDir = await mkdtemp(join(tmpdir(), "multimodal-rag-image-"));
    const convertedPath = join(tempDir, "converted.jpg");

    try {
      const tileGrid = await this.readHeicTileGrid(imagePath, execFileAsync);
      if (tileGrid && tileGrid.tiles.length > 0) {
        const labels = tileGrid.tiles.map((t) => `[0:v:${t.streamIndex}]`).join("");
        const layout = tileGrid.tiles.map((t) => `${t.x}_${t.y}`).join("|");
        const filter = `${labels}xstack=inputs=${tileGrid.tiles.length}:layout=${layout}:fill=black,crop=${tileGrid.width}:${tileGrid.height}:0:0[out]`;
        await execFileAsync(
          "ffmpeg",
          [
            "-y",
            "-v",
            "error",
            "-i",
            imagePath,
            "-filter_complex",
            filter,
            "-map",
            "[out]",
            "-frames:v",
            "1",
            "-update",
            "1",
            convertedPath,
          ],
          { maxBuffer: 10 * 1024 * 1024 },
        );
      } else {
        await execFileAsync(
          "ffmpeg",
          ["-y", "-v", "error", "-i", imagePath, "-frames:v", "1", "-update", "1", convertedPath],
          { maxBuffer: 10 * 1024 * 1024 },
        );
      }
      return {
        path: convertedPath,
        cleanup: async () => {
          await rm(tempDir, { recursive: true, force: true });
        },
      };
    } catch (error) {
      await rm(tempDir, { recursive: true, force: true }).catch(() => {});
      const err = error as NodeJS.ErrnoException;
      if (err?.code === "ENOENT") {
        throw new Error("HEIC/HEIF conversion failed: ffmpeg not found in PATH");
      }
      throw new Error(
        `HEIC/HEIF conversion failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async readHeicTileGrid(
    imagePath: string,
    execFileAsync: (
      file: string,
      args: string[],
      options: { maxBuffer: number },
    ) => Promise<{ stdout: string; stderr: string }>,
  ): Promise<HeicTileGrid | null> {
    try {
      const { stdout } = await execFileAsync(
        "ffprobe",
        [
          "-v",
          "error",
          "-print_format",
          "json",
          "-show_stream_groups",
          imagePath,
        ],
        { maxBuffer: 10 * 1024 * 1024 },
      );
      const parsed = JSON.parse(stdout) as {
        stream_groups?: Array<{
          type?: string;
          components?: Array<{
            width?: number;
            height?: number;
            subcomponents?: Array<{
              stream_index?: number;
              tile_horizontal_offset?: number;
              tile_vertical_offset?: number;
            }>;
          }>;
        }>;
      };

      const groups = Array.isArray(parsed.stream_groups) ? parsed.stream_groups : [];
      const tileGroup = groups.find((g) => String(g.type || "").toLowerCase().includes("tile grid"));
      const component = tileGroup?.components?.[0];
      if (!component) {
        return null;
      }

      const width = Number(component.width);
      const height = Number(component.height);
      if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
        return null;
      }

      const tiles = (component.subcomponents || [])
        .map((s) => ({
          streamIndex: Number(s.stream_index),
          x: Number(s.tile_horizontal_offset),
          y: Number(s.tile_vertical_offset),
        }))
        .filter((s) =>
          Number.isFinite(s.streamIndex) &&
          Number.isFinite(s.x) &&
          Number.isFinite(s.y) &&
          s.streamIndex >= 0 &&
          s.x >= 0 &&
          s.y >= 0,
        )
        .sort((a, b) => (a.y - b.y) || (a.x - b.x));

      if (tiles.length === 0) {
        return null;
      }

      return { width, height, tiles };
    } catch {
      // ffprobe 失败时回退到普通单流转换
      return null;
    }
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
