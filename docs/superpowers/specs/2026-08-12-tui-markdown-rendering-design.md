# mini-Pi TUI Markdown 渲染设计

关联 Issue：[ #2](https://github.com/justlearner010/mini-Pi/issues/2)

## 目标

将 Agent 的最终 Markdown 回答渲染为可读的终端样式，而非原样显示 `#`、`**` 和反引号。支持标题、强调、列表、行内代码、代码块、链接和表格。

## 范围

本次仅渲染最终 Agent 回答。`Thinking…`、工具调用/结果、错误诊断、TUI 命令与用户输入继续按纯文本显示。

使用纯 ESM/TypeScript 的 `markdansi` 作为 Markdown→ANSI 渲染器；它无原生依赖，适配项目的 Node 22 约束。渲染逻辑放在现有 `tui.ts`，不新增核心文件。

## 安全链路

```text
模型最终回答
  → 删除输入中的 ANSI CSI、OSC 与其他 C0/C1 控制序列
  → markdansi 将 Markdown 转为终端 ANSI 样式
  → TUI 输出
```

模型文本中的控制序列必须先删除，不能执行终端标题修改、光标移动、清屏、超链接或伪造提示符。渲染器产生的样式 ANSI 是唯一允许输出的控制序列。

## 降级

若渲染器同步抛错，TUI 输出：

```text
Markdown rendering failed; showing safe plain text.
```

然后显示已清理控制字符的原 Markdown。任何回答都不因渲染失败而丢失。空回答保持现有空输出行为。

## 接口与显示

`tui.ts` 导出可测试的 `renderMarkdown(text)`：返回安全终端字符串。`startTui` 在 `agent.run()` 成功后用它替代当前对 `result.answer` 的直接输出。

普通纯文本保持可读，Markdown 代码块保留原始代码字符与换行；不执行模型提供的终端控制字符。渲染内容与 TUI 命令处理彼此独立。

## 测试

- 覆盖标题、粗体、斜体、列表、行内代码、围栏代码块、链接和表格，断言 Markdown 标记不再原样作为格式标记出现，文本内容仍保留；
- 覆盖纯文本；
- 覆盖 CSI、OSC、C0/C1 控制序列都不进入输出；
- 通过可注入渲染函数模拟渲染失败，验证安全纯文本回退和警告；
- 覆盖 `startTui` 最终回答走渲染路径，工具/错误信息不走渲染路径；
- 保留已有 TUI 输入、Provider 错误诊断和 Agent 回归测试。

## 非目标

本次不做流式 Markdown 渲染、代码语法高亮配置、图片、Mermaid、HTML 执行、Markdown 链接点击，或已打印工具过程的真正折叠/展开。这些是后续 Pi-style 可重绘 TUI 的设计范围。
