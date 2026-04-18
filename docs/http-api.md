# HTTP 接入接口

`multimodal-rag` 插件通过本地 HTTP 服务把 LanceDB 里的索引能力暴露给外部系统（NAS 前端、自建 App、自动化脚本等）。

> 代码位置：`src/http-server.ts`。

---

## 1. 接口清单

| Method | Path | 用途 |
|---|---|---|
| `POST` | `/get_file_info` | 批量获取文件 metadata + AI 描述 |
| `GET`  | `/search_file`   | 基于语义向量搜索，返回匹配的文件绝对路径 |

- **默认端口：`7749`**
- 所有响应 `Content-Type: application/json; charset=utf-8`

---

## 2. `POST /get_file_info`

### 2.1 请求

```
POST /get_file_info
Content-Type: application/json

["/absolute/path/a.jpg", "~/data/b.png", "/nonexistent.jpg"]
```

**入参**：JSON 数组，每个元素是一个文件路径字符串。

- 支持绝对路径和 `~` 开头的路径（会被服务端展开到用户 home）
- 同一数组内多个路径会**并发**处理
- 请求体最大 1 MB，超过返回 `payload_too_large`

### 2.2 响应

`HTTP 200`，响应体是一个数组，长度与入参一致，每项是**成功对象**或**错误对象**：

**成功对象**：

```json
{
  "path": "/home/user/data/photo.jpg",
  "time": "2026-04-17 14:48",
  "location": "中国/上海",
  "kind": "image",
  "contentType": "image/jpeg",
  "size": 1842930,
  "fileName": "photo.jpg",
  "desc": "一张户外街景照片，可以看到..."
}
```

**错误对象**：

```json
{ "path": "/nonexistent.jpg", "error": "not_found" }
```

### 2.3 字段语义

