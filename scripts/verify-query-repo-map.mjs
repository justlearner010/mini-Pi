import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const runner = fileURLToPath(new URL("./benchmark-query-repo-map.mjs", import.meta.url));
const numeric = ["indexBuildMs", "mapRenderMs", "turns", "modelRequests", "toolCalls", "filesRead", "returnedToolBytes", "sourceBytesBeforeCorrectRead", "requestCharacters"];

function execute() { return JSON.parse(execFileSync(process.execPath, [runner], { encoding: "utf8" })); }
function stable(document) { return { ...document, runs: document.runs.map(({ indexBuildMs: _index, mapRenderMs: _map, ...run }) => run) }; }
function median(values) { const sorted = [...values].sort((a, b) => a - b); return sorted[Math.floor(sorted.length / 2)]; }
function reduction(before, after) { return before === 0 ? (after === 0 ? 0 : -Infinity) : (before - after) / before; }

function validate(document) {
  assert.equal(document.schemaVersion, 1);
  assert.equal(document.questions.length, 5);
  assert.equal(document.runs.length, 15);
  for (const run of document.runs) {
    assert(["none", "map-4000", "map-8000"].includes(run.variant));
    assert.equal(run.outcome, "answered", `${run.variant}/${run.questionId} did not answer`);
    assert.equal(typeof run.top1, "boolean");
    assert.equal(typeof run.top3, "boolean");
    assert(run.firstCorrectCandidateRead !== null, `${run.variant}/${run.questionId} never read the correct candidate`);
    for (const key of numeric) assert.equal(typeof run[key], "number", `${key} must be numeric`);
  }
  const map8000 = document.runs.filter((run) => run.variant === "map-8000");
  assert.equal(map8000.filter((run) => run.top3).length, 5, "8k Top-3 must be 5/5");
  assert(map8000.filter((run) => run.top1).length >= 4, "8k Top-1 must be at least 4/5");
  const none = document.runs.filter((run) => run.variant === "none");
  assert(reduction(median(none.map((run) => run.firstCorrectCandidateRead)), median(map8000.map((run) => run.firstCorrectCandidateRead))) >= 0.30, "exploratory calls reduction below 30%");
  assert(reduction(median(none.map((run) => run.sourceBytesBeforeCorrectRead)), median(map8000.map((run) => run.sourceBytesBeforeCorrectRead))) >= 0.30, "source bytes reduction below 30%");
}

const first = execute();
const second = execute();
validate(first);
validate(second);
assert.deepEqual(stable(first), stable(second));
process.stdout.write("query-aware repo-map verification passed\n");
