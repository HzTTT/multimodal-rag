# Agent 使用多模态 RAG 工具指南

## 🎯 工具优化总结

为了让 Agent 更好地使用多模态 RAG 插件，我们做了以下优化：

### 1. **改进的工具描述**

- 更明确的使用场景说明
- 参数使用指导
- 常见错误提示

### 2. **新增 media_stats 工具**

- **media_describe**Agent 可以先了解媒体库状态
- 当搜索不到时提供上下文

### 3. **优化搜索阈值**

- 降低匹配阈值从 30% → 25%
- 提高召回率，减少"找不到"的情况

### 4. **改进返回格式**

- 更清晰的成功/失败提示
- 提供置信度评估
- 包含后续建议

## 📊 4 个 Agent 工具

### 1. `media_stats` - 媒体库统计（新增）

```typescript
// 使用场景：
// - 用户问"有多少照片"
// - 搜索前了解媒体库状态
// - 搜索失败时提供上下文

// 调用方式：
media_stats()

// 返回示例：
{
  total: 16,
  message: "📊 媒体库统计:\n\n总计: 16 个文件\n\n监听目录:\n- ~/mic-recordings\n- /home/lucy/usb_data"
}
```

**Agent 提示**: 当用户询问媒体库情况，或搜索前想了解有哪些文件时使用。

### 2. `media_search` - 语义搜索（主要工具）

```typescript
// 使用场景：
// ✅ "帮我找东方明珠的照片" → query: "东方明珠"
// ✅ "上周的会议录音" → query: "会议", after: "2026-01-28"
// ✅ "食物的图片" → query: "食物", type: "image"

// 调用方式：
media_search({
  query: "东方明珠",        // 简短关键词，不是完整问句
  type: "image",            // 可选: "image" | "audio" | "all"
  after: "2026-02-01",      // 可选: ISO 时间
  limit: 5                  // 可选: 返回数量
})

// 返回示例（找到）：
{
  count: 5,
  maxMatchScore: 52.3,
  confidence: "中",
  results: [
    {
      fileName: "20260203-190325.jpg",
      matchScore: 52,
      description: "上海黄浦江畔的夜景，东方明珠广播电视塔...",
      filePath: "/home/lucy/usb_data/..."
    }
  ]
}

// 返回示例（未找到）：
{
  count: 0,
  query: "东方明珠",
  totalInDatabase: 16,
  suggestion: "try_broader_keywords_or_use_media_list"
}
```

**Agent 提示**: 

- 提取用户描述中的关键词作为 `query`
- 匹配度 >30% 即可认为相关
- 未找到时，建议用户提供更多关键词或使用 `media_list`

### 3. `media_list` - 浏览文件列表

```typescript
// 使用场景：
// - 按时间浏览："今天的照片"
// - 看所有文件："有哪些录音"
// - 搜索不到时的备选方案

// 调用方式：
media_list({
  type: "image",            // 可选: 类型过滤
  after: "2026-02-05",      // 可选: 时间过滤
  limit: 10,                // 可选: 返回数量
  offset: 0                 // 可选: 分页偏移
})

// 返回示例：
{
  total: 16,
  showing: 10,
  files: [
    {
      fileName: "20260203-190325.jpg",
      type: "image",
      fileCreatedAt: "2026-02-03T11:04:13Z",
      description: "上海黄浦江畔的夜景..."
    }
  ]
}
```

**Agent 提示**: 不做语义匹配，只按时间和类型过滤。适合浏览和统计。

### 4. `media_describe` - 查看文件详情

```typescript
// 使用场景：
// - 查看搜索结果的完整描述
// - 强制重新分析文件

// 调用方式：
media_describe({
  filePath: "/home/lucy/usb_data/test.jpg",
  refresh: false            // 可选: 强制重新分析
})

// 返回示例：
{
  fileName: "test.jpg",
  type: "image",
  description: "完整的图片描述...",
  fileCreatedAt: "2026-02-03T11:04:13Z",
  indexedAt: "2026-02-05T11:15:30Z"
}
```

