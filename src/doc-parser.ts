/**
 * 文档解析器：按扩展名分派到 PDF / Office / 纯文本解析路径。
 * 输出统一为 ChunkerSegment[]，交给 doc-chunker 切分。
 */

import { readFile, mkdtemp, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

import type { ChunkerSegment } from "./doc-chunker.js";
import type { DocumentParseContext, IOcrProvider } from "./types.js";

const execFileAsync = promisify(execFile);

export class DocumentParseError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = "DocumentParseError";
  }
}

export async function parseDocument(
  ctx: DocumentParseContext,
): Promise<ChunkerSegment[]> {
  const ext = ctx.fileExt;
  try {
    switch (ext) {
      case ".pdf":
        return await parsePdf(ctx);
      case ".docx":
      case ".xlsx":
      case ".pptx":
        return await parseOffice(ctx);
      case ".txt":
      case ".md":
      case ".markdown":
        return await parsePlainText(ctx, false);
      case ".html":
      case ".htm":
        return await parsePlainText(ctx, true);
      default:
        throw new DocumentParseError(`Unsupported document extension: ${ext}`);
    }
  } catch (error) {
    if (error instanceof DocumentParseError) {
      throw error;
    }
    throw new DocumentParseError(
      `Document parse failed (${ext}): ${error instanceof Error ? error.message : String(error)}`,
      error,
    );
  }
}

// ============================================================
// PDF
// ============================================================

let pdfjsPromise: Promise<any> | null = null;
function loadPdfjs(): Promise<any> {
  if (!pdfjsPromise) {
    pdfjsPromise = import("pdfjs-dist/legacy/build/pdf.mjs").catch((error) => {
      pdfjsPromise = null;
      throw new DocumentParseError(
        `PDF parse failed: cannot load pdfjs-dist (${error instanceof Error ? error.message : String(error)})`,
        error,
      );
    });
  }
  return pdfjsPromise;
}

const requireFromHere = createRequire(import.meta.url);

let pdfjsAssetsCache: { cMapUrl: string; standardFontDataUrl: string } | null = null;
function resolvePdfjsAssets(): { cMapUrl: string; standardFontDataUrl: string } {
  if (!pdfjsAssetsCache) {
    const root = dirname(requireFromHere.resolve("pdfjs-dist/package.json"));
    pdfjsAssetsCache = {
      cMapUrl: pathToFileURL(join(root, "cmaps") + "/").href,
      standardFontDataUrl: pathToFileURL(join(root, "standard_fonts") + "/").href,
    };
  }
  return pdfjsAssetsCache;
}

async function parsePdf(ctx: DocumentParseContext): Promise<ChunkerSegment[]> {
  const pdfjsLib = await loadPdfjs();
  const buffer = await readFile(ctx.filePath);
  const data = new Uint8Array(buffer);

  const { cMapUrl, standardFontDataUrl } = resolvePdfjsAssets();

  const loadingTask = pdfjsLib.getDocument({
    data,
    cMapUrl,
    cMapPacked: true,
    standardFontDataUrl,
    disableFontFace: true,
    isEvalSupported: false,
    useSystemFonts: false,
  });

  let doc: any;
  try {
    doc = await loadingTask.promise;
  } catch (error) {
    throw new DocumentParseError(
      `PDF parse failed: ${error instanceof Error ? error.message : String(error)}`,
      error,
    );
  }

  const segments: ChunkerSegment[] = [];

  try {
    const numPages = doc.numPages as number;
    for (let pageNum = 1; pageNum <= numPages; pageNum++) {
      const page = await doc.getPage(pageNum);
      let text = "";
      try {
        const content = await page.getTextContent();
        const raw = (content.items as Array<{ str?: string }>)
          .map((item) => item.str ?? "")
          .join(" ");
        text = raw.replace(/\s+/g, " ").trim();
      } finally {
        try {
          page.cleanup?.();
        } catch {
          // 清理错误忽略
        }
      }

      if (text.length >= ctx.ocrTriggerChars) {
        segments.push({ pageNumber: pageNum, heading: "", text });
        continue;
      }

      if (!ctx.ocr) {
        if (text) {
          segments.push({ pageNumber: pageNum, heading: "", text });
        }
        continue;
      }

      // OCR 回落
      const ocrText = await renderPdfPageAndOcr(ctx.filePath, pageNum, ctx.ocr);
      const merged = [text, ocrText].map((s) => s.trim()).filter(Boolean).join(" ");
      if (merged) {
        segments.push({ pageNumber: pageNum, heading: "", text: merged });
      }
    }
  } finally {
    try {
      await doc.destroy?.();
    } catch {
      // 销毁错误忽略
    }
  }

  return segments;
}

