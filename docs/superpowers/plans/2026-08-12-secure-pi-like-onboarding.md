# Secure Pi-like Onboarding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add secure cross-platform API-key onboarding and remembered global model defaults while preserving mini-Pi's five source files.

**Architecture:** `cli.ts` owns credential lookup, `@github/keytar` calls, `~/.mini-pi/config.json`, and the login/model/logout workflows. `tui.ts` parses and dispatches the new commands while existing `llm.ts`, `agent.ts`, and `tool.ts` continue to consume only a resolved key, provider, and model. Tests inject an in-memory credential/config/interactive boundary, so automated checks never access a real keychain.

**Tech Stack:** TypeScript, Node.js 22, `@github/keytar`, `@inquirer/select`, `node:test`.

---

### Task 1: Add credential and global-preference primitives in `cli.ts`

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `src/cli.ts`
- Test: `test/cli.test.ts`

- [ ] **Step 1: Write failing tests for precedence and persistent preferences**

```ts
test("environment keys override stored credentials", async () => {
  const store = fakeStore({ deepseek: "stored" });
  assert.equal(await resolveApiKey("deepseek", { DEEPSEEK_API_KEY: "env" }, store), "env");
});

test("stored credentials and a global preference produce a direct startup selection", async () => {
  const state = fakeState({ provider: "openai", model: "gpt-test" });
  const store = fakeStore({ openai: "saved" });
  assert.deepEqual(await loadSavedSelection(state, store), { provider: "openai", model: "gpt-test", apiKey: "saved" });
});
```

- [ ] **Step 2: Run the focused test file and verify RED**

Run: `npm test -- test/cli.test.ts`  
Expected: FAIL because the new exports do not exist.

- [ ] **Step 3: Add minimal safe storage helpers and the keyring dependency**

Implement in `src/cli.ts`:

```ts
type CredentialStore = {
  getPassword(service: string, account: string): Promise<string | null>;
  setPassword(service: string, account: string, value: string): Promise<void>;
  deletePassword(service: string, account: string): Promise<boolean>;
};
type GlobalPreference = { provider: ProviderName; model: string };
```

Use service `mini-Pi`; only store provider/model in `~/.mini-pi/config.json`; use `mkdir`, `readFile`, `writeFile`, and `rename` for safe preference persistence. Resolve environment variables before `CredentialStore` reads. Add exact-pinned `@github/keytar` dependency and update the lockfile without overwriting its existing version field change.

- [ ] **Step 4: Run focused tests and type checking for GREEN**

Run: `npm test -- test/cli.test.ts && npm run check`  
Expected: PASS.

- [ ] **Step 5: Commit the primitive layer**

```bash
git add package.json package-lock.json src/cli.ts test/cli.test.ts
git commit -m "feat: add secure credential preferences"
```

### Task 2: Implement Pi-like onboarding and minimal TUI commands

**Files:**
- Modify: `src/cli.ts`
- Modify: `src/tui.ts`
- Test: `test/cli.test.ts`

- [ ] **Step 1: Write failing tests for login, model change, logout, and cancellation**

```ts
test("login saves a key and default only after model selection succeeds", async () => {
  const result = await login(depsWithModel("chat"));
  assert.deepEqual(result.preference, { provider: "deepseek", model: "chat" });
});

test("a login model-list failure preserves previous saved state", async () => {
  await assert.rejects(() => login(depsWithModelFailure()), /Unable to list models/);
  assert.deepEqual(store.values, { openai: "old-key" });
});

test("new slash commands have stable parsing", () => {
  assert.deepEqual(parseCommand("/login"), { type: "login" });
  assert.deepEqual(parseCommand("/model"), { type: "model" });
  assert.deepEqual(parseCommand("/logout"), { type: "logout" });
});
```

- [ ] **Step 2: Run focused tests and verify RED**

Run: `npm test -- test/cli.test.ts`  
Expected: FAIL because onboarding functions and commands are absent.

- [ ] **Step 3: Implement the smallest command workflow**

Add a hidden password prompt through `@inquirer/password`. At startup, use a saved preference plus resolved Key to bypass provider/model prompts; otherwise run login automatically. Implement `/login`, `/model`, and `/logout` using injected actions. Do not mutate a saved key or preference until provider choice, password input, model listing, and model selection all succeed. On logout of the default provider, delete the global preference. Preserve Ctrl+C/Esc errors and existing exit code mapping.

- [ ] **Step 4: Run focused tests and type checking for GREEN**

Run: `npm test -- test/cli.test.ts && npm run check`  
Expected: PASS.

- [ ] **Step 5: Commit the interactive workflow**

```bash
git add src/cli.ts src/tui.ts test/cli.test.ts package.json package-lock.json
git commit -m "feat: add Pi-like credential onboarding"
```

### Task 3: Rewrite user documentation and complete validation

**Files:**
- Modify: `README.md`
- Modify: `DEFERRED_FEATURES.md`
- Test: `test/cli.test.ts`

- [ ] **Step 1: Write a failing command/help test if the documented commands are absent from help text**

```ts
test("help lists the credential lifecycle commands", () => {
  assert.match(helpText("/project", "openai", "gpt"), /\/login.*\/model.*\/logout/);
});
```

- [ ] **Step 2: Run the test and verify RED if the help output needs updating**

Run: `npm test -- test/cli.test.ts`  
Expected: FAIL until the TUI help text names the new commands.

- [ ] **Step 3: Rewrite README around project purpose, feature stages, and use**

Document: the learning-oriented read-only project-analysis goal; delivered v1 and v1.1 secure-onboarding stages; future stages; first run and later run commands; `/login`, `/model`, `/logout`; Keychain/Credential Vault/Secret Service behavior; Linux `libsecret` prerequisite; environment variable temporary override; and the privacy/cost warning. Move deferred scope accurately in `DEFERRED_FEATURES.md` without claiming session persistence or OAuth exists.

- [ ] **Step 4: Run complete verification**

Run: `npm test && npm run check && npm run build && npm run verify:bin && npm run verify:package && git diff --check`  
Expected: all commands PASS; `npm pack --dry-run` includes the five compiled source modules and README.

- [ ] **Step 5: Perform macOS credential smoke test and cleanup**

Run a one-off `@github/keytar` script using account `mini-pi-test-<timestamp>` to set, read, delete, then confirm absent. Do not print a real key; use a generated test string. Expected: process exits 0 and cleanup succeeds.

- [ ] **Step 6: Commit docs and final verification changes**

```bash
git add README.md DEFERRED_FEATURES.md src/tui.ts test/cli.test.ts
git commit -m "docs: explain secure mini-Pi workflow"
```
