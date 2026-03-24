# Multimodal RAG Plugin Modernization Design

**Date:** 2026-03-24

## Goal

把 `multimodal-rag` 从旧式 OpenClaw 扩展写法升级为最新原生插件形态，同时保留核心运维命令，去掉旧 `setup` 配置流程，并提升配置、加载和运维链路的健壮性。

## Scope

本次改造覆盖：

- 插件入口改为 `definePluginEntry(...)`
- 插件 SDK 导入改为 `openclaw/plugin-sdk/<subpath>`
- `openclaw.plugin.json` 改为严格静态 manifest
- 配置收敛到 `plugins.entries.multimodal-rag.config`
- 移除 `setup`
- 保留 `search`、`list`、`stats`、`index`、`reindex`、`cleanup-missing`、`cleanup-failed-audio`
- 新增 `doctor`
- watcher/service/tools/CLI 共用统一运行时上下文
- 增加针对新版入口、配置与运维面的测试

不在本次改造范围内：

- 改动插件 id、npm 包名或核心功能语义
- 改动媒体理解、向量存储、通知的业务能力边界
- 保留向下兼容的旧 `setup` 行为

## Current Problems

当前实现存在以下结构性问题：

1. 入口仍是手写插件对象，未按最新 SDK 推荐使用 `definePluginEntry(...)`。
2. `index.ts` 过重，同时承担配置合并、运行时装配、CLI 注册、service 注册。
3. `openclaw.plugin.json` 的 schema 与真实配置支持不完全一致，`whisper` 等字段未被严格声明。
4. 默认值、校验与错误消息分散在入口、工具和 setup 逻辑里，存在漂移风险。
5. 插件在配置未完成时会直接抛错，容易导致“安装后未配置”阶段的整插件加载失败。
6. `setup` 继续承载旧式私有配置路径，与新版 OpenClaw 插件系统的主路径冲突。

## Design Decisions

### 1. Plugin Shape

插件改成标准原生工具/服务插件：

- `index.ts` 只负责 `definePluginEntry(...)` 和注册
- `api.registerTool(...)` 继续提供 4 个 agent tools
- `api.registerCli(...)` 只提供运维/调试命令
- `api.registerService(...)` 负责 watcher 生命周期

安装、启用、配置全部回归 OpenClaw 原生流程：

- `openclaw plugins install ...`
- `openclaw plugins enable multimodal-rag`
- `plugins.entries.multimodal-rag.config`

### 2. Config Model

配置采用“两层约束”：

1. `openclaw.plugin.json`
   - 作为静态 manifest
   - 提供严格 `configSchema`
   - `additionalProperties: false`
   - `uiHints` 与字段一一对应
2. `src/config.ts`
   - 运行时默认值合并
   - 派生字段与规范化
   - provider-specific 依赖检查
   - 生成 CLI/doctor 可复用的诊断结果

运行时不再因为“可选能力未配置”就直接让整个插件注册失败。改为：

- 结构非法：由 schema 阶段阻止
- 配置不完整：插件加载成功，但 `doctor` 报告问题
- 某能力实际执行时缺依赖：在命令或工具执行时返回精确错误

### 3. Runtime Assembly

新增统一运行时上下文工厂，负责创建并缓存：

- normalized config
- resolved DB path
- embedding provider
- storage
- media processor
- notifier
- watcher

这样 tools、CLI、service 不再各自复制默认值和依赖装配逻辑。

### 4. CLI Boundary

新版仍保留运维 CLI，但角色收缩为“管理员面”。

保留命令：

- `stats`
- `doctor`
- `search`
- `list`
- `index`
- `reindex`
- `cleanup-missing`
- `cleanup-failed-audio`

移除命令：

- `setup`
- `clear`

具体定位：

- `search` / `list`: 调试命令，方便 SSH / 远程排障
- `index`: 单文件或单目录调试入口，不承担配置职责
- `doctor`: 聚合配置、路径、二进制依赖、模型服务和数据库可访问性检查
- `reindex` / `cleanup-*`: 运维修复动作

### 5. Tool Boundary

保留现有 4 个 agent tools，不改名称：

- `media_search`
- `media_list`
- `media_describe`
- `media_stats`

这些工具继续作为用户侧主入口。CLI 仅服务于人工排障和远端维护。

### 6. File Layout

计划中的主要文件职责：

- `index.ts`
  - 新版插件入口
- `src/config.ts`
  - 默认值、归一化、运行时校验、doctor 诊断输入
- `src/runtime.ts`
  - 共享上下文装配与缓存
- `src/cli.ts`
  - 运维 CLI 注册
- `src/doctor.ts`
  - 诊断逻辑
- `src/tools.ts`
  - 继续保留 4 个工具，改为消费共享运行时
- `src/setup.ts`
  - 删除
- `plugin-runtime.ts`
  - 删除或并入新的本地 barrel

## Error Handling Strategy

### Plugin Load

- 不因 `watchPaths` 为空而报错
- 不因 `whisper.provider=zhipu` 但暂未配置 key 而阻塞加载
- 不因 `embedding.provider=openai` 但暂未配置 key 而阻塞加载
- 改为 logger warning + `doctor` 输出

### Service Start

watcher 启动前检查：

- `watchPaths` 是否存在可监听路径
- 必需依赖是否满足

若条件不足：

- service 记录 warning
- 不启动 watcher
- CLI / tools / doctor 仍可继续工作

### Command / Tool Execution

在具体链路执行时再做硬校验，例如：

- `index` 音频链路需要 local whisper 时检查 `whisper` 与 `ffmpeg`
- `search` 仅依赖 embedding + storage
- `media_describe` 触发重处理时检查对应 provider 依赖

## Testing Strategy

### Local

- 构建成功
- 插件入口注册测试
- 配置归一化与未完成配置下的加载测试
- CLI `doctor` 输出测试
- CLI 保留命令注册测试

### Remote (`lucy@192.168.1.108`)

- 安装或本地路径加载插件
- 启用插件并写新版配置
- `openclaw multimodal-rag doctor`
- `openclaw multimodal-rag stats`
- `openclaw multimodal-rag list`
- `openclaw multimodal-rag search "<query>"`
- `openclaw multimodal-rag index <path>`
- watcher 对真实媒体目录的增量索引验证

## Success Criteria

满足以下条件视为完成：

1. 插件入口、SDK 导入和 manifest 均符合最新官方插件指导格式。
2. `setup` 被移除，标准配置路径生效。
3. 运维命令按确认范围保留且职责清晰。
4. 不完整配置不再导致整插件无法加载。
5. 本地验证通过，且可在 `lucy@192.168.1.108` 上完成联调。
