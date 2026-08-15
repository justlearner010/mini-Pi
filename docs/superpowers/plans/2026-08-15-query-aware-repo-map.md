# Query-aware Repo Map Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build one bounded syntax-only TS/JS repository index per CLI process, give every Agent run a question-specific transient Repo Map, and add one SAFE `query_repo_map` refinement Tool that reduces exploratory source reads.

**Architecture:** `tool.ts` owns discovery, AST extraction, the immutable index, ranking, rendering, and the bound Tool. `agent.ts` owns transient per-run context and bounded Tool-history replacement. `cli.ts` owns one index lifecycle; `tui.ts` exposes summary status only. Deterministic scripts compare no-map, 4,000-character, and 8,000-character variants.

**Tech Stack:** Node.js 22, TypeScript 5.9 syntax-only Compiler API, `ignore@7.0.6`, `tsx` tests.

---

## Files

- Modify `src/tool.ts`, `src/agent.ts`, `src/cli.ts`, `src/tui.ts`.
- Modify `test/tool.test.ts`, `test/agent.test.ts`, `test/cli.test.ts`.
- Modify `package.json`, `package-lock.json`, and `README.md`.
- Create `scripts/benchmark-query-repo-map.mjs` and `scripts/verify-query-repo-map.mjs`.
- Create `docs/experiments/9-query-aware-repo-map.md`.
- Remove the obsolete `2026-08-14-compact-project-map.md` plan.

### Task 1: Bounded and ignored source discovery

**Files:** `package.json`, `package-lock.json`, `src/tool.ts`, `test/tool.test.ts`

- [ ] **Step 1: Pin dependency**

Run `npm install --save-exact ignore@7.0.6`.

Expected: exact version only; no unrelated upgrade.

- [ ] **Step 2: Write failing tests**

```ts
assert.deepEqual(REPOSITORY_INDEX_LIMITS, {
  maxFiles: 5_000,
  maxFileBytes: 512 * 1024,
  maxTotalBytes: 50 * 1024 * 1024
});
const rootDir = await project({
  ".gitignore": "ignored/\n!ignored/keep.ts\n*.generated.ts\n",
  "src/a.ts": "export const a = 1",
  "types/api.d.ts": "export interface Api {}",
  "ignored/drop.ts": "export const drop = 1",
  "ignored/keep.ts": "export const keep = 1",
  "src/skip.generated.ts": "export const generated = 1",
  "node_modules/pkg/index.ts": "export const dependency = 1",
  ".cache/hidden.ts": "export const hidden = 1",
  "script.py": "print('unsupported')"
});
const result = await discoverRepositorySources(rootDir);
assert.deepEqual(result.files.map((file) => file.path), [
  "ignored/keep.ts", "src/a.ts", "types/api.d.ts"
]);
assert.equal(result.unsupportedLanguageFiles, 1);
```

Add exact-boundary cases using injected small limits for file count, per-file
bytes, and total bytes. Add directory/file symlink, invalid UTF-8, lexical
order, and nested `.gitignore` unsupported-scope cases.

- [ ] **Step 3: Verify RED**

Run `npx tsx --test --test-name-pattern="repository discovery" test/tool.test.ts`.

Expected: discovery exports are missing.

- [ ] **Step 4: Implement contracts**

```ts
export interface RepositoryIndexLimits {
  maxFiles: number; maxFileBytes: number; maxTotalBytes: number;
}
export const REPOSITORY_INDEX_LIMITS: RepositoryIndexLimits = {
  maxFiles: 5_000, maxFileBytes: 512 * 1024, maxTotalBytes: 50 * 1024 * 1024
};
export type SourceKind = "ts" | "tsx" | "js" | "jsx" | "dts";
export interface DiscoveredSource {
  path: string; sourceKind: SourceKind; bytes: number; text: string;
}
export async function discoverRepositorySources(
  rootDir: string,
  limits: RepositoryIndexLimits = REPOSITORY_INDEX_LIMITS
): Promise<RepositoryDiscovery>;
```

Use sorted traversal, fatal UTF-8 decoding, root `.gitignore` standard
negation/root/directory ordering, hard excludes, and no symlink following.
Record skipped counts without raw filesystem errors. Classify `.d.ts` first.

- [ ] **Step 5: Verify and commit**

```bash
npx tsx --test --test-name-pattern="repository discovery" test/tool.test.ts
npm run check
git add package.json package-lock.json src/tool.ts test/tool.test.ts
git commit -m "feat: discover bounded repository sources"
```

### Task 2: Syntax index and dependency graph

**Files:** `src/tool.ts`, `test/tool.test.ts`

- [ ] **Step 1: Write failing extraction tests**

