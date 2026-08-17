# Goal-directed tool orchestration and evidence guardrails

## Status and relationship to Issues 9, 18, 20, and 11

This is the owner-review design for Issue #10. It is stacked after Issue #18
because the guard consumes the ranked candidates, `area`, and `confidence` that
Issue #18 added to the compact Repo Map. It is also informed by the Issue #20
live observation, which showed the real failure mode this issue targets: on the
five-question DeepSeek Harness run, two non-Top-1 questions still resolved, but
the model repeated `query_repo_map`, re-read files, and scanned unnecessarily —
the `tools registry` question alone consumed 107,210 tokens.

This document is design-only. Code changes begin only after owner review of
this specification and a dedicated implementation plan.

Issue #11 (evidence-bounded answers) is the next dependent step: it separates
verified facts from uninspected scope using the evidence state that this issue
begins to track. Issue #10 does not implement that answer format.

## Problem statement

The Repo Map now gives the model a small, ranked set of candidate locations.
But nothing stops the model from wasting turns and tokens once the map is in
hand. Issue #20 demonstrated the concrete waste: repeated `query_repo_map`,
re-reading the same file, jumping to test or vendor files before verifying the
implementation, and re-running whole-project scans after the answer was already
in reach.

The fix is not to make the model stop deciding. It is to add a small,
deterministic check that a requested tool call can actually close the current
evidence gap, and to say no when it cannot.

## Goal

Before each tool execution, a deterministic evidence guard decides whether the
proposed call is a relevant, non-duplicate, in-budget step toward the user's
goal. It may allow it, block it with a reason and a suggested alternative, or
allow it while attaching a short hint. The model remains the decision-maker;
the guard only removes calls that provably cannot help.

The desired path becomes:

```text
question
  -> deterministic evidence-path intent (entry | dependency | overview | unclear)
  -> compact Repo Map (already built by Issue 9/18)
  -> model proposes a tool call
  -> guard: allow / block(duplicate, budget, unrelated, expansion) / suggest
  -> execute and record evidence
```

## Non-goals

- No second LLM, no planner, no autonomous task queue, no workflow engine.
- No change to candidate ranking, map budgets, Provider protocol, or the
  syntax-only index. The guard consumes what already exists.
- No write, delete, shell, or network tool, and no new permission scope.
- No interception of the existing approval boundary for non-SAFE tools.
- No automatic retry, model fallback, or stop-the-loop policy: blocking a call
  still consumes that turn and returns a tool result; it does not end the run.
- No claim of lower real-Provider cost in this issue. Cost comparison remains a
  separately recorded owner-run, exactly as in Issue #20.

## Principle: fail-open vs fail-closed

The guard is conservative by construction:

- **Fail-closed** (block) only for conditions that are provably wasteful and
  intent-independent: exact duplicate calls, exhausted per-run budgets, a
  `high`-confidence map pointing to a product implementation while the model
  reads an unrequested non-product scope, and expansion after the intent's
  evidence path is already satisfied.
- **Fail-open** (allow) everywhere else, and always for unclear intent. An
  unrecognized question falls back to ordinary ReAct; only duplicate and budget
  rules still apply.
- **Suggest** (allow with a bounded hint) for intent/evidence mismatches that
  are plausible but suboptimal; a hint never blocks a call.

## Evidence-path intent

`agent.ts` gains a small, deterministic classifier with one of four outcomes:

| Intent | Trigger terms (English, case-insensitive, tokenized) | Preferred evidence path |
| --- | --- | --- |
| `entry` | entry, entrypoint, startup, start, main, bootstrap, bin | manifest/build clue → entry candidate → limited entry reads |
| `dependency` | depend, dependency, dependencies, import, require, cycle | dependency analysis → target and adjacent module reads |
| `overview` | overview, structure, architecture, layout, summary | compact map → selected README/manifest or key directory evidence |
| `unclear` | anything else, conflicting terms, or no tokens | ordinary ReAct fallback (duplicate/budget guard only) |

