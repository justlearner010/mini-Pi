import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import select from "@inquirer/select";
import password from "@inquirer/password";
import { render as renderWithMarkdansi } from "markdansi";

import type { Agent, AgentEvent, ApprovalDecision, ApprovalRequest } from "./agent.js";
import type { ProviderName } from "./llm.js";

export type TuiCommand = { type: "help" | "reset" | "exit" | "login" | "model" | "logout" | "empty" } | { type: "unknown"; command: string } | { type: "prompt"; prompt: string };
export type TuiSession = { agent: Agent; provider: ProviderName; model: string };
export type TuiActions = { login: (session: TuiSession) => Promise<TuiSession>; model: (session: TuiSession) => Promise<TuiSession>; logout: () => Promise<ProviderName | undefined> };
export type TuiLine = { question: (prompt: string) => Promise<string>; close: () => void };
export type MarkdownRenderer = (text: string) => string;
export type TuiRuntime = { createLine?: () => TuiLine; write?: (text: string) => void; renderMarkdown?: MarkdownRenderer };
export type TuiViewRuntime = { write: (text: string) => void; now?: () => Date; provider?: ProviderName; model?: string; debug?: boolean; renderMarkdown?: MarkdownRenderer };

const tuiColor = { user: "\x1b[38;5;110m", assistant: "\x1b[38;5;141m", activity: "\x1b[38;5;245m", approval: "\x1b[38;5;179m", error: "\x1b[38;5;203m", reset: "\x1b[0m" };

/** Removes terminal controls and invisible formatting from plain TUI fields. */
export function sanitizePlainText(text: string): string {
  return sanitizeMarkdown(text)
    .replace(/[\p{Default_Ignorable_Code_Point}]/gu, "");
}

export type ActivityItem = { text: string; isError: boolean };
export type Activity = { turnCount: number; toolCount: number; durationMs: number; items: ActivityItem[]; expanded: boolean };
type ActiveActivity = Activity & { startedAt: Date };

/**
 * An append-only transcript view. It deliberately does not repaint or stream
 * model tokens: activity is collected and revealed only on explicit toggle.
 */
export class TuiView {
  private readonly write: (text: string) => void;
  private readonly now: () => Date;
  private readonly markdown: MarkdownRenderer;
  private provider: ProviderName;
  private model: string | undefined;
  private readonly debug: boolean;
  private activity: Activity[] = [];
  private currentActivity: ActiveActivity | undefined;
  private answerRendered = false;
  private pendingError: AgentEvent | undefined;
  private errorHandled = false;

  constructor(runtime: TuiViewRuntime) {
    this.write = runtime.write;
    this.now = runtime.now ?? (() => new Date());
    this.provider = runtime.provider ?? "openai";
    this.model = runtime.model;
    this.debug = runtime.debug ?? false;
    this.markdown = runtime.renderMarkdown ?? defaultMarkdownRenderer;
  }

  onEvent(event: AgentEvent): void {
    if (event.type === "agent_start") {
      this.answerRendered = false;
      this.errorHandled = false;
      this.currentActivity = { turnCount: 0, toolCount: 0, durationMs: 0, items: [], expanded: false, startedAt: this.now() };
      this.writeLayer("user", `YOU: ${sanitizePlainText(event.prompt)}`);
      return;
    }
    if (event.type === "model_start") {
      if (this.currentActivity) this.currentActivity.turnCount = event.turn;
      this.writeLayer("activity", `· working · turn ${event.turn}`);
      return;
    }
    if (event.type === "model_end" || event.type === "agent_end") {
      if (event.type === "agent_end") {
        if (this.currentActivity) this.currentActivity.turnCount = event.turns;
        if (event.answer) { this.renderAnswer(event.answer, event.turns); this.answerRendered = true; }
        this.finishActivity();
        this.flushPendingError();
      }
      return;
    }
    if (event.type === "tool_start") {
      this.addActivity(`→ ${sanitizePlainText(event.toolName)}`, false, true);
      return;
    }
    if (event.type === "tool_end") {
      const name = sanitizePlainText(event.toolName);
      const summary = event.isError ? `: ${sanitizePlainText(event.message)}` : "";
      this.addActivity(`${event.isError ? "✗" : "✓"} ${name}${summary}`, event.isError);
      return;
    }
    if (this.currentActivity) this.pendingError = event;
    else {
      this.writeLayer("error", sanitizePlainText(formatEvent(event, this.debug)));
      this.errorHandled = true;
    }
  }

