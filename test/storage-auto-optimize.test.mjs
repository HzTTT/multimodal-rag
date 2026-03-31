import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
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

test("MediaStorage schedules optimize asynchronously after writes", async () => {
  const root = await mkdtemp(join(tmpdir(), "storage-auto-optimize-"));
  try {
    const storage = new MediaStorage(join(root, "media.lance"), 1, {
      autoOptimizeThreshold: 1,
      autoOptimizeIdleMs: 10,
    });

    await storage.ensureInitialized();

    let optimizeCalls = 0;
    storage.table.optimize = async () => {
      optimizeCalls++;
      return {
        compaction: {
          fragmentsRemoved: 0,
          fragmentsAdded: 0,
          filesRemoved: 0,
          filesAdded: 0,
        },
        prune: {
          bytesRemoved: 0,
          oldVersionsRemoved: 0,
        },
      };
    };

    await storage.store(
      makeEntry({
        fileName: "sample.jpg",
        filePath: join(root, "sample.jpg"),
        fileType: "image",
        fileHash: "hash-sample",
      }),
    );

    assert.equal(optimizeCalls, 0);
    await delay(50);
    assert.equal(optimizeCalls, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
