import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MediaStorage } from "../dist/src/storage.js";

function makeEntry(overrides = {}) {
  return {
    filePath: overrides.filePath ?? `/tmp/${Math.random().toString(16).slice(2)}.bin`,
    fileName: overrides.fileName ?? "sample.bin",
    fileType: overrides.fileType ?? "image",
    description: overrides.description ?? "normal description",
    vector: overrides.vector ?? [0.1],
    fileHash: overrides.fileHash ?? Math.random().toString(16).slice(2),
    fileSize: overrides.fileSize ?? 123,
    fileCreatedAt: overrides.fileCreatedAt ?? Date.now(),
    fileModifiedAt: overrides.fileModifiedAt ?? Date.now(),
  };
}

test("MediaStorage creates scalar indexes for filter columns", async () => {
  const root = await mkdtemp(join(tmpdir(), "storage-scalar-indexes-"));
  try {
    const storage = new MediaStorage(join(root, "media.lance"), 1);
    await storage.store(
      makeEntry({
        fileName: "sample.jpg",
        filePath: join(root, "sample.jpg"),
        fileType: "image",
        fileHash: "hash-sample",
      }),
    );

    const indices = await storage.table.listIndices();
    const byColumn = new Map(indices.map((index) => [index.columns.join(","), index.indexType]));

    assert.equal(byColumn.get("fileType"), "Bitmap");
    assert.equal(byColumn.get("fileCreatedAt"), "BTree");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
