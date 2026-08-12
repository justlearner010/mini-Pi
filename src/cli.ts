#!/usr/bin/env node
import { parseArgs as nodeParseArgs } from "node:util";
import { realpath, stat } from "node:fs/promises";
import { resolve } from "node:path";

import { Agent, type AgentEvent } from "./agent.js";
import { createLLM, type ProviderName } from "./llm.js";
import { tools } from "./tool.js";
import { chooseModel, chooseProvider, formatEvent, startTui } from "./tui.js";

export type CliOptions = { project: string; provider?: ProviderName; model?: string; prompt?: string; help: boolean; version: boolean };
export type ValidatedOptions = CliOptions & { rootDir?: string; apiKey?: string; error?: string };

export function parseArgs(args: string[]): CliOptions {
  let values: { provider?: string; model?: string; prompt?: string; help?: boolean; version?: boolean }, positionals: string[];
  try { ({ values, positionals } = nodeParseArgs({ args, options: { provider: { type: "string" }, model: { type: "string" }, prompt: { type: "string" }, help: { type: "boolean", short: "h" }, version: { type: "boolean", short: "v" } }, allowPositionals: true, strict: true })); }
  catch (error) { throw new Error(error instanceof Error ? error.message : "Invalid arguments"); }
  if (positionals.length > 1) throw new Error("Specify at most one project directory");
  if (values.provider && values.provider !== "openai" && values.provider !== "deepseek") throw new Error("Provider must be openai or deepseek");
  return { project: positionals[0] ?? ".", provider: values.provider as ProviderName | undefined, model: values.model, prompt: values.prompt, help: values.help ?? false, version: values.version ?? false };
}

export async function validateOptions(options: CliOptions, env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): Promise<ValidatedOptions> {
  let rootDir: string;
  try {
    rootDir = await realpath(resolve(cwd, options.project));
    if (!(await stat(rootDir)).isDirectory()) throw new Error("not a directory");
  }
  catch { return { ...options, error: `Project directory not found: ${options.project}` }; }
  if (options.prompt && (!options.provider || !options.model)) return { ...options, rootDir, error: "--prompt requires both --provider and --model" };
  if (options.provider) {
    const name = options.provider === "openai" ? "OPENAI_API_KEY" : "DEEPSEEK_API_KEY";
    const apiKey = env[name];
    if (!apiKey) return { ...options, rootDir, error: `Missing ${name} in environment` };
    return { ...options, rootDir, apiKey };
  }
  return { ...options, rootDir };
}

const SYSTEM_PROMPT = "You are mini-Pi, a read-only assistant for exploring this TypeScript/JavaScript project. Use tools when needed and explain findings concisely.";
function usage(): string { return "Usage: mini-pi [project] [--provider openai|deepseek --model MODEL] [--prompt TEXT]\n\nKeys: OPENAI_API_KEY or DEEPSEEK_API_KEY (environment only)."; }
function makeAgent(options: Required<Pick<ValidatedOptions, "provider" | "model" | "apiKey" | "rootDir">>, onEvent: (event: AgentEvent) => void): Agent {
  return new Agent({ llm: createLLM({ provider: options.provider, model: options.model, apiKey: options.apiKey }), tools, rootDir: options.rootDir, systemPrompt: SYSTEM_PROMPT, onEvent });
}

export async function run(args = process.argv.slice(2), env = process.env, cwd = process.cwd()): Promise<number> {
  let options: CliOptions;
  try { options = parseArgs(args); } catch (error) { console.error(error instanceof Error ? error.message : "Invalid arguments"); return 2; }
  if (options.help) { console.log(usage()); return 0; }
  if (options.version) { console.log("mini-pi 0.1.0"); return 0; }
  let valid = await validateOptions(options, env, cwd);
  if (valid.error) { console.error(valid.error); return 2; }
  if (!valid.provider) {
    const provider = await chooseProvider(); const model = await chooseModel(provider);
    valid = await validateOptions({ ...options, provider, model }, env, cwd);
    if (valid.error) { console.error(valid.error); return 2; }
  }
  const agent = makeAgent(valid as Required<Pick<ValidatedOptions, "provider" | "model" | "apiKey" | "rootDir">>, (event) => { const text = formatEvent(event); if (text) console.log(text); });
  if (valid.prompt) { try { console.log((await agent.run(valid.prompt)).answer); return 0; } catch { return 1; } }
  await startTui(agent);
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) run().then((code) => { process.exitCode = code; });
