import { connect } from "@lancedb/lancedb";

async function debug() {
  const db = await connect("/home/lucy/.openclaw/multimodal-rag.lance");
  const table = await db.openTable("media");

  // 使用反引号包裹字段名的正确方式
  console.log("=== 测试反引号语法 ===");

  // 在 JavaScript 中，需要用普通字符串来包含反引号
  const whereClause = "`fileType` = 'image'";
  console.log("Where 子句:", whereClause);
  console.log("字符 codes:", [...whereClause].map((c) => c.charCodeAt(0)));

  const results = await table.query().where(whereClause).limit(5).toArray();
  console.log("结果数:", results.length);
  for (const r of results as any[]) {
    console.log(`  ${r.fileName}: ${r.fileType}`);
  }

  // 测试向量搜索 + 反引号 where
  console.log("\n=== 向量搜索 + 反引号 where ===");
  const embedResponse = await fetch("http://127.0.0.1:11434/api/embeddings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "qwen3-embedding:latest", prompt: "东方明珠" }),
  });
  const queryVector = (await embedResponse.json()).embedding;

  const r2 = await table
    .vectorSearch(queryVector)
    .where("`fileType` = 'image'")
    .limit(5)
    .toArray();
  console.log("结果数:", r2.length);
  for (const r of r2 as any[]) {
    console.log(`  ${r.fileName} | distance=${r._distance} | type=${r.fileType}`);
  }
}

debug().catch((e) => console.error(e));
