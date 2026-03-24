import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("built plugin entry uses definePluginEntry and focused SDK imports", async () => {
  const source = await readFile(new URL("../dist/index.js", import.meta.url), "utf8");
  assert.match(source, /definePluginEntry\s*\(/);
  assert.match(source, /openclaw\/plugin-sdk\/plugin-entry/);
  assert.match(source, /registerMultimodalRagCli/);
  assert.doesNotMatch(source, /import\s+type\s+\{\s*OpenClawPluginApi\s*\}\s+from\s+"openclaw\/plugin-sdk"/);
  assert.doesNotMatch(source, /splitCliExistingAndMissingCandidates|parseCliDate|parseCliInteger/);
});
