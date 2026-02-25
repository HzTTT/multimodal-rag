import test from "node:test";
import assert from "node:assert/strict";
import { copyFile, mkdtemp, mkdir, readFile, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { MediaWatcher } from "../dist/watcher.js";

class FakeStorage {
  constructor(entries = []) {
    this.entries = entries.map((entry) => ({ ...entry }));
    this.nextId = entries.length + 1;
  }

  async findByPath(filePath) {
    return this.entries.find((entry) => entry.filePath === filePath) ?? null;
  }

  async findEntriesByHash(fileHash) {
    return this.entries.filter((entry) => entry.fileHash === fileHash);
  }

  async replaceByPath(entry) {
    await this.deleteByPath(entry.filePath);
    const fullEntry = {
      ...entry,
      id: `id-${this.nextId++}`,
      indexedAt: Date.now(),
    };
    this.entries.push(fullEntry);
    return fullEntry;
  }

  async store(entry) {
    const fullEntry = {
      ...entry,
      id: `id-${this.nextId++}`,
      indexedAt: Date.now(),
    };
    this.entries.push(fullEntry);
    return fullEntry;
  }

  async delete(id) {
    const index = this.entries.findIndex((entry) => entry.id === id);
    if (index >= 0) {
      this.entries.splice(index, 1);
      return true;
    }
    return false;
  }

  async deleteByPath(filePath) {
    const before = this.entries.length;
    this.entries = this.entries.filter((entry) => entry.filePath !== filePath);
    return before - this.entries.length;
  }

  async listAllEntries() {
    return this.entries.map((entry) => ({
      id: entry.id,
      filePath: entry.filePath,
      fileName: entry.fileName,
      fileType: entry.fileType,
      description: entry.description,
      fileHash: entry.fileHash,
      fileSize: entry.fileSize,
      fileCreatedAt: entry.fileCreatedAt,
      fileModifiedAt: entry.fileModifiedAt,
      indexedAt: entry.indexedAt,
    }));
  }

  async cleanupMissingEntries() {
    return { scanned: 0, missing: 0, removed: 0, missingIds: [] };
  }

  async clear() {
    this.entries = [];
  }
}

function createCallbacksRecorder() {
  const state = {
    queued: [],
    indexed: [],
    skipped: [],
    failed: [],
  };
  return {
    state,
    callbacks: {
      onFileQueued: (filePath) => state.queued.push(filePath),
      onFileIndexed: (filePath, fileType) => state.indexed.push({ filePath, fileType }),
      onFileSkipped: (filePath, fileType, reason) =>
        state.skipped.push({ filePath, fileType, reason }),
      onFileFailed: (filePath, error) => state.failed.push({ filePath, error }),
    },
  };
}

function createProcessorRecorder() {
  const state = { audioCalls: [] };
  return {
    state,
    processor: {
      processImage: async () => {
        throw new Error("image path not expected in this test");
      },
      processAudio: async (audioPath) => {
        state.audioCalls.push(audioPath);
        return `processed:${audioPath}`;
      },
    },
  };
}

function createEmbeddingsRecorder() {
  const state = { calls: [] };
  return {
    state,
    embeddings: {
      embed: async (text) => {
        state.calls.push(text);
        return [0.25, 0.5, 0.75];
      },
      getDimension: () => 3,
    },
  };
}

function createWatcher(storage, processor, embeddings, callbacks) {
  return new MediaWatcher(
    {
      watchPaths: [],
      fileTypes: {
        image: [],
        audio: [".mp3"],
      },
      ollama: {
        baseUrl: "http://localhost:11434",
        visionModel: "unused",
        embedModel: "unused",
      },
      embedding: {
        provider: "openai",
        openaiModel: "text-embedding-3-small",
      },
      dbPath: join(tmpdir(), "watcher-move-reuse-test.db"),
      watchDebounceMs: 10,
      indexExistingOnStart: false,
    },
    storage,
    embeddings,
    processor,
    {},
    callbacks,
  );
}

async function fileHashOf(filePath) {
  const content = await readFile(filePath);
  return createHash("sha256").update(content).digest("hex");
}

async function seedIndexedEntry(filePath, overrides = {}) {
  const fileStats = await stat(filePath);
  const hash = await fileHashOf(filePath);
  return {
    id: overrides.id ?? "id-seed",
    filePath,
    fileName: overrides.fileName ?? basename(filePath),
    fileType: "audio",
    description: overrides.description ?? "seeded-description",
    vector: overrides.vector ?? [0.1, 0.2, 0.3],
    fileHash: hash,
    fileSize: fileStats.size,
    fileCreatedAt: fileStats.birthtimeMs || fileStats.mtimeMs,
    fileModifiedAt: fileStats.mtimeMs,
    indexedAt: Date.now(),
  };
}

test("move (unlink -> add): reuse deleted snapshot and skip notification-worthy indexing", async () => {
  const root = await mkdtemp(join(tmpdir(), "watcher-move-unlink-add-"));
  try {
    const oldPath = join(root, "old", "clip.mp3");
    const newPath = join(root, "new", "clip.mp3");
    await mkdir(join(root, "old"), { recursive: true });
    await mkdir(join(root, "new"), { recursive: true });
    await writeFile(oldPath, "same-content");

    const seeded = await seedIndexedEntry(oldPath, { id: "id-old" });
    const storage = new FakeStorage([seeded]);
    const { state: callbackState, callbacks } = createCallbacksRecorder();
    const { state: processorState, processor } = createProcessorRecorder();
    const { state: embeddingState, embeddings } = createEmbeddingsRecorder();
    const watcher = createWatcher(storage, processor, embeddings, callbacks);

    await rename(oldPath, newPath);
    await watcher.handleFileDeleted(oldPath);
    const result = await watcher.indexFile(newPath);

    assert.equal(result, true);
    assert.equal(processorState.audioCalls.length, 0);
    assert.equal(embeddingState.calls.length, 0);
    assert.equal(callbackState.indexed.length, 0);
    assert.deepEqual(
      callbackState.skipped.filter((item) => item.filePath === newPath).map((item) => item.reason),
      ["moved"],
    );
    assert.equal(storage.entries.length, 1);
    assert.equal(storage.entries[0].filePath, newPath);
    assert.equal(storage.entries[0].description, "seeded-description");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("move (add -> unlink): reuse missing old-path candidate from storage", async () => {
  const root = await mkdtemp(join(tmpdir(), "watcher-move-add-unlink-"));
  try {
    const oldPath = join(root, "old", "clip.mp3");
    const newPath = join(root, "new", "clip.mp3");
    await mkdir(join(root, "old"), { recursive: true });
    await mkdir(join(root, "new"), { recursive: true });
    await writeFile(oldPath, "same-content");

    const seeded = await seedIndexedEntry(oldPath, { id: "id-old" });
    const storage = new FakeStorage([seeded]);
    const { state: callbackState, callbacks } = createCallbacksRecorder();
    const { state: processorState, processor } = createProcessorRecorder();
    const { state: embeddingState, embeddings } = createEmbeddingsRecorder();
    const watcher = createWatcher(storage, processor, embeddings, callbacks);

    await rename(oldPath, newPath);
    const result = await watcher.indexFile(newPath);
    await watcher.handleFileDeleted(oldPath);

    assert.equal(result, true);
    assert.equal(processorState.audioCalls.length, 0);
    assert.equal(embeddingState.calls.length, 0);
    assert.equal(callbackState.indexed.length, 0);
    assert.deepEqual(
      callbackState.skipped.filter((item) => item.filePath === newPath).map((item) => item.reason),
      ["moved"],
    );
    assert.equal(storage.entries.length, 1);
    assert.equal(storage.entries[0].filePath, newPath);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("copy keeps path-level indexing semantics", async () => {
  const root = await mkdtemp(join(tmpdir(), "watcher-copy-"));
  try {
    const oldPath = join(root, "old", "clip.mp3");
    const newPath = join(root, "new", "clip.mp3");
    await mkdir(join(root, "old"), { recursive: true });
    await mkdir(join(root, "new"), { recursive: true });
    await writeFile(oldPath, "same-content");
    await copyFile(oldPath, newPath);

    const seeded = await seedIndexedEntry(oldPath, { id: "id-old" });
    const storage = new FakeStorage([seeded]);
    const { state: callbackState, callbacks } = createCallbacksRecorder();
    const { state: processorState, processor } = createProcessorRecorder();
    const { state: embeddingState, embeddings } = createEmbeddingsRecorder();
    const watcher = createWatcher(storage, processor, embeddings, callbacks);

    const result = await watcher.indexFile(newPath);

    assert.equal(result, true);
    assert.equal(processorState.audioCalls.length, 1);
    assert.equal(embeddingState.calls.length, 1);
    assert.equal(callbackState.indexed.length, 1);
    assert.equal(callbackState.indexed[0].filePath, newPath);
    assert.equal(
      callbackState.skipped.some((item) => item.reason === "moved"),
      false,
    );
    assert.equal(storage.entries.length, 2);
    assert.equal(storage.entries.some((entry) => entry.filePath === oldPath), true);
    assert.equal(storage.entries.some((entry) => entry.filePath === newPath), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("real delete still removes indexed entry", async () => {
  const root = await mkdtemp(join(tmpdir(), "watcher-delete-"));
  try {
    const oldPath = join(root, "old", "clip.mp3");
    await mkdir(join(root, "old"), { recursive: true });
    await writeFile(oldPath, "to-delete");

    const seeded = await seedIndexedEntry(oldPath, { id: "id-old" });
    const storage = new FakeStorage([seeded]);
    const { callbacks } = createCallbacksRecorder();
    const { processor } = createProcessorRecorder();
    const { embeddings } = createEmbeddingsRecorder();
    const watcher = createWatcher(storage, processor, embeddings, callbacks);

    await unlink(oldPath);
    await watcher.handleFileDeleted(oldPath);

    assert.equal(storage.entries.length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
