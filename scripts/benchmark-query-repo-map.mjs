import { fileURLToPath } from "node:url";

import { Agent } from "../dist/src/agent.js";
import { buildRepositoryIndex, createQueryRepoMapTool, queryRepositoryIndex, tools } from "../dist/src/tool.js";

const rootDir = fileURLToPath(new URL("../", import.meta.url));
const questions = [
  { id: "cli", prompt: "Where is CLI handling implemented?", expectedPaths: ["src/cli.ts"] },
  { id: "llm-provider", prompt: "Which module defines the LLM provider?", expectedPaths: ["src/llm.ts"] },
  { id: "tool-execution", prompt: "Where is tool execution handled?", expectedPaths: ["src/tool.ts"] },
  { id: "agent-dependents", prompt: "Which modules depend on Agent?", expectedPaths: ["src/agent.ts"] },
  { id: "provider-config", prompt: "Where should I inspect provider configuration?", expectedPaths: ["src/llm.ts"] }
];
const variants = ["none", "map-4000", "map-8000"];

function toolCall(id, name, arguments_) {
  return { role: "assistant", content: null, toolCalls: [{ id, name, arguments: JSON.stringify(arguments_) }] };
}

function repliesFor(variant, expectedPath) {
  if (variant !== "none") return [toolCall("read-candidate", "read_file", { path: expectedPath }), { role: "assistant", content: `Candidate verified: ${expectedPath}`, toolCalls: [] }];
  return [
    toolCall("scan", "scan_project", {}),
    toolCall("read-manifest", "read_file", { path: "package.json" }),
    toolCall("dependencies", "analyze_dependencies", { entry: "src/cli.ts" }),
    toolCall("read-candidate", "read_file", { path: expectedPath }),
    { role: "assistant", content: `Candidate verified: ${expectedPath}`, toolCalls: [] }
  ];
}

function measuredTools(availableTools, expectedPaths, metrics) {
  return availableTools.map((tool) => ({
    ...tool,
    async execute(args, context) {
      metrics.toolCalls += 1;
      metrics.toolCallsByName[tool.name] = (metrics.toolCallsByName[tool.name] ?? 0) + 1;
      const path = tool.name === "read_file" && args && typeof args === "object" && typeof args.path === "string" ? args.path : undefined;
      const correctRead = path !== undefined && expectedPaths.includes(path);
      const result = await tool.execute(args, context);
      metrics.returnedToolBytes += Buffer.byteLength(JSON.stringify(result.content));
      if (tool.name === "read_file" && !result.isError && result.content && typeof result.content === "object" && typeof result.content.content === "string") {
        metrics.filesRead += 1;
        if (correctRead && metrics.firstCorrectCandidateRead === null) metrics.firstCorrectCandidateRead = metrics.toolCalls;
        else if (metrics.firstCorrectCandidateRead === null) metrics.sourceBytesBeforeCorrectRead += Buffer.byteLength(result.content.content);
      }
      return result;
    }
  }));
}

function scriptedLLM(replies, metrics) {
  let cursor = 0;
  return { async generate(messages, availableTools) {
    metrics.modelRequests += 1;
    metrics.requestCharacters += JSON.stringify({ messages, tools: availableTools }).length;
    const message = replies[cursor++];
    if (!message) throw new Error("Scripted LLM exhausted its replies");
    return { message: structuredClone(message) };
  } };
}

const indexStart = process.hrtime.bigint();
const index = await buildRepositoryIndex(rootDir);
const indexBuildMs = Number(process.hrtime.bigint() - indexStart) / 1_000_000;
const runs = [];

for (const variant of variants) {
  for (const question of questions) {
    const limit = variant === "map-4000" ? 4_000 : 8_000;
    const renderStart = process.hrtime.bigint();
    const map = variant === "none" ? undefined : queryRepositoryIndex(index, question.prompt, { maxCharacters: limit, limit: 8 });
    const mapRenderMs = variant === "none" ? 0 : Number(process.hrtime.bigint() - renderStart) / 1_000_000;
    const metrics = { modelRequests: 0, toolCalls: 0, toolCallsByName: {}, filesRead: 0, returnedToolBytes: 0, sourceBytesBeforeCorrectRead: 0, requestCharacters: 0, firstCorrectCandidateRead: null };
    const availableTools = variant === "none" ? tools : [...tools, createQueryRepoMapTool(index)];
    const agent = new Agent({
      llm: scriptedLLM(repliesFor(variant, question.expectedPaths[0]), metrics),
      tools: measuredTools(availableTools, question.expectedPaths, metrics),
      rootDir,
      systemPrompt: "Use repository evidence to identify and verify the candidate file."
    });
    let outcome = "answered";
    let turns = 0;
    try {
      const result = await agent.run(question.prompt, map ? { transientContext: map.text } : undefined);
      turns = result.turns;
    } catch (error) {
      outcome = error instanceof Error && /maximum turns/i.test(error.message) ? "maximum_turns" : "failed";
      turns = metrics.modelRequests;
    }
    runs.push({
      variant, questionId: question.id, outcome,
      top1: map ? question.expectedPaths.includes(map.candidates[0]?.path) : false,
      top3: map ? map.candidates.slice(0, 3).some((candidate) => question.expectedPaths.includes(candidate.path)) : false,
      indexBuildMs: variant === "none" ? 0 : indexBuildMs, mapRenderMs, turns,
      ...metrics,
      toolCallsByName: Object.fromEntries(Object.entries(metrics.toolCallsByName).sort(([left], [right]) => left.localeCompare(right)))
    });
  }
}

runs.sort((left, right) => left.variant.localeCompare(right.variant) || left.questionId.localeCompare(right.questionId));
process.stdout.write(`${JSON.stringify({ schemaVersion: 1, questions, runs })}\n`);
