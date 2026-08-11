# mini-Pi 第一版设计规格

## 1. 项目目标

mini-Pi 是一个用于学习 TypeScript 语法和 Agent Loop 的独立终端 Agent。它读取陌生项目的文件结构，分析 TypeScript/JavaScript 静态依赖，并用自然语言解释项目入口、模块关系和限制。

第一版追求最小完整闭环：

```text
用户输入
→ LLM
→ tool call
→ 工具执行
→ tool result
→ LLM
→ 最终回答
```

项目位于 `/Users/jay/pi-agent_forked/mini-Pi`，使用独立 Git，后续关联公开的 GitHub 同名仓库 `mini-Pi`。五个核心 TypeScript 源码文件合计不超过 1000 行；测试、文档和工程配置不计入该预算。

## 2. 第一版范围

第一版支持：

- OpenAI 和 DeepSeek Provider。
- OpenAI-compatible Chat Completions Tool Calling。
- 交互 TUI 和无 TUI 的一次性 CLI 模式。
- 内存中的多轮会话。
- 只读项目扫描和文本文件读取。
- `.ts`、`.tsx`、`.js`、`.jsx` 的静态 `import` 和 `export ... from` 分析。
- 目录树、入口依赖树、内部依赖、Node 内置模块、外部包、未解析依赖和循环依赖报告。

第一版明确不实现的内容统一记录在根目录 `DEFERRED_FEATURES.md`。

## 3. 文件架构

```text
src/
├── llm.ts
├── agent.ts
├── tool.ts
├── cli.ts
└── tui.ts
```

### 3.1 `llm.ts`

- 创建 OpenAI SDK 客户端。
- 封装 OpenAI 与 DeepSeek 的 `baseURL` 差异。
- 在线读取当前 API Key 可见的模型列表。
- 将 mini-Pi 消息和工具定义转换成 Chat Completions 格式。
- 将 Provider 响应转换成统一 `ModelResponse`。
- 将 Provider 异常转换成不泄漏密钥的错误。

### 3.2 `agent.ts`

- 保存当前会话的消息历史。
- 实现 Agent Loop。
- 按顺序执行一轮中的多个 tool call。
- 将工具成功或错误结果回填给模型。
- 发出最小生命周期事件。
- 提供 `run()` 和 `reset()`。

### 3.3 `tool.ts`

- 定义 `Tool`、`ToolContext` 和 `ToolResult`。
- 实现 `scan_project`、`read_file` 和 `analyze_dependencies`。
- 校验模型参数、项目路径和文件边界。
- 使用 TypeScript Compiler API 提取 TS/JS 静态依赖。

### 3.4 `cli.ts`

- 使用 Node `parseArgs` 解析参数。
- 校验项目根目录。
- 读取 Provider 对应的环境变量。
- 创建 LLM、Tools 和 Agent。
- 决定进入 TUI 或一次性模式。
- 管理退出码。

### 3.5 `tui.ts`

- 使用 `@inquirer/select` 选择 Provider 和模型。
- 使用 Node `readline` 接收单行问题。
- 显示 Agent 生命周期、工具状态、最终回答和简化错误。
- 处理 `/help`、`/reset` 和 `/exit`。

`agent.ts` 不导入 `tui.ts`，核心层不直接输出到终端。移除 TUI 后，CLI 和测试仍可直接运行 Agent。

## 4. 依赖方向

```text
cli.ts
├── llm.ts
├── tool.ts
├── agent.ts
└── tui.ts

tui.ts ──提交文本/订阅事件──→ agent.ts
agent.ts ──generate()────────→ llm.ts
agent.ts ──execute()─────────→ tool.ts
```

工具实现之间不互相调用公开的 `execute()`。`scan_project` 与 `analyze_dependencies` 可以共享 `tool.ts` 内部的文件遍历函数。

## 5. 模型层

### 5.1 配置与公开接口

