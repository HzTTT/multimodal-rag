import assert from "node:assert/strict";
import test from "node:test";
import { loadRegisteredCommandNames } from "./helpers/cli-command-recorder.mjs";

test("approved operator commands remain registered", async () => {
  const commands = await loadRegisteredCommandNames();

  assert(commands.includes("stats"));
  assert(commands.includes("doctor"));
  assert(commands.includes("search"));
  assert(commands.includes("list"));
  assert(commands.includes("index"));
  assert(commands.includes("reindex"));
  assert(commands.includes("cleanup-missing"));
  assert(commands.includes("cleanup-failed-audio"));
  assert(!commands.includes("setup"));
  assert(!commands.includes("clear"));
});
