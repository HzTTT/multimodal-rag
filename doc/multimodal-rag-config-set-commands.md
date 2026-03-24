# Multimodal RAG `openclaw config set` Commands

以下命令按 `lucy@192.168.1.117` 当前 `multimodal-rag` 配置整理。

请先把占位符替换成真实值：

- `<OLLAMA_API_KEY>`
- `<ZHIPU_API_KEY>`

## 启用插件

```bash
openclaw config set plugins.entries.multimodal-rag.enabled true --strict-json
```

## 基础配置

```bash
openclaw config set plugins.entries.multimodal-rag.config.watchPaths '["/home/lucy/data"]' --strict-json
openclaw config set plugins.entries.multimodal-rag.config.ollama.baseUrl '"https://test.unicorn.org.cn/cephalon/user-center/v1/model"' --strict-json
openclaw config set plugins.entries.multimodal-rag.config.ollama.apiKey '"<OLLAMA_API_KEY>"' --strict-json
openclaw config set plugins.entries.multimodal-rag.config.ollama.visionModel '"qwen3-vl:2b"' --strict-json
openclaw config set plugins.entries.multimodal-rag.config.ollama.embedModel '"qwen3-embedding:latest"' --strict-json

openclaw config set plugins.entries.multimodal-rag.config.embedding.provider '"ollama"' --strict-json

openclaw config set plugins.entries.multimodal-rag.config.whisper.provider '"zhipu"' --strict-json
openclaw config set plugins.entries.multimodal-rag.config.whisper.zhipuApiKey '"<ZHIPU_API_KEY>"' --strict-json
openclaw config set plugins.entries.multimodal-rag.config.whisper.zhipuModel '"glm-asr-2512"' --strict-json

openclaw config set plugins.entries.multimodal-rag.config.dbPath '"~/.openclaw/multimodal-rag.lance"' --strict-json
openclaw config set plugins.entries.multimodal-rag.config.indexExistingOnStart true --strict-json
```

## 通知配置

```bash
openclaw config set plugins.entries.multimodal-rag.config.notifications.enabled false --strict-json
openclaw config set plugins.entries.multimodal-rag.config.notifications.quietWindowMs 30000 --strict-json
openclaw config set plugins.entries.multimodal-rag.config.notifications.batchTimeoutMs 600000 --strict-json
openclaw config set plugins.entries.multimodal-rag.config.notifications.channel '"last"' --strict-json
openclaw config set plugins.entries.multimodal-rag.config.notifications.targets '[]' --strict-json
```

## 验证

```bash
openclaw config validate
openclaw multimodal-rag doctor
```
