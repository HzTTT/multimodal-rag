# Multimodal RAG 插件开发文档

## 概述

多模态 RAG 插件，支持**图像**和**音频**的语义索引与时间感知搜索。

**核心功能**:
- 自动监听本地文件夹（`~/mic-recordings`, `~/usb_data`）
- 使用本地 Ollama 模型进行多模态索引
  - 图像: `qwen3-vl:2b` 生成描述 + `qwen3-embedding` 生成向量
  - 音频: `whisper`（本地）或 `GLM-ASR-2512`（智谱云端）转录 + `qwen3-embedding` 生成向量
- 支持时间过滤和语义搜索
- Agent 可通过工具直接查询并返回媒体文件

**目标硬件**: Ubuntu 25.10, AMD Ryzen AI MAX+ 395, 30GB RAM, AMD Radeon 8060S (ROCm)

## 项目结构

```
extensions/multimodal-rag/
├── CLAUDE.md              # 本文档
├── README.md              # 用户文档
├── index.ts               # 插件入口
├── openclaw.plugin.json   # 插件元数据
├── package.json           # 依赖配置
├── deploy.sh              # 远程部署脚本
├── src/
│   ├── config.ts          # 配置 schema 和默认值
│   ├── embeddings.ts      # Ollama 嵌入提供者（带重试逻辑）
│   ├── storage.ts         # LanceDB 向量存储
│   ├── processor.ts       # 多模态处理器（qwen3-vl + whisper/GLM-ASR）
│   ├── watcher.ts         # chokidar 文件监听服务
│   └── tools.ts           # Agent 工具定义
└── test/
    └── ...                # 测试文件
```

## 核心模块

### 1. **配置 (`src/config.ts`)**

**默认配置**:
```typescript
{
  dbPath: "/home/lucy/.openclaw/multimodal-rag.lance",
  watchPaths: [],  // 需要用户配置
  watchDebounceMs: 1000,
  indexExistingOnStart: true,  // 启动时自动索引已存在的文件
  fileTypes: {
    image: [".jpg", ".jpeg", ".png", ".webp", ".gif", ".heic"],
    audio: [".wav", ".mp3", ".m4a", ".ogg", ".flac", ".aac"]
  },
  ollama: {
    baseUrl: "http://127.0.0.1:11434",
    apiKey: undefined,  // 远程 Ollama 或 API 网关时设置
    visionModel: "qwen3-vl:2b",
    embedModel: "qwen3-embedding:latest"
  },
  embedding: {
    provider: "ollama"
  },
  whisper: {
    provider: "local",        // "local"（Whisper CLI）或 "zhipu"（GLM-ASR 云端）
    zhipuApiKey: undefined,   // 智谱 API Key（zhipu 时必填）
    zhipuModel: "glm-asr-2512",
    language: "zh"            // 仅 local whisper 使用
  }
}
```

**配置位置**: `~/.openclaw/openclaw.json` → `plugins.entries.multimodal-rag.config`

**配置说明**:
- 大部分参数已设置为推荐默认值
- 用户只需通过 `openclaw multimodal-rag setup` 配置 `watchPaths`
- `ollama.apiKey` 可选，配置后所有 Ollama API 请求（嵌入、视觉、健康检查）会附带 `Authorization: Bearer <apiKey>` header
- 如需自定义其他参数，可手动编辑配置文件

### 2. **向量存储 (`src/storage.ts`)**

使用 **LanceDB** 存储媒体元数据和嵌入向量。

**重要 Schema 字段**:
```typescript
{
  id: string,              // UUID
  filePath: string,        // 绝对路径
  fileName: string,        // 文件名
  fileType: "image" | "audio",
  description: string,     // 图像描述或音频转录
  vector: number[],        // 嵌入向量（4096 维）
  fileHash: string,        // SHA256（用于去重）
  fileSize: number,
  fileCreatedAt: number,   // 时间戳（毫秒）
  fileModifiedAt: number,
  indexedAt: number
}
```