  updateSession(provider: ProviderName, model: string): void {
    this.provider = provider;
    this.model = model;
  }

  hasHandledError(): boolean { return this.errorHandled || Boolean(this.pendingError); }

  renderUnhandledError(message: string): void {
    this.pendingError = { type: "error", stage: "agent", message };
    this.finishActivity();
    this.flushPendingError();
  }

  toggleLatestActivity(): boolean {
    const latest = this.activity.at(-1) ?? this.currentActivity;
    if (!latest) return false;
    latest.expanded = !latest.expanded;
    this.renderActivityState(latest);
    return latest.expanded;
  }

  clearActivity(): void {
    this.activity = [];
    this.currentActivity = undefined;
  }

  renderTurn(_prompt: string, answer: string, turns: number): void {
    if (!this.answerRendered) this.renderAnswer(answer, turns);
  }

  private addActivity(text: string, isError: boolean, isToolStart = false): void {
    if (!this.currentActivity) return;
    this.currentActivity.items.push({ text, isError });
    if (isToolStart) this.currentActivity.toolCount += 1;
  }

  private renderAnswer(answer: string, turns: number): void {
    const label = `MINI-PI · ${this.provider}${this.model ? ` · ${this.model}` : ""} · ${turns} turns`;
    try { this.writeLayer("assistant", `${label}\n${renderMarkdown(answer, this.markdown)}`); }
    catch { this.writeLayer("assistant", `${label}\nMarkdown rendering failed; showing safe plain text.\n${sanitizeMarkdown(answer)}`); }
  }

  private finishActivity(): void {
    if (!this.currentActivity) return;
    this.currentActivity.durationMs = Math.max(0, this.now().getTime() - this.currentActivity.startedAt.getTime());
    const { startedAt: _startedAt, ...activity } = this.currentActivity;
    this.activity.push(activity);
    this.currentActivity = undefined;
    this.renderActivityState(activity);
  }

  private flushPendingError(): void {
    if (!this.pendingError) return;
    this.writeLayer("error", sanitizePlainText(formatEvent(this.pendingError, this.debug)));
    this.pendingError = undefined;
    this.errorHandled = true;
  }

  private renderActivityState(activity: Activity): void {
    const label = `${activity.expanded ? "▾" : "▸"} activity · ${activity.toolCount} tools · ${activity.durationMs}ms`;
    const details = activity.expanded ? `\n${activity.items.map((item) => item.text).join("\n")}` : "";
    this.writeLayer("activity", `${label}${details}`);
  }

  private writeLayer(layer: "user" | "assistant" | "activity" | "approval" | "error", text: string): void {
    this.write(`${tuiColor[layer]}${text}${tuiColor.reset}\n`);
  }
}

const MAX_APPROVAL_FIELD_LENGTH = 500;
const MAX_APPROVAL_ARGUMENTS_LENGTH = 4_000;

/** Makes untrusted approval details safe for a terminal while retaining structural JSON newlines. */
function sanitizeApprovalDisplay(text: string, maximumLength: number, preserveNewlines = false): string {
  const withoutTerminalSequences = text
    .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\|$)/g, "")
    .replace(/\x9d[\s\S]*?(?:\x07|\x9c|\x1b\\|$)/g, "")
    .replace(/(?:\x1b\[|\x9b)[0-?]*[ -/]*[@-~]/g, "");
  const controls = preserveNewlines ? /[\x00-\x09\x0b-\x1f\x7f-\x9f]|\p{Default_Ignorable_Code_Point}/gu : /[\x00-\x1f\x7f-\x9f]|\p{Default_Ignorable_Code_Point}/gu;
  const safe = withoutTerminalSequences.replace(controls, "");
  return safe.length > maximumLength ? `${safe.slice(0, maximumLength)}… [truncated]` : safe;
}

function approvalArguments(argumentsValue: unknown): string {
  try {
    const serialized = JSON.stringify(argumentsValue, (_key, value) => typeof value === "string" ? sanitizeApprovalDisplay(value, MAX_APPROVAL_FIELD_LENGTH) : value, 2);
    return sanitizeApprovalDisplay(serialized ?? "[unavailable]", MAX_APPROVAL_ARGUMENTS_LENGTH, true);
  }
  catch { return "[unavailable]"; }
}

