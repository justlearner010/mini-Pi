import { fileURLToPath } from "node:url";

import { Agent } from "../dist/src/agent.js";
import { tools } from "../dist/src/tool.js";

const fixtures = [
  {
    fixture: "alpha-service",
    rootDir: fileURLToPath(new URL("../test/fixtures/efficiency/alpha-service/", import.meta.url)),
    entry: "src/index.ts"
  },
  {
    fixture: "beta-workspace",
    rootDir: fileURLToPath(new URL("../test/fixtures/efficiency/beta-workspace/", import.meta.url)),
    entry: "packages/api/src/main.ts"
  },
  {
    fixture: "gamma-layered",
    rootDir: fileURLToPath(new URL("../test/fixtures/efficiency/gamma-layered/", import.meta.url)),
    entry: "src/server.ts"
  }
];

function toolCall(id, name, arguments_) {
  return {
    role: "assistant",
    content: null,
    toolCalls: [{ id, name, arguments: JSON.stringify(arguments_) }]
  };
}

function finalAnswer() {
  return {
    role: "assistant",
    content: "Project analysis complete.",
    toolCalls: []
  };
}

function normalReplies(entry) {
  return [
    toolCall("scan-1", "scan_project", {}),
    toolCall("read-2", "read_file", { path: "package.json" }),
    toolCall("dependencies-3", "analyze_dependencies", { entry }),
    finalAnswer()
  ];
}

function capacityBoundaryReplies() {
  return [
    ...Array.from({ length: 9 }, (_, index) =>
      toolCall(`scan-${index + 1}`, "scan_project", {})
    ),
    finalAnswer()
  ];
}

function beyondDefaultReplies() {
  return [
    ...Array.from({ length: 17 }, (_, index) =>
      toolCall(`scan-${index + 1}`, "scan_project", {})
    ),
    finalAnswer()
  ];
}

function createMetrics() {
  return {
    modelRequests: 0,
    toolCalls: 0,
    filesRead: 0,
    returnedFileBytes: 0,
    requestCharacters: 0,
    toolResultCharacters: 0
  };
}

function measuredTools(metrics) {
  return tools.map((tool) => ({
    ...tool,
    async execute(args, context) {
      metrics.toolCalls += 1;
      if (tool.name === "read_file") metrics.filesRead += 1;
      const result = await tool.execute(args, context);
      const serialized = JSON.stringify(result.content);
      if (typeof serialized !== "string") throw new Error(`Unable to serialize ${tool.name} result content`);
      metrics.toolResultCharacters += serialized.length;
      if (tool.name === "read_file") {
        const content = result.content;
        if (result.isError || !content || typeof content !== "object" || Array.isArray(content) || typeof content.content !== "string") {
          throw new Error("Unable to derive returned file bytes from read_file result");
        }
        metrics.returnedFileBytes += Buffer.byteLength(content.content);
      }
      if (tool.name === "analyze_dependencies") {
        const content = result.content;
        if (result.isError || !content || typeof content !== "object" || Array.isArray(content) || !Number.isInteger(content.analyzedFileCount) || content.analyzedFileCount < 0) {
          throw new Error("Unable to derive analyzed source file count from analyze_dependencies result");
        }
        metrics.filesRead += content.analyzedFileCount;
      }
      return result;
    }
  }));
}

function scriptedLLM(replies, metrics) {
  let nextReply = 0;
  return {
    async generate(messages, availableTools) {
      metrics.requestCharacters += JSON.stringify({ messages, tools: availableTools }).length;
      metrics.modelRequests += 1;
      const message = replies[nextReply];
      if (!message) throw new Error("Scripted LLM exhausted its replies");
      nextReply += 1;
      return { message: structuredClone(message) };
    }
  };
}

async function runBenchmark({ fixture, rootDir, maxTurns, replies }) {
  const metrics = createMetrics();
  const start = process.hrtime.bigint();
  const agent = new Agent({
    llm: scriptedLLM(replies, metrics),
    tools: measuredTools(metrics),
    systemPrompt: "Inspect the project using the available read-only tools.",
    rootDir,
    maxTurns
  });

  let outcome;
  let turns;
  try {
    const result = await agent.run("Analyze this project.");
    outcome = "answered";
    turns = result.turns;
  } catch (error) {
    if (!(error instanceof Error) || !/maximum turns/i.test(error.message)) throw error;
    outcome = "maximum_turns";
    turns = metrics.modelRequests;
  }

  const elapsedMs = Number(process.hrtime.bigint() - start) / 1_000_000;
  return {
    fixture,
    maxTurns,
    outcome,
    turns,
    ...metrics,
    elapsedMs
  };
}

const runs = [];
for (const fixture of fixtures) {
  for (const maxTurns of [8, 16]) {
    runs.push(await runBenchmark({
      fixture: fixture.fixture,
      rootDir: fixture.rootDir,
      maxTurns,
      replies: normalReplies(fixture.entry)
    }));
  }
}

for (const maxTurns of [8, 16]) {
  runs.push(await runBenchmark({
    fixture: "capacity-boundary",
    rootDir: fixtures[0].rootDir,
    maxTurns,
    replies: capacityBoundaryReplies()
  }));
}

runs.push(await runBenchmark({
  fixture: "beyond-default",
  rootDir: fixtures[0].rootDir,
  maxTurns: 16,
  replies: beyondDefaultReplies()
}));

runs.sort((left, right) =>
  left.fixture.localeCompare(right.fixture) || left.maxTurns - right.maxTurns
);

process.stdout.write(`${JSON.stringify({
  schemaVersion: 1,
  generatedBy: "scripts/benchmark-large-project.mjs",
  runs
})}\n`);
