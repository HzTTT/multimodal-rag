import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Qwen3VLProcessor } from "../dist/src/processor.js";

test("processImage surfaces business errors instead of empty-description fallback", async () => {
  const root = await mkdtemp(join(tmpdir(), "processor-image-error-"));
  const imagePath = join(root, "sample.png");
  const originalFetch = globalThis.fetch;

  try {
    await writeFile(imagePath, "fake-png-content");

    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          code: 40000,
          msg: "登录状态已失效，请重新登录",
          data: {},
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );

    const processor = new Qwen3VLProcessor(
      "https://prod.unicorn.org.cn/cephalon/user-center/v1/model",
      "qwen3-vl:2b",
      "test-api-key",
    );

    await assert.rejects(
      processor.processImage(imagePath),
      /登录状态已失效，请重新登录/,
    );
  } finally {
    globalThis.fetch = originalFetch;
    await rm(root, { recursive: true, force: true });
  }
});
