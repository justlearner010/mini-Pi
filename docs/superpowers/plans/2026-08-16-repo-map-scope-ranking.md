# Scope-aware Repo Map Candidate Ranking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Improve the bounded Repo Map so ordinary code-navigation questions rank likely product implementation files above irrelevant tests, generated files, examples, and vendor code, while preserving explicit access to every scope.

**Architecture:** `src/tool.ts` augments Issue #9's immutable syntax index with path-derived file area and safely-read nearest package names. It derives deterministic query intent, ranks direct candidates lexicographically, and renders bounded reasons/confidence. `cli.ts` keeps passing the map only as transient context; Issue #10 remains responsible for later tool decisions.

**Tech Stack:** Node.js 22, TypeScript 5.9 syntax-only Compiler API, existing `ignore`, `tsx`/ `node:test`, and the Issue #16 scripted DeepSeek Harness evaluator.

---

## Files and predecessor boundary

| File | Change |
| --- | --- |
| `src/tool.ts` | Area/package index metadata, intent, rank tuple, reasons, confidence, bounded renderer |
| `test/tool.test.ts` | Metadata, ordering, reachability, confidence, and budget regressions |
| `test/cli.test.ts` | Automatic 4K transient context remains ephemeral and gains new labels |
| `scripts/benchmark-deepseek-harness-repo-map.mjs` | Extend Issue #16 results with ranking evidence |
| `scripts/verify-deepseek-harness-repo-map.mjs` | Enforce Issue #18 Top-1/Top-3 thresholds |
| `docs/experiments/18-scope-aware-repo-map-ranking.md` | Controlled baseline-versus-result report |
| `README.md`, `package.json` | Link report; expose only needed harness scripts |

Implementation is stacked after Issue #9 / PR #15 and Issue #16 / PR #17.
Before Task 4, rebase onto the branch containing both predecessors; do not
duplicate Issue #16's harness. No changes are planned for `agent.ts`, `llm.ts`,
`tui.ts`, discovery limits, credentials, or Issue #10 orchestration.

### Task 1: Add safe source-area and package metadata

**Files:**
- Modify: `src/tool.ts`
- Test: `test/tool.test.ts`

- [ ] **Step 1: Write a failing fixture test**

```ts
const index = await buildRepositoryIndex(await project({
  "package.json": JSON.stringify({ name: "root-package" }),
  "src/agent.ts": "export class Agent {}",
  "test/agent.test.ts": "export const test = true",
  "vendor/sdk/client.ts": "export const client = true",
  "examples/demo.ts": "export const demo = true",
  "src/generated/types.ts": "export interface Generated {}",
  "packages/core/package.json": JSON.stringify({ name: "@repo/core" }),
  "packages/core/src/engine.ts": "export function run() {}"
}));
assert.deepEqual(index.files.map((file) => [file.path, file.area, file.packageRoot, file.packageName]), [
  ["examples/demo.ts", "example", ".", "root-package"],
  ["packages/core/src/engine.ts", "product", "packages/core", "@repo/core"],
  ["src/agent.ts", "product", ".", "root-package"],
  ["src/generated/types.ts", "generated", ".", "root-package"],
  ["test/agent.test.ts", "test", ".", "root-package"],
  ["vendor/sdk/client.ts", "vendor", ".", "root-package"]
]);
```

Add separate cases for `.spec.ts`, `third-party/`, `codegen/`, no manifest,
invalid JSON, a 256 KiB-plus manifest, and an unreadable manifest. Every case
must build successfully and retain no manifest content other than name/root.

- [ ] **Step 2: Confirm RED**

Run: `npx tsx --test --test-name-pattern="repository index classifies file areas" test/tool.test.ts`

Expected: TypeScript/test failure because `FileInfo` has no area/package fields.

- [ ] **Step 3: Implement the minimal index contracts**

```ts
export type FileArea = "product" | "test" | "vendor" | "example" | "generated";
export interface PackageInfo { root: string; name?: string; workspace: boolean; }
export interface FileInfo {
  path: string; sourceKind: SourceKind; imports: ImportInfo[]; exports: string[];
  symbols: SymbolInfo[]; parseDiagnostics: number;
  area: FileArea; packageRoot: string; packageName?: string;
}
export function classifyFileArea(path: string): FileArea;
```

Split normalized project-relative paths on `/`. Match test directories and
`.test.`/`.spec.` first, then vendor, example, generated, then product. Keep
the classifier path-only and export it for direct tests.

- [ ] **Step 4: Add bounded package discovery**

Implement a private cached manifest reader used by `buildRepositoryIndex`.
It accepts regular non-symlink `package.json` files inside the real project
root, rejects files over `256 * 1024` bytes, parses JSON, and preserves only a
nonempty string `name`. For each discovered source, walk parent directories
up to root and take the nearest valid manifest. On failure return root `.`
with no name. Do not expand workspaces, execute scripts, or retain raw JSON/errors.