**LanceDB 查询注意事项**:
- 字段名必须用反引号包裹：`` `fileType` = 'image' ``
- `type="all"` 时，使用分别查询然后合并（规避 LanceDB OR 查询 bug）

### 3. **文件监听 (`src/watcher.ts`)**

**核心功能**:
- `chokidar` 监听文件变化
- 启动时批量扫描缺失文件（性能优化：一次查询所有已索引文件）
- Ollama 健康检查（60秒缓存）
- 失败文件自动重试（3次，60秒间隔）
- 基于文件 hash 去重

**关键优化** (最新):
```typescript
// 启动扫描：批量查询 → 内存比较（避免 N 次数据库查询）
const { entries: indexedFiles } = await this.storage.list({ limit: 10000 });
const indexedPathsSet = new Set(indexedFiles.map(f => f.filePath));
```

**索引流程**:
1. 文件变化 → 加入队列（防抖 2 秒）
2. 检查 Ollama 健康状态
3. 计算文件 hash → 检查是否重复
4. 处理媒体（图像描述/音频转录）
5. 生成嵌入向量 → 存储到 LanceDB

### 4. **Agent 工具 (`src/tools.ts`)**

**4 个工具**:

1. **`media_search`** - 语义搜索（支持时间过滤）
   - 参数: `query`, `type`, `after`, `before`, `limit`
   - **强制行为**: 搜索到结果后必须立即发送文件，禁止只描述不发送

2. **`media_describe`** - 获取单个媒体文件详细描述
   - 参数: `filePath`

3. **`media_stats`** - 查看媒体库统计
   - 返回总数、图片数、音频数

4. **`media_list`** - 列出最近的媒体文件
   - 参数: `type`, `limit`
   - **强制行为**: 用户想查看文件时必须立即发送，禁止询问

**Agent 强制行为** (2026-02-05 更新):
工具描述中包含以下强制要求：
- ⚠️ 搜索到结果后，必须立即发送媒体文件给用户
- ❌ 禁止询问'需要我发送给你吗？'
- ❌ 禁止只描述文件内容而不发送实际文件
- ✅ 根据当前聊天渠道，使用该渠道对应的方式发送图片/音频文件

**渠道适配**: Agent 需自行判断当前聊天渠道（Telegram/飞书/QQ/Discord/Slack/微信等）并选择正确的发送方式

## 部署

### 本地开发

```bash
# 在 openclaw 仓库根目录
cd extensions/multimodal-rag
npm install
npm run build  # 如果有构建步骤
```

### 远程部署

**使用部署脚本**:
```bash
./deploy.sh
```

**手动部署**:
```bash
# 同步代码
rsync -avz --exclude=node_modules extensions/multimodal-rag/ \
  lucy@192.168.0.184:/home/lucy/projects/multimodal-rag/

# 重启 Gateway
ssh lucy@192.168.0.184 "systemctl --user restart openclaw-gateway.service"
```

**快速同步单个文件** (开发时常用):
```bash
rsync -avz extensions/multimodal-rag/src/watcher.ts \
  lucy@192.168.0.184:/home/lucy/projects/multimodal-rag/src/
```

## 测试

### 1. 插件加载测试

```bash
ssh lucy@192.168.0.184
openclaw plugins list | grep multimodal-rag
```

**预期输出**: `loaded` 状态（不是 `error`）

### 2. 索引功能测试

#### 查看统计
```bash
openclaw multimodal-rag stats
```

**预期输出**:
```
媒体库统计:
  总计: 59 个文件
  图片: 9 个
  音频: 50 个
```

#### 手动索引单个文件
```bash
openclaw multimodal-rag index ~/mic-recordings/test.wav
```

#### 完整重新索引
```bash
openclaw multimodal-rag reindex --confirm
```

**用途**: 清空数据库并重新扫描所有文件（解决数据不一致问题）

### 3. 搜索功能测试

