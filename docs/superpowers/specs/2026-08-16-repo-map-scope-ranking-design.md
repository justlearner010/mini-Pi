# Scope-aware Repo Map candidate ranking

## Status and relationship to Issues 9, 10, 16, and 18

This is the owner-review design for Issue #18. It is intentionally stacked on
the Issue #9 branch because #9 supplies the local `RepositoryIndex`, bounded
Repo Map rendering, and `query_repo_map` refinement tool that this issue
improves. It is informed by the controlled external evaluation in Issue #16.

Issue #10 remains a separate effort: it will decide when the Agent should
explore or stop, and will add evidence-aware tool orchestration. Issue #18
does not add tool-call policy, semantic search, or an LLM planner. It makes
the existing deterministic candidate list more useful before #10 decides what
to do with it.

This document is design-only. Code changes begin only after owner review of
this specification and a dedicated implementation plan.

## Problem statement

Issue #9 can construct a bounded syntax-only map, but its first ranking is
mostly lexical. The Issue #16 DeepSeek Harness experiment demonstrated the
failure mode on a large multi-package TypeScript repository: generic words
such as `CLI`, `agent`, `adapter`, and `tool` often rank barrel files, tests,
or unrelated package files above the implementation a user should inspect.

The Agent consequently spends turns and tokens reading plausible-looking but
irrelevant files. The goal is not to make the map answer a question. The goal
is to provide a smaller, better ordered set of source locations that the Agent
can verify with `read_file` and, when needed, `analyze_dependencies`.

## Goal

For a TypeScript/JavaScript repository, derive a deterministic, explainable
ranking that combines query intent, file area, nearest workspace package, and
existing syntax/index facts. For ordinary implementation-navigation questions,
product implementation files should be preferred over tests, generated files,
examples, and third-party/vendor code without making those scopes unreachable.

The desired path becomes:

```text
question
  -> local deterministic intent + scoped ranking
  -> compact candidate Repo Map with reasons and confidence
  -> inspect candidate source evidence
  -> (Issue #10 later decides whether more exploration is justified)
```

## Non-goals

- No embeddings, vector database, BM25 service, PageRank, or LLM classifier.
- No TypeScript `Program`/`TypeChecker`, complete call graph, body semantics,
  dynamic-import resolution, or runtime-routing claims.
- No permanent hiding of test, vendor, example, or generated scope.
- No automatic answer based on ranking alone; source inspection remains
  mandatory before factual implementation claims.
- No changes to Issue #9 file/byte/map resource limits, Provider protocol,
  or on-disk persistence.
- No tool-order blocking, duplicate-call prevention, or stop-policy logic;
  those are Issue #10 responsibilities.

## Inputs and bounded local metadata

Issue #18 consumes the existing immutable `RepositoryIndex` and the current
question. It adds only small local metadata.

```ts
type FileArea = "product" | "test" | "vendor" | "example" | "generated";

interface PackageInfo {
  root: string;                 // project-relative directory, `.` for root
  name?: string;                // package.json name, if safely readable
  workspace: boolean;           // true for a discovered nested package
}

interface RankedCandidate {
  path: string;
  area: FileArea;
  packageRoot: string;
  packageName?: string;
  score: readonly number[];     // deterministic ordering tuple
  reasons: readonly string[];   // bounded human-readable evidence
}

interface QueryIntent {
  tokens: readonly string[];
  requestedAreas: readonly FileArea[];
  roles: readonly ("cli" | "adapter" | "loop" | "registry" | "config")[];
  implementationSeeking: boolean;
}
```

`FileInfo` remains source-only; the implementation may attach a serializable
area and package reference beside it in the index. It must not store file
bodies, credentials, environment values, or full manifest contents.

### File-area classification

Classification is a conservative, path-only rule applied after existing
discovery/ignore rules:

