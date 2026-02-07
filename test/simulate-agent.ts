import { connect } from "@lancedb/lancedb";

// 模拟 OllamaEmbeddingProvider
async function embed(text: string): Promise<number[]> {
  const response = await fetch("http://127.0.0.1:11434/api/embeddings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "qwen3-embedding:latest",
      prompt: text,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Ollama embedding failed: ${response.status} ${error}`);
  }

  const data = await response.json();
  return data.embedding;
}

// 模拟 MediaStorage.search
async function search(vector: number[], options: any = {}) {
  const { type = "all", after, before, limit = 5, minScore = 0.25 } = options;

  const db = await connect("/home/lucy/.openclaw/multimodal-rag.lance");
  const table = await db.openTable("media");

  let query = table.vectorSearch(vector).limit(limit * 2);

  if (type !== "all" || after || before) {
    const conditions: string[] = [];
    if (type !== "all") conditions.push(`"fileType" = '${type}'`);
    if (after) conditions.push(`"fileCreatedAt" >= ${after}`);
    if (before) conditions.push(`"fileCreatedAt" <= ${before}`);
    if (conditions.length > 0) query = query.where(conditions.join(" AND "));
  }

  const results = await query.toArray();
  console.log("LanceDB 原始结果数:", results.length);

  const mapped = results.map((row: any) => {
    const distance = row._distance ?? 0;
    const score = 1 / (1 + distance);
    return {
      entry: {
        id: row.id,
        filePath: row.filePath,
        fileName: row.fileName,
        fileType: row.fileType,
        description: row.description,
        fileCreatedAt: row.fileCreatedAt,
      },
      score,
    };
  });

  console.log(
    "映射后结果分数:",
    mapped.map((r: any) => ({ file: r.entry.fileName, score: r.score.toFixed(3) })),
  );

  const filtered = mapped.filter((r: any) => r.score >= minScore).slice(0, limit);
  console.log(`过滤后结果数 (minScore=${minScore}):`, filtered.length);

  return filtered;
}

// 模拟 execute
async function execute(params: {
  query: string;
  type?: string;
  after?: string;
  before?: string;
  limit?: number;
}) {
  const { query, type = "all", after, before, limit = 5 } = params;

  console.log("\n=== 模拟 Agent 调用 media_search ===");
  console.log("参数:", JSON.stringify(params, null, 2));

  try {
    // 生成查询向量
    console.log("\n>>> 1. 生成查询向量");
    const vector = await embed(query);
    console.log("向量维度:", vector.length);

    // 解析时间参数
    const afterTs = after ? new Date(after).getTime() : undefined;
    const beforeTs = before ? new Date(before).getTime() : undefined;

    // 搜索
    console.log("\n>>> 2. 搜索数据库");
    const results = await search(vector, {
      type,
      after: afterTs,
      before: beforeTs,
      limit,
      minScore: 0.25,
    });

    if (results.length === 0) {
      console.log("\n❌ 未找到结果");
      return { count: 0, message: "未找到相关媒体文件" };
    }

    console.log("\n✅ 找到", results.length, "个结果");
    return {
      count: results.length,
      results: results.map((r: any) => ({
        file: r.entry.fileName,
        score: (r.score * 100).toFixed(1) + "%",
        description: r.entry.description?.slice(0, 60) + "...",
      })),
    };
  } catch (error) {
    console.error("\n❌ 错误:", error);
    return { error: String(error) };
  }
}

// 测试
execute({ query: "东方明珠" }).then((result) => {
  console.log("\n=== 最终结果 ===");
  console.log(JSON.stringify(result, null, 2));
});
