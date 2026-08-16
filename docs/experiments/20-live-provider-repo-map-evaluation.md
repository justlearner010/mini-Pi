# Issue #20：真实 DeepSeek Repo Map 评估

## 结论

一次受预算限制的真实 Provider 运行完成：五个预注册问题均得到回答，均读取了预注册正确源码路径，并在最终回答中提到了该路径。实际使用 DeepSeek V4 Flash 的 18 次请求，低于 20 次硬上限；没有自动重试或预算耗尽。

这是一份真实 token 与完成延迟观测，不是一般化的模型能力或价格结论。它只覆盖一个模型、一个目标 commit、五个问题和一次顺序运行；模型为非流式 Chat Completions，故**未测量 TTFT**。

## 固定环境与边界

- 目标：本地只读 `deepseek-harness`，commit
  `47f943859bef60e4160492346772ded9b24f765a`
- Provider / model：DeepSeek / `deepseek-v4-flash`
- 问题：Issue #16/18 预注册的 CLI、Agent loop、tools registry、DeepSeek adapter、basic compaction 五题
- 限制：每题最多 6 turns；全程至多 20 个已开始 Provider 请求；无自动重试
- 目标仓库没有被修改，也没有运行目标仓库代码。
- 报告不保存 API Key、完整 prompt、Repo Map、源码、工具输出、完整模型回答、原始错误或 request ID。原始脱敏 JSON 只保留在未跟踪的临时路径，不提交仓库。

## 真实 Provider 使用

| 指标 | 观测值 |
| --- | ---: |
| 已开始请求 / 上限 | 18 / 20 |
| prompt tokens | 178,608 |
| completion tokens | 6,883 |
| total tokens | 185,491 |
| 请求完成延迟：min / p50 / mean / max | 1,226 / 1,800 / 3,156 / 8,189 ms |
| 整题端到端延迟：min / p50 / mean / max | 6,071 / 9,818 / 11,518 / 17,716 ms |
| turns：min / p50 / mean / max | 2 / 3 / 4 / 5 |
| 工具调用：min / p50 / mean / max | 2 / 4 / 4 / 6 |

Provider 在全部 18 次请求中都报告了标准 prompt/completion/total usage；因此没有 token 缺失项。延迟包含网络、Provider 推理和 API 完成等待；它不包含流式首 token，因为当前请求禁用了流式输出。

## 每题结果

| 问题 | turns | 请求 | total tokens | 端到端 ms | 工具调用 | Map Top-1 / Top-3 | 读取正确源码 | 最终答案提及正确路径 |
| --- | ---: | ---: | ---: | ---: | ---: | --- | --- | --- |
| CLI entry | 3 | 3 | 10,879 | 9,082 | 3 | ✓ / ✓ | ✓ | ✓ |
| Agent loop | 5 | 5 | 43,792 | 14,901 | 5 | ✗ / ✓ | ✓ | ✓ |
| Tools registry | 5 | 5 | 107,210 | 17,716 | 6 | ✗ / ✓ | ✓ | ✓ |
| DeepSeek adapter | 2 | 2 | 9,539 | 6,071 | 2 | ✓ / ✓ | ✓ | ✓ |
| Basic compaction | 3 | 3 | 14,071 | 9,818 | 4 | ✓ / ✓ | ✓ | ✓ |

## 观察与限制

1. #18 的 Map Top-3 对五题均包含正确路径；真实模型也确实读取了正确路径，而不是只依赖地图回答。
2. 两个非 Top-1 问题仍能完成验证，但代价较高：Agent loop 需要一次 `query_repo_map` 和重复读取；tools registry 使用 5 次模型请求、超过十万 tokens，是本次最大的上下文成本。
3. 工具轨迹不是由 benchmark fake LLM 固定的；真实模型自行调用 `scan_project`、`query_repo_map`、`read_file`。因此 token/延迟具有真实参考价值，但一次运行不可作为稳定平均值。
4. 这组题都由模型最终回答成功，不能推出任意大型项目、任意问题或 OpenAI Provider 都会同样表现。
5. 未测真实价格：价格表、缓存计费和账户折扣是 Provider/模型/时间相关信息；本报告只记录 Provider 返回的 token usage。

## 建议

真实闭环已验证可用，但成本分布不均。下一步最有价值的是 Issue #10 的工具编排与证据护栏：当 Map 已给出 Top-3 且工具已读到正确候选时，应减少重复 `query_repo_map`、重复 `read_file` 和不必要的项目扫描。后续改动应在相同预注册题集上比较真实 total tokens、请求数和端到端延迟，但每次运行前设置独立预算并明确可能产生费用。

## 复现说明

`benchmark:deepseek-harness:live` 需要显式 `DEEPSEEK_API_KEY`，会发送模型选择读取的目标项目内容给 DeepSeek 并可能产生费用，因此不属于 `npm test`。本次结果来自一次受 20 次请求上限约束的运行；不得为了改善结果而重复调用。