| 字段 | 类型 | 说明 |
|---|---|---|
| `path` | string | 原样回传入参中的路径（未展开 `~`） |
| `time` | string | 文件时间，格式 `YYYY-MM-DD HH:mm`。优先用索引时解析出的**拍摄时间**（EXIF DateTimeOriginal / PNG tIME / ffprobe creation_time）；没有时回退到文件 mtime |
| `location` | string | 地理位置。仅对带 EXIF GPS 的 JPEG 有效，经 [Nominatim](https://nominatim.openstreetmap.org) 反向地理编码得到 `"国家/城市"`（中文）。PNG / 无 GPS / 反查失败一律返回 `""` |
| `kind` | string | `"image"` / `"audio"` / `"unknown"` |
| `contentType` | string | 按扩展名推断的 MIME，如 `image/jpeg`、`audio/mpeg` |
| `size` | number | 文件字节数 |
| `fileName` | string | 文件名（含扩展名） |
| `desc` | string | 见 §2.4 |

### 2.4 `desc` 字段的四种状态

| desc 内容 | 含义 |
|---|---|
| 非空文本 | 已索引：AI 生成的详细描述（图像由 vision 模型生成，音频由 ASR 转录） |
| `""` | 已索引但原始描述为空字符串（通常是索引失败被记空） |
| `"(indexing)"` | 文件存在但**尚未出现在 LanceDB** 里，调用方后续再调本接口拿真值 |
| 不存在 | 错误对象里用 `error` 字段替代（见 §2.5） |

### 2.5 错误码

| `error` | 含义 |
|---|---|
| `invalid_path` | 入参不是字符串或为空串 |
| `not_found` | 文件在磁盘上找不到（`stat` 失败） |
| `not_a_file` | 路径存在但不是普通文件（如目录、socket） |

其它异常以 `HTTP 500` 返回 `{ "error": "<message>" }`。

### 2.6 示例

```bash
curl -sS -X POST http://<host>:7749/get_file_info \
  -H "Content-Type: application/json" \
  -d '["/home/cephalon/data/desktop_test/Screenshot 2026-04-17 at 14.48.10.png"]'
```

响应片段：

```json
[{
  "path": "/home/cephalon/data/desktop_test/Screenshot 2026-04-17 at 14.48.10.png",
  "time": "2026-04-17 06:48",
  "location": "",
  "kind": "image",
  "contentType": "image/png",
  "size": 14529,
  "fileName": "Screenshot 2026-04-17 at 14.48.10.png",
  "desc": "这张图片并不是一张风景照或自然场景，而是一个软件用户界面（UI）的截图..."
}]
```

---

## 3. `GET /search_file`

### 3.1 请求

```
GET /search_file?q=<关键词>
```

- `q`（或兼容写法 `keyword`）：搜索关键词，需 URL-encode
- 缺省 `q` 返回 `HTTP 400 missing_keyword`

### 3.2 响应

`HTTP 200`，响应体是**绝对路径字符串数组**（按相似度降序），命中的文件都是已索引到 LanceDB 的条目：

```json
[
  "/home/cephalon/data/test_img/8.jpeg",
  "/home/cephalon/data/desktop_test/Screenshot 2026-04-06 at 07.55.01.png"
]
```

- 自带去重（同 hash 文件只返回一个）
- 单次返回**最多 20 条**
- 最低相似度 **0.25**，低于此分数的结果会被过滤
- 空结果返回 `[]`

### 3.3 示例

```bash
# 中文关键词（URL-encode）
curl -sS "http://<host>:7749/search_file?q=%E6%88%AA%E5%9B%BE"

# 英文关键词
curl -sS "http://<host>:7749/search_file?q=code"
```

### 3.4 错误码

| HTTP | body | 含义 |
|---|---|---|
| `400` | `{"error":"missing_keyword","hint":"use ?q=<keyword>"}` | 未提供关键词 |
| `500` | `{"error":"<message>"}` | 向量化失败 / LanceDB 查询异常等 |

---

## 4. 404 与其他路径

未命中的路径统一返回：

```
HTTP 404
{"error":"not_found","path":"/<requested path>"}
```

---

## 5. 运行注意事项

### 5.1 首次请求冷启动

如果嵌入模型（如 `qwen3-embedding:latest`）不在内存里，首次 `/search_file` 会触发 Ollama 加载模型：

- GPU 主机：通常 1-3 秒
- **CPU 主机**：可能 5-15 秒

客户端 timeout 建议设 **≥30 秒**。一旦预热（`ollama ps` 显示 UNTIL 5 分钟内），后续请求毫秒返回。想避免冷启动可用 cron 定时打 `GET /search_file?q=ping` 把模型常驻。

### 5.2 `location` 依赖外网

反向地理编码调用 `nominatim.openstreetmap.org`：

- 服务器必须能出公网
- OSM Usage Policy 限流 **1 req/s**，服务端带 500 条内存 LRU 缓存（key 精度 4 位小数 ≈ 11m）去重
- 网络不可达 / HTTP 非 2xx / 超时 5 秒：降级为 `""`，不影响其它字段

离线环境运行时，所有 `location` 一律为 `""`。

### 5.3 `desc` 异步生成

图像 AI 描述与音频 ASR 都是**异步在 watcher 里跑**，不由 HTTP 接口触发。批量上传大量文件时，建议先等索引跑完再轮询 `/get_file_info`，否则大部分响应会是 `"(indexing)"`。

---

## 6. 文档（document）支持

与 image/audio 并列，`.pdf / .docx / .xlsx / .pptx / .txt / .md / .markdown / .html / .htm` 走文档路径。

### 6.1 `POST /get_file_info` 对 document 的差异

- `kind: "document"`；`contentType` 按扩展名映射（例如 `.pdf → application/pdf`，`.docx → application/vnd.openxmlformats-officedocument.wordprocessingml.document`）。
- `desc` 取自 `storage.findDocChunksByPath` 的前 3 段 chunkText 拼接（上限 1200 字，超出截断加 `…`）。
- `location` 永远为空（文档不抽 EXIF GPS）。
- 未索引时同样返回 `"(indexing)"`；启用 `--enable-index-on-demand` 时 fire-and-forget 触发 `watcher.indexPath`。

### 6.2 `GET /search_file` 对 document 的差异

- 底层改用 `storage.unifiedSearch`，同时查 media 与 doc_chunks 两张表，文档侧先按 `docId` 聚合再合并。
- 响应仍是**去重后的文件绝对路径数组**，同一文档多段命中只会出现一次。
- `--search-min-score` 对两张表同时生效。

### 6.3 依赖

- `pdftoppm`（poppler）仅在 PDF 扫描页 OCR 回落时需要；纯文本 PDF 不依赖。
- Ollama VLM（`ocrModel` 或 `visionModel` fallback）在 OCR 开启时需要可用。
- `officeparser` / `pdfjs-dist` 是插件 npm 依赖，随 `npm install` 到位。
