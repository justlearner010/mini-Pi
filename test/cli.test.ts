import assert from "node:assert/strict";
import test from "node:test";

import { parseArgs, validateOptions } from "../src/cli.js";
import { formatEvent, parseCommand } from "../src/tui.js";

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
