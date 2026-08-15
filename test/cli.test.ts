import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  AUTO_REPO_MAP_MAX_CHARACTERS,
  completeInteractiveOptions,
  createRepositoryNavigation,
  createSystemCredentialStore,
  debugEnabled,
  loginWithCredentialStore,
  logoutFromCredentialStore,
  exitCodeFor,
  getStartupSelection,
  parseArgs,
  readGlobalPreference,
  resolveApiKey,
  runWithNavigation,
  runOneShot,
  selectAndSaveModel,
  saveGlobalPreference,
  SYSTEM_PROMPT,
  type CredentialStore,
  validateOptions
} from "../src/cli.js";
import { formatEvent, helpText, parseCommand, renderMarkdown, requestTerminalApproval, startTui, TuiView, type TuiRuntime } from "../src/tui.js";
import type { ApprovalRequest } from "../src/agent.js";

test("one-shot prompt uses the plain CLI transcript and prints its answer once", async () => {
  const output: string[] = [];
  const agent = { async run() { return { answer: "final answer", messages: [], turns: 1 }; } } as never;
  assert.equal(await runOneShot(agent, "question", (text) => output.push(`${text}\n`)), 0);
  const text = output.join("");
  assert(!text.includes("YOU:") && !text.includes("MINI-PI") && !text.includes("activity"));
  assert.equal((text.match(/final answer/g) ?? []).length, 1);
});

test("repository navigation builds a query Tool and supplies transient context", async () => {
  assert.equal(AUTO_REPO_MAP_MAX_CHARACTERS, 4_000);
  const rootDir = await mkdtemp(join(tmpdir(), "mini-pi-navigation-"));
  await mkdir(join(rootDir, "src"));
  await writeFile(join(rootDir, "src", "llm.ts"), "export interface ProviderConfig { model: string }");
  const navigation = await createRepositoryNavigation(rootDir);
  assert(navigation);
  assert(navigation.tools.some((tool) => tool.name === "query_repo_map"));
  assert(navigation.mapFor("provider configuration").text.length <= 4_000);
  const calls: Array<{ prompt: string; options?: { transientContext?: string } }> = [];
  const agent = { async run(prompt: string, options?: { transientContext?: string }) { calls.push({ prompt, options }); return { answer: "done", messages: [], turns: 1 }; } };
  await runWithNavigation(agent, "provider configuration", navigation);
  assert.equal(calls.length, 1);
  assert.match(calls[0].options?.transientContext ?? "", /src\/llm\.ts/);
  assert.match(calls[0].options?.transientContext ?? "", /source bodies not inspected/);
});

test("repository navigation degrades safely and TUI status never receives map text", async () => {
  assert.equal(await createRepositoryNavigation("/does-not-exist"), undefined);
  const calls: unknown[] = [];
  const agent = { async run(...args: unknown[]) { calls.push(args); return { answer: "done", messages: [], turns: 1 }; } };
  await runWithNavigation(agent, "question", undefined);
  assert.deepEqual(calls, [["question"]]);
  const output: string[] = [];
  const view = new TuiView({ write: (text) => output.push(text) });
  view.repositoryIndexStatus({ available: true, indexedFiles: 42, skippedFiles: 3, truncated: true });
  const text = output.join("");
  assert.match(text, /Repository index · 42 files · 3 skipped · truncated/);
  assert(!text.includes("REPO MAP") && !text.includes("signature"));
});

function approvalRequest(permission: ApprovalRequest["permission"], argumentsValue: unknown = { path: "secret.txt" }): ApprovalRequest {
  return { toolName: "guarded_tool", permission, reason: "Needs your permission", risk: "Changes project state", arguments: argumentsValue };
}

test("terminal approval requires exact confirmation words and displays request details", async () => {
  const outputs: string[] = [];
  const answers = ["y", "yes", "", "yes", "y"];
  let closed = 0;
  const runtime: TuiRuntime = {
    createLine: () => ({ question: async () => answers.shift()!, close: () => { closed += 1; } }),
    write: (text) => { outputs.push(text); }
  };

  assert.deepEqual(await requestTerminalApproval(approvalRequest("SENSITIVE"), runtime), { approved: true, reason: "user approved" });
  assert.deepEqual(await requestTerminalApproval(approvalRequest("SENSITIVE"), runtime), { approved: false, reason: "user declined" });
  assert.deepEqual(await requestTerminalApproval(approvalRequest("SENSITIVE"), runtime), { approved: false, reason: "user declined" });
  assert.deepEqual(await requestTerminalApproval(approvalRequest("DESTRUCTIVE"), runtime), { approved: true, reason: "user approved" });
  assert.deepEqual(await requestTerminalApproval(approvalRequest("DESTRUCTIVE"), runtime), { approved: false, reason: "user declined" });
  assert.equal(closed, 5);
  const text = outputs.join("");
  assert.match(text, /Tool: guarded_tool/);
  assert.match(text, /Reason: Needs your permission/);
  assert.match(text, /Risk: Changes project state/);
  assert.match(text, /"path": "secret.txt"/);
  assert.match(text, /HIGH RISK/);
});

