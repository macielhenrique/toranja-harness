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
| `error_*` 结果子类型、其他 API 错误、CLI 进程在结果之前结束，或 `init` 消息列出桥接之外的工具或 MCP 服务器 | `CLAUDE_CODE_ERROR` |

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

对话查询以一组配置（工作目录、模型、推理等级、系统提示与工具定义的哈希）打开，并记住 CLI 已持有的对话条目。当配置不变、且请求历史等于这些条目后面只追加了新的用户消息时，下一轮复用它：把新的用户文本作为一条消息推入，并读取同一个查询直到该轮的 `result`。去掉开头空白后CLI 收到的每段用户文本，无论以什么开头，都会以 `USUÁRIO:`、换行和该文本的形式发送，因为 CLI 会把以 `/` 开头的文本当作自己的斜杠命令执行，而开头的不可见字符会让检测看不到斜杠。以 `USUÁRIO:`、`ASSISTENTE:`、`FERRAMENTA:`、`[resultado da chamada` 或 `[contexto adicional do Toranja Harness]` 开头的内容行会加上 `> ` 前缀，使消息文本和工具结果无法伪造对话记录中的轮次、结果标题或 harness 上下文。比较时把每条消息投影为其角色和文本，并略去 harness 可能丢弃的空文本块。其他任何历史或配置变化，都会关闭查询，并带着请求历史的对话记录打开新查询：

- 新消息中出现压缩摘要（来源类型为 `compact-checkpoint` 的用户消息），或摘要替换了记住的条目时，总是重新打开，因此新查询持有压缩后的历史，而不是 harness 已丢弃的内容；
- 离开该路由又回来的历史，在记住的条目之后带有其他提供方的助手消息，因此重新打开的对话记录包含这些消息；
- Host 重启后没有存活的查询，因此对话的第一轮带着完整历史打开；
- 编辑或删除了之前的消息，或者记录的回复与 CLI 产生的不同，也会重新打开。同一对话的各轮依次执行：并发请求会等待正在运行的轮次结束。中止的轮次会被中断，并在读到被中断的 `result` 之后查询才重新空闲；失败的轮次、退出的 CLI 进程、空闲十分钟或插件释放都会关闭它。

查询选项是固定的：`tools: []`、`mcpServers: {}`、`strictMcpConfig: true`、`settingSources: []`、`persistSession: false`、`includePartialMessages: true`、一个拒绝所有请求的 `canUseTool` 回调，以及请求的 `model` 和 `effort`。带工具的对话请求替换其中三项：`mcpServers` 只包含 `toranja` 桥接服务器，`allowedTools` 为桥接提供的每个工具列出 `mcp__toranja__<name>`，`canUseTool` 只允许这些名称并拒绝其他所有名称；原生工具保持关闭。当 CLI 的 `init` 消息列出 `mcp__toranja__*` 之外的工具、在请求没有 harness 工具时列出任何工具，或列出 `toranja` 之外的 MCP 服务器时，该轮以 `CLAUDE_CODE_ERROR` 结束并关闭查询。挂载了 `ctx.sessions` 与 `ctx.workingDirectory` 时，工作目录是发起请求的 Session 的工作目录，否则是 Host 进程目录。

CLI 进程通过 [`@deepseek-ai/dsh-subagent-claude-code`](../../subagent/subagent-claude-code/README.zh.md) 的 `claudeSpawnSpec` 与 `ManagedClaudeCodeProcess` 启动，因此由 `ctx.subprocess` 管理其进程范围。其环境是去掉所有以 `CLAUDE`、`ANTHROPIC` 或 `MCP_` 开头的变量之后的 `scrubbedParentEnv()`；CLI 通过用户配置目录找到登录信息，所以 `ANTHROPIC_API_KEY`、`ANTHROPIC_BASE_URL` 和自定义的 `CLAUDE_CONFIG_DIR` 都不会到达它。关闭查询时调用 `disposeClaudeCodeChild`，它关闭查询并等待进程退出；插件释放时关闭所有仍然打开的查询，并且只在它们的每个 CLI 进程都退出之后才完成。

取消时调用 `interrupt()`，最多等待 subagent 的释放宽限时间，因为只中止 SDK 控制器会让 CLI 再开始一次付费回复。之后一次性查询关闭；对话查询只有在同一宽限时间内没有收到被中断的 `result` 时才关闭。

### 工具步骤

由桥接提供的 `mcp__toranja__<name>` 工具的 `tool_use` 块会变为 harness 的 `tool-call` 块，带有 `tool_use` id、harness 名称 `<name>` 以及流式传来的 JSON 参数；其他任何 `tool_use` 都留给 CLI 自行回答。在至少含有一个此类块的消息中，`stop_reason` 为 `tool_use` 的 `message_delta` 结束该步骤：`stream()` 输出该消息的用量，然后输出类型为 `tool-calls` 的 `finish` 并返回，不等待任何处理函数，因为 CLI 可能在消息结束前就调用第一个处理函数。查询保持打开并标记为等待工具，对话锁被释放。

