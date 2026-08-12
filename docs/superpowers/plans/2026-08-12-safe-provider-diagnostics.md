# Safe Provider Diagnostics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace generic model failures with safe Chinese diagnostics and optional `MINI_PI_DEBUG=1` evidence, without logging secrets or project content.

**Architecture:** `llm.ts` creates a typed `ProviderDiagnostic` from status, an allowlisted generic error code, and known network signals. `agent.ts` transports it in a model error event, while `tui.ts` renders Chinese reason/advice and conditionally appends safe status/code fields. `cli.ts` enables that rendering only when `MINI_PI_DEBUG === "1"`.

**Tech Stack:** TypeScript, Node.js 22, OpenAI-compatible SDK, `node:test`.

---

### Task 1: Build safe error classification and presentation

**Files:**
- Modify: `src/llm.ts`
- Modify: `src/agent.ts`
- Modify: `src/tui.ts`
- Modify: `src/cli.ts`
- Modify: `test/llm.test.ts`
- Modify: `test/agent.test.ts`
- Modify: `test/cli.test.ts`

- [ ] **Step 1: Write failing tests for provider categories and non-leakage**

```ts
test("classifies a 401 without exposing secret response text", async () => {
  const error = Object.assign(new Error("Authorization: Bearer secret"), {
    status: 401, code: "invalid_api_key"
  });
  await assert.rejects(() => failingLLM(error).generate([], []), (failure: ProviderDiagnostic) => {
    assert.equal(failure.kind, "authentication");
    assert.equal(failure.level, "error");
    assert(!JSON.stringify(failure).includes("secret"));
    return true;
  });
});

test("renders model diagnostics in Chinese and only adds safe debug fields", () => {
  const event = diagnosticEvent({ status: 429, code: "rate_limit_exceeded" });
  assert.match(formatEvent(event), /限流/);
  assert(!formatEvent(event).includes("req_2"));
  assert.match(formatEvent(event, true), /HTTP 429.*code=rate_limit_exceeded/);
});
```

- [ ] **Step 2: Run focused tests and verify RED**

Run: `npm test -- test/llm.test.ts test/agent.test.ts test/cli.test.ts`  
Expected: FAIL because `ProviderDiagnostic` and diagnostic event fields do not exist.

- [ ] **Step 3: Implement the minimal diagnostic flow**

In `llm.ts`, export a `ProviderDiagnostic` error subtype carrying only `level`, `kind`, `provider`, Chinese `message`/`advice`, and optional `status` plus an allowlisted generic `code`. Map 401, 403, 404, 429, 5xx, and network-like codes/messages. Never include original exception text or request IDs.

In `agent.ts`, preserve a caught `ProviderDiagnostic` as a model-stage error event; keep existing generic error behavior for non-diagnostic model errors and all tool/turn failures.

In `tui.ts`, format the event as Chinese label/location/reason/advice. Accept a `debug = false` flag and append only `HTTP <status>` plus an allowlisted `code=<code>` when true. In `cli.ts`, pass `env.MINI_PI_DEBUG === "1"` to the event formatter.

- [ ] **Step 4: Add full category and transport regressions**

Add tests for 401, 403, 404, 429, 503, network, and unknown mappings; default and debug formatting; strict `"1"` toggle; Agent event transport; and strings containing a fake Key, `Authorization`, request body, response body, tool text, and stack-like text not appearing in output.

- [ ] **Step 5: Run full verification for GREEN**

Run: `npm test && npm run check && npm run build && npm run verify:bin && npm run verify:package && git diff --check`  
Expected: all commands PASS and the five `src/*.ts` files remain at or below 1000 total lines.

- [ ] **Step 6: Commit implementation and tests**

```bash
git add src/llm.ts src/agent.ts src/tui.ts src/cli.ts test/llm.test.ts test/agent.test.ts test/cli.test.ts
git commit -m "feat: explain provider failures safely"
```

### Task 2: Document and package the safe debug workflow

**Files:**
- Modify: `README.md`
- Modify: `DEFERRED_FEATURES.md`
- Test: `test/cli.test.ts`

- [ ] **Step 1: Write a failing documentation-adjacent behavior test**

```ts
test("only MINI_PI_DEBUG exactly 1 enables debug rendering", () => {
  assert.equal(debugEnabled({ MINI_PI_DEBUG: "1" }), true);
  assert.equal(debugEnabled({ MINI_PI_DEBUG: "true" }), false);
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npm test -- test/cli.test.ts`  
Expected: FAIL until the exported toggle helper exists.

- [ ] **Step 3: Document normal and debug diagnoses**

Update README with example Chinese diagnosis, `MINI_PI_DEBUG=1 npm run dev -- <project>` usage, the allowed debug fields, and an explicit no-secrets/no-content boundary. Keep automatic retries, persistent logs and `/debug` deferred.

- [ ] **Step 4: Run complete verification**

Run: `npm test && npm run check && npm run build && npm run verify:bin && npm run verify:package && git diff --check`  
Expected: all commands PASS.

- [ ] **Step 5: Commit docs and final tests**

```bash
git add README.md DEFERRED_FEATURES.md test/cli.test.ts src/cli.ts
git commit -m "docs: explain safe provider diagnostics"
```