The classifier reuses the existing Issue #18 tokenizer, which strips
non-ASCII characters. A prompt with only CJK characters therefore tokenizes to
nothing and classifies as `unclear`, which is safe: it falls back to ReAct
rather than being misclassified. This is an explicit, observable limitation of
the lexicon, not a hidden heuristic. `overview` terms are checked first, then
`dependency`, then `entry`, so a mixed prompt settles deterministically.

```ts
export type EvidenceIntent = "entry" | "dependency" | "overview" | "unclear";
export function classifyEvidenceIntent(prompt: string): EvidenceIntent;
```

Area-awareness comes from the existing `deriveQueryIntent(query).requestedAreas`
in `tool.ts`. A question that explicitly requests a non-product scope (for
example "which test covers …") must keep that scope reachable; the guard reads
this and never blocks a requested area.

## Per-run evidence state

The Agent accumulates a bounded, per-run record of what has actually executed.
The record persists only for the current `Agent.run()` call and is reset at the
start of every run. It is never written to history, configuration, credentials,
or the terminal activity log beyond the existing safe tool-name summaries.

```ts
export interface EvidenceState {
  readPaths: readonly string[];        // normalized read_file paths, in order
  readRanges: ReadonlyMap<string, readonly { start?: number; end?: number }[]>;
  scannedPaths: readonly string[];     // normalized scan_project directories
  analyzedPaths: readonly string[];    // normalized analyze_dependencies directories
  analyzedEntries: readonly string[];  // normalized analyze_dependencies entries
  queryRepoMapCount: number;
  readFileCount: number;
  scanCount: number;
  analyzeCount: number;
}
```

`readRanges` stores the model's *requested* line range per path (unbounded when
`startLine`/`endLine` are absent). Duplicate detection works on requested
ranges, not on the clamped ranges the tool actually returns, so the guard's
behavior is independent of file length.

## Guard contract

The guard is a pure, injectable decision function owned by `agent.ts`. It is
opt-in: `AgentConfig` gains an optional `guard`, and an `Agent` constructed
without one behaves exactly as it does today. This keeps the locked Issue
#16/#18/#20 benchmarks — which construct `Agent` directly and never pass a
guard — byte-for-byte unchanged.

```ts
export interface NavigationSummary {
  confidence: "high" | "ambiguous" | "fallback";
  candidates: readonly { path: string; area: FileArea }[];
}

export type EvidenceGuardDecision =
  | { outcome: "allow"; hint?: string }   // hint present = "suggest"
  | { outcome: "block"; reason: string; alternative?: string };

export interface EvidenceGuardInput {
  intent: EvidenceIntent;
  navigation?: NavigationSummary;
  evidence: EvidenceState;
  proposed: { name: string; arguments: unknown };
  requestedAreas: readonly FileArea[];
}

export interface EvidenceBudget {
  maxReadFiles: number;            // default 12
  maxScanProject: number;          // default 3
  maxAnalyzeDependencies: number;  // default 2
  maxQueryRepoMap: number;         // default 1
}

export interface EvidenceGuard {
  evaluate(input: EvidenceGuardInput): EvidenceGuardDecision;
}

export const DEFAULT_EVIDENCE_BUDGET: EvidenceBudget;
export function createEvidenceGuard(budget?: Partial<EvidenceBudget>): EvidenceGuard;
```

The three documented outcomes map onto the type as: `allow` with no hint,
`allow` with a hint (`suggest`), and `block`. A blocked call does **not**
execute the underlying tool; the Agent returns a bounded, deterministic tool
result instead.

## Guard rules

Rules are evaluated in order; the first match wins. The guard only understands
the four built-in read-only tools. Any other tool name is always allowed
(fail-open), so future tools and the approval boundary are never shadowed.

### R1 — unknown tool (fail-open)

If `proposed.name` is not `read_file`, `scan_project`,
`analyze_dependencies`, or `query_repo_map`, allow with no hint.

### R2 — exhausted budget (fail-closed, all intents)

- `query_repo_map` when `queryRepoMapCount >= maxQueryRepoMap` → block, reason
  "the map was already refined once", alternative "inspect the candidates
  already returned or read a candidate file".
- `read_file` when `readFileCount >= maxReadFiles` → block, "read budget
  exhausted", "narrow the range of an already-read file or ask a more specific
  question".
