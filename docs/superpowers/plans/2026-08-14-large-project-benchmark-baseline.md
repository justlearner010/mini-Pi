# Large-Project Benchmark Baseline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Raise the default Agent limit to 16 and establish a deterministic,
repeatable measurement baseline for later large TypeScript/JavaScript project
efficiency work.

**Architecture:** Agent owns a named 16-turn default while preserving explicit
per-instance limits. A compiled Node benchmark drives existing read-only tools
over fixed fixtures with scripted LLM replies, then prints canonical JSON
metrics. A verifier runs it twice and ignores elapsed time when checking
determinism. The final report stores measured baseline output and marks
real-Provider validation honestly as pending owner-run.

**Tech Stack:** TypeScript, Node test runner through tsx, compiled ESM Node
scripts, existing read-only tools.

---

## File structure

| File | Responsibility |
| --- | --- |
| src/agent.ts | Named default of 16 turns; explicit override remains unchanged. |
| test/agent.test.ts | Default and explicit max-turn boundary regression. |
| test/fixtures/efficiency | Three static TS/JS repositories with known facts. |
| scripts/benchmark-large-project.mjs | Deterministic run and canonical metric JSON. |
| scripts/verify-benchmark.mjs | Run benchmark twice and enforce metric schema. |
| package.json | Benchmark and verifier commands. |
| docs/experiments/8-benchmark-baseline.md | Measured result and quality-gate report. |

### Task 1: Make sixteen the default limit

**Files:**
- Modify: src/agent.ts:26-67
- Modify: test/agent.test.ts:174-185

- [ ] **Step 1: Write the failing default-limit regression**

Add this test after the current max-turn test:

    test("uses sixteen turns by default but preserves an explicit limit", async () => {
      const replies = Array.from({ length: 16 }, (_, index) =>
        response(index === 15 ? "done" : null, index === 15 ? [] : [{ id: String(index), name: "noop", arguments: "{}" }])
      );
      const defaultAgent = new Agent({
        llm: fakeLLM(replies).llm,
        tools: [tool("noop", async () => ({ content: "", isError: false }))],
        systemPrompt: "rules",
        rootDir: "/project"
      });
      assert.equal((await defaultAgent.run("analyse")).turns, 16);

      const explicitAgent = new Agent({
        llm: fakeLLM([response(null, [{ id: "one", name: "noop", arguments: "{}" }])]).llm,
        tools: [tool("noop", async () => ({ content: "", isError: false }))],
        systemPrompt: "rules",
        rootDir: "/project",
        maxTurns: 1
      });
      await assert.rejects(() => explicitAgent.run("analyse"), /maximum turns/i);
    });

- [ ] **Step 2: Observe RED**

Run:

    npx tsx --test test/agent.test.ts

Expected: the new default-limit assertion fails because Agent stops at 8.

- [ ] **Step 3: Implement the named default**

Add before AgentConfig:

    export const DEFAULT_MAX_TURNS = 16;

Replace the constructor assignment with:

    this.maxTurns = config.maxTurns ?? DEFAULT_MAX_TURNS;

Leave the while-loop boundary unchanged: a final answer on turn 16 succeeds;
only a seventeenth model request fails.

- [ ] **Step 4: Observe GREEN and commit**

Run:

    npx tsx --test test/agent.test.ts
    git add src/agent.ts test/agent.test.ts
    git commit -m "feat: raise default agent turn limit to sixteen"

Expected: all Agent tests pass, including the explicit limit of one.

### Task 2: Create fixed benchmark projects

**Files:**
- Create: test/fixtures/efficiency/alpha-service/package.json
- Create: test/fixtures/efficiency/alpha-service/README.md
- Create: test/fixtures/efficiency/alpha-service/src/index.ts
- Create: test/fixtures/efficiency/alpha-service/src/auth/session.ts
- Create: test/fixtures/efficiency/alpha-service/src/unused/report.ts
- Create: test/fixtures/efficiency/beta-workspace/package.json
- Create: test/fixtures/efficiency/beta-workspace/packages/api/src/main.ts
- Create: test/fixtures/efficiency/beta-workspace/packages/api/src/router.ts
- Create: test/fixtures/efficiency/beta-workspace/packages/web/src/app.ts
- Create: test/fixtures/efficiency/gamma-layered/package.json
- Create: test/fixtures/efficiency/gamma-layered/src/server.ts
- Create: test/fixtures/efficiency/gamma-layered/src/domain/orders.ts
- Create: test/fixtures/efficiency/gamma-layered/src/infra/store.ts
- Modify: test/agent.test.ts

- [ ] **Step 1: Add a failing fixture fact test**

Import tools from src/tool.js and add:

    test("efficiency fixtures expose a manifest, entry point, and core module", async () => {
      const root = new URL("./fixtures/efficiency/alpha-service/", import.meta.url).pathname;
      const scanned = await tools[0].execute({}, { rootDir: root });
      const manifest = await tools[1].execute({ path: "package.json" }, { rootDir: root });
      assert.equal(scanned.isError, false);
      assert.match(JSON.stringify(scanned.content), /src\\/index\\.ts/);
      assert.match(JSON.stringify(manifest.content), /alpha-service/);
    });

- [ ] **Step 2: Observe RED**

Run:

    npx tsx --test test/agent.test.ts

Expected: fixture paths do not exist.

- [ ] **Step 3: Add fixture facts**

Create valid package manifests with name, type set to module, and a start
script. Make the source relationships exactly:

    alpha-service: src/index.ts imports ./auth/session.js
    beta-workspace: packages/api/src/main.ts imports ./router.js
    gamma-layered: src/server.ts imports ./domain/orders.js;
                   orders.ts imports ../infra/store.js

