import assert from "node:assert/strict";
import test from "node:test";

import { completeInteractiveOptions, exitCodeFor, parseArgs, SYSTEM_PROMPT, validateOptions } from "../src/cli.js";
import { formatEvent, helpText, parseCommand } from "../src/tui.js";

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
  assert.match(key.error ?? "", /DEEPSEEK_API_KEY/);
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
  assert.deepEqual(parseCommand(""), { type: "empty" });
  assert.deepEqual(parseCommand("/wat"), { type: "unknown", command: "/wat" });
  assert.deepEqual(parseCommand("inspect src"), { type: "prompt", prompt: "inspect src" });
});

test("agent events format without leaking full tool content", () => {
  assert.equal(formatEvent({ type: "model_start", turn: 2 }), "Thinking (turn 2)...");
  assert.equal(formatEvent({ type: "tool_end", turn: 1, toolCallId: "x", toolName: "read_file", isError: false, message: "completed" }), "✓ read_file");
  assert.equal(formatEvent({ type: "error", stage: "model", message: "Model request failed" }), "Error: Model request failed");
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

test("help identifies the active project provider and model, and system prompt is exact", () => {
  assert.match(helpText("/project", "openai", "gpt"), /Project: \/project/);
  assert.match(helpText("/project", "openai", "gpt"), /Provider: openai/);
  assert.match(helpText("/project", "openai", "gpt"), /Model: gpt/);
  assert.match(SYSTEM_PROMPT, /Use tools to gather evidence before making claims/);
  assert.match(SYSTEM_PROMPT, /Answer in the user's language/);
});

test("prompt cancellation maps to the conventional Ctrl+C exit status", () => {
  assert.equal(exitCodeFor({ name: "ExitPromptError" }), 130);
  assert.equal(exitCodeFor(new Error("other")), 1);
});