async function renderPdfPageAndOcr(
  pdfPath: string,
  pageNum: number,
  ocr: IOcrProvider,
): Promise<string> {
  const tempDir = await mkdtemp(join(tmpdir(), "multimodal-rag-pdf-"));
  try {
    const prefix = join(tempDir, "page");
    try {
      await execFileAsync(
        "pdftoppm",
        [
          "-png",
          "-r",
          "200",
          "-f",
          String(pageNum),
          "-l",
          String(pageNum),
          pdfPath,
          prefix,
        ],
        { maxBuffer: 50 * 1024 * 1024 },
      );
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err?.code === "ENOENT") {
        throw new DocumentParseError(
          "PDF OCR 失败: pdftoppm not found in PATH (请安装 poppler-utils)",
          error,
        );
      }
      throw new DocumentParseError(
        `PDF 渲染失败: ${error instanceof Error ? error.message : String(error)}`,
        error,
      );
    }

    const files = await readdir(tempDir);
    const pngFile = files.find((f) => f.endsWith(".png"));
    if (!pngFile) {
      throw new DocumentParseError(
        `PDF 渲染失败: pdftoppm 未生成 PNG (page ${pageNum})`,
      );
    }

    try {
      return await ocr.extractText(join(tempDir, pngFile));
    } catch (error) {
      // OCR 失败不应该整个文档失败，返回空字符串让上层决定
      return "";
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

// ============================================================
// Office（docx / xlsx / pptx）
// ============================================================

let officeparserPromise: Promise<any> | null = null;
function loadOfficeparser(): Promise<any> {
  if (!officeparserPromise) {
    officeparserPromise = import("officeparser").catch((error) => {
      officeparserPromise = null;
      throw new DocumentParseError(
        `Office parse failed: cannot load officeparser (${error instanceof Error ? error.message : String(error)})`,
        error,
      );
    });
  }
  return officeparserPromise;
}

async function parseOffice(ctx: DocumentParseContext): Promise<ChunkerSegment[]> {
  const mod = await loadOfficeparser();
  const parseAsync: ((path: string) => Promise<string>) | undefined =
    mod?.parseOfficeAsync || mod?.default?.parseOfficeAsync;
  if (typeof parseAsync !== "function") {
    throw new DocumentParseError(
      "Office parse failed: officeparser 未暴露 parseOfficeAsync",
    );
  }

  let text: string;
  try {
    text = await parseAsync(ctx.filePath);
  } catch (error) {
    throw new DocumentParseError(
      `Office parse failed: ${error instanceof Error ? error.message : String(error)}`,
      error,
    );
  }

  const normalized = (text || "").trim();
  if (!normalized) {
    return [];
  }
  return [{ pageNumber: 0, heading: "", text: normalized }];
}

// ============================================================
// 纯文本 / HTML
// ============================================================

async function parsePlainText(
  ctx: DocumentParseContext,
  isHtml: boolean,
): Promise<ChunkerSegment[]> {
  const buffer = await readFile(ctx.filePath);
  const raw = buffer.toString("utf-8");
  const text = isHtml ? stripHtml(raw) : raw;
  const normalized = text.trim();
  if (!normalized) {
    return [];
  }
  return [{ pageNumber: 0, heading: "", text: normalized }];
}

function stripHtml(input: string): string {
  return input
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|h[1-6]|li|tr)\s*>/gi, "\n\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
