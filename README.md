# mini-Pi

一个刻意保持小而可读的 TypeScript 终端 Agent。它只读地分析 TypeScript / JavaScript 项目：扫描目录、读取受限文本、检查静态 import 依赖，并用语法级 Repo Index 快速定位与问题相关的候选文件。项目的目的不是做一个功能齐全的编码助手，而是通过可测试、可测量的增量，学习 LLM Provider、Tool Calling、Agent loop、上下文管理、CLI 与 TUI 如何组成一个可运行闭环。

## 架构

核心按职责切分五个源文件，保持精简（按需增长，避免无意义拆分，也避免堆成大块）：

| 文件 | 职责 |
| --- | --- |
| `src/llm.ts` | Provider 注册表（OpenAI Chat Completions 兼容的多 provider）、消息转换、错误诊断归一。 |
| `src/agent.ts` | 保存消息历史，运行“模型 → 工具 → 模型”的 Agent loop。 |
| `src/tool.ts` | 提供只读项目工具，并限制路径、大小与依赖分析范围。 |
| `src/cli.ts` | 处理启动参数、全局偏好、Provider / Model / Key 凭据与各层装配。 |
| `src/tui.ts` | 提供终端输入、命令和上下键选择；移除它不影响 Agent 核心。 |

## 功能阶段

- **v1：已完成。** OpenAI / DeepSeek、动态模型列表、只读项目扫描 / 文件读取 / TS-JS 静态依赖分析，以及有最大轮数的 Agent loop。
- **v1.1：已完成。** 接近 Pi 的首次登录向导：安全保存 API Key，记住全局默认 Provider / 模型，之后直接进入聊天；支持 `/login`、`/model`、`/logout`。
- **v1.2：已完成。** TUI 会把最终回答的 Markdown 渲染为终端标题、列表、强调和代码样式；模型内容中的终端控制序列会被过滤，链接不会变成可点击的终端超链接。
- **v1.3：已完成。** 交互式会话以低对比度的用户、回答、活动和错误层呈现；工具活动默认折叠，不输出原始事件日志。
- **v2A：已完成。** 工具权限由 Agent runtime 强制执行：安全工具自动运行；需要确认的工具会在终端展示操作、原因、风险和参数，并等待用户决定。
- **v2B / Issue #9、#18：已完成。** 启动时在本地构建一次有界、语法级 TS/JS Repo Index；每次提问只把按问题生成的紧凑 Repo Map 作为临时上下文发送给 Provider，并提供 `query_repo_map` 做一次按需细化。候选会标注 product/test/vendor 等范围、workspace package、排序理由和置信度；最终结论仍须读取源码验证。
- **后续方向。** 项目级模型偏好、会话恢复、流式输出、OAuth、更多 Provider 等尚未实现，见 [DEFERRED_FEATURES.md](DEFERRED_FEATURES.md)。

## 大型项目导航：当前阶段

mini-Pi 现在具备的是**大型 TypeScript / JavaScript 项目的候选定位能力**：先以受限预算建立本地地图，再按用户问题缩小候选范围，最后由 Agent 读取源码获得证据。它不是完整的“自动读懂大型项目”系统，也不应把地图排名当作最终结论。

### 已交付能力

- **有界发现与索引：** 识别 TS/JS 源文件、导入导出、选定声明签名和静态依赖；遵守根 `.gitignore`，排除常见构建目录，并限制文件数、单文件大小和总字节数。
- **紧凑 Repo Map：** 每轮仅注入与当前问题相关、最多 4,000 字符的临时地图；地图不会写入聊天历史、配置、凭据或 TUI 活动记录。
- **范围感知排序：** 产品代码、测试、vendor、example/generated 范围、workspace package、角色词与角色文件形式共同排序；结果说明理由和 `high` / `ambiguous` / `fallback` 置信度。
- **证据式探索：** Map 只用于定位。模型仍通过只读 `read_file`、`query_repo_map`、`analyze_dependencies` 等工具验证源码；索引异常会退回既有的扫描和读取流程。

### 实验阶段与证据