test("terminal approval rejects input failures and unavailable arguments safely", async () => {
  const outputs: string[] = [];
  const failures = [{ code: "EOF" }, { code: "SIGINT" }, new Error("prompt failed")];
  let closed = 0;
  const runtime: TuiRuntime = {
    createLine: () => ({ question: async () => Promise.reject(failures.shift()), close: () => { closed += 1; } }),
    write: (text) => { outputs.push(text); }
  };
  const circular: { self?: unknown } = {}; circular.self = circular;
  for (let index = 0; index < 3; index += 1) assert.deepEqual(await requestTerminalApproval(approvalRequest("SENSITIVE", circular), runtime), { approved: false, reason: "user declined" });
  assert.equal(closed, 3);
  assert.match(outputs.join(""), /\[unavailable\]/);
});

test("terminal approval strips terminal controls and bidi characters from untrusted request text", async () => {
  const output: string[] = [];
  const runtime: TuiRuntime = {
    createLine: () => ({ question: async () => "no", close: () => undefined }),
    write: (text) => { output.push(text); }
  };
  await requestTerminalApproval({
    toolName: "guarded\u001b]0;spoof\u0007\u009b2J\u202ereversed",
    permission: "SENSITIVE",
    reason: "reason\u001b[2J\u200bhidden",
    risk: "risk\u009d8;;bad\u009c\u2066isolated",
    arguments: { path: "safe\u001b[31mtext\u001b[0m\u202e.txt" }
  }, runtime);
  const rendered = output.join("");
  assert(!/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f]/.test(rendered));
  assert.match(rendered, /Tool: guardedreversed/);
  assert.match(rendered, /"path": "safetext.txt"/);
});

test("terminal approval strips every default-ignorable Unicode character from untrusted details", async () => {
  const output: string[] = [];
  const invisible = "\u061c\u180e\u034f\ufe0f\udb40\udd00";
  const runtime: TuiRuntime = {
    createLine: () => ({ question: async () => "no", close: () => undefined }),
    write: (text) => { output.push(text); }
  };
  await requestTerminalApproval({
    toolName: `tool${invisible}name`, permission: "SENSITIVE", reason: `reason${invisible}text`, risk: `risk${invisible}text`, arguments: { path: `file${invisible}.txt` }
  }, runtime);
  const rendered = output.join("");
  assert(!/\p{Default_Ignorable_Code_Point}/u.test(rendered));
  assert.match(rendered, /Tool: toolname/);
  assert.match(rendered, /"path": "file.txt"/);
});

