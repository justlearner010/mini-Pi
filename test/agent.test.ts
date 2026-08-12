import assert from "node:assert/strict";
import test from "node:test";

import { Agent, type AgentEvent } from "../src/agent.js";
import type { LLMClient, Message, ModelResponse } from "../src/llm.js";
import type { Tool } from "../src/tool.js";

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
  return { name, description: name, parameters: { type: "object" }, execute };
}

test("returns a direct answer and retains shared history", async () => {
  const fake = fakeLLM([response("first"), response("second")]);
  const agent = new Agent({ llm: fake.llm, tools: [], systemPrompt: "rules", rootDir: "/project" });
  assert.equal(await agent.run("one"), "first");
  assert.equal(await agent.run("two"), "second");
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
  assert.equal(await agent.run("go"), "done");
  assert.deepEqual(calls, ['first:{"n":1}:/project', 'second:{"n":2}']);
  assert.deepEqual(fake.requests[1].slice(-3), [
    { role: "assistant", content: null, toolCalls: [{ id: "a", name: "first", arguments: '{"n":1}' }, { id: "b", name: "second", arguments: '{"n":2}' }] },
    { role: "tool", toolCallId: "a", content: "A" }, { role: "tool", toolCallId: "b", content: '{"value":"B"}' }
  ]);
});

test("recovers from unknown tools, malformed arguments, and tool failures", async () => {
  const fake = fakeLLM([
    response(null, [{ id: "unknown", name: "nope", arguments: "{}" }, { id: "bad", name: "ok", arguments: "{" }, { id: "fail", name: "broken", arguments: "{}" }]), response("recovered")
  ]);
  const agent = new Agent({ llm: fake.llm, tools: [tool("ok", async () => ({ content: "ok", isError: false })), tool("broken", async () => { throw new Error("private failure"); })], systemPrompt: "rules", rootDir: "/project" });
  assert.equal(await agent.run("go"), "recovered");
  const results = fake.requests[1].filter((message) => message.role === "tool");
  assert.equal(results.length, 3);
  assert(results.every((message) => message.role === "tool" && /error/i.test(message.content)));
});

test("emits lifecycle events including tool events", async () => {
  const fake = fakeLLM([response(null, [{ id: "x", name: "echo", arguments: "{}" }]), response("done")]);
  const events: AgentEvent[] = [];
  const agent = new Agent({ llm: fake.llm, tools: [tool("echo", async () => ({ content: "yes", isError: false }))], systemPrompt: "rules", rootDir: "/project", onEvent: (event) => events.push(event) });
  await agent.run("go");
  assert.deepEqual(events.map((event) => event.type), ["agent_start", "model_start", "model_end", "tool_start", "tool_end", "model_start", "model_end", "agent_end"]);
});

test("allows final answer on maxTurns and rejects only when another model call is needed", async () => {
  const seven = fakeLLM(Array.from({ length: 7 }, (_, i) => response(i === 6 ? "done" : null, i === 6 ? [] : [{ id: String(i), name: "noop", arguments: "{}" }])));
  const eight = fakeLLM(Array.from({ length: 8 }, (_, i) => response(i === 7 ? "done" : null, i === 7 ? [] : [{ id: String(i), name: "noop", arguments: "{}" }])));
  const nine = fakeLLM(Array.from({ length: 8 }, (_, i) => response(null, [{ id: String(i), name: "noop", arguments: "{}" }])));
  const config = (llm: LLMClient, onEvent?: (event: AgentEvent) => void) => new Agent({ llm, tools: [tool("noop", async () => ({ content: "", isError: false }))], systemPrompt: "r", rootDir: "/p", maxTurns: 8, onEvent });
  assert.equal(await config(seven.llm).run("x"), "done");
  assert.equal(await config(eight.llm).run("x"), "done");
  const events: AgentEvent[] = [];
  await assert.rejects(() => config(nine.llm, (event) => events.push(event)).run("x"), /maximum turns/i);
  assert.equal(nine.requests.length, 8);
  assert.deepEqual(events.slice(-2).map((event) => event.type), ["error", "agent_end"]);
});

test("reset restores only the system prompt and provider failures rollback a run", async () => {
  const fake = fakeLLM([response("saved"), new Error("secret exposed"), response("fresh")]);
  const events: AgentEvent[] = [];
  const agent = new Agent({ llm: fake.llm, tools: [], systemPrompt: "rules", rootDir: "/p", onEvent: (event) => events.push(event) });
  await agent.run("keep");
  await assert.rejects(() => agent.run("rollback"), /Model request failed/);
  assert.deepEqual(fake.requests[1].at(-1), { role: "user", content: "rollback" });
  agent.reset();
  assert.equal(await agent.run("new"), "fresh");
  assert.deepEqual(fake.requests[2], [{ role: "system", content: "rules" }, { role: "user", content: "new" }]);
  assert(events.some((event) => event.type === "error"));
});
