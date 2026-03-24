import type { MultimodalRagRuntime } from "./runtime.js";
import { buildDependencyHints } from "./config.js";

export function buildMultimodalRagDoctorReport(runtime: MultimodalRagRuntime): Record<string, unknown> {
  return {
    runtimeConfig: {
      embeddingProvider: runtime.config.embedding.provider,
      whisperProvider: runtime.config.whisper.provider,
      ollamaBaseUrl: runtime.config.ollama.baseUrl,
      ollamaApiKeyConfigured: !!runtime.config.ollama.apiKey,
      visionModel: runtime.config.ollama.visionModel,
      embedModel: runtime.config.ollama.embedModel,
      dbPath: runtime.resolvedDbPath,
    },
    deferredWarnings: runtime.deferredWarnings,
    watcherStartupBlockers: runtime.watcherStartupBlockers,
    dependencyHints: buildDependencyHints(runtime.config, runtime.whisperBin),
  };
}

export function logMultimodalRagDoctorReport(
  runtime: MultimodalRagRuntime,
  logger: { info?: (msg: string) => void },
): void {
  const report = buildMultimodalRagDoctorReport(runtime);
  logger.info?.(`multimodal-rag: runtime config ${JSON.stringify(report.runtimeConfig)}`);
  logger.info?.(`multimodal-rag: dependency hints ${JSON.stringify(report.dependencyHints)}`);
}
