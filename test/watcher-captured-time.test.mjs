import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MediaWatcher } from "../dist/src/watcher.js";

class FakeStorage {
  constructor() {
    this.entries = [];
    this.nextId = 1;
  }

  async findByPath(filePath) {
    return this.entries.find((entry) => entry.filePath === filePath) ?? null;
  }

  async findEntriesByHash() {
    return [];
  }

  async replaceByPath(entry) {
    await this.deleteByPath(entry.filePath);
    return this.store(entry);
  }

  async store(entry) {
    const fullEntry = { ...entry, id: `id-${this.nextId++}`, indexedAt: Date.now() };
    this.entries.push(fullEntry);
    return fullEntry;
  }

  async delete() {
    return true;
  }

  async deleteByPath(filePath) {
    const before = this.entries.length;
    this.entries = this.entries.filter((entry) => entry.filePath !== filePath);
    return before - this.entries.length;
  }

  async listAllEntries() {
    return this.entries;
  }

  async cleanupMissingEntries() {
    return { scanned: 0, missing: 0, removed: 0, missingIds: [] };
  }

  async clear() {
    this.entries = [];
  }
}

function makeJpegWithExifDate(dateTimeOriginal) {
  const exifString = Buffer.from(`${dateTimeOriginal}\0`, "ascii");

  const tiff = Buffer.alloc(64);
  tiff.write("MM", 0, "ascii");
  tiff.writeUInt16BE(0x2a, 2);
  tiff.writeUInt32BE(8, 4);

  tiff.writeUInt16BE(1, 8);
  tiff.writeUInt16BE(0x8769, 10);
  tiff.writeUInt16BE(4, 12);
  tiff.writeUInt32BE(1, 14);
  tiff.writeUInt32BE(26, 18);
  tiff.writeUInt32BE(0, 22);

  tiff.writeUInt16BE(1, 26);
  tiff.writeUInt16BE(0x9003, 28);
  tiff.writeUInt16BE(2, 30);
  tiff.writeUInt32BE(exifString.length, 32);
  tiff.writeUInt32BE(44, 36);
  tiff.writeUInt32BE(0, 40);
  exifString.copy(tiff, 44);

  const exifHeader = Buffer.from("Exif\0\0", "ascii");
  const app1Data = Buffer.concat([exifHeader, tiff]);
  const segmentLength = Buffer.alloc(2);
  segmentLength.writeUInt16BE(app1Data.length + 2, 0);

  return Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xe1]),
    segmentLength,
    app1Data,
    Buffer.from([0xff, 0xd9]),
  ]);
}

function createWatcher(storage) {
  return new MediaWatcher(
    {
      watchPaths: [],
      fileTypes: {
        image: [".jpg", ".jpeg"],
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
      dbPath: join(tmpdir(), "watcher-captured-time-test.db"),
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
    storage,
    { embed: async () => [0.25, 0.5, 0.75], getDimension: () => 3 },
    { processImage: async () => "image-description", processAudio: async () => "audio-description" },
    {},
    undefined,
  );
}

test("indexFile stores EXIF capture time into fileCreatedAt", async () => {
  const root = await mkdtemp(join(tmpdir(), "watcher-captured-time-"));
  try {
    const imagePath = join(root, "captured.jpg");
    await writeFile(imagePath, makeJpegWithExifDate("2020:12:10 13:58:52"));

    const storage = new FakeStorage();
    const watcher = createWatcher(storage);
    watcher.checkOllamaHealth = async () => true;

    const result = await watcher.indexFile(imagePath);

    assert.equal(result, true);
    assert.equal(storage.entries.length, 1);
    assert.equal(storage.entries[0].fileCreatedAt, new Date(2020, 11, 10, 13, 58, 52).getTime());
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
