# mini-Pi 安全 Provider 错误诊断设计

## 目标

将当前笼统的 `Model request failed` 转换为可行动的中文诊断：用户知道错误发生在什么阶段、属于什么级别、可能原因与下一步。诊断必须不泄漏 API Key、请求头、聊天/文件内容或完整 Provider 响应。

## 范围与职责

仍只使用五个核心源文件：

- `llm.ts`：把 OpenAI-compatible SDK 的原始异常转换为安全的结构化 Provider 诊断。
- `agent.ts`：保留模型阶段错误的结构化诊断并通过 AgentEvent 上传；不自行猜测 Provider 原因。
- `tui.ts`：默认以中文显示原因与建议；调试模式追加有限的技术证据。
- `cli.ts`：从 `MINI_PI_DEBUG=1` 读取调试开关并传入 TUI/格式化层。
- `tool.ts`：不修改。

## 诊断模型

模型请求错误包含：

```ts
{
  level: "warning" | "error",
  kind: "authentication" | "permission" | "model" | "rate_limit" | "provider" | "network" | "unknown",
  stage: "model",
  provider: "openai" | "deepseek",
  message: string,
  advice: string,
  status?: number,
  code?: string,
}
```

默认映射如下：

| 条件 | kind / level | 用户建议 |
| --- | --- | --- |
| 401 | authentication / error | 运行 `/login` 重新保存对应 Provider 的 API Key。 |
| 403 | permission / error | 确认 Key 的权限、账号状态和 Provider 是否正确。 |
| 404 | model / warning | 运行 `/model` 重新选择可用模型。 |
| 429 | rate_limit / warning | 稍后重试，或切换模型 / Provider。 |
| 5xx | provider / warning | Provider 暂时不可用，稍后重试。 |
| 网络/超时/连接错误 | network / warning | 检查网络、代理和 Provider API 地址后重试。 |
| 其他 | unknown / warning | 查看调试信息或稍后重试。 |

本地凭据库错误仍作为 Agent/CLI 本地错误显示为 `error`，并建议检查系统凭据服务或临时设置相应环境变量。

## 展示与调试边界

默认显示：

```text
错误 [认证失败]
位置：DeepSeek，第 1 次模型请求
原因：API Key 无效、过期，或不属于 DeepSeek。
建议：运行 /login 重新保存 DeepSeek 的 API Key。
```

运行 `MINI_PI_DEBUG=1 mini-pi .` 时，默认诊断后可追加：

```text
调试：HTTP 401 · code=invalid_api_key
```

原始 Provider 错误码和 request ID 也不可信：仅允许固定白名单的通用错误码，完全不显示 request ID。无论模式都禁止打印：API Key（含片段）、Authorization/其他请求头、请求或响应完整正文、聊天内容、文件内容、工具结果、堆栈。

`MINI_PI_DEBUG` 仅在值严格等于 `1` 时开启。第一版不增加 `/debug`、文件日志、自动重试、自动模型回退或上报错误。

## 错误流

```text
Provider SDK error
  → llm.ts：安全分类为 ProviderDiagnostic
  → agent.ts：model-stage AgentEvent
  → tui.ts：中文原因与建议
  → debug 开关：仅追加 status / 白名单 code
```

既有工具错误和最大回合错误维持原行为；只有模型/Provider 失败走新诊断路径。

## 测试

自动化测试使用人工构造的 SDK 错误，不发出真实请求。覆盖：

- 401、403、404、429、5xx、网络、未知错误的 kind、级别、中文原因与建议；
- 默认展示不包含 Key、请求头、请求/响应正文；
- `MINI_PI_DEBUG=1` 只显示 status 和白名单 code；不显示 request ID；
- AgentEvent 保留阶段与诊断，TUI 正确格式化；
- 旧工具错误、最大回合错误与成功调用不回归。

## 延期

文件日志、可切换日志级别、`/debug`、自动重试、自动模型回退和错误上报均移入待选功能。