```bash
# 语义搜索
openclaw multimodal-rag search "东方明珠"

# 时间过滤搜索
openclaw multimodal-rag search "上海" \
  --after "2026-02-03T00:00:00" \
  --type image
```

### 4. Agent 集成测试

通过 Telegram/QQ 向 Agent 发送消息：

```
"我有一张东方明珠的照片，请你帮我找出来"
```

**预期行为**:
1. Agent 调用 `media_search` 工具
2. 找到匹配的图片文件路径
3. **使用 `message` 工具的 `attachments` 参数发送图片给用户**
4. 用户在聊天界面中看到图片

**测试要点**:
- Agent 是否调用了正确的工具
- Agent 是否发送了图片（而不是仅描述）
- 不同聊天渠道（Telegram/QQ）的图片发送格式是否正确

### 5. 性能测试

```bash
# 监控索引速度
tail -f /tmp/openclaw/openclaw-$(date +%Y-%m-%d).log | grep "Indexed"

# 查看 Ollama 状态
ollama ps
```

**参考速度**:
- 图像: ~3-5 秒/张（qwen3-vl 处理 + 嵌入）
- 音频（本地 whisper）: ~12-15 秒/条（whisper 转录 + 嵌入）
- 音频（智谱 GLM-ASR）: ~2-5 秒/条（云端转录 + 嵌入，取决于网络）

### 6. 错误处理测试

#### 测试 Ollama 服务中断
```bash
# 停止 Ollama
pkill -f ollama

# 添加新文件到监听目录
touch ~/mic-recordings/test_$(date +%s).wav

# 检查日志：应该看到 "Ollama unavailable, will retry"
tail -50 /tmp/openclaw/openclaw-$(date +%Y-%m-%d).log | grep Ollama
```

#### 测试重试逻辑
```bash
# 启动 Ollama
ollama serve > /tmp/ollama.log 2>&1 &

# 等待 60 秒，检查文件是否被重新索引
sleep 60
openclaw multimodal-rag stats
```

## 日志查看

### Gateway 日志
```bash
# 实时查看
tail -f /tmp/openclaw/openclaw-$(date +%Y-%m-%d).log

# 过滤插件相关日志
tail -100 /tmp/openclaw/openclaw-$(date +%Y-%m-%d).log | grep multimodal-rag

# 查看索引进度
tail -200 /tmp/openclaw/openclaw-$(date +%Y-%m-%d).log | grep "Indexed"

# 查看错误
tail -200 /tmp/openclaw/openclaw-$(date +%Y-%m-%d).log | grep -E "(ERROR|Failed)"
```

### Ollama 日志
```bash
tail -f /tmp/ollama.log
```

### Whisper 日志
```bash
# whisper 输出会显示在 Gateway 日志中
tail -100 /tmp/openclaw/openclaw-$(date +%Y-%m-%d).log | grep whisper
```

## 已知问题与解决方案

### 1. **启动扫描失败: "Cannot read properties of undefined (reading 'map')"**

**原因**: `storage.list()` 返回 `{ total, entries }`，但代码中错误地使用了 `items`

**修复**: ✅ 已修复（`watcher.ts` 中使用正确的 `entries` 字段）

### 2. **索引数量不匹配（stats 显示总数小于实际文件数）**

**可能原因**:
- 文件 hash 重复（内容相同但路径不同）
- 之前索引失败留下脏数据
- LanceDB 查询 bug（`type="all"` 时的 OR 查询）

**解决方案**:
```bash
openclaw multimodal-rag reindex --confirm
```

### 3. **Ollama 服务崩溃导致索引停止**

**症状**: `ollama ps` 无输出，日志中出现 "Ollama unavailable"

**解决方案**:
```bash
# 启动 Ollama
ollama serve > /tmp/ollama.log 2>&1 &

# 重启 Gateway（会自动重新扫描缺失文件）
systemctl --user restart openclaw-gateway.service
```

**预防措施**: ✅ 已实现
- Ollama 健康检查（60秒缓存）
- 失败文件自动重试（3次）

### 4. **Agent 找到图片但不发送给用户**

