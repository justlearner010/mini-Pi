import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import test from "node:test";

import { analyzeDependenciesTool, buildRepositoryIndex, classifyFileArea, createQueryRepoMapTool, deriveQueryIntent, discoverRepositorySources, findCycles, queryRepositoryIndex, readFileTool, REPOSITORY_INDEX_LIMITS, scanProjectTool, type RepoMapResult, type RepositoryIndexLimits } from "../src/tool.js";

async function project(files: Record<string, string | Buffer> = {}) {
  const rootDir = await mkdtemp(join(tmpdir(), "mini-pi-tool-"));
  for (const [relativePath, content] of Object.entries(files)) {
    const path = join(rootDir, relativePath);
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, content);
  }
  return rootDir;
}

async function scan(rootDir: string) {
  const result = await scanProjectTool.execute({}, { rootDir });
  assert.equal(result.isError, false);
  return result.content as Record<string, unknown>;
}

async function analyze(rootDir: string, args: Record<string, unknown> = {}) {
  const result = await analyzeDependenciesTool.execute(args, { rootDir });
  assert.equal(result.isError, false);
  return result.content as Record<string, unknown>;
}

test("repository discovery honors gitignore, hard excludes, and source kinds", async () => {
  const rootDir = await project({
    ".gitignore": "ignored/*\n!ignored/keep.ts\n*.generated.ts\n",
    "src/a.ts": "export const a = 1",
    "src/view.tsx": "export const View = () => null",
    "src/legacy.js": "export const legacy = 1",
    "src/widget.jsx": "export const Widget = () => null",
    "types/api.d.ts": "export interface Api {}",
    "ignored/drop.ts": "export const drop = 1",
    "ignored/keep.ts": "export const keep = 1",
    "src/skip.generated.ts": "export const generated = 1",
    "node_modules/pkg/index.ts": "export const dependency = 1",
    "dist/out.js": "export const built = 1",
    ".cache/hidden.ts": "export const hidden = 1",
    "script.py": "print('unsupported')"
  });
  const result = await discoverRepositorySources(rootDir);
  assert.deepEqual(result.files.map((file) => [file.path, file.sourceKind]), [
    ["ignored/keep.ts", "ts"], ["src/a.ts", "ts"], ["src/legacy.js", "js"],
    ["src/view.tsx", "tsx"], ["src/widget.jsx", "jsx"], ["types/api.d.ts", "dts"]
  ]);
  assert.equal(result.unsupportedLanguageFiles, 1);
  assert.equal(result.truncated, false);
});

test("repository discovery records file-size and total-byte bounds", async () => {
  assert.deepEqual(REPOSITORY_INDEX_LIMITS, { maxFiles: 5_000, maxFileBytes: 512 * 1024, maxTotalBytes: 50 * 1024 * 1024 });
  const limits: RepositoryIndexLimits = { maxFiles: 10, maxFileBytes: 4, maxTotalBytes: 6 };
  const result = await discoverRepositorySources(await project({ "a.ts": "1234", "b.ts": "56", "c.ts": "7", "large.ts": "12345" }), limits);
  assert.deepEqual(result.files.map((file) => file.path), ["a.ts", "b.ts"]);
  assert.deepEqual(result.skipped, { fileLimit: 0, fileTooLarge: 1, totalBytes: 1, readError: 0 });
  assert.equal(result.inspectedBytes, 6);
  assert.equal(result.truncated, true);
});

test("repository discovery records the file-count boundary and nested gitignore scope", async () => {
  const result = await discoverRepositorySources(await project({
    "a.ts": "a", "b.ts": "b", "c.ts": "c", "nested/.gitignore": "ignored.ts\n", "nested/ignored.ts": "ignored"
  }), { maxFiles: 2, maxFileBytes: 10, maxTotalBytes: 20 });
  assert.deepEqual(result.files.map((file) => file.path), ["a.ts", "b.ts"]);
  assert.equal(result.skipped.fileLimit, 2);
  assert.equal(result.nestedGitignoreFiles, 1);
  assert.equal(result.truncated, true);
});

test("repository discovery never follows file or directory symlinks", async () => {
  const outside = await project({ "secret.ts": "secret" });
  const rootDir = await project({ "inside.ts": "inside", "real/nested.ts": "nested" });
  await symlink(join(outside, "secret.ts"), join(rootDir, "outside.ts"));
  await symlink(join(rootDir, "real"), join(rootDir, "linked"));
  const result = await discoverRepositorySources(rootDir);
  assert.deepEqual(result.files.map((file) => file.path), ["inside.ts", "real/nested.ts"]);
});

