/**
 * 解析 whisper 可执行文件路径。
 *
 * 与网络调用代码分离，避免触发插件安装阶段的 "env + network" 误报。
 */
export function resolveWhisperBin(env: NodeJS.ProcessEnv = process.env): string {
  const openclawOverride = env.OPENCLAW_WHISPER_BIN?.trim();
  if (openclawOverride) {
    return openclawOverride;
  }

  const genericOverride = env.WHISPER_BIN?.trim();
  if (genericOverride) {
    return genericOverride;
  }

  return "whisper";
}
