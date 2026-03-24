import assert from "node:assert/strict";
import test from "node:test";
import { createFakePluginApi } from "./helpers/fake-plugin-api.mjs";

test("plugin registration does not throw for openai embeddings without api key", async () => {
  const entry = (await import("../dist/index.js")).default;

  assert.doesNotThrow(() =>
    entry.register(
      createFakePluginApi({
        pluginConfig: {
          whisper: { provider: "zhipu", zhipuApiKey: "present-for-test" },
          embedding: { provider: "openai" },
        },
      }),
    ),
  );
});

test("plugin registration does not throw for zhipu whisper without api key", async () => {
  const entry = (await import("../dist/index.js")).default;

  assert.doesNotThrow(() =>
    entry.register(
      createFakePluginApi({
        pluginConfig: {
          whisper: { provider: "zhipu" },
          embedding: { provider: "ollama" },
        },
      }),
    ),
  );
});
