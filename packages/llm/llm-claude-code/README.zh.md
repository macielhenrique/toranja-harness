---
description: "把本地 Claude Code 登录用作 Toranja Harness 对话模型，流式返回文本、推理与用量，把其工具调用交给 harness，并映射登录与额度失败。"
kind: "package-reference"
---

# @deepseek-ai/dsh-llm-claude-code

[English](README.md) | 中文

## 概述

当 Toranja Harness 组合需要通过本地 Claude Code CLI 已登录的 Claude 订阅回答对话轮次时，挂载本插件。它注册 `claude-code-local` 路由，提供 `opus`、`sonnet`、`haiku` 别名及其推理等级。每个对话在其各轮之间保持一个隔离的 Claude Code 查询打开，不带原生工具、宿主设置或用户的 MCP 服务器，并流式返回文本和推理。对话的 harness 工具通过一个进程内 MCP 服务器到达 Claude：Claude 发出的每个调用都会作为 harness 的 `tool-call` 块返回，由 harness 执行，其结果在同一个查询中继续。对话之外的调用打开一个不带工具的查询，并在结果之后关闭。插件不读取也不复制 API 密钥。目前没有 bundle 挂载本插件。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## 使用本包

在 `cordis.patch.yml` 中把插件插入到 LLM 与 subprocess 服务之后：

```yaml
- insert:
    - id: llm-claude-code
      name: '@deepseek-ai/dsh-llm-claude-code'
```

本插件没有配置项。先运行一次 `claude auth login` 登录；之后路由会列出 `opus`、`sonnet`、`haiku`，每个模型都提供 Claude Code subagent 接受的 `low`、`medium`、`high`、`xhigh`、`max` 推理等级。省略等级时沿用 CLI 默认值。

### 失败与恢复

每种失败都以一个类型为 `error` 的 `finish` 块结束流，并带有固定的葡萄牙语消息，绝不复述 CLI 输出或 stderr。

| 情况 | 代码 |
|---|---|
| 编排器报告 `claude-code` 为 `signed-out` 或 `not-installed`，CLI 报告 `authentication_failed`，或 `auth_status` 消息带有错误 | `AUTH` |
| 订阅额度被拒绝（`rate_limit_event` 且 `status: "rejected"`）或 `billing_error` | `QUOTA` |
| 单次请求的 `rate_limit` 错误 | `RATE_LIMIT` |
| 结果文本指出上下文窗口溢出 | `CONTEXT_WINDOW_EXCEEDED` |
| 成功结果没有任何内容 | `EMPTY_RESPONSE` |
| `error_*` 结果子类型、其他 API 错误，或 CLI 进程在结果之前结束 | `CLAUDE_CODE_ERROR` |

登录检查只在挂载了 `ctx.toranjaOrchestrator` 时运行；状态未知或没有编排器时查询照常启动，此时由 CLI 自身的身份验证错误生效。中止的 `signal` 会中断该轮，并以类型为 `aborted` 的 `finish` 结束；对话查询保持打开供下一轮使用，其他查询则关闭。失败的轮次会关闭其对话查询，因此下一轮会带着对话记录启动新查询。

当查询关闭、CLI 进程退出或插件释放时，仍在等待 harness 的工具调用会以错误结果返回给 Claude。桥接无法转换的工具会记录一条警告并被排除；其余工具仍然提供。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节——点击展开</summary>

### 源码地图

| 文件 | 作用 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口、模型目录、提示词投影、查询选项、工具步骤、流与失败映射 |
| [`src/bridge.ts`](src/bridge.ts) | `toranja` MCP 服务器：为 SDK 转换的 harness 工具 schema，以及等待 harness 的调用 |

### 查询生命周期

`stream()` 以流式输入调用官方 Agent SDK 的 `query()`：一个用户消息队列，在查询存活期间一直保持打开，因为 `interrupt()` 需要它。带有 `sessionId` 且没有 `purpose` 的请求属于一个以该 id 为键的对话；压缩、Session 标题以及没有 Session 的请求使用一次性查询，在结果之后关闭。

