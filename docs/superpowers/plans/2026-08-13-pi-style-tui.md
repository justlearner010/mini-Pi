# Pi-style Layered TUI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render completed mini-Pi turns as calm, low-contrast conversation layers with a collapsed, toggleable Activity summary.

**Architecture:** A `TuiView` in `tui.ts` collects the existing Agent events and owns purely presentational session state. `cli.ts` passes its event sink into every Agent instead of directly printing events. The view renders user, assistant, Activity, working, approval, and error layers; it does not alter Agent, provider, or tool semantics.

**Tech Stack:** TypeScript, Node.js test runner, readline, existing markdansi Markdown renderer.

---

### Task 1: Create a testable TUI view model and layer renderers

**Files:**
- Modify: `src/tui.ts:1-130`
- Modify: `test/cli.test.ts:1-180`

- [ ] **Step 1: Write failing view tests**

Import `TuiView` and create it with an injected clock and writer. Feed these existing events in order:

```ts
{ type: "agent_start", prompt: "inspect src" }
{ type: "model_start", turn: 1 }
{ type: "model_end", turn: 1, toolCallCount: 2 }
{ type: "tool_start", turn: 1, toolCallId: "a", toolName: "scan_project" }
{ type: "tool_end", turn: 1, toolCallId: "a", toolName: "scan_project", isError: false, message: "completed" }
{ type: "agent_end", answer: "# Result", turns: 1 }
```

Assert the output has `YOU`, `MINI-PI`, a collapsed `▸ activity · 1 tools`, and no `Thinking`, `Working`, or raw `→ scan_project`. Assert the assistant content uses the injected Markdown renderer. Add a malicious prompt/tool-name/summary test and assert output contains no CSI, OSC, C0/C1, or default-ignorable Unicode.

- [ ] **Step 2: Run tests RED**

Run: `npm test -- --test-name-pattern="layered view"`

Expected: import failure because `TuiView` does not exist.

- [ ] **Step 3: Implement the smallest view model**

Export these TUI-only types/classes:

```ts
export type ActivityItem = { text: string; isError: boolean };
export type Activity = { turnCount: number; toolCount: number; durationMs: number; items: ActivityItem[]; expanded: boolean };
export class TuiView { record(event: AgentEvent): void; renderTurn(prompt: string, answer: string, provider: ProviderName, model: string): void; }
```

Use existing terminal sanitization, extended to default-ignorable characters for plain layer text. Use dim ANSI SGR styling generated only by trusted literal templates. Activity records only `→ toolName`, `✓ toolName`, or bounded existing error summary; never ToolResult content. `renderTurn` writes muted blue `YOU`, muted purple `MINI-PI · provider · N turns`, the Markdown answer, then a gray collapsed Activity line.

- [ ] **Step 4: Run tests GREEN and commit**

Run: `npm test -- --test-name-pattern="layered view" && npm run check`

Expected: PASS.

Commit: `git add src/tui.ts test/cli.test.ts && git commit -m "feat(tui): render layered conversation turns"`

### Task 2: Add Activity toggling and failure layers

**Files:**
- Modify: `src/tui.ts: TuiView`
- Modify: `test/cli.test.ts`

- [ ] **Step 1: Write failing interaction tests**

After rendering the event sequence from Task 1, call `view.toggleLatestActivity()` twice. Assert first call writes `▾ activity` followed by ordered `→ scan_project` and `✓ scan_project`; second writes a collapsed `▸ activity` only. Assert it returns false/writes nothing when no Activity exists. Add an error event after a tool event and assert a muted error layer includes the safe diagnostic text but does not remove the toggleable Activity.

- [ ] **Step 2: Run tests RED**

Run: `npm test -- --test-name-pattern="activity toggle|error layer"`

Expected: missing method or failing expanded-state assertions.

- [ ] **Step 3: Implement Activity and errors**

Add `toggleLatestActivity(): boolean` and `clearActivity(): void`. Each toggle appends a new representation at transcript end; do not use cursor positioning. On `model_start`, write only `· working · turn N` once per turn. On error, append a muted red error layer using existing safe `formatEvent` diagnostic text. `/reset` will call `clearActivity`.

- [ ] **Step 4: Run tests GREEN and commit**

Run: `npm test -- --test-name-pattern="activity toggle|error layer" && npm run check`

Expected: PASS.

Commit: `git add src/tui.ts test/cli.test.ts && git commit -m "feat(tui): collapse activity details"`

### Task 3: Wire TUI events and input behavior through CLI

**Files:**
- Modify: `src/cli.ts:190-250`
- Modify: `src/tui.ts: startTui`
- Modify: `test/cli.test.ts`

- [ ] **Step 1: Write failing integration tests**

Use a fake Agent that exposes a captured event callback. Feed events while `run()` is pending, then resolve an answer. With inputs `["question", "", "", "/reset", "", "/exit"]`, assert: user/assistant/activity layers are printed once; first empty input expands, second collapses; reset clears activity; final empty input has no output and does not call Agent. Include a replacement session test proving `/model`/`/login` receives the same view event sink.

- [ ] **Step 2: Run tests RED**

Run: `npm test -- --test-name-pattern="layered TUI integration"`

Expected: current TUI treats empty input as an informational message and CLI prints lifecycle events directly.

- [ ] **Step 3: Compose the view**

Create one `TuiView` per interactive CLI session. Replace CLI's `console.log(formatEvent(...))` callback with `view.record`. Pass the same callback to Agents reconstructed by `/login` or `/model`. Extend `startTui` options with the view: an empty input calls `view.toggleLatestActivity()` and otherwise writes nothing; prompt runs call `view.renderTurn`; `/reset` calls both `agent.reset()` and `view.clearActivity()`. Preserve existing EOF/SIGINT and readline close rules.

- [ ] **Step 4: Run tests GREEN and commit**

Run: `npm test -- --test-name-pattern="layered TUI integration" && npm test && npm run check`

Expected: PASS with prior TUI command/approval/Markdown tests still green.

Commit: `git add src/cli.ts src/tui.ts test/cli.test.ts && git commit -m "feat(cli): route agent events through TUI view"`

### Task 4: Update documentation and prepare PR

**Files:**
- Modify: `README.md`
- Modify: `DEFERRED_FEATURES.md`

- [ ] **Step 1: Update user-facing documentation**

Document the layered low-contrast interface, Activity default collapse and empty-Enter toggle, and clarify that answers remain non-streaming. Remove the delivered basic terminal-component item from deferred work; retain true in-place re-rendering, token streaming, persistent activities, and advanced navigation as deferred.

- [ ] **Step 2: Verify, commit, and open PR**

Run: `npm test && npm run check && npm run build && npm run verify:bin && npm run verify:package && git diff --check`

Expected: every command exits 0.

Commit documentation; push `codex/pi-style-tui`; create a PR to `main` with `Closes #6`, the test count, and all commands. Do not merge; await repository owner review.
