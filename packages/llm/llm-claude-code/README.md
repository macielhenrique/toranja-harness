---
description: "Use the local Claude Code login as a Toranja Harness chat model that streams text, reasoning, and usage, hands its tool calls to the harness, and maps sign-in and limit failures."
kind: "package-reference"
---

# @deepseek-ai/dsh-llm-claude-code

English | [中文](README.zh.md)

## Summary

Mount this plugin when a Toranja Harness composition should answer chat turns through the Claude subscription signed in to the local Claude Code CLI. It registers the `claude-code-local` route with the `opus`, `sonnet`, and `haiku` aliases and their reasoning levels. Each conversation keeps one isolated Claude Code query open across its turns, without native tools, host settings, or the user's MCP servers, and streams text and reasoning. The harness tools of a conversation reach Claude through an in-process MCP server: each call Claude makes comes back as a harness `tool-call` block, the harness runs it, and its result continues the same query. Calls outside a conversation open a query without tools and close it after the result. No API key is read or copied. No bundle mounts the plugin yet.

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

A tool call still waiting for the harness fails with an error result for Claude when its query closes, when the CLI process exits, or when the plugin is disposed. A tool the bridge cannot translate is logged as a warning and left out; the rest of the tools are still offered.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry, model catalog, prompt projection, query options, tool steps, stream and failure mapping |
| [`src/bridge.ts`](src/bridge.ts) | The `toranja` MCP server: harness tool schemas translated for the SDK, and the calls pending on the harness |

### Query lifecycle

`stream()` calls the official Agent SDK `query()` with streaming input: a queue of user messages that stays open while the query lives, because `interrupt()` requires it. A request with a `sessionId` and no `purpose` belongs to a conversation, keyed by that id; compaction, Session-title, and session-less requests get a disposable query that closes after the result.

A conversation query is opened with a configuration (working directory, model, effort, system prompt, and a hash of the tool definitions) and remembers the conversation entries the CLI holds. The next turn reuses it when the configuration is unchanged and the request history equals those entries followed only by new user messages; it then pushes the new user text as one message and reads the same query until that turn's `result`. The comparison projects each message to its role and text, leaving out empty text blocks, which the harness may drop. Any other history or a changed configuration closes the query and opens a new one with the transcript of the request history:

- a compaction summary (a user message whose source kind is `compact-checkpoint`) among the new messages, or one that replaced remembered entries, always reopens, so the new query holds the compacted history and not what the harness discarded;
- a history that left the route and came back carries the assistant messages of the other provider after the remembered entries, so the reopened transcript includes them;
- after a Host restart no query is alive, so the first turn of the conversation opens with its whole history;
- an edited or removed earlier message, or a recorded reply that differs from what the CLI produced, also reopens. Turns of one conversation run one at a time: a concurrent request waits for the running turn to settle. An aborted turn is interrupted and its interrupted `result` read before the query becomes idle again; a failed turn, a CLI process that exits, ten idle minutes, or plugin disposal closes it.

The query options are fixed: `tools: []`, `mcpServers: {}`, `strictMcpConfig: true`, `settingSources: []`, `persistSession: false`, `includePartialMessages: true`, a `canUseTool` callback that denies every request, and the request's `model` and `effort`. A conversation request with tools replaces three of them: `mcpServers` holds only the `toranja` bridge server, `allowedTools` lists `mcp__toranja__<name>` for each tool the bridge serves, and `canUseTool` allows exactly those names and denies every other one; the native tools stay off. The working directory is the requesting Session's working directory when `ctx.sessions` and `ctx.workingDirectory` are mounted, otherwise the Host process directory.

The CLI process starts through `claudeSpawnSpec` and `ManagedClaudeCodeProcess` from [`@deepseek-ai/dsh-subagent-claude-code`](../../subagent/subagent-claude-code/README.md), so `ctx.subprocess` owns its managed range. Its environment is `scrubbedParentEnv()` without any variable whose name starts with `CLAUDE`, `ANTHROPIC`, or `MCP_`; the CLI finds the login through the user profile directories, so `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL`, and a custom `CLAUDE_CONFIG_DIR` never reach it. Closing a query calls `disposeClaudeCodeChild`, which closes it and waits for the process to exit; plugin disposal closes every query still open.

Cancellation calls `interrupt()`, bounded by the subagent's dispose grace, because aborting the SDK controller alone lets the CLI start another paid reply. A disposable query then closes; a conversation query closes only when its interrupted `result` does not arrive within the same grace.

### Tool steps

A `tool_use` block of a served `mcp__toranja__<name>` tool becomes a harness `tool-call` block with the `tool_use` id, the harness `<name>`, and the streamed JSON arguments; any other `tool_use` stays with the CLI, which answers it itself. A `message_delta` whose `stop_reason` is `tool_use`, in a message with at least one such block, ends the step: `stream()` emits the message's usage, then `finish` of kind `tool-calls`, and returns without waiting for any handler, because the CLI may call the first handler before the message ends. The query stays open, marked as waiting for tools, and the conversation lock is released.

The next request of the conversation continues the same query when the configuration is unchanged and its history equals the remembered entries, the assistant message with those calls included, followed by `tool` messages and, after them, only user messages the harness itself produced, whose source kind is neither `user` nor `compact-checkpoint`, such as the `additionalContexts` a tool attaches to its result. Their text reaches the model appended to the result of the last waiting call, after `[contexto adicional do Toranja Harness]`. Each result whose `toolCallId` matches a waiting call settles its handler with the result text and `isError`; a result for any other id is logged and ignored, and a waiting call without a result settles as an error. Reading then resumes on the same query up to the next tool step or the final `result`. Without `readOnlyHint` the CLI calls the handlers of one step one at a time, so a result that arrives before its handler is kept by id and delivered when the handler is called; the first call never waits for the rest of the batch.