Create one fixture covering static/type/side-effect imports, re-exports,
package/alias/dynamic imports, exported declarations, exported class public
methods, private/protected members, comments, initializer strings, overloads,
JSX, parse diagnostics, cycles, and `.js` to `.ts` resolution.

```ts
const index = await buildRepositoryIndex(rootDir);
const agent = index.files.find((file) => file.path === "src/agent.ts")!;
assert.deepEqual(agent.symbols.map((item) => [item.kind, item.name]), [
  ["class", "Agent"], ["method", "constructor"], ["method", "run"],
  ["interface", "AgentConfig"], ["function", "createAgent"]
]);
assert(!JSON.stringify(agent).includes("PRIVATE_BODY_VALUE"));
assert(!JSON.stringify(agent).includes("INITIALIZER_VALUE"));
assert.equal(agent.symbols[0].location.line, 3);
```

Assert exact sorted `ImportInfo`, `exports`, incoming/outgoing arrays,
240-character signature truncation, and omitted destructured variables.

- [ ] **Step 2: Verify RED**

Run `npx tsx --test --test-name-pattern="repository index" test/tool.test.ts`.

Expected: index exports are missing.

- [ ] **Step 3: Implement the spec data model**

Add `SourceLocation`, `ImportInfo`, `SymbolInfo`, `FileInfo`, and
`RepositoryIndex` exactly as approved, then:

```ts
export async function buildRepositoryIndex(
  rootDir: string,
  limits: RepositoryIndexLimits = REPOSITORY_INDEX_LIMITS
): Promise<RepositoryIndex>;
```

Use `ts.createSourceFile` with correct `ScriptKind`; never create a Program or
TypeChecker. Share relative import resolution with `analyze_dependencies`.
Print bodyless declaration headers, remove parameter defaults/initializers,
normalize whitespace, cap signatures, sort all collections, and freeze the
returned index. Derive lexical entry candidates only from source basenames
`index`, `main`, `server`, `app`, and `cli`; test that `application.ts` does not
qualify.

- [ ] **Step 4: Verify and commit**

```bash
npx tsx --test --test-name-pattern="repository index|dependencies|cycles" test/tool.test.ts
npm test -- test/tool.test.ts
npm run check
git add src/tool.ts test/tool.test.ts
git commit -m "feat: index repository declarations"
```

### Task 3: Query ranking and bounded rendering

**Files:** `src/tool.ts`, `test/tool.test.ts`

- [ ] **Step 1: Write failing behavioral tests**

```ts
const cases = [
  ["Where is CLI handling implemented?", "src/cli.ts"],
  ["Which module defines the LLM provider?", "src/llm.ts"],
  ["Where is tool execution handled?", "src/tool.ts"],
  ["Which modules depend on Agent?", "src/agent.ts"],
  ["Where should I inspect provider configuration?", "src/llm.ts"]
] as const;
for (const [query, expected] of cases) {
  const result = queryRepositoryIndex(index, query, { maxCharacters: 8_000, limit: 8 });
  assert(result.candidates.slice(0, 3).some((item) => item.path === expected));
  assert.match(result.text, /source bodies not inspected/);
}
```

Add token splitting, symbol/path priority, incoming-count/lexical tie-break,
one-hop expansion, fallback entries, limit 1/8, and 4,000/8,000 line-safe
reduction cases.

- [ ] **Step 2: Verify RED**

Run `npx tsx --test --test-name-pattern="queryRepositoryIndex|Repo Map" test/tool.test.ts`.

Expected: query exports are missing.

- [ ] **Step 3: Implement query API**

```ts
export interface RepoMapResult {
  query: string;
  candidates: RepoMapCandidate[];
  text: string;
  mapTruncated: boolean;
}
export function queryRepositoryIndex(
  index: RepositoryIndex,
  query: string,
  options?: { maxCharacters?: 4_000 | 8_000; limit?: number }
): RepoMapResult;
```

Apply the approved deterministic tuple with no stop-word list. Rank direct
seeds before one-hop neighbors. Render `REPO MAP`, `FILES`, `DEPENDENCIES`,
`SYMBOLS`, and mandatory `SCOPE`; reserve scope before optional lines and
never slice a line.

- [ ] **Step 4: Verify and commit**

```bash
npx tsx --test --test-name-pattern="queryRepositoryIndex|Repo Map|navigation" test/tool.test.ts
npm run check
git add src/tool.ts test/tool.test.ts
git commit -m "feat: render query-aware repository maps"
```

Expected: Top-3 5/5, Top-1 >=4/5, caps always respected.

### Task 4: `query_repo_map` and history breadcrumb