test("repository index classifies file areas and nearest package metadata", async () => {
  assert.equal(classifyFileArea("src/agent.ts"), "product");
  assert.equal(classifyFileArea("test/agent.test.ts"), "test");
  assert.equal(classifyFileArea("vendor/sdk/client.ts"), "vendor");
  assert.equal(classifyFileArea("examples/demo.ts"), "example");
  assert.equal(classifyFileArea("src/generated/types.ts"), "generated");
  const index = await buildRepositoryIndex(await project({
    "package.json": JSON.stringify({ name: "root-package", scripts: { ignored: "true" } }),
    "src/agent.ts": "export class Agent {}",
    "test/agent.test.ts": "export const test = true",
    "vendor/sdk/client.ts": "export const client = true",
    "examples/demo.ts": "export const demo = true",
    "src/generated/types.ts": "export interface Generated {}",
    "packages/core/package.json": JSON.stringify({ name: "@repo/core" }),
    "packages/core/src/engine.ts": "export function run() {}"
  }));
  assert.deepEqual(index.files.map((file) => [file.path, file.area, file.packageRoot, file.packageName]), [
    ["examples/demo.ts", "example", ".", "root-package"],
    ["packages/core/src/engine.ts", "product", "packages/core", "@repo/core"],
    ["src/agent.ts", "product", ".", "root-package"],
    ["src/generated/types.ts", "generated", ".", "root-package"],
    ["test/agent.test.ts", "test", ".", "root-package"],
    ["vendor/sdk/client.ts", "vendor", ".", "root-package"]
  ]);
});

test("repository index degrades safely for malformed and oversized package manifests", async () => {
  const rootDir = await project({
    "package.json": "{invalid",
    "src/root.ts": "export const root = true",
    "packages/invalid/package.json": "{also invalid",
    "packages/invalid/src/a.ts": "export const a = true",
    "packages/large/package.json": JSON.stringify({ name: "x".repeat(256 * 1024) }),
    "packages/large/src/b.ts": "export const b = true",
    "packages/valid/package.json": JSON.stringify({ name: "@repo/valid" }),
    "packages/valid/src/c.ts": "export const c = true"
  });
  const index = await buildRepositoryIndex(rootDir);
  assert.deepEqual(index.files.map((file) => [file.path, file.packageRoot, file.packageName]), [
    ["packages/invalid/src/a.ts", ".", undefined],
    ["packages/large/src/b.ts", ".", undefined],
    ["packages/valid/src/c.ts", "packages/valid", "@repo/valid"],
    ["src/root.ts", ".", undefined]
  ]);
  const restricted = join(rootDir, "packages", "restricted", "package.json");
  await mkdir(join(restricted, ".."), { recursive: true });
  await writeFile(restricted, JSON.stringify({ name: "@repo/restricted" }));
  await writeFile(join(rootDir, "packages", "restricted", "entry.ts"), "export const restricted = true");
  await chmod(restricted, 0o000);
  try {
    const rebuilt = await buildRepositoryIndex(rootDir);
    assert.equal(rebuilt.files.find((file) => file.path === "packages/restricted/entry.ts")?.packageName, undefined);
  } finally { await chmod(restricted, 0o600); }
});

test("repository index extracts syntax metadata without bodies or private methods", async () => {
  const rootDir = await project({
    "src/agent.ts": `import type { Tool } from "./tool.js";
import OpenAI from "openai";
export { helper } from "./helper.js";
export interface AgentConfig { tools: Tool[] }
export type Mode = "fast" | "safe";
export enum State { Ready }
export const secret = "DO_NOT_INDEX_INITIALIZER";
export function createAgent(config: AgentConfig): Agent { return new Agent(config); }
export default class Agent {
  constructor(config: AgentConfig) {}
  run(prompt: string): Promise<void> { return Promise.resolve(); }
  protected prepare(): void {}
  private leak(): string { return "DO_NOT_INDEX_BODY"; }
}
const lazy = import("./lazy.js");
import alias from "@/alias.js";`,
    "src/tool.ts": "export interface Tool { name: string }",
    "src/helper.ts": "export const helper = 1"
  });
  const index = await buildRepositoryIndex(rootDir);
  const agent = index.files.find((file) => file.path === "src/agent.ts")!;
  assert(agent);
  assert.deepEqual(agent.imports.map(({ specifier, kind, resolvedPath, exported }) => ({ specifier, kind, resolvedPath, exported })), [
    { specifier: "./helper.js", kind: "relative", resolvedPath: "src/helper.ts", exported: true },
    { specifier: "./lazy.js", kind: "dynamic", resolvedPath: undefined, exported: false },
    { specifier: "./tool.js", kind: "relative", resolvedPath: "src/tool.ts", exported: false },
    { specifier: "@/alias.js", kind: "alias", resolvedPath: undefined, exported: false },
    { specifier: "openai", kind: "package", resolvedPath: undefined, exported: false }
  ]);
  const symbols = agent.symbols.map((symbol) => `${symbol.kind}:${symbol.name}`);
  for (const expected of ["class:Agent", "method:constructor", "method:run", "function:createAgent", "interface:AgentConfig", "type:Mode", "enum:State", "variable:secret"]) assert(symbols.includes(expected), `${expected} missing from ${symbols.join(", ")}`);
  const serialized = JSON.stringify(agent);
  assert(!serialized.includes("DO_NOT_INDEX_INITIALIZER"));
  assert(!serialized.includes("DO_NOT_INDEX_BODY"));
  assert(!serialized.includes("prepare"));
  assert(!serialized.includes("leak"));
  assert.deepEqual(index.outgoing.get("src/agent.ts"), ["src/helper.ts", "src/tool.ts"]);
  assert.deepEqual(index.incoming.get("src/tool.ts"), ["src/agent.ts"]);
});

