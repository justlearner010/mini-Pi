import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  completeInteractiveOptions,
  createSystemCredentialStore,
  loginWithCredentialStore,
  logoutFromCredentialStore,
  exitCodeFor,
  getStartupSelection,
  parseArgs,
  readGlobalPreference,
  resolveApiKey,
  selectAndSaveModel,
  saveGlobalPreference,
  SYSTEM_PROMPT,
  type CredentialStore,
  validateOptions
} from "../src/cli.js";
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