**Files:** `src/tool.ts`, `src/agent.ts`, `test/tool.test.ts`, `test/agent.test.ts`

- [ ] **Step 1: Write failing Tool tests**

```ts
const tool = createQueryRepoMapTool(index);
assert.equal(tool.permission, "SAFE");
assert.deepEqual(tool.parameters, {
  type: "object",
  properties: {
    query: { type: "string", minLength: 1 },
    limit: { type: "integer", minimum: 1, maximum: 8 }
  },
  required: ["query"],
  additionalProperties: false
});
const result = await tool.execute({ query: "provider", limit: 3 }, { rootDir: "/ignored" });
assert.equal(result.isError, false);
assert((result.historyContent ?? "").length <= 512);
```

Assert strict failures for empty/missing query, invalid limit, array, and extra
property. Prove the bound Tool does not inspect `rootDir`.

- [ ] **Step 2: Write failing Agent compaction tests**

A fake Tool returns large content and a short `historyContent`. Prove full
content reaches the next LLM request, but successful result/history contain the
breadcrumb with a valid assistant/tool pair. Test non-string replacement,
>512 Unicode code points, and rollback cleanup.

- [ ] **Step 3: Verify RED**

Run `npx tsx --test --test-name-pattern="query_repo_map|history breadcrumb" test/tool.test.ts test/agent.test.ts`.

- [ ] **Step 4: Implement generic result compaction**

Add `historyContent?: string` to `ToolResult` and export:

```ts
export function createQueryRepoMapTool(index: RepositoryIndex): Tool;
```

The Tool defaults to 8 candidates, renders <=8,000 characters, and returns a
<=512-code-point candidate/truncation breadcrumb. `Agent.execute` tracks a
replacement by call ID, retains full content for the active run, applies it
before successful return, and clears it on rollback. Do not branch on Tool name.

- [ ] **Step 5: Verify and commit**

```bash
npx tsx --test --test-name-pattern="query_repo_map|history breadcrumb" test/tool.test.ts test/agent.test.ts
npm test
npm run check
git add src/tool.ts src/agent.ts test/tool.test.ts test/agent.test.ts
git commit -m "feat: query repository index on demand"
```

### Task 5: Per-run transient Agent context

**Files:** `src/agent.ts`, `test/agent.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
const result = await agent.run("find provider", {
  transientContext: "REPO MAP\nsrc/llm.ts"
});
for (const request of fake.requests) {
  assert.deepEqual(request.slice(0, 2), [
    { role: "system", content: "rules" },
    { role: "system", content: "Current-run repository navigation context:\nREPO MAP\nsrc/llm.ts" }
  ]);
}
assert(!JSON.stringify(result.messages).includes("REPO MAP"));
assert(!JSON.stringify(agent.history()).includes("REPO MAP"));
```

Add whitespace, >8,000 characters, Provider failure, max-turn rollback, a
different second-run map, and replacement-Agent history tests.

- [ ] **Step 2: Verify RED**

Run `npx tsx --test --test-name-pattern="transient context" test/agent.test.ts`.

- [ ] **Step 3: Implement**

```ts
export interface AgentRunOptions { transientContext?: string; }
```

Change `run(prompt, options = {})`. Compose a fresh request array with one
transient system message after the stable system message on every model call.
Never push it into `this.messages`. Treat whitespace as absent and reject
>8,000 JavaScript characters with a stable Agent error.

- [ ] **Step 4: Verify and commit**

```bash
npx tsx --test --test-name-pattern="transient context|shared history|rollback" test/agent.test.ts
npm test
npm run check
git add src/agent.ts test/agent.test.ts
git commit -m "feat: add transient agent context"
```

### Task 6: CLI lifecycle and status-only TUI

**Files:** `src/cli.ts`, `src/tui.ts`, `test/cli.test.ts`

- [ ] **Step 1: Write failing lifecycle tests**

Use an injected navigation builder to prove: build once; distinct map per
question; transient one-shot input; same object across `/login` and `/model`;
degraded mode without the new Tool; and no map text in TUI output.

```ts
export interface RepositoryNavigation {
  index: RepositoryIndex;
  tools: Tool[];
  mapFor(query: string, maxCharacters?: 4_000 | 8_000): RepoMapResult;
}
```

- [ ] **Step 2: Verify RED**

Run `npx tsx --test --test-name-pattern="repository navigation|index status" test/cli.test.ts`.

Expected: fixed startup-map assertions fail.

- [ ] **Step 3: Replace legacy wiring**

Delete legacy map constants/types/build/load/system-prompt composition. Add:

