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

test("cleanupFailedMediaEntries removes failed audio and image records but keeps healthy media", async () => {
  const root = await mkdtemp(join(tmpdir(), "storage-cleanup-failed-media-"));
  try {
    const storage = new MediaStorage(join(root, "media.lance"), 1);

    await storage.store(
      makeEntry({
        fileName: "failed-audio.mp3",
        filePath: join(root, "failed-audio.mp3"),
        fileType: "audio",
        description: "（转录失败：Whisper crashed）",
        fileHash: "hash-audio",
      }),
    );
    await storage.store(
      makeEntry({
        fileName: "failed-image.png",
        filePath: join(root, "failed-image.png"),
        fileType: "image",
        description: "Qwen3-VL processing failed: code=40000, msg=登录状态已失效，请重新登录",
        fileHash: "hash-image-failed",
      }),
    );
    await storage.store(
      makeEntry({
        fileName: "healthy-image.png",
        filePath: join(root, "healthy-image.png"),
        fileType: "image",
        description: "一间老式中式理发店，理发师正在为顾客剪发",
        fileHash: "hash-image-healthy",
      }),
    );

    const result = await storage.cleanupFailedMediaEntries();
    const remaining = await storage.listAllEntries();

    assert.equal(result.candidates, 2);
    assert.equal(result.removed, 2);
    assert.deepEqual(
      remaining.map((entry) => entry.fileName),
      ["healthy-image.png"],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
