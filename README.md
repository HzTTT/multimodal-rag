# Multimodal RAG Plugin

OpenClaw 多模态 RAG 插件 — 使用本地 AI 模型对图像和音频进行语义索引与时间感知搜索。

## 功能特性

- **图像索引**：使用 Qwen3-VL 自动描述图像内容并生成嵌入向量
- **音频索引**：使用 Whisper 转录音频并生成嵌入向量
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
- 已安装 `whisper` 命令（`openai-whisper`）
- 以下 Ollama 模型已拉取：
  - `qwen3-vl:2b` (视觉模型，图像描述)
  - `qwen3-embedding:latest` (嵌入模型，向量生成)

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

### 交互式配置（推荐）

安装完成后，运行引导配置向导：

```bash
openclaw multimodal-rag setup
```

向导将引导你配置**文件监听路径**，其他参数已使用推荐的默认值：

- **Ollama 地址**: `http://127.0.0.1:11434`
- **视觉模型**: `qwen3-vl:2b` (图像描述)
- **嵌入模型**: `qwen3-embedding:latest` (向量生成)
- **嵌入提供者**: `ollama` (本地)
- **数据库路径**: `~/.openclaw/multimodal-rag.lance`
- **启动时索引**: `true` (自动索引已有文件)

你只需要指定要监听的文件夹路径即可。

### 非交互式配置（适合脚本/远程部署）

通过命令行参数一次性完成配置，无需交互输入，适用于 SSH 远程部署、CI/CD 脚本等场景：

```bash
# 最简用法：只指定监听路径（其他使用默认值）
openclaw multimodal-rag setup --non-interactive --watch ~/photos --watch ~/audio

# 简写形式
openclaw multimodal-rag setup -n -w ~/photos -w ~/audio

# 逗号分隔多个路径
openclaw multimodal-rag setup -n --watch ~/photos,~/mic-recordings,~/usb_data

# 自定义所有参数
openclaw multimodal-rag setup -n \
  --watch ~/photos --watch ~/audio \
  --ollama-url http://192.168.0.100:11434 \
  --vision-model qwen3-vl:2b \
  --embed-model qwen3-embedding:latest \
  --db-path ~/.openclaw/my-rag.lance \
  --no-index-on-start

# 使用 OpenAI 嵌入
openclaw multimodal-rag setup -n \
  --watch ~/photos \
  --embedding-provider openai \
  --openai-api-key sk-xxx \
  --openai-model text-embedding-3-small

# 启用索引通知
openclaw multimodal-rag setup -n \
  --watch ~/photos \
  --notify-enabled \
  --notify-quiet-window 30000 \
  --notify-batch-timeout 600000

# 仅启用通知（其他通知参数沿用已有配置；若无则使用默认值）
openclaw multimodal-rag setup -n \
  --watch ~/photos \
  --notify-enabled

# 关闭通知（当前 CLI 无 --notify-disabled，需手动改配置）
# 在 ~/.openclaw/openclaw.json 中将 notifications.enabled 设为 false
```

| 选项 | 简写 | 说明 | 默认值 |
| --- | --- | --- | --- |
| `--non-interactive` | `-n` | 启用非交互式模式 | - |
| `--watch <paths...>` | `-w` | 监听路径（可多次指定或逗号分隔） | 必填 |
| `--ollama-url <url>` | - | Ollama 服务地址 | `http://127.0.0.1:11434` |
| `--vision-model <model>` | - | 视觉模型 | `qwen3-vl:2b` |
| `--embed-model <model>` | - | 嵌入模型 | `qwen3-embedding:latest` |
| `--embedding-provider <p>` | - | 嵌入提供者: `ollama` / `openai` | `ollama` |
| `--openai-api-key <key>` | - | OpenAI API Key | - |
| `--openai-model <model>` | - | OpenAI 嵌入模型 | `text-embedding-3-small` |
| `--db-path <path>` | - | LanceDB 数据库路径 | `~/.openclaw/multimodal-rag.lance` |
| `--no-index-on-start` | - | 启动时不索引已有文件 | `false` |
| `--notify-enabled` | - | 启用索引完成通知 | 未指定时沿用已有配置，否则 `false` |
| `--notify-quiet-window <ms>` | - | 通知静默窗口（毫秒） | 未指定时沿用已有配置，否则 `30000` |
| `--notify-batch-timeout <ms>` | - | 通知批次超时（毫秒） | 未指定时沿用已有配置，否则 `600000` |

通知参数行为说明（与当前实现一致）：

- 非交互式执行时，`--notify-enabled` 仅负责“显式开启”，未传不会主动关闭通知。
- 当前没有 `--notify-disabled` 选项；要关闭通知请手动编辑 `~/.openclaw/openclaw.json`。
- `--notify-quiet-window` 和 `--notify-batch-timeout` 未传时会优先沿用已有配置，没有已有值才回退默认值。
- `notifications.agentId` / `notifications.channel` / `notifications.to` / `notifications.targets` 目前通过配置文件手动设置（setup 命令暂未提供对应参数）。
- 未配置 `targets` 且未配置 `channel+to` 时，插件会自动从 session store 选取“最近活跃会话”的 `lastChannel + lastTo` 作为通知目标。

