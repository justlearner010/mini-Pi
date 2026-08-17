import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { Agent, type AgentEvent, type AgentResult, type ApprovalRequest } from "../src/agent.js";
import { ProviderDiagnostic, type LLMClient, type Message, type ModelResponse } from "../src/llm.js";
import { switchProjectTool, tools, type Tool } from "../src/tool.js";

function response(content: string | null, toolCalls: ModelResponse["message"]["toolCalls"] = []): ModelResponse {
  return { message: { role: "assistant", content, toolCalls } };
}

function fakeLLM(replies: Array<ModelResponse | Error>) {
  const requests: Message[][] = [];
  const llm: LLMClient = { async generate(messages) {
    requests.push(structuredClone(messages));
    const reply = replies.shift();
    if (reply instanceof Error) throw reply;
    if (!reply) throw new Error("unexpected model call");
    return reply;
  } };
  return { llm, requests };
}

function tool(name: string, execute: Tool["execute"]): Tool {
  return { name, description: name, parameters: { type: "object" }, permission: "SAFE", reason: "Read-only test operation", risk: "low", execute };
}

function approvalTool(permission: "SENSITIVE" | "DESTRUCTIVE", execute: Tool["execute"]): Tool {
  return { name: "guarded", description: "guarded", parameters: { type: "object" }, permission, reason: "This operation needs explicit approval", risk: "medium", execute };
}

