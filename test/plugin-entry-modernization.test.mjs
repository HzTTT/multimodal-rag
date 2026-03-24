import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("built plugin entry exposes the native contract without runtime sdk import", async () => {
  const source = await readFile(new URL("../dist/index.js", import.meta.url), "utf8");
  const mod = await import("../dist/index.js");

  assert.equal(typeof mod.default?.register, "function");
  assert.equal(mod.default?.id, "multimodal-rag");
  assert.equal(typeof mod.default?.configSchema, "object");
  assert.match(source, /registerMultimodalRagCli/);
  assert.doesNotMatch(source, /openclaw\/plugin-sdk\/plugin-entry/);
  assert.doesNotMatch(source, /definePluginEntry\s*\(/);
  assert.doesNotMatch(source, /splitCliExistingAndMissingCandidates|parseCliDate|parseCliInteger/);
});
