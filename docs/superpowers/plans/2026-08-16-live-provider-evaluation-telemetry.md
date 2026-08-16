# Live Provider Repo Map Evaluation Telemetry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add safe opt-in LLM usage/latency telemetry and run one capped, real DeepSeek Repo Map evaluation without changing normal mini-Pi behavior.

**Architecture:** `llm.ts` emits one sanitized event after each attempted chat completion when an optional callback is supplied. A dedicated evaluator wraps that LLM with a shared pre-request cap, runs five fixed questions through the real Agent/navigation/tools path, and emits only aggregate-safe JSON. A verifier and report consume that JSON.

**Tech Stack:** Node.js 22, TypeScript 5.9, OpenAI-compatible DeepSeek Chat Completions, existing Agent/Repo Map/read-only tools, `node:test`.

---

### Task 1: Add isolated LLM telemetry

**Files:**
- Modify: `src/llm.ts`, `test/llm.test.ts`

- [ ] **Step 1: Write failing fake-client tests**

```ts
const events: LLMTelemetryEvent[] = [];
const client = fakeClient({ choices: [{ message: { content: "ok" } }], usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 } });
await createLLM({ provider: "deepseek", model: "deepseek-v4-flash", apiKey: "secret" }, client, (event) => events.push(event)).generate([], []);
assert.deepEqual(events[0], {
  provider: "deepseek", model: "deepseek-v4-flash", outcome: "success",
  durationMs: events[0]!.durationMs,
  usage: { promptTokens: 12, completionTokens: 3, totalTokens: 15 }
});
assert(events[0]!.durationMs >= 0);
```

Add failure, malformed/negative usage, and throwing-callback cases. Assert every
event JSON omits `apiKey`, raw response, request ID, message, headers, and
secret-like fixture strings.

- [ ] **Step 2: Confirm RED**

Run: `npx tsx --test --test-name-pattern="LLM telemetry" test/llm.test.ts`

Expected: missing telemetry contracts or missing third `createLLM` argument.

- [ ] **Step 3: Implement the minimal contract**

```ts
export interface ProviderUsage {
  promptTokens?: number; completionTokens?: number; totalTokens?: number;
}
export interface LLMTelemetryEvent {
  provider: ProviderName; model: string; outcome: "success" | "failure";
  durationMs: number; usage?: ProviderUsage;
}
export type LLMTelemetry = (event: LLMTelemetryEvent) => void;
export function createLLM(config: LLMConfig, client?: ProviderClient, telemetry?: LLMTelemetry): LLMClient;
```

Measure around only `client.chat.completions.create`. Parse only finite
non-negative integer raw `usage` fields. Emit exactly once in a `finally`
path, wrap telemetry invocation in `try/catch`, and preserve existing safe
diagnostic conversion.

- [ ] **Step 4: Verify and commit**

```bash
npx tsx --test --test-name-pattern="LLM telemetry|generate" test/llm.test.ts
npm run check
git add src/llm.ts test/llm.test.ts
git commit -m "feat: add opt-in LLM telemetry"
```

### Task 2: Add a capped, safe live-evaluation runner

**Files:**
- Create: `scripts/benchmark-deepseek-harness-live.mjs`, `scripts/verify-deepseek-harness-live.mjs`
- Modify: `package.json`
- Test: `test/llm.test.ts`

- [ ] **Step 1: Write failing cap/schema tests**

Use a fake `LLMClient` wrapper that attempts 21 requests:

```ts
const { llm, requestsStarted } = withRequestBudget(fakeLlm, 20);
await Promise.allSettled(Array.from({ length: 21 }, () => llm.generate([], [])));
assert.equal(requestsStarted(), 20);
```

Assert runner rows allow only outcome, numeric timing/usage, tool counts,
project-relative `readPaths`, booleans, candidate rank, and
`telemetryComplete`; assert serialized rows reject `prompt`, `answer`,
`content`, `apiKey`, `requestId`, and source text.

- [ ] **Step 2: Confirm RED**

Run: `npx tsx --test --test-name-pattern="live evaluation budget|live evaluation schema" test/llm.test.ts`

Expected: missing exported budget/schema helpers.

- [ ] **Step 3: Implement evaluator helpers and script**

Export testable `withRequestBudget` and `sanitizeLiveEvaluationRow` from
`src/llm.ts` or a narrowly scoped new helper only if required by the existing
five-file architecture. The wrapper increments before `generate` and throws
`LiveEvaluationBudgetExceeded` before request 21.

The script must:
1. require `DEEPSEEK_API_KEY` from environment (never Keychain and never CLI args);
2. verify `/Users/jay/deepseek-harness` is at the fixed commit;
3. run the five inherited questions sequentially with `maxTurns: 6`;
4. construct Issue #18 navigation and wrap only SAFE tools;
5. emit exactly one JSON document to stdout; write no trace file;
6. exit nonzero after classified budget/provider/agent failures without retries.

Add package scripts:
```json
"benchmark:deepseek-harness:live": "npm run build && node scripts/benchmark-deepseek-harness-live.mjs",
"verify:deepseek-harness:live": "npm run build && node scripts/verify-deepseek-harness-live.mjs"
```

- [ ] **Step 4: Verify fake path and commit**

```bash
npx tsx --test --test-name-pattern="live evaluation budget|live evaluation schema" test/llm.test.ts
npm test
npm run check
git add src/llm.ts test/llm.test.ts scripts/benchmark-deepseek-harness-live.mjs scripts/verify-deepseek-harness-live.mjs package.json
git commit -m "feat: add capped live repo map evaluator"
```

### Task 3: Run the single authorized live experiment and report it

**Files:**
- Create: `docs/experiments/20-live-provider-repo-map-evaluation.md`
- Modify: `README.md`

- [ ] **Step 1: Verify no live request occurs in tests**

Run: `npm test && npm run check && npm run build`

Expected: all pass without `DEEPSEEK_API_KEY` being read by tests.

- [ ] **Step 2: Run exactly one capped live evaluation**

Run with an existing locally exported DeepSeek credential:

```bash
DEEPSEEK_API_KEY="$DEEPSEEK_API_KEY" npm run benchmark:deepseek-harness:live > /tmp/mini-pi-live-deepseek-issue-20.json
npm run verify:deepseek-harness:live -- /tmp/mini-pi-live-deepseek-issue-20.json
```

Expected: no more than 20 started Provider requests, five rows or explicit
budget-exhausted rows, and no retry. Do not rerun to improve a result.

- [ ] **Step 3: Write the report from that one JSON document**

Include environment/model/commit, request cap, aggregate prompt/completion/
total tokens, per-request and end-to-end latency summaries, tool/read evidence,
Top-1/Top-3, omitted usage, failures, variance, and non-streaming TTFT
limitation. Include only permitted booleans and paths; never copy prompts,
answers, source, tool outputs, keys, raw errors, request IDs, or raw JSON.

- [ ] **Step 4: Final verification and commit**

```bash
npm test
npm run check
npm run build
npm run verify:deepseek-harness:live -- /tmp/mini-pi-live-deepseek-issue-20.json
npm run verify:bin
npm run verify:package
git diff --check
git add README.md docs/experiments/20-live-provider-repo-map-evaluation.md
git commit -m "docs: report live repo map evaluation"
```

Expected: code validation passes; report derives from exactly one captured
experiment; no secret or source content is tracked.