- [ ] **Step 5: Verify and commit**

```bash
npx tsx --test --test-name-pattern="repository index classifies file areas|package metadata" test/tool.test.ts
npm run check
git add src/tool.ts test/tool.test.ts
git commit -m "feat: index repo map areas and packages"
```

Expected: targeted tests/check pass; the commit changes only index facts and tests.

### Task 2: Derive deterministic intent and score direct candidates

**Files:**
- Modify: `src/tool.ts`
- Test: `test/tool.test.ts`

- [ ] **Step 1: Write failing ranking/reachability tests**

```ts
const index = await buildRepositoryIndex(await project({
  "packages/cli/package.json": JSON.stringify({ name: "@repo/cli" }),
  "packages/cli/src/bin.ts": "export function runCli() {}",
  "packages/core/src/agent.ts": "export class Agent { run() {} }",
  "packages/llm/src/adapter.ts": "export class DeepSeekAdapter {}",
  "packages/tools/src/registry.ts": "export class ToolRegistry { execute() {} }",
  "packages/llm/test/adapter.test.ts": "export const adapterTest = true",
  "vendor/adapter.ts": "export class Adapter {}"
}));
const normal = queryRepositoryIndex(index, "Where is the DeepSeek provider adapter?", { maxCharacters: 8_000, limit: 8 });
assert.equal(normal.candidates[0]?.path, "packages/llm/src/adapter.ts");
assert(normal.candidates[0]?.reasons.includes("scope: product"));
assert(normal.candidates[0]?.reasons.includes("role: adapter"));
const testQuery = queryRepositoryIndex(index, "Which adapter test covers DeepSeek?", { maxCharacters: 8_000, limit: 8 });
assert.equal(testQuery.candidates[0]?.path, "packages/llm/test/adapter.test.ts");
```

Add CLI, loop, registry, config, exact-symbol-over-later-score, lexical tie,
unknown-question, explicit vendor/example/generated, and at-most-three-reason
cases. Explicit-area cases must prove those files remain discoverable.

- [ ] **Step 2: Confirm RED**

Run: `npx tsx --test --test-name-pattern="scope-aware Repo Map ranking" test/tool.test.ts`

Expected: current candidates lack scope, package, role, and new reasons.

- [ ] **Step 3: Add inspectable contracts and intent lexicon**

```ts
export type QueryRole = "cli" | "adapter" | "loop" | "registry" | "config";
export interface QueryIntent {
  tokens: readonly string[]; requestedAreas: readonly FileArea[];
  roles: readonly QueryRole[]; implementationSeeking: boolean;
}
export interface RepoMapCandidate {
  path: string; area: FileArea; packageRoot: string; packageName?: string;
  reasons: string[]; symbols: SymbolInfo[]; incoming: string[]; outgoing: string[];
}
export function deriveQueryIntent(query: string): QueryIntent;
```

Use one readonly lexicon: CLI=`cli command terminal shell`,
adapter=`adapter provider llm model`, loop=`loop agent run turn`,
registry=`tool tools registry execute`, config=`config configuration settings env`.
Explicit areas are test/spec/fixture, vendor/third-party, example/demo, and
generated/codegen. `implementationSeeking` requires a role and no requested
non-product area.

- [ ] **Step 4: Implement the stable score tuple**

Refactor `queryRepositoryIndex` to order direct candidates by:

```ts
type CandidateScore = readonly [
  exactSymbol: number, area: number, role: number, packageMatch: number,
  symbolMatches: number, pathMatches: number, entry: number, incoming: number
];
```

Area boosts explicit requested scope, or product only for implementation
questions. Role counts approved role words in basename/path/exported symbols.
Package counts query overlap with package name/root. Entry boosts only a CLI
role plus existing entry evidence. Sort lexical project path after the tuple.
Never filter any area. Keep one-hop expansion after ranked direct seeds.
Create reasons in this order, capped at three: exact symbol; scope; role;
package; symbol/path; entry; dependency.

- [ ] **Step 5: Verify and commit**

```bash
npx tsx --test --test-name-pattern="scope-aware Repo Map ranking|navigation targets|one hop" test/tool.test.ts
npm run check
git add src/tool.ts test/tool.test.ts
git commit -m "feat: rank repo map candidates by scope and package"
```

Expected: product navigation improves; explicit non-product queries stay valid.

### Task 3: Render confidence without changing context boundaries

**Files:**
- Modify: `src/tool.ts`
- Test: `test/tool.test.ts`, `test/cli.test.ts`

- [ ] **Step 1: Write failing renderer/context tests**

