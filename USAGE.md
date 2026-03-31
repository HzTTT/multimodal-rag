# 快速开始指南

## 安装与启用

```bash
openclaw plugins install @hzttt/multimodal-rag@latest
openclaw plugins enable multimodal-rag
```

如果你是本地开发或远程调试，也可以直接从本地路径安装：

```bash
openclaw plugins install ./multimodal-rag
openclaw plugins enable multimodal-rag
```

## 配置

插件使用 OpenClaw 原生配置路径，不再提供 `setup` 命令。

编辑 `~/.openclaw/openclaw.json`（或你的 gateway 配置文件），把配置写到
`plugins.entries.multimodal-rag.config`：

```json
{
  "plugins": {
    "entries": {
      "multimodal-rag": {
        "enabled": true,
        "config": {
          "watchPaths": ["/home/lucy/mic-recordings"],
          "ollama": {
            "baseUrl": "http://127.0.0.1:11434",
            "visionModel": "qwen3-vl:2b",
            "embedModel": "qwen3-embedding:latest"
          },
          "embedding": {
            "provider": "ollama"
          },
          "whisper": {
            "provider": "local"
          },
          "dbPath": "~/.openclaw/multimodal-rag.lance",
          "indexExistingOnStart": true
        }
      }
    }
  }
}
```

如果切换 provider，需要额外补齐：

- `embedding.provider=openai` 时，必须设置 `embedding.openaiApiKey`
- `whisper.provider=zhipu` 时，必须设置 `whisper.zhipuApiKey`

插件加载不会因为这些可选项缺失而直接失败，但相关命令会在执行时报精确错误。

## 先跑 Doctor

```bash
openclaw multimodal-rag doctor
```

建议每次修改配置后先跑一次。它会显示：

- 当前使用的 embedding / whisper provider
- 数据库路径
- 依赖提示
- 延迟失败警告
- watcher 是否因配置缺失而被禁用

## 常用命令

```bash
# 诊断
openclaw multimodal-rag doctor

# 手动索引单个文件或目录
openclaw multimodal-rag index ~/Pictures/test.jpg

# 语义搜索
openclaw multimodal-rag search "东方明珠"
openclaw multimodal-rag search "会议讨论" --type audio --limit 3

# 浏览和统计
openclaw multimodal-rag list --type image --limit 10
openclaw multimodal-rag stats

# 维护
openclaw multimodal-rag cleanup-missing --dry-run
openclaw multimodal-rag cleanup-missing --confirm
openclaw multimodal-rag cleanup-failed-media --confirm
openclaw multimodal-rag reindex --confirm
```

当前保留的 CLI 命令：

- `doctor`
- `stats`
- `search`
- `list`
- `index`
- `reindex`
- `cleanup-missing`
- `cleanup-failed-media`（旧命令 `cleanup-failed-audio` 仍兼容）

已经移除：

- `setup`
- `clear`

## 验证流程

最小验证：

```bash
openclaw multimodal-rag doctor
openclaw multimodal-rag stats
openclaw multimodal-rag list --limit 5
```

索引验证：

```bash
openclaw multimodal-rag index /path/to/sample-media
openclaw multimodal-rag search "测试关键词" --limit 3
```

## 故障排查

### 1. `doctor` 显示 provider 配置不完整

补齐对应 key：

- `embedding.openaiApiKey`
- `whisper.zhipuApiKey`

然后重新执行：

```bash
openclaw multimodal-rag doctor
```

### 2. watcher 没有启动

先看 `doctor` 输出，再确认：

- `watchPaths` 非空
- OpenAI embedding 模式下已配置 `embedding.openaiApiKey`
- OpenClaw 进程对监听目录有读权限

### 3. 本地 Whisper 不可用

```bash
ffmpeg -version
whisper --help
which whisper
```

如果 `whisper` 不在 `PATH`，可在启动 OpenClaw 前设置：

```bash
export OPENCLAW_WHISPER_BIN=/absolute/path/to/whisper
```
