# Large-project intelligence and local trace design

## Status and dependency

This design is approved for planning only. Implementation starts only after
Issue 8 is merged into `main`, because its deterministic fixtures and benchmark
contract are the baseline for the work below.

The work is intentionally split into four reviewable GitHub Issues:

1. **Issue 9 — compact project map**
2. **Issue 10 — goal-directed tool orchestration**
3. **Issue 11 — evidence-bounded answers**
4. **Issue 12 — local safe run traces**

Each Issue must use its own branch and PR, include tests plus a report at
`docs/experiments/<issue>-<short-name>.md`, and wait for owner review before
merging. No Issue may claim lower real-Provider cost without a separately
recorded owner-run using a pinned Provider/model and Provider-reported usage
where available.

## Goals

For unfamiliar projects, mini-Pi should first gain a compact, stable project
shape, then explore only evidence relevant to the user's question, and finally
separate verified facts from uninspected scope. Every run should leave a local,
privacy-preserving trace that makes its activity measurable and debuggable.

The design supports a general directory map for any language. TypeScript and
JavaScript receive the current repository's deeper static hints because the
existing dependency analyzer supports those languages.

## Non-goals

- No general-purpose planner, autonomous task queue, write/delete/shell/network
  tool, or additional permission scope.
- No claim that static analysis understands dynamic imports, runtime routing, or
  non-TS/JS dependency semantics.
- No default persistence of full prompts, model completions, source content,
  tool-result bodies, API keys, Authorization headers, or raw Provider errors.
- No hosted observability service, account, or network upload.
- No detailed trace-content mode in this milestone; it remains deferred.

## Issue 9: compact project map

### Behavior

At every interactive session start, CLI builds one project map before the first
user question. The map is an internal context block with a hard 4,000-character
UTF-16 JavaScript string limit. TUI prints only a concise status such as:

```text
Project map loaded · 86 files · 2 entry candidates
```

For any language, the map contains stable, sorted directory/file-type counts,
README and common manifest/config clues, scan truncation state, ignored scope,
and candidate next areas. For TS/JS it additionally includes `package.json`
name/scripts, `tsconfig*.json`, likely entry files from start scripts, and a
bounded static dependency summary. All paths remain project-root-relative.

If scan or map construction fails, CLI writes a short safe status and starts
the session without a map. The Agent can still use existing tools normally.

### Map budget and reduction order

The renderer must fit the limit deterministically. It keeps, in order:

1. safety/truncation and root information;
2. README, manifests, entry and build clues;
3. top-level directory counts and source-language totals;
4. TS/JS dependency summaries and candidate next areas;
5. lower-ranked file samples.

It truncates at section boundaries and appends an explicit omitted-scope line;
it never cuts paths or JSON in the middle. It does not read arbitrary source
file contents merely to make a map.

### Acceptance and experiment

Against the locked Issue 8 16-turn baseline, an overview prompt on at least two
of three deterministic fixtures must reduce request characters by at least 35%
without a quality-rubric regression. The report records baseline/candidate
metrics, fixture revision, result, and known limitations. Existing scan root,
symlink, binary, and truncation tests remain green.

## Issue 10: goal-directed tool orchestration

### Principle

The model remains the decision-maker. A small deterministic evidence guard
checks whether a requested tool call can close an identified evidence gap. This
is not a second LLM and not a rigid workflow engine.

First-version intent classes are:

| Intent | Preferred evidence path |
| --- | --- |
| Entry/startup | manifest or build clue → entry candidate → limited entry reads |
| Dependency chain | dependency analysis → target and adjacent module reads |
| Project overview | compact map → selected README/manifest or key directory evidence |

When intent is unclear, orchestration falls back to ordinary ReAct rather than
misclassifying a request.

### Guard decisions

Before tool execution, a guard receives the user goal, compact map summary,
already obtained evidence, and proposed tool name/arguments. It may:

- **allow** a relevant, new evidence-gathering call;
- **block** an exact duplicate, clearly unrelated read, budget-exhausted call,
  or expansion after sufficient evidence; or
- **suggest** a safer/relevant next call in a short tool result.

Blocked calls do not execute. The response says why, names the evidence gap or
budget state, and offers a path such as `analyze_dependencies` before reading
unrelated files. This is deliberately fail-open only for unclear intent; it is
fail-closed for exact duplicates and already exhausted limits.

