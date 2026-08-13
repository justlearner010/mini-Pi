# TUI Markdown Rendering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render final mini-Pi Markdown answers as safe, readable terminal output and fall back to safe plain text on renderer failure.

**Architecture:** `tui.ts` owns a small control-character sanitizer and an injectable Markdown renderer backed by `markdansi`; it renders only `AgentResult.answer` after a successful run. Progress, diagnostics, tools, commands and prompts remain direct text. The renderer is invoked only after cleaning untrusted model text; a thrown renderer emits a fixed warning plus the cleaned original answer.

**Tech Stack:** TypeScript, Node.js 22, `markdansi`, `node:test`.

---

### Task 1: Add safe Markdown terminal rendering

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `src/tui.ts`
- Modify: `test/cli.test.ts`

- [ ] **Step 1: Write failing renderer and TUI-path tests**

```ts
test("renders Markdown answers while retaining visible text", () => {
  const rendered = renderMarkdown("# Heading\n\n**bold** and `code`\n\n- item");
  assert.match(rendered, /Heading|bold|code|item/);
  assert(!rendered.includes("**bold**"));
});

test("removes untrusted terminal controls and falls back safely", async () => {
  const answer = "\x1b]0;title\x07# Safe\x1b[2J";
  assert(!renderMarkdown(answer).includes("\x1b]"));
  const output = await runTuiAnswer(answer, () => { throw new Error("renderer internals"); });
  assert.match(output, /Markdown rendering failed/);
  assert(output.includes("# Safe"));
});
```

- [ ] **Step 2: Run focused tests and verify RED**

Run: `npm test -- test/cli.test.ts`  
Expected: FAIL because `renderMarkdown` and renderer injection do not exist.

- [ ] **Step 3: Install the exact renderer dependency and implement compact rendering**

Add exact `markdansi` dependency. In `tui.ts`, export a sanitizer that strips ESC-based CSI/OSC sequences and remaining C0/C1 control characters except newline/tab. Export `renderMarkdown(text, renderer?)`, where production renderer uses markdansi. Make `TuiRuntime` accept an optional renderer for tests. After successful `agent.run`, output rendered text; if it throws, write the fixed fallback warning and sanitized answer. Do not send non-answer TUI text through the renderer.

- [ ] **Step 4: Add safety and formatting coverage**

Cover headings, bold/italic, list, inline code, fenced code, link, table, ordinary text; CSI/OSC/C0/C1 stripping; fallback warning and no original renderer error leakage; TUI final-answer wiring; and a tool/error text regression remaining unrendered.

- [ ] **Step 5: Run full verification**

Run: `npm test && npm run check && npm run build && npm run verify:bin && npm run verify:package && git diff --check`  
Expected: all PASS.

- [ ] **Step 6: Commit implementation**

```bash
git add package.json package-lock.json src/tui.ts test/cli.test.ts
git commit -m "feat(tui): render Markdown answers safely"
```

### Task 2: Document and close Issue #2

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Document final-answer rendering and non-goals**

Add a concise README note: final answers support terminal Markdown rendering; activity/tool/error messages remain text; model control sequences are removed; fallback preserves clean Markdown; true activity collapse, streaming and rich media remain future work.

- [ ] **Step 2: Verify and commit documentation**

Run: `npm test && npm run check && git diff --check`  
Expected: PASS.

```bash
git add README.md
git commit -m "docs: explain terminal Markdown rendering"
```

- [ ] **Step 3: Close Issue #2 after merge verification**

Run after the implementation branch is merged and validated: `gh issue close 2 --repo justlearner010/mini-Pi --comment "Implemented safe final-answer Markdown rendering with control-sequence stripping, fallback, and automated coverage."`