test("repository index derives exact entry basenames and caps signatures", async () => {
  const longParameters = Array.from({ length: 80 }, (_, index) => `value${index}: string`).join(", ");
  const index = await buildRepositoryIndex(await project({
    "src/index.ts": `export function long(${longParameters}): void {}`,
    "src/application.ts": "export const application = true",
    "src/cli.ts": "export const cli = true"
  }));
  assert.deepEqual(index.entryCandidates, ["src/cli.ts", "src/index.ts"]);
  const signature = index.files.find((file) => file.path === "src/index.ts")!.symbols[0];
  assert.equal(signature.signature.length, 240);
  assert.equal(signature.signatureTruncated, true);
  assert.deepEqual(signature.location, { line: 1, column: 1 });
});

test("repository index gives anonymous default declarations stable nonempty signatures", async () => {
  const index = await buildRepositoryIndex(await project({
    "class.ts": "export default class {}",
    "function.ts": "export default function (): void {}"
  }));
  const symbols = index.files.flatMap((file) => file.symbols);
  const anonymousClass = symbols.find((item) => item.name === "default class")!;
  const anonymousFunction = symbols.find((item) => item.name === "default function")!;
  assert.match(anonymousClass.signature, /export default class/);
  assert.match(anonymousFunction.signature, /export default function/);
  assert.equal(anonymousClass.exported, true);
  assert.equal(anonymousFunction.exported, true);
});

test("queryRepositoryIndex locates the five declared navigation targets", async () => {
  const index = await buildRepositoryIndex(await project({
    "src/cli.ts": `import { Agent } from "./agent.js"; import { createLLM } from "./llm.js"; export function runCli(): void {}`,
    "src/agent.ts": `import type { Tool } from "./tool.js"; import type { LLMClient } from "./llm.js"; export class Agent { run(prompt: string): Promise<void> { return Promise.resolve(); } }`,
    "src/tool.ts": `export interface Tool { execute(args: unknown): Promise<void> } export class ToolRegistry { execute(name: string): Promise<void> { return Promise.resolve(); } }`,
    "src/llm.ts": `export interface LLMProviderConfig { provider: string } export interface LLMClient {} export function createLLM(config: LLMProviderConfig): LLMClient { return {}; }`
  }));
  const cases = [
    ["Where is CLI handling implemented?", "src/cli.ts"],
    ["Which module defines the LLM provider?", "src/llm.ts"],
    ["Where is tool execution handled?", "src/tool.ts"],
    ["Which modules depend on Agent?", "src/agent.ts"],
    ["Where should I inspect provider configuration?", "src/llm.ts"]
  ] as const;
  let top1 = 0;
  for (const [query, expected] of cases) {
    const result = queryRepositoryIndex(index, query, { maxCharacters: 8_000, limit: 8 });
    assert(result.candidates.slice(0, 3).some((candidate) => candidate.path === expected), `${expected} missing for ${query}`);
    if (result.candidates[0]?.path === expected) top1 += 1;
    assert.match(result.text, /REPO MAP/);
    assert.match(result.text, /source bodies not inspected/);
    assert.match(result.text, /index truncated: no/);
    assert.match(result.text, /map truncated: no/);
  }
  assert(top1 >= 4, `only ${top1}/5 Top-1 matches`);
});

