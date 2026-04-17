# Multimodal RAG 插件 — 贡献者向导

本文件是 Claude Code 与人类贡献者协作时的入口约定，**不重复**已经写在专题文档里的内容。技术细节请直接读 [`README.md`](./README.md) 与 [`docs/`](./docs)。

---

## 文档分布

| 文件 | 用途 | 谁应该读 |
| --- | --- | --- |
| [`README.md`](./README.md) | 一页能力概览 + 快速开始 + 文档导航 | 所有人 |
| [`docs/architecture.md`](./docs/architecture.md) | 组件拓扑、加载流程、运行时执行模型 | 修改入口/初始化逻辑前必读 |
| [`docs/storage.md`](./docs/storage.md) | LanceDB 存储层全部细节 | 改 schema、查询、清理、auto-optimize 前必读 |
| [`docs/indexing-pipeline.md`](./docs/indexing-pipeline.md) | watcher → processor → embeddings → storage 主链路 | 改 watcher、重试、broken-file、move-reuse、media 处理前必读 |
| [`docs/search-and-retrieval.md`](./docs/search-and-retrieval.md) | query → vector → score → dedupe → 自愈 | 改 minScore、置信度、未索引兜底前必读 |
| [`docs/agent-tools.md`](./docs/agent-tools.md) | 4 个 Agent 工具完整契约 | 改 tools.ts 前必读 |
| [`docs/cli-reference.md`](./docs/cli-reference.md) | 9 个 CLI 命令完整契约 | 改 cli.ts 前必读 |
| [`docs/configuration.md`](./docs/configuration.md) | 配置 schema、默认值、provider 分支 | 改 config.ts 或 manifest 前必读 |
| [`docs/notifications.md`](./docs/notifications.md) | 通知状态机、agent --deliver、目标解析 | 改 notifier.ts 前必读 |
| [`docs/operations.md`](./docs/operations.md) | doctor、broken-file、cleanup、健康检查、故障树 | 排障 / 写运维脚本时必读 |
| [`docs/http-api.md`](./docs/http-api.md) | `openclaw multimodal-rag serve` 暴露的 `/get_file_info` 与 `/search_file` 契约 | 改 http-server.ts 或对接外部系统前必读 |
| [`docs/legacy/`](./docs/legacy) | 旧版用户指南、历史优化记录、旧技术分析 | 仅作历史参考，**不要再更新** |

---

## 代码与文档的对齐契约

1. **代码是唯一真相**。文档里所有事实都用 `路径:行号` 锚定到源文件。修改代码时同步更新对应专题文档，不要让文档悄悄漂移。
2. **不要在文档里硬编码版本号**。版本由 `package.json` 与 `openclaw.plugin.json` 通过 `scripts/sync-version.mjs` 维护一致。
3. **不要写"未来计划/TODO/性能优化建议"到文档**。这些信息属于 Issue/PR，不是稳定文档的一部分。
4. **公开 API 改动**：tools.ts / cli.ts / config schema / 通知行为变更必须更新 `docs/agent-tools.md` / `docs/cli-reference.md` / `docs/configuration.md` / `docs/notifications.md`。
5. **新增文档**：放到 `docs/` 下，并在 README 与本文件的"文档分布"表里登记。

---

## 模块责任图

```
插件入口（index.ts）
  └─ 插件运行时初始化（runtime.ts）
       ├─ 配置归一化与依赖提示（config.ts）
       ├─ 嵌入服务（embeddings.ts，Ollama / OpenAI）
       ├─ 存储层（storage.ts，LanceDB + 自动优化 + 失效清理）
       ├─ 媒体处理器（processor.ts，图像理解 + 音频转录）
       │    └─ Whisper 路径解析（whisper-bin.ts）
       ├─ 媒体拍摄时间解析（media-timestamps.ts，EXIF / PNG tIME / ffprobe）
       ├─ 监听服务（watcher.ts，文件队列 + 重试 + broken-file + 移动复用 + 启动自愈）
       ├─ 通知器（notifier.ts，批次状态机 + agent 主动回复）
       ├─ Agent 工具（tools.ts，4 个工具）
       ├─ CLI 命令（cli.ts，9 个命令）
       └─ 诊断报告（doctor.ts）
```

---

## 协作约定

- **测试目录** `test/` 包含调试脚本（`debug-where*.ts`、`simulate-agent.ts`）与正式 `*.test.mjs` 测试。改 storage / watcher / processor 时优先扩展现有 `*.test.mjs`。
- **部署**：`deploy.sh` 用 rsync 推到目标主机并重启 gateway。代码或配置改动后用它快速验证远程行为。
- **远程日志**：参见 [`docs/operations.md`](./docs/operations.md) §9（索引事件 JSON 行）。
- **版本同步**：`npm version` / `prepack` 自动调用 `scripts/sync-version.mjs` 同步 manifest 与 package。
- **远程开发约定**（仅参考）：项目曾运行在 Ubuntu 25.10 + AMD Ryzen AI MAX+ 395 + AMD Radeon 8060S (ROCm) 主机；硬件细节不影响插件本身的可移植性。

---

## 修改某个模块前的清单

| 改动目标 | 必读文档 |
| --- | --- |
| 新增/修改 Agent 工具 | `docs/agent-tools.md` + `docs/architecture.md` §4 |
| 新增/修改 CLI 命令 | `docs/cli-reference.md` |
| 新增配置字段 | `docs/configuration.md` + manifest configSchema/uiHints + `src/config.ts` 默认值与 normalize |
| 改 watcher 行为 | `docs/indexing-pipeline.md`（队列 / 重试 / broken-file / move-reuse 章节） |
| 改 storage schema 或查询 | `docs/storage.md`（表结构 / where 回退 / auto-optimize 章节） |
| 改通知行为 | `docs/notifications.md`（状态机 / 目标解析 / agent 命令构造） |
| 改 doctor / cleanup | `docs/operations.md` |
| 加新 provider（embedding / 音频） | `docs/configuration.md` provider 分支决策图 + `docs/indexing-pipeline.md` 媒体处理子链路 |

> 默认情况下，写完代码后**至少更新一篇专题文档**与 README 的能力一览（如果是公开能力变化）。