### Acceptance and experiment

Use deterministic scripted runs for each intent and at least one unclear-intent
fallback. Assert duplicate calls do not execute, blocked calls provide an
alternative, relevant paths still execute, and unconstrained ReAct remains
available for unclear prompts. Compare tools, request characters, and outcomes
with the locked baseline. A reduction is a pass only if the answer-quality
rubric does not regress; otherwise report the trade-off rather than shipping a
cost claim.

## Issue 11: evidence-bounded answers

Before the final answer, mini-Pi derives a compact evidence state from actual
tool results. The answer format must distinguish:

- **Checked:** files, manifests, or dependency edges actually observed;
- **Not checked:** relevant paths/modules not opened or not analyzed;
- **Cannot confirm:** dynamic behavior, unsupported language semantics, scan
  truncation, missing file, or exhausted budget.

The model may write a natural explanation, but it must not state an unobserved
fact as verified. If no relevant evidence exists, it says so plainly instead of
inventing a conclusion.

Tests cover an uninspected critical file, scan truncation, unresolved
dependency, unsupported source language, and a normal evidence-backed answer.
The report scores answers against the governing rubric and includes counter-
examples, not only successful runs.

## Issue 12: local safe run trace

### Ownership and flow

Trace persistence belongs in `cli.ts`, preserving the five-file architecture.
`agent.ts` remains an event-producing core and never opens trace files. CLI
fans each Agent event to both TUI rendering and a `TraceWriter`; replacement
Agents created by `/login` or `/model` use the same sink.

```text
Agent event → CLI fan-out → TUI view
                         → TraceWriter → ~/.mini-pi/traces/<runId>.jsonl
```

One run gets one JSONL file. Appending each event permits diagnosis after a
crash without retaining a whole run in memory. A run end record is attempted
for normal completion, tool/model failure, max-turn failure, and cancellation.

### Stored records

Every line has `schemaVersion`, `runId`, ISO timestamp, monotonic elapsed
milliseconds, and one of these event kinds:

| Kind | Safe fields |
| --- | --- |
| `run_start` | project-root display name, provider, model, prompt character count |
| `model_start/end` | turn, duration, request character count, tool-call count, outcome category |
| `tool_start/end` | turn, tool name, safe argument summary, duration, outcome category, result character count |
| `run_end` | outcome, total turns/tools/duration, final-answer character count |

Safe argument summaries are allowlisted per built-in read-only tool and have
length caps. Any unknown field is omitted. All stored strings receive the
existing terminal-control/default-ignorable sanitizer plus a trace-specific
length cap. Trace records never contain raw content, key-like strings, token-
like strings, headers, raw exception messages, full prompts, final answers,
source snippets, or complete tool results.

### Retention and TUI

At CLI startup, trace maintenance removes files older than seven days. It also
enforces a documented total directory size cap by deleting oldest regular trace
files first. Invalid files, symlinks, and paths outside the trace directory are
never followed or deleted. Maintenance failure only disables trace persistence
for that run and emits a safe TUI notice; it does not stop Agent execution.

At run end, TUI displays a short `Trace saved: <path>` line. `/trace` lists
recent run summaries only: timestamp, project display name, provider/model,
outcome, turns, tools, and duration. It never renders raw JSONL content.

### Acceptance

- Normal, tool-error, model-error, max-turn, EOF, and Ctrl+C paths produce
  safe, parseable records when the trace directory is writable.
- Tests inject key-like text, terminal controls, default-ignorables, long
  source content, and raw Provider failures, then prove none are persisted.
- Seven-day expiry and size eviction are deterministic under injected clock and
  filesystem adapters; symlink/outside-target safety is covered.
- Writer and maintenance failure leave the interactive run usable.
- `/trace` is summary-only and deterministic.

## Sequencing and close gates

Issue 9 must land before Issue 10, and Issue 10 before Issue 11. Issue 12 may
be implemented after Issue 8 independently, but its measurements become most
valuable once Issues 9–11 exist. Each PR runs the full test suite, type check,
build, relevant benchmark/verifier, and `git diff --check`. Each experiment
report distinguishes deterministic local metrics from any live-Provider
owner-run and labels unavailable data as not measured.