| 阶段 | 问题 | 已验证的结果 | 边界 |
| --- | --- | --- | --- |
| [#9 Repo Map](docs/experiments/9-query-aware-repo-map.md) | 索引能否让导航少走弯路？ | 本地固定轨迹中 Top-1 / Top-3 为 5/5；首次读取正确候选前的 Tool 调用中位数从 4 降至 1。 | 使用 fake LLM，不代表真实 token、费用或延迟。 |
| [#16 / #17 外部评估](docs/experiments/10-deepseek-harness-repo-map-evaluation.md) | 简单词面排序在真实大型 monorepo 上够用吗？ | 不够用：产品范围 Top-1 0/5、Top-3 1/5，明确暴露了排序问题。 | 外部仓库只读；不调用 Provider。 |
| [#18 / #19 范围排序](docs/experiments/18-scope-aware-repo-map-ranking.md) | scope/package/角色排序是否改善候选？ | 同一五题提升至产品范围 Top-1 3/5、Top-3 5/5。 | 仍是确定性轨迹，且 Map 可能截断。 |
| [#20 / #21 真实 Provider](docs/experiments/20-live-provider-repo-map-evaluation.md) | 真实模型会怎样使用 Map？ | 一次 DeepSeek V4 Flash 运行中，五题均读取并提及正确路径；18 / 20 次请求，185,491 total tokens。 | 单一模型、单个 commit、一次顺序运行；未测 TTFT 或真实价格。 |

### 如何理解这些结果

真实闭环已经可用：Agent 不必遍历全部源码，就能先得到候选，再读取正确文件验证。与此同时，结果也指出了当前效率问题：五题中的 tools registry 一题消耗 107,210 tokens，说明模型仍可能重复查询、重复读取或做不必要的扫描。实验数据是进一步优化的起点，不是“已解决大型项目分析”的证明。

### 边界与下一步

- 当前不生成完整 call graph，不理解函数 body 语义，不追踪运行时动态关系，也不支持所有编程语言。
- 4,000 字符是默认成本/覆盖折中；遇到歧义时可用 `query_repo_map` 进一步缩小范围，而不是盲目扩大所有上下文。
- 下一步是 [Issue #10](https://github.com/justlearner010/mini-Pi/issues/10)：加入工具编排与证据护栏，明确何时细化地图、何时读源码、何时检查依赖，并以同一题集继续比较真实请求数、token 与端到端延迟。

## 安装

需要 Node.js 22 或更高版本。

```sh
git clone https://github.com/justlearner010/mini-Pi.git
cd mini-Pi
npm install
npm run build
```

`@github/keytar` 是原生依赖：macOS 使用 Keychain，Windows 使用 Credential Vault，Linux 使用 Secret Service。Linux 桌面环境通常还需要系统安装 `libsecret` 开发库；没有可用系统凭据库时，仍可用环境变量临时运行。

## 使用

第一次启动会自动进入向导：用上下键选择 Provider，隐藏输入 API Key，再选择模型。Key 只会写入系统凭据库；`~/.mini-pi/config.json` 只记录上次的 Provider 和模型，不含 Key。

```sh
npm run dev -- ../my-project
```

以后再次运行同一命令，会读取安全凭据和全局默认模型，直接进入 TUI。

构建后的本地启动方式：

```sh
node dist/src/cli.js ../my-project
```

若希望把当前仓库的命令链接到本机全局环境，可在构建后执行 `npm link`，随后使用：

```sh
mini-pi ../my-project
```

TUI 内可输入问题，或使用以下命令：

- `/login`：新增或替换当前 Provider 的 Key，并选择新的默认模型。
- `/model`：为当前 Provider 拉取模型列表并切换默认模型。
- `/provider [id]`：不带参数时列出已注册的 Provider 并标记当前使用的；带参数时切换到该 Provider（需要该 Provider 的 Key 已配置）。
- `/logout`：上下键选择一个已登录 Provider，删除它的系统凭据。
- `/project <目录>`：切换到另一个项目目录（绝对或相对路径均可，含空格或引号的目录名按 Shell 习惯处理），重新构建 Repository Index 并清空当前对话，之后即可分析新项目；默认 Provider 与模型保持不变。Agent 也可以自行发起切换：当问题涉及当前根目录之外的项目时，它会调用 `switch_project` 工具并在终端展示目标路径，你输入 `y` 确认后即完成切换并继续分析。
- `/help`、`/reset`、`/exit`：查看信息、清空当前对话（也会清除本次会话的活动记录）、退出。

### Providers

mini-Pi 通过 OpenAI Chat Completions 协议连接多 Provider，配置通过 `src/llm.ts` 的 `providerRegistry` 维护（加一个 Provider 只改配置、不改协议代码）：

| ID | 显示名 | 备注 |
| --- | --- | --- |
| `openai` | OpenAI | `OPENAI_API_KEY` |
| `deepseek` | DeepSeek | `DEEPSEEK_API_KEY`，自动加 `extra_body.thinking.disabled` |
| `openrouter` | OpenRouter | `OPENROUTER_API_KEY`，自动加 `HTTP-Referer` / `X-Title` header |
| `together` | Together AI | `TOGETHER_API_KEY` |
| `groq` | Groq | `GROQ_API_KEY` |
| `mistral` | Mistral | `MISTRAL_API_KEY` |
| `ollama` | Ollama (local) | `http://localhost:11434/v1`，无需 Key |
| `vllm` | vLLM (local) | `http://localhost:8000/v1`，无需 Key |

OAuth / Anthropic / Google 等需要新协议的 Provider 是 B 档、C 档延后项，见 [DEFERRED_FEATURES.md](DEFERRED_FEATURES.md)。

模型的最终回答支持常见 Markdown：标题、列表、粗体/斜体、行内代码、代码块和引用会以适合终端阅读的形式显示。回答仍是非流式的：一次 Agent 运行结束后才展示最终答案。工具活动默认收起为 `▸ activity · N tools · duration`；在空输入处直接按 Enter 可展开或再次收起最近一次活动。没有可展开活动时，空 Enter 不做任何事。活动只保留安全的工具名称和简短失败摘要，不会显示完整工具输出或推理内容。

Provider 或 Agent 错误使用红色区块显示安全诊断，并保留可展开的活动记录。

启动 TUI 时会显示本地 Repository Index 的文件数、跳过数和是否截断。Index 只保存路径、import/export、选定声明签名和依赖关系，不分析函数 body；根目录 `.gitignore` 会被读取，嵌套 `.gitignore` 当前只计数并报告，不会解释。索引超出文件数、单文件或总字节限制时会截断并降级，而不是无限扫描。

每个用户问题会获得一份不超过预算的 query-aware Repo Map。它只存在于本次 `Agent.run()` 的临时消息中，不写入对话历史、配置、凭据或终端活动详情。模型应先用它定位候选文件，再通过 `read_file` 验证源码；候选缺失、冲突或歧义时，可调用只查询内存索引的 `query_repo_map`。Index 构建失败时，mini-Pi 会回退到原有 `scan_project`、`read_file`、`analyze_dependencies` 流程。

当 Agent 请求非安全工具时，终端会显示工具名、理由、风险与 JSON 参数。`SENSITIVE` 操作只能输入完全一致的 `y` 才会执行；`DESTRUCTIVE` 操作会显示 `HIGH RISK` 不可逆警告，且只能输入完全一致的 `yes` 才会执行。空输入、其他输入、EOF、Ctrl+C 或提示失败都会安全地拒绝；拒绝结果会作为一条工具观察返回给 Agent，让它调整后续回答。

一次性模式必须明确指定 Provider 和模型：

```sh
OPENAI_API_KEY="..." npm run dev -- ../my-project \
  --provider openai --model gpt-4.1-mini \
  --prompt "主要入口文件在哪里？"
```

环境变量 `OPENAI_API_KEY` 或 `DEEPSEEK_API_KEY` 会临时优先于系统凭据库，适合 CI、服务器或临时换 Key；它们不会覆盖已安全保存的 Key。API Key 不接受命令行参数，也不要提交到 Git。

## 请求错误诊断

模型请求失败时，mini-Pi 会显示中文的错误级别、Provider、回合、原因与建议。例如认证失败会提示运行 `/login` 更新 Key，限流会建议稍后重试或切换模型。若需要排查技术细节，可在启动时开启安全调试信息：

```sh
MINI_PI_DEBUG=1 npm run dev -- ../my-project
```

调试模式只额外显示 HTTP 状态码与经过白名单筛选的 Provider 错误码；原始 request ID 不可信，因此不会显示。它同样不会显示 API Key、请求头、聊天/文件/工具内容或完整响应。

## 安全与边界

工具只能在选定项目根目录内读取文件，会拒绝路径穿越和符号链接逃逸，忽略常见构建目录，并限制扫描与读取输出。当前只读工具属于 `SAFE`，会自动执行；未来的敏感或破坏性工具仍必须经过 runtime 权限边界。mini-Pi 不修改项目、不运行项目代码、不执行 Shell 命令。

模型请求会将工具可见的项目文本发送给所选 Provider，并可能产生费用。运行前请确认目标项目可被发送，并阅读对应 Provider 的政策。

## 验证

```sh
npm test
npm run check
npm run build
npm run verify:bin
npm run verify:package
```

自动化测试使用假的凭据库和 Provider 客户端；仓库不会用真实 API Key 或真实系统凭据做测试。真实 OpenAI / DeepSeek 请求也没有在自动化测试中验证，因为它们需要你的凭据且可能产生费用。

多 Provider 真实端到端测试（opt-in，消耗 token / 钱）：

```sh
MINI_PI_TEST_PROVIDERS=deepseek,openrouter \
  DEEPSEEK_API_KEY=sk-... OPENROUTER_API_KEY=sk-... \
  npm run test:providers
```

脚本对每个 Provider 并行跑 12 轮 Agent + 一次会话内项目切换，打印对比表（哪些 Provider 通过、第一条失败在第几轮、用了多少时间）。未指定 `MINI_PI_TEST_PROVIDERS` 时自动选取所有有可用 Key 的 Provider。

Repo Map 的本地确定性实验可运行：

```sh
npm run benchmark:repo-map
npm run verify:repo-map
```

这组命令只运行本地、确定性的 fake-LLM 实验。真实 Provider 评估需要显式 `DEEPSEEK_API_KEY`，会发送模型选择读取的项目内容并可能产生费用，因此不属于 `npm test`；请先阅读 [#20 的真实运行边界与结果](docs/experiments/20-live-provider-repo-map-evaluation.md)。