- `scan_project` when `scanCount >= maxScanProject` → block, "scan budget
  exhausted", "read a map candidate or run analyze_dependencies".
- `analyze_dependencies` when `analyzeCount >= maxAnalyzeDependencies` → block,
  "dependency analysis budget exhausted", "read the target and adjacent module
  files directly".

### R3 — exact duplicate (fail-closed, all intents)

- `read_file` of a path already in `readPaths` whose requested range overlaps a
  previously requested range, or where either range is unbounded → block,
  "already read <path>", "request a disjoint line range or a different file".
- `scan_project` of a directory already in `scannedPaths` → block, "already
  scanned <directory>".
- `analyze_dependencies` with a `(path, entry)` pair already recorded → block,
  "already analyzed <path> with entry <entry>".

### R4 — clearly unrelated read (fail-closed, clear intent only)

Fires only when all of the following hold:

1. `intent !== "unclear"`;
2. `navigation` is present and `navigation.confidence === "high"`;
3. `requestedAreas` is empty (the user did not ask for a non-product scope);
4. `proposed.name` is `read_file` or `analyze_dependencies`;
5. `classifyFileArea(proposedPath)` is `test`, `vendor`, `example`, or
   `generated`; and
6. no path in `readPaths` is a product-area candidate in
   `navigation.candidates`.

Then block with reason "reading <area> scope before verifying the
implementation", alternative "read <top product candidate path> first". This is
the narrow, high-signal case Issue #20 exposed: the model has a confident
product candidate but jumps to tests or vendor first. `proposedPath` is the
`path` argument (for `read_file`) or `path ?? "."` (for
`analyze_dependencies`).

### R5 — expansion after sufficient evidence (fail-closed, clear intent only)

- `entry`: a path in `readPaths` is a candidate in `navigation.candidates`, and
  `proposed.name === "scan_project"` with a root-level path (`"."` or absent) →
  block, "entry already located", "inspect the located entry's imports via
  analyze_dependencies if needed".
- `overview`: `readPaths` contains a README basename and a manifest basename
  (`package.json` or `tsconfig*.json`), and `proposed.name === "scan_project"`
  root-level → block, "overview evidence already gathered".
- `dependency`: `analyzeCount >= 1` and `proposed.name === "analyze_dependencies"`
  with no `entry` argument → block, "dependency chain already analyzed", "read
  a specific target or adjacent module".

### R6 — evidence-path mismatch (suggest / fail-open, clear intent only)

When `intent !== "unclear"`, `navigation` is present, and the proposed call
deviates from the preferred path before that path is satisfied, allow it but
attach a bounded hint. At most two hints are defined:

- `entry` and `proposed.name === "scan_project"` with no candidate read yet →
  hint "prefer read_file on a ranked entry candidate over a full scan".
- `entry` and `proposed.name === "query_repo_map"` with `queryRepoMapCount === 0`
  → hint "the map already ranks candidates; read the top candidate before
  refining".

### R7 — default allow

Everything not matched above executes unchanged.

## Delivery and message safety

A blocked call produces a tool result of the form
`Blocked: <reason> Next: <alternative>` with `isError: false`, so the TUI shows
a guarded decision, not a failure. A suggested call executes normally and has
`Hint: <hint>` prepended to its tool result. The tool_end event for a blocked
call carries a short `blocked: <reason>` summary so the activity log stays
legible.

All guard-authored strings are bounded (at most 200 code points), deterministic,
and composed only from tool names, known `FileArea` labels, and project-relative
paths that already appeared in the map or the proposed arguments. They never
embed source content, prompt text, map text, credentials, or error bodies.
Guard exceptions are caught and treated as `allow`, so a guard bug can never
break a model request or crash the run.

## Architecture ownership

- `agent.ts`: owns `EvidenceIntent`, `EvidenceState`, `EvidenceGuard`, the
  intent lexicon, and the rule evaluation. It imports only the already-exported
  `deriveQueryIntent`, `classifyFileArea`, and `FileArea` from `tool.ts`. At
  `run()` start it resets evidence, classifies intent once, and records
  `requestedAreas`; in `execute()` it consults the guard after argument parsing
  and permission handling but before tool execution, and updates evidence after
  each executed call.