/** Prompts locally for an Agent tool permission decision; every unexpected input fails closed. */
export async function requestTerminalApproval(request: ApprovalRequest, runtime: TuiRuntime = {}): Promise<ApprovalDecision> {
  const createLine = runtime.createLine ?? (() => createInterface({ input: stdin, output: stdout }));
  const write = runtime.write ?? ((text: string) => { stdout.write(text); });
  const destructive = request.permission === "DESTRUCTIVE";
  const required = destructive ? "yes" : "y";
  write(`\nTool: ${sanitizeApprovalDisplay(request.toolName, MAX_APPROVAL_FIELD_LENGTH)}\nReason: ${sanitizeApprovalDisplay(request.reason, MAX_APPROVAL_FIELD_LENGTH)}\nRisk: ${sanitizeApprovalDisplay(request.risk, MAX_APPROVAL_FIELD_LENGTH)}\nArguments:\n${approvalArguments(request.arguments)}\n`);
  if (destructive) write("HIGH RISK: This action may be irreversible.\n");
  const line = createLine();
  try {
    const answer = await line.question(`Approve? Type exactly ${required}: `);
    return answer === required ? { approved: true, reason: "user approved" } : { approved: false, reason: "user declined" };
  } catch { return { approved: false, reason: "user declined" }; }
  finally { line.close(); }
}

/** Removes terminal control input from untrusted model text while retaining layout. */
export function sanitizeMarkdown(text: string): string {
  return text.replace(/&#(?:x([0-9a-f]+)|([0-9]+));/gi, (_match, hex, decimal) => {
    const codePoint = Number.parseInt(hex ?? decimal, hex ? 16 : 10);
    return Number.isFinite(codePoint) && codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : "";
  })
    .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\|$)/g, "")
    .replace(/\x9d[\s\S]*?(?:\x07|\x9c|\x1b\\|$)/g, "")
    .replace(/(?:\x1b\[|\x9b)[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
}

/** Keeps only renderer-generated SGR styling and removes every other terminal control. */
export function sanitizeRenderedMarkdown(text: string): string {
  const removeControls = (value: string) => value
    .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\|$)/g, "")
    .replace(/\x9d[\s\S]*?(?:\x07|\x9c|\x1b\\|$)/g, "")
    .replace(/(?:\x1b\[|\x9b)[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "")
    .replace(/[\p{Default_Ignorable_Code_Point}]/gu, "");
  const sgr = /\x1b\[(\d{0,3}(?:[;:]\d{0,3})*)m/g;
  let safeText = "", cursor = 0;
  for (const style of text.matchAll(sgr)) {
    safeText += removeControls(text.slice(cursor, style.index));
    safeText += style[0];
    cursor = (style.index ?? 0) + style[0].length;
  }
  return safeText + removeControls(text.slice(cursor));
}

const defaultMarkdownRenderer: MarkdownRenderer = (text) => renderWithMarkdansi(text, { hyperlinks: false });

export function renderMarkdown(text: string, renderer: MarkdownRenderer = defaultMarkdownRenderer): string {
  return sanitizeRenderedMarkdown(renderer(sanitizeMarkdown(text)));
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
  const text = formatUnsafeEvent(event, debug);
  return sanitizePlainText(text);
}

function formatUnsafeEvent(event: AgentEvent, debug: boolean): string {
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

export async function startTui(agent: Agent, config: { project: string; provider: ProviderName; model: string }, actions?: TuiActions, runtime: TuiRuntime = {}, view = new TuiView({ write: runtime.write ?? ((text) => { stdout.write(text); }), provider: config.provider, model: config.model, renderMarkdown: runtime.renderMarkdown })): Promise<number> {
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
      if (command.type === "reset") { session.agent.reset(); view.clearActivity(); write("Conversation reset.\n"); continue; }
      if (command.type === "empty") { view.toggleLatestActivity(); continue; }
      if (command.type === "unknown") { write(`Unknown command: ${command.command}\n`); continue; }
      if (command.type === "login" || command.type === "model") {
        try { session = command.type === "login" ? await actions!.login(session) : await actions!.model(session); view.updateSession(session.provider, session.model); write(`Using ${session.provider} / ${session.model}.\n`); }
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
        view.renderTurn(command.prompt, result.answer, result.turns);
      }
      catch (error) {
        if (!view.hasHandledError()) view.renderUnhandledError(error instanceof Error ? error.message : "Agent failed");
      }
  }
}
