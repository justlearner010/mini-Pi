import assert from "node:assert/strict";
import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { readFileTool, scanProjectTool } from "../src/tool.js";

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
  assert.deepEqual(result.sourceFiles, ["a.py", "z.ts"]);
  assert.deepEqual(result.tree, ["README.md", "a.py", "data/config.json", "notes/idea.md", "package.json", "tsconfig.json", "z.ts"]);
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
  assert.deepEqual(result.tree, ["index.ts"]);
});

test("scan reports common unsupported source files separately", async () => {
  const result = await scan(await project({ "main.ts": "", "native.rs": "", "web.go": "", "app.java": "" }));
  assert.deepEqual(result.sourceFiles, ["main.ts"]);
  assert.deepEqual(result.unsupportedFiles, ["app.java", "native.rs", "web.go"]);
});

test("scan returns only the first 500 sorted relevant files", async () => {
  const files: Record<string, string> = {};
  for (let i = 0; i < 501; i += 1) files[`src/${String(i).padStart(3, "0")}.ts`] = "";
  const result = await scan(await project(files));
  assert.equal(result.totalRelevantFiles, 501);
  assert.equal(result.returnedFileCount, 500);
  assert.equal(result.truncated, true);
  assert.deepEqual((result.tree as string[]).slice(0, 2), ["src/000.ts", "src/001.ts"]);
  assert.equal((result.tree as string[]).at(-1), "src/499.ts");
});

test("read rejects paths that escape the project", async () => {
  const rootDir = await project({ "safe.txt": "ok" });
  const result = await readFileTool.execute({ path: "../outside.txt" }, { rootDir });
  assert.equal(result.isError, true);
});

test("read rejects symlink paths even when their target is inside the project", async () => {
  const rootDir = await project({ "safe.txt": "ok" });
  await symlink(join(rootDir, "safe.txt"), join(rootDir, "link.txt"));
  const result = await readFileTool.execute({ path: "link.txt" }, { rootDir });
  assert.equal(result.isError, true);
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

test("read rejects binary and non-existent files", async () => {
  const rootDir = await project({ "image.bin": Buffer.from([0, 1, 2]), "exists.txt": "yes" });
  const binary = await readFileTool.execute({ path: "image.bin" }, { rootDir });
  const missing = await readFileTool.execute({ path: "missing.txt" }, { rootDir });
  assert.equal(binary.isError, true);
  assert.equal(missing.isError, true);
});
