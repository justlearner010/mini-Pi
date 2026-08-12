import assert from "node:assert/strict";
import test from "node:test";

import { createLLM, listModels, ProviderDiagnostic, type ProviderClient } from "../src/llm.js";

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
  await assert.rejects(() => createLLM({ provider: "openai", model: "x", apiKey: "secret" }, failing).generate([], []), (error: unknown) => error instanceof ProviderDiagnostic && error.kind === "unknown");
  const rejected = fakeClient({});
  rejected.chat.completions.create = async () => { throw new Error("key secret was rejected"); };
  await assert.rejects(() => createLLM({ provider: "openai", model: "x", apiKey: "secret" }, rejected).generate([], []), (error: Error) => !error.message.includes("secret") && /Provider 请求失败/.test(error.message));
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

test("classifies provider failures without retaining unsafe exception text", async () => {
  const leaked = "sk-secret Authorization: Bearer token request-body=file content tool-body response-body stack trace";
  const rejected = fakeClient({});
  rejected.chat.completions.create = async () => { throw Object.assign(new Error(leaked), { status: 401, code: "invalid_api_key", request_id: "req_1", requestId: "sk-secret" }); };
  await assert.rejects(() => createLLM({ provider: "deepseek", model: "x", apiKey: "secret" }, rejected).generate([], []), (error: unknown) => {
    assert(error instanceof ProviderDiagnostic);
    assert.deepEqual({ level: error.level, kind: error.kind, provider: error.provider, status: error.status, code: error.code, requestId: error.requestId }, { level: "error", kind: "authentication", provider: "deepseek", status: 401, code: "invalid_api_key", requestId: undefined });
    assert(!JSON.stringify(error).includes(leaked));
    return true;
  });
});

test("classifies every safe provider failure category", async () => {
  const cases = [
    [{ status: 403 }, "permission", "error"], [{ status: 404 }, "model", "warning"], [{ status: 429 }, "rate_limit", "warning"],
    [{ status: 503 }, "provider", "warning"], [{ code: "ETIMEDOUT" }, "network", "warning"], [{ code: "OTHER" }, "unknown", "warning"]
  ] as const;
  for (const [properties, kind, level] of cases) {
    const rejected = fakeClient({});
    rejected.chat.completions.create = async () => { throw Object.assign(new Error("unsafe secret response text"), properties); };
    await assert.rejects(() => createLLM({ provider: "openai", model: "x", apiKey: "secret" }, rejected).generate([], []), (error: unknown) => error instanceof ProviderDiagnostic && error.kind === kind && error.level === level);
  }
});

test("drops untrusted provider debug strings and diagnoses malformed responses", async () => {
  const rejected = fakeClient({});
  rejected.chat.completions.create = async () => { throw Object.assign(new Error("failure"), { status: 401, code: "api_key_SECRET", request_id: "token-super-secret" }); };
  await assert.rejects(() => createLLM({ provider: "openai", model: "x", apiKey: "secret" }, rejected).generate([], []), (error: unknown) => error instanceof ProviderDiagnostic && error.code === undefined && error.requestId === undefined);
  await assert.rejects(() => createLLM({ provider: "openai", model: "x", apiKey: "secret" }, fakeClient({ choices: [] })).generate([], []), (error: unknown) => error instanceof ProviderDiagnostic && error.kind === "unknown" && /无法分类/.test(error.reason));
});
