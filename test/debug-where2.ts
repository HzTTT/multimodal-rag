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

  // 1. 测试纯向量搜索（不带 where）
  console.log("\n=== 测试 1: 纯向量搜索（无 where） ===");
  const r1 = await table.vectorSearch(queryVector).limit(5).toArray();
  console.log("结果数:", r1.length);
  r1.forEach((r: any) =>
    console.log(`  ${r.fileName} | distance=${r._distance} | type=${r.fileType}`),
  );

  // 2. 测试 where 条件（不带向量搜索）
  console.log("\n=== 测试 2: 纯 where 过滤（无向量） ===");
  const r2 = await table.query().where(`"fileType" = 'image'`).limit(5).toArray();
  console.log("结果数:", r2.length);
  r2.forEach((r: any) => console.log(`  ${r.fileName} | type=${r.fileType}`));

  // 3. 测试向量搜索 + prefilter
  console.log("\n=== 测试 3: vectorSearch + prefilter ===");
  try {
    const r3 = await table
      .vectorSearch(queryVector)
      .prefilter(true)
      .where(`"fileType" = 'image'`)
      .limit(5)
      .toArray();
    console.log("结果数:", r3.length);
    r3.forEach((r: any) =>
      console.log(`  ${r.fileName} | distance=${r._distance} | type=${r.fileType}`),
    );
  } catch (e: any) {
    console.log("  错误:", e.message?.slice(0, 200));
  }

  // 4. 测试先过滤再搜索
  console.log("\n=== 测试 4: 先查询获取 ID，再向量搜索 ===");
  // 获取所有 image 类型的记录
  const imageRecords = await table
    .query()
    .where(`"fileType" = 'image'`)
    .limit(100)
    .toArray();
  console.log("image 类型记录数:", imageRecords.length);

  // 获取所有记录的向量并手动计算距离
  console.log("\n手动计算前 3 个匹配结果:");
  const scored = imageRecords.map((r: any) => {
    const vec = r.vector;
    // 计算 L2 距离
    let sum = 0;
    for (let i = 0; i < queryVector.length; i++) {
      const diff = queryVector[i] - vec.get(i);
      sum += diff * diff;
    }
    const distance = Math.sqrt(sum);
    return { fileName: r.fileName, distance, description: r.description?.slice(0, 50) };
  });
  scored.sort((a, b) => a.distance - b.distance);
  scored.slice(0, 3).forEach((r) =>
    console.log(`  ${r.fileName} | distance=${r.distance.toFixed(4)} | ${r.description}...`),
  );
}

debug().catch((e) => console.error(e));