test("renders common Markdown answer text without leaving formatting markers", () => {
  const rendered = renderMarkdown("# Heading\n\n**bold** and *italic* and `code`\n\n- item\n\n```ts\nconst value = 1;\n```\n\n[link](https://example.com)\n\n| name | value |\n| --- | --- |\n| row | cell |");
  for (const text of ["Heading", "bold", "italic", "code", "item", "const value = 1;", "link", "row", "cell"]) assert.match(rendered, new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert(!rendered.includes("**bold**"));
  assert(!rendered.includes("*italic*"));
  assert(!rendered.includes("`code`"));
});

test("removes model terminal controls before rendering", () => {
  let received = "";
  const rendered = renderMarkdown("\u001b]0;bad-title\u0007# Safe\u001b[2J\u001b]8;;https://bad\u001b\\link\u001b]8;;\u001b\\\u009b31m\u0000ok\u0009tab\nnext", (text) => { received = text; return text; });
  assert.equal(received, "# Safelinkok\ttab\nnext");
  assert.equal(rendered, received);
  assert(!rendered.includes("\u001b") && !rendered.includes("\u009b") && !rendered.includes("\u0000"));
});

test("removes controls decoded from Markdown entities and disables terminal hyperlinks", () => {
  const markdown = "[safe](https://example.com/&#x0d;bad)&#x9b;31m";
  let received = "";
  const rendered = renderMarkdown(markdown, (text) => {
    received = text;
    return "\u001b[32msafe\u001b[0m\u001b]8;;https://bad\u0007safe\u001b]8;;\u0007\u001b[2J\u009b31m";
  });
  assert.equal(received, "[safe](https://example.com/bad)");
  assert.match(rendered, /\u001b\[32msafe\u001b\[0m/);
  assert(!rendered.includes("\u001b]8;") && !rendered.includes("\u001b[2J") && !rendered.includes("\u009b") && !rendered.includes("\r"));
});

test("does not turn model-controlled private-use characters into terminal styles", () => {
  assert.equal(renderMarkdown("\uE00031\uE001", (text) => text), "\uE00031\uE001");
});

test("TUI renders only final answers and falls back to safe plain text", async () => {
  const output: string[] = [];
  const inputs = ["question", "/exit"];
  const runtime: TuiRuntime = {
    createLine: () => ({ question: async () => inputs.shift() ?? Promise.reject({ code: "EOF" }), close: () => undefined }),
    write: (text) => { output.push(text); },
    renderMarkdown: () => { throw new Error("renderer internals: secret"); }
  };
  const agent = {
    reset() {},
    async run() { return { answer: "# Safe\u001b[2J\n\n**answer**", messages: [], turns: 1 }; }
  } as never;
  assert.equal(await startTui(agent, { project: "/project", provider: "openai", model: "gpt" }, undefined, runtime), 0);
  const text = output.join("");
  assert.match(text, /Markdown rendering failed; showing safe plain text\./);
  assert.match(text, /# Safe\n\n\*\*answer\*\*/);
  assert(!text.includes("renderer internals") && !text.includes("secret"));
  assert(!text.includes("\u001b[2J"));
});

test("TUI does not send agent errors through the Markdown renderer", async () => {
  const output: string[] = [];
  let renders = 0;
  const inputs = ["question", "/exit"];
  const runtime: TuiRuntime = {
    createLine: () => ({ question: async () => inputs.shift() ?? Promise.reject({ code: "EOF" }), close: () => undefined }),
    write: (text) => { output.push(text); },
    renderMarkdown: (text) => { renders += 1; return `rendered:${text}`; }
  };
  const agent = { reset() {}, async run() { throw new Error("tool error: **not markdown**"); } } as never;
  await startTui(agent, { project: "/project", provider: "openai", model: "gpt" }, undefined, runtime);
  assert.equal(renders, 0);
  assert(output.join("").includes("Error: tool error: **not markdown**"));
});

test("layered TUI integration toggles completed activity, resets it, and still submits text", async () => {
  const output: string[] = [];
  const inputs = ["question", "", "", "/reset", "", "/exit"];
  let runs = 0;
  const view = new TuiView({ write: (text) => output.push(text), provider: "openai", renderMarkdown: (text) => `md:${text}` });
  const agent = {
    reset() {},
    async run(prompt: string) {
      runs += 1;
      sink({ type: "agent_start", prompt });
      sink({ type: "model_start", turn: 1 });
      sink({ type: "tool_start", turn: 1, toolCallId: "a", toolName: "read_file" });
      sink({ type: "tool_end", turn: 1, toolCallId: "a", toolName: "read_file", isError: false, message: "completed" });
      sink({ type: "agent_end", answer: "answer", turns: 1 });
      return { answer: "answer", messages: [], turns: 1 };
    }
  } as never;
  let sink: (event: import("../src/agent.js").AgentEvent) => void = () => undefined;
  sink = view.onEvent.bind(view);
  const runtime: TuiRuntime = {
    createLine: () => ({ question: async () => inputs.shift() ?? Promise.reject({ code: "EOF" }), close: () => undefined }),
    write: (text) => output.push(text)
  };
  await startTui(agent, { project: "/project", provider: "openai", model: "gpt" }, undefined, runtime, view);
  assert.equal(runs, 1);
  const text = output.join("");
  assert.match(text, /YOU: question/);
  assert.match(text, /MINI-PI · openai · 1 turns\nmd:answer/);
  assert.match(text, /▸ activity · 1 tools/);
  assert.match(text, /▾ activity · 1 tools[\s\S]*→ read_file[\s\S]*✓ read_file/);
  assert.equal((text.match(/Enter a question/g) ?? []).length, 0);
});

test("layered TUI uses the replacement session provider and model for actual runs", async () => {
  const output: string[] = [];
  const inputs = ["/login", "after-login", "/model", "after-model", "/exit"];
  const view = new TuiView({ write: (text) => output.push(text), provider: "openai" });
  const agent = (answer: string) => ({ reset() {}, async run(prompt: string) {
    sink({ type: "agent_start", prompt });
    sink({ type: "model_start", turn: 1 });
    sink({ type: "agent_end", answer, turns: 1 });
    return { answer, messages: [], turns: 1 };
  } }) as never;
  const original = agent("original");
  const loggedIn = agent("login-answer");
  const modelChanged = agent("model-answer");
  let sink: (event: import("../src/agent.js").AgentEvent) => void = view.onEvent.bind(view);
  await startTui(original, { project: "/project", provider: "openai", model: "old" }, {
    login: async (session) => ({ ...session, agent: loggedIn, provider: "deepseek", model: "chat" }),
    model: async (session) => ({ ...session, agent: modelChanged, model: "reasoner" }),
    logout: async () => undefined
  }, {
    createLine: () => ({ question: async () => inputs.shift() ?? Promise.reject({ code: "EOF" }), close: () => undefined }),
    write: (text) => output.push(text)
  }, view);
  const text = output.join("");
  assert.match(text, /MINI-PI · deepseek · chat · 1 turns\nlogin-answer/);
  assert.match(text, /MINI-PI · deepseek · reasoner · 1 turns\nmodel-answer/);
});

test("interactive command releases its prompt and returns to the next prompt", async () => {
  const inputs = ["/login", "/model", "/logout", "/exit"];
  const closed: number[] = [];
  const output: string[] = [];
  const runtime: TuiRuntime = {
    createLine: () => ({
      question: async () => inputs.shift() ?? Promise.reject({ code: "EOF" }),
      close: () => { closed.push(1); }
    }),
    write: (text) => { output.push(text); }
  };
  const agent = { reset() {} } as never;
  const result = await startTui(agent, { project: "/project", provider: "deepseek", model: "old" }, {
    login: async (session) => session,
    model: async (session) => ({ ...session, model: "new" }),
    logout: async () => undefined
  }, runtime);
  assert.equal(result, 0);
  assert.equal(closed.length, 4);
  assert(output.some((text) => text.includes("Using deepseek / new.")));
});

test("a failed interactive command returns to the next prompt", async () => {
  const inputs = ["/model", "/exit"];
  const closed: number[] = [];
  const output: string[] = [];
  const runtime: TuiRuntime = {
    createLine: () => ({ question: async () => inputs.shift() ?? Promise.reject({ code: "EOF" }), close: () => { closed.push(1); } }),
    write: (text) => { output.push(text); }
  };
  const result = await startTui({ reset() {} } as never, { project: "/project", provider: "deepseek", model: "old" }, {
    login: async (session) => session,
    model: async () => { throw new Error("cancelled"); },
    logout: async () => undefined
  }, runtime);
  assert.equal(result, 0);
  assert.equal(closed.length, 2);
  assert(output.some((text) => text.includes("Error: cancelled")));
});

test("prompt EOF exits normally after closing its readline", async () => {
  let closed = false;
  const runtime: TuiRuntime = { createLine: () => ({ question: async () => Promise.reject({ code: "EOF" }), close: () => { closed = true; } }), write: () => undefined };
  assert.equal(await startTui({ reset() {} } as never, { project: "/project", provider: "openai", model: "gpt" }, undefined, runtime), 0);
  assert.equal(closed, true);
});

test("prompt SIGINT exits with 130 after closing its readline", async () => {
  let closed = false;
  const runtime: TuiRuntime = { createLine: () => ({ question: async () => Promise.reject({ code: "SIGINT" }), close: () => { closed = true; } }), write: () => undefined };
  assert.equal(await startTui({ reset() {} } as never, { project: "/project", provider: "openai", model: "gpt" }, undefined, runtime), 130);
  assert.equal(closed, true);
});

test("parseArgs recognizes help, version, provider, model, prompt, and project", () => {
  assert.deepEqual(parseArgs(["demo", "--provider", "openai", "--model", "gpt-4.1", "--prompt", "hi"]), {
    project: "demo", provider: "openai", model: "gpt-4.1", prompt: "hi", help: false, version: false
  });
  assert.equal(parseArgs(["-h"]).help, true);
  assert.equal(parseArgs(["-v"]).version, true);
});

test("parseArgs rejects unsupported providers and extra projects", () => {
  assert.throws(() => parseArgs(["--provider", "other"]), /Provider/);
  assert.throws(() => parseArgs(["one", "two"]), /one project/);
});

test("validateOptions resolves a project and takes keys only from environment", async () => {
  const options = parseArgs([".", "--provider", "openai", "--model", "gpt-4.1"]);
  const result = await validateOptions(options, { OPENAI_API_KEY: "test-key" }, process.cwd());
  assert.equal(result.error, undefined);
  assert.equal(result.apiKey, "test-key");
  assert.equal(result.rootDir, process.cwd());
});

test("validateOptions rejects a missing project or provider key", async () => {
  const missing = await validateOptions(parseArgs(["not-a-real-project"]), {}, process.cwd());
  assert.match(missing.error ?? "", /Project directory/);
  const key = await validateOptions(parseArgs([".", "--provider", "deepseek", "--model", "x"]), {}, process.cwd());
  assert.match(key.error ?? "", /No saved API key/);
  const file = await validateOptions(parseArgs(["package.json"]), {}, process.cwd());
  assert.match(file.error ?? "", /Project directory/);
});

test("an explicit prompt requires provider and model", async () => {
  const result = await validateOptions(parseArgs(["--prompt", "hello"]), {}, process.cwd());
  assert.match(result.error ?? "", /--prompt requires both --provider and --model/);
});

test("TUI commands and blank input have stable meanings", () => {
  assert.deepEqual(parseCommand("/help"), { type: "help" });
  assert.deepEqual(parseCommand("/reset"), { type: "reset" });
  assert.deepEqual(parseCommand("/exit"), { type: "exit" });
  assert.deepEqual(parseCommand("/login"), { type: "login" });
  assert.deepEqual(parseCommand("/model"), { type: "model" });
  assert.deepEqual(parseCommand("/logout"), { type: "logout" });
  assert.deepEqual(parseCommand(""), { type: "empty" });
  assert.deepEqual(parseCommand("/wat"), { type: "unknown", command: "/wat" });
  assert.deepEqual(parseCommand("inspect src"), { type: "prompt", prompt: "inspect src" });
});

test("agent events format without leaking full tool content", () => {
  assert.equal(formatEvent({ type: "model_start", turn: 2 }), "Thinking (turn 2)...");
  assert.equal(formatEvent({ type: "tool_end", turn: 1, toolCallId: "x", toolName: "read_file", isError: false, message: "completed" }), "✓ read_file");
  assert.equal(formatEvent({ type: "error", stage: "model", message: "Model request failed" }), "Error: Model request failed");
  assert.equal(formatEvent({ type: "agent_end", answer: "done", turns: 3 }), "Completed · 3 turns");
});

test("plain event formatting removes terminal controls from tool names and error summaries", () => {
  const malicious = "read\u001b]8;;https://bad\u0007_file\u001b[2J\u0000\u200b";
  const tool = formatEvent({ type: "tool_end", turn: 1, toolCallId: "call", toolName: malicious, isError: true, message: `failed\u009b31m\u001b]0;bad\u0007${malicious}` });
  const error = formatEvent({ type: "error", stage: "agent", message: `broken: ${malicious}` });
  for (const text of [tool, error]) assert(!/[\x00-\x1f\x7f-\x9f\u200b]/u.test(text));
  assert.equal(tool, "✗ read_file: failedread_file");
  assert.equal(error, "Error: broken: read_file");
});

test("TuiView records one collapsed activity with labels, counts, and duration", () => {
  const output: string[] = [];
  const times = [new Date(1000), new Date(1250)];
  const view = new TuiView({ write: (text) => output.push(text), now: () => times.shift()!, provider: "openai", renderMarkdown: (text) => `md:${text}` });
  view.onEvent({ type: "agent_start", prompt: "inspect src" });
  view.onEvent({ type: "model_start", turn: 1 });
  view.onEvent({ type: "tool_start", turn: 1, toolCallId: "a", toolName: "read_file" });
  view.onEvent({ type: "tool_end", turn: 1, toolCallId: "a", toolName: "read_file", isError: false, message: "SECRET TOOL RESULT" });
  view.onEvent({ type: "agent_end", answer: "# done", turns: 1 });
  const text = output.join("");
  assert.match(text, /\x1b\[38;5;110mYOU: inspect src/);
  assert.match(text, /\x1b\[38;5;141mMINI-PI · openai · 1 turns\nmd:# done/);
  assert.match(text, /\x1b\[38;5;245m▸ activity · 1 tools · 250ms/);
  assert.match(text, /· working · turn 1/);
  assert(!text.includes("Working...") && !text.includes("Thinking") && !text.includes("SECRET TOOL RESULT"));
});

test("TuiView creates and toggles a collapsed activity for a zero-tool run", () => {
  const output: string[] = [];
  const view = new TuiView({ write: (text) => output.push(text) });
  view.onEvent({ type: "agent_start", prompt: "hello" });
  view.onEvent({ type: "model_start", turn: 1 });
  view.onEvent({ type: "agent_end", answer: "done", turns: 1 });
  assert.equal(view.toggleLatestActivity(), true);
  assert.equal(view.toggleLatestActivity(), false);
  const text = output.join("");
  assert.match(text, /▸ activity · 0 tools · \d+ms/);
  assert.match(text, /▾ activity · 0 tools · \d+ms/);
});

test("TuiView appends safe tool summaries when toggled and retains them after errors", () => {
  const output: string[] = [];
  const view = new TuiView({ write: (text) => output.push(text) });
  view.onEvent({ type: "agent_start", prompt: "hello" });
  view.onEvent({ type: "tool_start", turn: 1, toolCallId: "a", toolName: "read_file" });
  view.onEvent({ type: "error", stage: "agent", message: "bad" });
  view.onEvent({ type: "agent_end", answer: "", turns: 1 });
  assert.equal(view.toggleLatestActivity(), true);
  assert.equal(view.toggleLatestActivity(), false);
  view.clearActivity();
  assert.equal(view.toggleLatestActivity(), false);
  const text = output.join("");
  assert.match(text, /▾ activity · 1 tools · \d+ms\n→ read_file/);
  assert.match(text, /▸ activity · 1 tools · \d+ms/);
  assert.match(text, /\x1b\[38;5;203mError: bad/);
});

test("TuiView defers a failure until agent_end finalizes activity and startTui does not duplicate it", async () => {
  const output: string[] = [];
  const inputs = ["question", "/exit"];
  const view = new TuiView({ write: (text) => output.push(text) });
  let sink: (event: import("../src/agent.js").AgentEvent) => void = view.onEvent.bind(view);
  const agent = { reset() {}, async run(prompt: string) {
    sink({ type: "agent_start", prompt });
    sink({ type: "tool_start", turn: 1, toolCallId: "a", toolName: "read_file" });
    sink({ type: "error", stage: "agent", message: "broken" });
    sink({ type: "agent_end", answer: "", turns: 1 });
    throw new Error("broken");
  } } as never;
  await startTui(agent, { project: "/project", provider: "openai", model: "gpt" }, undefined, {
    createLine: () => ({ question: async () => inputs.shift() ?? Promise.reject({ code: "EOF" }), close: () => undefined }),
    write: (text) => output.push(text)
  }, view);
  const text = output.join("");
  assert(text.indexOf("▸ activity · 1 tools") < text.indexOf("Error: broken"));
  assert.equal((text.match(/Error: broken/g) ?? []).length, 1);
});

test("startTui delegates user prompts to the navigation-aware run callback", async () => {
  const inputs = ["where is provider configuration?", "/exit"];
  const prompts: string[] = [];
  const agent = { reset() {}, async run() { throw new Error("direct run must not be used"); } } as never;
  const code = await startTui(agent, { project: "/project", provider: "openai", model: "gpt" }, undefined, {
    createLine: () => ({ question: async () => inputs.shift() ?? Promise.reject({ code: "EOF" }), close: () => undefined }),
    write: () => undefined,
    runAgent: async (_agent, prompt) => { prompts.push(prompt); return { answer: "src/llm.ts", messages: [], turns: 1 }; }
  });
  assert.equal(code, 0);
  assert.deepEqual(prompts, ["where is provider configuration?"]);
});

test("TuiView forwards MINI_PI_DEBUG to diagnostic formatting", () => {
  const output: string[] = [];
  const view = new TuiView({ write: (text) => output.push(text), debug: true });
  view.onEvent({ type: "error", stage: "model", turn: 1, message: "limited", diagnostic: { level: "warning", kind: "rate_limit", provider: "openai", message: "limited", reason: "slow down", advice: "retry", status: 429 } });
  assert.match(output.join(""), /调试：HTTP 429/);
});

test("TuiView keeps multiple activity records with their own turn counts", () => {
  const output: string[] = [];
  const view = new TuiView({ write: (text) => output.push(text) });
  view.onEvent({ type: "agent_start", prompt: "one" });
  view.onEvent({ type: "model_start", turn: 1 });
  view.onEvent({ type: "agent_end", answer: "one", turns: 1 });
  view.onEvent({ type: "agent_start", prompt: "two" });
  view.onEvent({ type: "model_start", turn: 1 });
  view.onEvent({ type: "model_start", turn: 2 });
  view.onEvent({ type: "tool_start", turn: 2, toolCallId: "b", toolName: "scan_project" });
  view.onEvent({ type: "tool_end", turn: 2, toolCallId: "b", toolName: "scan_project", isError: false, message: "completed" });
  view.onEvent({ type: "agent_end", answer: "two", turns: 2 });
  const text = output.join("");
  assert.match(text, /MINI-PI · openai · 1 turns/);
  assert.match(text, /MINI-PI · openai · 2 turns/);
  assert.equal((text.match(/▸ activity/g) ?? []).length, 2);
  assert.match(text, /▸ activity · 1 tools · \d+ms/);
});

test("TuiView strips control and default-ignorable characters from all plain fields", () => {
  const output: string[] = [];
  const view = new TuiView({ write: (text) => output.push(text) });
  const malicious = "ok\u0000\u009b31m\u001b]8;;bad\u0007\u200b\u2060";
  view.onEvent({ type: "agent_start", prompt: malicious });
  view.onEvent({ type: "tool_start", turn: 1, toolCallId: malicious, toolName: malicious });
  view.onEvent({ type: "error", stage: "agent", message: malicious });
  const text = output.join("").replace(/\x1b\[\d+(?:;\d+)*m/g, "");
  assert(!/[\x00-\x09\x0b-\x1f\x7f-\x9f\u200b\u2060]/u.test(text));
  assert(!text.includes("\x1b]") && !text.includes("\x9b"));
});

test("Markdown output strips default-ignorable characters while retaining trusted SGR", () => {
  const rendered = renderMarkdown("a\u200b\u2060b", () => "\x1b[35ma\u200b\u2060b\x1b[0m");
  assert.equal(rendered, "\x1b[35mab\x1b[0m");
});

test("renders Chinese model diagnostics and only exposes safe debug fields", () => {
  const event = { type: "error" as const, stage: "model" as const, turn: 2, message: "DeepSeek 请求受限", diagnostic: { level: "warning" as const, kind: "rate_limit" as const, provider: "deepseek" as const, message: "DeepSeek 请求受限", reason: "当前请求被限流、余额或并发限制。", advice: "稍后重试，或切换模型 / Provider。", status: 429, code: "rate_limit", requestId: "req_2" } };
  const normal = formatEvent(event);
  assert.match(normal, /警告 \[限流\][\s\S]*DeepSeek，第 2 次模型请求[\s\S]*原因：当前请求被限流/);
  assert(!normal.includes("429") && !normal.includes("rate_limit") && !normal.includes("req_2"));
  assert.match(formatEvent(event, true), /调试：HTTP 429$/);
});

test("only MINI_PI_DEBUG exactly 1 enables debug rendering", () => {
  assert.equal(debugEnabled({ MINI_PI_DEBUG: "1" }), true);
  assert.equal(debugEnabled({ MINI_PI_DEBUG: "true" }), false);
  assert.equal(debugEnabled({}), false);
});

test("debug formatting never renders provider supplied secret-like fields", () => {
  const event = { type: "error" as const, stage: "model" as const, turn: 1, message: "Provider 请求失败", diagnostic: { level: "warning" as const, kind: "unknown" as const, provider: "openai" as const, message: "Provider 请求失败", reason: "Provider 返回了无法分类的错误。", advice: "查看调试信息或稍后重试。", status: 400, code: "api_key_SECRET", requestId: "token-super-secret" } };
  const text = formatEvent(event, true);
  assert(!text.includes("SECRET") && !text.includes("token-super-secret"));
});

test("interactive completion uses provider models unless a model was supplied", async () => {
  const initial = await validateOptions(parseArgs([".", "--provider", "openai"]), { OPENAI_API_KEY: "key" }, process.cwd());
  const complete = await completeInteractiveOptions(initial, {
    chooseProvider: async () => "deepseek", chooseModel: async (models) => models[0], listModels: async () => ["z", "a"]
  });
  assert.equal(complete.model, "z");
  assert.equal(complete.error, undefined);
  const supplied = await completeInteractiveOptions({ ...initial, model: "manual" }, {
    chooseProvider: async () => "openai", chooseModel: async () => "bad", listModels: async () => { throw new Error("must not list"); }
  });
  assert.equal(supplied.model, "manual");
});

test("interactive completion reports model listing failures and empty lists", async () => {
  const initial = await validateOptions(parseArgs([".", "--provider", "openai"]), { OPENAI_API_KEY: "key" }, process.cwd());
  const failure = await completeInteractiveOptions(initial, { chooseProvider: async () => "openai", chooseModel: async () => "", listModels: async () => { throw new Error("nope"); } });
  assert.match(failure.error ?? "", /pass --model/);
  const empty = await completeInteractiveOptions(initial, { chooseProvider: async () => "openai", chooseModel: async () => "", listModels: async () => [] });
  assert.match(empty.error ?? "", /pass --model/);
});

test("interactive completion uses the supplied environment and preserves cancellation", async () => {
  const noProvider = await validateOptions(parseArgs(["."]), {}, process.cwd());
  const complete = await completeInteractiveOptions(noProvider, {
    chooseProvider: async () => "openai", chooseModel: async (models) => models[0], listModels: async () => ["model"]
  }, { OPENAI_API_KEY: "injected" });
  assert.equal(complete.apiKey, "injected");
  await assert.rejects(
    completeInteractiveOptions(noProvider, { chooseProvider: async () => { throw { name: "ExitPromptError" }; }, chooseModel: async () => "", listModels: async () => [] }, {}),
    { name: "ExitPromptError" }
  );
});

test("model-only CLI resolves the selected provider's saved credential", async () => {
  const initial = await validateOptions(parseArgs([".", "--model", "chosen"]), {}, process.cwd());
  const complete = await completeInteractiveOptions(initial, { chooseProvider: async () => "deepseek", chooseModel: async () => "never", listModels: async () => [] }, {}, fakeCredentials({ deepseek: "stored-key" }));
  assert.equal(complete.provider, "deepseek");
  assert.equal(complete.model, "chosen");
  assert.equal(complete.apiKey, "stored-key");
});

test("help identifies the active project provider and model, and system prompt is exact", () => {
  assert.match(helpText("/project", "openai", "gpt"), /Project: \/project/);
  assert.match(helpText("/project", "openai", "gpt"), /Provider: openai/);
  assert.match(helpText("/project", "openai", "gpt"), /Model: gpt/);
  assert.match(helpText("/project", "openai", "gpt"), /\/login, \/model, \/logout/);
  assert.match(SYSTEM_PROMPT, /Use tools to gather evidence before making claims/);
  assert.match(SYSTEM_PROMPT, /Answer in the user's language/);
});

test("prompt cancellation maps to the conventional Ctrl+C exit status", () => {
  assert.equal(exitCodeFor({ name: "ExitPromptError" }), 130);
  assert.equal(exitCodeFor({ name: "AbortPromptError" }), 130);
  assert.equal(exitCodeFor({ code: "SIGINT" }), 130);
  assert.equal(exitCodeFor(new Error("other")), 1);
});

function fakeCredentials(values: Record<string, string | undefined> = {}): CredentialStore {
  return {
    getPassword: async (_service, account) => values[account] ?? null,
    setPassword: async (_service, account, password) => { values[account] = password; },
    deletePassword: async (_service, account) => { delete values[account]; return true; }
  };
}

async function tempConfigPath(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), "mini-pi-cli-")), "nested", "config.json");
}

test("environment keys override stored credentials without modifying them", async () => {
  const credentials = fakeCredentials({ openai: "stored-key" });
  const key = await resolveApiKey("openai", credentials, { OPENAI_API_KEY: "environment-key" });
  assert.deepEqual(key, { apiKey: "environment-key", source: "environment" });
  assert.equal(await credentials.getPassword("mini-Pi", "openai"), "stored-key");
});

test("environment keys work when the native credential store cannot load", async () => {
  const unavailable = createSystemCredentialStore(() => { throw new Error("native addon unavailable"); });
  assert.deepEqual(await resolveApiKey("openai", unavailable, { OPENAI_API_KEY: "environment-key" }), {
    apiKey: "environment-key", source: "environment"
  });
  assert.equal(await resolveApiKey("openai", unavailable, {}), undefined);
});

test("a saved preference and matching credential provide direct startup selection", async () => {
  const configPath = await tempConfigPath();
  await saveGlobalPreference({ provider: "deepseek", model: "deepseek-chat" }, configPath);
  const selection = await getStartupSelection(fakeCredentials({ deepseek: "stored-key" }), configPath, {});
  assert.deepEqual(selection, {
    provider: "deepseek", model: "deepseek-chat", apiKey: "stored-key", keySource: "credential-store"
  });
  assert.deepEqual(JSON.parse(await readFile(configPath, "utf8")), { provider: "deepseek", model: "deepseek-chat" });
});

test("missing or malformed preferences safely produce no startup selection", async () => {
  const missing = await tempConfigPath();
  assert.equal(await readGlobalPreference(missing), undefined);
  assert.equal(await getStartupSelection(fakeCredentials({ openai: "secret" }), missing, {}), undefined);

  const invalid = await tempConfigPath();
  await saveGlobalPreference({ provider: "openai", model: "temporary" }, invalid);
  await writeFile(invalid, '{"provider":"openai","model":42}', "utf8");
  assert.equal(await readGlobalPreference(invalid), undefined);
  assert.equal(await getStartupSelection(fakeCredentials({ openai: "secret" }), invalid, {}), undefined);
});

test("global preferences reject extra fields and never serialize an api key", async () => {
  const configPath = await tempConfigPath();
  await saveGlobalPreference({ provider: "openai", model: "gpt", apiKey: "must-not-persist" } as never, configPath);
  assert.deepEqual(JSON.parse(await readFile(configPath, "utf8")), { provider: "openai", model: "gpt" });
  await writeFile(configPath, '{"provider":"openai","model":"gpt","apiKey":"must-not-read"}', "utf8");
  assert.equal(await readGlobalPreference(configPath), undefined);
});

test("a failed preference save removes its temporary file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mini-pi-cli-"));
  const configPath = join(directory, "config.json");
  await mkdir(configPath);
  await assert.rejects(saveGlobalPreference({ provider: "openai", model: "gpt" }, configPath));
  assert.deepEqual(await readdir(directory), ["config.json"]);
});

test("login validates and selects before committing a credential and preference", async () => {
  const values: Record<string, string | undefined> = { openai: "old-key" };
  const saved: Array<{ provider: string; model: string }> = [];
  const result = await loginWithCredentialStore({
    credentials: fakeCredentials(values), chooseProvider: async () => "deepseek", askApiKey: async () => "new-key",
    listModels: async (provider, key) => { assert.equal(provider, "deepseek"); assert.equal(key, "new-key"); return ["chat"]; },
    chooseModel: async (models) => models[0], savePreference: async (preference) => { saved.push(preference); }
  });
  assert.deepEqual(result, { provider: "deepseek", model: "chat", apiKey: "new-key", keySource: "credential-store" });
  assert.equal(values.deepseek, "new-key");
  assert.deepEqual(saved, [{ provider: "deepseek", model: "chat" }]);
});

test("login and model selection leave existing state unchanged when interaction or saving fails", async () => {
  const values: Record<string, string | undefined> = { openai: "old-key" };
  const credentials = fakeCredentials(values);
  await assert.rejects(loginWithCredentialStore({
    credentials, chooseProvider: async () => "deepseek", askApiKey: async () => "bad-key", listModels: async () => { throw new Error("bad key"); },
    chooseModel: async () => "never", savePreference: async () => undefined
  }), /bad key/);
  assert.deepEqual(values, { openai: "old-key" });
  await assert.rejects(loginWithCredentialStore({
    credentials, chooseProvider: async () => "deepseek", askApiKey: async () => "new-key", listModels: async () => ["chat"],
    chooseModel: async () => "chat", savePreference: async () => { throw new Error("disk failed"); }
  }), /disk failed/);
  assert.equal((values as Record<string, string | undefined>)["deepseek"], undefined);
  const preference = { provider: "openai" as const, model: "old-model" };
  await assert.rejects(selectAndSaveModel(preference, "old-key", {
    listModels: async () => ["new-model"],
    chooseModel: async () => "new-model", savePreference: async () => { throw new Error("disk failed"); }
  }), /disk failed/);
  assert.deepEqual(preference, { provider: "openai", model: "old-model" });
});

test("login does not save a preference when secure credential storage is unavailable", async () => {
  let saved = false;
  const unavailable: CredentialStore = { getPassword: async () => { throw new Error("unavailable"); }, setPassword: async () => { throw new Error("unavailable"); }, deletePassword: async () => false };
  await assert.rejects(loginWithCredentialStore({ credentials: unavailable, chooseProvider: async () => "openai", askApiKey: async () => "key", listModels: async () => ["model"], chooseModel: async () => "model", savePreference: async () => { saved = true; } }), /unavailable/);
  assert.equal(saved, false);
});

test("logout chooses a stored provider and clears the matching default only", async () => {
  const values: Record<string, string | undefined> = { openai: "one", deepseek: "two" };
  const cleared: string[] = [];
  const provider = await logoutFromCredentialStore(fakeCredentials(values), { provider: "deepseek", model: "chat" }, async (items) => {
    assert.deepEqual(items, ["openai", "deepseek"]); return "deepseek";
  }, async () => { cleared.push("default"); });
  assert.equal(provider, "deepseek");
  assert.equal(values.deepseek, undefined);
  assert.deepEqual(cleared, ["default"]);
});

test("logout reports a failed default cleanup instead of claiming completion", async () => {
  const values: Record<string, string | undefined> = { deepseek: "key" };
  await assert.rejects(logoutFromCredentialStore(fakeCredentials(values), { provider: "deepseek", model: "chat" }, async () => "deepseek", async () => { throw new Error("preference cleanup failed"); }), /preference cleanup failed/);
  assert.equal(values.deepseek, undefined);
});
