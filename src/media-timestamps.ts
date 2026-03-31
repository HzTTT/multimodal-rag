import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { promisify } from "node:util";
import type { MediaType } from "./types.js";

type FileTimeSnapshot = {
  birthtimeMs: number;
  mtimeMs: number;
};

type TimestampResolverDeps = {
  readFile?: typeof readFile;
  probeTags?: (filePath: string) => Promise<Record<string, string>>;
};

const JPEG_CAPTURE_TAGS = new Set([0x9003, 0x9004, 0x0132]);
const FFPROBE_CAPTURE_KEYS = [
  "creation_time",
  "date_time_original",
  "datetimeoriginal",
  "datetime_original",
  "date",
  "creationdate",
  "com.apple.quicktime.creationdate",
  "date:create",
];

function readUInt16(buffer: Buffer, offset: number, littleEndian: boolean): number {
  return littleEndian ? buffer.readUInt16LE(offset) : buffer.readUInt16BE(offset);
}

function readUInt32(buffer: Buffer, offset: number, littleEndian: boolean): number {
  return littleEndian ? buffer.readUInt32LE(offset) : buffer.readUInt32BE(offset);
}

export function parseExifDateString(value: string): number | undefined {
  const raw = value.trim().replace(/\0+$/, "");
  const exifMatch = raw.match(
    /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/,
  );
  if (exifMatch) {
    const [, year, month, day, hour, minute, second] = exifMatch;
    return new Date(
      Number(year),
      Number(month) - 1,
      Number(day),
      Number(hour),
      Number(minute),
      Number(second),
    ).getTime();
  }

  const parsed = Date.parse(raw);
  if (Number.isFinite(parsed)) {
    return parsed;
  }

  return undefined;
}

function readAsciiValue(
  buffer: Buffer,
  tiffStart: number,
  entryOffset: number,
  littleEndian: boolean,
  count: number,
): string | undefined {
  if (count <= 0) {
    return undefined;
  }

  let dataOffset: number;
  if (count <= 4) {
    dataOffset = entryOffset + 8;
  } else {
    const relativeOffset = readUInt32(buffer, entryOffset + 8, littleEndian);
    dataOffset = tiffStart + relativeOffset;
  }

  if (dataOffset < 0 || dataOffset + count > buffer.length) {
    return undefined;
  }

  return buffer.toString("ascii", dataOffset, dataOffset + count).replace(/\0+$/, "");
}

function parseJpegExifAt(
  buffer: Buffer,
  tiffStart: number,
  ifdOffset: number,
  littleEndian: boolean,
  visited: Set<number>,
): number | undefined {
  if (visited.has(ifdOffset)) {
    return undefined;
  }
  visited.add(ifdOffset);

  const absoluteIfdOffset = tiffStart + ifdOffset;
  if (absoluteIfdOffset < 0 || absoluteIfdOffset + 2 > buffer.length) {
    return undefined;
  }

  const entryCount = readUInt16(buffer, absoluteIfdOffset, littleEndian);
  let exifSubIfdOffset: number | undefined;

  for (let i = 0; i < entryCount; i++) {
    const entryOffset = absoluteIfdOffset + 2 + i * 12;
    if (entryOffset + 12 > buffer.length) {
      return undefined;
    }

    const tag = readUInt16(buffer, entryOffset, littleEndian);
    const type = readUInt16(buffer, entryOffset + 2, littleEndian);
    const count = readUInt32(buffer, entryOffset + 4, littleEndian);

    if (JPEG_CAPTURE_TAGS.has(tag) && type === 2) {
      const asciiValue = readAsciiValue(buffer, tiffStart, entryOffset, littleEndian, count);
      if (!asciiValue) {
        continue;
      }

      const parsed = parseExifDateString(asciiValue);
      if (parsed !== undefined) {
        return parsed;
      }
    }

    if (tag === 0x8769) {
      exifSubIfdOffset = readUInt32(buffer, entryOffset + 8, littleEndian);
    }
  }

  if (exifSubIfdOffset !== undefined) {
    return parseJpegExifAt(buffer, tiffStart, exifSubIfdOffset, littleEndian, visited);
  }

  return undefined;
}

