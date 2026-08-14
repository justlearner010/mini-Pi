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

function overLimitReplies() {
  return [
    ...Array.from({ length: 9 }, (_, index) =>
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
      metrics.returnedFileBytes += Buffer.byteLength(serialized);
      metrics.toolResultCharacters += serialized.length;
      return result;
    }
  }));
}

function scriptedLLM(replies, metrics) {
  let nextReply = 0;
  return {
    async generate(messages) {
      metrics.requestCharacters += JSON.stringify(messages).length;
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
    fixture: "over-limit",
    rootDir: fixtures[0].rootDir,
    maxTurns,
    replies: overLimitReplies()
  }));
}

runs.sort((left, right) =>
  left.fixture.localeCompare(right.fixture) || left.maxTurns - right.maxTurns
);

process.stdout.write(`${JSON.stringify({
  schemaVersion: 1,
  generatedBy: "scripts/benchmark-large-project.mjs",
  runs
})}\n`);