```ts
export async function createRepositoryNavigation(rootDir: string): Promise<RepositoryNavigation | undefined> {
  try {
    const index = await buildRepositoryIndex(rootDir);
    return {
      index,
      tools: [...tools, createQueryRepoMapTool(index)],
      mapFor: (query, maxCharacters = 8_000) =>
        queryRepositoryIndex(index, query, { maxCharacters, limit: 8 })
    };
  } catch { return undefined; }
}
```

Make `makeAgent` accept session Tools. Add only the approved decision rule to
`SYSTEM_PROMPT`. Route one-shot and TUI prompts through `agent.run(prompt,
{transientContext})`. Reuse navigation across replacements.

- [ ] **Step 4: Add status-only API**

```ts
export interface RepositoryIndexStatus {
  available: boolean;
  indexedFiles: number;
  skippedFiles: number;
  truncated: boolean;
}
```

`TuiView.repositoryIndexStatus` accepts only this object, sanitizes it, and
prints one quiet line. It cannot receive map/index content.

- [ ] **Step 5: Verify and commit**

```bash
npx tsx --test --test-name-pattern="repository navigation|index status|one-shot" test/cli.test.ts
npm test
npm run check
npm run build
git add src/cli.ts src/tui.ts test/cli.test.ts
git commit -m "feat: use query maps in agent sessions"
```

### Task 7: Deterministic benchmark and verifier

**Files:** `scripts/benchmark-query-repo-map.mjs`, `scripts/verify-query-repo-map.mjs`, `package.json`

- [ ] **Step 1: Add commands and verify RED**

```json
"benchmark:repo-map": "npm run build && node scripts/benchmark-query-repo-map.mjs",
"benchmark:repo-map:json": "node scripts/benchmark-query-repo-map.mjs",
"verify:repo-map": "npm run build && node scripts/verify-query-repo-map.mjs"
```

Run `npm run benchmark:repo-map`; expect missing runner.

- [ ] **Step 2: Implement JSON-only runner**

Run the five declared questions with `none`, `map-4000`, and `map-8000` fixed
fake-model trajectories using built production Agent/index/Tools. Wrap real
Tool execution and emit one sorted document:

```js
{
  schemaVersion: 1,
  questions: [{ id, prompt, expectedPaths }],
  runs: [{ variant, questionId, outcome, top1, top3, indexBuildMs,
    mapRenderMs, turns, modelRequests, toolCalls, toolCallsByName,
    filesRead, returnedToolBytes, sourceBytesBeforeCorrectRead,
    requestCharacters, firstCorrectCandidateRead }]
}
```

Only timing fields may vary.

- [ ] **Step 3: Implement verifier**

Execute twice, remove timing, deep-compare, and require 15 answered runs,
8,000 Top-3 5/5, Top-1 >=4/5, no new failure/max-turn outcome, and >=30%
median reductions in exploratory calls and source bytes before correct read.
Success text is exactly `query-aware repo-map verification passed`.

- [ ] **Step 4: Verify and commit**

```bash
npm run benchmark:repo-map
npm run --silent benchmark:repo-map:json
npm run verify:repo-map
git add package.json scripts/benchmark-query-repo-map.mjs scripts/verify-query-repo-map.mjs
git commit -m "test: benchmark query-aware repository maps"
```

### Task 8: Report and PR close gate

**Files:** `docs/experiments/9-query-aware-repo-map.md`, `README.md`

- [ ] **Step 1: Capture local evidence**

```bash
npm run build
node scripts/benchmark-query-repo-map.mjs > /tmp/mini-pi-query-repo-map.json
npm run verify:repo-map
git rev-parse HEAD
node --version
npm exec tsc -- --version
```

- [ ] **Step 2: Write report and README**

Report all 15 rows, expected paths, Top-1/Top-3, median Tool/source-byte
changes, observed timings, failures, variance, truncation, trade-offs, and a
4,000-versus-8,000 recommendation. Mark live Provider token/cost/latency
`NOT MEASURED` without an owner-run. README documents local indexing,
transient metadata, root-only `.gitignore`, source verification, and fallback.

- [ ] **Step 3: Run full gate**

```bash
npm test
npm run check
npm run build
npm run benchmark:large
npm run verify:benchmark
npm run benchmark:repo-map
npm run verify:repo-map
npm run verify:bin
npm run verify:package
git diff --check main...HEAD
```

Expected: all exit 0; a threshold failure stays a PR blocker.

- [ ] **Step 4: Commit and prepare owner review**

```bash
git add README.md docs/experiments/9-query-aware-repo-map.md
git commit -m "docs: report query-aware repo-map results"
```

Push the branch, update Issue #9, and open/update its PR with validation and
experiment evidence. Do not merge before owner approval.
