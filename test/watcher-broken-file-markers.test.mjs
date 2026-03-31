import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MediaWatcher } from "../dist/src/watcher.js";

function createWatcher(dbPath) {
  return new MediaWatcher(
    {
      watchPaths: [],
      fileTypes: {
        image: [".png", ".jpg", ".jpeg"],
        audio: [".mp3"],
      },
      ollama: {
        baseUrl: "http://localhost:11434",
        visionModel: "unused",
        embedModel: "unused",
      },
      embedding: {
        provider: "openai",
        openaiApiKey: "test-key",
        openaiModel: "text-embedding-3-small",
      },
      whisper: {
        provider: "local",
        language: "zh",
        zhipuModel: "unused",
      },
      dbPath,
      watchDebounceMs: 10,
      indexExistingOnStart: false,
      notifications: {
        enabled: false,
        quietWindowMs: 30000,
        batchTimeoutMs: 600000,
        channel: "last",
        targets: [],
      },
    },
    {},
    { embed: async () => [0.1], getDimension: () => 1 },
    {
      processImage: async () => "unused",
      processAudio: async () => "unused",
    },
    {},
    undefined,
  );
}

test("clearBrokenFileMarkers loads persisted markers and removes them", async () => {
  const root = await mkdtemp(join(tmpdir(), "watcher-broken-markers-"));
  try {
    const dbPath = join(root, "media.lance");
    const filePath = join(root, "sample.png");
    await writeFile(filePath, "content");

    const watcherThatMarked = createWatcher(dbPath);
    await watcherThatMarked.markFileAsBroken(filePath, "Qwen3-VL processing failed: code=40000");

    const freshWatcher = createWatcher(dbPath);
    const removed = await freshWatcher.clearBrokenFileMarkers();

    assert.equal(removed.removed, 1);
    assert.equal(await freshWatcher.shouldSkipBrokenFile(filePath), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
