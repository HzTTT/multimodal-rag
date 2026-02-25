export { createEmbeddingProvider } from "./src/embeddings.js";
export { IndexNotifier } from "./src/notifier.js";
export { createMediaProcessor } from "./src/processor.js";
export { runNonInteractiveSetup, runSetup } from "./src/setup.js";
export { MediaStorage } from "./src/storage.js";
export {
  createMediaDescribeTool,
  createMediaListTool,
  createMediaSearchTool,
  createMediaStatsTool,
} from "./src/tools.js";
export type { PluginConfig } from "./src/types.js";
export { MediaWatcher } from "./src/watcher.js";
export { resolveWhisperBin } from "./src/whisper-bin.js";
