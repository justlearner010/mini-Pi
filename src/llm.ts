import OpenAI from "openai";

import type { Tool } from "./tool.js";

export type ProviderName = "openai" | "deepseek";

export interface LLMConfig {
  provider: ProviderName;
  model: string;
  apiKey: string;
}

export interface SystemMessage { role: "system"; content: string; }
export interface UserMessage { role: "user"; content: string; }
export interface ToolCall { id: string; name: string; arguments: string; }
export interface AssistantMessage { role: "assistant"; content: string | null; toolCalls: ToolCall[]; }
export interface ToolResultMessage { role: "tool"; toolCallId: string; content: string; }
export type Message = SystemMessage | UserMessage | AssistantMessage | ToolResultMessage;
export interface ModelResponse { message: AssistantMessage; }
export interface LLMClient { generate(messages: Message[], tools: Tool[]): Promise<ModelResponse>; }

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

export function createLLM(config: LLMConfig, client: ProviderClient = clientFor(config.provider, config.apiKey)): LLMClient {
  return {
    async generate(messages, tools) {
      const request: Record<string, unknown> = {
        model: config.model,
        messages: requestMessages(messages),
        tools: tools.map((tool) => ({ type: "function", function: { name: tool.name, description: tool.description, parameters: tool.parameters } }))
      };
      if (config.provider === "deepseek") request.extra_body = { thinking: { type: "disabled" } };
      try {
        return modelResponse(await client.chat.completions.create(request));
      } catch (error) {
        if (error instanceof Error && error.message === "Provider returned no choices") throw error;
        throw safeError("Provider request failed");
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
