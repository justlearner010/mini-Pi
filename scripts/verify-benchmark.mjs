import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const runner = fileURLToPath(new URL("./benchmark-large-project.mjs", import.meta.url));
const numericMetrics = [
  "turns",
  "modelRequests",
  "toolCalls",
  "filesRead",
  "returnedFileBytes",
  "requestCharacters",
  "toolResultCharacters",
  "elapsedMs"
];

function executeBenchmark() {
  return JSON.parse(execFileSync(process.execPath, [runner], { encoding: "utf8" }));
}

function validateDocument(document) {
  assert.equal(document.schemaVersion, 1);
  assert.equal(document.generatedBy, "scripts/benchmark-large-project.mjs");
  assert.ok(Array.isArray(document.runs));
  assert.equal(document.runs.length, 9);

  for (const run of document.runs) {
    for (const metric of numericMetrics) {
      assert.equal(typeof run[metric], "number", `${metric} must be numeric`);
      assert.ok(Number.isFinite(run[metric]), `${metric} must be finite`);
    }
  }
}

function withoutElapsedMs(document) {
  return {
    ...document,
    runs: document.runs.map(({ elapsedMs: _elapsedMs, ...run }) => run)
  };
}

const first = executeBenchmark();
const second = executeBenchmark();
validateDocument(first);
validateDocument(second);
assert.deepEqual(withoutElapsedMs(first), withoutElapsedMs(second));

process.stdout.write("benchmark verification passed\n");
