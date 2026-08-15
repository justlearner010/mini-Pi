# Issue #9：Query-aware Repo Map 实验报告

## 结论

本地确定性实验通过关闭门槛。8,000 字符版本的候选路径 Top-1 / Top-3 均为 5/5；与无 Map 的固定探索轨迹相比，首次读取正确候选前的 Tool 调用中位数从 4 降到 1（-75%），此前返回的源码字节中位数从 1,255 降到 0（-100%）。15/15 次运行均正常回答，没有失败或最大轮次结果。

这证明了“语法级索引可以让固定 Agent 轨迹更早定位并读取正确文件”，但不证明真实模型一定采用相同决策。Provider token、真实费用、端到端 latency 均为 **NOT MEASURED**。在 owner 使用同一 Provider、模型、参数和三次重复完成 live run 前，不应宣传真实成本或延迟已经下降。

4,000 与 8,000 的候选准确率和探索量完全相同，而 4,000 的请求字符更少，因此生产自动 Map 默认使用 **4,000 字符**；`query_repo_map` 仍保留 8,000 给歧义查询或显式细化。

## 实验环境与方法

- 基准代码 commit：`eee19cbeed91aeabb4e1c3d896714476153f3c75`
- Node.js：`v26.0.0`
- TypeScript：`5.9.3`
- 仓库：该 commit 的 mini-Pi 工作树，冷启动时本地构建一次 Index
- 原始 JSON：本地 `/tmp/mini-pi-query-repo-map.json`（不提交；可由命令重建）
- 重复性：verifier 连续运行两次，去除 `indexBuildMs`、`mapRenderMs` 后深比较
- Provider / model：固定 fake LLM trajectory，不调用真实 Provider
- 三组：`none`、`map-4000`、`map-8000`

五个问题及预先声明的期望路径：

| ID | 问题 | 期望路径 |
| --- | --- | --- |
| cli | Where is CLI handling implemented? | `src/cli.ts` |
| llm-provider | Which module defines the LLM provider? | `src/llm.ts` |
| tool-execution | Where is tool execution handled? | `src/tool.ts` |
| agent-dependents | Which modules depend on Agent? | `src/agent.ts` |
| provider-config | Where should I inspect provider configuration? | `src/llm.ts` |

无 Map 轨迹先执行 `scan_project`、读取 manifest、分析依赖，再读取正确候选；Map 轨迹直接读取排名候选。两组都使用真实生产 `Agent` 和真实只读 Tool 实现，但模型决策是固定的，因此本实验隔离的是“导航上下文是否能支持更短路径”，不是自然语言模型自主规划能力。

## 15 行结果

`pre-read calls` 是首次正确候选读取在 Tool 序列中的位置；`pre-read bytes` 是此前成功 `read_file` 返回的源码字节。时间只用于观察，不作为 CI 阈值。

