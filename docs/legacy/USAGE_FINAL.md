# OpenClaw 多模态 RAG 插件 - 使用指南

## ✅ 已完成功能

### 1. 自动监听与索引
插件会自动监听配置的目录，当有新的图片或音频文件添加时，会自动：
- 使用 Qwen3-VL 生成图片的详细中文描述
- 使用 Whisper 转录音频内容
- 生成向量嵌入并存储到 LanceDB

**监听的目录**：
- `~/mic-recordings`
- `/home/lucy/usb_data`

**支持的格式**：
- **图片**: `.jpg`, `.jpeg`, `.png`, `.webp`, `.gif`, `.heic`
- **音频**: `.wav`, `.mp3`, `.m4a`, `.ogg`, `.flac`, `.aac`

### 2. CLI 命令

#### 手动索引文件
```bash
openclaw multimodal-rag index /path/to/file.jpg
```

#### 查看统计
```bash
openclaw multimodal-rag stats
```

#### 列出所有文件
```bash
openclaw multimodal-rag list

# 只列出图片
openclaw multimodal-rag list --type image

# 时间过滤
openclaw multimodal-rag list --after "2026-02-01" --before "2026-02-05"

# 分页
openclaw multimodal-rag list --limit 10 --offset 0
```

#### 语义搜索
```bash
openclaw multimodal-rag search "东方明珠"

# 只搜索图片
openclaw multimodal-rag search "照片" --type image

# 时间范围搜索
openclaw multimodal-rag search "录音" --after "2026-02-05" --limit 5
```

### 3. Agent 工具

插件提供了 3 个 Agent 工具，可以在对话中使用：

1. **media_search**: 语义搜索媒体文件
   - 支持内容搜索："上周我去东方明珠拍的照片"
   - 支持时间过滤：`after`, `before` 参数
   
2. **media_describe**: 获取特定文件的详细描述

3. **media_list**: 浏览已索引的媒体文件

## 🔧 配置说明

插件配置位于 `~/.openclaw/openclaw.json`：

```json5
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
          "dbPath": "~/.openclaw/multimodal-rag.lance"
        }
      }
    }
  }
}
```

## 📊 技术栈

- **视觉理解**: Ollama Qwen3-VL (2B)
- **音频转录**: OpenAI Whisper (base model, 中文)
- **向量嵌入**: Ollama qwen3-embedding (4096 维)
- **向量数据库**: LanceDB
- **文件监听**: chokidar (支持去重和去抖动)

## 🚀 使用示例

### 场景 1：查找上周拍的照片
```bash
openclaw multimodal-rag search "东方明珠" --after "2026-01-28" --limit 3
```

### 场景 2：查看今天的录音
```bash
openclaw multimodal-rag list --type audio --after "2026-02-05"
```

### 场景 3：搜索所有餐厅照片
```bash
openclaw multimodal-rag search "餐厅 食物" --type image
```

### 场景 4：自动索引
只需将文件复制到监听目录，插件会在 1-2 秒内自动索引：
```bash
cp my_photo.jpg ~/mic-recordings/
# 等待自动索引完成...
openclaw multimodal-rag search "my_photo"
```

## ⚡ 性能

- **图片索引**: ~15 秒/张（Qwen3-VL 推理时间）
- **音频转录**: 取决于音频长度（Whisper base 模型）
- **语义搜索**: <1 秒（向量相似度搜索）
- **自动监听**: 1 秒去抖动延迟

## 🔍 故障排查

### 查看 Gateway 日志
```bash
journalctl -u openclaw-gateway.service -f
```

### 重启 Gateway
```bash
openclaw gateway restart
```

### 清空索引（谨慎使用）
```bash
openclaw multimodal-rag clear --confirm
```

## 📝 备注

- 音频转录使用的是虚拟环境：`/home/lucy/projects/multimodal-rag/venv/bin/whisper`
- 数据库位置：`/home/lucy/.openclaw/multimodal-rag.lance`
- 插件会在 Gateway 启动时自动启动文件监听服务
- 文件去重基于 SHA256 哈希，重复文件不会被重复索引

---

**最后验证时间**: 2026-02-05  
**已索引文件数**: 16 个（图片 + 音频）  
**状态**: ✅ 所有功能正常