test("scope-aware Repo Map ranking prefers requested implementation areas with explicit reasons", async () => {
  assert.deepEqual(deriveQueryIntent("Where is the CLI provider adapter?"), {
    tokens: ["where", "is", "the", "cli", "provider", "adapter"], requestedAreas: [],
    roles: ["cli", "adapter"], implementationSeeking: true
  });
  assert.deepEqual(deriveQueryIntent("Inspect generated vendor test fixtures"), {
    tokens: ["inspect", "generated", "vendor", "test", "fixtures"],
    requestedAreas: ["test", "vendor", "generated"], roles: [], implementationSeeking: false
  });
  assert.deepEqual(deriveQueryIntent("unrelated mystery"), {
    tokens: ["unrelated", "mystery"], requestedAreas: [], roles: [], implementationSeeking: false
  });
  const index = await buildRepositoryIndex(await project({
    "packages/cli/package.json": JSON.stringify({ name: "@repo/cli" }),
    "packages/cli/src/bin.ts": "export function runCli() {}",
    "packages/core/src/agent.ts": "export class Agent { run() {} }",
    "packages/llm/package.json": JSON.stringify({ name: "@repo/llm" }),
    "packages/llm/src/adapter.ts": "export class DeepSeekAdapter {}",
    "packages/tools/src/registry.ts": "export class ToolRegistry { execute() {} }",
    "packages/llm/test/adapter.test.ts": "export const adapterTest = true",
    "vendor/adapter.ts": "export class ExternalClient {}"
  }));
  const implementation = queryRepositoryIndex(index, "Where is the DeepSeek LLM provider adapter?", { maxCharacters: 8_000, limit: 8 });
  assert.equal(implementation.candidates[0]?.path, "packages/llm/src/adapter.ts");
  assert(implementation.candidates[0]?.reasons.includes("scope: product"));
  assert(implementation.candidates[0]?.reasons.includes("role: adapter"));
  assert.equal(implementation.candidates[0]?.packageName, "@repo/llm");
  const tests = queryRepositoryIndex(index, "Which adapter test covers DeepSeek?", { maxCharacters: 8_000, limit: 8 });
  assert.equal(tests.candidates[0]?.path, "packages/llm/test/adapter.test.ts");
  const vendor = queryRepositoryIndex(index, "Which vendor adapter is used?", { maxCharacters: 8_000, limit: 8 });
  assert.equal(vendor.candidates[0]?.path, "vendor/adapter.ts");
  assert(vendor.candidates.every((candidate) => candidate.reasons.length <= 3));
});

test("Repo Map renders confidence and scoped candidates within fixed budgets", async () => {
  const index = await buildRepositoryIndex(await project({
    "package.json": JSON.stringify({ name: "@repo/root" }),
    "src/adapter.ts": "export class DeepSeekAdapter {}",
    "src/other-adapter.ts": "export class OtherAdapter {}",
    "src/index.ts": "export const index = true"
  }));
  const high = queryRepositoryIndex(index, "DeepSeek adapter", { maxCharacters: 4_000, limit: 8 });
  assert.equal(high.confidence, "high");
  assert.match(high.text, /src\/adapter\.ts  \[product · package @repo\/root\]/);
  assert.match(high.text, /reason: exact symbol match; scope: product; role: adapter/);
  assert(high.text.length <= 4_000);
  const ambiguous = queryRepositoryIndex(index, "adapter", { maxCharacters: 8_000, limit: 8 });
  assert.equal(ambiguous.confidence, "ambiguous");
  const fallback = queryRepositoryIndex(index, "unmatched mystery", { maxCharacters: 8_000, limit: 8 });
  assert.equal(fallback.confidence, "fallback");
  assert.match(fallback.text, /confidence: fallback/);
});

test("queryRepositoryIndex expands one hop, falls back to entries, and caps complete lines", async () => {
  const index = await buildRepositoryIndex(await project({
    "src/index.ts": `import { target } from "./target.js"; export const start = target`,
    "src/target.ts": `export function target(): void {}`,
    ...Object.fromEntries(Array.from({ length: 100 }, (_, index) => [`src/neighbor-${String(index).padStart(3, "0")}.ts`, `import { target } from "./target.js"; export const n${index} = target`]))
  }));
  const matched = queryRepositoryIndex(index, "target", { maxCharacters: 4_000, limit: 8 });
  assert.equal(matched.candidates[0].path, "src/target.ts");
  assert(matched.candidates.slice(1).some((candidate) => candidate.path === "src/index.ts"));
  assert(matched.text.length <= 4_000);
  assert.match(matched.text, /map truncated: yes/);
  assert(!matched.text.endsWith("src/"));
  const fallback = queryRepositoryIndex(index, "unrelated mystery", { maxCharacters: 8_000, limit: 1 });
  assert.equal(fallback.candidates[0].path, "src/index.ts");
  assert(fallback.candidates[0].reasons.includes("fallback candidate"));
});