```ts
type ProviderName = "openai" | "deepseek";

interface LLMConfig {
  provider: ProviderName;
  model: string;
  apiKey: string;
}

interface LLMClient {
  generate(messages: Message[], tools: Tool[]): Promise<ModelResponse>;
}
```

`createLLM(config)` 创建客户端；`listModels(provider, apiKey)` 返回排序、去重后的模型 ID。

OpenAI 使用 SDK 默认地址。DeepSeek 使用 `https://api.deepseek.com`。第一版明确关闭 DeepSeek thinking，以避免在最小消息协议中引入并回传 `reasoning_content`。

### 5.2 消息类型

```ts
type Message = SystemMessage | UserMessage | AssistantMessage | ToolResultMessage;

interface SystemMessage {
  role: "system";
  content: string;
}

interface UserMessage {
  role: "user";
  content: string;
}

interface AssistantMessage {
  role: "assistant";
  content: string | null;
  toolCalls: ToolCall[];
}

interface ToolResultMessage {
  role: "tool";
  toolCallId: string;
  content: string;
}

interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

interface ModelResponse {
  message: AssistantMessage;
}
```

`ToolCall.arguments` 保留 Provider 返回的原始 JSON 字符串。Agent 解析失败时不执行工具，而是生成与原 `toolCallId` 对应的错误 Tool Result。

### 5.3 消息往返

```text
system
→ user
→ assistant(tool call: call_123)
→ tool(toolCallId: call_123)
→ assistant(final answer)
```

一次响应中的多个 tool call 和 tool result 都保持原始顺序。assistant 消息和对应工具结果必须完整保存在历史中。

## 6. Agent Loop

### 6.1 公开接口

```ts
interface AgentConfig {
  llm: LLMClient;
  tools: Tool[];
  systemPrompt: string;
  maxTurns: number;
  onEvent?: (event: AgentEvent) => void;
}

class Agent {
  constructor(config: AgentConfig);
  run(prompt: string): Promise<AgentResult>;
  reset(): void;
}
```

一个 Agent 实例对应一次内存会话。`reset()` 清空历史并恢复初始 System Prompt，不触碰项目文件。

### 6.2 循环语义

1. 将用户消息追加到历史并发出 `agent_start`。
2. 调用 LLM 并保存完整 assistant 消息。
3. assistant 没有 tool call 时，返回最终回答。
4. assistant 有 tool call 时，按来源顺序逐个执行。
5. 工具结果无论成功或失败都追加到历史。
6. 带着 tool result 再次调用 LLM。
7. Provider 失败或达到 `maxTurns = 8` 时结束当前运行。

工具失败不是 Agent 级终止条件。不存在的工具、非法 JSON 参数、参数验证失败和工具异常都转成 `isError` Tool Result，让模型有机会修正。

Provider 失败时，回滚本次 `run()` 新增的不完整消息，使既有会话保持可继续使用的有效状态。

### 6.3 生命周期事件

```ts
type AgentEvent =
  | { type: "agent_start"; prompt: string }
  | { type: "model_start"; turn: number }
  | { type: "model_end"; turn: number; toolCallCount: number }
  | { type: "tool_start"; turn: number; toolCallId: string; toolName: string }
  | {
      type: "tool_end";
      turn: number;
      toolCallId: string;
      toolName: string;
      isError: boolean;
      message: string;
    }
  | { type: "agent_end"; answer: string; turns: number }
  | { type: "error"; stage: "model" | "agent"; message: string };
```

事件通过同步回调发送。`tool_end.message` 只包含短摘要，不包含完整工具 JSON。

## 7. 工具层

### 7.1 共同契约

```ts
interface ToolContext {
  rootDir: string;
}

interface Tool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute(args: unknown, context: ToolContext): Promise<ToolResult>;
}

interface ToolResult {
  content: string;
  isError: boolean;
}
```

项目根目录由 CLI 校验并注入，模型无权传入或修改。每个工具手写小型 JSON Schema，并在执行时对 `unknown` 参数进行运行时检查。第一版不启用 Provider strict mode，也不引入 Schema 验证库。

### 7.2 `scan_project`

参数：

