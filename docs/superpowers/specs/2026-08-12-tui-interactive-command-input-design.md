# mini-Pi TUI 交互命令输入修复设计

关联 Issue：[ #1](https://github.com/justlearner010/mini-Pi/issues/1)

## 问题

TUI 使用一个长期存在的 Node `readline` 接收 `>` 提问，同时 `/login`、`/model`、`/logout` 使用 Inquirer 临时接管同一 `stdin`。Inquirer 结束后旧 `readline.question()` 可能收到 EOF/关闭状态；当前实现把它当作正常退出，导致已成功切换模型后程序返回 shell。

## 目标

任何交互命令完成、失败或被取消后，TUI 都恢复可用的 `>` 输入提示。`/model` 成功后保留已更新的 Provider、模型和对话历史，不退出进程。

## 设计

只修改 `tui.ts`：

1. 在每轮等待输入前创建 `readline`；获取一行输入后立即关闭它。
2. 之后才执行命令分发；因此 Inquirer 是交互命令期间唯一持有 stdin 的组件。
3. `/login`、`/model`、`/logout` 的成功、失败和取消都回到下一轮，重新显示 `>`。
4. EOF 仍以状态 0 退出，Ctrl+C/SIGINT 仍以状态 130 退出；两者只发生在真正等待用户普通输入时。

不改变 Agent、LLM、凭据、模型选择、错误诊断和 TUI 命令的职责，也不增加核心文件。

## 测试

通过注入可控的行输入和动作函数测试 TUI 循环：

- `/model` 返回新 session 后，下一个输入仍被读取并可执行 `/exit`；
- `/login` 和 `/logout` 也会继续下一轮；
- 动作抛错或取消后循环仍继续；
- EOF 和 SIGINT 的退出码保持原有语义。

验证：`npm test`、`npm run check`、`npm run build`、`npm run verify:bin`、`npm run verify:package`，且五个 `src/*.ts` 总行数不超过 1000。
