# mini-Pi

一个刻意保持小而可读的 TypeScript 终端 Agent。它只读地分析 TypeScript / JavaScript 项目：扫描目录、读取受限文本、检查静态 import 依赖，并用语法级 Repo Index 快速定位与问题相关的候选文件。项目的目的不是做一个功能齐全的编码助手，而是通过可测试、可测量的增量，学习 LLM Provider、Tool Calling、Agent loop、上下文管理、CLI 与 TUI 如何组成一个可运行闭环。

## 架构

核心始终只有五个源文件：

| 文件 | 职责 |
| --- | --- |
| `src/llm.ts` | 统一 OpenAI 与 DeepSeek 的模型调用和消息转换。 |
| `src/agent.ts` | 保存消息历史，运行“模型 → 工具 → 模型”的 Agent loop。 |
| `src/tool.ts` | 提供只读项目工具，并限制路径、大小与依赖分析范围。 |
| `src/cli.ts` | 处理启动参数、全局偏好、系统凭据与各层装配。 |
| `src/tui.ts` | 提供终端输入、命令和上下键选择；移除它不影响 Agent 核心。 |

## 功能阶段

- **v1：已完成。** OpenAI / DeepSeek、动态模型列表、只读项目扫描 / 文件读取 / TS-JS 静态依赖分析，以及有最大轮数的 Agent loop。
- **v1.1：已完成。** 接近 Pi 的首次登录向导：安全保存 API Key，记住全局默认 Provider / 模型，之后直接进入聊天；支持 `/login`、`/model`、`/logout`。
- **v1.2：已完成。** TUI 会把最终回答的 Markdown 渲染为终端标题、列表、强调和代码样式；模型内容中的终端控制序列会被过滤，链接不会变成可点击的终端超链接。
- **v1.3：已完成。** 交互式会话以低对比度的用户、回答、活动和错误层呈现；工具活动默认折叠，不输出原始事件日志。
- **v2A：已完成。** 工具权限由 Agent runtime 强制执行：安全工具自动运行；需要确认的工具会在终端展示操作、原因、风险和参数，并等待用户决定。
- **v2B / Issue #9、#18：候选实现。** 启动时在本地构建一次有界、语法级 TS/JS Repo Index；每次提问只把按问题生成的紧凑 Repo Map 作为临时上下文发送给 Provider，并提供 `query_repo_map` 做一次按需细化。候选会标注 product/test/vendor 等范围、workspace package、排序理由和置信度；最终结论仍须读取源码验证。
- **后续方向。** 项目级模型偏好、会话恢复、流式输出、OAuth、更多 Provider 等尚未实现，见 [DEFERRED_FEATURES.md](DEFERRED_FEATURES.md)。

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

- `/login`：新增或替换某个 Provider 的 Key，并选择新的默认模型。
- `/model`：为当前 Provider 拉取模型列表并切换默认模型。
- `/logout`：上下键选择一个已登录 Provider，删除它的系统凭据。
- `/help`、`/reset`、`/exit`：查看信息、清空当前对话（也会清除本次会话的活动记录）、退出。

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

Repo Map 的本地确定性实验可运行：

```sh
npm run benchmark:repo-map
npm run verify:repo-map
```

实验使用固定假模型轨迹，只验证候选定位、上下文边界和工具探索量；它不证明真实 Provider token、价格或端到端延迟已经下降。完整结果见 [Issue #9 实验报告](docs/experiments/9-query-aware-repo-map.md)。

在外部大型 monorepo `deepseek-harness` 上，Issue #16 先确认简单词面 Ranking 不足；Issue #18 随后以同一五题验证了 scope/package/角色排序的改进（产品范围 Top-1 `3/5`、Top-3 `5/5`）。两份证据与限制分别见 [基线评估](docs/experiments/10-deepseek-harness-repo-map-evaluation.md) 和 [Issue #18 报告](docs/experiments/18-scope-aware-repo-map-ranking.md)。两项实验都不调用真实 Provider。