**症状**: Agent 描述找到了图片，但只返回文本描述，不发送图片

**原因**: Agent 工具描述不够明确

**修复**: ✅ 已优化 `tools.ts` 中的描述
```typescript
// 现在包含明确指引：
"找到匹配的媒体文件后，使用 message 工具的 attachments 参数
将 filePath 发送给用户"
```

### 5. **音频文件索引速度慢**

**原因**: 本地 Whisper 转录耗时较长（12-15秒/文件）

**解决方案**:
- ✅ 已实现队列处理（单个文件失败不影响其他）
- ✅ 已实现自动重试
- ✅ 支持智谱 GLM-ASR 云端转录（`whisper.provider=zhipu`，2-5秒/文件）
- 考虑: 使用更小的 whisper 模型（`tiny` 替代 `base`）
- 考虑: 并行处理（需注意 GPU 内存）

### 5b. **智谱 GLM-ASR 音频时长限制**

**症状**: 超过 30 秒的音频转录失败

**原因**: GLM-ASR API 限制单次请求 ≤ 30 秒、≤ 25MB

**现状**: 当前未实现自动分片，超时长音频会报错并进入重试队列

**规避**: 短音频（语音备忘录、指令等）直接使用云端；长音频可保持 `whisper.provider=local`

### 6. **chokidar 启动时不索引已存在的文件**

**原因**: `ignoreInitial: false` 在重启后不会重新触发已存在文件的 `add` 事件

**修复**: ✅ 已实现启动时批量扫描逻辑
```typescript
// watcher.ts ready 事件中
this.scanAndIndexMissingFiles(expandedPaths, supportedExts)
```

### 7. **不同聊天渠道搜索结果不一致**

**症状**: 同一个查询，TG 能搜到结果，飞书搜不到（或反过来）

**原因**: 
- OpenClaw 为不同渠道可能创建独立的插件实例
- LanceDB 的表在 `openTable()` 后会保持在当时的版本
- 不同实例打开表的时间不同，可能看到不同版本的数据

**修复**: ✅ 已实现 (2026-02-05)
```typescript
// storage.ts 中添加 refreshToLatest() 方法
// 在每次查询前调用 table.checkoutLatest() 刷新到最新版本
private async refreshToLatest(): Promise<void> {
  if (this.table) {
    await this.table.checkoutLatest();
  }
}

// 在 search、list、count、findByPath、findByHash 等方法中调用
async search(...) {
  await this.ensureInitialized();
  await this.refreshToLatest(); // 确保跨渠道数据一致性
  // ...
}
```

**排查方法**:
```bash
# 查看搜索日志
tail -200 /tmp/openclaw/openclaw-$(date +%Y-%m-%d).log | grep -E 'media_search|Search returned'

# 检查数据库版本
ls -lt ~/.openclaw/multimodal-rag.lance/media.lance/_versions/ | head -5
```

## 性能优化记录

### ✅ 已完成的优化

1. **批量扫描优化** (2026-02-05)
   - **之前**: 每个文件单独查询数据库（59 次查询）
   - **现在**: 一次查询所有已索引文件，内存中比较（1 次查询）
   - **性能提升**: ~99% 减少数据库查询

2. **Ollama 健康检查缓存** (2026-02-05)
   - 60秒缓存，避免每个文件都检查一次
   - 减少不必要的网络请求

3. **嵌入提供者重试逻辑** (2026-02-05)
   - 自动重试（3次，递增延迟）
   - 处理 Ollama 间歇性错误（如 "Internal Server Error"）

4. **LanceDB 查询优化** (2026-02-05)
   - `type="all"` 时分别查询图片和音频，避免 OR 查询 bug
   - 字段名使用反引号包裹，避免大小写问题

5. **跨渠道数据一致性修复** (2026-02-05)
   - **问题**: 不同聊天渠道（TG/飞书/QQ）可能看到不同版本的数据
   - **原因**: LanceDB 表在 `openTable()` 后不会自动刷新到最新版本
   - **修复**: 在每次查询前调用 `table.checkoutLatest()` 刷新表
   - **影响**: 轻微的查询延迟增加（通常 <10ms）

