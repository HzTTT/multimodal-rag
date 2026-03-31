import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MediaWatcher } from "../dist/src/watcher.js";

function createWatcher() {
  return new MediaWatcher(
    {
      watchPaths: [],
      fileTypes: {
        image: [".jpg", ".png"],
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
      dbPath: join(tmpdir(), "watcher-index-path-test.db"),
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

test("indexPath recursively indexes supported files when given a directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "watcher-index-path-"));
  try {
    const nested = join(root, "nested");
    const deeper = join(nested, "deeper");
    await mkdir(deeper, { recursive: true });

    const supportedTop = join(root, "cover.jpg");
    const supportedNested = join(nested, "voice.mp3");
    const supportedDeeper = join(deeper, "photo.png");
    const ignored = join(deeper, "notes.txt");

    await writeFile(supportedTop, "jpg");
    await writeFile(supportedNested, "mp3");
    await writeFile(supportedDeeper, "png");
    await writeFile(ignored, "txt");

    const watcher = createWatcher();
    const indexed = [];
    watcher.indexFile = async (filePath) => {
      indexed.push(filePath);
      return true;
    };

    await watcher.indexPath(root);

    assert.deepEqual(
      indexed.slice().sort(),
      [supportedTop, supportedNested, supportedDeeper].sort(),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("indexPath continues indexing remaining files for a directory after a file fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "watcher-index-path-continue-"));
  try {
    const nested = join(root, "nested");
    const deeper = join(nested, "deeper");
    await mkdir(deeper, { recursive: true });

    const first = join(root, "cover.jpg");
    const failing = join(nested, "voice.mp3");
    const last = join(deeper, "photo.png");

    await writeFile(first, "jpg");
    await writeFile(failing, "mp3");
    await writeFile(last, "png");

    const watcher = createWatcher();
    const indexed = [];
    watcher.scanDirectory = async () => [first, failing, last];
    watcher.indexFile = async (filePath) => {
      indexed.push(filePath);
      return filePath !== failing;
    };

    await assert.rejects(
      watcher.indexPath(root),
      /索引失败: .*voice\.mp3/,
    );

    assert.deepEqual(
      indexed.slice().sort(),
      [first, failing, last].sort(),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
