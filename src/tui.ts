import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import select from "@inquirer/select";
import password from "@inquirer/password";
import { render as renderWithMarkdansi } from "markdansi";

import type { Agent, AgentEvent } from "./agent.js";
import type { ProviderName } from "./llm.js";

export type TuiCommand = { type: "help" | "reset" | "exit" | "login" | "model" | "logout" | "empty" } | { type: "unknown"; command: string } | { type: "prompt"; prompt: string };
export type TuiSession = { agent: Agent; provider: ProviderName; model: string };
export type TuiActions = { login: (session: TuiSession) => Promise<TuiSession>; model: (session: TuiSession) => Promise<TuiSession>; logout: () => Promise<ProviderName | undefined> };
export type TuiLine = { question: (prompt: string) => Promise<string>; close: () => void };
export type MarkdownRenderer = (text: string) => string;
export type TuiRuntime = { createLine?: () => TuiLine; write?: (text: string) => void; renderMarkdown?: MarkdownRenderer };

/** Removes terminal control input from untrusted model text while retaining layout. */
export function sanitizeMarkdown(text: string): string {
  return text
    .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\|$)/g, "")
    .replace(/\x9d[\s\S]*?(?:\x07|\x9c|\x1b\\|$)/g, "")
    .replace(/(?:\x1b\[|\x9b)[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
}

export function renderMarkdown(text: string, renderer: MarkdownRenderer = renderWithMarkdansi): string {
  return renderer(sanitizeMarkdown(text));
}

export function parseCommand(input: string): TuiCommand {
  const text = input.trim();
  if (!text) return { type: "empty" };
  if (text === "/help") return { type: "help" };
  if (text === "/reset") return { type: "reset" };
  if (text === "/exit") return { type: "exit" };
  if (text === "/login") return { type: "login" };
  if (text === "/model") return { type: "model" };
  if (text === "/logout") return { type: "logout" };
  return text.startsWith("/") ? { type: "unknown", command: text } : { type: "prompt", prompt: text };
}

export function formatEvent(event: AgentEvent, debug = false): string {
  if (event.type === "agent_start") return "Working...";
  if (event.type === "model_start") return `Thinking (turn ${event.turn})...`;
  if (event.type === "model_end") return event.toolCallCount ? `Using ${event.toolCallCount} tool(s)...` : "";
  if (event.type === "tool_start") return `→ ${event.toolName}`;
  if (event.type === "tool_end") return event.isError ? `✗ ${event.toolName}: ${event.message}` : `✓ ${event.toolName}`;
  if (event.type === "agent_end") return `Completed · ${event.turns} turns`;
  if (!event.diagnostic) return `Error: ${event.message}`;
  const label = { authentication: "认证失败", permission: "权限不足", model: "模型不可用", rate_limit: "限流", provider: "Provider 暂时不可用", network: "网络请求失败", unknown: "未知 Provider 错误" }[event.diagnostic.kind];
  const provider = event.diagnostic.provider === "openai" ? "OpenAI" : "DeepSeek";
  const safeCode = ["invalid_api_key", "rate_limit_exceeded", "model_not_found"].includes(event.diagnostic.code ?? "") ? event.diagnostic.code : undefined;
  const details = [event.diagnostic.status === undefined ? "" : `HTTP ${event.diagnostic.status}`, safeCode ? `code=${safeCode}` : ""].filter(Boolean).join(" · ");
  return `${event.diagnostic.level === "error" ? "错误" : "警告"} [${label}]\n位置：${provider}，第 ${event.turn} 次模型请求\n原因：${event.diagnostic.reason}\n建议：${event.diagnostic.advice}${debug && details ? `\n调试：${details}` : ""}`;
}

export async function chooseProvider(): Promise<ProviderName> {
  return select({ message: "Provider", choices: [{ name: "OpenAI", value: "openai" }, { name: "DeepSeek", value: "deepseek" }] });
}

export async function chooseModel(models: string[]): Promise<string> {
  return select({ message: "Model", choices: models.map((value) => ({ name: value, value })) });
}
export async function askApiKey(): Promise<string> { return password({ message: "API Key", mask: "*" }); }
export async function chooseStoredProvider(providers: ProviderName[]): Promise<ProviderName> { return select({ message: "Provider to log out", choices: providers.map((value) => ({ name: value, value })) }); }

export function helpText(project: string, provider: ProviderName, model: string): string {
  return `Project: ${project}\nProvider: ${provider}\nModel: ${model}\nAsk about the project. Commands: /login, /model, /logout, /help, /reset, /exit`;
}

export async function startTui(agent: Agent, config: { project: string; provider: ProviderName; model: string }, actions?: TuiActions, runtime: TuiRuntime = {}): Promise<number> {
  const createLine = runtime.createLine ?? (() => createInterface({ input: stdin, output: stdout }));
  const write = runtime.write ?? ((text: string) => { stdout.write(text); });
  let session: TuiSession = { agent, provider: config.provider, model: config.model };
  write("mini-Pi ready. /help for commands.\n");
  while (true) {
    const line = createLine();
    let input: string;
    try { input = await line.question("> "); }
    catch (error) {
      const failure = error as { name?: string; code?: string };
      return failure?.name === "AbortPromptError" || failure?.code === "SIGINT" ? 130 : 0;
    } finally { line.close(); }
      const command = parseCommand(input);
      if (command.type === "exit") return 0;
      if (command.type === "help") { write(`${helpText(config.project, session.provider, session.model)}\n`); continue; }
      if (command.type === "reset") { session.agent.reset(); write("Conversation reset.\n"); continue; }
      if (command.type === "empty") { write("Enter a question or /help.\n"); continue; }
      if (command.type === "unknown") { write(`Unknown command: ${command.command}\n`); continue; }
      if (command.type === "login" || command.type === "model") {
        try { session = command.type === "login" ? await actions!.login(session) : await actions!.model(session); write(`Using ${session.provider} / ${session.model}.\n`); }
        catch (error) { write(`Error: ${error instanceof Error ? error.message : "Command failed"}\n`); }
        continue;
      }
      if (command.type === "logout") {
        try { const provider = await actions!.logout(); write(provider ? `${provider} credentials removed. Current session remains active.\n` : "No stored credentials to remove.\n"); }
        catch (error) { write(`Error: ${error instanceof Error ? error.message : "Command failed"}\n`); }
        continue;
      }
      if (command.type !== "prompt") continue;
      try {
        const result = await session.agent.run(command.prompt);
        try { write(`${renderMarkdown(result.answer, runtime.renderMarkdown)}\n`); }
        catch { write(`Markdown rendering failed; showing safe plain text.\n${sanitizeMarkdown(result.answer)}\n`); }
      }
      catch (error) { if (!(error instanceof Error && error.name === "ProviderDiagnostic")) write(`Error: ${error instanceof Error ? error.message : "Agent failed"}\n`); }
  }
}
