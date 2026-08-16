# Live Provider Repo Map Evaluation Telemetry Design

## Status and relationship

This is the owner-approved design for Issue #20. It is stacked after Issue #18
because it evaluates the actual Repo Map path, not a separate SDK imitation.
It adds opt-in measurement only; it does not alter candidate ranking, Agent
tool policy, normal CLI output, or the Provider request shape.

Issue #18's deterministic fake-LLM benchmark remains the merge-quality gate.
Issue #20 adds a bounded live DeepSeek observation to help the owner decide
whether that deterministic gain translates to actual Provider behavior.

## Goal

Measure real Provider token usage and latency while mini-Pi runs five
predeclared navigation questions against the local read-only
`deepseek-harness` repository. Record enough aggregate evidence to compare
the live Agent path with the deterministic experiment without persisting
credentials, full prompts, source text, tool results, or model answers.

## Non-goals

- No streaming or token-by-token rendering; therefore no TTFT measurement.
- No tracing SaaS, database, dashboard, background collection, or normal CLI
  log file.
- No retries, model fallback, prompt optimization, or ranking change.
- No claim that five questions measure general model quality or real monetary
  cost.
- No changes to the target repository and no execution of its code.

## Telemetry contract

`llm.ts` gains an optional callback on `createLLM`; existing callers that
omit it behave exactly as before.

```ts
export interface ProviderUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}
export interface LLMTelemetryEvent {
  provider: ProviderName;
  model: string;
  outcome: "success" | "failure";
  durationMs: number;
  usage?: ProviderUsage;
}
export type LLMTelemetry = (event: LLMTelemetryEvent) => void;
export function createLLM(
  config: LLMConfig,
  client?: ProviderClient,
  telemetry?: LLMTelemetry
): LLMClient;
```

The callback fires exactly once per attempted Provider request after the request
settles. A success event reads only finite non-negative integer
`usage.prompt_tokens`, `usage.completion_tokens`, and
`usage.total_tokens` from the raw response. A failure event has no usage.
It contains no request ID, headers, error message, prompt, response, tool
arguments, API key, or source-derived text. Exceptions from telemetry are
caught and cannot change an Agent result.

## Live evaluator and hard budget

A dedicated script runs five fixed questions from Issue #16/18 against
`/Users/jay/deepseek-harness` at its recorded commit, using the owner-selected
saved DeepSeek credential and `deepseek-v4-flash`.

For each question it builds the existing local RepositoryNavigation, passes the
automatic 4,000-character map transiently, and runs a real `Agent` with
`maxTurns: 6`. A wrapper around the LLM client increments a shared budget
*before* invoking `generate` and rejects once 20 requests have begun. This
guarantees no twenty-first network request even if a model repeatedly calls
tools. There is no automatic retry. Each question runs sequentially.

Tool wrappers record only: tool name, call count, and for `read_file` the
project-relative requested path plus whether it was one of that question's
predeclared expected paths. The script computes boolean
`expectedSourceRead` and `answerMentionsExpectedPath` in memory, but does
not write answer text. It emits one JSON document to stdout and a human report
derived from that JSON.

## Result schema and privacy boundary

Each question row contains:

```ts
interface LiveEvaluationRow {
  id: string;
  outcome: "answered" | "maximum_turns" | "budget_exhausted" | "provider_failure" | "agent_failure";
  turns: number;
  providerRequests: number;
  requestDurationMs: number[];
  endToEndDurationMs: number;
  usage: ProviderUsage;
  toolCalls: number;
  toolsByName: Record<string, number>;
  readPaths: string[];
  expectedSourceRead: boolean;
  answerMentionsExpectedPath: boolean;
  repoMapTop1: boolean;
  repoMapTop3: boolean;
  telemetryComplete: boolean;
}
```

The committed report contains aggregates and these boolean/path-level facts
only. It must not contain API credentials, original prompts, system prompts,
Repo Map text, source contents, tool output, raw errors, request IDs, or model
answer text. If the Provider omits usage, the report says `NOT REPORTED`
rather than estimating it.

## Failure handling

- Missing credential, unavailable model, network/Provider failure, malformed
  usage, or budget exhaustion produces a classified row and a nonzero evaluator
  exit after JSON is safely written when possible.
- The evaluator stops new requests after the shared cap, records unfinished
  rows as `budget_exhausted`, and does not retry.
- The test suite uses fake Provider clients; it never contacts a live API.
- The live script is opt-in and is never part of `npm test`, package
  verification, or normal `mini-pi` startup.

## Test and verification plan

1. Fake-client unit tests verify success usage extraction, malformed/negative
   usage omission, failure telemetry with no unsafe fields, duration
   non-negativity, one event per request, and telemetry callback isolation.
2. A budget-wrapper test feeds more than 20 planned generate attempts and
   asserts exactly 20 underlying calls.
3. A script schema test uses a fake LLM/temporary project to assert output has
   no forbidden keys or secret-like values and stores only allowed paths and
   booleans.
4. Before the live run, run `npm test`, `npm run check`, and the evaluator's
   JSON verifier.
5. Run the live script exactly once under the 20-request cap, save raw JSON
   only in a temporary ignored path, derive the committed report, and run the
   verifier against the captured JSON. Do not rerun merely to improve results.

## Acceptance criteria

- Normal CLI and all existing fake tests retain their behavior when telemetry
  is absent.
- Telemetry is optional, safe, and reports only allowlisted numeric usage and
  timing/provider/model/outcome metadata.
- Tests demonstrate no telemetry exception can affect a model request.
- The live evaluator cannot start more than 20 Provider requests and never
  retries automatically.
- The committed report declares actual observed usage/latency, omissions,
  failures, and the non-streaming TTFT limitation without claiming generalized
  quality or cost.