test("query_repo_map is SAFE, strict, bounded, and index-only", async () => {
  const index = await buildRepositoryIndex(await project({ "src/llm.ts": "export interface ProviderConfig { model: string }" }));
  const tool = createQueryRepoMapTool(index);
  assert.equal(tool.name, "query_repo_map");
  assert.equal(tool.permission, "SAFE");
  assert.deepEqual(tool.parameters, {
    type: "object",
    properties: { query: { type: "string", minLength: 1 }, limit: { type: "integer", minimum: 1, maximum: 8 } },
    required: ["query"],
    additionalProperties: false
  });
  const result = await tool.execute({ query: "provider", limit: 3 }, { rootDir: "/does-not-exist" });
  assert.equal(result.isError, false);
  assert((result.content as RepoMapResult).text.length <= 8_000);
  assert.equal(typeof result.historyContent, "string");
  assert([...result.historyContent!].length <= 512);
  for (const args of [{}, { query: "" }, { query: "x", limit: 0 }, { query: "x", limit: 9 }, { query: "x", limit: 1.5 }, { query: "x", extra: true }, []]) {
    assert.equal((await tool.execute(args, { rootDir: "/does-not-exist" })).isError, true);
  }
});

test("scan discovers README, manifests, supported files, and stable ordering", async () => {
  const rootDir = await project({
    "README.md": "# demo",
    "package.json": "{}",
    "tsconfig.json": "{}",
    "z.ts": "",
    "a.py": "",
    "notes/idea.md": "",
    "data/config.json": "{}"
  });
  const result = await scan(rootDir);
  assert.equal(result.readmePath, "README.md");
  assert.deepEqual(result.manifestPaths, ["package.json", "tsconfig.json"]);
  assert.deepEqual(result.sourceFiles, ["z.ts"]);
  assert.deepEqual(result.unsupportedFiles, ["a.py"]);
  assert.equal(result.tree, "README.md\na.py\ndata/config.json\nnotes/idea.md\npackage.json\ntsconfig.json\nz.ts");
  assert.equal(result.totalRelevantFiles, 7);
  assert.equal(result.returnedFileCount, 7);
  assert.equal(result.truncated, false);
});

test("scan handles a project without a README", async () => {
  const result = await scan(await project({ "index.ts": "export {};" }));
  assert.equal(result.readmePath, null);
});

test("scan ignores build artifacts and all hidden directories", async () => {
  const result = await scan(await project({
    "index.ts": "",
    "node_modules/nope.ts": "",
    ".git/config": "",
    "dist/app.js": "",
    "build/app.py": "",
    "coverage/out.json": "{}",
    ".cache/a.ts": ""
  }));
  assert.equal(result.tree, "index.ts");
});

test("scan reports common unsupported source files separately", async () => {
  const result = await scan(await project({ "main.ts": "", "script.py": "", "native.rs": "", "web.go": "", "app.java": "" }));
  assert.deepEqual(result.sourceFiles, ["main.ts"]);
  assert.deepEqual(result.unsupportedFiles, ["app.java", "native.rs", "script.py", "web.go"]);
});

test("scan returns only the first 500 sorted relevant files", async () => {
  const files: Record<string, string> = {};
  for (let i = 0; i < 501; i += 1) files[`src/${String(i).padStart(3, "0")}.ts`] = "";
  const result = await scan(await project(files));
  assert.equal(result.totalRelevantFiles, 501);
  assert.equal(result.returnedFileCount, 500);
  assert.equal(result.truncated, true);
  assert.deepEqual((result.tree as string).split("\n").slice(0, 2), ["src/000.ts", "src/001.ts"]);
  assert.equal((result.tree as string).split("\n").at(-1), "src/499.ts");
  assert.equal((result.sourceFiles as string[]).length, 500);
});

test("scan exposes a handwritten schema and scans a requested in-root subdirectory", async () => {
  const rootDir = await project({ "outside.ts": "", "nested/inside.ts": "", "nested/tsconfig.app.json": "{}" });
  assert.deepEqual(scanProjectTool.parameters, {
    type: "object",
    properties: { path: { type: "string", description: "Optional relative directory to scan" } },
    additionalProperties: false
  });
  const result = await scanProjectTool.execute({ path: "nested" }, { rootDir });
  assert.equal(result.isError, false);
  assert.deepEqual(result.content, {
    scannedPath: "nested",
    readmePath: null,
    manifestPaths: ["nested/tsconfig.app.json"],
    sourceFiles: ["nested/inside.ts"],
    unsupportedFiles: [],
    tree: "nested/inside.ts\nnested/tsconfig.app.json",
    totalRelevantFiles: 2,
    returnedFileCount: 2,
    truncated: false
  });
});

