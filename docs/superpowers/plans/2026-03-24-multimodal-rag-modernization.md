# Multimodal RAG Modernization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate `multimodal-rag` to the latest OpenClaw native plugin format while preserving the approved operator CLI surface and improving runtime robustness.

**Architecture:** Convert the plugin entry to `definePluginEntry(...)`, move config/runtime/CLI concerns into focused modules, and keep tools/service/CLI on top of one shared runtime factory. Remove the legacy setup flow, make the manifest authoritative for static config validation, and add explicit diagnostics plus tests for incomplete-config behavior.

**Tech Stack:** TypeScript (ESM), OpenClaw Plugin SDK, TypeBox, chokidar, LanceDB, Node built-in test runner

---

### Task 1: Establish the new plugin entry and runtime boundaries

**Files:**
- Create: `src/config.ts`
- Create: `src/runtime.ts`
- Create: `src/cli.ts`
- Create: `src/doctor.ts`
- Create: `test/helpers/fake-plugin-api.mjs`
- Modify: `index.ts`
- Modify: `package.json`
- Modify: `openclaw.plugin.json`
- Test: `test/plugin-entry-modernization.test.mjs`

- [ ] **Step 1: Write the failing entry registration test**

Create `test/plugin-entry-modernization.test.mjs` covering the built entry in `dist/index.js`:

```js
test("plugin exposes a native plugin entry contract with configSchema", async () => {
  const mod = await import("../dist/index.js");
  assert.equal(typeof mod.default?.register, "function");
  assert.equal(mod.default.id, "multimodal-rag");
  assert.equal(typeof mod.default.configSchema, "object");
});
```

- [ ] **Step 2: Run the test to verify it fails for the intended reason**

Run:

```bash
npm run build
node --test test/plugin-entry-modernization.test.mjs
```

Expected: FAIL because the current entry does not yet expose the native plugin contract used by the test.

- [ ] **Step 3: Implement the thin entry and shared runtime factory**

Implement:

- `index.ts` with `definePluginEntry(...)`
- `src/runtime.ts` that assembles normalized config, storage, providers, notifier, watcher
- `src/config.ts` for defaults + normalization
- `src/cli.ts` for CLI registration
- `src/doctor.ts` for diagnostics helpers
- `test/helpers/fake-plugin-api.mjs` for local registration tests without importing helpers from outside this package

- [ ] **Step 4: Run the test to verify it passes**

Run:

```bash
npm run build
node --test test/plugin-entry-modernization.test.mjs
```

Expected: PASS

- [ ] **Step 5: Build after boundary changes**

Run: `npm run build`

Expected: TypeScript build succeeds.

### Task 2: Make manifest and runtime config authoritative and aligned

**Files:**
- Modify: `openclaw.plugin.json`
- Modify: `src/config.ts`
- Modify: `src/types.ts`
- Test: `test/config-normalization.test.mjs`

- [ ] **Step 1: Write the failing config normalization test**

Create `test/config-normalization.test.mjs` against the built output:

```js
test("normalizePluginConfig applies defaults without crashing on incomplete optional providers", async () => {
  const { normalizePluginConfig } = await import("../dist/src/config.js");
  const cfg = normalizePluginConfig({});
  assert.deepEqual(cfg.watchPaths, []);
  assert.equal(cfg.embedding.provider, "ollama");
  assert.equal(cfg.whisper.provider, "local");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```bash