| variant | question | outcome | Top-1 | Top-3 | turns | model req | tools | files read | returned bytes | pre-read bytes | request chars | pre-read calls | index ms | map ms |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| map-4000 | agent-dependents | answered | 1 | 1 | 2 | 2 | 1 | 1 | 8,611 | 0 | 21,009 | 1 | 83.48 | 1.48 |
| map-4000 | cli | answered | 1 | 1 | 2 | 2 | 1 | 1 | 19,296 | 0 | 31,891 | 1 | 83.48 | 2.43 |
| map-4000 | llm-provider | answered | 1 | 1 | 2 | 2 | 1 | 1 | 7,475 | 0 | 19,553 | 1 | 83.48 | 1.33 |
| map-4000 | provider-config | answered | 1 | 1 | 2 | 2 | 1 | 1 | 7,475 | 0 | 19,569 | 1 | 83.48 | 1.39 |
| map-4000 | tool-execution | answered | 1 | 1 | 2 | 2 | 1 | 1 | 19,109 | 0 | 31,958 | 1 | 83.48 | 1.41 |
| map-8000 | agent-dependents | answered | 1 | 1 | 2 | 2 | 1 | 1 | 8,611 | 0 | 29,133 | 1 | 83.48 | 1.92 |
| map-8000 | cli | answered | 1 | 1 | 2 | 2 | 1 | 1 | 19,296 | 0 | 40,005 | 1 | 83.48 | 1.94 |
| map-8000 | llm-provider | answered | 1 | 1 | 2 | 2 | 1 | 1 | 7,475 | 0 | 27,693 | 1 | 83.48 | 1.63 |
| map-8000 | provider-config | answered | 1 | 1 | 2 | 2 | 1 | 1 | 7,475 | 0 | 27,693 | 1 | 83.48 | 1.61 |
| map-8000 | tool-execution | answered | 1 | 1 | 2 | 2 | 1 | 1 | 19,109 | 0 | 40,128 | 1 | 83.48 | 1.56 |
| none | agent-dependents | answered | — | — | 5 | 5 | 4 | 2 | 20,926 | 1,255 | 53,871 | 4 | 0 | 0 |
| none | cli | answered | — | — | 5 | 5 | 4 | 2 | 31,611 | 1,255 | 64,769 | 4 | 0 | 0 |
| none | llm-provider | answered | — | — | 5 | 5 | 4 | 2 | 19,790 | 1,255 | 52,397 | 4 | 0 | 0 |
| none | provider-config | answered | — | — | 5 | 5 | 4 | 2 | 19,790 | 1,255 | 52,437 | 4 | 0 | 0 |
| none | tool-execution | answered | — | — | 5 | 5 | 4 | 2 | 31,424 | 1,255 | 64,810 | 4 | 0 | 0 |

## 汇总与门槛

| 指标 | none | map-4000 | map-8000 | 判定 |
| --- | ---: | ---: | ---: | --- |
| answered | 5/5 | 5/5 | 5/5 | 通过：无新失败/最大轮次 |
| Top-1 | N/A | 5/5 | 5/5 | 通过（8K 要求 >=4/5） |
| Top-3 | N/A | 5/5 | 5/5 | 通过（8K 要求 5/5） |
| median pre-read Tool calls | 4 | 1 | 1 | -75%，通过 >=30% 门槛 |
| median pre-read source bytes | 1,255 | 0 | 0 | -100%，通过 >=30% 门槛 |
| turns / run | 5 | 2 | 2 | 固定轨迹下降 60% |

4K 与 8K 都准确命中；8K 每次请求多携带约 8,100 个累计请求字符（两次模型请求的合计差），没有换来更好结果。因此当前问题集支持 4K 默认、8K 按需。

## 失败、方差与 trade-off

- **没有观察到运行失败。** verifier 会把任何 `failed`、`maximum_turns`、不足 15 行、准确率或降幅不达标视为阻塞。
- **时间有方差。** 本次 Index 构建约 83.48 ms，Map 渲染约 1.33–2.43 ms；机器缓存、Node 版本和仓库变化都会影响它们，所以不作为稳定阈值。
- **结果会随仓库 revision 漂移。** 源文件大小会改变 `returnedToolBytes` 与请求字符；新增 symbol 可能改变排名。verifier 只要求结构、重复性和行为门槛。
- **固定轨迹偏向验证机制。** 它证明 Map 足以支持直接读取候选，但没有证明真实模型一定减少探索；需要 owner live run 验证自然决策。
- **Syntax-only 的边界。** Map 不读函数 body、不构建 call graph、不解析运行时动态行为；候选必须用 `read_file` 验证。
- **上下文换探索。** Map 增加第一次模型请求的元数据，但可以减少后续轮次和源码返回。4K 在本问题集占优；复杂 monorepo 可能需要 8K 或一次 `query_repo_map` 细化。
- **忽略规则不完整。** 只应用根 `.gitignore`；嵌套规则只计数。索引有 5,000 文件、512 KiB/文件和 50 MiB 总量边界，截断时结果可能遗漏候选。

## 最终建议

确定性门槛 **PASS**，Issue #9 可以进入 owner review。建议把默认自动 Map 改为 4,000 字符，并保留 8,000 给 `query_repo_map` 或明确的歧义细化；在 live Provider 实验前，只宣称“本地固定轨迹减少了探索”，不要宣称真实 token、费用或 latency 已降低。

复现实验：

```sh
npm run benchmark:repo-map
npm run verify:repo-map
```