test("scan rejects non-string and escaping paths", async () => {
  const rootDir = await project({ "safe.ts": "" });
  assert.equal((await scanProjectTool.execute({ path: "../outside" }, { rootDir })).isError, true);
  assert.equal((await scanProjectTool.execute({ path: 12 }, { rootDir })).isError, true);
});

test("read rejects paths that escape the project", async () => {
  const rootDir = await project({ "safe.txt": "ok" });
  const result = await readFileTool.execute({ path: "../outside.txt" }, { rootDir });
  assert.equal(result.isError, true);
});

test("read rejects nested traversal and paths in a same-prefix sibling directory", async () => {
  const rootDir = await project({ "nested/safe.txt": "ok" });
  const sibling = `${rootDir}-sibling`;
  await mkdir(sibling);
  await writeFile(join(sibling, "secret.txt"), "secret");
  assert.equal((await readFileTool.execute({ path: "nested/../../outside.txt" }, { rootDir })).isError, true);
  assert.equal((await readFileTool.execute({ path: `../${sibling.split("/").at(-1)}/secret.txt` }, { rootDir })).isError, true);
});

test("read rejects symlink paths even when their target is inside the project", async () => {
  const rootDir = await project({ "safe.txt": "ok" });
  await symlink(join(rootDir, "safe.txt"), join(rootDir, "link.txt"));
  const result = await readFileTool.execute({ path: "link.txt" }, { rootDir });
  assert.equal(result.isError, true);
});

test("read rejects symlinks whose target is outside the project", async () => {
  const rootDir = await project({ "safe.txt": "ok" });
  const outside = await project({ "secret.txt": "secret" });
  await symlink(join(outside, "secret.txt"), join(rootDir, "outside-link.txt"));
  assert.equal((await readFileTool.execute({ path: "outside-link.txt" }, { rootDir })).isError, true);
});

test("read returns complete small text files with line metadata", async () => {
  const rootDir = await project({ "note.txt": "one\ntwo\nthree" });
  const result = await readFileTool.execute({ path: "note.txt" }, { rootDir });
  assert.equal(result.isError, false);
  assert.deepEqual(result.content, { path: "note.txt", startLine: 1, endLine: 3, totalLines: 3, content: "one\ntwo\nthree", truncated: false });
});

test("read honors inclusive line ranges", async () => {
  const rootDir = await project({ "note.txt": "one\ntwo\nthree\nfour" });
  const result = await readFileTool.execute({ path: "note.txt", startLine: 2, endLine: 3 }, { rootDir });
  assert.equal(result.isError, false);
  assert.deepEqual(result.content, { path: "note.txt", startLine: 2, endLine: 3, totalLines: 4, content: "two\nthree", truncated: false });
});

test("read truncates at 300 lines when no end line is supplied", async () => {
  const lines = Array.from({ length: 301 }, (_, i) => `line ${i + 1}`);
  const result = await readFileTool.execute({ path: "long.txt" }, { rootDir: await project({ "long.txt": lines.join("\n") }) });
  assert.equal(result.isError, false);
  assert.equal((result.content as Record<string, unknown>).startLine, 1);
  assert.equal((result.content as Record<string, unknown>).endLine, 300);
  assert.equal((result.content as Record<string, unknown>).truncated, true);
});

test("read truncates text output at 256 KB without splitting UTF-8 characters", async () => {
  const rootDir = await project({ "large.txt": "你".repeat(100_000) });
  const result = await readFileTool.execute({ path: "large.txt" }, { rootDir });
  assert.equal(result.isError, false);
  const content = result.content as Record<string, unknown>;
  assert.equal(content.truncated, true);
  assert.ok(Buffer.byteLength(content.content as string, "utf8") <= 256 * 1024);
  assert.match(content.content as string, /你$/);
});

test("read observes exact 255 KB, 256 KB, and 257 KB byte boundaries", async () => {
  const rootDir = await project({
    "255.txt": "x".repeat(255 * 1024),
    "256.txt": "x".repeat(256 * 1024),
    "257.txt": "x".repeat(257 * 1024)
  });
  for (const [path, expectedTruncated, expectedBytes] of [["255.txt", false, 255 * 1024], ["256.txt", false, 256 * 1024], ["257.txt", true, 256 * 1024]] as const) {
    const result = await readFileTool.execute({ path }, { rootDir });
    assert.equal(result.isError, false);
    const content = result.content as Record<string, unknown>;
    assert.equal(content.truncated, expectedTruncated);
    assert.equal(Buffer.byteLength(content.content as string, "utf8"), expectedBytes);
  }
});