```ts
interface ScanProjectArgs {
  path?: string;
}
```

返回：

```ts
interface ScanProjectOutput {
  scannedPath: string;
  readmePath: string | null;
  manifestPaths: string[];
  sourceFiles: string[];
  unsupportedFiles: string[];
  tree: string;
  totalRelevantFiles: number;
  returnedFileCount: number;
  truncated: boolean;
}
```

行为：

- `path` 默认为项目根目录，且只能是根目录内的相对目录。
- 使用 `readdir(..., { withFileTypes: true })` 递归扫描。
- 忽略 `.git`、`node_modules`、`dist`、`build`、`coverage`、隐藏目录、二进制资产和符号链接。
- 目录树包含 README、`package.json`、`tsconfig*.json`、Markdown、JSON、TS/JS 源码、测试文件，以及常见文本源码扩展名。
- `.py`、`.rs`、`.java`、`.go`、`.c`、`.h`、`.cpp`、`.cs`、`.rb`、`.php`、`.swift`、`.kt` 等非 TS/JS 源码列入 `unsupportedFiles`，但不进入依赖分析。
- 路径按稳定字母顺序返回。
- 超过 500 个相关文件时返回稳定的部分结果、总数、返回数并设置 `truncated: true`；Agent 可以缩小 `path` 重试。

### 7.3 `read_file`

参数：

```ts
interface ReadFileArgs {
  path: string;
  startLine?: number;
  endLine?: number;
}
```

返回：

```ts
interface ReadFileOutput {
  path: string;
  startLine: number;
  endLine: number;
  totalLines: number;
  content: string;
  truncated: boolean;
}
```

行为：

- 行号从 1 开始。
- 参数必须为正整数，且 `startLine <= endLine`。
- 小文本文件默认完整读取。
- 一次最多返回 300 行和 256 KB。
- 超限时返回部分内容并设置 `truncated: true`。
- 拒绝目录、符号链接、二进制文件、项目外路径和不存在的文件。
- 只向模型暴露项目相对路径。

### 7.4 `analyze_dependencies`

参数：

```ts
interface AnalyzeDependenciesArgs {
  path?: string;
  entry?: string;
}
```

两者都省略时分析整个项目；指定 `entry` 时额外生成入口依赖树。若同时提供，entry 必须位于 path 范围内。

内部拆分为职责单一的函数：

```text
collectSourceFiles
→ extractImports
→ resolveImportPath
→ buildDependencyGraph
→ findCycles
→ buildEntryTree
```

返回内容包括：

- 分析范围和可选入口。
- `analyzedFiles` 与 `unsupportedFiles`。
- 内部依赖边：`from`、`to`、原始 `specifier`、`kind`、`typeOnly`。
- Node 内置依赖。
- 外部 npm 依赖和子路径。
- 未解析依赖及原因。
- 去重后的循环路径。
- 可选入口依赖树。
- `analyzedFileCount`、`totalEdgeCount` 和 `returnedEdgeCount` 汇总计数。
- `truncated` 标记。

第一版解析：

- `import`、副作用 import、`import type`、`export ... from` 和 `export * from`。
- 相对路径的 `.ts/.tsx/.js/.jsx` 和 `index.*` 候选。
- TS Node ESM 中 `.js` specifier 到 `.ts/.tsx` 源码的映射。
- `node:` 与 Node 内置模块分类。
- npm 包和 scoped package 分类。

第一版不解析动态 `import()`、TypeScript `paths` 别名、package exports、运行时依赖或非 TS/JS 语言依赖。不能解析的文件和 specifier 必须显式报告，不能静默假装完整。

循环用首尾重复的路径表示，例如 `a.ts → b.ts → a.ts`，旋转等价的同一循环只保留一份。入口树遇到重复节点标记 `[already shown]`，遇到循环标记 `[cycle]`。

## 8. 项目探索策略与 System Prompt

Agent 第一次理解陌生项目时：

