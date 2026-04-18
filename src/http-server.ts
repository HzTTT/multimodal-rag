/**
 * 本地 HTTP 接口：
 * - POST /get_file_info  入参 ["path1","path2"]，返回 [{path,time,location,kind,contentType,size,fileName,desc}]
 * - GET  /search_file?q=<keyword>  返回命中文件的绝对路径数组
 *
 * 复用插件运行时的 storage + embeddings，不自己建 DB 连接。
 */

import { stat } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { homedir } from "node:os";
import { basename, extname, resolve as resolvePath } from "node:path";
import { readImageGps, type GpsCoordinate } from "./exif-gps.js";
import type { MediaStorage } from "./storage.js";
import type { IEmbeddingProvider, MediaType } from "./types.js";
import type { MediaWatcher } from "./watcher.js";

export type HttpServerOptions = {
  host: string;
  port: number;
  storage: MediaStorage;
  embeddings: IEmbeddingProvider;
  /** 可选：当 /get_file_info 命中未索引文件时，可以用 watcher 同步触发索引（见 resolveUnindexedDescription） */
  watcher?: MediaWatcher;
  /** 搜索返回条数上限（默认 20） */
  searchLimit?: number;
  /** 搜索最低匹配分数（0-1，默认 0.25，与 media_search 工具保持一致） */
  searchMinScore?: number;
};

type FileInfoResponse = {
  path: string;
  time: string;
  location: string;
  kind: string;
  contentType: string;
  size: number;
  fileName: string;
  desc: string;
};

type FileInfoError = {
  path: string;
  error: string;
};

const IMAGE_EXTS = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp", ".heic", ".heif", ".bmp"]);
const AUDIO_EXTS = new Set([".mp3", ".wav", ".m4a", ".aac", ".ogg", ".flac", ".opus"]);
const DOC_EXTS = new Set([
  ".pdf",
  ".docx",
  ".xlsx",
  ".pptx",
  ".txt",
  ".md",
  ".markdown",
  ".html",
  ".htm",
]);

const MIME_MAP: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".heic": "image/heic",
  ".heif": "image/heif",
  ".bmp": "image/bmp",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".ogg": "audio/ogg",
  ".flac": "audio/flac",
  ".opus": "audio/opus",
  ".pdf": "application/pdf",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".markdown": "text/markdown",
  ".html": "text/html",
  ".htm": "text/html",
};

function expandPath(p: string): string {
  if (p === "~") {
    return homedir();
  }
  if (p.startsWith("~/")) {
    return resolvePath(homedir(), p.slice(2));
  }
  return p;
}