test("read rejects binary and non-existent files", async () => {
  const rootDir = await project({ "image.bin": Buffer.from([0, 1, 2]), "jpeg.bin": Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0x11, 0x22]), "exists.txt": "yes" });
  const binary = await readFileTool.execute({ path: "image.bin" }, { rootDir });
  const jpeg = await readFileTool.execute({ path: "jpeg.bin" }, { rootDir });
  const missing = await readFileTool.execute({ path: "missing.txt" }, { rootDir });
  assert.equal(binary.isError, true);
  assert.equal(jpeg.isError, true);
  assert.equal(missing.isError, true);
});

test("read rejects unknown arguments", async () => {
  const result = await readFileTool.execute({ path: "safe.txt", unexpected: true }, { rootDir: await project({ "safe.txt": "ok" }) });
  assert.equal(result.isError, true);
});

test("dependency analysis uses the TypeScript parser for static forms but ignores comments and strings", async () => {
  const result = await analyze(await project({
    "src/main.ts": [
      'import value from "./value.js";',
      'import type { Shape } from "./types.js";',
      'import "./setup";',
      'export { helper } from "./helper";',
      'export * from "./barrel";',
      'export const from = "./not-a-dependency";',
      '// import "./comment";',
      'const pretend = "import \\\"./string\\\"";'
    ].join("\n"),
    "src/value.ts": "export default 1;",
    "src/types.ts": "export type Shape = {};",
    "src/setup.ts": "",
    "src/helper.ts": "export const helper = 1;",
    "src/barrel.ts": ""
  }));
  assert.deepEqual(result.edges, [
    { from: "src/main.ts", to: "src/barrel.ts", specifier: "./barrel", kind: "export", typeOnly: false },
    { from: "src/main.ts", to: "src/helper.ts", specifier: "./helper", kind: "export", typeOnly: false },
    { from: "src/main.ts", to: "src/setup.ts", specifier: "./setup", kind: "import", typeOnly: false },
    { from: "src/main.ts", to: "src/types.ts", specifier: "./types.js", kind: "import", typeOnly: true },
    { from: "src/main.ts", to: "src/value.ts", specifier: "./value.js", kind: "import", typeOnly: false }
  ]);
  assert.equal(result.totalEdgeCount, 5);
  assert.equal(result.returnedEdgeCount, 5);
  assert.equal(result.truncated, false);
  assert.deepEqual(result.unresolved, []);
});

test("dependency analysis resolves extensions and index files, and classifies builtins and packages", async () => {
  const result = await analyze(await project({
    "main.ts": 'import "node:fs"; import "path"; import "react/jsx-runtime"; import "@scope/pkg/subpath"; import "./dir"; import "./view.jsx";',
    "dir/index.tsx": "",
    "view.jsx": ""
  }));
  assert.deepEqual(result.edges, [
    { from: "main.ts", to: "dir/index.tsx", specifier: "./dir", kind: "import", typeOnly: false },
    { from: "main.ts", to: "view.jsx", specifier: "./view.jsx", kind: "import", typeOnly: false }
  ]);
  assert.deepEqual(result.builtins, [
    { from: "main.ts", specifier: "node:fs" },
    { from: "main.ts", specifier: "path" }
  ]);
  assert.deepEqual(result.packages, [
    { from: "main.ts", packageName: "@scope/pkg", specifier: "@scope/pkg/subpath" },
    { from: "main.ts", packageName: "react", specifier: "react/jsx-runtime" }
  ]);
});

test("dependency analysis explicitly reports aliases, missing files, and unsupported relative files", async () => {
  const result = await analyze(await project({
    "main.ts": 'import "@/app"; import "./missing"; import "./native.py";',
    "native.py": "print('x')"
  }));
  assert.deepEqual(result.unresolved, [
    { from: "main.ts", specifier: "./missing", kind: "import", typeOnly: false, reason: "missing" },
    { from: "main.ts", specifier: "./native.py", kind: "import", typeOnly: false, reason: "unsupported" },
    { from: "main.ts", specifier: "@/app", kind: "import", typeOnly: false, reason: "alias" }
  ]);
  assert.deepEqual(result.unsupportedFiles, ["native.py"]);
});

test("dependency analysis reports canonical deduplicated self, two-node, and multi-node cycles", async () => {
  const result = await analyze(await project({
    "a.ts": 'import "./a"; import "./b";',
    "b.ts": 'import "./c"; import "./d";',
    "c.ts": 'import "./a";',
    "d.ts": 'import "./b";'
  }));
  assert.deepEqual(result.cycles, [
    ["a.ts", "a.ts"],
    ["a.ts", "b.ts", "c.ts", "a.ts"],
    ["b.ts", "d.ts", "b.ts"]
  ]);
});