## 🎯 典型对话场景

### 场景 1: 用户问"有没有东方明珠的照片"

**优化前的错误做法** ❌:

```typescript
// Agent 可能会错误地将整个问句作为 query
media_search({
  query: "有没有东方明珠的照片"  // ❌ 太长，效果差
})
```

**优化后的正确做法** ✅:

```typescript
// 第 1 步: 提取关键词
media_search({
  query: "东方明珠",  // ✅ 简短关键词
  type: "image",       // ✅ 明确类型
  limit: 5
})

// 返回 5 个匹配结果 (52%, 51%, 49%, 48%, 48%)
// Agent 回复: "找到 5 张东方明珠的照片，最高匹配度 52%..."
```

### 场景 2: 搜索不到时的处理

**优化前** ❌:

```
Agent: "未找到相关媒体文件。"  // 太简单，没有帮助
```

**优化后** ✅:

```typescript
// 第 1 步: 尝试搜索
media_search({ query: "某个关键词" })
// 返回: count: 0, totalInDatabase: 16

// 第 2 步: 提供建议
Agent: "没有找到包含「某个关键词」的文件。数据库中共有 16 个文件。
建议：
1. 尝试更通用的关键词
2. 使用 media_list 浏览所有文件
3. 使用 media_stats 查看媒体库概况"

// 第 3 步: 主动调用 media_stats
media_stats()
// 让用户了解媒体库状态
```

### 场景 3: 用户问"今天有什么照片"

**正确做法** ✅:

```typescript
// 第 1 步: 按时间浏览
media_list({
  type: "image",
  after: "2026-02-05T00:00:00",  // 今天 00:00
  limit: 10
})

// 返回: 今天的所有照片列表
// Agent 回复: "今天有 X 张照片：[列表]"
```

### 场景 4: 用户问"上周去上海拍的照片"

**正确做法** ✅:

```typescript
// 组合使用时间过滤和语义搜索
media_search({
  query: "上海",
  type: "image",
  after: "2026-01-28",    // 上周开始
  before: "2026-02-04",   // 上周结束
  limit: 10
})

// 找到相关照片后，可以进一步细化：
media_search({
  query: "东方明珠",      // 更具体的地标
  after: "2026-01-28",
  before: "2026-02-04"
})
```

## 💡 Agent 使用技巧

### 1. **关键词提取**

- 用户说: "帮我找一下东方明珠的照片"
- 提取: `query: "东方明珠"`，`type: "image"`

### 2. **时间解析**

- "上周" → `after: (今天 - 7天)`
- "今天" → `after: (今天 00:00)`
- "昨天" → `after: (昨天 00:00)`, `before: (今天 00:00)`

### 3. **匹配度理解**

- > 60%: 高置信度（非常相关）
- 40-60%: 中等置信度（可能相关）
- 30-40%: 低置信度（弱相关）
- <30%: 不显示（已过滤）

### 4. **多次尝试策略**

### 5. **主动提供上下文**

- 搜索前调用 `media_stats` 了解媒体库状态
- 搜索失败时说明数据库总文件数
- 提供具体的后续建议

## 🚀 性能优化

- **搜索阈值**: 25%（平衡召回率和准确率）
- **默认返回数**: 5 个（避免过多结果）
- **描述长度**: 搜索时截断到 150 字符（减少传输量）

## 📝 调试建议

如果 Agent 还是找不到文件：

1. **检查查询关键词**:
  ```bash
   # 在服务器上测试
   openclaw multimodal-rag search "东方明珠" --limit 10
  ```
2. **查看原始描述**:
  ```bash
   openclaw multimodal-rag list --limit 5
  ```
3. **检查向量维度**:
  - 确保 embeddings 使用 `qwen3-embedding:latest` (4096 维)
4. **查看 gateway 日志**:
  ```bash
   journalctl -u openclaw-gateway.service -f
  ```

---

**最后更新**: 2026-02-05  
**工具数量**: 4 个（新增 media_stats）  
**优化重点**: 降低阈值、改进提示、增加上下文