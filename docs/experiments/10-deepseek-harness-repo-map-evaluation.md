# Issue #16：deepseek-harness 双轨 Repo Map 评估

## 结论

当前 mini-Pi 的 Repo Map **不适合宣称已具备大型 monorepo 的有效导航能力**。在 `deepseek-harness` 的五个预先声明问题上，完整仓库范围的 4K / 8K Map 均为 Top-1 `0/5`、Top-3 `0/5`；产品源码范围的 4K / 8K Map 均为 Top-1 `0/5`、Top-3 `1/5`。

实验成功地验证了双轨设计的价值：排除 `vendor/`、tests、fixtures 和 examples 后，索引从 2,586 文件 / 24.3 MB 缩小至 1,503 文件 / 10.9 MB，Map 渲染中位数从约 39.7 ms 降至约 25.9 ms；但准确率仍不足。这说明问题不只是噪声范围，还包括当前简单 Ranking 的信息与权重不足。

该结论来自真实生产 Index、Map renderer、Agent 与只读 Tool 的本地确定性运行；不调用 Provider。真实 token、成本、模型行为和端到端延迟均为 **NOT MEASURED**。

## 实验原则

1. 题目与正确路径在运行前由 `deepseek-harness` 的 `AGENTS.md` 和 `docs/architecture.md` 固定。
2. 不修改目标仓库，不运行其项目代码，不发送任何文件或元数据给 Provider。
3. 双轨只改变候选范围：完整仓库保留全部可索引 TS/JS；产品源码只保留 `apps/`、`packages/`、`scripts/`、`native/`，并排除 `vendor/`、tests、fixtures、examples、生成目录和 `packages/test-support/`。
4. 每个范围比较 `none`、`map-4000`、`map-8000`，并使用相同的固定 fake-model 轨迹。
5. Map 只产生候选；实际读取预先声明路径才算验证。若 Top-1 错误，轨迹会先读取该错误候选，再读取正确路径，因此能够量化误排的成本。
6. runner 连续运行两次，去掉纯计时字段后深比较；verifier 仅确认可重复性、30 行完整结果、数值字段与源码验证，不把当前差的准确率伪装成通过。

## 环境

- 目标仓库：`deepseek-harness`
- 目标 commit：`47f943859bef60e4160492346772ded9b24f765a`
- mini-Pi：Issue #9 分支上的实验 worktree
- Node.js：`v26.0.0`
- TypeScript：`5.9.3`
- 原始 JSON：本地 `/tmp/mini-pi-deepseek-harness-repo-map-final.json`，可由 benchmark 重建，不提交仓库

## 预注册问题

| ID | 问题 | 正确源码路径 |
| --- | --- | --- |
| cli-bin | Where does the dsh CLI start? | `apps/cli/src/bin.ts` |
| agent-loop | Where is the default Agent loop implemented? | `packages/core/agent-loop/src/agent.ts` |
| tools | Where is the core tool registry implemented? | `packages/core/tools/src/index.ts` |
| deepseek-adapter | Where is the DeepSeek LLM adapter implemented? | `packages/llm/llm-deepseek/src/adapter.ts` |
| basic-compaction | Where is basic context compaction implemented? | `packages/compaction/compaction-basic/src/index.ts` |

## 汇总结果

| scope | variant | answered | Top-1 | Top-3 | median turns | median first-correct read | median bytes before correct read | median request chars | Map truncated |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| full-repository | none | 5/5 | N/A | N/A | 3 | 2 | 1,710 | 21,403 | 0/5 |
| full-repository | map-4000 | 5/5 | 0/5 | 0/5 | 3 | 2 | 5,696 | 43,947 | 5/5 |
| full-repository | map-8000 | 5/5 | 0/5 | 0/5 | 3 | 2 | 5,696 | 56,088 | 5/5 |
| product-source | none | 5/5 | N/A | N/A | 3 | 2 | 1,710 | 21,403 | 0/5 |
| product-source | map-4000 | 5/5 | 0/5 | 1/5 | 3 | 2 | 12,904 | 59,036 | 5/5 |
| product-source | map-8000 | 5/5 | 0/5 | 1/5 | 3 | 2 | 12,904 | 71,093 | 5/5 |

