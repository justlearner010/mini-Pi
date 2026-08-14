# Large TypeScript/JavaScript Project Efficiency Design

## Goal

Make mini-Pi more effective on large TypeScript/JavaScript projects without
turning a project overview into an unbounded dump of paths, file contents, or
model context. The work must demonstrably reduce the amount of information sent
to the model while preserving evidence-based answers.

The first delivery changes the default Agent turn limit from 8 to 16. This is a
capacity adjustment, not evidence of efficiency by itself. All later changes
must be compared against a locked baseline.

## Scope

- Only TypeScript and JavaScript project analysis.
- A deterministic benchmark harness for tool use, context size, and latency.
- A small, fixed real-Provider validation set for answer quality and API usage.
- A compact project map before detailed exploration.
- A bounded, evidence-only investigation summary for multi-turn work.
- Explicit exploration guidance: map first, then narrow to relevant directories,
  entry points, dependencies, and files.

## Non-goals

- No Python, Rust, Java, or other language dependency parser.
- No token streaming, hidden reasoning storage, persistent conversations, or
  unrestricted directory reads.
- No claim that character counts equal billing tokens.
- No real-Provider calls in unit tests or CI.
- No automatic merging based solely on benchmark numbers.

## Efficiency model

Efficiency has three independent dimensions:

| Dimension | Deterministic measure | Desired change |
| --- | --- | --- |
| Tool work | Agent turns, tool calls, files read, bytes read | Avoid irrelevant exploration |
| Context cost proxy | Serialized model-request characters and tool-result characters | Lower model input volume |
| User outcome | Rubric-backed answer facts and declared limitations | Preserve or improve quality |

Provider token usage is recorded only in the manual validation run when the
chosen Provider reports it. It is corroborating evidence, not the only gate.

## Benchmark corpus and questions

The repository will contain deterministic, generated TS/JS fixtures with:

- a small entry point and several unrelated directories;
- a multi-package or layered application shape;
- enough source files and dependency edges to exercise scan/result budgets;
- README and manifest facts that can be independently asserted.

Every fixture has fixed questions:

1. Where is the executable entry point and how is it started?
2. How does one named core module connect to its callers and dependencies?
3. Give a project overview, important directories, and explicit analysis limits.

The real-Provider validation uses the same three question classes against three
public TS/JS projects selected before the run. The exact commit SHA, project
path, Provider/model, timestamp, prompt, and response usage are recorded. API
keys, complete source text, and full provider responses are never committed.

## Required experiment report

Every implementation Issue must add an experiment report at:

\`\`\`text
docs/experiments/<issue-number>-<short-name>.md
\`\`\`

The report is a merge and Issue-close gate. It must contain:

1. Hypothesis and the commit compared with the baseline commit.
2. Fixture/project revision, questions, Provider/model if used, and commands.
3. A before/after metric table: turns, tool calls, files, bytes, request
   characters, tool-result characters, elapsed time, maximum-turn outcome, and
   reported Provider usage when available.
4. The answer-quality rubric result, with file-backed evidence for each fact.
5. Failures, variance, trade-offs, and a clear pass/fail recommendation.

The report must state when a metric is unavailable; it may not substitute an
estimate for a Provider-reported cost.

## Quality rubric

For each overview answer, reviewers score these independently:

- Correct entry point/start command when available.
- Correct framework/build or package-manifest evidence when available.
- Correct important directory/module description.
- Correctly identified dependency relationship for the chosen core module.
- Explicitly named uninspected or truncated scope.

Each claim must cite an inspected file or tool result. A candidate cannot score
lower than its baseline on any applicable item. Unsupported claims fail the
quality gate even if the context cost decreases.

## Issue sequence

### Issue A — Benchmark and baseline instrumentation

Deliver a test-only benchmark seam and a command that emits machine-readable
metrics for deterministic fixtures. Record the baseline at 8 turns and at 16
turns so capacity and efficiency are not conflated.

Acceptance:

- Existing tests remain green.
- Repeated deterministic runs produce identical metrics.
- Metrics include every deterministic field in the report template.
- A checked-in baseline report explains the effect of 8 versus 16 turns.
- No network or real credentials are needed.

### Issue B — Compact project map

Change initial project exploration so the model sees a compact map: top-level
and relevant directory counts, README/manifest/tsconfig clues, entry candidates,
language/build clues, truncation state, and suggested next investigation areas.
Detailed paths remain available only through explicitly scoped tool calls.

Acceptance:

- The benchmark overview prompt reduces serialized model-request characters by
  at least 35% versus the locked 16-turn baseline on two of three large
  fixtures.
- The applicable quality-rubric score is not lower than baseline.
- File/root boundary and 500-file safety tests remain green.
- The experiment report records all three fixtures, including any miss.

### Issue C — Goal-directed exploration policy

Add a small, visible investigation policy to the system prompt and tool
feedback. The next action must target one missing fact: structure, entry point,
dependency relationship, candidate source, contradiction, or stated limit.

Acceptance:

- Scripted Agent traces show map -> narrow -> inspect -> answer ordering for the
  benchmark questions.
- Average tool calls are no more than 110% of the locked 16-turn baseline.
- No benchmark run reaches the maximum-turn error.
- The answer-quality gate still passes.

### Issue D — Evidence-only investigation summary

After bounded exploration, retain a compact structured summary of confirmed
facts, current question, inspected evidence, and known limits instead of
repeatedly carrying full historical tool output. The summary contains only
returned tool facts, never hidden reasoning or invented conclusions.

Acceptance:

- Multi-turn benchmark request characters decrease by at least 40% from the
  locked 16-turn baseline.
- The same file is not read twice unless the request explicitly asks for a
  different line range or the source changed.
- Summary provenance is testable: every entry refers to an earlier tool result.
- Quality does not regress and real-Provider usage does not increase in the
  manual comparison.

## Real-Provider validation gate

For every candidate Issue, run:

\`\`\`text
3 public projects × 3 fixed questions × baseline/candidate
\`\`\`

This is 18 calls per comparison. Use one pinned Provider/model per comparison;
do not compare different models. A reviewer checks the rubric and records
Provider usage where returned. The candidate passes only if it has no quality
regression and does not increase reported input usage/cost; if usage is
unavailable, deterministic context reduction plus the quality rubric are
required and the report must say so.

## Failure handling

- If a candidate reduces context but loses a rubric fact, reject or revise it.
- If a candidate improves a synthetic fixture but not public projects, record
  the mismatch and do not claim real-world efficiency.
- If a Provider run is unavailable, preserve the deterministic report and mark
  real validation pending; do not close the Issue as fully validated.
- If 16 turns still reaches the ceiling, return a bounded, evidence-based
  partial answer in a later Issue rather than silently raising the limit again.

## Workflow

Each Issue follows the repository contribution workflow:

1. Issue-specific design and test plan.
2. Dedicated branch and TDD implementation.
3. Experiment report and validation output in the PR.
4. Owner review.
5. Merge only after approval.