- `agent.ts` run options: `AgentRunOptions` gains an optional
  `navigationSummary`, symmetric to the existing `transientContext`.
- `cli.ts`: `runWithNavigation` computes the map once and passes both
  `transientContext` (map text) and `navigationSummary`
  (`confidence` plus per-candidate `{ path, area }`) to `Agent.run`.
  `makeAgent` attaches `createEvidenceGuard()` so interactive and one-shot runs
  get the guard. The locked benchmark scripts construct `Agent` directly and do
  not pass a guard, so their trajectories are unaffected.
- `tool.ts`: no change except consuming the existing exports above.
- `tui.ts`, `llm.ts`: unchanged.

## Test and experiment plan

### Unit and integration tests

1. Intent classification: each trigger term maps deterministically; term
   precedence (overview > dependency > entry) holds; CJK-only and unknown
   prompts classify as `unclear`.
2. Duplicate detection: identical file, overlapping ranges, disjoint ranges
   (allowed), repeated scan directory, repeated dependency `(path, entry)`
   pair.
3. Budget enforcement for all four tools, with injected small budgets; over-limit
   calls block and never execute.
4. R4 fires only when all six preconditions hold; it never fires for an explicit
   non-product request, for `unclear` intent, or for a non-`high` map.
5. R5 fires per intent after the evidence predicate is satisfied; it never fires
   before that predicate.
6. R6 attaches a hint but still executes the call.
7. Unknown tool names are always allowed.
8. Guard exceptions and a guard-absent Agent preserve the existing behavior:
   the full current suite (`agent.test.ts`, `cli.test.ts`, `tool.test.ts`,
   `llm.test.ts`) remains green without modification.
9. Blocked/suggested messages are bounded and contain no source content, prompt
   text, or map text.

### Deterministic orchestration experiment

A new scripted harness (`benchmark-tool-orchestration` plus a verifier, both
Provider-free and deterministic) drives a scripted LLM through one fixture per
intent plus an unclear fallback, against the same locked DeepSeek Harness
commit and questions as Issue #16/#18. It must assert:

- duplicate and over-budget calls do not execute;
- blocked calls return a reason and an alternative;
- relevant evidence paths still execute (no false block on a correct read);
- a non-product-requesting question still reads its test file;
- an unclear-intent prompt runs ordinary ReAct with no relevance blocks.

The verifier compares executed tool calls, request characters, and outcome
against the locked Issue #18 baseline. The quality gate is unchanged from the
governing rubric: the expected source is still read and the final answer still
mentions the expected path. A reduction in tool calls or characters is a pass
only when that gate does not regress; otherwise the report records the trade-off
rather than shipping a cost claim.

### Live comparison (deferred, separately approved)

Any claim that the guard reduces real Provider cost is out of scope here. It
requires a separately recorded owner-run — pinned Provider/model, a fresh
budget, and Provider-reported usage — following the exact pattern of Issue #20,
and is never part of `npm test`.

## Acceptance criteria

- All new classification, duplicate, budget, relevance, message-safety, and
  regression tests pass alongside the current suite.
- An `Agent` without a guard behaves exactly as before; the locked Issue
  #16/#18/#20 benchmark outputs are unchanged.
- The deterministic orchestration experiment proves: duplicates and over-budget
  calls are blocked with an alternative; `unclear` intent falls back to ReAct;
  relevant and explicitly-requested scopes still execute; and the quality gate
  does not regress versus the locked baseline.
- Guard-authored strings are bounded, deterministic, and free of source, prompt,
  map, credential, and error content.
- No Provider API call is added to indexing, ranking, the guard, tests, or the
  deterministic experiment.

## Deferred follow-up

- Enabling/refining the guard for the live interactive CLI after the
  deterministic experiment passes owner review, plus the separately recorded
  live-Provider cost comparison.
- Broader intent lexicons, per-intent entry/overview/dependency evidence
  predicates, or a TypeChecker experiment if the deterministic result still
  leaves broad ambiguity.
- Issue #11 consumes the per-run evidence state to separate checked, unchecked,
  and unconfirmable facts in the final answer.
