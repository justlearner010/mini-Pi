import assert from "node:assert/strict";
import test from "node:test";

import { createLLM, listModels, type ProviderClient } from "../src/llm.js";

function fakeClient(reply: unknown, models: string[] = ["z", "a", "z"]): ProviderClient & { requests: unknown[] } {
  const requests: unknown[] = [];
  return {
    requests,
    chat: { completions: { create: async (request: unknown) => { requests.push(request); return reply; } } },
    models: { list: async () => ({ data: models.map((id) => ({ id })) }) }
  };
}

const tools = [{ name: "read_file", description: "Read", parameters: { type: "object" }, execute: async () => ({ content: "", isError: false }) }];

test("generate converts every message role, tools, null content, and multiple tool calls", async () => {
  const client = fakeClient({ choices: [{ message: { content: null, tool_calls: [
    { id: "call_1", type: "function", function: { name: "read_file", arguments: "{bad" } },
    { id: "call_2", type: "function", function: { name: "read_file", arguments: "{}" } }
  ] } }] });
  const llm = createLLM({ provider: "openai", model: "gpt-test", apiKey: "secret" }, client);
  const result = await llm.generate([
    { role: "system", content: "rules" },
    { role: "user", content: "read it" },
    { role: "assistant", content: null, toolCalls: [{ id: "old", name: "read_file", arguments: "{}" }] },
    { role: "tool", toolCallId: "old", content: "file contents" }
  ], tools);
  assert.deepEqual(result, { message: { role: "assistant", content: null, toolCalls: [
    { id: "call_1", name: "read_file", arguments: "{bad" }, { id: "call_2", name: "read_file", arguments: "{}" }
  ] } });
  assert.deepEqual(client.requests, [{ model: "gpt-test", messages: [
    { role: "system", content: "rules" }, { role: "user", content: "read it" },
    { role: "assistant", content: null, tool_calls: [{ id: "old", type: "function", function: { name: "read_file", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "old", content: "file contents" }
  ], tools: [{ type: "function", function: { name: "read_file", description: "Read", parameters: { type: "object" } } }] }]);
});

test("generate returns a safe error for provider failures and malformed empty responses", async () => {
  const failing = fakeClient({ choices: [] });
  await assert.rejects(() => createLLM({ provider: "openai", model: "x", apiKey: "secret" }, failing).generate([], []), /Provider returned no choices/);
  const rejected = fakeClient({});
  rejected.chat.completions.create = async () => { throw new Error("key secret was rejected"); };
  await assert.rejects(() => createLLM({ provider: "openai", model: "x", apiKey: "secret" }, rejected).generate([], []), (error: Error) => !error.message.includes("secret") && /Provider request failed/.test(error.message));
});

test("listModels sorts and deduplicates ids and reports safe provider errors", async () => {
  assert.deepEqual(await listModels("openai", "secret", fakeClient({}, ["z", "a", "z"])), ["a", "z"]);
  const rejected = fakeClient({});
  rejected.models.list = async () => { throw new Error("secret denied"); };
  await assert.rejects(() => listModels("openai", "secret", rejected), (error: Error) => !error.message.includes("secret") && /Unable to list models/.test(error.message));
});

test("DeepSeek requests disable thinking explicitly", async () => {
  const client = fakeClient({ choices: [{ message: { content: "ok", tool_calls: [] } }] });
  await createLLM({ provider: "deepseek", model: "deepseek-chat", apiKey: "secret" }, client).generate([{ role: "user", content: "hi" }], []);
  assert.deepEqual(client.requests, [{ model: "deepseek-chat", messages: [{ role: "user", content: "hi" }], tools: [], extra_body: { thinking: { type: "disabled" } } }]);
});
