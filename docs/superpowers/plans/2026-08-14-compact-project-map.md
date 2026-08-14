# Compact Project Map Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a <=4,000-character evidence-based project map to every mini-Pi session, lowering overview-request context without a quality regression.

**Architecture:** `cli.ts` owns map rendering, the single startup scan, and system-context composition. `tui.ts` receives only a safe one-line status. New scripts compare actual built Agent/tool baseline and map-aware trajectories against the locked three fixtures.

**Tech Stack:** TypeScript 5.9, Node.js 22, existing read-only tools, `tsx` tests.

---

## Files

- `src/cli.ts`: map types, validation, renderer, loader, context composition.
- `src/tui.ts`: sanitized loaded/unavailable status only.
- `test/cli.test.ts`: map renderer, loader, context, TUI behavior.
- `scripts/benchmark-compact-project-map.mjs`: JSON-only six-run benchmark.
- `scripts/verify-compact-project-map.mjs`: repeatability and threshold verifier.
- `package.json`: build-safe commands.
- `docs/experiments/9-compact-map.md`: measured report and recommendation.

### Task 1: Render a bounded general map

**Files:**
- Modify: `src/cli.ts` before `SYSTEM_PROMPT`
- Modify: `test/cli.test.ts` near CLI helper tests

- [ ] **Step 1: Write failing renderer tests**

Import `buildProjectMap` and `PROJECT_MAP_MAX_CHARACTERS`. Test literal scan
metadata with README, package/tsconfig manifests, TS sources, and a Python file:

```ts
const map = buildProjectMap({ readmePath: "README.md", manifestPaths: ["package.json", "tsconfig.json"], sourceFiles: ["src/index.ts", "src/lib/a.ts"], unsupportedFiles: ["scripts/run.py"], totalRelevantFiles: 6, returnedFileCount: 6, truncated: false, tree: "README.md\npackage.json\nscripts/run.py\nsrc/index.ts\nsrc/lib/a.ts\ntsconfig.json" });
assert.equal(map.status, "loaded");
assert.match(map.context, /README: README.md/);
assert.match(map.context, /Directories: src \(2\)/);
assert(map.context.length <= PROJECT_MAP_MAX_CHARACTERS);
```

Test a 600-file scan with `returnedFileCount: 500` and `truncated: true`: it
must retain the scan-truncation line plus `Omitted map details due to
4000-character limit`. Test malformed input returns exactly unavailable/empty.

- [ ] **Step 2: Verify RED**

Run: `npx tsx --test --test-name-pattern='buildProjectMap' test/cli.test.ts`

Expected: fail because exports are absent.

- [ ] **Step 3: Implement renderer**

Add:

```ts
export const PROJECT_MAP_MAX_CHARACTERS = 4_000;
export type ProjectMap = { status: "loaded"; context: string; totalFiles: number; entryCandidates: number } | { status: "unavailable"; context: "" };
```

Add an exact primitive-array `isScanContent` guard and
`buildProjectMap(value: unknown): ProjectMap`. Derive sorted root-relative
directory counts, README/manifests, source/unsupported counts, and source entry
candidates named `index`, `main`, `server`, `app`, or `cli`. Support arbitrary
languages with the general facts; include TS/JS facts only where available.
Order rendered sections: safety/truncation; README/manifests/entries;
directory/language counts; candidate areas. A line-aware budget helper reserves
the omission line and never cuts paths mid-line. Invalid input returns
unavailable without throwing.

- [ ] **Step 4: Verify GREEN**

Run: `npx tsx --test --test-name-pattern='buildProjectMap' test/cli.test.ts && npm run check`

Expected: all renderer tests and type check pass.

- [ ] **Step 5: Commit**

Run: `git add src/cli.ts test/cli.test.ts && git commit -m "feat: render bounded project maps"`

### Task 2: Load exactly once and inject map context

**Files:**
- Modify: `src/cli.ts: makeAgent and run`
- Modify: `test/cli.test.ts`

- [ ] **Step 1: Write failing loader/context tests**

Export `loadProjectMap(rootDir, scan = scanProjectTool)`. Inject a
`Pick<Tool, "execute">` fake and assert one execution and loaded map; assert
error/throw becomes unavailable. Capture fake LLM messages to prove the initial
system message contains map context once but not raw scan JSON, and a
`/login`/`/model` replacement reuses it without another scan.

```ts
let calls = 0;
const map = await loadProjectMap("/project", { execute: async () => {
  calls += 1; return { isError: false, content: emptyValidScan };
} } as never);
assert.equal(calls, 1);
assert.equal(map.status, "loaded");
```

- [ ] **Step 2: Verify RED**

Run: `npx tsx --test --test-name-pattern='loadProjectMap|project map context' test/cli.test.ts`

Expected: fail because loader/context injection is absent.

- [ ] **Step 3: Implement single startup scan**

Implement:

```ts
export async function loadProjectMap(rootDir: string, scan: Pick<Tool, "execute"> = scanProjectTool): Promise<ProjectMap> {
  try { const result = await scan.execute({}, { rootDir }); return result.isError ? { status: "unavailable", context: "" } : buildProjectMap(result.content); }
  catch { return { status: "unavailable", context: "" }; }
}
export function mapSystemPrompt(map: ProjectMap): string {
  return map.status === "loaded" ? `${SYSTEM_PROMPT}\n\n${map.context}` : SYSTEM_PROMPT;
}
```

Make `makeAgent` receive this precomputed prompt. After final provider/model
selection, load once before one-shot or interactive construction, then pass the
same composed prompt to one-shot and every replacement Agent. Loading must not
need a key or make a Provider call; failure continues with `SYSTEM_PROMPT`.

