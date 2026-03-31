# Multimodal RAG Plugin

OpenClaw 多模态 RAG 插件 — 使用本地 AI 模型对图像和音频进行语义索引与时间感知搜索。

## 功能特性

- **图像索引**：使用 Qwen3-VL 自动描述图像内容并生成嵌入向量
- **音频索引**：使用 Whisper（本地）或智谱 GLM-ASR（云端）转录音频并生成嵌入向量
- **语义搜索**：基于向量相似度的语义检索，支持中英文
- **时间过滤**：按文件创建时间范围过滤搜索结果
- **自动监听**：实时监听文件夹变化，自动索引新增文件
- **向量存储**：使用 LanceDB 高效存储和检索
- **路径级索引**：同内容不同路径分别索引，删除某一路径只影响该路径
- **搜索去重展示**：`media_search` 默认按内容 hash 去重，避免重复结果淹没输出
- **强一致清理**：监听删除事件自动移除索引；查询链路会自动清理失效索引
- **安全原则**：插件不会删除原始图片/音频文件，只会删除索引记录
- **索引通知**：批次聚合索引事件，仅通过唤醒 agent 生成并回复通知

## 前置条件

- [Ollama](https://ollama.ai) 已安装并运行
- 系统已安装 `ffmpeg`
- **音频转录**（二选一）：
  - **本地 Whisper**（默认）：已安装 `whisper` 命令（`openai-whisper`）
  - **智谱 GLM-ASR**（云端）：拥有[智谱开放平台](https://open.bigmodel.cn/) API Key，无需安装 Whisper
- 以下 Ollama 模型已拉取：
  - `qwen3-vl:2b` (视觉模型，图像描述)
  - `qwen3-embedding:latest` (嵌入模型，向量生成)

**使用本地 Whisper 时：**

```bash
# Ubuntu / Debian
sudo apt update
sudo apt install -y ffmpeg pipx
pipx ensurepath
pipx install --pip-args='-i https://pypi.org/simple' openai-whisper

# 首次执行 ensurepath 后，重新打开终端（或 source ~/.bashrc / source ~/.zshrc）

# 验证
ffmpeg -version
whisper --help

# 安装模型
ollama pull qwen3-vl:2b
ollama pull qwen3-embedding:latest
```

如果 `whisper` 不在默认 `PATH`，可以在启动 OpenClaw 前指定：

```bash
export OPENCLAW_WHISPER_BIN=/absolute/path/to/whisper
```

**使用智谱 GLM-ASR 云端转录时：**

```bash
# 只需 ffmpeg（用于格式转换）和 Ollama 模型
sudo apt install -y ffmpeg
ollama pull qwen3-vl:2b
ollama pull qwen3-embedding:latest
```

无需安装 Whisper，但需在配置中设置 `whisper.provider: "zhipu"` 和 `whisper.zhipuApiKey`。

> **注意**：GLM-ASR 限制单次请求音频时长 ≤ 30 秒、文件大小 ≤ 25MB，仅支持 wav/mp3 格式（其他格式会自动用 ffmpeg 转换）。

### 运行前自检清单

启动前建议逐项确认：

1. `ffmpeg -version` 可执行（所有配置都需要）。
2. `whisper.provider=local` 时，`whisper --help` 可执行。
3. `whisper.provider=zhipu` 时，`whisper.zhipuApiKey` 已配置。
4. `embedding.provider=ollama` 时，`ollama serve` 正常，且 `embedModel` 已 pull。
5. 任意配置下，图片链路都依赖 Ollama（`visionModel` 必须可用）。
6. `embedding.provider=openai` 时，`embedding.openaiApiKey` 已配置。
7. 远程 Ollama 或经 API 网关访问时，`ollama.apiKey` 已配置。
8. `watchPaths` 指向真实目录，且 OpenClaw 进程有读权限。

## 安装

### 方式一：从 npm 安装（推荐）

```bash
openclaw plugins install @hzttt/multimodal-rag@latest
```

插件会自动安装到 `~/.openclaw/extensions/multimodal-rag/`，并自动安装所有运行时依赖。

### 方式二：从 GitHub 安装

```bash
openclaw plugins install github:hzttt/multimodal-rag
```

### 方式三：从本地路径安装

```bash
git clone https://github.com/hzttt/multimodal-rag.git
openclaw plugins install ./multimodal-rag
```

## 配置

插件不再提供 `setup` 命令。安装后请直接使用 OpenClaw 原生插件流程：

```bash
openclaw plugins install @hzttt/multimodal-rag@latest
openclaw plugins enable multimodal-rag
openclaw multimodal-rag doctor
```

实际配置统一写在 gateway 配置中的 `plugins.entries.multimodal-rag.config`。

### 原生插件配置

编辑 `~/.openclaw/openclaw.json`（或你的 gateway 配置文件）：

```json
{
  "plugins": {
    "entries": {
      "multimodal-rag": {
        "enabled": true,
        "config": {
          "watchPaths": ["~/mic-recordings", "~/usb_data"],
          "ollama": {
            "baseUrl": "http://127.0.0.1:11434",
            "apiKey": "",
            "visionModel": "qwen3-vl:2b",
            "embedModel": "qwen3-embedding:latest"
          },
          "embedding": {
            "provider": "ollama"
          },
          "whisper": {
            "provider": "zhipu",
            "zhipuApiKey": "your-zhipu-api-key"
          },
          "dbPath": "~/.openclaw/multimodal-rag.lance",
          "indexExistingOnStart": true,
          "notifications": {
            "enabled": true,
            "agentId": "main",
            "quietWindowMs": 30000,
            "batchTimeoutMs": 600000,
            "channel": "last"
          }
        }
      }
    }
  }
}
```

推荐配置流程：

1. 先写最小配置，只填 `watchPaths`。
2. 如果使用远程 Ollama，再补 `ollama.apiKey`。
3. 如果使用 `embedding.provider=openai`，必须补 `embedding.openaiApiKey`。
4. 如果使用 `whisper.provider=zhipu`，必须补 `whisper.zhipuApiKey`。
5. 保存后执行 `openclaw multimodal-rag doctor` 检查缺失项。

关于“不完整配置”的新行为：

- 插件加载不再因为缺少可选 provider key 而直接失败。
- `doctor` 会显示需要补齐的配置项。
- 真正执行搜索、索引或转录时，才会返回精确错误。

### 通知配置

通知通过配置文件开启，不再通过 CLI 向导写入。示例：

```json
{
  "plugins": {
    "entries": {
      "multimodal-rag": {
        "config": {
          "notifications": {
            "enabled": true,
            "agentId": "main",
            "quietWindowMs": 30000,
            "batchTimeoutMs": 600000,
            "targets": [
              {
                "channel": "feishu",
                "to": "ou_xxx_or_chat_id"
              }
            ]
          }
        }
      }
    }
  }
}
```

如果未配置 `notifications.targets`，插件会先尝试 `channel + to`；若仍未配置，则自动使用最近活跃会话目标。

### 配置项说明


| 配置项                          | 类型       | 默认值                                | 说明                                     |
| ---------------------------- | -------- | ---------------------------------- | -------------------------------------- |
| `watchPaths`                 | string[] | `[]`                               | 监听的文件夹路径（支持 `~` 展开）                    |
| `ollama.baseUrl`             | string   | `http://127.0.0.1:11434`           | Ollama 服务地址                            |
| `ollama.apiKey`              | string   | -                                  | Ollama API Key（远程 Ollama 或 API 网关时需要）  |
| `ollama.visionModel`         | string   | `qwen3-vl:2b`                      | 用于图像描述的视觉模型                            |
| `ollama.embedModel`          | string   | `qwen3-embedding:latest`           | 用于生成嵌入向量的模型                            |
| `embedding.provider`         | string   | `ollama`                           | 嵌入提供者: `ollama` 或 `openai`             |
| `embedding.openaiApiKey`     | string   | -                                  | OpenAI API Key（仅 openai 时需要）           |
| `embedding.openaiModel`      | string   | `text-embedding-3-small`           | OpenAI 嵌入模型                            |
| `whisper.provider`           | string   | `local`                            | 音频转录提供者: `local`（Whisper CLI）或 `zhipu`（GLM-ASR 云端）|
| `whisper.zhipuApiKey`        | string   | -                                  | 智谱 API Key（仅 zhipu 时需要）              |
| `whisper.zhipuApiBaseUrl`    | string   | `https://open.bigmodel.cn/api/paas/v4` | 智谱 API 地址（可选，用于自定义端点）       |
| `whisper.zhipuModel`         | string   | `glm-asr-2512`                     | 智谱 ASR 模型                              |
| `whisper.language`           | string   | `zh`                               | 转录语言（仅 local whisper 使用）            |
| `dbPath`                     | string   | `~/.openclaw/multimodal-rag.lance` | LanceDB 数据库路径                          |
| `watchDebounceMs`            | number   | `1000`                             | 文件监听去抖延迟（毫秒）                           |
| `indexExistingOnStart`       | boolean  | `true`                             | 启动时是否索引已有文件                            |
| `notifications.enabled`      | boolean  | `false`                            | 启用索引完成通知（默认唤醒 agent 回复）         |
| `notifications.agentId`      | string   | `"main"`                           | 通知触发使用的 agent ID（会沿用该 agent 的性格/身份设定） |
| `notifications.quietWindowMs` | number   | `30000`                            | 兼容保留参数（当前完成通知按“队列清空 + 无处理中”即时触发）         |
| `notifications.batchTimeoutMs` | number   | `600000`                           | 批次最大超时：超过此时间强制发送总结（毫秒），防止大批量索引时等太久 |
| `notifications.channel`      | string   | `"last"`                           | 通知渠道（未配置 `targets` 时使用）                      |
| `notifications.to`           | string   | -                                  | 通知目标（未配置 `targets` 时使用）                      |
| `notifications.targets`      | object[] | `[]`                               | 通知目标列表（用于 `agent --reply-channel/--reply-to`）            |


配置完成后，重启 OpenClaw Gateway 使配置生效。

## 使用方法

### 索引通知（可选功能）

插件支持在索引新文件时自动发送通知。通知采用批次聚合机制，避免逐文件通知造成的消息轰炸。

#### 工作原理

1. **开始通知**：检测到第一个新文件入队时，插件默认用 `openclaw agent --deliver` 唤醒 agent 生成回复并发送
2. **批次聚合**：持续聚合多个文件的索引状态，避免频繁通知
3. **完成通知**：当本轮无正在处理文件且队列为空时，立即触发 agent 发送总结

#### 通知示例

**开始通知**：
```
[Multimodal RAG] 已开始处理本轮新增媒体文件...
```

**完成通知**：
```
[Multimodal RAG] 索引完成
共处理 5 个文件，成功 4 个 (2 张图片, 2 个音频)，失败 1 个
耗时 2 分 30 秒
```

#### 启用通知

在 `~/.openclaw/openclaw.json` 中设置 `notifications.enabled: true`：

```json
{
  "plugins": {
    "entries": {
      "multimodal-rag": {
        "config": {
          "notifications": {
            "enabled": true,
            "agentId": "main",
            "quietWindowMs": 30000,
            "batchTimeoutMs": 600000,
            "targets": [
              {
                "channel": "feishu",
                "to": "ou_xxx_or_chat_id"
              },
              {
                "channel": "qq",
                "to": "group_or_user_id"
              }
            ]
          }
        }
      }
    }
  }
}
```
如果未配置 `notifications.targets`，插件会先尝试 `channel+to`；若仍未配置，则自动使用最新活跃会话目标。

### Agent 工具

插件注册 4 个 Agent 工具，可以在对话中自然地调用：

#### `media_search` — 语义搜索

```
用户：上周我去东方明珠拍的照片在哪
Agent：[调用 media_search] → 找到 3 张匹配的照片 → 发送给用户
```

#### `media_describe` — 获取媒体描述

```
用户：这个录音说了什么
Agent：[调用 media_describe(filePath)] → 返回音频转录内容
```

#### `media_list` — 浏览媒体文件

```
用户：列出最近的照片
Agent：[调用 media_list(type="image")] → 返回最近索引的图片列表
```

#### `media_stats` — 查看库统计

```
用户：我的媒体库有多少文件
Agent：[调用 media_stats] → 总计 120 个文件，图片 80，音频 40
```

### CLI 命令

```bash
# 诊断当前配置和依赖状态
openclaw multimodal-rag doctor

# 手动索引文件或文件夹
openclaw multimodal-rag index ~/Pictures/photo.jpg

# 语义搜索
openclaw multimodal-rag search "东方明珠"
openclaw multimodal-rag search "会议讨论" --type audio --after 2026-01-29

# 查看索引统计
openclaw multimodal-rag stats

# 列出已索引文件
openclaw multimodal-rag list --type image --limit 10

# 完整重新索引
openclaw multimodal-rag reindex --confirm

# 清理历史失败导致的脏媒体索引（音频/图片）
openclaw multimodal-rag cleanup-failed-media --confirm

# 清理“索引存在但源文件已删除”的失效索引
openclaw multimodal-rag cleanup-missing --dry-run
openclaw multimodal-rag cleanup-missing --confirm
```

### 索引一致性与清理策略

- 插件**不会删除原始媒体文件**（图片/音频），仅管理向量索引记录。
- 当监听到文件被删除（`unlink`）时，会同步硬删除对应索引，避免“幽灵结果”。
- 若历史上存在“源文件已丢失但索引还在”的脏数据，系统会：
  - watcher 启动后后台自愈清理一次；
  - 在 `media_search` / `media_list` / CLI `search` / CLI `list` 查询时做存在性兜底并自动清理。
- 也可手动执行 `cleanup-missing` 做全量清理。

## 故障排除

### Ollama 连接失败

```bash
# 确保 Ollama 已启动
ollama serve

# 检查连接
curl http://127.0.0.1:11434/api/tags
```

### 嵌入维度不匹配

切换嵌入模型后需要重建索引：

```bash
openclaw multimodal-rag reindex --confirm
```

### 文件监听不生效

检查路径是否正确，以及插件是否已启用：

```bash
openclaw plugins list | grep multimodal-rag
openclaw multimodal-rag doctor
```

### 音频索引失败或统计异常

**本地 Whisper 模式**，检查依赖：

```bash
ffmpeg -version
whisper --help
which whisper
```

如果 `whisper` 找不到，执行 `pipx ensurepath` 然后重开终端。

**智谱 GLM-ASR 模式**，检查：
- API Key 是否配置正确
- 音频文件是否超过 30 秒或 25MB（当前不支持自动分片）
- 查看日志中的 HTTP 状态码：`tail -200 /tmp/openclaw/openclaw-$(date +%Y-%m-%d).log | grep GLM-ASR`

清理历史脏数据并重新索引：

```bash
openclaw multimodal-rag cleanup-failed-media --confirm
openclaw multimodal-rag cleanup-missing --confirm
openclaw multimodal-rag reindex --confirm
```

## 许可证

MIT