完整范围的 Index 构建约 2,527 ms；4K / 8K Map 渲染中位数分别约 39.7 / 39.2 ms。产品源码范围复用同一次语法解析后，Map 渲染中位数约 25.9 / 26.8 ms。它的候选空间更小，但当前实现仍先构建全仓库 Index；因此该实验不证明产品范围能降低首次索引成本。

## 错误候选证据（4K）

| scope | 问题 | Top-3 候选 | 观察 |
| --- | --- | --- | --- |
| full-repository | cli-bin | `packages/shell/shell/src/index.ts`, `packages/subagent/subagent/src/index.ts`, `packages/shell/pwsh-sandbox/src/index.ts` | `apps/cli` 未进入 Top-3；广泛的 `index.ts` 与入口加分挤占结果。 |
| full-repository | agent-loop | fixture、FS tests、`packages/core/agent/src/runtime-types.ts` | `agent`、`loop` 等通用词命中测试与类型文件。 |
| full-repository | tools | system-prompt / session / tools 的 tests | 没有把实现目录优先于测试目录。 |
| full-repository | deepseek-adapter | `vendor/cosmokit/src/types.ts`、`vendor/cordis/src/context.ts`、settings test | vendor 与通用 symbol 抢占 DeepSeek adapter。 |
| full-repository | basic-compaction | `vendor/cordis/src/context.ts`、两个 compaction tests | `context` 的词面重合高于 package 意图。 |
| product-source | tools | client runtime、`packages/core/tools/src/index.ts`、session | 唯一进入 Top-3 的正确路径，仍不是 Top-1。 |
| product-source | deepseek-adapter | `packages/llm/llm/src/index.ts`、`call-config.ts`、`web-search-deepseek/src/provider.ts` | 去掉 vendor 后仍无法区分 adapter 与相关 provider/config。 |

## 对 mini-Pi 当前阶段的诊断

### Scope 仍然过于粗粒度

完整范围会让 `vendor/`、测试和 fixture 与产品实现同等参与排名。产品源码范围可降低候选空间约 42%，但只是实验过滤，不是产品的 query-aware scope 能力。未来需要根据用户问题选择或偏置 package / app / test / vendor 范围，而不是永久硬排除目录。

### Ranking 只懂词面，不懂模块意图

当前分数由 symbol/export 精确命中、symbol token overlap、路径 token overlap、入口文件与入边数量组成。它不知道：`apps/cli` 是 CLI 的 product entry；`packages/core/agent-loop` 比 `agent` 的 runtime types 更接近“默认 Agent loop”；`llm-deepseek/adapter.ts` 比任意含 DeepSeek 的 provider 或 config 更接近“adapter”。

### 入口启发式在 monorepo 中变成噪声

完整范围有 280 个 `index` / `main` / `server` / `app` / `cli` 入口候选。把它们统一加分适合小项目，却让大量 `index.ts` 在 monorepo 中竞争，压低真正 package 路径的区分度。

### 一跳扩展与 4K / 8K 预算没有改善候选质量

所有 Map 都截断。扩大到 8K 只增加请求字符，并未改变 Top-1 / Top-3。当前瓶颈在候选排序之前，而不是文本预算；继续增大 Map 会先增加上下文成本。

### 当前“效率收益”不具有可迁移性

Issue #9 的 mini-Pi 自身实验显示固定轨迹可减少探索，但这里 Map 的错误 Top-1 导致先读取错误源码，正确读取前字节反而增加。结论应收缩为：Repo Map 基础设施可用，但 Ranking 尚未在大型 monorepo 上验证为有效。

## 下一步建议

不要立刻增加 embedding、向量库或 PageRank。先做一个独立的 Ranking / scope 改进 Issue，并用本报告的五题作为回归集：

1. 把 `scope` 作为显式 Index 查询输入：产品、测试、vendor、docs，而不是静态全局忽略。
2. 增加 package-aware 特征：问题中的 CLI、adapter、loop、registry、compaction 与 workspace package / 目录名共同评分。
3. 降低 tests / fixture / vendor 对非测试问题的默认权重，而用户明确提及时再提升。
4. 把入口加分限定为与 query 路径/符号相关的 entry，而非所有 `index.ts`。
5. 每次改动必须重新跑此双轨数据集，并要求显著提升 Top-3，同时不靠扩大 Map 预算掩盖问题。

复现命令：

```sh
npm run benchmark:deepseek-harness
npm run verify:deepseek-harness
```

这些命令只读取本地 `/Users/jay/deepseek-harness`，不调用 Provider。
