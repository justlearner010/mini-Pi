import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const runner = fileURLToPath(new URL("./benchmark-deepseek-harness-repo-map.mjs", import.meta.url));
const numbers = ["indexBuildMs", "mapRenderMs", "indexFiles", "indexBytes", "turns", "modelRequests", "toolCalls", "filesRead", "returnedToolBytes", "sourceBytesBeforeCorrectRead", "requestCharacters"];
function execute() { return JSON.parse(execFileSync(process.execPath, [runner], { encoding: "utf8" })); }
function stable(document) { return { ...document, runs: document.runs.map(({ indexBuildMs: _index, mapRenderMs: _map, ...run }) => run) }; }
function validate(document) {
  assert.equal(document.schemaVersion, 2);
  assert.equal(document.questions.length, 5);
  assert.equal(document.scopes.length, 2);
  assert.equal(document.runs.length, 30);
  for (const run of document.runs) {
    assert.equal(run.outcome, "answered", `${run.scope}/${run.variant}/${run.questionId} did not answer`);
    assert.notEqual(run.firstCorrectCandidateRead, null, `${run.scope}/${run.variant}/${run.questionId} did not verify source`);
    assert.ok(Array.isArray(run.topCandidates), "topCandidates must be an array");
    assert.ok(Array.isArray(run.candidateReasons), "candidateReasons must be an array");
    assert.ok(Array.isArray(run.candidateAreas), "candidateAreas must be an array");
    assert.ok(Array.isArray(run.candidatePackages), "candidatePackages must be an array");
    assert.ok(["none", "high", "ambiguous", "fallback"].includes(run.confidence), "confidence must be known");
    assert(run.candidateReasons.every((reasons) => Array.isArray(reasons) && reasons.length <= 3), "candidate reasons must be bounded");
    for (const key of numbers) assert.equal(typeof run[key], "number", `${key} must be numeric`);
  }
  for (const scope of ["full-repository", "product-source"]) for (const variant of ["map-4000", "map-8000"]) assert.equal(document.runs.filter((run) => run.scope === scope && run.variant === variant).length, 5);
  const product = document.runs.filter((run) => run.scope === "product-source" && run.variant === "map-4000");
  assert(product.filter((run) => run.top3).length >= 4, "product map-4000 Top-3 must be at least 4/5");
  assert(product.filter((run) => run.top1).length >= 3, "product map-4000 Top-1 must be at least 3/5");
}
const first = execute(), second = execute();
validate(first); validate(second); assert.deepEqual(stable(first), stable(second));
process.stdout.write("deepseek-harness repo-map evaluation verification passed\n");