test("efficiency fixtures expose stable project layouts and dependency relationships", async () => {
  const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/efficiency/${name}`, import.meta.url));
  const byName = (name: string) => {
    const found = tools.find((candidate) => candidate.name === name);
    assert(found, `missing ${name} tool`);
    return found;
  };

  const alphaScan = await byName("scan_project").execute({}, { rootDir: fixture("alpha-service") });
  assert.equal(alphaScan.isError, false);
  assert.deepEqual((alphaScan.content as { sourceFiles: string[] }).sourceFiles, ["src/auth/session.ts", "src/index.ts", "src/unused/report.ts"]);

  const cases = [
    ["alpha-service", "src/index.ts", ["src/auth/session.ts", "src/index.ts", "src/unused/report.ts"], ["src/index.ts", "src/auth/session.ts"]],
    ["beta-workspace", "packages/api/src/main.ts", ["packages/api/src/main.ts", "packages/api/src/router.ts", "packages/web/src/app.ts"], ["packages/api/src/main.ts", "packages/api/src/router.ts"]],
    ["gamma-layered", "src/server.ts", ["src/domain/orders.ts", "src/infra/store.ts", "src/server.ts"], ["src/server.ts", "src/domain/orders.ts", "src/infra/store.ts"]]
  ] as const;
  for (const [name, entry, analyzedFiles, entryFiles] of cases) {
    const manifest = await byName("read_file").execute({ path: "package.json" }, { rootDir: fixture(name) });
    assert.equal(manifest.isError, false);
    const packageJson = JSON.parse((manifest.content as { content: string }).content) as { name: string; type: string; scripts: { start: string } };
    assert.equal(packageJson.name, name);
    assert.equal(packageJson.type, "module");
    assert.equal(packageJson.scripts.start, `node --import tsx ${entry}`);

    const analysis = await byName("analyze_dependencies").execute({ entry }, { rootDir: fixture(name) });
    assert.equal(analysis.isError, false);
    const content = analysis.content as { analyzedFiles: string[]; entryTree: string | null };
    assert.deepEqual(content.analyzedFiles, analyzedFiles);
    assert.equal(content.entryTree, entryFiles.map((file, index) => `${"  ".repeat(index)}${file}`).join("\n"));
  }
});

test("returns a direct answer and retains shared history", async () => {
  const fake = fakeLLM([response("first"), response("second")]);
  const agent = new Agent({ llm: fake.llm, tools: [], systemPrompt: "rules", rootDir: "/project" });
  const first: AgentResult = await agent.run("one");
  assert.deepEqual(first, { answer: "first", messages: [{ role: "system", content: "rules" }, { role: "user", content: "one" }, { role: "assistant", content: "first", toolCalls: [] }], turns: 1 });
  assert.equal((await agent.run("two")).answer, "second");
  assert.deepEqual(fake.requests[1], [
    { role: "system", content: "rules" }, { role: "user", content: "one" }, { role: "assistant", content: "first", toolCalls: [] }, { role: "user", content: "two" }
  ]);
});

test("executes tool calls sequentially and gives their results to the next model call", async () => {
  const calls: string[] = [];
  const fake = fakeLLM([
    response(null, [{ id: "a", name: "first", arguments: '{"n":1}' }, { id: "b", name: "second", arguments: '{"n":2}' }]), response("done")
  ]);
  const agent = new Agent({ llm: fake.llm, tools: [
    tool("first", async (args, context) => { calls.push(`first:${JSON.stringify(args)}:${context.rootDir}`); return { content: "A", isError: false }; }),
    tool("second", async (args) => { calls.push(`second:${JSON.stringify(args)}`); return { content: { value: "B" }, isError: false }; })
  ], systemPrompt: "rules", rootDir: "/project" });
  assert.equal((await agent.run("go")).answer, "done");
  assert.deepEqual(calls, ['first:{"n":1}:/project', 'second:{"n":2}']);
  assert.deepEqual(fake.requests[1].slice(-3), [
    { role: "assistant", content: null, toolCalls: [{ id: "a", name: "first", arguments: '{"n":1}' }, { id: "b", name: "second", arguments: '{"n":2}' }] },
    { role: "tool", toolCallId: "a", content: "A" }, { role: "tool", toolCallId: "b", content: '{"value":"B"}' }
  ]);
});

test("SAFE tools execute without requesting approval", async () => {
  const fake = fakeLLM([response(null, [{ id: "safe", name: "safe", arguments: '{"value":1}' }]), response("done")]);
  let executions = 0;
  let approvals = 0;
  const agent = new Agent({ llm: fake.llm, tools: [tool("safe", async () => { executions += 1; return { content: "ok", isError: false }; })], systemPrompt: "rules", rootDir: "/p", requestApproval: async () => { approvals += 1; return { approved: true, reason: "not needed" }; } });
  await agent.run("go");
  assert.equal(executions, 1);
  assert.equal(approvals, 0);
});

test("approved SENSITIVE tools receive the complete request then execute", async () => {
  const fake = fakeLLM([response(null, [{ id: "sensitive", name: "guarded", arguments: '{"path":"secrets.txt"}' }]), response("done")]);
  const approvals: ApprovalRequest[] = [];
  let executions = 0;
  const agent = new Agent({ llm: fake.llm, tools: [approvalTool("SENSITIVE", async () => { executions += 1; return { content: "ok", isError: false }; })], systemPrompt: "rules", rootDir: "/p", requestApproval: async (request) => { approvals.push(request); return { approved: true, reason: "confirmed" }; } });
  await agent.run("go");
  assert.equal(executions, 1);
  assert.deepEqual(approvals, [{ toolName: "guarded", permission: "SENSITIVE", reason: "This operation needs explicit approval", risk: "medium", arguments: { path: "secrets.txt" } }]);
});

test("object approval decisions deny tools without executing and return a safe denial reason", async () => {
  const fake = fakeLLM([response(null, [{ id: "declined", name: "guarded", arguments: "{}" }]), response("recovered")]);
  const events: AgentEvent[] = [];
  let executions = 0;
  const agent = new Agent({ llm: fake.llm, tools: [approvalTool("DESTRUCTIVE", async () => { executions += 1; return { content: "bad", isError: false }; })], systemPrompt: "rules", rootDir: "/p", requestApproval: async () => ({ approved: false, reason: "not now" }), onEvent: (event) => events.push(event) });
  assert.equal((await agent.run("go")).answer, "recovered");
  assert.equal(executions, 0);
  assert.deepEqual(fake.requests[1].at(-1), { role: "tool", toolCallId: "declined", content: "Tool error: User declined guarded: approval denied" });
  assert.deepEqual(events.filter((event) => event.type === "tool_start" || event.type === "tool_end"), [
    { type: "tool_end", turn: 1, toolCallId: "declined", toolName: "guarded", isError: true, message: "User declined guarded: approval denied" }
  ]);
});

test("switch_project swaps the root and tools after approval and clears stale context", async () => {
  const calls: string[] = [];
  const fake = fakeLLM([
    response(null, [{ id: "sw", name: "switch_project", arguments: '{"path":"/other"}' }]),
    response(null, [{ id: "rd", name: "read", arguments: '{"path":"a.ts"}' }]),
    response("done")
  ]);
  const approvals: ApprovalRequest[] = [];
  const switchedTools = [tool("read", async (_args, context) => { calls.push(`read:${context.rootDir}`); return { content: "ok", isError: false }; })];
  const agent = new Agent({
    llm: fake.llm,
    tools: [switchProjectTool, tool("read", async (_args, context) => { calls.push(`read:${context.rootDir}`); return { content: "ok", isError: false }; })],
    systemPrompt: "rules",
    rootDir: "/old",
    requestApproval: async (request) => { approvals.push(request); return { approved: true, reason: "confirmed" }; },
    switchProject: async (path) => ({ ok: true, rootDir: path, tools: switchedTools, notice: `Switched to ${path}; index rebuilt` })
  });
  const result = await agent.run("go", { transientContext: "STALE MAP CONTENT" });
  assert.equal(result.answer, "done");
  assert.deepEqual(approvals, [{ toolName: "switch_project", permission: "SENSITIVE", reason: "Repoints the project root the agent reads to another directory.", risk: "After approval, the agent can read files under the new directory and send their contents to the Provider.", arguments: { path: "/other" } }]);
  assert.deepEqual(calls, ["read:/other"]);
  const switchedMessage = result.messages.find((item) => item.role === "tool" && item.toolCallId === "sw");
  assert(switchedMessage && typeof switchedMessage.content === "string" && switchedMessage.content.includes("Switched to /other"));
  assert(!JSON.stringify(fake.requests[1]).includes("STALE MAP CONTENT"));
  assert(!JSON.stringify(fake.requests[2]).includes("STALE MAP CONTENT"));
});

test("switch_project fails closed without a handler", async () => {
  const fake = fakeLLM([response(null, [{ id: "sw", name: "switch_project", arguments: '{"path":"/other"}' }]), response("recovered")]);
  const agent = new Agent({ llm: fake.llm, tools: [switchProjectTool], systemPrompt: "rules", rootDir: "/old", requestApproval: async () => ({ approved: true, reason: "ok" }) });
  const result = await agent.run("go");
  assert.equal(result.answer, "recovered");
  const message = result.messages.find((item) => item.role === "tool" && item.toolCallId === "sw");
  assert(message && typeof message.content === "string" && /Tool error: Project switching is unavailable/.test(message.content));
});

test("switch_project surfaces a handler failure to the model", async () => {
  const fake = fakeLLM([response(null, [{ id: "sw", name: "switch_project", arguments: '{"path":"/missing"}' }]), response("recovered")]);
  const agent = new Agent({ llm: fake.llm, tools: [switchProjectTool], systemPrompt: "rules", rootDir: "/old", requestApproval: async () => ({ approved: true, reason: "ok" }), switchProject: async () => ({ ok: false, error: "Project directory not found: /missing" }) });
  const result = await agent.run("go");
  assert.equal(result.answer, "recovered");
  const message = result.messages.find((item) => item.role === "tool" && item.toolCallId === "sw");
  assert(message && typeof message.content === "string" && /Tool error: Project directory not found/.test(message.content));
});

test("switch_project requires approval and a denial blocks the switch", async () => {
  const fake = fakeLLM([response(null, [{ id: "sw", name: "switch_project", arguments: '{"path":"/other"}' }]), response("recovered")]);
  let switched = 0;
  const agent = new Agent({ llm: fake.llm, tools: [switchProjectTool], systemPrompt: "rules", rootDir: "/old", requestApproval: async () => ({ approved: false, reason: "not now" }), switchProject: async () => { switched += 1; return { ok: true, rootDir: "/other", tools: [] }; } });
  const result = await agent.run("go");
  assert.equal(switched, 0);
  const message = result.messages.find((item) => item.role === "tool" && item.toolCallId === "sw");
  assert(message && typeof message.content === "string" && /User declined switch_project/.test(message.content));
});

test("unknown runtime permissions fail closed without asking or executing", async () => {
  const fake = fakeLLM([response(null, [{ id: "bogus", name: "guarded", arguments: "{}" }]), response("recovered")]);
  let approvals = 0;
  let executions = 0;
  const guarded = { ...approvalTool("SENSITIVE", async () => { executions += 1; return { content: "bad", isError: false }; }), permission: "BOGUS" as unknown as Tool["permission"] };
  const agent = new Agent({ llm: fake.llm, tools: [guarded], systemPrompt: "rules", rootDir: "/p", requestApproval: async () => { approvals += 1; return { approved: true, reason: "approved" }; } });
  await agent.run("go");
  assert.equal(approvals, 0);
  assert.equal(executions, 0);
  assert.deepEqual(fake.requests[1].at(-1), { role: "tool", toolCallId: "bogus", content: "Tool error: User declined guarded: approval failed" });
});

test("malformed approval decisions fail closed without executing", async () => {
  const fake = fakeLLM([response(null, [{ id: "malformed", name: "guarded", arguments: "{}" }]), response("recovered")]);
  let executions = 0;
  const agent = new Agent({ llm: fake.llm, tools: [approvalTool("SENSITIVE", async () => { executions += 1; return { content: "bad", isError: false }; })], systemPrompt: "rules", rootDir: "/p", requestApproval: async () => ({ approved: "yes" as unknown as boolean, reason: "secret reason" }) });
  await agent.run("go");
  assert.equal(executions, 0);
  assert.deepEqual(fake.requests[1].at(-1), { role: "tool", toolCallId: "malformed", content: "Tool error: User declined guarded: approval failed" });
});

test("approval callback reasons never leak into model history or tool events", async () => {
  const secret = "secret-approval-reason-".repeat(100);
  const fake = fakeLLM([response(null, [{ id: "secret", name: "guarded", arguments: "{}" }]), response("recovered")]);
  const events: AgentEvent[] = [];
  const agent = new Agent({ llm: fake.llm, tools: [approvalTool("SENSITIVE", async () => ({ content: "bad", isError: false }))], systemPrompt: "rules", rootDir: "/p", requestApproval: async () => ({ approved: false, reason: secret }), onEvent: (event) => events.push(event) });
  await agent.run("go");
  assert(!JSON.stringify(fake.requests).includes(secret));
  assert(!JSON.stringify(events).includes(secret));
});

test("missing or failed approval callbacks fail closed without tool_start", async () => {
  for (const requestApproval of [undefined, async () => { throw new Error("approval UI disconnected"); }]) {
    const fake = fakeLLM([response(null, [{ id: "blocked", name: "guarded", arguments: "{}" }]), response("recovered")]);
    const events: AgentEvent[] = [];
    let executions = 0;
    const agent = new Agent({ llm: fake.llm, tools: [approvalTool("SENSITIVE", async () => { executions += 1; return { content: "bad", isError: false }; })], systemPrompt: "rules", rootDir: "/p", requestApproval, onEvent: (event) => events.push(event) });
    await agent.run("go");
    const reason = requestApproval ? "approval failed" : "approval unavailable";
    assert.equal(executions, 0);
    assert.deepEqual(fake.requests[1].at(-1), { role: "tool", toolCallId: "blocked", content: `Tool error: User declined guarded: ${reason}` });
    assert.deepEqual(events.filter((event) => event.type === "tool_start" || event.type === "tool_end"), [
      { type: "tool_end", turn: 1, toolCallId: "blocked", toolName: "guarded", isError: true, message: `User declined guarded: ${reason}` }
    ]);
  }
});

test("recovers from unknown tools, malformed arguments, and tool failures", async () => {
  const fake = fakeLLM([
    response(null, [{ id: "unknown", name: "nope", arguments: "{}" }, { id: "bad", name: "ok", arguments: "{" }, { id: "fail", name: "broken", arguments: "{}" }]), response("recovered")
  ]);
  const agent = new Agent({ llm: fake.llm, tools: [tool("ok", async () => ({ content: "ok", isError: false })), tool("broken", async () => { throw new Error("private failure"); })], systemPrompt: "rules", rootDir: "/project" });
  assert.equal((await agent.run("go")).answer, "recovered");
  const results = fake.requests[1].filter((message) => message.role === "tool");
  assert.equal(results.length, 3);
  assert(results.every((message) => message.role === "tool" && /error/i.test(message.content)));
});

test("unknown and malformed tool calls emit only error endings", async () => {
  const fake = fakeLLM([response(null, [{ id: "unknown", name: "nope", arguments: "{}" }, { id: "bad", name: "ok", arguments: "{" }]), response("recovered")]);
  const events: AgentEvent[] = [];
  const agent = new Agent({ llm: fake.llm, tools: [tool("ok", async () => ({ content: "ok", isError: false }))], systemPrompt: "rules", rootDir: "/project", onEvent: (event) => events.push(event) });
  await agent.run("go");
  assert.deepEqual(events.filter((event) => event.type === "tool_start" || event.type === "tool_end"), [
    { type: "tool_end", turn: 1, toolCallId: "unknown", toolName: "nope", isError: true, message: "Unknown tool: nope" },
    { type: "tool_end", turn: 1, toolCallId: "bad", toolName: "ok", isError: true, message: "Malformed tool arguments" }
  ]);
});

test("emits lifecycle events including tool events", async () => {
  const fake = fakeLLM([response(null, [{ id: "x", name: "echo", arguments: "{}" }]), response("done")]);
  const events: AgentEvent[] = [];
  const agent = new Agent({ llm: fake.llm, tools: [tool("echo", async () => ({ content: "yes", isError: false }))], systemPrompt: "rules", rootDir: "/project", onEvent: (event) => events.push(event) });
  await agent.run("go");
  assert.deepEqual(events, [
    { type: "agent_start", prompt: "go" }, { type: "model_start", turn: 1 }, { type: "model_end", turn: 1, toolCallCount: 1 },
    { type: "tool_start", turn: 1, toolCallId: "x", toolName: "echo" }, { type: "tool_end", turn: 1, toolCallId: "x", toolName: "echo", isError: false, message: "completed" },
    { type: "model_start", turn: 2 }, { type: "model_end", turn: 2, toolCallCount: 0 }, { type: "agent_end", answer: "done", turns: 2 }
  ]);
});

test("allows final answer on maxTurns and rejects only when another model call is needed", async () => {
  const seven = fakeLLM(Array.from({ length: 7 }, (_, i) => response(i === 6 ? "done" : null, i === 6 ? [] : [{ id: String(i), name: "noop", arguments: "{}" }])));
  const eight = fakeLLM(Array.from({ length: 8 }, (_, i) => response(i === 7 ? "done" : null, i === 7 ? [] : [{ id: String(i), name: "noop", arguments: "{}" }])));
  const nine = fakeLLM(Array.from({ length: 8 }, (_, i) => response(null, [{ id: String(i), name: "noop", arguments: "{}" }])));
  const config = (llm: LLMClient, onEvent?: (event: AgentEvent) => void) => new Agent({ llm, tools: [tool("noop", async () => ({ content: "", isError: false }))], systemPrompt: "r", rootDir: "/p", maxTurns: 8, onEvent });
  assert.equal((await config(seven.llm).run("x")).answer, "done");
  assert.equal((await config(eight.llm).run("x")).answer, "done");
  const events: AgentEvent[] = [];
  await assert.rejects(() => config(nine.llm, (event) => events.push(event)).run("x"), /maximum turns/i);
  assert.equal(nine.requests.length, 8);
  assert.deepEqual(events.slice(-2), [{ type: "error", stage: "agent", message: "Agent reached maximum turns" }, { type: "agent_end", answer: "", turns: 8 }]);
});

test("defaults to sixteen turns while an explicit one-turn limit still stops after a tool call", async () => {
  const sixteen = fakeLLM(Array.from({ length: 16 }, (_, i) => response(i === 15 ? "done" : null, i === 15 ? [] : [{ id: String(i), name: "noop", arguments: "{}" }])));
  const defaultAgent = new Agent({ llm: sixteen.llm, tools: [tool("noop", async () => ({ content: "", isError: false }))], systemPrompt: "r", rootDir: "/p" });
  const result = await defaultAgent.run("x");
  assert.equal(result.answer, "done");
  assert.equal(result.turns, 16);

  const one = fakeLLM([response(null, [{ id: "only", name: "noop", arguments: "{}" }])]);
  let executions = 0;
  const limitedAgent = new Agent({ llm: one.llm, tools: [tool("noop", async () => { executions += 1; return { content: "", isError: false }; })], systemPrompt: "r", rootDir: "/p", maxTurns: 1 });
  await assert.rejects(() => limitedAgent.run("x"), /maximum turns/i);
  assert.equal(executions, 1);
  assert.equal(one.requests.length, 1);
});

test("default turn limit rejects after sixteen tool-call turns", async () => {
  const sixteen = fakeLLM(Array.from({ length: 16 }, (_, i) => response(null, [{ id: String(i), name: "noop", arguments: "{}" }])));
  const events: AgentEvent[] = [];
  const agent = new Agent({ llm: sixteen.llm, tools: [tool("noop", async () => ({ content: "", isError: false }))], systemPrompt: "r", rootDir: "/p", onEvent: (event) => events.push(event) });

  await assert.rejects(() => agent.run("x"), /maximum turns/i);
  assert.equal(sixteen.requests.length, 16);
  assert.deepEqual(events.slice(-2), [{ type: "error", stage: "agent", message: "Agent reached maximum turns" }, { type: "agent_end", answer: "", turns: 16 }]);
});

test("reset restores only the system prompt and provider failures rollback a run", async () => {
  const fake = fakeLLM([response("saved"), new Error("secret exposed"), response("fresh")]);
  const events: AgentEvent[] = [];
  const agent = new Agent({ llm: fake.llm, tools: [], systemPrompt: "rules", rootDir: "/p", onEvent: (event) => events.push(event) });
  await agent.run("keep");
  await assert.rejects(() => agent.run("rollback"), /Model request failed/);
  assert.deepEqual(fake.requests[1].at(-1), { role: "user", content: "rollback" });
  agent.reset();
  assert.equal((await agent.run("new")).answer, "fresh");
  assert.deepEqual(fake.requests[2], [{ role: "system", content: "rules" }, { role: "user", content: "new" }]);
  assert.deepEqual(events.slice(4, 7), [
    { type: "agent_start", prompt: "rollback" }, { type: "model_start", turn: 1 }, { type: "error", stage: "model", message: "Model request failed" }
  ]);
});

test("an agent can carry a completed conversation into a replacement model", async () => {
  const one = fakeLLM([response("one")]);
  const two = fakeLLM([response("two")]);
  const first = new Agent({ llm: one.llm, tools: [], rootDir: ".", systemPrompt: "system" });
  await first.run("first");
  const second = new Agent({ llm: two.llm, tools: [], rootDir: ".", systemPrompt: "system", messages: first.history() });
  const result = await second.run("second");
  assert.deepEqual(result.messages.map((message) => message.content), ["system", "first", "one", "second", "two"]);
});

test("tool events summarize errors and never leak large tool content", async () => {
  const large = "sensitive-content-".repeat(1000);
  const fake = fakeLLM([response(null, [{ id: "ok", name: "large", arguments: "{}" }, { id: "bad", name: "fail", arguments: "{}" }]), response("done")]);
  const events: AgentEvent[] = [];
  const agent = new Agent({ llm: fake.llm, tools: [tool("large", async () => ({ content: large, isError: false })), tool("fail", async () => ({ content: "precise failure details", isError: true }))], systemPrompt: "r", rootDir: "/p", onEvent: (event) => events.push(event) });
  await agent.run("go");
  const ends = events.filter((event) => event.type === "tool_end");
  assert.deepEqual(ends, [
    { type: "tool_end", turn: 1, toolCallId: "ok", toolName: "large", isError: false, message: "completed" },
    { type: "tool_end", turn: 1, toolCallId: "bad", toolName: "fail", isError: true, message: "precise failure details" }
  ]);
  assert(!JSON.stringify(events).includes(large));
});

test("serializes null and undefined tool content safely", async () => {
  const fake = fakeLLM([response(null, [{ id: "null", name: "null", arguments: "{}" }, { id: "undefined", name: "undefined", arguments: "{}" }]), response("done")]);
  const agent = new Agent({ llm: fake.llm, tools: [tool("null", async () => ({ content: null, isError: false })), tool("undefined", async () => ({ content: undefined, isError: false }))], systemPrompt: "rules", rootDir: "/p" });
  await agent.run("go");
  assert.deepEqual(fake.requests[1].filter((message) => message.role === "tool").map((message) => (message as { content: string }).content), ["", ""]);
});

test("Tool history breadcrumbs retain full content during a run then compact persistent history", async () => {
  const full = "FULL_REPO_MAP_".repeat(1000);
  const breadcrumb = "Repo map candidates: src/llm.ts; map truncated: no";
  const fake = fakeLLM([response(null, [{ id: "map", name: "map", arguments: "{}" }]), response("done")]);
  const agent = new Agent({ llm: fake.llm, tools: [tool("map", async () => ({ content: full, historyContent: breadcrumb, isError: false }))], systemPrompt: "rules", rootDir: "/p" });
  const result = await agent.run("find provider");
  assert.equal((fake.requests[1].at(-1) as { content: string }).content, full);
  assert.equal((result.messages.find((message) => message.role === "tool") as { content: string }).content, breadcrumb);
  assert.equal((agent.history().find((message) => message.role === "tool") as { content: string }).content, breadcrumb);
});

test("Tool history breadcrumbs cap Unicode safely and ignore malformed replacements", async () => {
  for (const historyContent of ["😀".repeat(600), 12 as unknown as string]) {
    const fake = fakeLLM([response(null, [{ id: "map", name: "map", arguments: "{}" }]), response("done")]);
    const agent = new Agent({ llm: fake.llm, tools: [tool("map", async () => ({ content: "full", historyContent, isError: false }))], systemPrompt: "rules", rootDir: "/p" });
    const result = await agent.run("x");
    const retained = (result.messages.find((message) => message.role === "tool") as { content: string }).content;
    if (typeof historyContent === "string") { assert.equal([...retained].length, 512); assert(!retained.endsWith("�")); }
    else assert.equal(retained, "full");
  }
});

test("transient context reaches every request but never persistent history", async () => {
  const fake = fakeLLM([response(null, [{ id: "read", name: "noop", arguments: "{}" }]), response("done"), response("second")]);
  const agent = new Agent({ llm: fake.llm, tools: [tool("noop", async () => ({ content: "ok", isError: false }))], systemPrompt: "rules", rootDir: "/project" });
  const result = await agent.run("find provider", { transientContext: "REPO MAP\nsrc/llm.ts" });
  for (const request of fake.requests.slice(0, 2)) assert.deepEqual(request.slice(0, 2), [
    { role: "system", content: "rules" },
    { role: "system", content: "Current-run repository navigation context:\nREPO MAP\nsrc/llm.ts" }
  ]);
  assert(!JSON.stringify(result.messages).includes("REPO MAP"));
  assert(!JSON.stringify(agent.history()).includes("REPO MAP"));
  await agent.run("second question", { transientContext: "SECOND MAP" });
  assert(JSON.stringify(fake.requests[2]).includes("SECOND MAP"));
  assert(!JSON.stringify(fake.requests[2]).includes("REPO MAP"));
});

test("transient context ignores whitespace and rejects content above its hard limit", async () => {
  const fake = fakeLLM([response("plain")]);
  const agent = new Agent({ llm: fake.llm, tools: [], systemPrompt: "rules", rootDir: "/project" });
  await agent.run("plain", { transientContext: "  \n" });
  assert.deepEqual(fake.requests[0], [{ role: "system", content: "rules" }, { role: "user", content: "plain" }]);
  await assert.rejects(() => agent.run("too large", { transientContext: "x".repeat(8_001) }), /8,000/);
  assert(!agent.history().some((message) => message.content === "too large"));
});

test("transports a safe provider diagnostic through the model error event", async () => {
  const failure = new ProviderDiagnostic({ provider: "deepseek", level: "warning", kind: "rate_limit", message: "DeepSeek 请求受限", reason: "当前请求被限流、余额或并发限制。", advice: "稍后重试，或切换模型 / Provider。", status: 429, code: "rate_limit", requestId: "req_2" });
  const fake = fakeLLM([failure]);
  const events: AgentEvent[] = [];
  const agent = new Agent({ llm: fake.llm, tools: [], systemPrompt: "rules", rootDir: "/p", onEvent: (event) => events.push(event) });
  await assert.rejects(() => agent.run("go"), /DeepSeek 请求受限/);
  const event = events.find((item) => item.type === "error");
  assert.deepEqual(event, { type: "error", stage: "model", turn: 1, message: "DeepSeek 请求受限", diagnostic: failure });
});
