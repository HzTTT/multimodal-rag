# 多模态 RAG 工具优化总结

**优化时间**: 2026-02-05  
**问题**: Agent 调用 `media_search` 后说"未找到相关媒体文件"，但 CLI 命令能找到

## 🔍 问题分析

从用户提供的截图和测试结果：

1. **CLI 搜索成功**:
   ```bash
   openclaw multimodal-rag search "东方明珠"
   # ✅ 找到 5 个相关文件（匹配度 52%, 51%, 49%, 48%, 48%）
   ```

2. **Agent 搜索失败**:
   ```
   User: "我有一张照片了一张东方明珠的照片，你帮我找出来"
   Agent: 调用 media_search
   Agent: "未找到相关媒体文件..."
   ```

## 🎯 优化方案

### 1. **改进工具描述** ⭐⭐⭐⭐⭐

**Before**:
```typescript
description: "搜索本地媒体文件。支持语义查询和时间范围过滤。..."
```

**After**:
```typescript
description: "语义搜索本地媒体文件（图片和音频）。这是主要的搜索工具，使用 AI 理解内容语义。

适用场景：
- 用户描述内容：'东方明珠的照片'、'会议录音'、'食物图片'
- 时间+内容：'上周拍的风景照'、'昨天的讨论'
- 模糊描述：'那个红色建筑'、'关于项目的对话'

重要提示：
1. query 参数应该是用户描述的内容关键词（如'东方明珠'），而非完整问句
2. 如果用户问'有没有X的照片'，将'X'作为 query
3. 返回的匹配度 >30% 即可认为相关
4. 如果未找到，建议用户提供更多关键词或调整时间范围"
```

**改进点**:
- ✅ 明确说明 `query` 应该是简短关键词
- ✅ 提供具体使用示例
- ✅ 说明匹配度阈值
- ✅ 给出未找到时的建议

### 2. **降低搜索阈值** ⭐⭐⭐⭐

**Before**: `minScore: 0.3` (30%)  
**After**: `minScore: 0.25` (25%)

**原因**: 提高召回率，减少"找不到"的误报

### 3. **优化返回格式** ⭐⭐⭐⭐⭐

**Before** (找不到时):
```typescript
{
  content: [{ type: "text", text: "未找到相关媒体文件。尝试调整查询或时间范围。" }],
  details: { count: 0 }
}
```

**After** (找不到时):
```typescript
{
  content: [{
    type: "text",
    text: `未找到与「${query}」相关的媒体文件。

数据库中共有 ${totalCount} 个已索引文件。建议：
1. 尝试使用更通用的关键词
2. 使用 media_list 工具浏览所有文件
3. 调整时间范围（如果设置了 after/before）`
  }],
  details: {
    count: 0,
    query,
    totalInDatabase: totalCount,
    suggestion: "try_broader_keywords_or_use_media_list"
  }
}
```

**After** (找到时):
```typescript
{
  content: [{
    type: "text",
    text: `✅ 找到 ${results.length} 个相关媒体文件（置信度: ${confidence}）：

1. [image] 20260203-190325.jpg (匹配度: 52%)
   📁 路径: /home/lucy/usb_data/386C-0B80/20260203-190325.jpg
   📅 时间: 2026/02/03 11:04
   📝 描述: 上海黄浦江畔的夜景，东方明珠广播电视塔...

💡 提示: 可以使用 media_describe 工具查看任一文件的完整描述。`
  }],
  details: {
    count: 5,
    query: "东方明珠",
    maxMatchScore: 52.3,
    confidence: "中",
    results: [...]
  }
}
```

**改进点**:
- ✅ 提供数据库总文件数上下文
- ✅ 给出具体的后续建议
- ✅ 添加置信度评估
- ✅ 使用 emoji 提高可读性
- ✅ 提供更多描述内容（150 字符）

### 4. **新增 media_stats 工具** ⭐⭐⭐⭐⭐

让 Agent 能先了解媒体库的整体情况：

```typescript
export function createMediaStatsTool(storage: MediaStorage) {
  return {
    name: "media_stats",
    description: "获取媒体库统计信息。当用户询问'有多少照片'、'有哪些文件'或搜索前想了解媒体库情况时使用。",
    async execute() {
      const total = await storage.count();
      return {
        content: [{
          type: "text",
          text: `📊 媒体库统计:\n\n总计: ${total} 个文件\n\n监听目录:\n- ~/mic-recordings\n- /home/lucy/usb_data`
        }],
        details: { total }
      };
    }
  };
}
```

**使用场景**:
- 用户问"有多少照片"
- 搜索失败时提供上下文
- 对话开始时了解媒体库状态

### 5. **改进 media_list 工具描述** ⭐⭐⭐

**Before**:
```typescript
description: "列出已索引的媒体文件，支持类型和时间过滤。用于浏览或统计媒体库。"
```

