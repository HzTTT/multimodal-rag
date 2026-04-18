/**
 * 文档切分器：把若干带 page/heading 元信息的段落文本切分成 chunk 数组。
 *
 * 算法:递归"段落(\n\n) → 句子(中英文终结符) → 硬切字符数" 三级回落，
 * 再按 chunkSize 贪心累加成 chunk，chunk 之间保留 chunkOverlap 字符重叠。
 */

import type { DocumentChunkInput } from "./types.js";

export type ChunkerSegment = {
  pageNumber: number; // 0 表示无
  heading: string; // 空串表示无
  text: string;
};

type Unit = {
  text: string;
  pageNumber: number;
  heading: string;
};

const SENTENCE_SPLIT_REGEX = /(?<=[。？！；\n.?!;])/g;

export function recursiveChunk(
  segments: ChunkerSegment[],
  chunkSize: number,
  chunkOverlap: number,
): DocumentChunkInput[] {
  const size = Math.max(100, Math.floor(chunkSize));
  const rawOverlap = Math.floor(chunkOverlap);
  const overlap =
    rawOverlap >= size ? 0 : Math.max(0, rawOverlap);

  const units = splitToUnits(segments, size);
  if (units.length === 0) {
    return [];
  }

  const chunks: DocumentChunkInput[] = [];
  let currentText = "";
  let currentPage = 0;
  let currentHeading = "";
  const separator = "\n";

  const flush = (): void => {
    const trimmed = currentText.trim();
    if (!trimmed) {
      currentText = "";
      return;
    }
    chunks.push({
      chunkIndex: chunks.length,
      pageNumber: currentPage,
      heading: currentHeading,
      chunkText: trimmed,
    });
    if (overlap > 0 && trimmed.length > overlap) {
      currentText = trimmed.slice(-overlap);
    } else {
      currentText = "";
    }
  };

  for (const unit of units) {
    if (currentText.length === 0) {
      currentText = unit.text;
      currentPage = unit.pageNumber;
      currentHeading = unit.heading;
      continue;
    }
    const candidate = currentText + separator + unit.text;
    if (candidate.length <= size) {
      currentText = candidate;
      continue;
    }
    flush();
    // overlap 之后的 currentText 已经自动作为"下一 chunk 的前缀"
    if (currentText.length === 0) {
      currentPage = unit.pageNumber;
      currentHeading = unit.heading;
      currentText = unit.text;
    } else {
      const merged = currentText + separator + unit.text;
      if (merged.length <= size) {
        currentText = merged;
      } else {
        // overlap + 单 unit 已经超过 size：说明单 unit 太大（理论上 splitToUnits 已经硬切，不会走到这里）
        // 保险起见，丢弃 overlap 开新 chunk
        currentText = unit.text;
        currentPage = unit.pageNumber;
        currentHeading = unit.heading;
      }
    }
  }

  if (currentText.length > 0) {
    flush();
  }

  return chunks.map((chunk, idx) => ({ ...chunk, chunkIndex: idx }));
}

function splitToUnits(segments: ChunkerSegment[], maxSize: number): Unit[] {
  const units: Unit[] = [];

  for (const seg of segments) {
    const text = seg.text ?? "";
    if (!text.trim()) {
      continue;
    }

    const paragraphs = text
      .split(/\n{2,}/)
      .map((p) => p.trim())
      .filter(Boolean);

    for (const para of paragraphs) {
      if (para.length <= maxSize) {
        units.push({
          text: para,
          pageNumber: seg.pageNumber,
          heading: seg.heading,
        });
        continue;
      }

      const sentences = para
        .split(SENTENCE_SPLIT_REGEX)
        .map((s) => s.trim())
        .filter(Boolean);

      for (const sentence of sentences) {
        if (sentence.length <= maxSize) {
          units.push({
            text: sentence,
            pageNumber: seg.pageNumber,
            heading: seg.heading,
          });
          continue;
        }

        // 句子还超大：按 maxSize 硬切
        for (let i = 0; i < sentence.length; i += maxSize) {
          units.push({
            text: sentence.slice(i, i + maxSize),
            pageNumber: seg.pageNumber,
            heading: seg.heading,
          });
        }
      }
    }
  }

  return units;
}
