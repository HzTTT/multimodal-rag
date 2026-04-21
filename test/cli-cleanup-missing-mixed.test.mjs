import assert from "node:assert/strict";
import test from "node:test";
import { registerMultimodalRagCli } from "../dist/src/cli.js";
import { createFakePluginApi } from "./helpers/fake-plugin-api.mjs";

class FakeCommand {
  constructor(name) {
    this.name = name;
    this.children = [];
    this.actionHandler = null;
  }
  description() { return this; }
  argument() { return this; }
  option() { return this; }
  action(handler) { this.actionHandler = handler; return this; }
  command(name) { const c = new FakeCommand(name); this.children.push(c); return c; }
}

function findChild(root, name) {
  return root.children.find((c) => c.name === name);
}

function buildRoot(api) {
  const registrar = api._captured.commands[0];
  let root;
  const program = {
    command(name) { root = new FakeCommand(name); return root; },
  };
  registrar({ program });
  return root;
}

function captureLogs(fn) {
  const originalLog = console.log;
  const originalError = console.error;
  const logs = [];
  const errors = [];
  console.log = (...a) => logs.push(a.join(" "));
  console.error = (...a) => errors.push(a.join(" "));
  return (async () => {
    try {
      await fn();
    } finally {
      console.log = originalLog;
      console.error = originalError;
    }
    return { logs, errors };
  })();
}

test("cleanup-missing invokes both media and doc cleanups and reports each bucket", async () => {
  const api = createFakePluginApi();
  const calls = [];

  registerMultimodalRagCli(api, {
    embeddings: {},
    storage: {
      cleanupMissingEntries: async (opts) => {
        calls.push({ kind: "media", opts });
        return { scanned: 5, missing: 2, removed: 2, missingIds: [] };
      },
      cleanupMissingDocChunks: async (opts) => {
        calls.push({ kind: "doc", opts });
        return {
          scanned: 3,
          missingPaths: 1,
          removedChunks: 1,
          missingFilePaths: [],
        };
      },
    },
    watcher: {},
  });

  const root = buildRoot(api);
  const cmd = findChild(root, "cleanup-missing");
  assert(cmd);

  const { logs } = await captureLogs(async () => {
    await cmd.actionHandler({ confirm: true });
  });

  assert(calls.some((c) => c.kind === "media"), "media cleanup should be invoked");
  assert(calls.some((c) => c.kind === "doc"), "doc cleanup should be invoked");

  const combined = logs.join("\n");
  assert(combined.includes("媒体"), "output should mention 媒体");
  assert(combined.includes("文档"), "output should mention 文档");
  assert(combined.includes("扫描 5 条"));
  assert(combined.includes("扫描 3 份"));
  assert(combined.includes("删除 2 条"));
});

test("cleanup-missing --dry-run does not remove anything but still scans both tables", async () => {
  const api = createFakePluginApi();
  let dryMedia;
  let dryDoc;

  registerMultimodalRagCli(api, {
    embeddings: {},
    storage: {
      cleanupMissingEntries: async (opts) => {
        dryMedia = opts.dryRun;
        return { scanned: 2, missing: 0, removed: 0, missingIds: [] };
      },
      cleanupMissingDocChunks: async (opts) => {
        dryDoc = opts.dryRun;
        return { scanned: 1, missingPaths: 0, removedChunks: 0, missingFilePaths: [] };
      },
    },
    watcher: {},
  });

  const root = buildRoot(api);
  const cmd = findChild(root, "cleanup-missing");

  const { logs } = await captureLogs(async () => {
    await cmd.actionHandler({ dryRun: true });
  });

  assert.equal(dryMedia, true);
  assert.equal(dryDoc, true);
  const combined = logs.join("\n");
  assert(combined.includes("预览完成"));
  assert(combined.includes("未执行删除"));
});