### 手动配置

如需自定义配置，编辑 `~/.openclaw/openclaw.json`：

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
            "visionModel": "qwen3-vl:2b",
            "embedModel": "qwen3-embedding:latest"
          },
          "embedding": {
            "provider": "ollama"
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

### 配置项说明


| 配置项                          | 类型       | 默认值                                | 说明                                     |
| ---------------------------- | -------- | ---------------------------------- | -------------------------------------- |
| `watchPaths`                 | string[] | `[]`                               | 监听的文件夹路径（支持 `~` 展开）                    |
| `ollama.baseUrl`             | string   | `http://127.0.0.1:11434`           | Ollama 服务地址                            |
| `ollama.visionModel`         | string   | `qwen3-vl:2b`                      | 用于图像描述的视觉模型                            |
| `ollama.embedModel`          | string   | `qwen3-embedding:latest`           | 用于生成嵌入向量的模型                            |
| `embedding.provider`         | string   | `ollama`                           | 嵌入提供者: `ollama` 或 `openai`             |
| `embedding.openaiApiKey`     | string   | -                                  | OpenAI API Key（仅 openai 时需要）           |
| `embedding.openaiModel`      | string   | `text-embedding-3-small`           | OpenAI 嵌入模型                            |
| `dbPath`                     | string   | `~/.openclaw/multimodal-rag.lance` | LanceDB 数据库路径                          |
| `watchDebounceMs`            | number   | `1000`                             | 文件监听去抖延迟（毫秒）                           |
| `indexExistingOnStart`       | boolean  | `true`                             | 启动时是否索引已有文件                            |
| `notifications.enabled`      | boolean  | `false`                            | 启用索引完成通知（默认唤醒 agent 回复）         |
| `notifications.agentId`      | string   | `"main"`                           | 通知触发使用的 agent ID（会沿用该 agent 的性格/身份设定） |
| `notifications.quietWindowMs` | number   | `30000`                            | 静默窗口：最后一个文件处理完后等待多久再发送总结（毫秒）         |
| `notifications.batchTimeoutMs` | number   | `600000`                           | 批次最大超时：超过此时间强制发送总结（毫秒），防止大批量索引时等太久 |
| `notifications.channel`      | string   | `"last"`                           | 通知渠道（未配置 `targets` 时使用）                      |
| `notifications.to`           | string   | -                                  | 通知目标（未配置 `targets` 时使用）                      |
| `notifications.targets`      | object[] | `[]`                               | 通知目标列表（用于 `agent --reply-channel/--reply-to`）            |


配置完成后，重启 OpenClaw Gateway 使配置生效。

## 使用方法

### 索引通知（可选功能）

插件支持在索引新文件时自动发送通知。通知采用批次聚合机制，避免逐文件通知造成的消息轰炸。

#### 工作原理

1. **开始通知**：检测到第一个新文件时，插件默认用 `openclaw agent --deliver` 唤醒 agent 生成回复并发送
2. **批次聚合**：持续聚合多个文件的索引状态，避免频繁通知
3. **完成通知**：所有文件处理完成后（静默窗口到期），插件再次触发 agent 发送总结

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

**方式一：通过 setup 命令配置**

```bash
# 启用通知（使用默认参数）
openclaw multimodal-rag setup -n --watch ~/photos --notify-enabled

# 自定义通知参数
openclaw multimodal-rag setup -n \
  --watch ~/photos \
  --notify-enabled \
  --notify-quiet-window 45000 \
  --notify-batch-timeout 300000
```

**方式二：手动编辑配置文件**

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
# 交互式配置
openclaw multimodal-rag setup

# 非交互式配置
openclaw multimodal-rag setup -n --watch ~/photos --watch ~/audio

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

# 清理历史“转录失败”脏音频索引
openclaw multimodal-rag cleanup-failed-audio --confirm

# 清理“索引存在但源文件已删除”的失效索引
openclaw multimodal-rag cleanup-missing --dry-run
openclaw multimodal-rag cleanup-missing --confirm

# 清空索引
openclaw multimodal-rag clear --confirm
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
```

### 音频索引失败或统计异常

先检查依赖：

```bash
ffmpeg -version
whisper --help
which whisper
```

如果 `whisper` 找不到，执行：

```bash
pipx ensurepath
```

然后重开终端后重试。

再清理历史脏数据并重新索引：

```bash
openclaw multimodal-rag cleanup-failed-audio --confirm
openclaw multimodal-rag cleanup-missing --confirm
openclaw multimodal-rag reindex --confirm
```

## 许可证

MIT
