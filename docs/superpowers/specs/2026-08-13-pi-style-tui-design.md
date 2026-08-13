# Pi-style Layered TUI Design

## Goal

Replace mini-Pi's streaming-style terminal prints with calm, low-contrast,
Pi-inspired conversation blocks. A completed turn must make user input, final
answer, runtime activity, approval, and errors visually distinct without
revealing reasoning content or full tool outputs.

## Scope

- Render a completed user prompt as a blue, low-contrast `YOU` block.
- Render a completed assistant answer as a purple `MINI-PI` block, preserving
  the existing safe Markdown renderer.
- Collect model/tool lifecycle events for a turn into a collapsed gray Activity
  summary rather than printing each event live.
- During a run, display only `· working · turn N`.
- When the input is empty, Enter toggles the most recent completed Activity;
  empty Enter with no Activity is a no-op. Text plus Enter still sends a prompt.
- Display low-contrast amber approval and red diagnostic/error blocks.
- Preserve current commands, cancellation behaviour, root-dir boundaries, and
  safe Markdown/terminal-control handling.

## Non-goals

- Do not display model chain-of-thought or `reasoning_content`.
- Do not display full ToolResult content in Activity.
- Do not add streaming tokens, persistent chat history, multiple Activity
  selection, scrolling, mouse support, or arbitrary terminal hyperlinks.
- Do not change Agent loop semantics, Provider APIs, or tool permissions.

## Render layers

| Layer | Appearance | Content |
| --- | --- | --- |
| User | muted blue left line and `YOU` label | the submitted prompt, terminal-sanitized |
| Assistant | muted purple left line and `MINI-PI · provider · N turns` label | safe rendered Markdown final answer |
| Activity | quiet gray `▸ activity · N tools · duration` line | collapsed by default; event summaries when expanded |
| Working | one quiet `· working · turn N` line | replaces live event spam while a run is active |
| Approval | muted amber left line | existing safe approval request and exact confirmation instruction |
| Error | muted red left line | existing safe diagnostic's level, reason, and advice |
| Input | subdued top separator and `›` prompt | command or user text |

No layer uses a filled bright card. Color is limited to a thin left line and
label; ordinary text remains low-saturation gray-white for extended terminal
use.

## Activity model

`tui.ts` owns a small in-memory view model, not the Agent. It receives existing
`AgentEvent`s through the CLI callback, records only safe summaries, and creates
one `Activity` after each Agent run:

```ts
type ActivityItem = { text: string; isError: boolean };
type Activity = { turnCount: number; toolCount: number; durationMs: number; items: ActivityItem[]; expanded: boolean };
```

`tool_start` records `→ toolName`; `tool_end` records `✓ toolName` or the
already-bounded tool error summary. `model_start` updates the visible working
turn; `agent_end` finalizes duration and count. Provider/agent errors preserve
any collected Activity and render an Error block after it.

Only the latest Activity is toggleable. Toggling redraws that summary and its
items at the end of the current transcript; it does not attempt cursor-addressed
in-place terminal repainting. This keeps the first version portable and avoids
interfering with readline/inquirer ownership. A future enhancement can replace
the renderer with a real retained component tree.

## Data flow

```text
AgentEvent -> CLI onEvent -> TuiView.record(event)
                              -> working-line update during run
AgentResult -> TuiView.renderTurn(prompt, answer, provider, model)
                              -> user block + assistant block + activity
empty Enter -> TuiView.toggleLatestActivity() -> append collapsed/expanded view
```

CLI must no longer `console.log(formatEvent(event))`; it passes a TUI event sink
to every Agent constructed for the session, including replacement Agents after
`/login` or `/model`.

## Safety

- User prompts, model answers, tool names, tool event summaries, provider
  diagnostics, and approval details remain untrusted terminal text.
- Reuse/extend existing sanitization before terminal writes; allow only renderer
  SGR styling for Markdown. No model-supplied OSC/CSI/C0/C1/default-ignorable
  controls may reach the terminal.
- Activity never includes full tool output; it uses the Agent's 200-character
  event summary at most.
- The TUI view model stays session-memory only and is cleared by `/reset`.

## Error and approval behaviour

Approval remains interactive and exact: SENSITIVE needs `y`, DESTRUCTIVE needs
`yes`. It is rendered through the amber layer, then its decision is still made
by the Agent runtime. A provider/agent failure renders the existing safe Chinese
diagnostic in a red layer; it does not turn into Markdown and does not erase the
latest Activity.

## Test matrix

- A normal run outputs one user block, one assistant block, and one collapsed
  Activity summary; no raw `Working`, `Thinking`, or per-event console spam.
- Tool events appear only after an empty-Enter toggle and retain order; full tool
  content is absent.
- Empty Enter with no Activity writes nothing; text input still calls Agent.
- A second empty Enter collapses the latest expanded Activity.
- `/reset` clears the latest Activity; `/login` and `/model` keep the event sink
  for replacement Agent runs.
- Error after tool activity shows red safe error text and permits Activity toggle.
- Layer renderers strip terminal controls/default-ignorable Unicode from all
  untrusted fields; Markdown fallback remains safe.
- Existing EOF, SIGINT, approval, and command tests remain green.

## Deferred follow-up

True in-place terminal re-rendering, keyboard navigation across older activities,
streaming tokens, and a retained component tree are intentionally deferred.
