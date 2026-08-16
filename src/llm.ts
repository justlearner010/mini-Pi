import OpenAI from "openai";

import type { Tool } from "./tool.js";

export type ProviderName = "openai" | "deepseek";

export interface LLMConfig {
  provider: ProviderName;
  model: string;
  apiKey: string;
}
export type DiagnosticKind = "authentication" | "permission" | "model" | "rate_limit" | "provider" | "network" | "unknown";
export type DiagnosticLevel = "warning" | "error";
export type ProviderDiagnosticData = { provider: ProviderName; level: DiagnosticLevel; kind: DiagnosticKind; message: string; reason: string; advice: string; status?: number; code?: string; requestId?: string };
export class ProviderDiagnostic extends Error {
  declare readonly level: DiagnosticLevel; declare readonly kind: DiagnosticKind; declare readonly provider: ProviderName; declare readonly reason: string; declare readonly advice: string; declare readonly status?: number; declare readonly code?: string; declare readonly requestId?: string;
  constructor(data: ProviderDiagnosticData) { super(data.message); this.name = "ProviderDiagnostic"; Object.assign(this, data); }
}

export interface SystemMessage { role: "system"; content: string; }
export interface UserMessage { role: "user"; content: string; }
export interface ToolCall { id: string; name: string; arguments: string; }
export interface AssistantMessage { role: "assistant"; content: string | null; toolCalls: ToolCall[]; }
export interface ToolResultMessage { role: "tool"; toolCallId: string; content: string; }
export type Message = SystemMessage | UserMessage | AssistantMessage | ToolResultMessage;
export interface ModelResponse { message: AssistantMessage; }
export interface LLMClient { generate(messages: Message[], tools: Tool[]): Promise<ModelResponse>; }
export interface ProviderUsage { promptTokens?: number; completionTokens?: number; totalTokens?: number; }
export interface LLMTelemetryEvent {
  provider: ProviderName;
  model: string;
  outcome: "success" | "failure";
  durationMs: number;
  usage?: ProviderUsage;
}
export type LLMTelemetry = (event: LLMTelemetryEvent) => void;

export interface ProviderClient {
  chat: { completions: { create(request: unknown): Promise<unknown> } };
  models: { list(): Promise<unknown> };
}

type ProviderMessage = Record<string, unknown>;

function clientFor(provider: ProviderName, apiKey: string): ProviderClient {
  return new OpenAI({ apiKey, ...(provider === "deepseek" ? { baseURL: "https://api.deepseek.com" } : {}) }) as unknown as ProviderClient;
}

function requestMessages(messages: Message[]): ProviderMessage[] {
  return messages.map((message) => {
    if (message.role === "assistant") return {
      role: "assistant", content: message.content,
      tool_calls: message.toolCalls.map((call) => ({ id: call.id, type: "function", function: { name: call.name, arguments: call.arguments } }))
    };
    if (message.role === "tool") return { role: "tool", tool_call_id: message.toolCallId, content: message.content };
    return { role: message.role, content: message.content };
  });
}

function modelResponse(raw: unknown): ModelResponse {
  const choice = (raw as { choices?: unknown[] })?.choices?.[0] as { message?: { content?: unknown; tool_calls?: unknown[] } } | undefined;
  if (!choice?.message) throw new Error("Provider returned no choices");
  const toolCalls = (choice.message.tool_calls ?? []).flatMap((call) => {
    const item = call as { id?: unknown; function?: { name?: unknown; arguments?: unknown } };
    return typeof item.id === "string" && typeof item.function?.name === "string" && typeof item.function.arguments === "string"
      ? [{ id: item.id, name: item.function.name, arguments: item.function.arguments }] : [];
  });
  return { message: { role: "assistant", content: typeof choice.message.content === "string" ? choice.message.content : null, toolCalls } };
}

function safeError(prefix: string): Error {
  return new Error(prefix);
}

function usageOf(raw: unknown): ProviderUsage | undefined {
  const usage = (raw as { usage?: unknown })?.usage as { prompt_tokens?: unknown; completion_tokens?: unknown; total_tokens?: unknown } | undefined;
  const number = (value: unknown): number | undefined => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
  const result = { ...(number(usage?.prompt_tokens) === undefined ? {} : { promptTokens: number(usage?.prompt_tokens) }), ...(number(usage?.completion_tokens) === undefined ? {} : { completionTokens: number(usage?.completion_tokens) }), ...(number(usage?.total_tokens) === undefined ? {} : { totalTokens: number(usage?.total_tokens) }) };
  return Object.keys(result).length ? result : undefined;
}
function emitTelemetry(telemetry: LLMTelemetry | undefined, event: LLMTelemetryEvent): void { try { telemetry?.(event); } catch { /* telemetry must not affect requests */ } }

