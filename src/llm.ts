import OpenAI from "openai";

import type { Tool } from "./tool.js";

export type ProviderName = string;

export interface LLMConfig {
  provider: ProviderName;
  model: string;
  apiKey: string;
}
export type DiagnosticKind = "authentication" | "billing" | "permission" | "model" | "invalid_request" | "rate_limit" | "provider" | "network" | "unknown";
export type DiagnosticLevel = "warning" | "error";
export interface ProviderDiagnosticData { provider: ProviderName; level: DiagnosticLevel; kind: DiagnosticKind; message: string; reason: string; advice: string; status?: number; code?: string; requestId?: string }
export class ProviderDiagnostic extends Error {
  declare readonly level: DiagnosticLevel; declare readonly kind: DiagnosticKind; declare readonly provider: ProviderName; declare readonly reason: string; declare readonly advice: string; declare readonly status?: number; declare readonly code?: string; declare readonly requestId?: string;
  constructor(data: ProviderDiagnosticData) { super(data.message); this.name = "ProviderDiagnostic"; Object.assign(this, data); }
}

export interface SystemMessage { role: "system"; content: string; }
export interface UserMessage { role: "user"; content: string; }
export interface ToolCall { id: string; name: string; arguments: string; }
export interface AssistantMessage { role: "assistant"; content: string | null; toolCalls: ToolCall[]; /** DeepSeek returns this whenever thinking produced it; passing it back on the next request is required. */ reasoningContent?: string; }
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
export class LiveEvaluationBudgetExceeded extends Error { constructor() { super("Live evaluation request budget exhausted"); this.name = "LiveEvaluationBudgetExceeded"; } }
export function withRequestBudget(llm: LLMClient, maxRequests: number): { llm: LLMClient; requestsStarted: () => number } {
  if (!Number.isSafeInteger(maxRequests) || maxRequests < 1) throw new Error("Live evaluation request budget must be positive");
  let started = 0;
  return {
    llm: { async generate(messages, tools) { if (started === maxRequests) throw new LiveEvaluationBudgetExceeded(); started += 1; return llm.generate(messages, tools); } },
    requestsStarted: () => started
  };
}

export interface ProviderClient {
  chat: { completions: { create(request: unknown): Promise<unknown> } };
  models: { list(): Promise<unknown> };
}

/**
 * Declarative metadata for an OpenAI Chat-Completions compatible Provider.
 * Adding a Provider is a one-line entry in `providerRegistry`; no protocol
 * code is required because every supported Provider speaks the same wire
 * format. Anthropic Messages and Google Generative AI are deferred (tier C).
 */
export interface ProviderSpec {
  id: string;
  name: string;
  baseUrl: string;
  apiKeyEnv: readonly string[];
  defaultHeaders?: Readonly<Record<string, string>>;
  extraBody?: Readonly<Record<string, unknown>>;
  needsApiKey: boolean;
}