| Area | Deterministic path evidence |
| --- | --- |
| `test` | a `test`, `tests`, `__tests__`, `spec`, or `specs` directory; or `.test.*` / `.spec.*` basename |
| `vendor` | `vendor`, `third_party`, `third-party`, or `external` directory |
| `example` | `example`, `examples`, `demo`, `demos`, or `sample` directory |
| `generated` | `generated`, `gen`, or `codegen` directory; or `.generated.*` basename |
| `product` | every remaining supported source file |

The first applicable explicit area follows the table order; all unclassified
files are `product`. These rules are visible in tests and documentation rather
than inferred from arbitrary source text. They are deliberately imperfect:
an unusual project layout remains available through lexical matches and
`query_repo_map`, rather than being silently excluded.

### Package discovery

The index discovers the root `package.json` and the nearest ancestor
`package.json` for each already-discovered source file. Each candidate manifest
is parsed locally only when it is a regular file at most 256 KiB; only its
string `name` is retained. Invalid, absent, unreadable, or oversized manifests
produce an unnamed package and never abort indexing.

No workspace glob expansion, dependency installation, script execution, or
manifest `exports` interpretation is added. A nested manifest means
`workspace: true`; the project root is `workspace: false`. Package membership
is therefore a local directory fact, not a claim about runtime module
resolution.

## Deterministic intent extraction

The renderer normalizes query words using the Issue #9 path/symbol splitter.
It then applies a small explicit lexicon:

| Role | Recognized query terms | Strong matching file/symbol terms |
| --- | --- | --- |
| `cli` | cli, command, terminal, shell | cli, command, bin, terminal |
| `adapter` | adapter, provider, llm, model | adapter, provider, llm, client |
| `loop` | loop, agent, run, turn | agent, loop, run, turn |
| `registry` | tool, tools, registry, execute | tool, registry, execute |
| `config` | config, configuration, settings, env | config, settings, env, option |

`test`, `spec`, `fixture`, `vendor`, `third party`, `example`, `demo`,
`generated`, and `codegen` explicitly request their corresponding areas. A
question with a role and without an explicit non-product area is treated as
implementation-seeking. Questions without recognized intent retain the
existing lexical behavior and receive no product-scope preference.

This approach is intentionally explainable: a candidate reason can say
`role: adapter` or `scope: product`, never "semantic similarity". It is also
limited: synonyms outside the table may not receive a role boost. That is an
observable limitation for later experiments, not a hidden heuristic.

## Ranking algorithm

Ranking remains deterministic and uses a lexicographic score tuple; a higher
component wins and project-relative path remains the final stable tie-breaker.
The exact numeric constants may be implemented as named constants, but their
priority order must remain:

1. exact symbol/export identifier match;
2. explicit requested-area match, or product-area preference for an
   implementation-seeking question;
3. role match in basename/path or exported symbol;
4. package-name/package-path token match;
5. existing symbol/export token-match count;
6. existing basename/path token-match count;
7. query-relevant entry evidence (only when an entry-like role is requested);
8. existing local incoming-dependency count;
9. lexical project-relative path.

Area preference is a boost, not a filter. For example, a query explicitly
asking for tests makes test files eligible for the corresponding preference;
an exact symbol match in a test still remains visible even for an ordinary
implementation question. Neighbor expansion remains one local dependency hop
and happens after ranked direct seeds, within Issue #9's candidate cap.

Each rendered candidate includes at most three short reasons selected from
`exact symbol`, `scope`, `role`, `package`, `path`, `entry`, and `dependency`.
This lets the Agent and user distinguish a high-confidence implementation
candidate from a merely lexical fallback.

## Ambiguity and evidence guardrails

The Repo Map must label its result as one of:

- `confidence: high` — there is at least one direct candidate and its leading
  ranking evidence is stronger than the next direct candidate;
- `confidence: ambiguous` — direct candidates tie on all meaningful ranking
  components, or only broad lexical/path evidence exists;
- `confidence: fallback` — no direct lexical match; bounded entry candidates
  are shown as in Issue #9.

