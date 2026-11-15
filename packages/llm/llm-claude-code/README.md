---
description: "Use the local Claude Code login as a text-only Toranja Harness chat model, with streamed text, reasoning, usage, and mapped sign-in and limit failures."
kind: "package-reference"
---

# @deepseek-ai/dsh-llm-claude-code

English | [中文](README.zh.md)

## Summary

Mount this plugin when a Toranja Harness composition should answer chat turns through the Claude subscription signed in to the local Claude Code CLI. It registers the `claude-code-local` route with the `opus`, `sonnet`, and `haiku` aliases and their reasoning levels. Each conversation keeps one isolated Claude Code query without tools, host settings, or MCP servers open across its turns and streams text and reasoning; calls outside a conversation open a query and close it after the result. No API key is read or copied. No bundle mounts the plugin yet.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

Insert the plugin in `cordis.patch.yml` after the LLM and subprocess services:

```yaml
- insert:
    - id: llm-claude-code
      name: '@deepseek-ai/dsh-llm-claude-code'
```

The plugin has no configuration. Sign in once with `claude auth login`; the route then lists `opus`, `sonnet`, and `haiku`, each with the `low`, `medium`, `high`, `xhigh`, and `max` reasoning levels the Claude Code subagent accepts. Omitting a level keeps the CLI default.

### Failure and recovery

Every failure ends the stream with one `finish` chunk of kind `error` and a fixed Portuguese message that never repeats CLI output or stderr.

| Condition | Code |
|---|---|
| The orchestrator reports `claude-code` as `signed-out` or `not-installed`, the CLI reports `authentication_failed`, or an `auth_status` message carries an error | `AUTH` |
| A rejected subscription limit (`rate_limit_event` with `status: "rejected"`) or a `billing_error` | `QUOTA` |
| A per-request `rate_limit` error | `RATE_LIMIT` |
| The result text names a context-window overflow | `CONTEXT_WINDOW_EXCEEDED` |
| A successful result without any content | `EMPTY_RESPONSE` |
| An `error_*` result subtype, another API error, or a CLI process that ends before its result | `CLAUDE_CODE_ERROR` |

The sign-in check runs only when `ctx.toranjaOrchestrator` is mounted; an unknown state or an absent orchestrator lets the query start, and the CLI's own authentication error then applies. An aborted `signal` interrupts the turn and ends with `finish` of kind `aborted`; a conversation query stays open for the next turn, and any other query closes. A failed turn closes its conversation query, so the next turn starts a new one with the transcript.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry, model catalog, prompt projection, query options, stream and failure mapping |

### Query lifecycle

`stream()` calls the official Agent SDK `query()` with streaming input: a queue of user messages that stays open while the query lives, because `interrupt()` requires it. A request with a `sessionId` and no `purpose` belongs to a conversation, keyed by that id; compaction, Session-title, and session-less requests get a disposable query that closes after the result.

A conversation query is opened with a configuration (working directory, model, effort, and system prompt) and remembers the conversation entries the CLI holds. The next turn reuses it when the configuration is unchanged and the request history equals those entries followed only by new user messages; it then pushes the new user text as one message and reads the same query until that turn's `result`. Any other history, such as a compacted, edited, or other-provider history, or a changed configuration closes the query and opens a new one with the transcript. Turns of one conversation run one at a time: a concurrent request waits for the running turn to settle. An aborted turn is interrupted and its interrupted `result` read before the query becomes idle again; a failed turn, a CLI process that exits, ten idle minutes, or plugin disposal closes it.

The query options are fixed: `tools: []`, `mcpServers: {}`, `strictMcpConfig: true`, `settingSources: []`, `persistSession: false`, `includePartialMessages: true`, a `canUseTool` callback that denies every request, and the request's `model` and `effort`. The working directory is the requesting Session's working directory when `ctx.sessions` and `ctx.workingDirectory` are mounted, otherwise the Host process directory.

The CLI process starts through `claudeSpawnSpec` and `ManagedClaudeCodeProcess` from [`@deepseek-ai/dsh-subagent-claude-code`](../../subagent/subagent-claude-code/README.md), so `ctx.subprocess` owns its managed range. Its environment is `scrubbedParentEnv()` without any variable whose name starts with `CLAUDE`, `ANTHROPIC`, or `MCP_`; the CLI finds the login through the user profile directories, so `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL`, and a custom `CLAUDE_CONFIG_DIR` never reach it. Closing a query calls `disposeClaudeCodeChild`, which closes it and waits for the process to exit; plugin disposal closes every query still open.

Cancellation calls `interrupt()`, bounded by the subagent's dispose grace, because aborting the SDK controller alone lets the CLI start another paid reply. A disposable query then closes; a conversation query closes only when its interrupted `result` does not arrive within the same grace.

</details>

-----

<a id="model-experience"></a>
## Model Experience

### Request projection

#### What the model sees

Claude Code receives a custom system prompt built from `GenerateOptions.system` and the text of every system and developer message, joined by blank lines, instead of the `claude_code` preset. A request with one user message sends that text as the prompt. A longer request sends one transcript of `USUÁRIO:` and `ASSISTENTE:` entries; tool calls become `[chamada de ferramenta: <name>]`, images and files become bracketed placeholders, reasoning blocks are omitted, and tool-result messages are dropped. No tool definitions are sent.

#### Token effect

A turn that continues a live conversation query sends only its new user text; the CLI keeps the earlier turns. Opening a query, on the first turn or after a reopen, sends the complete projected history. The CLI adds its own fixed request framing to the custom system prompt.

#### KV Cache effect

The projection is deterministic for an unchanged history, so a provider-side prompt cache can reuse the stable prefix. Switching to a multi-message transcript after the first turn rewrites the prompt from the first user entry onward.

### Response mapping

#### What the model sees

Streamed `text` and `thinking` blocks become harness text and reasoning blocks; a thinking block without visible text is not emitted. When the stream carried no block, the result text becomes one text block.

#### Token effect

Usage comes from the per-turn `result.usage`: `input_tokens`, `output_tokens`, `cache_read_input_tokens`, and `cache_creation_input_tokens` map to the disjoint harness counters.

#### KV Cache effect

Recorded response content appends to the next request and keeps the earlier projected prefix unchanged.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Text only** — the route offers no harness tools, and tool-result messages from another provider are dropped from the projected history.
- **The session reuses only a plain continuation** — a history that is not the remembered one followed by new user messages reopens the query with the full transcript instead of reconciling it.
- **Not mounted by any bundle** — the Toranja Harness bundle and model selector registration are deferred.
- **The sign-in pre-check reads the host `claude` executable** — the orchestrator probes the host CLI, while the SDK starts its own platform-pinned runtime, so `not-installed` can reject a runtime that would have started.
- **A custom `CLAUDE_CONFIG_DIR` is not honored** — the environment filter removes it, so a login stored outside the default profile directory is not found.
