# Tool Permissions 2A Design

## Goal

Add a runtime-owned permission boundary to mini-Pi. The model may propose a tool
call, but the runtime decides whether it runs. The terminal UI only collects a
human decision, so a future web UI or MCP client can use the same policy.

This is the first half of Phase 2. It does not add process execution, writing,
or destructive tools. `run_tests` is deferred to 2B.

## Scope

- Add `SAFE`, `SENSITIVE`, and `DESTRUCTIVE` permissions to every `Tool`.
- Add human-readable `reason` and `risk` metadata to every `Tool`.
- Add an optional asynchronous approval callback to `AgentConfig`.
- Have the runtime await approval before executing `SENSITIVE` or
  `DESTRUCTIVE` tools.
- Keep a denied action as a tool result so the next model turn can adapt.
- Add TUI prompting and deterministic tests.

## Non-goals

- No new shell, write, delete, network, or test-running tool.
- No persistence of approvals or approval decisions.
- No change to provider APIs or existing SAFE-tool interaction.

## Types

```ts
type ToolPermission = "SAFE" | "SENSITIVE" | "DESTRUCTIVE";

type ApprovalRequest = {
  toolName: string;
  permission: "SENSITIVE" | "DESTRUCTIVE";
  reason: string;
  risk: string;
  arguments: unknown;
};

type ApprovalDecision = { approved: boolean; reason: string };
type RequestApproval = (request: ApprovalRequest) => Promise<ApprovalDecision>;
```

`Tool` gains `permission`, `reason`, and `risk`. The three current read-only
tools are all `SAFE`; their existing behaviour remains automatic.

## Runtime flow

```text
LLM proposes a tool call
  -> Agent finds and parses the Tool
  -> SAFE: execute
  -> SENSITIVE/DESTRUCTIVE: await requestApproval
  -> approved: execute
  -> denied/unavailable/approval-error: do not execute; append a ToolResult
  -> model receives the observation and continues its loop
```

The runtime, rather than the tool or TUI, enforces this rule. A missing or
throwing approval callback fails closed: it denies the action.

## Terminal approval

For a `SENSITIVE` request, TUI prints the tool, reason, risk and JSON arguments,
then accepts only an exact `y` as approval. For a `DESTRUCTIVE` request, it
prints an explicit high-risk warning and accepts only an exact `yes`.

Empty input, any other input, EOF, Ctrl+C, a prompt error, or callback failure
denies execution. The resulting ToolResult tells the model that the user
declined, without exposing an implementation stack trace.

## Events and composition

`tool_start` is emitted only when the tool is about to run. A denied call emits
the normal `tool_end` with `isError: true` and a short denial summary. The CLI
creates the TUI-backed `RequestApproval` and supplies it when it creates an
Agent. Non-TUI callers can supply their own callback or receive a safe denial.

## Test matrix

- SAFE tools execute without asking for approval.
- SENSITIVE tools execute after `{ approved: true }` and do not execute after a
  denial; the model receives the denial ToolResult and can answer next turn.
- DESTRUCTIVE tools use the same runtime callback contract; TUI accepts exactly
  `yes`, not `y`.
- TUI rejects empty, invalid, EOF, Ctrl+C and prompt-error input.
- Missing or throwing callbacks deny safely and do not execute the tool.
- Existing scan/read/dependency tests remain automatic and green.

## 2B handoff

2B can add `run_tests` as `SENSITIVE` without changing this policy. Its command
is limited to project-root `npm test` or `pytest`, with a 60-second timeout and
20-KB head-and-tail output cap.