1. `scan_project` 建立目录地图。
2. 存在 README 时尽早读取。
3. 将 README 视为作者意图，而非当前实现的证明。
4. 读取 `package.json`、`tsconfig*.json` 等相关配置。
5. 使用 `analyze_dependencies` 验证实际 TS/JS 关系。
6. 使用 `read_file` 阅读与问题有关的入口和核心模块。
7. 对比文档与源码后回答。

没有 README 不是错误，Agent 继续使用配置、依赖和源码建立事实。

System Prompt 正式文本：

```text
You are mini-Pi, a read-only codebase analysis agent.

Use tools to gather evidence before making claims about a project.
Do not claim that you inspected a file unless its contents or dependency
data were returned by a tool.

When first exploring an unfamiliar project:
1. Use scan_project to understand its structure.
2. If a README exists, read it early to learn the intended design.
3. Treat documentation as context, not proof. Verify important claims
   against configuration, source files, and dependency data.
4. Use analyze_dependencies to inspect actual TS/JS import relationships.
5. Use read_file only for files relevant to the user's question.

Never request paths outside the selected project.
Do not modify files or execute shell commands.

Clearly distinguish:
- internal dependencies;
- Node.js built-in modules;
- external packages;
- unresolved dependencies;
- unsupported files;
- circular dependencies.

If a tool result is truncated or incomplete, say so and narrow the
analysis scope when possible.

Answer in the user's language.
For full-project analysis, include:
- a short project overview;
- the directory structure;
- important entry points;
- the dependency structure;
- cycles, unresolved imports, unsupported files, and limitations.
```

System Prompt 不是安全边界；真正的目录限制由工具实现强制执行。

## 9. CLI 与 TUI

### 9.1 CLI 参数

```text
mini-pi [project]

--provider <openai|deepseek>
--model <model-id>
--prompt <text>
--help, -h
--version, -v
```

- `project` 默认为当前目录。
- API Key 只读取 `OPENAI_API_KEY` 或 `DEEPSEEK_API_KEY`。
- 不接受 `--api-key`。
- 交互模式缺少 Provider 或模型时询问用户。
- `--model` 存在时不请求模型列表。
- 一次性 `--prompt` 模式必须同时提供 Provider 和模型，保证脚本不等待交互。
- 参数或配置失败发生在 Agent 创建前。

### 9.2 模型选择

- 使用 `@inquirer/select`。
- 上下键移动，Enter 确认，`Ctrl+C` 取消。
- Provider 只有 OpenAI 与 DeepSeek。
- 模型列表来自 Provider `/models`，排序并去重。
- 每页显示约 10 项，支持组件自带的快速匹配。
- 模型列表为空或请求失败时，提示用户使用 `--model` 手动指定。
- 第一版不根据模型名猜测 Tool Calling 能力。

### 9.3 交互模式

- 使用 Node `readline` 接收单行问题。
- 空行忽略。
- Agent 运行期间不接受下一条输入。
- `/help` 显示项目、Provider、模型和命令。
- `/reset` 清空 Agent 内存历史，不清屏、不改文件。
- `/exit` 正常关闭。
- 未知斜杠命令不发送给模型。

TUI 展示模型调用次数、工具开始/完成/失败、最终回答、Turn 数量和简化错误；不展示 API Key、完整 SDK 响应、完整工具 JSON、堆栈或 reasoning。

### 9.4 退出与错误

- `/exit` 和 `Ctrl+D` 返回 0。
- `Ctrl+C` 返回 130。
- 一次性模式成功返回 0，参数、配置、Provider 或 Agent 失败返回 1。
- TUI 中单次问题失败后恢复输入提示符。
- 第一版运行中的 `Ctrl+C` 直接结束进程；优雅的 AbortSignal 传播延期。

## 10. 限制与确定性

- 最多扫描 500 个相关文件。
- 单次读取最多 300 行、256 KB。
- Agent 最多 8 Turns。
- 工具输出使用稳定的相对路径和排序。
- 截断结果必须带 `truncated: true`，并提供足够计数信息让模型说明覆盖范围。
- 不跟随符号链接；使用 `path.relative()` 与必要的 `realpath()` 检查阻止路径逃逸和相似前缀目录绕过。

