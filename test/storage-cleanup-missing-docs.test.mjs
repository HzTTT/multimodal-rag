import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MediaStorage } from "../dist/src/storage.js";

function makeChunk(overrides = {}) {
  return {
    docId: overrides.docId ?? "doc-" + Math.random().toString(16).slice(2),
    filePath: overrides.filePath ?? `/tmp/${Math.random().toString(16).slice(2)}.md`,
    fileName: overrides.fileName ?? "sample.md",
    fileExt: overrides.fileExt ?? ".md",
    chunkIndex: overrides.chunkIndex ?? 0,
    totalChunks: overrides.totalChunks ?? 1,
    pageNumber: overrides.pageNumber ?? 0,
    heading: overrides.heading ?? "",
    chunkText: overrides.chunkText ?? "hello world",
    vector: overrides.vector ?? [0.1],
    fileHash: overrides.fileHash ?? "hash-" + Math.random().toString(16).slice(2),
    fileSize: overrides.fileSize ?? 123,
    fileCreatedAt: overrides.fileCreatedAt ?? Date.now(),
    fileModifiedAt: overrides.fileModifiedAt ?? Date.now(),
  };
}

test("cleanupMissingDocChunks deletes chunks whose source files are gone", async () => {
  const root = await mkdtemp(join(tmpdir(), "storage-missing-docs-"));
  try {
    const storage = new MediaStorage(join(root, "media.lance"), 1);

    const alivePath = join(root, "alive.md");
    const deadPath = join(root, "dead.md");
    await writeFile(alivePath, "alive content");
    await writeFile(deadPath, "dead content");

    await storage.storeDocChunks([
      makeChunk({ filePath: alivePath, fileName: "alive.md", docId: "d-alive", chunkIndex: 0, totalChunks: 2, fileHash: "hash-alive" }),
      makeChunk({ filePath: alivePath, fileName: "alive.md", docId: "d-alive", chunkIndex: 1, totalChunks: 2, fileHash: "hash-alive" }),
      makeChunk({ filePath: deadPath, fileName: "dead.md", docId: "d-dead", chunkIndex: 0, totalChunks: 2, fileHash: "hash-dead" }),
      makeChunk({ filePath: deadPath, fileName: "dead.md", docId: "d-dead", chunkIndex: 1, totalChunks: 2, fileHash: "hash-dead" }),
    ]);

    assert.equal(await storage.countDocChunks(), 4);

    await unlink(deadPath);

    // dry-run 不删
    const dry = await storage.cleanupMissingDocChunks({ dryRun: true });
    assert.equal(dry.scanned, 2, "scanned by unique path");
    assert.equal(dry.missingPaths, 1, "one path missing");
    assert.equal(dry.removedChunks, 0, "dry-run does not remove");
    assert.deepEqual(dry.missingFilePaths, [deadPath]);
    assert.equal(await storage.countDocChunks(), 4);

    // confirm 实际删除
    const done = await storage.cleanupMissingDocChunks({ dryRun: false });
    assert.equal(done.scanned, 2);
    assert.equal(done.missingPaths, 1);
    // doc_chunks 表里 deadPath 的 2 个 chunks 被删光
    assert.equal(await storage.countDocChunks(), 2);

    const remainingPaths = await storage.listIndexedDocPaths();
    assert.deepEqual(remainingPaths, [alivePath]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("cleanupMissingDocChunks honors limit to cap scan size", async () => {
  const root = await mkdtemp(join(tmpdir(), "storage-missing-docs-limit-"));
  try {
    const storage = new MediaStorage(join(root, "media.lance"), 1);

    // 3 个路径的源文件故意不创建（都 missing）
    const p1 = join(root, "a.md");
    const p2 = join(root, "b.md");
    const p3 = join(root, "c.md");

    await storage.storeDocChunks([
      makeChunk({ filePath: p1, fileName: "a.md", docId: "d1", fileHash: "h1" }),
      makeChunk({ filePath: p2, fileName: "b.md", docId: "d2", fileHash: "h2" }),
      makeChunk({ filePath: p3, fileName: "c.md", docId: "d3", fileHash: "h3" }),
    ]);

    const limited = await storage.cleanupMissingDocChunks({ dryRun: true, limit: 2 });
    assert.equal(limited.scanned, 2, "limit caps candidatePaths size");
    assert(limited.missingPaths <= 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("cleanupMissingDocChunks accepts explicit candidates and skips full scan", async () => {
  const root = await mkdtemp(join(tmpdir(), "storage-missing-docs-candidates-"));
  try {
    const storage = new MediaStorage(join(root, "media.lance"), 1);

    const realPath = join(root, "kept.md");
    const ghostPath = join(root, "ghost.md");
    await writeFile(realPath, "hi");

    await storage.storeDocChunks([
      makeChunk({ filePath: realPath, fileName: "kept.md", docId: "d-kept", fileHash: "h-kept" }),
      makeChunk({ filePath: ghostPath, fileName: "ghost.md", docId: "d-ghost", fileHash: "h-ghost" }),
    ]);

    // 只传 ghostPath 作为候选
    const result = await storage.cleanupMissingDocChunks({
      dryRun: false,
      candidates: [ghostPath],
    });
    assert.equal(result.scanned, 1);
    assert.equal(result.missingPaths, 1);

    // realPath 的 chunk 保留
    assert.equal(await storage.countDocChunks(), 1);
    const paths = await storage.listIndexedDocPaths();
    assert.deepEqual(paths, [realPath]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
