import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import { promisify } from "node:util";

const run = promisify(execFile);

await rm("dist", { recursive: true, force: true });
await run("npm", ["run", "build"], { cwd: process.cwd() });

const pkg = JSON.parse(await readFile("package.json", "utf8"));
const bin = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.[pkg.name];
assert.equal(typeof bin, "string", "package.json must declare a bin for its package name");

const { stdout } = await run(process.execPath, [bin, "--help"], { cwd: process.cwd() });
assert.match(stdout, /Usage: mini-pi/, "declared package bin must run --help after a clean build");