Any other history, such as the results followed by a person's message (source kind `user`, or none) after a cancelled step or as steering, closes the query, which fails the waiting calls, and reopens it with the transcript. The bridge timeout is 30 minutes (`TOOL_CALL_TIMEOUT_MS`), long enough for a human approval; the query waiting for tools closes after the same time. A call past the limit gets an error from the CLI, so its late result never reaches that query and arrives only through the transcript of a reopened one.

The final `result.usage` counts the whole CLI turn, so the usage of the steps already reported is subtracted from it.

### Real CLI test

`tests/real-claude.e2e.ts` runs the route with `haiku` against the CLI bundled with the SDK and the local login, under `vitest.e2e.config.ts`; it skips unless that CLI's `auth status` reports `loggedIn: true`. It checks that the `init` message lists only the `mcp__toranja__*` tools and the `toranja` server with `apiKeySource: "none"`; that a text turn streams several deltas and ends with `usage` and `stop`; that a step with one or two tool calls ends with `tool-calls` after the CLI's `message_delta` with `stop_reason: "tool_use"`, and that the results reach the final reply; that later turns, an aborted turn, and the turn after it run on one query and one process; that fake `ANTHROPIC_*`, `CLAUDE_*`, and `MCP_*` variables never reach the child while the login still works; and that no CLI process outlives disposal. A run costs about US$ 0.02 of subscription usage.

</details>

-----

<a id="model-experience"></a>
## Model Experience

### Request projection

#### What the model sees

Claude Code receives a custom system prompt built from `GenerateOptions.system` and the text of every system and developer message, joined by blank lines, instead of the `claude_code` preset. A request with one user message sends that text as the prompt. A longer request sends one transcript of `USUÁRIO:`, `ASSISTENTE:`, and `FERRAMENTA:` entries; tool calls become `[chamada de ferramenta <name> (<id>): <arguments>]`, a tool result starts with `[resultado da chamada <id>]` (`, com erro` for an error result) followed by its text, images and files become bracketed placeholders, and reasoning blocks are omitted. In the transcript, each tool call's arguments and each tool result's text are cut at 20,000 characters (`MAX_TRANSCRIPT_ITEM_CHARS`), followed by `[<n> caracteres omitidos]`; past 400,000 characters in all (`MAX_TRANSCRIPT_CHARS`), the oldest entries are left out, the latest one always stays, and the transcript starts with `[<n> mensagens anteriores omitidas da transcrição]`.

A conversation request with tools sends their definitions as the `toranja` MCP server, so the model sees each tool as `mcp__toranja__<name>` with its description and JSON Schema parameters; the CLI loads them all up front. A tool result reaches the model as the MCP result of its call: its text, cut at 100,000 characters with a notice of how many were omitted.

#### Token effect

A turn that continues a live conversation query sends only its new user text, and a tool step only its results; the CLI keeps the earlier turns. The tool definitions add to every request of a conversation that offers tools. Opening a query, on the first turn or after a reopen, sends the complete projected history. The CLI adds its own fixed request framing to the custom system prompt.

#### KV Cache effect

The projection is deterministic for an unchanged history, so a provider-side prompt cache can reuse the stable prefix. Switching to a multi-message transcript after the first turn rewrites the prompt from the first user entry onward.

### Response mapping

#### What the model sees

Streamed `text` and `thinking` blocks become harness text and reasoning blocks; a thinking block without visible text is not emitted. A `tool_use` block of a served tool becomes a `tool-call` block named without the `mcp__toranja__` prefix. When the stream carried no block, the result text becomes one text block.

#### Token effect

Usage comes from the per-turn `result.usage`: `input_tokens`, `output_tokens`, `cache_read_input_tokens`, and `cache_creation_input_tokens` map to the disjoint harness counters. A tool step reports the usage of its message, from `message_start` and `message_delta`, and the final `result.usage` is reported less those steps.

#### KV Cache effect

Recorded response content appends to the next request and keeps the earlier projected prefix unchanged.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **No native tools** — Claude gets only the harness tools of a conversation; compaction, Session-title, and session-less calls get none.
- **Tool results are text** — an image or file in a tool result reaches Claude as a bracketed placeholder.
- **The calls of one step run one at a time** — the bridge sets no `readOnlyHint`, so the CLI calls the next handler only after the previous one returns.
- **The session reuses only a plain continuation** — a history that is not the remembered one followed by new user messages, or by the results of the waiting tool calls and harness context, reopens the query with the transcript instead of reconciling it; a person's message that steers during a tool step also reopens.
- **A reopened query loses what the transcript cuts** — tool arguments and results past 20,000 characters and the oldest entries past 400,000 characters in all are left out of it.
- **Not mounted by any bundle** — the Toranja Harness bundle and model selector registration are deferred.
- **The sign-in pre-check reads the host `claude` executable** — the orchestrator probes the host CLI, while the SDK starts its own platform-pinned runtime, so `not-installed` can reject a runtime that would have started.
- **A custom `CLAUDE_CONFIG_DIR` is not honored** — the environment filter removes it, so a login stored outside the default profile directory is not found.
- **User text that starts with `/` runs as a Claude Code command** — the CLI treats it as a slash command instead of a prompt: with Claude Code 2.1.263, `/help` answers "/help isn't available in this environment." without calling the model, and that text becomes the reply. The `init` message lists commands such as `/clear`, `/compact`, and `/model`, and the skills of the user profile, although `settingSources` is empty. The real CLI test expects this failure until it is fixed.