function formatTime(ts: number): string {
  if (!Number.isFinite(ts) || ts <= 0) {
    return "";
  }
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function detectKind(ext: string): MediaType | "other" {
  const e = ext.toLowerCase();
  if (IMAGE_EXTS.has(e)) {
    return "image";
  }
  if (AUDIO_EXTS.has(e)) {
    return "audio";
  }
  if (DOC_EXTS.has(e)) {
    return "document";
  }
  return "other";
}

function contentTypeOf(ext: string): string {
  return MIME_MAP[ext.toLowerCase()] ?? "application/octet-stream";
}

/**
 * 反向地理编码：把 lat/lon 转成「国家/城市」人类可读地名。
 *
 * 用 Nominatim（OpenStreetMap 公共 API）：免费、无需 API key、全球覆盖，
 * 通过 `accept-language=zh-CN` 拿中文地名。
 *
 * 注意：
 * - Usage Policy 要求有效 User-Agent 和 ≤1 req/s；这里加内存 LRU 缓存去重同一地点。
 * - 网络/解析失败时静默降级成空串，避免阻塞 /get_file_info 响应。
 */
const GEOCODE_CACHE_MAX = 500;
const GEOCODE_TIMEOUT_MS = 5000;
const GEOCODE_USER_AGENT = "openclaw-multimodal-rag/http-server";
const geocodeCache = new Map<string, string>();

type NominatimAddress = Partial<
  Record<
    | "country"
    | "state"
    | "province"
    | "region"
    | "city"
    | "town"
    | "village"
    | "municipality"
    | "county"
    | "city_district"
    | "suburb",
    string
  >
>;

async function reverseGeocode(lat: number, lon: number): Promise<string> {
  const key = `${lat.toFixed(4)},${lon.toFixed(4)}`;
  const cached = geocodeCache.get(key);
  if (cached !== undefined) {
    geocodeCache.delete(key);
    geocodeCache.set(key, cached);
    return cached;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GEOCODE_TIMEOUT_MS);
  try {
    const url =
      `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}` +
      `&format=jsonv2&zoom=10&addressdetails=1&accept-language=zh-CN`;
    const res = await fetch(url, {
      headers: { "User-Agent": GEOCODE_USER_AGENT, Accept: "application/json" },
      signal: controller.signal,
    });
    if (!res.ok) {
      return cacheSet(key, "");
    }
    const data = (await res.json()) as { address?: NominatimAddress };
    const addr = data.address ?? {};
    const country = addr.country ?? "";
    const locality =
      addr.city ??
      addr.town ??
      addr.village ??
      addr.municipality ??
      addr.county ??
      addr.state ??
      addr.province ??
      addr.region ??
      "";
    const parts = [country, locality].filter((s) => s.length > 0);
    return cacheSet(key, parts.join("/"));
  } catch {
    return cacheSet(key, "");
  } finally {
    clearTimeout(timer);
  }
}

function cacheSet(key: string, value: string): string {
  if (geocodeCache.size >= GEOCODE_CACHE_MAX) {
    const oldest = geocodeCache.keys().next().value;
    if (oldest !== undefined) {
      geocodeCache.delete(oldest);
    }
  }
  geocodeCache.set(key, value);
  return value;
}

export async function formatLocation(gps: GpsCoordinate | undefined): Promise<string> {
  if (!gps) {
    return "";
  }
  return reverseGeocode(gps.latitude, gps.longitude);
}

/**
 * 未索引文件的 desc 解析策略（方案 C：占位 + 后台触发）：
 * - 立即返回占位符 "(indexing)"，不阻塞 HTTP 响应。
 * - 如果 watcher 注入（serve 带 `--enable-index-on-demand`），fire-and-forget
 *   触发 indexPath；watcher 内部已有 broken-file / 重试保护，异常静默吞掉。
 * - 调用方下次再调 /get_file_info 时，如果索引完成就会拿到真实的 AI 描述。
 */
const INDEXING_PLACEHOLDER = "(indexing)";

export async function resolveUnindexedDescription(
  _absolutePath: string,
  deps: { watcher?: MediaWatcher; storage: MediaStorage },
): Promise<string> {
  if (deps.watcher) {
    void deps.watcher.indexPath(_absolutePath).catch(() => {});
  }
  return INDEXING_PLACEHOLDER;
}

async function buildFileInfo(
  rawPath: string,
  deps: { storage: MediaStorage; watcher?: MediaWatcher },
): Promise<FileInfoResponse | FileInfoError> {
  if (typeof rawPath !== "string" || rawPath.trim() === "") {
    return { path: String(rawPath), error: "invalid_path" };
  }

  const absolute = expandPath(rawPath);
  let stats;
  try {
    stats = await stat(absolute);
  } catch {
    return { path: rawPath, error: "not_found" };
  }
  if (!stats.isFile()) {
    return { path: rawPath, error: "not_a_file" };
  }

  const ext = extname(absolute);
  const kind = detectKind(ext);

  let description: string;
  let timeTs: number;

  if (kind === "document") {
    const chunks = await deps.storage.findDocChunksByPath(absolute);
    if (chunks.length > 0) {
      const sorted = chunks.slice().sort((a, b) => a.chunkIndex - b.chunkIndex);
      const joined = sorted
        .slice(0, 3)
        .map((c) => c.chunkText)
        .join("\n\n");
      description =
        joined.length > 1200 ? joined.slice(0, 1200) + "…" : joined;
      timeTs = sorted[0].fileCreatedAt;
    } else {
      description = await resolveUnindexedDescription(absolute, deps);
      timeTs = stats.mtimeMs;
    }
  } else {
    const entry = await deps.storage.findByPath(absolute);
    description =
      entry?.description ?? (await resolveUnindexedDescription(absolute, deps));
    timeTs = entry?.fileCreatedAt ?? stats.mtimeMs;
  }

  const gps = kind === "image" ? await readImageGps(absolute) : undefined;

  return {
    path: rawPath,
    time: formatTime(timeTs),
    location: await formatLocation(gps),
    kind: kind === "other" ? "unknown" : kind,
    contentType: contentTypeOf(ext),
    size: stats.size,
    fileName: basename(absolute),
    desc: description,
  };
}

async function readJsonBody(req: IncomingMessage, maxBytes = 1 * 1024 * 1024): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > maxBytes) {
      throw new Error("payload_too_large");
    }
    chunks.push(buf);
  }
  if (total === 0) {
    return null;
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

export function createHttpServer(options: HttpServerOptions): Server {
  const {
    storage,
    embeddings,
    watcher,
    searchLimit = 20,
    searchMinScore = 0.25,
  } = options;

  return createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

    try {
      if (req.method === "POST" && url.pathname === "/get_file_info") {
        const body = await readJsonBody(req);
        if (!Array.isArray(body)) {
          sendJson(res, 400, { error: "expected_array_of_paths" });
          return;
        }
        const paths = body.filter((x): x is string => typeof x === "string");
        const infos = await Promise.all(
          paths.map((p) => buildFileInfo(p, { storage, watcher })),
        );
        sendJson(res, 200, infos);
        return;
      }

      if (req.method === "GET" && url.pathname === "/search_file") {
        const q = (url.searchParams.get("q") ?? url.searchParams.get("keyword") ?? "").trim();
        if (!q) {
          sendJson(res, 400, { error: "missing_keyword", hint: "use ?q=<keyword>" });
          return;
        }
        const vector = await embeddings.embed(q);
        const unified = await storage.unifiedSearch(vector, {
          type: "all",
          limit: searchLimit,
          minScore: searchMinScore,
          dedupeByHash: true,
        });
        const paths = unified.map((r) =>
          r.kind === "media" ? r.entry.filePath : r.doc.filePath,
        );
        // 去重（同一文档可能被多个 chunk 命中，upstream 已聚合但保险）
        const uniquePaths: string[] = [];
        const seen = new Set<string>();
        for (const p of paths) {
          if (!seen.has(p)) {
            seen.add(p);
            uniquePaths.push(p);
          }
        }
        sendJson(res, 200, uniquePaths);
        return;
      }

      sendJson(res, 404, { error: "not_found", path: url.pathname });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sendJson(res, 500, { error: message });
    }
  });
}

export function startHttpServer(options: HttpServerOptions): Promise<Server> {
  return new Promise((resolvePromise, rejectPromise) => {
    const server = createHttpServer(options);
    server.once("error", rejectPromise);
    server.listen(options.port, options.host, () => resolvePromise(server));
  });
}