Keep alpha-service/src/unused/report.ts unreferenced. Source files must use
relative .js specifiers so the existing dependency resolver can inspect them.

- [ ] **Step 4: Observe GREEN and commit**

Run:

    npx tsx --test test/agent.test.ts
    git add test/agent.test.ts test/fixtures/efficiency
    git commit -m "test: add deterministic large-project fixtures"

Expected: scan and manifest assertions pass without network access.

### Task 3: Create the canonical benchmark runner

**Files:**
- Create: scripts/benchmark-large-project.mjs
- Modify: package.json

- [ ] **Step 1: Add the command and observe RED**

Add this package script:

    "benchmark:large": "npm run build && node scripts/benchmark-large-project.mjs"
    "benchmark:large:json": "node scripts/benchmark-large-project.mjs"

Run:

    npm run benchmark:large

Expected: failure because the runner is absent.

- [ ] **Step 2: Implement the runner**

Import Agent from dist/src/agent.js and tools from dist/src/tool.js. Resolve the
three fixture roots relative to the script. For every tool, create a wrapper
that calls the original execute function and increments:

    toolCalls
    filesRead when the tool name is read_file
    returnedFileBytes as Buffer.byteLength(JSON.stringify(result.content))
    toolResultCharacters as JSON.stringify(result.content).length

The scripted LLM generate method must clone/count each messages argument with:

    requestCharacters += JSON.stringify(messages).length
    modelRequests += 1

For each normal fixture return, in order: scan_project, read_file package.json,
analyze_dependencies for that fixture entry, then a final answer. Entries are
src/index.ts, packages/api/src/main.ts, and src/server.ts respectively.

Also run a capacity-boundary scenario whose first nine replies each call
scan_project, followed by a final answer. It must produce maximum_turns for
maxTurns 8 and answered with 10 turns for maxTurns 16. Run a separate
beyond-default scenario with seventeen scan_project replies followed by a
final answer; at maxTurns 16 it must produce maximum_turns. The complete
document therefore has nine runs: six normal fixture runs, two
capacity-boundary runs, and one beyond-default run.

Print one JSON document only:

    {
      "schemaVersion": 1,
      "generatedBy": "scripts/benchmark-large-project.mjs",
      "runs": [
        {
          "fixture": "alpha-service",
          "maxTurns": 8,
          "outcome": "answered",
          "turns": 4,
          "modelRequests": 4,
          "toolCalls": 3,
          "filesRead": 1,
          "returnedFileBytes": 0,
          "requestCharacters": 0,
          "toolResultCharacters": 0,
          "elapsedMs": 0
        }
      ]
    }

Sort runs by fixture then maxTurns. Obtain elapsedMs from process.hrtime.bigint.
It is reported but not used for deterministic equality.

- [ ] **Step 3: Observe GREEN and commit**

Run:

    npm run benchmark:large
    npm run build
    npm run benchmark:large:json
    git add package.json scripts/benchmark-large-project.mjs
    git commit -m "feat: add deterministic large-project benchmark"

Expected: benchmark:large builds and then prints one JSON document. After a
build, benchmark:large:json runs the benchmark directly and prints only the
same nine-run JSON document: 8-turn and 16-turn records for three normal
fixtures, both capacity-boundary records, and the 16-turn beyond-default
record.

### Task 4: Verify repeatability and publish the report

**Files:**
- Create: scripts/verify-benchmark.mjs
- Modify: package.json
- Create: docs/experiments/8-benchmark-baseline.md

- [ ] **Step 1: Add verifier command and observe RED**

Add:

    "verify:benchmark": "npm run build && node scripts/verify-benchmark.mjs"

Run:

    npm run verify:benchmark

Expected: failure because the verifier is absent.

- [ ] **Step 2: Implement deterministic verification**

The verifier executes the runner twice with:

    execFileSync(process.execPath, [runner], { encoding: "utf8" })

Parse both documents, remove elapsedMs from every run, then assert deep equality.
Reject any run missing a numeric turns, modelRequests, toolCalls, filesRead,
returnedFileBytes, requestCharacters, toolResultCharacters, or elapsedMs.
On success print exactly:

    benchmark verification passed

- [ ] **Step 3: Write the measured experiment report**

Run:

    npm run build
    node scripts/benchmark-large-project.mjs > /tmp/mini-pi-benchmark.json
    npm run verify:benchmark

Create docs/experiments/8-benchmark-baseline.md with the baseline and candidate
commit SHAs, the two commands, a table copied from actual JSON for every run,
and the conclusion that the over-limit scenario fails at 8 but completes at 16.
Score manifest, entry point, dependency relationship, and stated limits with
file-backed evidence. Include a clearly labelled Real Provider validation:
pending owner-run section that requires 3 projects times 3 questions times
baseline/candidate, without API keys, full source, or full answers.

- [ ] **Step 4: Run full validation and commit**

Run:

    npm test
    npm run check
    npm run build
    npm run benchmark:large
    npm run verify:benchmark
    npm run verify:bin
    npm run verify:package
    git diff --check
    git add package.json scripts/verify-benchmark.mjs docs/experiments/8-benchmark-baseline.md
    git commit -m "docs: record large-project benchmark baseline"

Expected: every command exits 0 and the verifier prints benchmark verification
passed.

## Plan self-review

- Task 1 measures the 8-to-16 capacity change without claiming it is an
  optimization.
- Tasks 2 through 4 provide deterministic fixtures, every required metric,
  repeatability verification, and an experiment report.
- Compact maps, exploration policy, and summary memory are correctly reserved
  for Issues 9 through 11.
- The plan adds no real credentials, live network call, language expansion, or
  uncontrolled tool.