## 11. 测试方案

### 11.1 工具测试

- README 存在与不存在。
- 忽略目录、隐藏目录和符号链接。
- 普通 `../`、嵌套逃逸、相似目录前缀和指向项目外的 symlink。
- 小文件、分段读取、二进制拒绝和文件不存在。
- import、import type、副作用 import、多行 import、export from、注释和字符串伪 import。
- 扩展名映射、index 文件、冲突候选和不存在入口。
- 内部、Node 内置、npm、scoped package、未解析和 unsupported 分类。
- 自循环、两节点循环、多节点循环、共享节点循环和去重。
- 499/500/501 文件、299/300/301 行、255/256/257 KB 的边界值。
- 文件、依赖边、外部包、循环和截断结果的稳定排序。

### 11.2 模型层测试

- 四类 mini-Pi Message 到 SDK 消息的转换。
- 普通文本、null content、单个与多个 tool call。
- assistant 文本与 tool call 同时出现。
- Tool Result 的 `toolCallId` 和顺序保持。
- 非法 arguments JSON。
- Provider 返回空 choices、空 content 且无 tool call。
- 模型列表为空、重复、未排序、401、超时。
- 传入 `--model` 时不请求模型列表。
- DeepSeek 请求明确关闭 thinking。

### 11.3 Agent 测试

- 模型直接回答。
- 工具调用、回填和最终回答。
- 多工具顺序执行。
- 工具不存在、非法 JSON、参数错误和工具异常后的恢复。
- Provider 错误事件和本次运行消息回滚。
- 7/8/9 Turn 边界。
- 连续问题共享历史和 `reset()`。
- AgentEvent 字段与顺序。

### 11.4 CLI/TUI 测试

- help、version、非法 Provider、无效项目路径和缺少 API Key。
- 一次性模式参数要求、成功和失败退出码。
- 抽出的命令解析、空输入和 AgentEvent 格式化函数。
- Provider/模型方向键选择、`Ctrl+C` 和终端恢复采用手动冒烟测试。

自动测试使用 Fake LLM 和临时项目，不调用付费 API。

## 12. 完成标准

### 实现完成

- 五个源码文件实现全部第一版契约。
- 核心源码合计不超过 1000 行。

### 本地验证完成

- TypeScript typecheck 通过。
- 工具、模型转换、Agent 和 CLI 自动测试通过。
- 一次性模式和 TUI 本地启动正常。

### Provider 验证完成

- OpenAI 普通回答与“tool call → tool result → 最终回答”各成功一次。
- DeepSeek 普通回答与“tool call → tool result → 最终回答”各成功一次。

真实 Provider 测试只在用户提供环境变量并选择执行时运行。若未运行，交付状态必须写为“Provider integration implemented but not live-verified”，不能声称完整验证。

## 13. 工程与发布

- Node.js 最低版本为 22。
- ESM TypeScript 项目。
- 运行依赖：`openai`、`typescript`、`@inquirer/select`。
- 开发依赖：`@types/node`、`tsx`。
- 测试使用 Node `node:test`。
- 构建产物位于 `dist`，CLI 命令为 `mini-pi`。
- Git 忽略 `.env`、`node_modules`、`dist`、`coverage`、日志和 `.superpowers` 可视化草稿。
- GitHub 仓库为公开的 `mini-Pi`。
- GitHub 创建、远程关联和推送在本地实现与验证完成后执行。

## 14. 实现顺序

```text
1. tool.ts：接口、路径安全、扫描、读取、AST 与测试
2. llm.ts：Provider、模型列表、消息转换与测试
3. agent.ts：Fake LLM Agent Loop、事件、回滚与测试
4. cli.ts：参数、装配、一次性模式与测试
5. tui.ts：选择器、readline、命令与手动冒烟
6. OpenAI/DeepSeek 可选真实冒烟
7. README、公开 GitHub 仓库关联与推送
```
