import { connect } from "@lancedb/lancedb";

async function debug() {
  const embedResponse = await fetch("http://127.0.0.1:11434/api/embeddings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "qwen3-embedding:latest",
      prompt: "东方明珠",
    }),
  });
  const queryVector = (await embedResponse.json()).embedding;
  console.log("向量维度:", queryVector?.length);

  const db = await connect("/home/lucy/.openclaw/multimodal-rag.lance");
  const table = await db.openTable("media");

  // 测试不同的 where 语法
  const tests = [
    `fileType = 'image'`, // 无引号字段名 + 单引号值
    `"fileType" = 'image'`, // 引号字段名 + 单引号值
    'fileType = "image"', // 无引号字段名 + 双引号值
    '"fileType" = "image"', // 引号字段名 + 双引号值
  ];

  for (const where of tests) {
    console.log("\n测试 where 子句:", JSON.stringify(where));
    try {
      const results = await table
        .vectorSearch(queryVector)
        .where(where)
        .limit(3)
        .toArray();
      console.log("  结果数:", results.length);
      if (results.length > 0) {
        console.log(
          "  第一个结果:",
          (results[0] as any).fileName,
          (results[0] as any).fileType,
        );
      }
    } catch (e: any) {
      console.log("  错误:", e.message?.slice(0, 150));
    }
  }

  // 直接检查数据库中的 fileType 值
  console.log("\n=== 数据库中的记录 ===");
  const records = await table.query().limit(5).toArray();
  for (const r of records as any[]) {
    console.log(`  ${r.fileName}: fileType="${r.fileType}" (${typeof r.fileType})`);
  }
}

debug().catch((e) => console.error(e));
