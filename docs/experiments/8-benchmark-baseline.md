# Issue 8 large-project benchmark baseline

## Revision context

- Code baseline (before Issue 8): `29fd2154cbfd13727dc804f8f5c8aba5ed7fa87c`.
  Its default Agent limit was 8 turns and it predates this benchmark harness.
- Candidate limit change: `f96cf28584e4732d34d3353a6357d7151b166456`,
  with the boundary regression added in `8309008`.
- Fixture and harness context: the measured checkout was at
  `d9ef9e01a753dbfe8f286bb2551396764810941b` before this report and verifier
  were added. That history includes the fixed fixtures, the runner introduced
  in `4ae072c`, corrected metrics in `cb44f4f`, and fresh-build command contract
  in `d9ef9e0`.

Because the runner did not exist at `29fd215`, the table does not claim a
historical benchmark execution from that commit. The current deterministic
harness explicitly runs `maxTurns: 8` to represent the before-limit and
`maxTurns: 16` to represent the candidate limit against identical fixtures and
scripted replies.

## Hypothesis

Raising the default limit from 8 to 16 should increase bounded task capacity,
not reduce work per completed normal analysis. The three normal projects should
produce the same non-timing metrics at both limits; the capacity-boundary case
should fail at 8 and answer at 16; work beyond the new default should still stop
at 16. This experiment does not claim an optimization.

## Measurement procedure

The report data came from a fresh build and a captured runner document:

```sh
npm run build
node scripts/benchmark-large-project.mjs > /tmp/mini-pi-benchmark.json
npm run verify:benchmark
```

The runner uses only fixed repository fixtures, scripted model replies, and
read-only local tools. It makes no Provider or network calls.

### Fixture questions, revision, and Provider status

The fixture revision is the `d9ef9e0` harness checkout named in the revision
context. Each fixture uses the same fixed question classes required by the
governing design:

1. Where is the executable entry point and how is it started?
2. How does one named core module connect to its callers and dependencies?
3. Give a project overview, important directories, and explicit analysis
   limits.

No Provider or model was used for this deterministic run, so Provider model,
timestamp, response usage, and reported input/cost are unavailable. This
report does not estimate them from characters; the owner-run section records
the required manual comparison instead.

## Metric definitions and limits

| Metric | Definition |
| --- | --- |
| `turns` | Completed Agent turns, or model request count when the maximum-turn error ends the run. |
| `modelRequests` | Calls to the scripted LLM `generate` method. |
| `toolCalls` | Executed read-only tool calls. |
| `filesRead` | One per `read_file`, plus `analyzedFileCount` reported by `analyze_dependencies`. |
| `returnedFileBytes` | UTF-8 bytes in raw file content returned by `read_file`; it excludes envelopes and dependency output. |
| `requestCharacters` | Sum of `JSON.stringify({ messages, tools }).length` for every model request. |
| `toolResultCharacters` | Sum of `JSON.stringify(result.content).length` for executed tools. |
| `elapsedMs` | Local monotonic wall-clock duration. It is recorded but removed from deterministic equality. |

These are harness-level counts, not token or cost estimates. The fixtures are
small and controlled, the LLM is scripted, and elapsed time is too noisy for a
performance conclusion. The benchmark checks capacity, metric stability, and
known-file recovery; it does not establish real-Provider answer quality or
large-repository latency.

## Measured before/after runs

These are the nine runs copied from `/tmp/mini-pi-benchmark.json`. “Before” and
“candidate” identify the explicit limit under test, as described above.

| Context | Fixture | Max turns | Outcome | Turns | Model requests | Tool calls | Files read | File bytes | Request chars | Tool-result chars | Elapsed ms |
| --- | --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Before limit | alpha-service | 8 | answered | 4 | 4 | 3 | 4 | 134 | 8335 | 1036 | 22.900375 |
| Candidate | alpha-service | 16 | answered | 4 | 4 | 3 | 4 | 134 | 8335 | 1036 | 2.286542 |
| Before limit | beta-workspace | 8 | answered | 4 | 4 | 3 | 4 | 147 | 8508 | 1141 | 2.867833 |
| Candidate | beta-workspace | 16 | answered | 4 | 4 | 3 | 4 | 147 | 8508 | 1141 | 2.027333 |
| Candidate | beyond-default | 16 | maximum_turns | 16 | 16 | 16 | 0 | 0 | 82778 | 5248 | 5.245291 |
| Before limit | capacity-boundary | 8 | maximum_turns | 8 | 8 | 8 | 0 | 0 | 24728 | 2624 | 2.746583 |
| Candidate | capacity-boundary | 16 | answered | 10 | 10 | 9 | 0 | 0 | 36110 | 2952 | 2.950125 |
| Before limit | gamma-layered | 8 | answered | 4 | 4 | 3 | 4 | 135 | 8447 | 1172 | 2.324333 |
| Candidate | gamma-layered | 16 | answered | 4 | 4 | 3 | 4 | 135 | 8447 | 1172 | 1.604667 |

The normal fixture metrics are identical between 8 and 16 after excluding
elapsed time. At the capacity boundary, 8 fails after eight requests while 16
succeeds on turn 10. The beyond-default case still fails at 16, so the new
default remains a finite boundary rather than permitting unbounded work.

## File-backed quality rubric

The 8-turn and 16-turn normal traces use the same fixture facts, so neither
side regresses on an applicable deterministic rubric item. The score below is
for evidence recoverability in the scripted run, not a claim about an
open-ended Provider answer.

