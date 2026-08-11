import assert from "node:assert/strict";
import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { analyzeDependenciesTool, readFileTool, scanProjectTool } from "../src/tool.js";

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