对话查询以一组配置（工作目录、模型、推理等级、系统提示与工具定义的哈希）打开，并记住 CLI 已持有的对话条目。当配置不变、且请求历史等于这些条目后面只追加了新的用户消息时，下一轮复用它：把新的用户文本作为一条消息推入，并读取同一个查询直到该轮的 `result`。其他任何历史（例如被压缩、编辑或来自其他提供方的历史）或配置变化，都会关闭查询并带着对话记录打开新查询。同一对话的各轮依次执行：并发请求会等待正在运行的轮次结束。中止的轮次会被中断，并在读到被中断的 `result` 之后查询才重新空闲；失败的轮次、退出的 CLI 进程、空闲十分钟或插件释放都会关闭它。

查询选项是固定的：`tools: []`、`mcpServers: {}`、`strictMcpConfig: true`、`settingSources: []`、`persistSession: false`、`includePartialMessages: true`、一个拒绝所有请求的 `canUseTool` 回调，以及请求的 `model` 和 `effort`。带工具的对话请求替换其中三项：`mcpServers` 只包含 `toranja` 桥接服务器，`allowedTools` 为桥接提供的每个工具列出 `mcp__toranja__<name>`，`canUseTool` 只允许这些名称并拒绝其他所有名称；原生工具保持关闭。挂载了 `ctx.sessions` 与 `ctx.workingDirectory` 时，工作目录是发起请求的 Session 的工作目录，否则是 Host 进程目录。

CLI 进程通过 [`@deepseek-ai/dsh-subagent-claude-code`](../../subagent/subagent-claude-code/README.zh.md) 的 `claudeSpawnSpec` 与 `ManagedClaudeCodeProcess` 启动，因此由 `ctx.subprocess` 管理其进程范围。其环境是去掉所有以 `CLAUDE`、`ANTHROPIC` 或 `MCP_` 开头的变量之后的 `scrubbedParentEnv()`；CLI 通过用户配置目录找到登录信息，所以 `ANTHROPIC_API_KEY`、`ANTHROPIC_BASE_URL` 和自定义的 `CLAUDE_CONFIG_DIR` 都不会到达它。关闭查询时调用 `disposeClaudeCodeChild`，它关闭查询并等待进程退出；插件释放时关闭所有仍然打开的查询。

取消时调用 `interrupt()`，最多等待 subagent 的释放宽限时间，因为只中止 SDK 控制器会让 CLI 再开始一次付费回复。之后一次性查询关闭；对话查询只有在同一宽限时间内没有收到被中断的 `result` 时才关闭。

### 工具步骤

由桥接提供的 `mcp__toranja__<name>` 工具的 `tool_use` 块会变为 harness 的 `tool-call` 块，带有 `tool_use` id、harness 名称 `<name>` 以及流式传来的 JSON 参数；其他任何 `tool_use` 都留给 CLI 自行回答。在至少含有一个此类块的消息中，`stop_reason` 为 `tool_use` 的 `message_delta` 结束该步骤：`stream()` 输出该消息的用量，然后输出类型为 `tool-calls` 的 `finish` 并返回，不等待任何处理函数，因为 CLI 可能在消息结束前就调用第一个处理函数。查询保持打开并标记为等待工具，对话锁被释放。

当配置不变、且历史等于记住的条目（包含带这些调用的助手消息）后面只跟着 `tool` 消息时，对话的下一个请求延续同一个查询。`toolCallId` 与等待中的调用匹配的每个结果，都以结果文本和 `isError` 完成其处理函数；其他 id 的结果会被记录并忽略，没有结果的等待调用以错误完成。随后在同一个查询上继续读取，直到下一个工具步骤或最终的 `result`。没有 `readOnlyHint` 时，CLI 一次只调用一个步骤中的一个处理函数，因此在其处理函数之前到达的结果按 id 保存，并在处理函数被调用时交付；第一个调用从不等待整批其余调用。

