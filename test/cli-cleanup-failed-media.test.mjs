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

  description() {
    return this;
  }

  argument() {
    return this;
  }

  option() {
    return this;
  }

  action(handler) {
    this.actionHandler = handler;
    return this;
  }

  command(name) {
    const child = new FakeCommand(name);
    this.children.push(child);
    return child;
  }
}

function findChild(root, name) {
  return root.children.find((child) => child.name === name);
}

test("cleanup-failed-media command clears broken file markers as well as failed index records", async () => {
  const api = createFakePluginApi();
  let cleanedFailedEntries = 0;
  let clearedBrokenMarkers = 0;

  registerMultimodalRagCli(api, {
    embeddings: {},
    storage: {
      cleanupFailedMediaEntries: async () => {
        cleanedFailedEntries++;
        return { removed: 2, candidates: 2 };
      },
    },
    watcher: {
      clearBrokenFileMarkers: async () => {
        clearedBrokenMarkers++;
        return { removed: 3 };
      },
    },
  });

  const registrar = api._captured.commands[0];
  let root;
  const program = {
    command(name) {
      root = new FakeCommand(name);
      return root;
    },
  };
  registrar({ program });
  const cleanupCommand = findChild(root, "cleanup-failed-media");

  assert(cleanupCommand);
  assert.equal(typeof cleanupCommand.actionHandler, "function");

  const originalLog = console.log;
  const logs = [];
  console.log = (...args) => logs.push(args.join(" "));

  try {
    await cleanupCommand.actionHandler({ confirm: true });
  } finally {
    console.log = originalLog;
  }

  assert.equal(cleanedFailedEntries, 1);
  assert.equal(clearedBrokenMarkers, 1);
  assert(logs.some((line) => line.includes("失败媒体记录")));
});
