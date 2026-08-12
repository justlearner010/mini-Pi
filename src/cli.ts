#!/usr/bin/env node
import { parseArgs as nodeParseArgs } from "node:util";
import { realpath, stat } from "node:fs/promises";
import { resolve } from "node:path";

import { Agent, type AgentEvent } from "./agent.js";
import { createLLM, listModels, type ProviderName } from "./llm.js";
import { tools } from "./tool.js";
import { chooseModel, chooseProvider, formatEvent, startTui } from "./tui.js";

export type CliOptions = { project: string; provider?: ProviderName; model?: string; prompt?: string; help: boolean; version: boolean };
export type ValidatedOptions = CliOptions & { rootDir?: string; apiKey?: string; error?: string };
export type InteractiveDeps = { chooseProvider: () => Promise<ProviderName>; chooseModel: (models: string[]) => Promise<string>; listModels: (provider: ProviderName, key: string) => Promise<string[]> };

export function exitCodeFor(error: unknown): number {
  return (error as { name?: string })?.name === "ExitPromptError" ? 130 : 1;
}

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

export const SYSTEM_PROMPT = `You are mini-Pi, a read-only codebase analysis agent.

Use tools to gather evidence before making claims about a project.
Do not claim that you inspected a file unless its contents or dependency
data were returned by a tool.

When first exploring an unfamiliar project:
1. Use scan_project to understand its structure.
2. If a README exists, read it early to learn the intended design.
3. Treat documentation as context, not proof. Verify important claims
   against configuration, source files, and dependency data.
4. Use analyze_dependencies to inspect actual TS/JS import relationships.
5. Use read_file only for files relevant to the user's question.

Never request paths outside the selected project.
Do not modify files or execute shell commands.

Clearly distinguish:
- internal dependencies;
- Node.js built-in modules;
- external packages;
- unresolved dependencies;
- unsupported files;
- circular dependencies.

If a tool result is truncated or incomplete, say so and narrow the
analysis scope when possible.

Answer in the user's language.
For full-project analysis, include:
- a short project overview;
- the directory structure;
- important entry points;
- the dependency structure;
- cycles, unresolved imports, unsupported files, and limitations.`;
function usage(): string { return "Usage: mini-pi [project] [--provider openai|deepseek --model MODEL] [--prompt TEXT]\n\nKeys: OPENAI_API_KEY or DEEPSEEK_API_KEY (environment only)."; }
function makeAgent(options: Required<Pick<ValidatedOptions, "provider" | "model" | "apiKey" | "rootDir">>, onEvent: (event: AgentEvent) => void): Agent {
  return new Agent({ llm: createLLM({ provider: options.provider, model: options.model, apiKey: options.apiKey }), tools, rootDir: options.rootDir, systemPrompt: SYSTEM_PROMPT, onEvent });
}

export async function completeInteractiveOptions(valid: ValidatedOptions, deps: InteractiveDeps = { chooseProvider, chooseModel, listModels }): Promise<ValidatedOptions> {
  const provider = valid.provider ?? await deps.chooseProvider();
  const refreshed = provider === valid.provider ? valid : await validateOptions({ ...valid, provider }, process.env, valid.rootDir);
  if (refreshed.error || refreshed.model) return refreshed;
  try {
    const models = await deps.listModels(provider, refreshed.apiKey!);
    if (!models.length) throw new Error("empty");
    return { ...refreshed, model: await deps.chooseModel(models) };
  } catch { return { ...refreshed, error: "Unable to list models; pass --model to specify one manually" }; }
}

export async function run(args = process.argv.slice(2), env = process.env, cwd = process.cwd()): Promise<number> {
  let options: CliOptions;
  try { options = parseArgs(args); } catch (error) { console.error(error instanceof Error ? error.message : "Invalid arguments"); return 1; }
  if (options.help) { console.log(usage()); return 0; }
  if (options.version) { console.log("mini-pi 0.1.0"); return 0; }
  let valid = await validateOptions(options, env, cwd);
  if (valid.error) { console.error(valid.error); return 1; }
  try {
    if (!valid.provider || !valid.model) valid = await completeInteractiveOptions(valid, { chooseProvider, chooseModel, listModels });
  } catch (error) { return exitCodeFor(error); }
  if (valid.error) { console.error(valid.error); return 1; }
  const agent = makeAgent(valid as Required<Pick<ValidatedOptions, "provider" | "model" | "apiKey" | "rootDir">>, (event) => { const text = formatEvent(event); if (text) console.log(text); });
  if (valid.prompt) { try { console.log((await agent.run(valid.prompt)).answer); return 0; } catch { return 1; } }
  return startTui(agent, { project: valid.rootDir!, provider: valid.provider!, model: valid.model! });
}

if (import.meta.url === `file://${process.argv[1]}`) run().then((code) => { process.exitCode = code; });