npm run build
node --test test/config-normalization.test.mjs
```

Expected: FAIL until the new config module exists and the behavior is implemented.

- [ ] **Step 3: Implement strict schema alignment and normalization**

Implement:

- strict `openclaw.plugin.json` schema with `additionalProperties: false`
- full schema coverage for `fileTypes`, `ollama`, `embedding`, `whisper`, `notifications`
- normalized runtime defaults in `src/config.ts`
- doctor-ready validation result helpers instead of eager plugin-load throws

- [ ] **Step 4: Run the test to verify it passes**

Run:

```bash
npm run build
node --test test/config-normalization.test.mjs
```

Expected: PASS

- [ ] **Step 5: Rebuild**

Run: `npm run build`

Expected: PASS

### Task 3: Preserve and modernize the operator CLI surface

**Files:**
- Modify: `src/cli.ts`
- Modify: `src/doctor.ts`
- Modify: `index.ts`
- Create: `test/helpers/cli-command-recorder.mjs`
- Delete: `src/setup.ts`
- Test: `test/cli-surface.test.mjs`

- [ ] **Step 1: Write the failing CLI surface test**

Create `test/helpers/cli-command-recorder.mjs` to:

- capture the `registerCli(...)` registrar from the fake plugin API
- run that registrar against a minimal fake `program` implementation
- collect the registered subcommand names under `openclaw multimodal-rag`

Then create `test/cli-surface.test.mjs` with assertions for the approved commands:

```js
test("approved operator commands remain registered", async () => {
  const commands = await loadRegisteredCommandNames();
  assert(commands.includes("stats"));
  assert(commands.includes("doctor"));
  assert(commands.includes("search"));
  assert(commands.includes("list"));
  assert(commands.includes("index"));
  assert(commands.includes("reindex"));
  assert(commands.includes("cleanup-missing"));
  assert(commands.includes("cleanup-failed-audio"));
  assert(!commands.includes("setup"));
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```bash
npm run build
node --test test/cli-surface.test.mjs
```

Expected: FAIL until the CLI is split and the command set is updated.

- [ ] **Step 3: Implement the modern CLI contract**

Implement:

- keep `stats`, `doctor`, `search`, `list`, `index`, `reindex`, `cleanup-missing`, `cleanup-failed-audio`
- remove `setup`
- remove `clear`
- document `index` as a debug/admin entry, not a config path

- [ ] **Step 4: Run the test to verify it passes**

Run:

```bash
npm run build
node --test test/cli-surface.test.mjs
```

Expected: PASS

- [ ] **Step 5: Build**

Run: `npm run build`

Expected: PASS

### Task 4: Keep service and tools usable under incomplete configuration

**Files:**
- Modify: `index.ts`
- Modify: `src/runtime.ts`
- Modify: `src/watcher.ts`
- Modify: `src/tools.ts`
- Modify: `test/watcher-move-reuse.test.mjs`
- Test: `test/incomplete-config-behavior.test.mjs`

- [ ] **Step 1: Write the failing incomplete-config behavior test**

Create `test/incomplete-config-behavior.test.mjs` with explicit deferred-failure cases against the built entry:

```js
test("plugin registration does not throw for openai embeddings without api key", async () => {
  const entry = (await import("../dist/index.js")).default;
  assert.doesNotThrow(() =>
    entry.register(createFakeApi({
      pluginConfig: {
        whisper: { provider: "zhipu", zhipuApiKey: "present-for-test" },
        embedding: { provider: "openai" },
      },
    })),
  );
});

test("plugin registration does not throw for zhipu whisper without api key", async () => {
  const entry = (await import("../dist/index.js")).default;
  assert.doesNotThrow(() =>
    entry.register(createFakeApi({
      pluginConfig: {
        whisper: { provider: "zhipu" },
        embedding: { provider: "ollama" },
      },
    })),
  );
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```bash
npm run build
node --test test/incomplete-config-behavior.test.mjs
```

Expected: FAIL because the current implementation still throws during plugin registration for these provider-specific gaps.

- [ ] **Step 3: Implement deferred hard-failure behavior**

Implement:

- plugin-load warnings instead of hard throws for incomplete optional providers
- watcher start gating when config cannot support background indexing
- precise execution-time errors in CLI/tool paths

- [ ] **Step 4: Run the test to verify it passes**

Run:

```bash
npm run build
node --test test/incomplete-config-behavior.test.mjs
```

Expected: PASS

- [ ] **Step 5: Run targeted watcher regression coverage**

Before running the regression, explicitly update `test/watcher-move-reuse.test.mjs` to import the built watcher module from `../dist/src/watcher.js`.

Run:

```bash
npm run build
node --test test/watcher-move-reuse.test.mjs
```

Expected: PASS

### Task 5: Update docs and verify end-to-end behavior locally and remotely

**Files:**
- Modify: `README.md`
- Modify: `USAGE.md`
- Modify: `AGENT_USAGE_GUIDE.md`
- Modify: `doc/multimodal-rag-technical-analysis.md`

- [ ] **Step 1: Update user docs to the new plugin flow**

Document:

- install / enable / config via native OpenClaw plugin system
- `setup` removal
- approved operator CLI commands
- `doctor` usage

- [ ] **Step 2: Run local verification**

Run:

```bash
npm run build
node --test test/plugin-entry-modernization.test.mjs
node --test test/config-normalization.test.mjs
node --test test/cli-surface.test.mjs
node --test test/incomplete-config-behavior.test.mjs
node --test test/watcher-move-reuse.test.mjs
```

Expected: all pass

- [ ] **Step 3: Run remote smoke checks on lucy**

Run on `lucy@192.168.1.108`:

```bash
openclaw plugins list | rg multimodal-rag
openclaw multimodal-rag doctor
openclaw multimodal-rag stats
openclaw multimodal-rag list --limit 5
openclaw multimodal-rag search "测试关键词" --limit 3
```

Expected: plugin loads, doctor surfaces actionable status, operator CLI works.

- [ ] **Step 4: Validate background indexing remotely**

Run on `lucy@192.168.1.108`:

```bash
openclaw multimodal-rag index /path/to/sample-media
openclaw multimodal-rag reindex --confirm
```

Expected: debug index and full reindex both behave correctly.

- [ ] **Step 5: Final review**

Confirm:

- `setup` absent
- retained CLI commands present
- docs reflect native plugin flow
- no duplicate config defaults remain
