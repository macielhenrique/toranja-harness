---
description: "把本地 Claude Code 登录用作仅文本的 Toranja Harness 对话模型，流式返回文本、推理与用量，并映射登录与额度失败。"
kind: "package-reference"
---

# @deepseek-ai/dsh-llm-claude-code

[English](README.md) | 中文

## 概述

当 Toranja Harness 组合需要通过本地 Claude Code CLI 已登录的 Claude 订阅回答对话轮次时，挂载本插件。它注册 `claude-code-local` 路由，提供 `opus`、`sonnet`、`haiku` 别名及其推理等级。每个请求打开一个隔离的 Claude Code 查询，不带工具、宿主设置或 MCP 服务器，流式返回文本和推理，并在结果之后关闭。插件不读取也不复制 API 密钥。目前没有 bundle 挂载本插件。

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

登录检查只在挂载了 `ctx.toranjaOrchestrator` 时运行；状态未知或没有编排器时查询照常启动，此时由 CLI 自身的身份验证错误生效。中止的 `signal` 会中断该轮、关闭查询，并以类型为 `aborted` 的 `finish` 结束。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节——点击展开</summary>

### 源码地图

| 文件 | 作用 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口、模型目录、提示词投影、查询选项、流与失败映射 |

### 查询生命周期

`stream()` 以流式输入调用官方 Agent SDK 的 `query()`，输入一直保持打开直到该轮结束，因为 `interrupt()` 需要它。查询选项是固定的：`tools: []`、`mcpServers: {}`、`strictMcpConfig: true`、`settingSources: []`、`persistSession: false`、`includePartialMessages: true`、一个拒绝所有请求的 `canUseTool` 回调，以及请求的 `model` 和 `effort`。挂载了 `ctx.sessions` 与 `ctx.workingDirectory` 时，工作目录是发起请求的 Session 的工作目录，否则是 Host 进程目录。

CLI 进程通过 [`@deepseek-ai/dsh-subagent-claude-code`](../../subagent/subagent-claude-code/README.zh.md) 的 `claudeSpawnSpec` 与 `ManagedClaudeCodeProcess` 启动，因此由 `ctx.subprocess` 管理其进程范围。其环境是去掉所有以 `CLAUDE`、`ANTHROPIC` 或 `MCP_` 开头的变量之后的 `scrubbedParentEnv()`；CLI 通过用户配置目录找到登录信息，所以 `ANTHROPIC_API_KEY`、`ANTHROPIC_BASE_URL` 和自定义的 `CLAUDE_CONFIG_DIR` 都不会到达它。在结果之后或失败之后，`disposeClaudeCodeChild` 关闭查询并等待进程退出；插件释放时关闭所有仍然打开的查询。

取消时先调用 `interrupt()`，在它完成后、或在 subagent 的释放宽限时间之后再调用 `close()`，因为只中止 SDK 控制器会让 CLI 再开始一次付费回复。

</details>

-----

<a id="model-experience"></a>
## 模型体验

### 请求投影

#### 模型看到什么

Claude Code 收到的是一个自定义系统提示，由 `GenerateOptions.system` 和每条 system 与 developer 消息的文本以空行连接而成，而不是 `claude_code` 预设。只有一条用户消息的请求直接把该文本作为提示发送。更长的请求发送一份由 `USUÁRIO:` 与 `ASSISTENTE:` 条目组成的对话记录；工具调用变为 `[chamada de ferramenta: <name>]`，图片和文件变为方括号占位符，推理块被省略，工具结果消息被丢弃。不发送任何工具定义。

#### Token 影响

每个请求都会重新发送完整的投影历史，因为每次调用都会打开新的 CLI 会话。CLI 会在自定义系统提示之外加入它自己的固定请求框架。

#### KV Cache 影响

在历史不变时投影是确定的，因此提供方的提示缓存可以复用稳定前缀。第一轮之后切换为多消息对话记录，会从第一个用户条目起改写提示。

### 响应映射

#### 模型看到什么

流式的 `text` 与 `thinking` 块变为 harness 的文本块与推理块；没有可见文本的 thinking 块不会输出。若流中没有任何块，结果文本会成为一个文本块。

#### Token 影响

用量来自每轮的 `result.usage`：`input_tokens`、`output_tokens`、`cache_read_input_tokens` 与 `cache_creation_input_tokens` 分别映射到互不重叠的 harness 计数。

#### KV Cache 影响

记录下来的响应内容追加到下一个请求中，之前的投影前缀保持不变。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **仅文本**——该路由不提供 harness 工具，来自其他提供方的工具结果消息会从投影历史中丢弃。
- **没有持续会话**——每个请求启动新的 CLI 进程并重新发送完整历史。
- **尚未被任何 bundle 挂载**——Toranja Harness bundle 与模型选择器的注册留待以后。
- **登录预检读取的是宿主 `claude` 可执行文件**——编排器探测宿主 CLI，而 SDK 启动的是它自己的平台锁定运行时，因此 `not-installed` 可能拒绝一个本可启动的运行时。
- **不支持自定义 `CLAUDE_CONFIG_DIR`**——环境过滤会移除它，存放在默认配置目录之外的登录信息不会被找到。
