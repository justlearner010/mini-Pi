# mini-Pi 安全登录与顺滑启动设计

## 目标

在不增加第六个核心源文件、也不持久化聊天记录的前提下，让 mini-Pi 从“每次启动都传 Key、选择 Provider 和模型”变成：首次通过登录向导安全配置，之后运行 `mini-pi .` 直接进入聊天。

## 范围

本次只修改 `cli.ts` 与 `tui.ts` 的职责，并在现有依赖中加入维护中的跨平台原生凭据库 `@github/keytar`。

- `cli.ts`：读取/保存全局偏好，读取/保存/删除安全凭据，编排登录和模型选择。
- `tui.ts`：识别并分发新增命令，负责隐藏输入和上下键选择的显示。
- `llm.ts`、`agent.ts`、`tool.ts`：不感知凭据保存方式，不改变职责。

不新增 `credential.ts`，以保留五文件学习框架。

## 状态与安全边界

### API Key

`@github/keytar` 用同一套异步 API 映射到操作系统的凭据库：macOS Keychain、Windows Credential Vault、Linux Secret Service。使用固定服务名 `mini-Pi`，Provider 名（`openai` 或 `deepseek`）作为 account。

Key 绝不写入 Git、`.env`、命令行参数、日志或 `config.json`。环境变量仍是临时覆盖来源，优先级为：

1. `OPENAI_API_KEY` / `DEEPSEEK_API_KEY`；
2. 系统凭据库；
3. 无 Key 时进入登录向导。

环境变量只用于本次运行，不会写入或替换系统凭据。

### 全局偏好

在 `~/.mini-pi/config.json` 保存：

```json
{ "provider": "deepseek", "model": "deepseek-chat" }
```

这是跨项目的默认偏好，不保存项目路径、聊天历史或 API Key。后续的项目级模型设置和会话恢复不在本次范围。

## 用户流程

### 启动

`mini-pi [project]` 首先尝试读取全局默认 Provider/模型及对应 Key。两者均可用时直接进入 TUI。

没有默认配置、默认凭据不存在或默认凭据无法读取时，自动显示首次登录向导：选择 Provider、隐藏输入 API Key、通过 `listModels` 获取模型列表并选择模型。仅当模型列表读取成功后，才保存 Key 和默认偏好；用户取消、网络错误或模型列表失败都不得覆盖旧状态。

如果系统凭据库不可用但环境变量存在，仍可运行；若两者都没有，则显示可理解的凭据库错误或登录提示并以失败状态退出。

### TUI 命令

- `/login`：选择 Provider，隐藏输入新 Key，成功列出模型后安全保存 Key 和全局默认 Provider/模型。
- `/model`：读取当前 Provider 的有效 Key，列出模型并上下键选择；成功后更新全局默认模型。
- `/logout`：上下键选择已登录的 Provider，删除其安全凭据；若删除的是默认 Provider，则删除全局偏好。
- 保留 `/help`、`/reset`、`/exit`。

第一版不实现 `/provider`、`/status`、项目级设置、持久会话或 OAuth。切换 Provider 通过 `/login` 完成。

## 错误与取消

- `Ctrl+C`/Esc 取消选择或输入：退出该流程，不修改旧 Key 或偏好。
- `/login` 的模型列表失败：Key 不保存；清晰提示失败原因。
- `/model` 无 Key：提示先执行 `/login`。
- `/logout` 没有可删凭据：提示没有已登录的 Provider。
- Linux 缺少 Secret Service/libsecret：说明系统凭据库不可用；允许环境变量临时运行。

## 测试

测试通过注入假的凭据库和假的交互函数，不读取真实凭据。覆盖：

- 环境变量优先于系统凭据库；
- 首次启动进入登录向导并保存 Key/全局默认；
- 已配置启动直接进入 TUI；
- `/login`、`/model`、`/logout` 的成功路径；
- 取消、模型列表失败和凭据库失败时保持原状态；
- 删除默认 Provider 后清除全局偏好；
- 无凭据库时环境变量仍可运行。

验证时额外进行一次 macOS 真正的凭据读写/删除冒烟测试，使用专用测试 account 并保证清理，不使用真实 API Key。

## 后续功能

本次明确延期：项目级 Provider/模型覆盖、会话持久化、OAuth、Linux 无 Secret Service 时的加密文件兜底、更多 Provider、流式输出与运行中中止。
