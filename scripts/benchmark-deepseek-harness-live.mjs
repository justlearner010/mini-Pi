import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { realpath } from "node:fs/promises";

import { Agent } from "../dist/src/agent.js";
import { createRepositoryNavigation, SYSTEM_PROMPT } from "../dist/src/cli.js";
import { createLLM, LiveEvaluationBudgetExceeded, withRequestBudget } from "../dist/src/llm.js";

const rootDir = "/Users/jay/deepseek-harness";
const expectedCommit = "47f943859bef60e4160492346772ded9b24f765a";
const apiKey = process.env.DEEPSEEK_API_KEY;
if (!apiKey) throw new Error("DEEPSEEK_API_KEY is required");
if (!existsSync(rootDir) || await realpath(rootDir) !== rootDir) throw new Error("deepseek-harness root is unavailable");
if (execFileSync("git", ["-C", rootDir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim() !== expectedCommit) throw new Error("deepseek-harness commit does not match the approved evaluation target");

const questions = [
  ["cli-bin", "Where does the dsh CLI start?", "apps/cli/src/bin.ts"],
  ["agent-loop", "Where is the default Agent loop implemented?", "packages/core/agent-loop/src/agent.ts"],
  ["tools", "Where is the core tool registry implemented?", "packages/core/tools/src/index.ts"],
  ["deepseek-adapter", "Where is the DeepSeek LLM adapter implemented?", "packages/llm/llm-deepseek/src/adapter.ts"],
  ["basic-compaction", "Where is basic context compaction implemented?", "packages/compaction/compaction-basic/src/index.ts"]
];
const navigation = await createRepositoryNavigation(rootDir);
if (!navigation) throw new Error("Repository navigation is unavailable");
const telemetry = [];
const budget = withRequestBudget(createLLM({ provider: "deepseek", model: "deepseek-v4-flash", apiKey }, undefined, (event) => telemetry.push(event)), 20);
const rows = [];

for (const [id, prompt, expectedPath] of questions) {
  const reads = [], toolsByName = {};
  const safeTools = navigation.tools.map((tool) => ({ ...tool, async execute(args, context) {
    toolsByName[tool.name] = (toolsByName[tool.name] ?? 0) + 1;
    if (tool.name === "read_file" && args && typeof args === "object" && typeof args.path === "string") reads.push(args.path);
    return tool.execute(args, context);
  } }));
  const before = telemetry.length, started = process.hrtime.bigint();
  let outcome = "answered", turns = 0, answerMentionsExpectedPath = false;
  try {
    const agent = new Agent({ llm: budget.llm, tools: safeTools, rootDir, systemPrompt: SYSTEM_PROMPT, maxTurns: 6 });
    const result = await agent.run(prompt, { transientContext: navigation.mapFor(prompt).text });
    turns = result.turns;
    answerMentionsExpectedPath = result.answer.includes(expectedPath);
  } catch (error) {
    outcome = error instanceof LiveEvaluationBudgetExceeded ? "budget_exhausted" : /maximum turns/i.test(error instanceof Error ? error.message : "") ? "maximum_turns" : /Provider/.test(error instanceof Error ? error.message : "") ? "provider_failure" : "agent_failure";
  }
  const events = telemetry.slice(before);
  const usage = events.reduce((total, event) => ({
    promptTokens: total.promptTokens + (event.usage?.promptTokens ?? 0),
    completionTokens: total.completionTokens + (event.usage?.completionTokens ?? 0),
    totalTokens: total.totalTokens + (event.usage?.totalTokens ?? 0)
  }), { promptTokens: 0, completionTokens: 0, totalTokens: 0 });
  const map = navigation.mapFor(prompt);
  rows.push({
    id, outcome, turns, providerRequests: events.length,
    requestDurationMs: events.map((event) => event.durationMs),
    endToEndDurationMs: Number(process.hrtime.bigint() - started) / 1_000_000,
    usage, toolCalls: Object.values(toolsByName).reduce((sum, value) => sum + value, 0),
    toolsByName, readPaths: reads, expectedSourceRead: reads.includes(expectedPath),
    answerMentionsExpectedPath, repoMapTop1: map.candidates[0]?.path === expectedPath,
    repoMapTop3: map.candidates.slice(0, 3).some((candidate) => candidate.path === expectedPath),
    telemetryComplete: events.every((event) => event.outcome === "success" && event.usage?.totalTokens !== undefined)
  });
  if (budget.requestsStarted() === 20) break;
}
process.stdout.write(JSON.stringify({ schemaVersion: 1, target: { repository: "deepseek-harness", commit: expectedCommit }, provider: "deepseek", model: "deepseek-v4-flash", requestBudget: 20, requestsStarted: budget.requestsStarted(), rows }) + "\n");

