# Tool Permissions 2A Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enforce tool authority in the Agent runtime and await human approval before sensitive or destructive execution.

**Architecture:** `Tool` declares permission and risk metadata. `Agent` parses a proposal, awaits approval before non-SAFE execution, and feeds denial back as a tool result. TUI owns input; CLI composes it into every Agent.

**Tech Stack:** TypeScript, Node.js test runner, readline.

---

### Task 1: Declare permission contracts

**Files:**
- Modify: `src/tool.ts:7-21`
- Modify: `src/agent.ts:1-38`
- Test: `test/agent.test.ts:10-14`

- [ ] **Step 1: Write the failing test**

Update the test Tool factory to accept a `ToolPermission`, defaulted to `SAFE`, and return `permission`, `reason`, and `risk`. Add a sensitive `review` tool whose approval callback asserts:

```ts
{ toolName: "review", permission: "SENSITIVE", reason: "review reason", risk: "review risk", arguments: { file: "a.ts" } }
```

- [ ] **Step 2: Run it RED**

Run: `npm test -- --test-name-pattern="approval"`

Expected: type/import failure because `ToolPermission` and `requestApproval` do not exist.

- [ ] **Step 3: Implement types**

In `src/tool.ts`, export `ToolPermission = "SAFE" | "SENSITIVE" | "DESTRUCTIVE"`, `ApprovalRequest`, `ApprovalDecision`, and `RequestApproval`. Add `permission`, `reason`, and `risk` to `Tool`. Add optional `requestApproval?: RequestApproval` to `AgentConfig`. Mark each current read-only tool SAFE with nonempty low-risk metadata.

- [ ] **Step 4: Run it GREEN and commit**

Run: `npm run check`

Expected: PASS; the runtime-behavior test stays red.

Commit: `git add src/tool.ts src/agent.ts test/agent.test.ts && git commit -m "feat: declare tool permission contracts"`

### Task 2: Gate execution inside Agent

**Files:**
- Modify: `src/agent.ts:76-95`
- Test: `test/agent.test.ts`

- [ ] **Step 1: Write failing runtime tests**

Use one tool-call response followed by final `"done"`. Test all four cases:

```ts
SAFE: execute count is 1; approval count is 0.
SENSITIVE approved: execute count is 1; exact request observed.
SENSITIVE denied: execute count is 0; next model request contains "Tool error: User declined review: user declined".
Missing/throwing callback: execute count is 0; result contains "approval unavailable" / "approval failed".
```

For denial assert no `tool_start`, one `tool_end` with `isError: true`, and no stack trace.

- [ ] **Step 2: Run tests RED**

Run: `npm test -- --test-name-pattern="SAFE|approval|denied"`

Expected: denial cases fail because Agent currently executes all known tools.

- [ ] **Step 3: Implement the fail-closed policy**

After tool lookup and JSON parse, only non-SAFE tools await `this.requestApproval`. Missing callback, a callback throw, or a false decision must skip `execute`, append `Tool error: User declined <name>: <reason>`, and emit `tool_end` only. Emit `tool_start` immediately before an actual execute call.

- [ ] **Step 4: Run tests GREEN and commit**

Run: `npm test -- --test-name-pattern="SAFE|approval|denied" && npm test -- test/agent.test.ts`

Expected: PASS.

Commit: `git add src/agent.ts test/agent.test.ts && git commit -m "feat: gate tool execution on runtime approval"`

### Task 3: Add terminal approval and CLI wiring

**Files:**
- Modify: `src/tui.ts:9-15,97-130`
- Modify: `src/cli.ts:1-12,190-245`
- Test: `test/cli.test.ts`

- [ ] **Step 1: Write failing TUI tests**

Export `requestTerminalApproval(request, runtime)`. Inject a line and test:

```ts
SENSITIVE: y is approved; yes and empty are denied.
DESTRUCTIVE: yes is approved; y is denied.
EOF and SIGINT: denied, line is closed.
```

Assert prompt output includes tool name, reason, risk, JSON arguments, and `HIGH RISK` for DESTRUCTIVE.

- [ ] **Step 2: Run tests RED**

Run: `npm test -- --test-name-pattern="terminal approval"`

Expected: missing helper import.

- [ ] **Step 3: Implement terminal approval**

Create/close one injected TUI line in `finally`. Let `required` be `yes` for DESTRUCTIVE and `y` otherwise. Only exact input is approved. Question errors return `{ approved: false, reason: "user declined" }`. Stringify arguments with a `[unavailable]` fallback.

- [ ] **Step 4: Wire CLI and run tests GREEN**

Pass this callback at normal Agent construction and when `/login` or `/model` rebuilds an Agent.

Run: `npm test -- --test-name-pattern="terminal approval" && npm test && npm run check`

Expected: PASS.

- [ ] **Step 5: Commit**

Commit: `git add src/cli.ts src/tui.ts test/cli.test.ts && git commit -m "feat: prompt for sensitive tool approval"`

### Task 4: Document and prepare review

**Files:**
- Modify: `README.md`
- Modify: `DEFERRED_FEATURES.md`

- [ ] **Step 1: Document the boundary**

Document SAFE automatic execution, exact `y` for SENSITIVE, exact `yes` for DESTRUCTIVE, and denial as an Agent observation. Keep run_tests, write/delete tools, and approval persistence deferred.

- [ ] **Step 2: Full verification, commit, and PR**

Run: `npm test && npm run check && npm run build && npm run verify:bin && npm run verify:package && git diff --check`

Expected: every command exits 0.

Commit docs, push `codex/tool-permissions-2a`, open a PR to `main` that says `Closes #3`, lists validation results, and remains unmerged for owner review.
