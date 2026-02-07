# Multimodal RAG Plugin

OpenClaw 多模态 RAG 插件 — 使用本地 AI 模型对图像和音频进行语义索引与时间感知搜索。

## 功能特性

- **图像索引**：使用 Qwen3-VL 自动描述图像内容并生成嵌入向量
- **音频索引**：使用 Whisper 转录音频并生成嵌入向量
- **语义搜索**：基于向量相似度的语义检索，支持中英文
- **时间过滤**：按文件创建时间范围过滤搜索结果
- **自动监听**：实时监听文件夹变化，自动索引新增文件
- **向量存储**：使用 LanceDB 高效存储和检索
- **智能去重**：基于文件 SHA256 哈希去重

## 前置条件

- [Ollama](https://ollama.ai) 已安装并运行
- 以下 Ollama 模型已拉取：
  - `qwen3-vl:2b` (视觉模型，图像描述)
  - `qwen3-embedding:latest` (嵌入模型，向量生成)

```bash
# 安装模型
ollama pull qwen3-vl:2b
ollama pull qwen3-embedding:latest
```

## 安装

### 方式一：从 npm 安装（推荐）

```bash
openclaw plugins install multimodal-rag
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
- **数据库路径**: `/home/lucy/.openclaw/multimodal-rag.lance`
- **启动时索引**: `true` (自动索引已有文件)

你只需要指定要监听的文件夹路径即可。

### 手动配置

如需自定义配置，编辑 `~/.openclaw/openclaw.json`：

```json
{
  "plugins": {
    "entries": {
      "multimodal-rag": {
        "enabled": true,
        "config": {
          "watchPaths": ["~/mic-recordings", "/home/lucy/usb_data"],
          "ollama": {
            "baseUrl": "http://127.0.0.1:11434",
            "visionModel": "qwen3-vl:2b",
            "embedModel": "qwen3-embedding:latest"
          },
          "embedding": {
            "provider": "ollama"
          },
          "dbPath": "/home/lucy/.openclaw/multimodal-rag.lance",
          "indexExistingOnStart": true
        }
      }
    }
  }
}
```

### 配置项说明

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `watchPaths` | string[] | `[]` | 监听的文件夹路径（支持 `~` 展开） |
| `ollama.baseUrl` | string | `http://127.0.0.1:11434` | Ollama 服务地址 |
| `ollama.visionModel` | string | `qwen3-vl:2b` | 用于图像描述的视觉模型 |
| `ollama.embedModel` | string | `qwen3-embedding:latest` | 用于生成嵌入向量的模型 |
| `embedding.provider` | string | `ollama` | 嵌入提供者: `ollama` 或 `openai` |
| `embedding.openaiApiKey` | string | - | OpenAI API Key（仅 openai 时需要） |
| `embedding.openaiModel` | string | `text-embedding-3-small` | OpenAI 嵌入模型 |
| `dbPath` | string | `~/.openclaw/multimodal-rag.lance` | LanceDB 数据库路径 |
| `watchDebounceMs` | number | `1000` | 文件监听去抖延迟（毫秒） |
| `indexExistingOnStart` | boolean | `true` | 启动时是否索引已有文件 |

配置完成后，重启 OpenClaw Gateway 使配置生效。

## 使用方法

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

# 清空索引
openclaw multimodal-rag clear --confirm
```

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

## 许可证

MIT
