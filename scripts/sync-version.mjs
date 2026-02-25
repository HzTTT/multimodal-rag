#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");

const packageJsonPath = path.join(rootDir, "package.json");
const pluginManifestPath = path.join(rootDir, "openclaw.plugin.json");

async function main() {
  const pkgRaw = await readFile(packageJsonPath, "utf8");
  const manifestRaw = await readFile(pluginManifestPath, "utf8");

  const pkg = JSON.parse(pkgRaw);
  const manifest = JSON.parse(manifestRaw);

  if (typeof pkg.version !== "string" || pkg.version.trim().length === 0) {
    throw new Error("package.json version is missing or invalid");
  }

  const nextVersion = pkg.version.trim();
  const prevVersion = manifest.version;

  if (prevVersion === nextVersion) {
    console.log(`[sync:version] already in sync (${nextVersion})`);
    return;
  }

  const versionFieldPattern = /("version"\s*:\s*)"([^"]*)"/;
  const nextManifestRaw = versionFieldPattern.test(manifestRaw)
    ? manifestRaw.replace(versionFieldPattern, `$1"${nextVersion}"`)
    : `${JSON.stringify({ ...manifest, version: nextVersion }, null, 2)}\n`;

  await writeFile(pluginManifestPath, nextManifestRaw, "utf8");
  console.log(`[sync:version] openclaw.plugin.json: ${String(prevVersion)} -> ${nextVersion}`);
}

main().catch((err) => {
  console.error("[sync:version] failed:", err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
