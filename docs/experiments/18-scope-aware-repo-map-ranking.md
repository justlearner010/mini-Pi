# Issue #18：Scope-aware Repo Map Ranking

## 结论

Issue #18 在预注册的 `deepseek-harness` 五题导航集上通过了本 Issue
的候选质量门槛：产品源码范围的 4K Repo Map 为 Top-1 `3/5`、Top-3 `5/5`
（门槛分别为 `>= 3/5`、`>= 4/5`）。4K 与 8K 的候选顺序相同，因此更大的
8K Map 没有带来导航收益，只增加了模型请求字符数。

这证明的是本地、确定性候选定位改进：scope、workspace package、角色词表
和角色文件形式可减少错误的首个读取。它**不**证明真实 Provider 的 token、
价格、端到端延迟或最终回答正确率；实验不调用 Provider，最终源码结论仍需
Agent 使用 `read_file` 验证。

## 方法与原则

- 目标仓库：本地只读 `/Users/jay/deepseek-harness`，commit
  `47f943859bef60e4160492346772ded9b24f765a`；没有修改它，也没有运行它。
- 双轨范围：完整仓库（2,586 个支持文件、24,332,267 bytes）与产品源码
  （1,503 个支持文件、10,880,691 bytes）。二者均记录 3 个嵌套
  `.gitignore` 的未支持范围，未触发文件数/字节硬上限。
- 每个范围都比较 `none`、`map-4000`、`map-8000`，题目和正确路径在运行前
  固定；fake LLM 对三种 variant 使用可重复轨迹。
- Map variant 先读取 Top-1；若错误再读取预注册正确路径。因此“正确读取前的
  源码字节数”真实反映这条固定轨迹的误排成本。
- runner 连续执行两次，并忽略仅计时字段后深比较。所有 Index、Map、Agent 和
  只读 Tool 来自生产实现；无 API Key、Provider 请求或目标仓库写入。

## 预注册问题与结果（产品源码 / 4K）

| ID | 正确路径 | Top-1 | Top-3 | 置信度 | 观察 |
| --- | --- | ---: | ---: | --- | --- |
| cli-bin | `apps/cli/src/bin.ts` | ✓ | ✓ | high | CLI + `bin.ts` 文件形式定位启动入口。 |
| agent-loop | `packages/core/agent-loop/src/agent.ts` | ✗ | ✓ | high | 同 package 的 `index.ts` 仍排第一。 |
| tools | `packages/core/tools/src/index.ts` | ✗ | ✓ | ambiguous | `agent-tool-presentation` 与 tools package 仍存在词面歧义。 |
| deepseek-adapter | `packages/llm/llm-deepseek/src/adapter.ts` | ✓ | ✓ | high | adapter 文件形式与 package token 共同生效。 |
| basic-compaction | `packages/compaction/compaction-basic/src/index.ts` | ✓ | ✓ | high | compaction 角色允许匹配 package 的 `index.ts`。 |

## 汇总测量

每格为五个问题的中位数；Top-1 / Top-3 为命中题数。`before correct`
是首个正确读取之前返回的源码字节；`request chars` 是 fake LLM 接收的
`messages + tools` 序列化字符数，不等同真实 token。

| scope | variant | Top-1 | Top-3 | turns | tool calls | before correct | request chars | map render ms | map truncated |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| full-repository | none | N/A | N/A | 3 | 2 | 1,710 | 21,403 | 0 | 0/5 |
| full-repository | map-4000 | 3/5 | 5/5 | 2 | 1 | 0 | 25,253 | 82.5 | 5/5 |
| full-repository | map-8000 | 3/5 | 5/5 | 2 | 1 | 0 | 33,303 | 72.8 | 5/5 |
| product-source | none | N/A | N/A | 3 | 2 | 1,710 | 21,403 | 0 | 0/5 |
| product-source | map-4000 | 3/5 | 5/5 | 2 | 1 | 0 | 25,253 | 46.8 | 5/5 |
| product-source | map-8000 | 3/5 | 5/5 | 2 | 1 | 0 | 33,303 | 45.3 | 5/5 |

首次完整 Index 构建在本次机器上约为 3,501.8 ms。产品范围在实验中复用已
建立的完整语法 Index，所以本实验不能宣称它降低了首次解析成本；它只显示
其 query/render 阶段更小。

## 与 Issue #16 基线的对比

Issue #16 的产品范围 Map Top-1 为 `0/5`、Top-3 为 `1/5`，且错误 Top-1
会带来额外读取。#18 没有扩大 4K 预算，而是将排序从“泛化 symbol 的绝对优先”
调整为：产品 scope → 角色 → package → 角色文件形式 → exact symbol。
结果是 4K 的 Top-1 提升到 `3/5`、Top-3 提升到 `5/5`，固定轨迹中的工具调用
中位数从 2 降到 1、turns 从 3 降到 2、正确读取前字节从 1,710 降到 0。

## 失败、方差与 trade-offs

- `agent-loop`：`index.ts` 与 `agent.ts` 同属匹配 package；当前没有函数体或
  export-to-body 语义，不能可靠判定哪一个才是 loop 的核心实现。
- `tools`：两个产品 package 都有 tool/registry 词面证据，因此正确标为
  `ambiguous`。这正是 Agent 应调用 `query_repo_map` 细化或读取候选验证的场景，
  而不是把 Top-1 视为事实。
- Map 在所有 map runs 都截断；8K 没有改变 Top-1/Top-3，只将请求字符中位数
  增加 8,050。默认 4K 因而仍是成本更低的选择。
- 本地 `mapRenderMs` 受文件缓存和机器负载影响，不能做精确性能承诺；verifier
  将计时字段排除在可重复性断言之外。路径、候选、理由、置信度和计数才是本次
  的确定性证据。
- 角色词表是小型、透明且项目无关的启发式；未识别的同义词、非标准目录布局、
  动态模块关系和 call graph 仍是本版本的限制。

## 建议

**通过 Issue #18 的预注册候选质量门槛。** 保持 4K 自动 Map 与 8K 手动
refinement，不因本次成功提高默认上下文预算。下一步应由 Issue #10 定义证据
护栏和工具编排：当 confidence 是 `ambiguous` 或已读候选冲突时，决定何时细化
Repo Map、读取源码或验证静态依赖；不要仅因排名成功而跳过源码验证。

## 复现

```sh
npm run benchmark:deepseek-harness
npm run verify:deepseek-harness
```

命令只读取本地目标仓库，不调用 Provider。