```ts
assert.match(queryRepositoryIndex(index, "DeepSeek adapter", { maxCharacters: 4_000 }).text, /confidence: high/);
assert.match(queryRepositoryIndex(index, "adapter", { maxCharacters: 8_000 }).text, /confidence: ambiguous/);
assert.match(queryRepositoryIndex(index, "unmatched phrase", { maxCharacters: 8_000 }).text, /confidence: fallback/);
```

Assert candidate rendering includes `[product · package @repo/llm]`, complete
`reason:` lines, at most three reasons, 4K automatic and 8K Tool limits. In
`test/cli.test.ts`, extend the navigation test: transient context has
`confidence:` and `scope:`, but post-run `Agent.history()` has no `REPO MAP`.

- [ ] **Step 2: Confirm RED**

Run: `npx tsx --test --test-name-pattern="Repo Map confidence|repository navigation" test/tool.test.ts test/cli.test.ts`

Expected: current renderer has no confidence or scoped candidate label.

- [ ] **Step 3: Implement confidence and reduction priority**

Add `confidence: "high" | "ambiguous" | "fallback"` to `RepoMapResult`.
Use fallback when direct seeds are absent. Use ambiguous when top two direct
non-lexical tuples tie, or neither has exact-symbol/role/area evidence; use
high otherwise. Render confidence in mandatory `SCOPE`; render
`path  [area · package name-or-root]` and reasons before decorative symbols.
Keep `AUTO_REPO_MAP_MAX_CHARACTERS = 4_000`, Tool 8K, limit 8, and
`runWithNavigation` transient-only behavior unchanged.

- [ ] **Step 4: Verify and commit**

```bash
npm test
npm run check
git diff --check
git add src/tool.ts test/tool.test.ts test/cli.test.ts
git commit -m "feat: explain repo map ranking confidence"
```

Expected: full suite passes and map data remains bounded/ephemeral.

### Task 4: Measure the external regression and publish evidence

**Files:**
- Modify: `scripts/benchmark-deepseek-harness-repo-map.mjs`, `scripts/verify-deepseek-harness-repo-map.mjs`, `package.json`, `README.md`
- Create: `docs/experiments/18-scope-aware-repo-map-ranking.md`

- [ ] **Step 1: Make the verifier fail against the #16 baseline**

Extend the inherited Issue #16 verifier before changing its schema:

```js
assert.equal(product.length, 5);
assert(product.filter((row) => row.map4k.rank <= 3).length >= 4);
assert(product.filter((row) => row.map4k.rank === 1).length >= 3);
assert(product.every((row) => row.map4k.candidateReasons.length <= 3));
assert(product.every((row) => ["high", "ambiguous", "fallback"].includes(row.map4k.confidence)));
```

Run: `npm run benchmark:deepseek-harness:json > /tmp/mini-pi-issue-18-before.json && node scripts/verify-deepseek-harness-repo-map.mjs /tmp/mini-pi-issue-18-before.json`

Expected: baseline fails Top-1/Top-3. Preserve JSON for the report. Do not call
a Provider or modify `/Users/jay/deepseek-harness`.

- [ ] **Step 2: Extend the canonical result schema**

After Task 3 passes, emit `confidence`, `candidateReasons`, `candidateAreas`,
and `candidatePackages` for none/map4K/map8K. Keep the fixed target commit,
five predeclared questions, fake LLM, production index/Agent/read-only tools,
full/product scopes, and existing cost metrics. Exclude elapsed time from
repeatability equality; include every deterministic field.

- [ ] **Step 3: Write the generated evidence report**

Create `docs/experiments/18-scope-aware-repo-map-ranking.md` with Method,
baseline-versus-ranked Top-1/Top-3 table, cost/latency table, failures/variance/
trade-offs, and an explicit pass/fail recommendation. State it measures
candidate navigation—not factual answer correctness—and uses no live Provider.
Link it from `README.md`.

- [ ] **Step 4: Verify and commit**

```bash
npm test
npm run check
npm run build
npm run benchmark:deepseek-harness
npm run verify:deepseek-harness
npm run verify:bin
npm run verify:package
git diff --check
git add scripts/benchmark-deepseek-harness-repo-map.mjs scripts/verify-deepseek-harness-repo-map.mjs package.json README.md docs/experiments/18-scope-aware-repo-map-ranking.md
git commit -m "test: measure scope-aware repo map ranking"
```

Expected: all validations pass; report records generated measurements and a
clear recommendation.

## Final PR checklist

- [ ] Rebase onto merged #9 and #16 predecessors; preserve their tests and evidence.
- [ ] Run Task 4's complete verification matrix from a clean worktree.
- [ ] Link #9, #16, and #18 in the PR; state #10 remains tool orchestration.
- [ ] Include pass/fail threshold results and wait for repository-owner review before merging.

