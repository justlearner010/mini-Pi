# Deferred Features

这份文档记录 mini-Pi 当前明确不实现、但后续可能加入的能力，避免设计讨论中的决定丢失。

## LLM 输出

- Token streaming：第一版不逐字输出模型内容。TUI 只展示模型调用、工具执行和最终回答等阶段事件。
- Thinking / reasoning 模式，包括保存并回传 DeepSeek 的 `reasoning_content`。
- OpenAI Responses API；当前统一使用 OpenAI-compatible Chat Completions API。
- 自动重试、模型回退和 Token 用量统计。
- 自定义 Provider `baseURL`。

## Agent 生命周期

- 异步事件订阅、`EventEmitter` 或可迭代事件流。
- `message_start`、`message_update`、`message_end` 等更细粒度消息生命周期事件。
- Agent 事件的持久化、回放和外部观察者机制。
- 使用 `AbortController` 优雅中止正在进行的 LLM 请求或工具调用。

## 测试与质量

- Provider/模型选择、方向键和终端恢复的完整 TUI 自动化测试。
- 大型代码库的性能、内存和基准测试。
- Windows、macOS、Linux 的全平台 CI 验证。
- 网络超时、重试和限流压力测试。
- 多语言依赖分析器加入后的对应回归测试。

## Provider 与认证

- OAuth 或账号登录。
- 根据 Tool Calling 等能力筛选模型列表。
- 模型列表缓存和专门的 `--list-models` 命令。
- Linux 没有 Secret Service 时的加密文件兜底。
- OpenAI、DeepSeek 之外的 Provider。

## 代码分析范围

- 动态 `import()` 分析。
- TypeScript `paths` 路径别名解析。
- TypeScript/JavaScript 以外的语言支持，包括 Python、Rust、Java 等语言的依赖提取器。
- 按文件扩展名分发到不同语言分析器的可插拔分析机制。
- 运行时依赖分析。

## 工具权限

- 写入或修改项目文件。
- 执行 Shell 命令。

## 交互层

- 更复杂的终端组件、快捷键和布局。
- TUI 之外的 Web UI 或其他界面。
- 多行问题编辑、外部编辑器和输入历史持久化。
- 项目级 Provider 或模型覆盖；当前只保存跨项目的全局默认偏好。
- 聊天会话持久化与恢复。
- `--provider`、`--model` 等参数的短名称。
- 文件日志、可切换日志级别和 `/debug` 命令；当前只支持 `MINI_PI_DEBUG=1` 的安全 Provider 诊断。

## 维护规则

- 只有讨论中明确决定延期的功能才加入本文档。
- 功能进入当前版本范围后，应从本文档移除并加入正式设计文档。
