# 快速开始指南

## ✅ 已完成的工作

1. ✅ 插件核心实现
   - 类型定义和配置 schema
   - Ollama qwen3-embedding 嵌入提供者（4096 维）
   - OpenAI 嵌入提供者（备选）
   - LanceDB 向量存储（支持时间过滤）
   - qwen3-vl 图像描述处理器
   - Chokidar 文件监听服务
   
2. ✅ Agent 工具
   - `media_search` - 时间感知的语义搜索
   - `media_describe` - 获取/刷新媒体描述
   - `media_list` - 列出已索引媒体

3. ✅ CLI 命令
   - `openclaw multimodal-rag index` - 手动索引
   - `openclaw multimodal-rag search` - 搜索
   - `openclaw multimodal-rag stats` - 统计
   - `openclaw multimodal-rag clear` - 清空

4. ✅ 测试和部署
   - 嵌入模型测试通过（4096 维，耗时 2.2s）
   - 部署脚本 `deploy.sh`
   - 已复制到远程服务器

## 🚀 下一步操作

### 1. 在远程服务器上配置 OpenClaw

SSH 到远程服务器：

```bash
ssh lucy@192.168.0.184
```

编辑 `~/.openclaw/config.json5`：

```json5
{
  plugins: {
    entries: {
      "multimodal-rag": {
        enabled: true,
        config: {
          // 监听你的文件夹
          watchPaths: ["/home/lucy/mic-recordings"],
          
          // 使用本地 Ollama
          ollama: {
            baseUrl: "http://127.0.0.1:11434",  // 本地
            visionModel: "qwen3-vl:2b",
            embedModel: "qwen3-embedding:latest"
          },
          
          embedding: {
            provider: "ollama"
          },
          
          dbPath: "~/.openclaw/multimodal-rag.lance",
          indexExistingOnStart: true
        }
      }
    }
  },
  
  tools: {
    allow: ["media_search", "media_describe", "media_list"]
  }
}
```

### 2. 测试视觉模型

准备一张测试图片，然后运行：

```bash
cd /home/lucy/projects/multimodal-rag
node test/test-vision.js /path/to/test-image.jpg
```

预期输出：
```
测试 Ollama 视觉模型:
  URL: http://127.0.0.1:11434
  Model: qwen3-vl:2b
  Image: /path/to/test-image.jpg

读取图像...
  大小: 245.67 KB

生成图像描述...
✓ 成功生成描述
  耗时: 8.32s

描述:
这张图片展示了...
```

### 3. 链接插件到 OpenClaw

在远程服务器上：

```bash
# 创建扩展目录
mkdir -p ~/.openclaw/extensions

# 创建符号链接
ln -s /home/lucy/projects/multimodal-rag ~/.openclaw/extensions/multimodal-rag
```

### 4. 启动 OpenClaw

```bash
openclaw gateway run
```

插件会自动加载并开始监听文件。

### 5. 测试完整流程

#### 手动索引测试

```bash
# 索引单个文件
openclaw multimodal-rag index ~/Pictures/test.jpg

# 查看统计
openclaw multimodal-rag stats
```

#### 搜索测试

```bash
# 基本搜索
openclaw multimodal-rag search "风景"

# 带时间过滤（查找上周的照片）
openclaw multimodal-rag search "东方明珠" --after 2026-01-29 --before 2026-02-05
```

#### Agent 对话测试

与 OpenClaw agent 对话：

```
你: 帮我找一下上周拍的照片
Agent: [调用 media_list 查看最近的照片]
      [如果有描述，返回列表]

你: 找一下有东方明珠的照片
Agent: [调用 media_search(query="东方明珠", type="image")]
      [返回匹配的照片列表]
```

## 📝 使用示例

### 示例 1：查找特定地点的照片

**用户**: 上周我去东方明珠拍的照片在哪

**Agent 行为**:
1. 解析时间："上周" → 2026-01-29 ~ 2026-02-05
2. 调用 `media_search(query="东方明珠 上海", type="image", after="2026-01-29", before="2026-02-05")`
3. 返回匹配的照片列表

### 示例 2：查找会议录音

**用户**: 昨天的项目会议录音

**Agent 行为**:
1. 解析时间："昨天" → 2026-02-04
2. 调用 `media_search(query="项目会议", type="audio", after="2026-02-04", before="2026-02-05")`
3. 返回匹配的音频文件

### 示例 3：浏览最近的照片

**用户**: 最近一周拍了哪些照片

**Agent 行为**:
1. 调用 `media_list(type="image", after="2026-01-29", limit=20)`
2. 返回照片列表

## 🔧 故障排除

### Ollama 连接失败

检查 Ollama 是否运行：

```bash
curl http://localhost:11434/api/version
```

如果失败，启动 Ollama：

```bash
ollama serve
```

### 索引速度慢

qwen3-vl:2b 在 AMD GPU 上的速度：
- 图像描述：约 5-10 秒/张
- 嵌入生成：约 2 秒/条

如需更快速度，可以：
1. 使用更小的嵌入模型：`qwen3-embedding:0.6b`
2. 减少监听路径数量
3. 关闭 `indexExistingOnStart`

### 搜索结果不准确

尝试：
1. 使用更详细的查询
2. 调整时间范围
3. 增加返回数量 `--limit 10`

## 📦 项目文件

```
extensions/multimodal-rag/
├── index.ts                  # 插件入口
├── openclaw.plugin.json      # 配置 schema
├── package.json              # 依赖
├── tsconfig.json             # TypeScript 配置
├── deploy.sh                 # 部署脚本
├── README.md                 # 完整文档
├── USAGE.md                  # 本文件
├── src/
│   ├── types.ts              # 类型定义
│   ├── embeddings.ts         # 嵌入提供者
│   ├── storage.ts            # LanceDB 存储
│   ├── processor.ts          # 媒体处理器
│   ├── watcher.ts            # 文件监听器
│   └── tools.ts              # Agent 工具
└── test/
    ├── test-embedding.js     # 嵌入测试
    └── test-vision.js        # 视觉测试
```

## 🎯 当前限制

- ❌ 音频转录未实现（需要安装 whisper）
- ⚠️ 仅支持本地文件系统（不支持网络存储）
- ⚠️ 大文件索引可能较慢

## 📚 更多信息

- 完整文档: [README.md](README.md)
- OpenClaw 插件开发: https://docs.openclaw.ai/plugin
- Ollama 文档: https://ollama.ai/docs
