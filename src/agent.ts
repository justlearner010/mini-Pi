import type { LLMClient, Message, ToolCall } from "./llm.js";
import type { Tool } from "./tool.js";

export type AgentEvent =
  | { type: "agent_start"; prompt: string }
  | { type: "model_start"; turn: number }
  | { type: "model_end"; turn: number; toolCallCount: number }
  | { type: "tool_start"; turn: number; toolCallId: string; toolName: string }
  | { type: "tool_end"; turn: number; toolCallId: string; toolName: string; isError: boolean; message: string }
  | { type: "agent_end"; answer: string; turns: number }
  | { type: "error"; stage: "model" | "agent"; message: string };
export interface AgentConfig {
  llm: LLMClient;
  tools: Tool[];
  systemPrompt: string;
  rootDir: string;
  maxTurns?: number;
  onEvent?: (event: AgentEvent) => void;
}
export interface AgentResult { answer: string; messages: Message[]; turns: number; }

function content(value: unknown): string {
  if (value == null) return "";
  const serialized = typeof value === "string" ? value : JSON.stringify(value);
  return serialized ?? "";
}
function summary(value: unknown): string { return content(value).slice(0, 200); }

export class Agent {
  private readonly llm: LLMClient;
  private readonly tools: Tool[];
  private readonly systemPrompt: string;
  private readonly rootDir: string;
  private readonly maxTurns: number;
  private readonly onEvent?: (event: AgentEvent) => void;
  private messages: Message[];

  constructor(config: AgentConfig) {
    this.llm = config.llm;
    this.tools = config.tools;
    this.systemPrompt = config.systemPrompt;
    this.rootDir = config.rootDir;
    this.maxTurns = config.maxTurns ?? 8;
    this.onEvent = config.onEvent;
    this.messages = [{ role: "system", content: this.systemPrompt }];
  }

  reset(): void { this.messages = [{ role: "system", content: this.systemPrompt }]; }

  async run(prompt: string): Promise<AgentResult> {
    const start = this.messages.length;
    this.emit({ type: "agent_start", prompt });
    this.messages.push({ role: "user", content: prompt });
    let turns = 0;
    try {
      while (true) {
        if (turns === this.maxTurns) throw new Error("Agent reached maximum turns");
        const turn = turns + 1;
        this.emit({ type: "model_start", turn });
        let response;
        try { response = await this.llm.generate(this.messages, this.tools); }
        catch { throw { stage: "model", message: "Model request failed" }; }
        turns += 1;
        const message = response.message;
        this.emit({ type: "model_end", turn, toolCallCount: message.toolCalls.length });
        this.messages.push(message);
        if (!message.toolCalls.length) {
          const answer = message.content ?? "";
          const result = { answer, messages: structuredClone(this.messages), turns };
          this.emit({ type: "agent_end", answer, turns });
          return result;
        }
        for (const call of message.toolCalls) await this.execute(call, turn);
      }
    } catch (error) {
      this.messages.splice(start);
      const failure = error as { stage?: "model" | "agent"; message?: string };
      const message = failure.message ?? (error instanceof Error ? error.message : "Agent failed");
      this.emit({ type: "error", stage: failure.stage ?? "agent", message });
      this.emit({ type: "agent_end", answer: "", turns });
      throw new Error(message);
    }
  }

  private async execute(call: ToolCall, turn: number): Promise<void> {
    this.emit({ type: "tool_start", turn, toolCallId: call.id, toolName: call.name });
    const tool = this.tools.find((item) => item.name === call.name);
    let result: string, isError: boolean, message: string;
    try {
      if (!tool) throw new Error(`Unknown tool: ${call.name}`);
      let args: unknown;
      try { args = JSON.parse(call.arguments); }
      catch { throw new Error("Malformed tool arguments"); }
      const output = await tool.execute(args, { rootDir: this.rootDir });
      isError = output.isError;
      result = output.isError ? `Tool error: ${content(output.content)}` : content(output.content);
      message = output.isError ? summary(output.content) : "completed";
    } catch (error) {
      isError = true;
      message = error instanceof Error ? error.message : "Tool failed";
      result = `Tool error: ${message}`;
    }
    this.messages.push({ role: "tool", toolCallId: call.id, content: result });
    this.emit({ type: "tool_end", turn, toolCallId: call.id, toolName: call.name, isError, message: summary(message) });
  }

  private emit(event: AgentEvent): void { this.onEvent?.(event); }
}