| Criterion | Before (8) | Candidate (16) | Evidence |
| --- | ---: | ---: | --- |
| Manifest / build evidence | 3/3 | 3/3 | Each package name, `type`, and start script is stored in [alpha-service/package.json](../../test/fixtures/efficiency/alpha-service/package.json), [beta-workspace/package.json](../../test/fixtures/efficiency/beta-workspace/package.json), and [gamma-layered/package.json](../../test/fixtures/efficiency/gamma-layered/package.json). No framework-specific build fact is present, so none is claimed. |
| Entry-point / start command | 3/3 | 3/3 | The same manifests point to `src/index.ts`, `packages/api/src/main.ts`, and `src/server.ts`; the [runner](../../scripts/benchmark-large-project.mjs) queries those exact entries. |
| Important directory / module description | 3/3 | 3/3 | The runner first calls `scan_project`; source evidence identifies [alpha's session module](../../test/fixtures/efficiency/alpha-service/src/auth/session.ts), [beta's API router](../../test/fixtures/efficiency/beta-workspace/packages/api/src/router.ts), [beta's web app](../../test/fixtures/efficiency/beta-workspace/packages/web/src/app.ts), and [gamma's domain](../../test/fixtures/efficiency/gamma-layered/src/domain/orders.ts) / [infrastructure](../../test/fixtures/efficiency/gamma-layered/src/infra/store.ts) modules. |
| Core-module dependency relationship | 3/3 | 3/3 | [alpha index](../../test/fixtures/efficiency/alpha-service/src/index.ts) imports `auth/session`, [beta main](../../test/fixtures/efficiency/beta-workspace/packages/api/src/main.ts) imports `router`, and [gamma server](../../test/fixtures/efficiency/gamma-layered/src/server.ts) reaches `domain/orders` then `infra/store`. |
| Explicit uninspected / truncated scope | 3/3 | 3/3 | Normal traces invoke `scan_project`, read only `package.json` through `read_file`, then analyze the configured entry. They do not read [alpha's unused report](../../test/fixtures/efficiency/alpha-service/src/unused/report.ts), [beta's web app](../../test/fixtures/efficiency/beta-workspace/packages/web/src/app.ts), or fixture READMEs. The runner does not persist a scan truncation flag, so truncation status is unavailable rather than asserted absent. |
| Stated-limit fact | 3/3 | 3/3 | The [runner](../../scripts/benchmark-large-project.mjs) encodes the normal, capacity-boundary, and beyond-default replies; the measured outcomes match all three stated boundaries. |

Score: 18/18 file-backed checks for both limit settings. This only means that
the deterministic fixtures and scripted questions have recoverable evidence;
it is not a score for open-ended model reasoning.

## Failures, variance, and trade-offs

- Failures: the capacity-boundary trace reaches `maximum_turns` at 8, and the
  beyond-default trace reaches `maximum_turns` at 16. A live Provider run and
  Provider usage are unavailable, so real-world quality and cost remain
  unvalidated.
- Variance: `elapsedMs` differs between invocations (including process warm-up
  effects), so it is excluded from the deep-equality check and is not compared
  as a speed result. Every non-timing metric is repeatable under the scripted
  harness.
- Trade-off: 16 turns lets the capacity-boundary trace complete, but that
  completed trace uses 10 model requests and 36,110 request characters versus
  the 8-turn failure's 8 requests and 24,728 characters. The beyond-default
  trace still spends 16 requests and 82,778 characters before stopping. This
  is bounded extra capacity, not demonstrated context, token, or cost
  reduction.

## Recommendation

**PASS for baseline instrumentation and the bounded 8-versus-16 capacity
record. NOT evidence of cost reduction or real-Provider efficiency.** Keep
this report as the locked deterministic baseline; do not close real-Provider
validation until the owner-run matrix supplies pinned Provider/model, project
revisions, timestamps, rubric outcomes, and Provider-reported usage when the
Provider exposes it.

## Verification results

TDD first produced the expected RED: after a successful build,
`npm run verify:benchmark` exited 1 with `MODULE_NOT_FOUND` for the absent
verifier. After implementation, the same command exited 0 and printed exactly
`benchmark verification passed`.

The final validation set covers:

```sh
npm test
npm run check
npm run build
npm run benchmark:large
npm run benchmark:large:json
npm run verify:benchmark
npm run verify:bin
npm run verify:package
git diff --check
```

All commands above exited 0. Both benchmark commands emitted a single
parseable nine-run JSON document, and the verifier confirmed two independent
runs are deeply equal after removing only `elapsedMs`.

## Real Provider validation: pending owner-run

This deterministic benchmark does not use credentials or call a live
Provider. The owner-run matrix is 3 projects x 3 questions x 2 revisions = 18
sessions. Run each question once at code baseline `29fd215` and once at the
candidate revision, recording only pass/fail, aggregate counts, and concise
evidence references. Do not record API keys, source dumps, or full model
outputs.

| Project | Question | Baseline | Candidate |
| --- | --- | --- | --- |
| alpha-service | Q1 manifest and entry point | pending | pending |
| alpha-service | Q2 dependency path | pending | pending |
| alpha-service | Q3 stated limit or unused-file distinction | pending | pending |
| beta-workspace | Q1 manifest and entry point | pending | pending |
| beta-workspace | Q2 dependency path | pending | pending |
| beta-workspace | Q3 stated limit or workspace distinction | pending | pending |
| gamma-layered | Q1 manifest and entry point | pending | pending |
| gamma-layered | Q2 dependency path | pending | pending |
| gamma-layered | Q3 stated limit or layer distinction | pending | pending |
