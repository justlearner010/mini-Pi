#!/usr/bin/env node
import { parseArgs as nodeParseArgs } from "node:util";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { Agent, type AgentEvent } from "./agent.js";
import { createLLM, listModels, type ProviderName } from "./llm.js";
import { tools } from "./tool.js";
import { askApiKey, chooseModel, chooseProvider, chooseStoredProvider, formatEvent, startTui, type TuiSession } from "./tui.js";

export type CliOptions = { project: string; provider?: ProviderName; model?: string; prompt?: string; help: boolean; version: boolean };
export type ValidatedOptions = CliOptions & { rootDir?: string; apiKey?: string; error?: string };
export type InteractiveDeps = { chooseProvider: () => Promise<ProviderName>; chooseModel: (models: string[]) => Promise<string>; listModels: (provider: ProviderName, key: string) => Promise<string[]> };
export type OnboardingDeps = InteractiveDeps & { credentials: CredentialStore; askApiKey: () => Promise<string>; savePreference: (preference: GlobalPreference) => Promise<void> };
export interface CredentialStore {
  getPassword(service: string, account: string): Promise<string | null>;
  setPassword(service: string, account: string, password: string): Promise<void>;
  deletePassword(service: string, account: string): Promise<boolean>;
}
export type GlobalPreference = { provider: ProviderName; model: string };
export type KeySource = "environment" | "credential-store";
export type StartupSelection = GlobalPreference & { apiKey: string; keySource: KeySource };
export const CREDENTIAL_SERVICE = "mini-Pi";
export function debugEnabled(env: NodeJS.ProcessEnv = process.env): boolean { return env.MINI_PI_DEBUG === "1"; }
const require = createRequire(import.meta.url);

export function createSystemCredentialStore(load: () => CredentialStore = () => require("@github/keytar") as CredentialStore): CredentialStore {
  let store: CredentialStore | undefined;
  const getStore = (): CredentialStore => store ??= load();
  return {
    getPassword: (service, account) => getStore().getPassword(service, account),
    setPassword: (service, account, password) => getStore().setPassword(service, account, password),
    deletePassword: (service, account) => getStore().deletePassword(service, account)
  };
}
export const systemCredentials = createSystemCredentialStore();

function environmentName(provider: ProviderName): "OPENAI_API_KEY" | "DEEPSEEK_API_KEY" {
  return provider === "openai" ? "OPENAI_API_KEY" : "DEEPSEEK_API_KEY";
}

export function defaultConfigPath(home = homedir()): string {
  return join(home, ".mini-pi", "config.json");
}

function isPreference(value: unknown): value is GlobalPreference {
  const item = value as { provider?: unknown; model?: unknown };
  return typeof value === "object" && value !== null && Object.keys(value).length === 2 && Object.keys(value).every((key) => key === "provider" || key === "model")
    && (item.provider === "openai" || item.provider === "deepseek") && typeof item.model === "string" && item.model.length > 0;
}

function hasPreferenceFields(value: unknown): value is GlobalPreference {
  const item = value as { provider?: unknown; model?: unknown };
  return typeof value === "object" && value !== null && (item.provider === "openai" || item.provider === "deepseek")
    && typeof item.model === "string" && item.model.length > 0;
}

export async function readGlobalPreference(configPath = defaultConfigPath()): Promise<GlobalPreference | undefined> {
  try {
    const value: unknown = JSON.parse(await readFile(configPath, "utf8"));
    return isPreference(value) ? value : undefined;
  } catch { return undefined; }
}

