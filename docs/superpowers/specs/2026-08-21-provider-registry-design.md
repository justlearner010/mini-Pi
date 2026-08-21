# Provider Registry Design (A-tier)

## Status

Owner-approved design for adding multiple OpenAI-compatible LLM providers via a
declarative registry, without rewriting the request/response protocol. A-tier of
the three-tier plan in PR #27 / conversation 2026-08-18: this PR is **tier A**
(declarative registry + multi-provider config + `/provider` command +
multi-provider real-Provider test harness + README constraint change).
Tier B (streaming, OAuth, per-provider reasoning_content nuances, model
catalog) and tier C (Anthropic Messages + Google Generative AI protocols)
are explicitly deferred.

## Goal

Today, mini-Pi hardcodes two providers (`openai`, `deepseek`) with provider
flags (`if (config.provider === "deepseek") { ... }`) embedded in the
protocol layer. Adding any new OpenAI-compatible provider (OpenRouter,
Together, Groq, Mistral, Ollama, vLLM, ...) currently requires editing
`src/llm.ts`. The user wants to add providers by **configuration, not code**,
and to **run the same real-Provider test suite against multiple providers in
parallel** (e.g., the multi-turn validation we just ran on DeepSeek should
also run on OpenAI / OpenRouter / Ollama with a single command).

## Non-goals

- No new protocols (Anthropic Messages, Google Generative AI). Tier C.
- No streaming responses. Tier B.
- No OAuth / subscription providers. Tier B.
- No per-provider model capability probing or pricing. Tier B.
- No automatic failover or routing. Future.

## Design

### Provider registry (in `src/llm.ts`)

A single readonly map of declarative `ProviderSpec` records. The protocol
layer stays OpenAI Chat Completions; only the metadata (base URL, auth env
vars, headers, body overrides, name) varies. This matches the shape Pi uses
for its OpenAI-compat providers (one thin record, shared protocol module)
and is the reason OpenRouter / Together / Groq / Mistral / Ollama / vLLM
can be added here without writing new protocol code.

```ts
interface ProviderSpec {
  id: string;                              // "openai", "deepseek", "openrouter", ...
  name: string;                            // human display
  baseUrl: string;                         // OpenAI-compat base
  apiKeyEnv: readonly string[];            // env vars, checked in order
  defaultHeaders?: Readonly<Record<string, string>>;
  extraBody?: Readonly<Record<string, unknown>>;
  needsApiKey: boolean;                    // false for local (Ollama, vLLM)
}

const providerRegistry: Readonly<Record<string, ProviderSpec>> = {
  openai:      { id: "openai", name: "OpenAI", baseUrl: "https://api.openai.com/v1",      apiKeyEnv: ["OPENAI_API_KEY"],     needsApiKey: true },
  deepseek:    { id: "deepseek", name: "DeepSeek", baseUrl: "https://api.deepseek.com/v1",  apiKeyEnv: ["DEEPSEEK_API_KEY"],   needsApiKey: true, extraBody: { thinking: { type: "disabled" } } },
  openrouter:  { id: "openrouter", name: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", apiKeyEnv: ["OPENROUTER_API_KEY"], needsApiKey: true, defaultHeaders: { "HTTP-Referer": "https://github.com/justlearner010/mini-Pi", "X-Title": "mini-Pi" } },
  together:    { id: "together", name: "Together AI", baseUrl: "https://api.together.xyz/v1", apiKeyEnv: ["TOGETHER_API_KEY"],   needsApiKey: true },
  groq:        { id: "groq", name: "Groq", baseUrl: "https://api.groq.com/openai/v1",     apiKeyEnv: ["GROQ_API_KEY"],       needsApiKey: true },
  mistral:     { id: "mistral", name: "Mistral", baseUrl: "https://api.mistral.ai/v1",      apiKeyEnv: ["MISTRAL_API_KEY"],    needsApiKey: true },
  ollama:      { id: "ollama", name: "Ollama (local)", baseUrl: "http://localhost:11434/v1", apiKeyEnv: [], needsApiKey: false },
  vllm:        { id: "vllm", name: "vLLM (local)", baseUrl: "http://localhost:8000/v1",     apiKeyEnv: [], needsApiKey: false }
};
```

Helper functions:

```ts
function lookupProvider(id: string): ProviderSpec          // throws if unknown
function listProviderIds(): string[]                       // for onboarding & /provider
function providerDisplayName(id: string): string            // for TUI / errors
function resolveProviderApiKey(spec, credentials, env): ... // existing keychain-or-env logic, parameterized
```

