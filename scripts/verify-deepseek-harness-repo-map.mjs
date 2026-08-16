import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const runner = fileURLToPath(new URL("./benchmark-deepseek-harness-repo-map.mjs", import.meta.url));
const numbers = ["indexBuildMs", "mapRenderMs", "indexFiles", "indexBytes", "turns", "modelRequests", "toolCalls", "filesRead", "returnedToolBytes", "sourceBytesBeforeCorrectRead", "requestCharacters"];
function execute() { return JSON.parse(execFileSync(process.execPath, [runner], { encoding: "utf8" })); }
function stable(document) { return { ...document, runs: document.runs.map(({ indexBuildMs: _index, mapRenderMs: _map, ...run }) => run) }; }
function validate(document) {
  assert.equal(document.schemaVersion, 1);
  assert.equal(document.questions.length, 5);
  assert.equal(document.scopes.length, 2);
  assert.equal(document.runs.length, 30);
  for (const run of document.runs) {
    assert.equal(run.outcome, "answered", `${run.scope}/${run.variant}/${run.questionId} did not answer`);
    assert.notEqual(run.firstCorrectCandidateRead, null, `${run.scope}/${run.variant}/${run.questionId} did not verify source`);
    assert.ok(Array.isArray(run.topCandidates), "topCandidates must be an array");
    for (const key of numbers) assert.equal(typeof run[key], "number", `${key} must be numeric`);
  }
  for (const scope of ["full-repository", "product-source"]) for (const variant of ["map-4000", "map-8000"]) assert.equal(document.runs.filter((run) => run.scope === scope && run.variant === variant).length, 5);
}
const first = execute(), second = execute();
validate(first); validate(second); assert.deepEqual(stable(first), stable(second));
process.stdout.write("deepseek-harness repo-map evaluation verification passed\n");
