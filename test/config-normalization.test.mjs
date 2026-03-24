import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("normalizePluginConfig applies defaults and exposes a strict config schema", async () => {
  const { normalizePluginConfig, multimodalRagConfigSchema } = await import(
    "../dist/src/config.js"
  );

  const cfg = normalizePluginConfig({});

  assert.deepEqual(cfg.watchPaths, []);
  assert.deepEqual(cfg.fileTypes.image, [".jpg", ".jpeg", ".png", ".webp", ".gif", ".heic"]);
  assert.deepEqual(cfg.fileTypes.audio, [".wav", ".mp3", ".m4a", ".ogg", ".flac", ".aac"]);
  assert.equal(cfg.ollama.baseUrl, "http://127.0.0.1:11434");
  assert.equal(cfg.ollama.visionModel, "qwen3-vl:2b");
  assert.equal(cfg.ollama.embedModel, "qwen3-embedding:latest");
  assert.equal(cfg.embedding.provider, "ollama");
  assert.equal(cfg.embedding.openaiModel, "text-embedding-3-small");
  assert.equal(cfg.whisper.provider, "local");
  assert.equal(cfg.whisper.zhipuModel, "glm-asr-2512");
  assert.equal(cfg.whisper.language, "zh");
  assert.equal(cfg.dbPath, "~/.openclaw/multimodal-rag.lance");
  assert.equal(cfg.watchDebounceMs, 1000);
  assert.equal(cfg.indexExistingOnStart, true);
  assert.deepEqual(cfg.notifications, {
    enabled: false,
    agentId: undefined,
    quietWindowMs: 30000,
    batchTimeoutMs: 600000,
    channel: "last",
    to: undefined,
    targets: [],
  });

  assert.equal(multimodalRagConfigSchema.jsonSchema.type, "object");
  assert.equal(multimodalRagConfigSchema.jsonSchema.additionalProperties, false);
  assert.ok(multimodalRagConfigSchema.jsonSchema.properties.fileTypes);
  assert.ok(multimodalRagConfigSchema.jsonSchema.properties.ollama);
  assert.ok(multimodalRagConfigSchema.jsonSchema.properties.embedding);
  assert.ok(multimodalRagConfigSchema.jsonSchema.properties.whisper);
  assert.ok(multimodalRagConfigSchema.jsonSchema.properties.notifications);

  assert.equal(multimodalRagConfigSchema.safeParse({ unexpected: true }).success, false);
  assert.equal(
    multimodalRagConfigSchema.safeParse({ embedding: { provider: "unsupported" } }).success,
    false,
  );

  const manifest = JSON.parse(
    await readFile(new URL("../openclaw.plugin.json", import.meta.url), "utf8"),
  );
  assert.equal(manifest.configSchema.additionalProperties, false);
  assert.equal(
    manifest.configSchema.properties.embedding.properties.openaiModel.default,
    cfg.embedding.openaiModel,
  );
  assert.equal(
    manifest.configSchema.properties.whisper.properties.zhipuModel.default,
    cfg.whisper.zhipuModel,
  );
});