Ranking never upgrades a candidate to a verified answer. The per-run context
will remind the model to read a candidate before describing bodies, behavior,
or module ownership as fact. When the map is ambiguous, the model may call
`query_repo_map` once with a narrower natural-language query, then inspect the
returned source. It may use `scan_project` or `analyze_dependencies` for
broader structural verification. Issue #10 will later formalize when those
calls are warranted and prevent wasteful repetition.

## Rendered map changes

Issue #9's 4,000-character automatic-map and 8,000-character refinement-map
budgets remain unchanged. The `FILES`/`SYMBOLS` candidate rendering gains only
compact metadata, for example:

```text
src/llm.ts  [product · package mini-pi]
  function createLLM(config: LLMConfig): LLM · line 42
  reason: scope product; role adapter; symbol/provider match

SCOPE
confidence: high
source bodies not inspected
```

Reduction keeps confidence, candidate paths, and their reasons before
decorative tree lines or nonmatching symbols. Map truncation remains explicit.
Neither map nor reasons are persisted into conversation history after a run.

## Architecture ownership

- `tool.ts`: computes area/package facts while constructing the index, extracts
  deterministic `QueryIntent`, ranks candidates, and renders reasons and
  confidence for automatic and refinement maps.
- `agent.ts`: keeps the existing transient-context boundary and evidence
  reminder; it does not choose tools or judge completion in this issue.
- `cli.ts`: continues to build/reuse one immutable index per session and
  compose the current question's transient map.
- `tui.ts`: may show only the existing safe indexed-summary state, never raw
  map text or source-derived package metadata.
- `llm.ts`: remains unchanged Provider conversion.

## Test and experiment plan

### Unit and integration tests

1. Classify representative `product`, `test`, `vendor`, `example`, and
   `generated` paths deterministically, including an explicit test query that
   promotes test scope rather than hiding it.
2. Associate source files with root and nested package names; verify missing,
   invalid, oversized, and unreadable manifests degrade safely.
3. Verify role/path/symbol/package ranking order, lexical tie stability, and
   explicit reasons without source-body reads.
4. Verify `high`, `ambiguous`, and `fallback` confidence labels; ambiguous
   output must never claim a candidate is verified.
5. Preserve Issue #9 bounds: four-kilobyte automatic maps, eight-kilobyte Tool
   maps, eight candidates, one-hop neighbor cap, and no persistent full map.
6. Preserve all existing scan/read/dependency tools and Provider-free tests.

### Controlled external regression

The existing Issue #16 DeepSeek Harness harness is extended, still without
Provider calls. It uses its fixed commit and five predeclared navigation
questions. The product-source scope must reach at least Top-3 `4/5` and Top-1
`3/5`; full-repository measurements remain reported rather than discarded.
The report compares baseline #16 against #18 for none/map-4K/map-8K,
candidate rank, rendered characters, candidate source bytes, tool calls, model
requests, and elapsed local time. It must also record failures, variance, and
the cases where the small lexicon still ranks poorly.

These thresholds measure navigation-candidate quality, not factual-answer
quality. Any claim that an Agent answered correctly still requires a separate
Provider-backed evaluation with inspected-source evidence.

## Acceptance criteria

- All new classification, package, ranking, ambiguity, safety, and regression
  tests pass alongside the current suite.
- Existing Issue #9 resource limits and no-persistence boundary stay intact.
- The DeepSeek Harness product scope reaches Top-3 >= 4/5 and Top-1 >= 3/5
  under the fixed scripted evaluation, with the complete experiment report
  committed.
- Every rendered direct candidate has bounded, deterministic ranking reasons.
- Non-product scopes remain reachable on explicit request and are never
  silently excluded.
- No Provider API call is added to indexing, ranking, tests, or experiments.

## Deferred follow-up

If the controlled result still leaves broad ambiguity, future work can compare
larger but explainable role lexicons, package-entry inference, or a TypeChecker
experiment. None is implied by this issue. Issue #10 remains the next separate
step for deciding how the Agent uses map evidence to orchestrate tools.
