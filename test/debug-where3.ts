import { connect } from "@lancedb/lancedb";

async function debug() {
  const db = await connect("/home/lucy/.openclaw/multimodal-rag.lance");
  const table = await db.openTable("media");

  // 先看看所有记录的 fileType
  console.log("=== 数据库记录 ===");
  const all = await table.query().limit(5).toArray();
  for (const r of all as any[]) {
    console.log(
      `  fileName: ${r.fileName}, fileType: "${r.fileType}", typeof: ${typeof r.fileType}`,
    );
  }

  // 测试各种 where 语法
  const tests = [
    // 不同引号组合
    `"fileType" = 'image'`,
    `"fileType" = "image"`,
    `fileType = 'image'`,
    `fileType = "image"`,
    // 使用反引号
    "`fileType` = 'image'",
    // LIKE 语法
    `"fileType" LIKE 'image'`,
    `fileType LIKE 'image'`,
    // IS 语法
    `"fileType" IS 'image'`,
    // 数字比较（确保 where 能工作）
    `"fileSize" > 0`,
    `fileSize > 0`,
  ];

  console.log("\n=== 测试 where 语法 ===");
  for (const where of tests) {
    try {
      const results = await table.query().where(where).limit(3).toArray();
      console.log(`${where.padEnd(35)} => 结果数: ${results.length}`);
    } catch (e: any) {
      console.log(`${where.padEnd(35)} => 错误: ${e.message?.slice(0, 60)}`);
    }
  }
}

debug().catch((e) => console.error(e));