test("list type=all renders media then documents, calling both storage APIs", async () => {
  const api = createFakePluginApi();
  const called = { list: 0, listDocSummaries: 0 };

  registerMultimodalRagCli(api, {
    embeddings: {},
    storage: {
      list: async () => {
        called.list++;
        return {
          total: 1,
          entries: [
            {
              id: "img-1",
              filePath: "/nonexistent/img.png",
              fileName: "img.png",
              fileType: "image",
              description: "an image",
              fileHash: "h1",
              fileSize: 1,
              fileCreatedAt: Date.now(),
              fileModifiedAt: Date.now(),
              indexedAt: Date.now(),
            },
          ],
        };
      },
      cleanupMissingEntries: async () => ({ scanned: 1, missing: 1, removed: 1, missingIds: [] }),
      cleanupMissingDocChunks: async () => ({
        scanned: 1,
        missingPaths: 1,
        removedChunks: 1,
        missingFilePaths: [],
      }),
      listDocSummaries: async () => {
        called.listDocSummaries++;
        return {
          total: 1,
          docs: [
            {
              docId: "doc-1",
              filePath: "/nonexistent/notes.md",
              fileName: "notes.md",
              fileExt: ".md",
              totalChunks: 1,
              fileSize: 123,
              fileCreatedAt: Date.now(),
              fileModifiedAt: Date.now(),
              indexedAt: Date.now(),
              snippet: "some snippet",
              topPageNumber: 0,
              topHeading: "",
            },
          ],
        };
      },
    },
    watcher: {},
  });

  const root = buildRoot(api);
  const cmd = findChild(root, "list");

  await captureLogs(async () => {
    await cmd.actionHandler({ type: "all" });
  });

  assert.equal(called.list, 1, "media list should be queried on type=all");
  assert.equal(called.listDocSummaries, 1, "doc list should also be queried on type=all");
});

test("list type=document skips media and only calls listDocSummaries", async () => {
  const api = createFakePluginApi();
  const called = { list: 0, listDocSummaries: 0 };

  registerMultimodalRagCli(api, {
    embeddings: {},
    storage: {
      list: async () => {
        called.list++;
        return { total: 0, entries: [] };
      },
      cleanupMissingEntries: async () => ({ scanned: 0, missing: 0, removed: 0, missingIds: [] }),
      cleanupMissingDocChunks: async () => ({
        scanned: 0,
        missingPaths: 0,
        removedChunks: 0,
        missingFilePaths: [],
      }),
      listDocSummaries: async () => {
        called.listDocSummaries++;
        return { total: 0, docs: [] };
      },
    },
    watcher: {},
  });

  const root = buildRoot(api);
  const cmd = findChild(root, "list");

  await captureLogs(async () => {
    await cmd.actionHandler({ type: "document" });
  });

  assert.equal(called.list, 0, "media list should NOT be queried on type=document");
  assert.equal(called.listDocSummaries, 1);
});

test("list type=image only calls media list (documents skipped)", async () => {
  const api = createFakePluginApi();
  const called = { list: 0, listDocSummaries: 0 };

  registerMultimodalRagCli(api, {
    embeddings: {},
    storage: {
      list: async () => {
        called.list++;
        return { total: 0, entries: [] };
      },
      cleanupMissingEntries: async () => ({ scanned: 0, missing: 0, removed: 0, missingIds: [] }),
      cleanupMissingDocChunks: async () => ({
        scanned: 0,
        missingPaths: 0,
        removedChunks: 0,
        missingFilePaths: [],
      }),
      listDocSummaries: async () => {
        called.listDocSummaries++;
        return { total: 0, docs: [] };
      },
    },
    watcher: {},
  });

  const root = buildRoot(api);
  const cmd = findChild(root, "list");

  await captureLogs(async () => {
    await cmd.actionHandler({ type: "image" });
  });

  assert.equal(called.list, 1);
  assert.equal(called.listDocSummaries, 0, "docs should NOT be listed on type=image");
});