当配置不变、且历史等于记住的条目（包含带这些调用的助手消息）后面跟着 `tool` 消息、且其后只有 harness 自己产生的用户消息（来源类型既不是 `user` 也不是 `compact-checkpoint`，例如工具附加在结果上的 `additionalContexts`）时，对话的下一个请求延续同一个查询。这些文本追加在最后一个等待中调用的结果之后、`[contexto adicional do Toranja Harness]` 之下到达模型。`toolCallId` 与等待中的调用匹配的每个结果，都以结果文本和 `isError` 完成其处理函数；其他 id 的结果会被记录并忽略，没有结果的等待调用以错误完成。随后在同一个查询上继续读取，直到下一个工具步骤或最终的 `result`。没有 `readOnlyHint` 时，CLI 一次只调用一个步骤中的一个处理函数，因此在其处理函数之前到达的结果按 id 保存，并在处理函数被调用时交付；第一个调用从不等待整批其余调用。

其他任何历史（例如在被取消的步骤之后或作为插话，结果后面跟着一条来自人的消息，即来源类型为 `user` 或没有来源）都会关闭查询（等待中的调用因此失败），并带着对话记录重新打开。桥接超时为 30 分钟（`TOOL_CALL_TIMEOUT_MS`），足够完成人工审批；等待工具的查询在同样时间后关闭。超过时限的调用会从 CLI 得到错误，因此其迟到的结果不会到达该查询，只会通过重新打开的查询的对话记录到达。

最终的 `result.usage` 统计整个 CLI 轮次，因此会从中减去已经报告过的步骤用量。

### 真实 CLI 测试

`tests/real-claude.e2e.ts` 在 `vitest.e2e.config.ts` 下，以 `haiku` 针对 SDK 自带的 CLI 和本地登录运行该路由；除非该 CLI 的 `auth status` 报告 `loggedIn: true`，否则跳过。它检查：`init` 消息只列出 `mcp__toranja__*` 工具和 `toranja` 服务器，且 `apiKeySource: "none"`；文本轮次流式输出多个增量，并以 `usage` 和 `stop` 结束；含一个或两个工具调用的步骤在 CLI 发出 `stop_reason: "tool_use"` 的 `message_delta` 之后以 `tool-calls` 结束，且结果到达最终回复；后续轮次、被中止的轮次及其后的轮次都在同一个查询和同一个进程上运行；伪造的 `ANTHROPIC_*`、`CLAUDE_*` 和 `MCP_*` 变量从不到达子进程，而登录仍然有效；以 `/` 开头的文本到达模型；释放之后没有 CLI 进程残留。它还断言 `.claude/commands` 中的纯文本项目命令不在 `init.slash_commands` 中，且被询问技能、代理和命令时，模型不会说出 `init` 所列的任何一个（按整词、不区分大小写比较，排除 Toranja 工具名、名称 `claude`，以及同时是内置命令名的普通词，如 `help` 和 `init`）。一次运行大约消耗 0.03 美元的订阅用量。

</details>

-----

<a id="model-experience"></a>
## 模型体验

### 请求投影

#### 模型看到什么

Claude Code 收到的是一个自定义系统提示，由 `GenerateOptions.system` 和每条 system 与 developer 消息的文本以空行连接而成，而不是 `claude_code` 预设。只有一条用户消息的请求直接把该文本作为提示发送。更长的请求发送一份由 `USUÁRIO:`、`ASSISTENTE:` 与 `FERRAMENTA:` 条目组成的对话记录；工具调用变为 `[chamada de ferramenta <name> (<id>): <arguments>]`，工具结果以 `[resultado da chamada <id>]` 开头（错误结果为 `, com erro`），后跟其文本；图片和文件变为方括号占位符，推理块被省略。在对话记录中，每个工具调用的参数和每个工具结果的文本在 20,000 个字符处截断（`MAX_TRANSCRIPT_ITEM_CHARS`），后跟 `[<n> caracteres omitidos]`；总长超过 400,000 个字符（`MAX_TRANSCRIPT_CHARS`）时，略去最早的条目，始终保留最后一条，对话记录以 `[<n> mensagens anteriores omitidas da transcrição]` 开头。

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
- **会话只复用简单延续**——历史若不是记住的条目后面追加新用户消息，或等待中工具调用的结果与 harness 上下文，就会带着对话记录重新打开查询，而不是加以协调；工具步骤期间来自人的插话消息也会重新打开。
- **重新打开的查询会丢失对话记录截掉的内容**——超过 20,000 个字符的工具参数与结果，以及总长超过 400,000 个字符时最早的条目，都不在其中。
- **尚未被任何 bundle 挂载**——Toranja Harness bundle 与模型选择器的注册留待以后。
- **登录预检读取的是宿主 `claude` 可执行文件**——编排器探测宿主 CLI，而 SDK 启动的是它自己的平台锁定运行时，因此 `not-installed` 可能拒绝一个本可启动的运行时。
- **不支持自定义 `CLAUDE_CONFIG_DIR`**——环境过滤会移除它，存放在默认配置目录之外的登录信息不会被找到。
- **`init` 消息列出用户配置中的技能、代理和命令**——尽管 `settingSources` 为空，Claude Code 2.1.263 仍列出用户配置中的技能、其内置代理以及 `/clear`、`/compact` 等斜杠命令。领导者没有 `Skill` 或 `Agent` 工具（`tools: []`），所有用户文本都带标签到达，因此不会触发任何命令；真实 CLI 测试检查模型不会说出所列的任何一个，且 `.claude/commands` 中的项目命令没有被加载。`init` 不会因列出它们而被拒绝，因为 CLI 总是会列出；只有工具或桥之外的 MCP 服务器才会被拒绝。