- [ ] **Step 4: Verify GREEN**

Run: `npx tsx --test --test-name-pattern='loadProjectMap|project map context' test/cli.test.ts && npm test && npm run check`

Expected: one scan per run, replacements reuse map, existing suite remains green.

- [ ] **Step 5: Commit**

Run: `git add src/cli.ts test/cli.test.ts && git commit -m "feat: load project map at session startup"`

### Task 3: Display safe status, never map text

**Files:**
- Modify: `src/tui.ts: TuiView and startTui`
- Modify: `src/cli.ts: startTui call`
- Modify: `test/cli.test.ts`

- [ ] **Step 1: Write failing TUI tests**

```ts
const output: string[] = [];
const view = new TuiView({ write: (text) => output.push(text) });
view.projectMapStatus({ status: "loaded", totalFiles: 86, entryCandidates: 2, context: "SECRET SOURCE CONTENT" });
view.projectMapStatus({ status: "unavailable", context: "" });
const text = output.join("");
assert.match(text, /Project map loaded · 86 files · 2 entry candidates/);
assert.match(text, /Project map unavailable; using on-demand exploration/);
assert(!text.includes("SECRET SOURCE CONTENT"));
```

Pass control/default-ignorable text through the public method and assert no
unsafe controls survive.

- [ ] **Step 2: Verify RED**

Run: `npx tsx --test --test-name-pattern='map state' test/cli.test.ts`

Expected: fail because `projectMapStatus` is absent.

- [ ] **Step 3: Implement status wiring**

Add `TuiView.projectMapStatus(map)` using only status and finite non-negative
counts. It writes through `sanitizePlainText` in activity color, never stores or
renders context. Add `map` to `startTui` configuration and emit status after
ready line; pass it from CLI. Do not add a map-dump command.

- [ ] **Step 4: Verify GREEN**

Run: `npx tsx --test --test-name-pattern='map state|layered TUI' test/cli.test.ts && npm test && npm run check`

Expected: one safe status per TUI startup and no map content reaches terminal.

- [ ] **Step 5: Commit**

Run: `git add src/tui.ts src/cli.ts test/cli.test.ts && git commit -m "feat: show compact project map status"`

### Task 4: Benchmark the real candidate trajectory

**Files:**
- Create: `scripts/benchmark-compact-project-map.mjs`
- Create: `scripts/verify-compact-project-map.mjs`
- Modify: `package.json`

- [ ] **Step 1: Add commands and observe RED**

Add:

```json
"benchmark:compact-map": "npm run build && node scripts/benchmark-compact-project-map.mjs",
"benchmark:compact-map:json": "node scripts/benchmark-compact-project-map.mjs",
"verify:compact-map": "npm run build && node scripts/verify-compact-project-map.mjs"
```

Run: `npm run benchmark:compact-map`

Expected: missing-runner failure.

- [ ] **Step 2: Implement JSON-only runner**

Model it on `scripts/benchmark-large-project.mjs`. Import built `Agent`, tools,
`buildProjectMap`, and `mapSystemPrompt`. For each locked fixture create two
fixed-reply/no-network runs:

- baseline: `scan_project → read_file(package.json) → analyze_dependencies(entry) → answer`, plain prompt;
- compact-map: real startup scan outside Agent messages, then `read_file(package.json) → analyze_dependencies(entry) → answer`, map prompt.

Emit one document containing six runs and `variant`, fixture, turns, model
requests, tools, files read, returned bytes, request characters, tool-result
characters, elapsed time. The wrapper builds; the JSON command emits no logs.

- [ ] **Step 3: Implement verifier**

Execute runner twice via `execFileSync`, parse one JSON document each, remove
only `elapsedMs`, deep-compare, require six answered runs, and require at least
two fixture pairs satisfying:

```js
candidate.requestCharacters <= baseline.requestCharacters * 0.65
```

Failure prints pair metrics/nonzero; success prints exactly
`compact-map benchmark verification passed`.

- [ ] **Step 4: Verify GREEN**

Run: `npm run benchmark:compact-map && npm run --silent benchmark:compact-map:json && npm run verify:compact-map`

Expected: canonical command builds/prints JSON; verifier passes only at 35%.

- [ ] **Step 5: Commit**

Run: `git add package.json scripts/benchmark-compact-project-map.mjs scripts/verify-compact-project-map.mjs && git commit -m "test: benchmark compact project maps"`

### Task 5: Record results and apply the close gate

**Files:**
- Create: `docs/experiments/9-compact-map.md`
- Modify: `README.md` only if user-facing map status needs explanation

- [ ] **Step 1: Capture deterministic output**

Run: `npm run build && node scripts/benchmark-compact-project-map.mjs > /tmp/mini-pi-compact-map.json && npm run verify:compact-map`

Expected: parseable six-run JSON and passing verifier.

- [ ] **Step 2: Write report**

Include fixture revision, six rows, metric definitions, per-fixture 35%
calculation, quality-rubric status, failures/variance/trade-offs, and explicit
pass/fail. Fixed replies measure context/tool trajectory only, not Provider
quality/token billing/cost. Missing owner-run data is `NOT MEASURED`; never
estimate cost from characters.

- [ ] **Step 3: Run full gate**

Run: `npm test && npm run check && npm run build && npm run benchmark:large && npm run verify:benchmark && npm run benchmark:compact-map && npm run verify:compact-map && npm run verify:bin && npm run verify:package && git diff --check main...HEAD`

Expected: all exit 0. A failed threshold or quality requirement is a reported
blocker, never a success claim.

- [ ] **Step 4: Commit**

Run: `git add docs/experiments/9-compact-map.md README.md && git commit -m "docs: record compact project map experiment"`
