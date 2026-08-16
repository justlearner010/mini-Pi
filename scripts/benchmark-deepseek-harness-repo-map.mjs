import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { Agent } from "../dist/src/agent.js";
import { buildRepositoryIndex, createQueryRepoMapTool, queryRepositoryIndex, tools } from "../dist/src/tool.js";

const rootDir = "/Users/jay/deepseek-harness";
const questions = [
  { id: "cli-bin", prompt: "Where does the dsh CLI start?", expectedPaths: ["apps/cli/src/bin.ts"] },
  { id: "agent-loop", prompt: "Where is the default Agent loop implemented?", expectedPaths: ["packages/core/agent-loop/src/agent.ts"] },
  { id: "tools", prompt: "Where is the core tool registry implemented?", expectedPaths: ["packages/core/tools/src/index.ts"] },
  { id: "deepseek-adapter", prompt: "Where is the DeepSeek LLM adapter implemented?", expectedPaths: ["packages/llm/llm-deepseek/src/adapter.ts"] },
  { id: "basic-compaction", prompt: "Where is basic context compaction implemented?", expectedPaths: ["packages/compaction/compaction-basic/src/index.ts"] }
];
const productPrefix = ["apps/", "packages/", "scripts/", "native/"];
const excludedProductPath = /(^|\/)(?:tests?|fixtures?|__tests__|dist|build|generated|coverage)(?:\/|$)/;

async function productSourceIndex(index) {
  const files = index.files.filter((file) => productPrefix.some((prefix) => file.path.startsWith(prefix)) && !excludedProductPath.test(file.path) && !file.path.startsWith("packages/test-support/"));
  const paths = new Set(files.map((file) => file.path));
  const graph = (source) => new Map(files.map((file) => [file.path, (source.get(file.path) ?? []).filter((path) => paths.has(path))]));
  const inspectedBytes = (await Promise.all(files.map((file) => readFile(join(rootDir, file.path)).then((value) => value.byteLength)))).reduce((total, bytes) => total + bytes, 0);
  return { ...index, files, incoming: graph(index.incoming), outgoing: graph(index.outgoing), entryCandidates: index.entryCandidates.filter((path) => paths.has(path)), inspectedFileCount: files.length, inspectedBytes };
}

function toolCall(id, name, arguments_) { return { role: "assistant", content: null, toolCalls: [{ id, name, arguments: JSON.stringify(arguments_) }] }; }
function repliesFor(variant, expectedPath, topPath) {
  if (variant === "none") return [toolCall("read-readme", "read_file", { path: "README.md" }), toolCall("read-candidate", "read_file", { path: expectedPath }), { role: "assistant", content: `Verified ${expectedPath}`, toolCalls: [] }];
  const candidate = topPath ?? expectedPath;
  const calls = [toolCall("read-top", "read_file", { path: candidate })];
  if (candidate !== expectedPath) calls.push(toolCall("read-expected", "read_file", { path: expectedPath }));
  return [...calls, { role: "assistant", content: `Verified ${expectedPath}`, toolCalls: [] }];
}

function measuredTools(available, expectedPaths, metrics) {
  return available.map((tool) => ({ ...tool, async execute(args, context) {
    metrics.toolCalls += 1;
    metrics.toolCallsByName[tool.name] = (metrics.toolCallsByName[tool.name] ?? 0) + 1;
    const path = tool.name === "read_file" && args && typeof args === "object" && typeof args.path === "string" ? args.path : undefined;
    const correct = path !== undefined && expectedPaths.includes(path);
    const result = await tool.execute(args, context);
    metrics.returnedToolBytes += Buffer.byteLength(JSON.stringify(result.content));
    if (tool.name === "read_file" && !result.isError && result.content && typeof result.content === "object" && typeof result.content.content === "string") {
      metrics.filesRead += 1;
      if (correct && metrics.firstCorrectCandidateRead === null) metrics.firstCorrectCandidateRead = metrics.toolCalls;
      else if (metrics.firstCorrectCandidateRead === null) metrics.sourceBytesBeforeCorrectRead += Buffer.byteLength(result.content.content);
    }
    return result;
  } }));
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

const targetCommit = execFileSync("git", ["-C", rootDir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const started = process.hrtime.bigint();
const fullIndex = await buildRepositoryIndex(rootDir);
const indexBuildMs = Number(process.hrtime.bigint() - started) / 1_000_000;
const scopes = [{ id: "full-repository", index: fullIndex }, { id: "product-source", index: await productSourceIndex(fullIndex) }];
const runs = [];

for (const scope of scopes) for (const variant of ["none", "map-4000", "map-8000"]) for (const question of questions) {
  const maxCharacters = variant === "map-4000" ? 4_000 : 8_000;
  const rendered = process.hrtime.bigint();
  const map = variant === "none" ? undefined : queryRepositoryIndex(scope.index, question.prompt, { maxCharacters, limit: 8 });
  const mapRenderMs = variant === "none" ? 0 : Number(process.hrtime.bigint() - rendered) / 1_000_000;
  const topPath = map?.candidates[0]?.path;
  const metrics = { modelRequests: 0, toolCalls: 0, toolCallsByName: {}, filesRead: 0, returnedToolBytes: 0, sourceBytesBeforeCorrectRead: 0, requestCharacters: 0, firstCorrectCandidateRead: null };
  const available = map ? [...tools, createQueryRepoMapTool(scope.index)] : tools;
  const agent = new Agent({ llm: scriptedLLM(repliesFor(variant, question.expectedPaths[0], topPath), metrics), tools: measuredTools(available, question.expectedPaths, metrics), rootDir, systemPrompt: "Use repository evidence to identify and verify the requested implementation." });
  let outcome = "answered", turns = 0;
  try { turns = (await agent.run(question.prompt, map ? { transientContext: map.text } : undefined)).turns; }
  catch (error) { outcome = error instanceof Error && /maximum turns/i.test(error.message) ? "maximum_turns" : "failed"; turns = metrics.modelRequests; }
  runs.push({ scope: scope.id, variant, questionId: question.id, outcome, topCandidates: map?.candidates.slice(0, 3).map((candidate) => candidate.path) ?? [], top1: map ? question.expectedPaths.includes(topPath) : false, top3: map ? map.candidates.slice(0, 3).some((candidate) => question.expectedPaths.includes(candidate.path)) : false, indexBuildMs, mapRenderMs, indexFiles: scope.index.inspectedFileCount, indexBytes: scope.index.inspectedBytes, indexTruncated: scope.index.truncated, mapTruncated: map?.mapTruncated ?? false, turns, ...metrics, toolCallsByName: Object.fromEntries(Object.entries(metrics.toolCallsByName).sort(([left], [right]) => left.localeCompare(right))) });
}

runs.sort((left, right) => left.scope.localeCompare(right.scope) || left.variant.localeCompare(right.variant) || left.questionId.localeCompare(right.questionId));
process.stdout.write(`${JSON.stringify({ schemaVersion: 1, target: { repository: "deepseek-harness", commit: targetCommit }, questions, scopes: scopes.map(({ id, index }) => ({ id, indexedFiles: index.inspectedFileCount, indexedBytes: index.inspectedBytes, truncated: index.truncated, skipped: index.skipped })), runs })}\n`);