其他任何历史（例如在被取消的步骤之后，结果后面跟着一条用户消息）都会关闭查询（等待中的调用因此失败），并带着对话记录重新打开。桥接超时为 30 分钟（`TOOL_CALL_TIMEOUT_MS`），足够完成人工审批；等待工具的查询在同样时间后关闭。超过时限的调用会从 CLI 得到错误，因此其迟到的结果不会到达该查询，只会通过重新打开的查询的对话记录到达。

最终的 `result.usage` 统计整个 CLI 轮次，因此会从中减去已经报告过的步骤用量。

</details>

-----

<a id="model-experience"></a>
## 模型体验

### 请求投影

#### 模型看到什么

Claude Code 收到的是一个自定义系统提示，由 `GenerateOptions.system` 和每条 system 与 developer 消息的文本以空行连接而成，而不是 `claude_code` 预设。只有一条用户消息的请求直接把该文本作为提示发送。更长的请求发送一份由 `USUÁRIO:`、`ASSISTENTE:` 与 `FERRAMENTA:` 条目组成的对话记录；工具调用变为 `[chamada de ferramenta <name> (<id>): <arguments>]`，工具结果以 `[resultado da chamada <id>]` 开头（错误结果为 `, com erro`），后跟其文本；图片和文件变为方括号占位符，推理块被省略。

带工具的对话请求把工具定义作为 `toranja` MCP 服务器发送，因此模型把每个工具看作 `mcp__toranja__<name>`，带有其描述和 JSON Schema 参数；CLI 一开始就加载全部工具。工具结果作为其调用的 MCP 结果到达模型：即其文本，在 100,000 个字符处截断，并附上省略了多少字符的说明。

#### Token 影响

延续存活对话查询的轮次只发送新的用户文本，工具步骤只发送其结果；CLI 保留之前的各轮。提供工具的对话中，工具定义会计入每个请求。打开查询时（第一轮或重新打开之后）发送完整的投影历史。CLI 会在自定义系统提示之外加入它自己的固定请求框架。

#### KV Cache 影响

在历史不变时投影是确定的，因此提供方的提示缓存可以复用稳定前缀。第一轮之后切换为多消息对话记录，会从第一个用户条目起改写提示。

### 响应映射

#### 模型看到什么

流式的 `text` 与 `thinking` 块变为 harness 的文本块与推理块；没有可见文本的 thinking 块不会输出。由桥接提供的工具的 `tool_use` 块会变为去掉 `mcp__toranja__` 前缀命名的 `tool-call` 块。若流中没有任何块，结果文本会成为一个文本块。

#### Token 影响

用量来自每轮的 `result.usage`：`input_tokens`、`output_tokens`、`cache_read_input_tokens` 与 `cache_creation_input_tokens` 分别映射到互不重叠的 harness 计数。工具步骤报告其消息的用量（来自 `message_start` 与 `message_delta`），最终的 `result.usage` 在减去这些步骤后报告。

#### KV Cache 影响

记录下来的响应内容追加到下一个请求中，之前的投影前缀保持不变。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **没有原生工具**——Claude 只获得对话的 harness 工具；压缩、Session 标题以及没有 Session 的调用不获得任何工具。
- **工具结果是文本**——工具结果中的图片或文件以方括号占位符到达 Claude。
- **一个步骤的调用依次执行**——桥接不设置 `readOnlyHint`，因此 CLI 只在上一个处理函数返回后才调用下一个。
- **会话只复用简单延续**——历史若不是记住的条目后面追加新用户消息或等待中工具调用的结果，就会带着完整对话记录重新打开查询，而不是加以协调。
- **尚未被任何 bundle 挂载**——Toranja Harness bundle 与模型选择器的注册留待以后。
- **登录预检读取的是宿主 `claude` 可执行文件**——编排器探测宿主 CLI，而 SDK 启动的是它自己的平台锁定运行时，因此 `not-installed` 可能拒绝一个本可启动的运行时。
- **不支持自定义 `CLAUDE_CONFIG_DIR`**——环境过滤会移除它，存放在默认配置目录之外的登录信息不会被找到。
