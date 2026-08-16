import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const path = process.argv[2];
if (!path) throw new Error("Pass the captured live evaluation JSON path");
const document = JSON.parse(await readFile(path, "utf8"));
assert.equal(document.schemaVersion, 1);
assert.equal(document.provider, "deepseek");
assert.equal(document.model, "deepseek-v4-flash");
assert.equal(document.requestBudget, 20);
assert(document.requestsStarted <= 20);
assert(document.rows.length >= 1 && document.rows.length <= 5);
for (const row of document.rows) {
  assert.equal(typeof row.id, "string");
  assert(["answered", "maximum_turns", "budget_exhausted", "provider_failure", "agent_failure"].includes(row.outcome));
  assert(Array.isArray(row.requestDurationMs) && row.requestDurationMs.every((value) => typeof value === "number" && value >= 0));
  assert(Array.isArray(row.readPaths) && row.readPaths.every((path) => typeof path === "string" && !path.startsWith("/") && !path.includes("..")));
  assert.equal(typeof row.expectedSourceRead, "boolean");
  assert.equal(typeof row.answerMentionsExpectedPath, "boolean");
  assert.equal(typeof row.repoMapTop1, "boolean");
  assert.equal(typeof row.repoMapTop3, "boolean");
  assert(!Object.keys(row).some((key) => ["apiKey", "prompt", "answer", "content", "requestId", "rawError"].includes(key)));
}
process.stdout.write("live deepseek-harness evaluation verification passed\n");
