#!/usr/bin/env node
// Multi-Provider real-Provider test harness.
// Runs the same Agent fixture (12 sequential runs + 1 mid-session project
// switch) against multiple Providers in parallel and emits a per-Provider
// comparison report. Real Provider keys; opt-in.
import { createSystemCredentialStore, SYSTEM_PROMPT, resolveProjectRoot, createRepositoryNavigation, composeAgentTools } from "/Users/jay/pi-agent_forked/mini-Pi/dist/src/cli.js";
import { tools, switchProjectTool, createQueryRepoMapTool, buildRepositoryIndex } from "/Users/jay/pi-agent_forked/mini-Pi/dist/src/tool.js";
import { Agent } from "/Users/jay/pi-agent_forked/mini-Pi/dist/src/agent.js";
import { createLLM, listProviderIds, lookupProvider } from "/Users/jay/pi-agent_forked/mini-Pi/dist/src/llm.js";

const MAX_RUNS = 12;
const WALL_BUDGET_MS = 5 * 60 * 1000;

const store = createSystemCredentialStore();

function pickProviders() {
  const wanted = (process.env["MINI_PI_TEST_PROVIDERS"] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (wanted.length) return wanted.filter((id) => listProviderIds().includes(id));
  return listProviderIds().filter((id) => lookupProvider(id).apiKeyEnv.some((env) => process.env[env]));
}

const prompts = [
  "研究一下 src/agent.ts 的核心结构",
  "src/llm.ts 做了什么",
  "看一下 src/tool.ts 的工具列表和它们如何扫描项目",
  "src/tui.ts 的命令解析逻辑",
  "src/cli.ts 如何启动 Agent",
  "这些文件之间怎么协作",
  "mini-Pi 的 Repo Index 是怎么构建的",
  "介绍一下 query_repo_map 工具的作用",
  "analyze_dependencies 工具支持哪些文件类型",
  "Agent 的 tool approval 流程",
  "runWithNavigation 怎么把 Repo Map 注入请求",
  "system prompt 告诉模型什么"
];

async function resolveKey(providerId) {
  const spec = lookupProvider(providerId);
  if (!spec.needsApiKey) return "unused";
  for (const envName of spec.apiKeyEnv) {
    const value = process.env[envName];
    if (value) return value;
  }
  try {
    const stored = await store.getPassword("mini-Pi", providerId);
    if (stored) return stored;
  } catch {}
  return null;
}

async function runOne(providerId, modelName) {
  const apiKey = await resolveKey(providerId);
  if (!apiKey) return { providerId, model: modelName ?? null, skipped: "no api key" };
  const idx = await buildRepositoryIndex("/Users/jay/pi-agent_forked/mini-Pi");
  const fullTools = [...tools, switchProjectTool, createQueryRepoMapTool(idx)];
  const handler = async (path) => {
    const rootDir = await resolveProjectRoot(process.cwd(), path);
    const navigation = await createRepositoryNavigation(rootDir);
    return { ok: true, rootDir, tools: composeAgentTools(navigation?.tools), notice: `Switched to ${rootDir}` };
  };
  const llm = createLLM({ provider: providerId, model: modelName, apiKey });
  const agent = new Agent({
    llm, systemPrompt: SYSTEM_PROMPT, rootDir: "/Users/jay/pi-agent_forked/mini-Pi",
    tools: composeAgentTools(fullTools),
    requestApproval: async () => ({ approved: true, reason: "test" }),
    switchProject: handler, maxTurns: 8
  });
  const results = [];
  let firstFailure = null;
  for (let i = 0; i < MAX_RUNS; i += 1) {
    const prompt = prompts[i] ?? `cycle ${i + 1}`;
    const startedAt = Date.now();
    try {
      const r = await agent.run(prompt);
      const ms = Date.now() - startedAt;
      results.push({ run: i + 1, turns: r.turns, ms });
      if (i === 4) {
        const r2 = await agent.run("切换到 /Users/jay/plugin recommend /dsh-plugin-market 并看 package.json");
        results.push({ run: `${i + 1}.switch`, turns: r2.turns, ms: Date.now() - startedAt });
      }
    } catch (e) {
      firstFailure = { run: i + 1, kind: e.kind ?? e.name, status: e.status, message: e.message };
      break;
    }
  }
  const ok = results.length;
  const fail = firstFailure ? MAX_RUNS - ok : 0;
  return { providerId, model: modelName, ok, fail, firstFailure };
}

async function main() {
  const ids = pickProviders();
  if (!ids.length) { console.error("No providers with available API keys. Set MINI_PI_TEST_PROVIDERS=openai,deepseek or expose *_API_KEY env vars."); process.exit(2); }
  const modelPerId = {};
  for (const id of ids) {
    const defaultModel = process.env[`MINI_PI_TEST_MODEL_${id.toUpperCase()}`] ?? "deepseek-v4-flash";
    modelPerId[id] = id === "openai" ? "gpt-4.1-mini" : defaultModel;
  }
  const results = await Promise.all(ids.map(async (id) => {
    try {
      return await Promise.race([
        runOne(id, modelPerId[id]),
        new Promise((_, reject) => setTimeout(() => reject(new Error("wall-clock budget exceeded")), WALL_BUDGET_MS))
      ]);
    } catch (error) {
      return { providerId: id, model: modelPerId[id], ok: 0, fail: MAX_RUNS, firstFailure: { run: -1, kind: "wall-clock", status: undefined, message: error.message } };
    }
  }));
  console.log("");
  console.log("| provider | model | runs OK | fail | first failure |");
  console.log("| --- | --- | ---: | ---: | --- |");
  for (const r of results) {
    const fail = r.firstFailure ? `${r.firstFailure.kind ?? "?"} (run ${r.firstFailure.run})` : "—";
    console.log(`| ${r.providerId} | ${r.model ?? "?"} | ${r.ok} | ${r.fail} | ${fail} |`);
  }
  console.log("");
  const allOk = results.every((r) => r.ok === MAX_RUNS);
  if (!allOk) { console.error("One or more providers failed. See table above."); process.exit(1); }
}

main().catch((error) => { console.error(error.message); process.exit(1); });