**After**:
```typescript
description: "浏览已索引的媒体文件列表（按时间排序）。适合以下场景：
- 用户想看所有照片/录音
- 按时间浏览：'今天的照片'、'本周的录音'
- 搜索不到时作为备选方案
- 了解特定时间段有什么文件

注意：此工具不做语义匹配，只按时间和类型过滤。如需按内容搜索请使用 media_search。"
```

### 6. **优化参数描述** ⭐⭐⭐

**Before**:
```typescript
query: Type.String({
  description: "语义搜索查询，描述你要找的内容，如'东方明珠'、'项目讨论'"
})
```

**After**:
```typescript
query: Type.String({
  description: "搜索关键词或内容描述。应该是简短的关键词，如'东方明珠'、'会议'、'食物'，而不是完整问句"
})
```

## 📊 优化前后对比

| 指标 | 优化前 | 优化后 | 改进 |
|------|--------|--------|------|
| 工具数量 | 3 | 4 | +1 (media_stats) |
| 搜索阈值 | 30% | 25% | 提高召回率 |
| 工具描述长度 | ~80 字 | ~300 字 | 更详细的指导 |
| 错误提示 | 简单 | 详细+建议 | Agent 更容易理解 |
| 上下文信息 | 无 | 总文件数 | 帮助 Agent 决策 |
| 匹配度显示 | 百分比 | 百分比+置信度 | 更直观 |

## 🎯 预期效果

### 1. **Agent 能正确提取关键词**
   - ❌ Before: `query: "我有一张照片了一张东方明珠的照片，你帮我找出来"`
   - ✅ After: `query: "东方明珠"`

### 2. **搜索成功率提高**
   - 阈值降低：30% → 25%
   - 更多边缘案例能被召回

### 3. **搜索失败时有明确指导**
   - 显示数据库总文件数
   - 提供 3 个具体建议
   - 引导使用其他工具

### 4. **Agent 能主动使用 media_stats**
   - 搜索前了解媒体库状态
   - 搜索失败后提供上下文

## 🧪 测试验证

### 测试用例 1: 基本搜索
```bash
# CLI 测试（已验证通过）
openclaw multimodal-rag search "东方明珠" --limit 5
# ✅ 找到 5 个文件（52%, 51%, 49%, 48%, 48%）
```

**期望 Agent 行为**:
```
User: "帮我找东方明珠的照片"

Agent 思考:
1. 提取关键词: "东方明珠"
2. 类型推断: "照片" → type: "image"

Agent 调用:
media_search({ query: "东方明珠", type: "image", limit: 5 })

Agent 回复:
"找到 5 张东方明珠的照片：
1. [image] 20260203-190325.jpg (52%)
   夜景，黄浦江畔的东方明珠广播电视塔...
2. [image] 20260203-190325.jpg (51%)
   ..."
```

### 测试用例 2: 搜索失败处理
```
User: "有没有富士山的照片"

Agent 调用:
media_search({ query: "富士山", type: "image" })

返回: { count: 0, totalInDatabase: 16 }

Agent 回复:
"没有找到富士山的照片。数据库中共有 16 个文件。
建议：
1. 使用其他关键词试试
2. 我可以列出所有照片让你浏览"

（可选）Agent 主动调用:
media_stats()
或
media_list({ type: "image", limit: 10 })
```

### 测试用例 3: 使用统计工具
```
User: "我的媒体库里有什么"

Agent 调用:
media_stats()

返回:
📊 媒体库统计:
总计: 16 个文件
监听目录:
- ~/mic-recordings
- /home/lucy/usb_data

Agent 回复:
"你的媒体库有 16 个文件，分布在两个监听目录。
需要我帮你搜索特定内容吗？"
```

## 📚 相关文档

- **完整使用指南**: `AGENT_USAGE_GUIDE.md`
- **用户手册**: `USAGE_FINAL.md`
- **README**: `README.md`

## ✅ 验证清单

- [x] 工具描述更新
- [x] 搜索阈值调整
- [x] 返回格式优化
- [x] 新增 media_stats 工具
- [x] 参数描述改进
- [x] 错误提示优化
- [x] 代码同步到远程
- [x] Gateway 重启成功
- [x] 插件加载正常（4 个工具）
- [ ] Agent 实际测试（待用户验证）

## 🚀 后续建议

1. **监控 Agent 使用情况**:
   - 观察 Agent 是否正确提取关键词
   - 统计搜索成功率
   - 收集 Agent 的错误处理模式

2. **进一步优化**:
   - 如果阈值 25% 还是太高，可以继续降低
   - 考虑添加查询扩展（同义词）
   - 可能需要针对中文优化 embedding

3. **用户反馈**:
   - 让用户实际测试对话效果
   - 收集"找不到"的案例
   - 调整工具描述和提示

---

**状态**: ✅ 优化完成，等待用户验证  
**下一步**: 让用户用 Agent 测试"找东方明珠的照片"场景