### 🔄 待优化

1. **音频处理并行化**
   - 当前: 单个文件顺序处理
   - 目标: 允许多个文件并行处理（需控制并发数）

2. **Whisper 模型优化**
   - 当前: `base` 模型（准确但慢）
   - 考虑: 切换到 `tiny` 模型（快但准确度略低）

3. **增量嵌入缓存**
   - 当前: 每次重新计算嵌入向量
   - 目标: 缓存常见查询的嵌入向量

4. **向量索引优化**
   - LanceDB 默认 IVF 索引可能不够优化
   - 考虑调整索引参数或使用 HNSW

## 开发约定

### 代码风格

- **注释**: 中文（代码逻辑说明）
- **Git Commit**: 英文
- **变量命名**: TypeScript 风格（camelCase）
- **类型**: 严格类型，避免 `any`

### 错误处理

- 所有异步操作必须 `try-catch`
- 关键错误使用 `logger.error`，非关键使用 `logger.warn`
- 用户可见错误提供清晰的中文提示

### 日志规范

```typescript
// 信息
this.logger.info?.(`Indexed ${fileType}: ${fileName}`);

// 警告
this.logger.warn?.(`Failed to index ${filePath}: ${errorMsg}`);

// 调试
this.logger.debug?.(`Processing queue size: ${this.processQueue.size}`);
```

### 配置变更

修改默认配置后，需要：
1. 更新 `src/config.ts`
2. 更新 `README.md`
3. 更新本文档
4. 通知用户更新 `~/.openclaw/openclaw.json`

## 依赖版本

**运行时**:
- Node.js: 22+
- Ollama: latest
- Python: 3.8+ (仅 `whisper.provider=local` 时需要)

**核心依赖**:
```json
{
  "vectordb": "^0.11.0",
  "chokidar": "^4.0.3",
  "apache-arrow": "^18.1.0"
}
```

## 相关链接

- **OpenClaw 主仓库**: https://github.com/openclaw/openclaw
- **LanceDB 文档**: https://lancedb.github.io/lancedb/
- **Ollama API**: https://github.com/ollama/ollama/blob/main/docs/api.md
- **Whisper**: https://github.com/openai/whisper

## 未来计划

### 短期
- [ ] 优化音频处理速度（并行化）
- [ ] 添加更多测试用例
- [ ] 改进错误提示

### 中期
- [ ] 支持视频文件（提取关键帧 + 音轨）
- [ ] 支持 PDF/文档（OCR + 文本提取）
- [ ] 增加语义聚类功能（相似媒体分组）

### 长期
- [ ] 支持多用户隔离
- [ ] 添加 Web UI（查看索引内容）
- [ ] 支持云端向量数据库（Qdrant/Pinecone）

## 常见问题 (FAQ)

### Q: 如何查看插件是否正常加载？
```bash
openclaw plugins list | grep multimodal-rag
```
看到 `loaded` 状态即正常。

### Q: 如何重新索引所有文件？
```bash
openclaw multimodal-rag reindex --confirm
```

### Q: 索引速度太慢怎么办？
- 音频: 考虑使用更小的 whisper 模型（在 `~/.openclaw/openclaw.json` 中修改 `whisper.model` 为 `tiny`）
- 图像: 检查 GPU 是否被正确使用（`ollama ps` 查看）

### Q: Agent 不使用搜索工具怎么办？
检查工具描述是否清晰，可以在聊天中明确提示：
```
"请使用本地媒体搜索工具查找我的照片"
```

### Q: 如何调试 Agent 工具调用？
查看 Gateway 日志中的工具调用记录：
```bash
tail -200 /tmp/openclaw/openclaw-$(date +%Y-%m-%d).log | grep -A5 "media_search"
```

---

**最后更新**: 2026-03-18  
**维护者**: OpenClaw Contributors
