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

type VisionChatResponse = {
  code?: number | string;
  msg?: string;
  error?: string;
  message?: {
    content?: string;
  } | string;
  data?: {
    message?: {
      content?: string;
    } | string;
  };
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
};

export class AudioTranscriptionError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = "AudioTranscriptionError";
  }
}

type WhisperConfig = {
  provider: "local" | "zhipu";
  zhipuApiKey?: string;
  zhipuApiBaseUrl?: string;
  zhipuModel?: string;
  language?: string;
};

const ZHIPU_SUPPORTED_AUDIO_EXTS = new Set([".wav", ".mp3"]);
const ZHIPU_DEFAULT_API_BASE = "https://open.bigmodel.cn/api/paas/v4";
const ZHIPU_DEFAULT_MODEL = "glm-asr-2512";
const ZHIPU_MAX_AUDIO_SECONDS = 30;
const ZHIPU_SEGMENT_SECONDS = 25;

/**
 * 多模态处理器（图像: Ollama Qwen3-VL，音频: local whisper 或 GLM-ASR）
 */
export class Qwen3VLProcessor implements IMediaProcessor {
  constructor(
    private readonly baseUrl: string,
    private readonly model: string,
    private readonly apiKey?: string,
    private readonly whisperConfig?: WhisperConfig,
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

      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (this.apiKey) {
        headers["Authorization"] = `Bearer ${this.apiKey}`;
        headers["api-key"] = this.apiKey;
      }
      const response = await fetch(`${this.baseUrl}/api/chat`, {
        method: "POST",
        headers,
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

      const data = await response.json() as VisionChatResponse;
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
        throw new Error(`Qwen3-VL processing failed: code=${businessCode}${suffix}`);
      }

      const description =
        (typeof data?.message === "object" && typeof data.message?.content === "string"
          ? data.message.content
          : "") ||
        (typeof data?.data?.message === "object" && typeof data.data.message?.content === "string"
          ? data.data.message.content
          : "") ||
        (Array.isArray(data?.choices) && typeof data.choices[0]?.message?.content === "string"
          ? data.choices[0].message.content
          : "");

      if (!description) {
        if (businessMessage) {
          throw new Error(`Qwen3-VL processing failed: ${businessMessage}`);
        }
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

  async processAudio(audioPath: string): Promise<string> {
    if (this.whisperConfig?.provider === "zhipu") {
      return this.processAudioZhipu(audioPath);
    }
    return this.processAudioLocal(audioPath);
  }

  /**
   * GLM-ASR-2512 云端转录
   *
   * 限制: 文件 ≤ 25MB, 时长 ≤ 30 秒, 仅 wav/mp3（其他格式自动用 ffmpeg 转换）
   */
  private async processAudioZhipu(audioPath: string): Promise<string> {
    const apiKey = this.whisperConfig?.zhipuApiKey;
    if (!apiKey) {
      throw new AudioTranscriptionError(
        "whisper.provider=zhipu 时必须配置 whisper.zhipuApiKey",
      );
    }

    const prepared = await this.prepareAudioForZhipu(audioPath);

    try {
      const segmented = await this.prepareAudioSegmentsForZhipu(
        prepared.path,
        prepared.fileName,
      );

      try {
        const transcripts: string[] = [];
        for (const [index, segment] of segmented.segments.entries()) {
          try {
            transcripts.push(
              await this.transcribeAudioSegmentWithZhipu(segment.path, segment.fileName, apiKey),
            );
          } catch (error) {
            if (
              segmented.segments.length > 1 &&
              error instanceof AudioTranscriptionError
            ) {
              throw new AudioTranscriptionError(
                `GLM-ASR 第 ${index + 1} 段转录失败: ${error.message}`,
                error,
              );
            }
            throw error;
          }
        }

        const merged = this.mergeAudioTranscripts(transcripts);
        if (!merged) {
          throw new AudioTranscriptionError("GLM-ASR 未返回有效转录文本");
        }

        return merged;
      } finally {
        await segmented.cleanup();
      }
    } finally {
      await prepared.cleanup();
    }
  }

  private async transcribeAudioSegmentWithZhipu(
    audioPath: string,
    fileName: string,
    apiKey: string,
  ): Promise<string> {
    const audioBuffer = await readFile(audioPath);
    const ext = extname(audioPath).toLowerCase();
    const mimeType = ext === ".mp3" ? "audio/mpeg" : "audio/wav";

    const formData = new FormData();
    formData.append(
      "file",
      new Blob([audioBuffer], { type: mimeType }),
      fileName,
    );
    formData.append(
      "model",
      this.whisperConfig?.zhipuModel || ZHIPU_DEFAULT_MODEL,
    );
    formData.append("stream", "false");

    const apiBase =
      this.whisperConfig?.zhipuApiBaseUrl || ZHIPU_DEFAULT_API_BASE;
    const response = await fetch(`${apiBase}/audio/transcriptions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: formData,
    });

    if (!response.ok) {
      const detail = (await response.text().catch(() => "")).trim();
      const suffix = detail ? ` - ${detail.slice(0, 240)}` : "";
      throw new AudioTranscriptionError(
        `GLM-ASR 转录失败: HTTP ${response.status}${suffix}`,
      );
    }

    const data = (await response.json()) as { text?: string };
    const text = data.text?.trim();

    if (!text) {
      throw new AudioTranscriptionError("GLM-ASR 未返回有效转录文本");
    }
    if (AUDIO_FAILURE_PATTERN.test(text)) {
      throw new AudioTranscriptionError("GLM-ASR 返回了失败标记文本");
    }

    return text;
  }

  private mergeAudioTranscripts(transcripts: string[]): string {
    return transcripts
      .map((text) => text.replace(/\s+/g, " ").trim())
      .filter(Boolean)
      .join(" ");
  }

  private async prepareAudioSegmentsForZhipu(
    audioPath: string,
    fileName: string,
  ): Promise<{
    segments: Array<{ path: string; fileName: string }>;
    cleanup: () => Promise<void>;
  }> {
    const durationSeconds = await this.probeAudioDurationSeconds(audioPath);
    if (
      durationSeconds !== null &&
      durationSeconds <= ZHIPU_MAX_AUDIO_SECONDS
    ) {
      return {
        segments: [{ path: audioPath, fileName }],
        cleanup: async () => {},
      };
    }

    return this.splitAudioForZhipu(audioPath, fileName);
  }

  private async probeAudioDurationSeconds(audioPath: string): Promise<number | null> {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execFileAsync = promisify(execFile);

    try {
      const { stdout } = await execFileAsync(
        "ffprobe",
        [
          "-v",
          "error",
          "-show_entries",
          "format=duration",
          "-of",
          "default=noprint_wrappers=1:nokey=1",
          audioPath,
        ],
        { maxBuffer: 10 * 1024 * 1024 },
      );
      const durationSeconds = Number(stdout.trim());
      return Number.isFinite(durationSeconds) ? durationSeconds : null;
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err?.code === "ENOENT") {
        return null;
      }
      throw new AudioTranscriptionError(
        `音频时长检测失败: ${error instanceof Error ? error.message : String(error)}`,
        error,
      );
    }
  }

  private async splitAudioForZhipu(
    audioPath: string,
    fileName: string,
  ): Promise<{
    segments: Array<{ path: string; fileName: string }>;
    cleanup: () => Promise<void>;
  }> {
    const { execFile } = await import("node:child_process");
    const { mkdtemp, readdir, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { basename } = await import("node:path");
    const { promisify } = await import("node:util");
    const execFileAsync = promisify(execFile);

    const tempDir = await mkdtemp(join(tmpdir(), "zhipu-asr-segments-"));
    const baseName = fileName.replace(/\.[^.]+$/, "");
    const outputPattern = join(tempDir, `${baseName}-%03d.wav`);

    try {
      await execFileAsync(
        "ffmpeg",
        [
          "-y",
          "-v",
          "error",
          "-i",
          audioPath,
          "-f",
          "segment",
          "-segment_time",
          String(ZHIPU_SEGMENT_SECONDS),
          "-reset_timestamps",
          "1",
          "-ar",
          "16000",
          "-ac",
          "1",
          "-c:a",
          "pcm_s16le",
          outputPattern,
        ],
        { maxBuffer: 50 * 1024 * 1024 },
      );

      const segments = (await readdir(tempDir))
        .filter((entry) => entry.startsWith(`${baseName}-`) && entry.endsWith(".wav"))
        .sort()
        .map((entry) => ({
          path: join(tempDir, entry),
          fileName: basename(entry),
        }));

      if (segments.length === 0) {
        throw new AudioTranscriptionError("音频切片失败: ffmpeg 未生成任何分段");
      }

      return {
        segments,
        cleanup: async () => {
          await rm(tempDir, { recursive: true, force: true });
        },
      };
    } catch (error) {
      await rm(tempDir, { recursive: true, force: true }).catch(() => {});
      const err = error as NodeJS.ErrnoException;
      if (err?.code === "ENOENT") {
        throw new AudioTranscriptionError(
          "音频切片失败: ffmpeg not found in PATH",
          error,
        );
      }
      if (error instanceof AudioTranscriptionError) {
        throw error;
      }
      throw new AudioTranscriptionError(
        `音频切片失败: ${error instanceof Error ? error.message : String(error)}`,
        error,
      );
    }
  }

  /**
   * 将非 wav/mp3 格式转换为 wav 以适配智谱 ASR API
   */
  private async prepareAudioForZhipu(
    audioPath: string,
  ): Promise<{ path: string; fileName: string; cleanup: () => Promise<void> }> {
    const { basename } = await import("node:path");
    const ext = extname(audioPath).toLowerCase();
    if (ZHIPU_SUPPORTED_AUDIO_EXTS.has(ext)) {
      return {
        path: audioPath,
        fileName: basename(audioPath),
        cleanup: async () => {},
      };
    }

    const { mkdtemp, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execFileAsync = promisify(execFile);

    const tempDir = await mkdtemp(join(tmpdir(), "zhipu-asr-"));
    const wavName = basename(audioPath).replace(/\.[^.]+$/, ".wav");
    const convertedPath = join(tempDir, wavName);

    try {
      await execFileAsync(
        "ffmpeg",
        ["-y", "-v", "error", "-i", audioPath, "-ar", "16000", "-ac", "1", convertedPath],
        { maxBuffer: 50 * 1024 * 1024 },
      );
      return {
        path: convertedPath,
        fileName: wavName,
        cleanup: async () => {
          await rm(tempDir, { recursive: true, force: true });
        },
      };
    } catch (error) {
      await rm(tempDir, { recursive: true, force: true }).catch(() => {});
      const err = error as NodeJS.ErrnoException;
      if (err?.code === "ENOENT") {
        throw new AudioTranscriptionError(
          "音频格式转换失败: ffmpeg not found in PATH",
          error,
        );
      }
      throw new AudioTranscriptionError(
        `音频格式转换失败: ${error instanceof Error ? error.message : String(error)}`,
        error,
      );
    }
  }

  /**
   * 本地 whisper CLI 转录
   */
  private async processAudioLocal(audioPath: string): Promise<string> {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execFileAsync = promisify(execFile);
    const { mkdtemp, rm, readFile: readFileLocal } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { basename } = await import("node:path");

    const tempDir = await mkdtemp(join(tmpdir(), "whisper-"));

    try {
      const whisperBin = resolveWhisperBin();
      const language = this.whisperConfig?.language || "zh";
      const args = [
        audioPath,
        "--model",
        "base",
        "--language",
        language,
        "--output_format",
        "txt",
        "--output_dir",
        tempDir,
      ];

      const { stdout, stderr } = await execFileAsync(whisperBin, args, {
        maxBuffer: 10 * 1024 * 1024,
      });

      const baseFileName = basename(audioPath).replace(/\.[^.]+$/, "");
      const txtPath = join(tempDir, `${baseFileName}.txt`);

      let transcription: string;
      try {
        transcription = await readFileLocal(txtPath, "utf-8");
      } catch {
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
      if (error instanceof AudioTranscriptionError) throw error;
      throw new AudioTranscriptionError(
        `Whisper 转录失败: ${error instanceof Error ? error.message : String(error)}`,
        error,
      );
    } finally {
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
  ollamaApiKey?: string;
  visionModel: string;
  whisper?: WhisperConfig;
}): IMediaProcessor {
  return new Qwen3VLProcessor(
    config.ollamaBaseUrl,
    config.visionModel,
    config.ollamaApiKey,
    config.whisper,
  );
}
