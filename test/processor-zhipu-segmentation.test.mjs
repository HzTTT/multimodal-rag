import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Qwen3VLProcessor } from "../dist/src/processor.js";

function createSilentWav(durationSeconds, sampleRate = 16000) {
  const channels = 1;
  const bitsPerSample = 16;
  const blockAlign = channels * (bitsPerSample / 8);
  const byteRate = sampleRate * blockAlign;
  const dataSize = durationSeconds * byteRate;
  const buffer = Buffer.alloc(44 + dataSize);

  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(bitsPerSample, 34);
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(dataSize, 40);

  return buffer;
}

test("processAudio splits long zhipu audio into sequential chunks and merges transcript text", async () => {
  const root = await mkdtemp(join(tmpdir(), "processor-zhipu-segments-"));
  const audioPath = join(root, "long.wav");
  const originalFetch = globalThis.fetch;
  const calls = [];

  try {
    await writeFile(audioPath, createSilentWav(52));

    globalThis.fetch = async (_url, _init) => {
      calls.push({ at: calls.length });
      return new Response(
        JSON.stringify({
          text: ["第一段", "第二段", "第三段"][calls.length - 1],
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    };

    const processor = new Qwen3VLProcessor(
      "https://unused.example.com",
      "unused-model",
      undefined,
      {
        provider: "zhipu",
        zhipuApiKey: "test-key",
      },
    );

    const transcript = await processor.processAudio(audioPath);

    assert.equal(calls.length, 3);
    assert.equal(transcript, "第一段 第二段 第三段");
  } finally {
    globalThis.fetch = originalFetch;
    await rm(root, { recursive: true, force: true });
  }
});