export async function saveGlobalPreference(preference: GlobalPreference, configPath = defaultConfigPath()): Promise<void> {
  if (!hasPreferenceFields(preference)) throw new Error("Invalid global preference");
  const directory = dirname(configPath);
  const temporary = `${configPath}.${randomUUID()}.tmp`;
  try {
    await mkdir(directory, { recursive: true });
    await writeFile(temporary, `${JSON.stringify({ provider: preference.provider, model: preference.model })}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, configPath);
  } catch {
    throw new Error("Unable to save global preference");
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}
export async function clearGlobalPreference(configPath = defaultConfigPath()): Promise<void> { try { await unlink(configPath); } catch (error) { if ((error as { code?: string }).code !== "ENOENT") throw error; } }

export async function resolveApiKey(provider: ProviderName, credentials: CredentialStore, env: NodeJS.ProcessEnv = process.env): Promise<{ apiKey: string; source: KeySource } | undefined> {
  const environmentKey = env[environmentName(provider)];
  if (environmentKey) return { apiKey: environmentKey, source: "environment" };
  try {
    const apiKey = await credentials.getPassword(CREDENTIAL_SERVICE, provider);
    return apiKey ? { apiKey, source: "credential-store" } : undefined;
  } catch { return undefined; }
}

export async function getStartupSelection(credentials: CredentialStore = systemCredentials, configPath = defaultConfigPath(), env: NodeJS.ProcessEnv = process.env): Promise<StartupSelection | undefined> {
  const preference = await readGlobalPreference(configPath);
  if (!preference) return undefined;
  const key = await resolveApiKey(preference.provider, credentials, env);
  return key && { ...preference, apiKey: key.apiKey, keySource: key.source };
}

export async function loginWithCredentialStore(deps: OnboardingDeps): Promise<StartupSelection> {
  const provider = await deps.chooseProvider();
  const apiKey = await deps.askApiKey();
  if (!apiKey) throw new Error("API key cannot be empty");
  const models = await deps.listModels(provider, apiKey);
  if (!models.length) throw new Error("No models are available for this provider");
  const model = await deps.chooseModel(models);
  const oldKey = await deps.credentials.getPassword(CREDENTIAL_SERVICE, provider);
  await deps.credentials.setPassword(CREDENTIAL_SERVICE, provider, apiKey);
  try { await deps.savePreference({ provider, model }); }
  catch (error) { oldKey ? await deps.credentials.setPassword(CREDENTIAL_SERVICE, provider, oldKey) : await deps.credentials.deletePassword(CREDENTIAL_SERVICE, provider); throw error; }
  return { provider, model, apiKey, keySource: "credential-store" };
}

export async function selectAndSaveModel(preference: GlobalPreference, apiKey: string, deps: Pick<OnboardingDeps, "listModels" | "chooseModel" | "savePreference">): Promise<GlobalPreference> {
  const models = await deps.listModels(preference.provider, apiKey);
  if (!models.length) throw new Error("No models are available for this provider");
  const next = { provider: preference.provider, model: await deps.chooseModel(models) };
  await deps.savePreference(next);
  return next;
}

export async function logoutFromCredentialStore(credentials: CredentialStore, preference: GlobalPreference | undefined, choose: (providers: ProviderName[]) => Promise<ProviderName>, clearPreference: () => Promise<void>): Promise<ProviderName | undefined> {
  const providers = (await Promise.all((['openai', 'deepseek'] as ProviderName[]).map(async (provider) => (await credentials.getPassword(CREDENTIAL_SERVICE, provider)) ? provider : undefined))).filter((value): value is ProviderName => Boolean(value));
  if (!providers.length) return undefined;
  const provider = await choose(providers);
  await credentials.deletePassword(CREDENTIAL_SERVICE, provider);
  if (preference?.provider === provider) await clearPreference();
  return provider;
}

export function exitCodeFor(error: unknown): number {
  const failure = error as { name?: string; code?: string };
  return failure?.name === "ExitPromptError" || failure?.name === "AbortPromptError" || failure?.code === "SIGINT" ? 130 : 1;
}

export function parseArgs(args: string[]): CliOptions {
  let values: { provider?: string; model?: string; prompt?: string; help?: boolean; version?: boolean }, positionals: string[];
  try { ({ values, positionals } = nodeParseArgs({ args, options: { provider: { type: "string" }, model: { type: "string" }, prompt: { type: "string" }, help: { type: "boolean", short: "h" }, version: { type: "boolean", short: "v" } }, allowPositionals: true, strict: true })); }
  catch (error) { throw new Error(error instanceof Error ? error.message : "Invalid arguments"); }
  if (positionals.length > 1) throw new Error("Specify at most one project directory");
  if (values.provider && values.provider !== "openai" && values.provider !== "deepseek") throw new Error("Provider must be openai or deepseek");
  return { project: positionals[0] ?? ".", provider: values.provider as ProviderName | undefined, model: values.model, prompt: values.prompt, help: values.help ?? false, version: values.version ?? false };
}

export async function validateOptions(options: CliOptions, env: NodeJS.ProcessEnv = process.env, cwd = process.cwd(), credentials?: CredentialStore): Promise<ValidatedOptions> {
  let rootDir: string;
  try {
    rootDir = await realpath(resolve(cwd, options.project));
    if (!(await stat(rootDir)).isDirectory()) throw new Error("not a directory");
  }
  catch { return { ...options, error: `Project directory not found: ${options.project}` }; }
  if (options.prompt && (!options.provider || !options.model)) return { ...options, rootDir, error: "--prompt requires both --provider and --model" };
  if (options.provider) {
    const key = credentials ? await resolveApiKey(options.provider, credentials, env) : env[environmentName(options.provider)] ? { apiKey: env[environmentName(options.provider)]!, source: "environment" as const } : undefined;
    if (!key) return { ...options, rootDir, error: `No saved API key for ${options.provider}; run mini-pi without options to log in` };
    return { ...options, rootDir, apiKey: key.apiKey };
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
function usage(): string { return "Usage: mini-pi [project] [--provider openai|deepseek --model MODEL] [--prompt TEXT]\n\nKeys: environment variables or secure system credential storage."; }
function makeAgent(options: Required<Pick<ValidatedOptions, "provider" | "model" | "apiKey" | "rootDir">>, onEvent: (event: AgentEvent) => void): Agent {
  return new Agent({ llm: createLLM({ provider: options.provider, model: options.model, apiKey: options.apiKey }), tools, rootDir: options.rootDir, systemPrompt: SYSTEM_PROMPT, onEvent });
}

export async function completeInteractiveOptions(valid: ValidatedOptions, deps: InteractiveDeps = { chooseProvider, chooseModel, listModels }, env: NodeJS.ProcessEnv = process.env, credentials?: CredentialStore): Promise<ValidatedOptions> {
  const provider = valid.provider ?? await deps.chooseProvider();
  const refreshed = provider === valid.provider ? valid : await validateOptions({ ...valid, provider }, env, valid.rootDir, credentials);
  if (refreshed.error || refreshed.model) return refreshed;
  try {
    const models = await deps.listModels(provider, refreshed.apiKey!);
    if (!models.length) throw new Error("empty");
    return { ...refreshed, model: await deps.chooseModel(models) };
  } catch (error) {
    if (exitCodeFor(error) === 130) throw error;
    return { ...refreshed, error: "Unable to list models; pass --model to specify one manually" };
  }
}

export async function run(args = process.argv.slice(2), env = process.env, cwd = process.cwd()): Promise<number> {
  let options: CliOptions;
  try { options = parseArgs(args); } catch (error) { console.error(error instanceof Error ? error.message : "Invalid arguments"); return 1; }
  if (options.help) { console.log(usage()); return 0; }
  if (options.version) { console.log("mini-pi 0.1.0"); return 0; }
  let valid = await validateOptions(options, env, cwd, systemCredentials);
  if (valid.error) { console.error(valid.error); return 1; }
  try {
    if (!valid.provider && !valid.model && !valid.prompt) {
      const saved = await getStartupSelection(systemCredentials, defaultConfigPath(), env);
      valid = saved ? { ...valid, ...saved } : { ...valid, ...(await loginWithCredentialStore({ credentials: systemCredentials, chooseProvider, chooseModel, askApiKey, listModels, savePreference: saveGlobalPreference })) };
    } else if (!valid.provider || !valid.model) valid = await completeInteractiveOptions(valid, { chooseProvider, chooseModel, listModels }, env, systemCredentials);
  } catch (error) { if (exitCodeFor(error) !== 130) console.error(error instanceof Error ? error.message : "Login failed"); return exitCodeFor(error); }
  if (valid.error) { console.error(valid.error); return 1; }
  const buildSession = (selection: StartupSelection | GlobalPreference, apiKey: string, history?: ReturnType<Agent["history"]>): TuiSession => ({ provider: selection.provider, model: selection.model, agent: new Agent({ llm: createLLM({ provider: selection.provider, model: selection.model, apiKey }), tools, rootDir: valid.rootDir!, systemPrompt: SYSTEM_PROMPT, messages: history, onEvent: (event) => { const text = formatEvent(event, debugEnabled(env)); if (text) console.log(text); } }) });
  const session = buildSession({ provider: valid.provider!, model: valid.model! }, valid.apiKey!);
  if (valid.prompt) { try { console.log((await session.agent.run(valid.prompt)).answer); return 0; } catch { return 1; } }
  return startTui(session.agent, { project: valid.rootDir!, provider: session.provider, model: session.model }, {
    login: async (current) => { const next = await loginWithCredentialStore({ credentials: systemCredentials, chooseProvider, chooseModel, askApiKey, listModels, savePreference: saveGlobalPreference }); return buildSession(next, next.apiKey, current.agent.history()); },
    model: async (current) => { const key = await resolveApiKey(current.provider, systemCredentials, env); if (!key) throw new Error(`No saved API key for ${current.provider}; use /login`); const next = await selectAndSaveModel({ provider: current.provider, model: current.model }, key.apiKey, { listModels, chooseModel, savePreference: saveGlobalPreference }); return buildSession(next, key.apiKey, current.agent.history()); },
    logout: async () => logoutFromCredentialStore(systemCredentials, await readGlobalPreference(), chooseStoredProvider, clearGlobalPreference)
  });
}

if (import.meta.url === `file://${process.argv[1]}`) run().then((code) => { process.exitCode = code; });
