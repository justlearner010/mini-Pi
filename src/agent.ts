import type { LLMClient, Message, ToolCall } from "./llm.js";
import type { Tool } from "./tool.js";

export type AgentEventType = "agent_start" | "model_start" | "model_end" | "tool_start" | "tool_end" | "agent_end" | "error";
export interface AgentEvent { type: AgentEventType; [key: string]: unknown; }
export interface AgentConfig {
  llm: LLMClient;
  tools: Tool[];
  systemPrompt: string;
  rootDir: string;
  maxTurns?: number;
  onEvent?: (event: AgentEvent) => void;
}

function content(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

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

  async run(prompt: string): Promise<string> {
    const start = this.messages.length;
    this.emit("agent_start");
    this.messages.push({ role: "user", content: prompt });
    let turns = 0;
    try {
      while (true) {
        if (turns === this.maxTurns) throw new Error("Agent reached maximum turns");
        this.emit("model_start");
        let response;
        try { response = await this.llm.generate(this.messages, this.tools); }
        catch { throw new Error("Model request failed"); }
        turns += 1;
        this.emit("model_end");
        const message = response.message;
        this.messages.push(message);
        if (!message.toolCalls.length) {
          const answer = message.content ?? "";
          this.emit("agent_end");
          return answer;
        }
        for (const call of message.toolCalls) await this.execute(call);
      }
    } catch (error) {
      this.messages.splice(start);
      const message = error instanceof Error ? error.message : "Agent failed";
      this.emit("error", { message });
      this.emit("agent_end");
      throw new Error(message);
    }
  }

  private async execute(call: ToolCall): Promise<void> {
    this.emit("tool_start", { toolCallId: call.id, name: call.name });
    const tool = this.tools.find((item) => item.name === call.name);
    let result: string;
    try {
      if (!tool) throw new Error(`Unknown tool: ${call.name}`);
      let args: unknown;
      try { args = JSON.parse(call.arguments); }
      catch { throw new Error("Malformed tool arguments"); }
      const output = await tool.execute(args, { rootDir: this.rootDir });
      result = output.isError ? `Tool error: ${content(output.content)}` : content(output.content);
    } catch (error) {
      result = `Tool error: ${error instanceof Error ? error.message : "Tool failed"}`;
    }
    this.messages.push({ role: "tool", toolCallId: call.id, content: result });
    this.emit("tool_end", { toolCallId: call.id, name: call.name });
  }

  private emit(type: AgentEventType, detail: Record<string, unknown> = {}): void { this.onEvent?.({ type, ...detail }); }
}