test("dependency analysis finds overlapping simple cycles from the same graph", async () => {
  const result = await analyze(await project({
    "a.ts": 'import "./b"; import "./c";',
    "b.ts": 'import "./c";',
    "c.ts": 'import "./a";'
  }));
  assert.deepEqual(result.cycles, [
    ["a.ts", "b.ts", "c.ts", "a.ts"],
    ["a.ts", "c.ts", "a.ts"]
  ]);
});

test("cycle discovery ignores earlier sorted non-SCC neighbors without exhausting its step budget", () => {
  const files = ["a.ts", "b.ts"];
  const edges = [
    ...Array.from({ length: 100_001 }, (_, index) => ({
      from: "a.ts",
      to: `acyclic-${String(index).padStart(6, "0")}.ts`,
      specifier: "",
      kind: "import" as const,
      typeOnly: false
    })),
    { from: "a.ts", to: "b.ts", specifier: "", kind: "import" as const, typeOnly: false },
    { from: "b.ts", to: "a.ts", specifier: "", kind: "import" as const, typeOnly: false }
  ];

  const result = findCycles(files, edges);

  assert.deepEqual(result.cycles, [["a.ts", "b.ts", "a.ts"]]);
  assert.equal(result.truncated, false);
});

test("dependency analysis finishes layered diamond DAGs without reporting cycles", async () => {
  const files: Record<string, string> = { "root.ts": 'import "./layer-0-a"; import "./layer-0-b";' };
  for (let layer = 0; layer < 23; layer += 1) {
    const imports = layer === 22 ? "" : `import "./layer-${layer + 1}-a"; import "./layer-${layer + 1}-b";`;
    files[`layer-${layer}-a.ts`] = imports;
    files[`layer-${layer}-b.ts`] = imports;
  }
  const started = performance.now();
  const result = await analyze(await project(files));
  assert.ok(performance.now() - started < 1_000);
  assert.deepEqual(result.cycles, []);
  assert.equal(result.truncated, false);
});

test("dependency analysis caps returned edges while preserving stable total counts", async () => {
  const files: Record<string, string> = { "main.ts": Array.from({ length: 501 }, (_, i) => `import "./parts/${i}";`).join("\n") };
  for (let i = 0; i < 501; i += 1) files[`parts/${i}.ts`] = "";
  const result = await analyze(await project(files));
  assert.equal(result.analyzedFileCount, 502);
  assert.equal(result.totalEdgeCount, 501);
  assert.equal(result.returnedEdgeCount, 500);
  assert.equal(result.truncated, true);
  assert.equal((result.edges as { specifier: string }[])[0].specifier, "./parts/0");
});

test("dependency analysis validates an entry, constrains it to path, and renders a repeat-aware tree", async () => {
  const rootDir = await project({
    "src/main.ts": 'import "./left"; import "./right";',
    "src/left.ts": 'import "./shared";',
    "src/right.ts": 'import "./shared"; import "./main";',
    "src/shared.ts": "",
    "other.ts": ""
  });
  const result = await analyze(rootDir, { path: "src", entry: "src/main.ts" });
  assert.deepEqual(result, {
    analyzedPath: "src",
    entry: "src/main.ts",
    analyzedFiles: ["src/left.ts", "src/main.ts", "src/right.ts", "src/shared.ts"],
    unsupportedFiles: [],
    edges: [
      { from: "src/left.ts", to: "src/shared.ts", specifier: "./shared", kind: "import", typeOnly: false },
      { from: "src/main.ts", to: "src/left.ts", specifier: "./left", kind: "import", typeOnly: false },
      { from: "src/main.ts", to: "src/right.ts", specifier: "./right", kind: "import", typeOnly: false },
      { from: "src/right.ts", to: "src/main.ts", specifier: "./main", kind: "import", typeOnly: false },
      { from: "src/right.ts", to: "src/shared.ts", specifier: "./shared", kind: "import", typeOnly: false }
    ],
    builtins: [], packages: [], unresolved: [],
    cycles: [["src/main.ts", "src/right.ts", "src/main.ts"]],
    entryTree: "src/main.ts\n  src/left.ts\n    src/shared.ts\n  src/right.ts\n    src/main.ts [cycle]\n    src/shared.ts [already shown]",
    analyzedFileCount: 4, totalEdgeCount: 5, returnedEdgeCount: 5, truncated: false
  });
  assert.equal((await analyzeDependenciesTool.execute({ entry: "other.ts" }, { rootDir })).isError, false);
  assert.equal((await analyzeDependenciesTool.execute({ path: "src", entry: "other.ts" }, { rootDir })).isError, true);
  assert.equal((await analyzeDependenciesTool.execute({ entry: "missing.ts" }, { rootDir })).isError, true);
});