function codeOf(value: unknown): string | undefined { return typeof value === "string" && ["invalid_api_key", "rate_limit_exceeded", "model_not_found"].includes(value) ? value : undefined; }
function diagnostic(provider: ProviderName, error: unknown): ProviderDiagnostic {
  const raw = error as { status?: unknown; code?: unknown; request_id?: unknown; requestId?: unknown; message?: unknown };
  const status = typeof raw?.status === "number" && Number.isInteger(raw.status) ? raw.status : undefined;
  const rawCode = typeof raw?.code === "string" ? raw.code : "", code = codeOf(rawCode), requestId = undefined;
  const network = /network|timeout|timed out|connection|socket|fetch/i.test(typeof raw?.message === "string" ? raw.message : "") || /^(E(?:CONN|TIME|HOST|NET)|ENOTFOUND|ECONN)/.test(rawCode);
  const name = provider === "openai" ? "OpenAI" : "DeepSeek";
  const [kind, level, message, reason, advice]: [DiagnosticKind, DiagnosticLevel, string, string, string] = status === 401 ? ["authentication", "error", `${name} 认证失败`, "API Key 无效、过期，或不属于当前 Provider。", `运行 /login 重新保存 ${name} 的 API Key。`] : status === 403 ? ["permission", "error", "Provider 权限不足", "当前 Key 没有访问该资源的权限。", "确认 Key 的权限、账号状态和 Provider 是否正确。"] : status === 404 ? ["model", "warning", "模型不可用", "模型名不存在或当前 Key 无权使用。", "运行 /model 重新选择可用模型。"] : status === 429 ? ["rate_limit", "warning", `${name} 请求受限`, "当前请求被限流、余额或并发限制。", "稍后重试，或切换模型 / Provider。"] : status !== undefined && status >= 500 ? ["provider", "warning", "Provider 暂时不可用", "Provider 服务端暂时发生故障。", "稍后重试。"] : network ? ["network", "warning", "网络请求失败", "无法连接到 Provider 或请求超时。", "检查网络、代理和 Provider API 地址后重试。"] : ["unknown", "warning", "Provider 请求失败", "Provider 返回了无法分类的错误。", "查看调试信息或稍后重试。"];
  return new ProviderDiagnostic({ provider, level, kind, message, reason, advice, ...(status === undefined ? {} : { status }), ...(code ? { code } : {}), ...(requestId ? { requestId } : {}) });
}

export function createLLM(config: LLMConfig, client: ProviderClient = clientFor(config.provider, config.apiKey), telemetry?: LLMTelemetry): LLMClient {
  return {
    async generate(messages, tools) {
      const request: Record<string, unknown> = {
        model: config.model,
        messages: requestMessages(messages),
        tools: tools.map((tool) => ({ type: "function", function: { name: tool.name, description: tool.description, parameters: tool.parameters } }))
      };
      if (config.provider === "deepseek") request.extra_body = { thinking: { type: "disabled" } };
      const started = process.hrtime.bigint();
      try {
        const raw = await client.chat.completions.create(request);
        const durationMs = Number(process.hrtime.bigint() - started) / 1_000_000;
        const response = modelResponse(raw);
        emitTelemetry(telemetry, { provider: config.provider, model: config.model, outcome: "success", durationMs, ...(usageOf(raw) ? { usage: usageOf(raw) } : {}) });
        return response;
      } catch (error) {
        const durationMs = Number(process.hrtime.bigint() - started) / 1_000_000;
        emitTelemetry(telemetry, { provider: config.provider, model: config.model, outcome: "failure", durationMs });
        throw diagnostic(config.provider, error);
      }
    }
  };
}

export async function listModels(provider: ProviderName, apiKey: string, client: ProviderClient = clientFor(provider, apiKey)): Promise<string[]> {
  try {
    const data = (await client.models.list() as { data?: unknown[] }).data ?? [];
    return [...new Set(data.flatMap((model) => typeof (model as { id?: unknown }).id === "string" ? [(model as { id: string }).id] : []))].sort();
  } catch {
    throw safeError("Unable to list models");
  }
}