`createLLM` becomes:

```ts
function createLLM(config: LLMConfig, client = clientFor(config.provider, config.apiKey), telemetry?) {
  const spec = lookupProvider(config.provider);
  return {
    async generate(messages, tools) {
      const request = {
        model: config.model,
        messages: requestMessages(messages),  // unchanged (PR #26 + #28 fixes preserved)
        tools: tools.map(...),
        ...(spec.defaultHeaders ? { default_headers: spec.defaultHeaders } : {}),
        ...(spec.extraBody ? { extra_body: spec.extraBody } : {})
      };
      // ... existing success / error / telemetry
    }
  };
}
```

The `defaultHeaders` field is folded into the request as the OpenAI SDK
accepts a top-level `defaultHeaders` option. We'll set those via the SDK
client instead, since per-request `defaultHeaders` is not a standard field.
Specifically: `clientFor(spec, apiKey, { defaultHeaders: spec.defaultHeaders })`.
The `extraBody` (DeepSeek's `thinking: { type: "disabled" }`) is the only
per-request override we still need.

Diagnostic messages: replace `name = provider === "openai" ? "OpenAI" : "DeepSeek"`
with `name = spec.name` so they read "OpenRouter 拒绝了请求" / "Groq 账户余额不足"
etc. without branching.

### Multi-provider config (`~/.mini-pi/config.json`)

Current format (unchanged for backward compatibility): `{ provider, model }`.
New format: `{ current: { provider, model } }`. The current selection moves
under a `current` key to leave room for future per-provider defaults without
breaking the schema again.

```ts
type GlobalPreference = { provider: string; model: string };
// disk format:
type StoredPreference =
  | { current: { provider: string; model: string } }
  | { provider: string; model: string };   // legacy — auto-migrated on read
```

`readGlobalPreference` detects the legacy shape and returns a normalized
`{ provider, model }` (the legacy shape itself already matches that type).
`saveGlobalPreference` always writes the new shape. This is a one-time
silent migration — no user-visible change.

Credentials (API keys) already live in the system credential store (one
entry per provider, service `mini-Pi`, account = provider id). The registry
doesn't change credential storage; `resolveApiKey(spec, credentials, env)`
reads `apiKeyEnv` from the spec instead of a hardcoded switch.

### TUI commands

`/provider` (new): with no argument, lists registered providers and marks
the current one; with an argument, switches the current provider. `/model`
already handles model selection per current provider. `/login`, `/logout`,
`/help`, `/reset`, `/exit` unchanged. Onboarding (`loginWithCredentialStore`)
now iterates `listProviderIds()` instead of a hardcoded two-option list.

### Multi-provider real-Provider test harness

`scripts/test-providers.mjs` (new): runs the existing multi-turn Agent
fixture (12 sequential runs + 1 mid-session project switch) against
multiple providers in parallel and emits a per-provider comparison report.

```sh
# opt-in: needs real Provider keys
MINI_PI_TEST_PROVIDERS=deepseek,openrouter \
  DEEPSEEK_API_KEY=sk-... OPENROUTER_API_KEY=sk-... \
  npm run test:providers
```

Auto-discovery: if `MINI_PI_TEST_PROVIDERS` is unset, the script enumerates
every registered provider with a present env-var key and runs them all in
parallel. Provider-specific Keychain entries are not consulted here (env is
the test seam).

Output: a markdown table printed to stdout. Columns: provider, runs OK,
runs failed, p50/p90 latency, total tokens, key kind. Exit 0 if all providers
pass; 1 if any failed. Each provider runs in its own `Promise.all` branch
using `AbortController` so a slow provider doesn't block the others, with a
default wall-clock budget of 5 minutes per provider.

The same fixture used in this conversation's multi-turn validation (12
Agent runs + mid-session project switch to `dsh-plugin-market`) is the
canonical workload. It exercises the realistic path that exposed the
`reasoning_content` and `tool_calls: []` bugs (PRs #26 and #28).

### README updates

1. **Constraint change.** Replace
   `五个核心 TypeScript 源码文件合计不超过 1000 行` with
   `核心源码保持精简、按职责切分（避免无意义的拆分，也避免堆成大块）`.
   The hard cap is replaced by a soft, judgment-based principle that survives
   the legitimate growth from new features.
2. **Provider table** in the `## 使用` section listing all registered
   providers with their base URL, env var, and a one-line note (e.g.,
   "OpenAI", "DeepSeek", "OpenRouter (one key, many models)", "Ollama
   (local, no key)").
3. **Multi-provider testing** sub-section: how to run `npm run test:providers`,
   cost note (real Provider keys, opt-in).
4. **Stream / OAuth / Anthropic / Google** explicitly moved to
   `DEFERRED_FEATURES.md` as "B-tier and C-tier". Streaming was already
   listed; the rest are new.

### `DEFERRED_FEATURES.md` updates

Add a new section:

```md
## B 档 — 下一轮在 A 档稳定后推进

- 流式输出（async stream of model tokens）。当前回答在 Agent.run 完成后一次性返回。
- OAuth / 订阅 Provider 登录（Anthropic Claude Pro/Max、Google AI Studio 等）。
- 模型注册表 + 能力探测（context window、supports tools、supports vision、supports thinking）。
- 多 provider 路由与自动 failover。
- 单独的 provider-specific reasoning_content / thinking 模式控制（DeepSeek / OpenAI / Anthropic 各家语义不同，目前只有 DeepSeek 走了 `extra_body` 显式 disable）。

## C 档 — 多 protocol 支持

- Anthropic Messages API（与 OpenAI Chat Completions 不同的 tool_use blocks / 流式事件 / 错误结构）。
- Google Generative AI（gemini-1.5 / 2.x 的 generateContent）。
- AWS Bedrock Converse。
```

## Architecture ownership

- `src/llm.ts`: replace the `ProviderName` enum with the registry;
  `clientFor` takes a `ProviderSpec`; `createLLM` reads `extraBody` /
  `defaultHeaders` from the spec; diagnostic messages use `spec.name`.
- `src/cli.ts`: `environmentName` becomes `spec.apiKeyEnv`; the hardcoded
  two-element `chooseProvider` prompt is replaced by iterating
  `listProviderIds()`; config format migration; `/provider` command
  implementation in the TUI actions object.
- `src/tui.ts`: add `parseCommand` for `/provider [id]`; update `helpText`
  to include the new command.
- `scripts/test-providers.mjs`: new, see above.
- `package.json`: add `test:providers` script.
- `README.md`: constraint change, provider table, multi-provider test
  section.
- `DEFERRED_FEATURES.md`: add B / C tier sections.
- `test/llm.test.ts`: replace `ProviderName` literal strings with registry
  lookups; add a test that every registered provider has the required
  fields and a unique id.
- `test/cli.test.ts`: config migration tests (legacy → new shape; new shape
  round-trips); `/provider` command tests; `chooseProvider` iterates the
  registry.

## Test and verification plan

1. Unit tests: `lookupProvider` throws on unknown; every registry entry
   has a unique `id` and `apiKeyEnv` entries are uppercase; legacy config
   shape migrates silently; new shape round-trips.
2. CLI tests: `/provider` without argument lists; `/provider openrouter`
   switches; onboarding iterates all registered providers.
3. Smoke: `node dist/src/cli.js --provider openai --model gpt-4.1 --prompt "hi"`
   still works after the registry refactor (no behavior change for the
   current two providers).
4. Multi-provider real-Provider harness: dry-run with a stubbed client to
   verify parallelism and exit codes. Manual run with `DEEPSEEK_API_KEY`
   to confirm the existing fixture still passes on `main`.
5. `git diff --check` clean; `npm test`, `npm run check`, `npm run build`,
   `verify:bin`, `verify:package` all pass; locked baselines
   (`verify:repo-map`, `verify:deepseek-harness`) unchanged.

## Acceptance criteria

- Adding a new OpenAI-compat provider is a one-line registry entry; no
  edits to `llm.ts` protocol code.
- `/provider` lists every registered provider and marks the current one.
- `/provider <id>` switches; the TUI session's project state and Agent
  history are preserved across the switch (same as `/login`).
- `scripts/test-providers.mjs` runs in parallel and exits non-zero on
  any provider failure.
- README no longer claims the 1000-line cap; documents the B / C tier
  deferral.
- Existing tests for OpenAI / DeepSeek still pass; behavior unchanged
  when only those two providers are registered.
- The locked baselines (`verify:repo-map`, `verify:deepseek-harness`)
  pass unchanged.

## Deferred follow-up

- Tier B (streaming, OAuth, model catalog) — open spec after A is
  shipped and one or two real-Provider providers beyond DeepSeek are
  actively used.
- Tier C (Anthropic Messages, Google Generative AI) — only after B
  ships and the streaming abstraction is in place.
