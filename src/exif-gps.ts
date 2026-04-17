/**
 * 从 JPEG EXIF 的 GPS IFD (tag 0x8825) 读取经纬度。
 *
 * 与 media-timestamps.ts 共享同一套 TIFF 字节解析思路（IFD entry 12 字节结构：
 * tag(2) + type(2) + count(4) + value/offset(4)），这里只关注 GPS IFD。
 *
 * 仅支持 JPEG（PNG 原生不存 GPS）。其它格式想加就接 ffprobe 的 location 标签。
 */

import { readFile } from "node:fs/promises";
import { extname } from "node:path";

export type GpsCoordinate = {
  latitude: number; // 十进制度；南纬为负
  longitude: number; // 十进制度；西经为负
};

type Reader = {
  readUInt16: (offset: number) => number;
  readUInt32: (offset: number) => number;
};

function makeReader(buffer: Buffer, littleEndian: boolean): Reader {
  return {
    readUInt16: (offset) =>
      littleEndian ? buffer.readUInt16LE(offset) : buffer.readUInt16BE(offset),
    readUInt32: (offset) =>
      littleEndian ? buffer.readUInt32LE(offset) : buffer.readUInt32BE(offset),
  };
}

export async function readImageGps(filePath: string): Promise<GpsCoordinate | undefined> {
  const ext = extname(filePath).toLowerCase();
  if (ext !== ".jpg" && ext !== ".jpeg") {
    return undefined;
  }
  try {
    const buffer = await readFile(filePath);
    return extractJpegGps(buffer);
  } catch {
    return undefined;
  }
}

export function extractJpegGps(buffer: Buffer): GpsCoordinate | undefined {
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
      const header = buffer.toString("ascii", segmentStart, segmentStart + 6);
      if (header === "Exif\0\0") {
        const tiffStart = segmentStart + 6;
        const byteOrder = buffer.toString("ascii", tiffStart, tiffStart + 2);
        const littleEndian = byteOrder === "II";
        const bigEndian = byteOrder === "MM";
        if (!littleEndian && !bigEndian) {
          return undefined;
        }
        const reader = makeReader(buffer, littleEndian);
        const ifd0Offset = reader.readUInt32(tiffStart + 4);
        return findAndParseGpsIfd(buffer, tiffStart, ifd0Offset, reader);
      }
    }

    offset += 2 + segmentLength;
  }
  return undefined;
}

function findAndParseGpsIfd(
  buffer: Buffer,
  tiffStart: number,
  ifd0Offset: number,
  reader: Reader,
): GpsCoordinate | undefined {
  const ifd0Absolute = tiffStart + ifd0Offset;
  if (ifd0Absolute + 2 > buffer.length) {
    return undefined;
  }
  const entryCount = reader.readUInt16(ifd0Absolute);
  for (let i = 0; i < entryCount; i++) {
    const entryOffset = ifd0Absolute + 2 + i * 12;
    if (entryOffset + 12 > buffer.length) {
      break;
    }
    const tag = reader.readUInt16(entryOffset);
    if (tag === 0x8825) {
      const gpsIfdOffset = reader.readUInt32(entryOffset + 8);
      return parseGpsIfd(buffer, tiffStart, gpsIfdOffset, reader);
    }
  }
  return undefined;
}

function parseGpsIfd(
  buffer: Buffer,
  tiffStart: number,
  gpsIfdOffset: number,
  reader: Reader,
): GpsCoordinate | undefined {
  const absolute = tiffStart + gpsIfdOffset;
  if (absolute + 2 > buffer.length) {
    return undefined;
  }
  const entryCount = reader.readUInt16(absolute);
  let latRef: string | undefined;
  let lat: number | undefined;
  let lonRef: string | undefined;
  let lon: number | undefined;

  for (let i = 0; i < entryCount; i++) {
    const entryOffset = absolute + 2 + i * 12;
    if (entryOffset + 12 > buffer.length) {
      break;
    }
    const tag = reader.readUInt16(entryOffset);
    const type = reader.readUInt16(entryOffset + 2);
    const count = reader.readUInt32(entryOffset + 4);

    if (tag === 0x0001 && type === 2) {
      latRef = readAscii(buffer, tiffStart, entryOffset, reader, count);
    } else if (tag === 0x0002 && type === 5 && count === 3) {
      lat = readDegMinSec(buffer, tiffStart, entryOffset, reader);
    } else if (tag === 0x0003 && type === 2) {
      lonRef = readAscii(buffer, tiffStart, entryOffset, reader, count);
    } else if (tag === 0x0004 && type === 5 && count === 3) {
      lon = readDegMinSec(buffer, tiffStart, entryOffset, reader);
    }
  }

  if (lat === undefined || lon === undefined) {
    return undefined;
  }

  const latitude = latRef === "S" ? -lat : lat;
  const longitude = lonRef === "W" ? -lon : lon;
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    return undefined;
  }
  return { latitude, longitude };
}

function readAscii(
  buffer: Buffer,
  tiffStart: number,
  entryOffset: number,
  reader: Reader,
  count: number,
): string | undefined {
  if (count <= 0) {
    return undefined;
  }
  let dataOffset: number;
  if (count <= 4) {
    dataOffset = entryOffset + 8;
  } else {
    const rel = reader.readUInt32(entryOffset + 8);
    dataOffset = tiffStart + rel;
  }
  if (dataOffset < 0 || dataOffset + count > buffer.length) {
    return undefined;
  }
  return buffer.toString("ascii", dataOffset, dataOffset + count).replace(/\0+$/, "");
}

function readDegMinSec(
  buffer: Buffer,
  tiffStart: number,
  entryOffset: number,
  reader: Reader,
): number | undefined {
  const rel = reader.readUInt32(entryOffset + 8);
  const dataOffset = tiffStart + rel;
  if (dataOffset < 0 || dataOffset + 24 > buffer.length) {
    return undefined;
  }
  const deg = readRational(buffer, dataOffset, reader);
  const min = readRational(buffer, dataOffset + 8, reader);
  const sec = readRational(buffer, dataOffset + 16, reader);
  if (deg === undefined || min === undefined || sec === undefined) {
    return undefined;
  }
  return deg + min / 60 + sec / 3600;
}

function readRational(buffer: Buffer, offset: number, reader: Reader): number | undefined {
  const numerator = reader.readUInt32(offset);
  const denominator = reader.readUInt32(offset + 4);
  if (denominator === 0) {
    return undefined;
  }
  return numerator / denominator;
}