function extractJpegCapturedAt(buffer: Buffer): number | undefined {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) {
    return undefined;
  }

  let offset = 2;
  while (offset + 4 <= buffer.length) {
    if (buffer[offset] !== 0xff) {
      break;
    }

    const marker = buffer[offset + 1];
    if (marker === 0xd9 || marker === 0xda) {
      break;
    }

    const segmentLength = buffer.readUInt16BE(offset + 2);
    if (segmentLength < 2 || offset + 2 + segmentLength > buffer.length) {
      break;
    }

    if (marker === 0xe1) {
      const segmentStart = offset + 4;
      const exifHeader = buffer.toString("ascii", segmentStart, segmentStart + 6);
      if (exifHeader === "Exif\0\0") {
        const tiffStart = segmentStart + 6;
        const byteOrder = buffer.toString("ascii", tiffStart, tiffStart + 2);
        const littleEndian = byteOrder === "II";
        const bigEndian = byteOrder === "MM";
        if (!littleEndian && !bigEndian) {
          return undefined;
        }

        const ifdOffset = readUInt32(buffer, tiffStart + 4, littleEndian);
        return parseJpegExifAt(buffer, tiffStart, ifdOffset, littleEndian, new Set());
      }
    }

    offset += 2 + segmentLength;
  }

  return undefined;
}

function extractPngCapturedAt(buffer: Buffer): number | undefined {
  const signature = "89504e470d0a1a0a";
  if (buffer.length < 8 || buffer.subarray(0, 8).toString("hex") !== signature) {
    return undefined;
  }

  let offset = 8;
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    const dataOffset = offset + 8;

    if (type === "tIME" && length === 7 && dataOffset + 7 <= buffer.length) {
      const year = buffer.readUInt16BE(dataOffset);
      const month = buffer[dataOffset + 2];
      const day = buffer[dataOffset + 3];
      const hour = buffer[dataOffset + 4];
      const minute = buffer[dataOffset + 5];
      const second = buffer[dataOffset + 6];
      return Date.UTC(year, month - 1, day, hour, minute, second);
    }

    offset = dataOffset + length + 4;
  }

  return undefined;
}

export function extractImageCapturedAt(buffer: Buffer, extension: string): number | undefined {
  const normalizedExt = extension.toLowerCase();
  if (normalizedExt === ".jpg" || normalizedExt === ".jpeg") {
    return extractJpegCapturedAt(buffer);
  }
  if (normalizedExt === ".png") {
    return extractPngCapturedAt(buffer);
  }
  return undefined;
}

export function extractTimestampFromFfprobeTags(tags: Record<string, string>): number | undefined {
  const lowered = new Map(
    Object.entries(tags).map(([key, value]) => [key.toLowerCase(), String(value)]),
  );

  for (const key of FFPROBE_CAPTURE_KEYS) {
    const value = lowered.get(key);
    if (!value) {
      continue;
    }

    const parsed = parseExifDateString(value);
    if (parsed !== undefined) {
      return parsed;
    }
  }

  return undefined;
}

async function probeTagsWithFfprobe(filePath: string): Promise<Record<string, string>> {
  const execFileAsync = promisify(execFile);
  const { stdout } = await execFileAsync(
    "ffprobe",
    [
      "-v",
      "error",
      "-print_format",
      "json",
      "-show_entries",
      "format_tags:stream_tags",
      filePath,
    ],
    { maxBuffer: 10 * 1024 * 1024 },
  );

  const parsed = JSON.parse(stdout) as {
    format?: { tags?: Record<string, string> };
    streams?: Array<{ tags?: Record<string, string> }>;
  };

  const mergedTags: Record<string, string> = {
    ...(parsed.format?.tags || {}),
  };

  for (const stream of parsed.streams || []) {
    Object.assign(mergedTags, stream.tags || {});
  }

  return mergedTags;
}

export async function resolveMediaCreatedAt(
  filePath: string,
  fileType: MediaType,
  stats: FileTimeSnapshot,
  deps: TimestampResolverDeps = {},
): Promise<number> {
  const readFileFn = deps.readFile ?? readFile;
  const probeTags = deps.probeTags ?? probeTagsWithFfprobe;

  if (fileType === "image") {
    try {
      const imageBuffer = await readFileFn(filePath);
      const capturedAt = extractImageCapturedAt(imageBuffer, extname(filePath));
      if (capturedAt !== undefined) {
        return capturedAt;
      }
    } catch {}
  }

  try {
    const tags = await probeTags(filePath);
    const capturedAt = extractTimestampFromFfprobeTags(tags);
    if (capturedAt !== undefined) {
      return capturedAt;
    }
  } catch {}

  if (Number.isFinite(stats.birthtimeMs) && stats.birthtimeMs > 0) {
    return stats.birthtimeMs;
  }

  return stats.mtimeMs;
}
