import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import select from "@inquirer/select";

import type { Agent, AgentEvent } from "./agent.js";
import type { ProviderName } from "./llm.js";

export type TuiCommand = { type: "help" | "reset" | "exit" | "empty" } | { type: "unknown"; command: string } | { type: "prompt"; prompt: string };

export function parseCommand(input: string): TuiCommand {
  const text = input.trim();
  if (!text) return { type: "empty" };
  if (text === "/help") return { type: "help" };
  if (text === "/reset") return { type: "reset" };
  if (text === "/exit") return { type: "exit" };
  return text.startsWith("/") ? { type: "unknown", command: text } : { type: "prompt", prompt: text };
}

export function formatEvent(event: AgentEvent): string {
  if (event.type === "agent_start") return "Working...";
  if (event.type === "model_start") return `Thinking (turn ${event.turn})...`;
  if (event.type === "model_end") return event.toolCallCount ? `Using ${event.toolCallCount} tool(s)...` : "";
  if (event.type === "tool_start") return `→ ${event.toolName}`;
  if (event.type === "tool_end") return event.isError ? `✗ ${event.toolName}: ${event.message}` : `✓ ${event.toolName}`;
  if (event.type === "agent_end") return `Completed · ${event.turns} turns`;
  return `Error: ${event.message}`;
}

export async function chooseProvider(): Promise<ProviderName> {
  return select({ message: "Provider", choices: [{ name: "OpenAI", value: "openai" }, { name: "DeepSeek", value: "deepseek" }] });
}

export async function chooseModel(models: string[]): Promise<string> {
  return select({ message: "Model", choices: models.map((value) => ({ name: value, value })) });
}

export function helpText(project: string, provider: ProviderName, model: string): string {
  return `Project: ${project}\nProvider: ${provider}\nModel: ${model}\nAsk about the project. Commands: /help, /reset, /exit`;
}

export async function startTui(agent: Agent, config: { project: string; provider: ProviderName; model: string }): Promise<number> {
  const line = createInterface({ input: stdin, output: stdout });
  stdout.write("mini-Pi ready. /help for commands.\n");
  try {
    while (true) {
      let input: string;
      try { input = await line.question("> "); }
      catch (error) {
        const failure = error as { name?: string; code?: string };
        return failure?.name === "AbortPromptError" || failure?.code === "SIGINT" ? 130 : 0;
      }
      const command = parseCommand(input);
      if (command.type === "exit") return 0;
      if (command.type === "help") { stdout.write(`${helpText(config.project, config.provider, config.model)}\n`); continue; }
      if (command.type === "reset") { agent.reset(); stdout.write("Conversation reset.\n"); continue; }
      if (command.type === "empty") { stdout.write("Enter a question or /help.\n"); continue; }
      if (command.type === "unknown") { stdout.write(`Unknown command: ${command.command}\n`); continue; }
      if (command.type !== "prompt") continue;
      try { const result = await agent.run(command.prompt); stdout.write(`${result.answer}\n`); }
      catch (error) { stdout.write(`Error: ${error instanceof Error ? error.message : "Agent failed"}\n`); }
    }
  } finally { line.close(); }
}