const providerRegistry: Readonly<Record<string, ProviderSpec>> = {
  openai: { id: "openai", name: "OpenAI", baseUrl: "https://api.openai.com/v1", apiKeyEnv: ["OPENAI_API_KEY"], needsApiKey: true },
  deepseek: { id: "deepseek", name: "DeepSeek", baseUrl: "https://api.deepseek.com/v1", apiKeyEnv: ["DEEPSEEK_API_KEY"], needsApiKey: true, extraBody: { thinking: { type: "disabled" } } },
  openrouter: { id: "openrouter", name: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", apiKeyEnv: ["OPENROUTER_API_KEY"], needsApiKey: true, defaultHeaders: { "HTTP-Referer": "https://github.com/justlearner010/mini-Pi", "X-Title": "mini-Pi" } },
  together: { id: "together", name: "Together AI", baseUrl: "https://api.together.xyz/v1", apiKeyEnv: ["TOGETHER_API_KEY"], needsApiKey: true },
  groq: { id: "groq", name: "Groq", baseUrl: "https://api.groq.com/openai/v1", apiKeyEnv: ["GROQ_API_KEY"], needsApiKey: true },
  mistral: { id: "mistral", name: "Mistral", baseUrl: "https://api.mistral.ai/v1", apiKeyEnv: ["MISTRAL_API_KEY"], needsApiKey: true },
  ollama: { id: "ollama", name: "Ollama (local)", baseUrl: "http://localhost:11434/v1", apiKeyEnv: [], needsApiKey: false },
  vllm: { id: "vllm", name: "vLLM (local)", baseUrl: "http://localhost:8000/v1", apiKeyEnv: [], needsApiKey: false }
};

export function lookupProvider(id: string): ProviderSpec {
  const spec = providerRegistry[id];
  if (!spec) throw new Error(`Unknown provider: ${id}`);
  return spec;
}
export function listProviderIds(): string[] { return Object.keys(providerRegistry); }
export function providerDisplayName(id: string): string { return providerRegistry[id]?.name ?? id; }
export function listProviders(): ReadonlyArray<ProviderSpec> { return Object.values(providerRegistry); }

type ProviderMessage = Record<string, unknown>;

function clientFor(provider: ProviderName | ProviderSpec, apiKey: string): ProviderClient {
  const spec = typeof provider === "string" ? lookupProvider(provider) : provider;
  return new OpenAI({ apiKey, baseURL: spec.baseUrl, ...(spec.defaultHeaders ? { defaultHeaders: { ...spec.defaultHeaders } } : {}) }) as unknown as ProviderClient;
}

function requestMessages(messages: Message[]): ProviderMessage[] {
  return messages.map((message) => {
    if (message.role === "assistant") {
      const result: ProviderMessage = { role: "assistant", content: message.content };
      // DeepSeek rejects an empty tool_calls array, so only include it when the assistant
      // actually invoked tools in this turn.
      if (message.toolCalls.length > 0) {
        result.tool_calls = message.toolCalls.map((call) => ({ id: call.id, type: "function", function: { name: call.name, arguments: call.arguments } }));
      }
      if (typeof message.reasoningContent === "string") result.reasoning_content = message.reasoningContent;
      return result;
    }
    if (message.role === "tool") return { role: "tool", tool_call_id: message.toolCallId, content: message.content };
    return { role: message.role, content: message.content };
  });
}

function modelResponse(raw: unknown): ModelResponse {
  const choice = (raw as { choices?: unknown[] })?.choices?.[0] as { message?: { content?: unknown; tool_calls?: unknown[]; reasoning_content?: unknown } } | undefined;
  if (!choice?.message) throw new Error("Provider returned no choices");
  const toolCalls = (choice.message.tool_calls ?? []).flatMap((call) => {
    const item = call as { id?: unknown; function?: { name?: unknown; arguments?: unknown } };
    return typeof item.id === "string" && typeof item.function?.name === "string" && typeof item.function.arguments === "string"
      ? [{ id: item.id, name: item.function.name, arguments: item.function.arguments }] : [];
  });
  const reasoningContent = typeof choice.message.reasoning_content === "string" && choice.message.reasoning_content.length > 0 ? choice.message.reasoning_content : undefined;
  return { message: { role: "assistant", content: typeof choice.message.content === "string" ? choice.message.content : null, toolCalls, ...(reasoningContent ? { reasoningContent } : {}) } };
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
  let name: string;
  try { name = providerDisplayName(provider); }
  catch { name = provider; }
  const [kind, level, message, reason, advice]: [DiagnosticKind, DiagnosticLevel, string, string, string] = status === 401 ? ["authentication", "error", `${name} 认证失败`, "API Key 无效、过期，或不属于当前 Provider。", `运行 /login 重新保存 ${name} 的 API Key。`] : status === 402 ? ["billing", "warning", `${name} 账户余额不足`, "当前账户余额不足，无法继续调用该模型。", "充值后再试，或切换 Provider / 模型。"] : status === 403 ? ["permission", "error", "Provider 权限不足", "当前 Key 没有访问该资源的权限。", "确认 Key 的权限、账号状态和 Provider 是否正确。"] : status === 404 ? ["model", "warning", "模型不可用", "模型名不存在或当前 Key 无权使用。", "运行 /model 重新选择可用模型。"] : status === 400 || status === 422 ? ["invalid_request", "warning", `${name} 拒绝了请求`, "请求参数不被接受，可能是不支持的参数、消息格式或工具定义。", "运行 /model 切换模型重试；若反复出现，可能是工具定义与 Provider 不兼容。"] : status === 429 ? ["rate_limit", "warning", `${name} 请求受限`, "当前请求被限流、余额或并发限制。", "稍后重试，或切换模型 / Provider。"] : status !== undefined && status >= 500 ? ["provider", "warning", "Provider 暂时不可用", "Provider 服务端暂时发生故障。", "稍后重试。"] : network ? ["network", "warning", "网络请求失败", "无法连接到 Provider 或请求超时。", "检查网络、代理和 Provider API 地址后重试。"] : ["unknown", "warning", "Provider 请求失败", "Provider 返回了无法分类的错误。", "查看调试信息或稍后重试。"];
  return new ProviderDiagnostic({ provider, level, kind, message, reason, advice, ...(status === undefined ? {} : { status }), ...(code ? { code } : {}), ...(requestId ? { requestId } : {}) });
}

export function createLLM(config: LLMConfig, client: ProviderClient = clientFor(config.provider, config.apiKey), telemetry?: LLMTelemetry): LLMClient {
  const spec = lookupProvider(config.provider);
  return {
    async generate(messages, tools) {
      const request: Record<string, unknown> = {
        model: config.model,
        messages: requestMessages(messages),
        tools: tools.map((tool) => ({ type: "function", function: { name: tool.name, description: tool.description, parameters: tool.parameters } }))
      };
      if (spec.extraBody) request.extra_body = spec.extraBody;
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
