/** Claude Code model route over the local Claude login for Toranja Harness, with the harness tools of a conversation. */

import { createHash } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import type { Context } from '@deepseek-ai/cordis'
import {
  query,
  type Options,
  type Query,
  type SDKAssistantMessageError,
  type SDKMessage,
  type SDKUserMessage,
  type SpawnOptions,
} from '@anthropic-ai/claude-agent-sdk'
import {
  CONTEXT_WINDOW_EXCEEDED_CODE,
  EMPTY_RESPONSE_CODE,
  isContextWindowExceededError,
  LlmAdapter,
  QUOTA_EXCEEDED_CODE,
  ReasoningEffortId,
  ToolCallId,
  type ContentBlock,
  type GenerateOptions,
  type LlmModelInfo,
  type LlmProviderInfo,
  type LlmResolvedModelInfo,
  type RequestMessage,
  type StreamChunk,
  type TokenUsage,
  type ToolResultMessage,
  type ToolSchema,
} from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-session'
import { scrubbedParentEnv, type SubprocessHandle } from '@deepseek-ai/dsh-subprocess'
import {
  CLAUDE_CODE_EFFORTS,
  claudeCodeFailureDiagnostic,
  claudeSpawnSpec,
  DEFAULT_DISPOSE_GRACE_MS,
  disposeClaudeCodeChild,
  ManagedClaudeCodeProcess,
  type ClaudeCodeEffort,
} from '@deepseek-ai/dsh-subagent-claude-code'
import type {} from '@deepseek-ai/dsh-toranja-orchestrator'
import type {} from '@deepseek-ai/dsh-working-directory'
import { BRIDGE_SERVER_NAME, createBridgeServer, type BridgeResult } from './bridge.ts'

export const name = 'llm-claude-code'
export const inject = ['llm', 'subprocess']

const PROVIDER = 'claude-code-local'
const AUTH_CODE = 'AUTH'
const RATE_LIMIT_CODE = 'RATE_LIMIT'
const GENERIC_CODE = 'CLAUDE_CODE_ERROR'
const LOGIN_MESSAGE = 'Conecte o Claude Code em Configurações → Orquestrador (claude auth login).'
const EFFORT_NAMES: Readonly<Record<ClaudeCodeEffort, string>> = {
  low: 'Baixo',
  medium: 'Médio',
  high: 'Alto',
  xhigh: 'Muito alto',
  max: 'Máximo',
}
const MODELS: readonly LlmModelInfo[] = ([
  ['opus', 'Claude Opus'],
  ['sonnet', 'Claude Sonnet'],
  ['haiku', 'Claude Haiku'],
] as const).map(([id, modelName]) => ({
  provider: PROVIDER,
  id,
  name: modelName,
  description: 'Usa o login e os limites da assinatura local do Claude Code; recebe só as ferramentas do Toranja Harness.',
  inputModalities: ['text'] as const,
}))

/** Largest tool argument or result text a reopening transcript carries; the excess is cut with a notice. */
export const MAX_TRANSCRIPT_ITEM_CHARS = 20_000
/** Largest reopening transcript; its oldest messages are left out first. */
export const MAX_TRANSCRIPT_CHARS = 400_000

function cut(text: string): string {
  return text.length <= MAX_TRANSCRIPT_ITEM_CHARS
    ? text
    : `${text.slice(0, MAX_TRANSCRIPT_ITEM_CHARS)}\n[${text.length - MAX_TRANSCRIPT_ITEM_CHARS} caracteres omitidos]`
}

/**
 * Text of content blocks as the CLI sees them; empty text blocks count as absent, as the harness may drop them.
 * @param content - message blocks.
 * @param limited - cut each tool argument text, for a transcript.
 * @returns the joined text.
 */
function contentText(content: readonly ContentBlock[], limited = false): string {
  return content.flatMap((block) => {
    if (block.type === 'text') return block.text.length === 0 ? [] : [block.text]
    if (block.type === 'tool-call') return [`[chamada de ferramenta ${block.name} (${block.id}): ${limited ? cut(block.arguments) : block.arguments}]`]
    if (block.type === 'image') return ['[imagem anexada no Toranja Harness]']
    if (block.type === 'file') return [`[arquivo anexado: ${block.attachment.name}]`]
    return []
  }).join('\n').trim()
}

/** Text of a message as the CLI sees it; a tool result names the call it answers. */
function blockText(message: RequestMessage, limited = false): string {
  const text = contentText(message.content, limited)
  if (message.role !== 'tool') return text
  return `[resultado da chamada ${message.toolCallId}${message.isError === true ? ', com erro' : ''}]\n${limited ? cut(text) : text}`.trim()
}

/**
 * Split a request into the CLI system prompt and one user prompt. A lone user
 * message is sent as is; a longer history becomes a labeled transcript, with
 * tool arguments and results cut and its oldest messages left out past its limit.
 * @param options - assembled model request.
 * @returns the system prompt text and the user prompt text.
 */
function promptOf(options: GenerateOptions): { readonly system: string; readonly prompt: string } {
  const system = options.system === undefined ? [] : [options.system]
  const rows: string[] = []
  for (const message of options.messages) {
    const text = blockText(message, message.role !== 'system' && message.role !== 'developer')
    if (text.length === 0) continue
    if (message.role === 'system' || message.role === 'developer') system.push(text)
    else if (message.role === 'user') rows.push(`USUÁRIO:\n${text}`)
    else if (message.role === 'assistant') rows.push(`ASSISTENTE:\n${text}`)
    else rows.push(`FERRAMENTA:\n${text}`)
  }
  let omitted = 0
  for (let size = rows.join('\n\n').length; size > MAX_TRANSCRIPT_CHARS && omitted < rows.length - 1; omitted++) {
    size -= (rows[omitted]?.length ?? 0) + 2
  }
  const kept = omitted === 0 ? rows : [`[${omitted} mensagens anteriores omitidas da transcrição]`, ...rows.slice(omitted)]
  const conversation = options.messages.filter(message => message.role === 'user' || message.role === 'assistant')
  const lone = conversation.length === 1 && conversation[0]?.role === 'user' ? conversation[0] : undefined
  return { system: system.join('\n\n'), prompt: lone === undefined ? kept.join('\n\n') : blockText(lone) }
}

/** Parent environment without credentials, harness variables, or Claude, Anthropic, and MCP overrides. */
function childEnv(): Record<string, string> {
  return Object.fromEntries(Object.entries(scrubbedParentEnv()).filter(([key]) => !/^(?:CLAUDE|ANTHROPIC|MCP_)/i.test(key)))
}

/** Read live cancellation; a call keeps TypeScript from narrowing it across awaits. */
function aborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true
}

function failed(code: string, message: string): StreamChunk {
  return { type: 'finish', reason: { kind: 'error', failure: { code, message } } }
}

const ABORTED: StreamChunk = {
  type: 'finish',
  reason: { kind: 'aborted', failure: { code: 'ABORTED', message: 'A resposta do Claude Code foi cancelada.' } },
}

/**
 * Classify a turn the CLI ended on an API error. A rejected subscription
 * window wins over the per-request error, because retrying cannot succeed
 * before the window resets.
 * @param apiError - error category the CLI attached to the assistant message.
 * @param limitRejected - whether the CLI reported a rejected subscription limit.
 * @param result - error text of the result message, read only for classification.
 * @returns the terminal error finish.
 */
function turnFailure(apiError: SDKAssistantMessageError | undefined, limitRejected: boolean, result: string): StreamChunk {
  if (apiError === 'authentication_failed' || apiError === 'oauth_org_not_allowed') return failed(AUTH_CODE, LOGIN_MESSAGE)
  if (limitRejected || apiError === 'billing_error') {
    return failed(QUOTA_EXCEEDED_CODE, 'O limite de uso da assinatura do Claude Code foi atingido; tente novamente depois que ele for renovado.')
  }
  if (apiError === 'rate_limit') return failed(RATE_LIMIT_CODE, 'O Claude Code recusou a requisição por limite de taxa; tente novamente em instantes.')
  if (isContextWindowExceededError(result)) return failed(CONTEXT_WINDOW_EXCEEDED_CODE, 'A conversa excede a janela de contexto do modelo do Claude Code.')
  return failed(GENERIC_CODE, `O Claude Code encerrou o turno com erro da API (${apiError ?? 'unknown'}).`)
}

interface OpenBlock {
  readonly kind: 'text' | 'reasoning' | 'tool-call'
  /** Text so far; for a tool call, its raw JSON arguments. */
  text: string
  /** Harness block index, assigned when the block starts. */
  index?: number
  /** `tool_use` id and harness tool name of a tool call. */
  readonly call?: { readonly id: string; readonly name: string }
}

function blockOf({ kind, text, call }: OpenBlock): ContentBlock {
  return call === undefined
    ? { type: kind === 'reasoning' ? 'reasoning' : 'text', text }
    : { type: 'tool-call', id: ToolCallId(call.id), name: call.name, arguments: text === '' ? '{}' : text }
}

/** Token counts as the Anthropic API reports them; a stream delta leaves unknown counts null. */
interface ApiUsage {
  readonly input_tokens?: number | null
  readonly output_tokens?: number | null
  readonly cache_read_input_tokens?: number | null
  readonly cache_creation_input_tokens?: number | null
}

/**
 * Harness usage of API counts, less what earlier steps of the same CLI turn already reported.
 * @param usage - API counts.
 * @param spent - usage already reported for this CLI turn.
 * @returns the remaining usage, never negative.
 */
function tokenUsage(usage: ApiUsage, spent?: TokenUsage): TokenUsage {
  const left = (count: number | null | undefined, already = 0): number => Math.max(0, (count ?? 0) - already)
  return {
    inputTokens: left(usage.input_tokens, spent?.inputTokens),
    outputTokens: left(usage.output_tokens, spent?.outputTokens),
    cacheReadTokens: left(usage.cache_read_input_tokens, spent?.cacheReadTokens),
    cacheWriteTokens: left(usage.cache_creation_input_tokens, spent?.cacheWriteTokens),
  }
}

function sumUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: (a.cacheReadTokens ?? 0) + (b.cacheReadTokens ?? 0),
    cacheWriteTokens: (a.cacheWriteTokens ?? 0) + (b.cacheWriteTokens ?? 0),
  }
}

/** An idle conversation query closes after this long without a turn. */
const IDLE_CLOSE_MS = 10 * 60_000
/**
 * Wall-clock limit of one harness tool call, as the CLI enforces it on the bridge. Generous because the
 * harness may hold a call for human approval; past it the CLI hands the model an error and the late result is dropped.
 */
const TOOL_CALL_TIMEOUT_MS = 30 * 60_000
/** Prefix the CLI gives the tools of the bridge server. */
const TOOL_PREFIX = `mcp__${BRIDGE_SERVER_NAME}__`
const ENDED_MESSAGE = 'A conversa do Claude Code foi encerrada antes do resultado desta ferramenta.'
const STOP = Symbol('stop')
const NEVER = new Promise<never>(() => undefined)

/** Conversation entry as the CLI sees it: role and projected text. */
interface Entry {
  readonly role: string
  readonly text: string
}

/** Producer kind of a message; a request-only user input has none. */
function kindOf(message: RequestMessage): string | undefined {
  return message.source?.kind
}

/** Context the harness itself adds as a user message, such as a tool's reminder; not a person's message nor a compaction summary. */
function harnessContext(message: RequestMessage): boolean {
  const kind = kindOf(message)
  return message.role === 'user' && kind !== undefined && kind !== 'user' && kind !== 'compact-checkpoint'
}

/**
 * Messages a history appends to what the CLI already holds.
 * @param seen - entries the live query already received or produced.
 * @param history - entries of the new request, one per message of `said`.
 * @param said - conversation messages of the new request.
 * @returns the appended messages; none unless the history starts with `seen` and goes past it without a compaction summary.
 */
function appended(seen: readonly Entry[], history: readonly Entry[], said: readonly RequestMessage[]): readonly RequestMessage[] {
  if (history.length <= seen.length) return []
  if (JSON.stringify(history.slice(0, seen.length)) !== JSON.stringify(seen)) return []
  const added = said.slice(seen.length)
  // The CLI still holds what a compaction summary replaced, so a summary always reopens.
  return added.some(message => kindOf(message) === 'compact-checkpoint') ? [] : added
}

/** What one turn produced, read by the settlement after the stream ends. */
interface TurnState {
  /** Harness blocks in index order. */
  readonly opened: OpenBlock[]
  /** Whether the CLI reported the turn's result. */
  completed: boolean
}

/** One Claude Code query and its CLI process, fed by a queue of user messages. */
class LiveQuery {
  /** `awaiting-tools`: the CLI turn stopped on tool calls the harness has yet to answer. */
  phase: 'idle' | 'turn-running' | 'awaiting-tools' | 'closing' | 'closed' = 'turn-running'
  /** Tool calls of the last step, in model order, that the harness has not answered yet. */
  awaiting: readonly string[] = []
  /** Usage already reported for the steps of the running CLI turn. */
  spent: TokenUsage = tokenUsage({})
  /** Conversation entries the CLI holds; its length counts the messages delivered. */
  seen: readonly Entry[] = []
  idle: ReturnType<typeof setTimeout> | undefined
  interrupting: Promise<void> | undefined
  managed: ManagedClaudeCodeProcess | undefined
  readonly query: Query
  private readonly messages: AsyncIterator<SDKMessage>
  private child: SubprocessHandle | undefined
  private failure: Promise<never> = NEVER
  private pending: Promise<IteratorResult<SDKMessage>> | undefined
  private readonly queued: string[] = []
  private wake: () => void = () => undefined
  private ended = false
  private closing: Promise<void> | undefined
  /** Harness names of the tools the bridge serves. */
  readonly served: ReadonlySet<string>
  private readonly bridge: ReturnType<typeof createBridgeServer> | undefined
  /** Results that came before the CLI called their handler: without readOnlyHint it calls one handler at a time. */
  private readonly early = new Map<string, BridgeResult>()

  constructor(private readonly ctx: Context, readonly config: string, options: Options, tools: readonly ToolSchema[] = []) {
    this.bridge = tools.length === 0
      ? undefined
      : createBridgeServer({ tools, onCall: ({ id }) => { this.deliver(id) }, timeoutMs: TOOL_CALL_TIMEOUT_MS })
    const refused = new Set(this.bridge?.refused.map(({ name: tool, reason }) => {
      ctx.logger.warn('llm-claude-code: tool %s is not offered to Claude Code: %s', tool, reason)
      return tool
    }))
    this.served = new Set(tools.map(tool => tool.name).filter(tool => !refused.has(tool)))
    const allowed = [...this.served].map(tool => TOOL_PREFIX + tool)
    this.query = query({
      // Streaming input keeps the control channel open, which interrupt() requires.
      prompt: this.input(),
      options: {
        ...options,
        ...this.bridge === undefined ? {} : {
          mcpServers: { [BRIDGE_SERVER_NAME]: this.bridge.server },
          allowedTools: allowed,
          canUseTool: (tool: string, input: Record<string, unknown>) => Promise.resolve(allowed.includes(tool)
            ? { behavior: 'allow' as const, updatedInput: input }
            : { behavior: 'deny' as const, message: 'Esta ferramenta não está disponível nesta conversa.' }),
        },
        spawnClaudeCodeProcess: (spawn: SpawnOptions) => {
          const child = ctx.subprocess.spawn(claudeSpawnSpec(spawn, DEFAULT_DISPOSE_GRACE_MS))
          this.child = child
          this.managed = new ManagedClaudeCodeProcess(child)
          this.failure = child.done.then(() => NEVER)
          void this.failure.catch(() => undefined)
          const exited = (): void => {
            this.bridge?.rejectAll(ENDED_MESSAGE)
            if (this.closing === undefined) this.phase = 'closed'
          }
          void child.done.then(exited, exited)
          return this.managed
        },
      },
    })
    this.messages = this.query[Symbol.asyncIterator]()
  }

  /** Start a CLI turn with a user message. */
  push(text: string): void {
    this.awaiting = []
    this.early.clear()
    this.spent = tokenUsage({})
    this.queued.push(text)
    this.wake()
  }

  /**
   * Hand the harness results to the waiting calls; a call the harness left without a result fails.
   * @param results - tool messages the harness appended after the step.
   * @param context - text the harness added after the results, handed to the model with the last call's result.
   */
  answer(results: readonly ToolResultMessage[], context: string): void {
    const given = new Map(results.map(message => [String(message.toolCallId), {
      content: contentText(message.content),
      ...message.isError === true ? { isError: true } : {},
    }]))
    for (const id of given.keys()) {
      if (!this.awaiting.includes(id)) this.ctx.logger.warn('llm-claude-code: ignoring a result for unknown tool call %s', id)
    }
    const last = this.awaiting.at(-1)
    for (const id of this.awaiting) {
      const base = given.get(id) ?? { content: 'Sem resultado do harness para esta chamada.', isError: true }
      // shortcut: the bridge cuts a huge result from the end, losing the context appended to it; move the context ahead if that matters.
      const result = id === last && context.length > 0 ? { ...base, content: `${base.content}\n\n[contexto adicional do Toranja Harness]\n${context}` } : base
      if (this.bridge?.resolve(id, result) !== true) this.early.set(id, result)
    }
    this.awaiting = []
  }

  /** Release a call whose handler arrived after the harness answered it. */
  private deliver(id: string): void {
    const result = this.early.get(id)
    if (result === undefined) return
    this.early.delete(id)
    this.bridge?.resolve(id, result)
  }

  private async * input(): AsyncIterable<SDKUserMessage> {
    for (;;) {
      const text = this.queued.shift()
      if (text !== undefined) yield { type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null }
      else if (this.ended) return
      else await new Promise<void>((resolve) => { this.wake = resolve })
    }
  }

  /**
   * Read the next CLI message unless `stop` settles first; a message still
   * pending then stays for the next read, so none is lost.
   * @param stop - settles with STOP to give up waiting.
   * @returns the iterator result, or STOP.
   */
  async read(stop: Promise<typeof STOP>): Promise<IteratorResult<SDKMessage> | typeof STOP> {
    if (this.pending === undefined) {
      this.pending = this.messages.next()
      void this.pending.catch(() => undefined)
    }
    const next = await Promise.race([this.pending, this.failure, stop])
    if (next !== STOP) this.pending = undefined
    return next
  }

  /** Interrupt the running turn once, bounded by the dispose grace. */
  interrupt(): Promise<void> {
    this.interrupting ??= Promise.race([this.query.interrupt(), delay(DEFAULT_DISPOSE_GRACE_MS, undefined, { ref: false })])
      .then(() => undefined, () => undefined)
    return this.interrupting
  }

  /** Interrupt the turn and read through its result, so the next turn starts on a clean stream. */
  async recover(): Promise<boolean> {
    await this.interrupt()
    const stop = delay(DEFAULT_DISPOSE_GRACE_MS, STOP, { ref: false })
    try {
      for (;;) {
        const next = await this.read(stop)
        if (next === STOP || next.done === true) return false
        if (next.value.type === 'result') return true
      }
    } catch {
      return false
    }
  }

  close(): Promise<void> {
    this.closing ??= (async () => {
      this.phase = 'closing'
      this.bridge?.rejectAll(ENDED_MESSAGE)
      clearTimeout(this.idle)
      this.ended = true
      this.wake()
      await this.release()
      this.phase = 'closed'
    })()
    return this.closing
  }

  private async release(): Promise<void> {
    if (this.child === undefined) {
      this.query.close()
      return
    }
    try {
      await disposeClaudeCodeChild(this.query, this.child)
    } catch (error: unknown) {
      // The turn already reported its outcome; a teardown failure only reaches the host log.
      this.ctx.logger.warn('llm-claude-code: Claude Code teardown failed: %o', error)
    }
  }
}

class ClaudeCodeAdapter extends LlmAdapter {
  /** Disposable queries of calls outside a conversation. */
  private readonly open = new Set<LiveQuery>()
  /** Live query of each conversation, by session id. */
  private readonly sessions = new Map<string, LiveQuery>()
  /** Tail of the turn queue of each conversation. */
  private readonly turns = new Map<string, Promise<void>>()

  constructor(private readonly ctx: Context) { super() }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: 'Claude Code (login local)' }
  }

  override listModels(_provider: string): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve(MODELS)
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    const listed = MODELS.find(candidate => candidate.id === model)
    return Promise.resolve({
      ...listed ?? { provider, id: model, name: model },
      reasoning: { efforts: CLAUDE_CODE_EFFORTS.map(effort => ({ id: ReasoningEffortId(effort), name: EFFORT_NAMES[effort] })) },
    })
  }

  /** Close every query still open, for plugin disposal. */
  dispose(): void {
    for (const live of [...this.open, ...this.sessions.values()]) void live.close()
    this.open.clear()
    this.sessions.clear()
  }

  private cwd(options: GenerateOptions): string {
    const sessions = this.ctx.get('sessions')
    const workingDirectory = this.ctx.get('workingDirectory')
    const session = options.sessionId === undefined ? undefined : sessions?.get(options.sessionId)
    return session === undefined || workingDirectory === undefined ? process.cwd() : workingDirectory.get(session)
  }

  private signedOut(): boolean {
    const connection = this.ctx.get('toranjaOrchestrator')?.status().providers
      .find(provider => provider.id === 'claude-code')?.connection
    return connection === 'signed-out' || connection === 'not-installed'
  }

  /** Conversation key of a request; auxiliary calls and calls without a session have none. */
  private sessionKey(options: GenerateOptions): string | undefined {
    return options.purpose === undefined && options.sessionId !== undefined ? String(options.sessionId) : undefined
  }

  /**
   * Wait for the previous turn of a conversation to settle; turns of one
   * conversation run one at a time on its single query.
   * @param key - conversation key.
   * @returns the release that lets the next turn start.
   */
  private async lock(key: string): Promise<() => void> {
    const previous = this.turns.get(key)
    let release: () => void = () => undefined
    const current = new Promise<void>((resolve) => { release = resolve })
    this.turns.set(key, current)
    await previous
    return () => {
      if (this.turns.get(key) === current) this.turns.delete(key)
      release()
    }
  }

  private forget(key: string, live: LiveQuery): Promise<void> {
    if (this.sessions.get(key) === live) this.sessions.delete(key)
    return live.close()
  }

  private queryOptions(cwd: string, model: string, effort: ClaudeCodeEffort | undefined, system: string): Options {
    return {
      cwd,
      model,
      ...effort === undefined ? {} : { effort },
      systemPrompt: system,
      tools: [],
      mcpServers: {},
      strictMcpConfig: true,
      settingSources: [],
      persistSession: false,
      includePartialMessages: true,
      env: childEnv(),
      canUseTool: () => Promise.resolve({ behavior: 'deny', message: 'Esta rota do Claude Code não oferece ferramentas.' }),
    }
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const signal = options.signal
    if (aborted(signal)) {
      yield ABORTED
      return
    }
    if (this.signedOut()) {
      yield failed(AUTH_CODE, LOGIN_MESSAGE)
      return
    }
    const key = this.sessionKey(options)
    const unlock = key === undefined ? undefined : await this.lock(key)
    let live: LiveQuery | undefined
    let history: readonly Entry[] = []
    let finish: string | undefined
    const turn: TurnState = { opened: [], completed: false }
    let stop: (value: typeof STOP) => void = () => undefined
    const stopped = new Promise<typeof STOP>((resolve) => { stop = resolve })
    // Aborting the SDK controller lets the CLI start another paid reply; interrupt stops the turn first.
    const onAbort = (): void => {
      void live?.interrupt()
      stop(STOP)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    try {
      if (aborted(signal)) {
        finish = 'aborted'
        yield ABORTED
        return
      }
      const { system, prompt } = promptOf(options)
      const effort = CLAUDE_CODE_EFFORTS.find(candidate => candidate === options.reasoningEffort)
      const cwd = this.cwd(options)
      // Tools ride only on a conversation, whose query outlives the step that asks for them.
      const tools = key === undefined ? [] : options.tools ?? []
      const config = JSON.stringify([cwd, options.model, effort ?? null, system, createHash('sha256').update(JSON.stringify(tools)).digest('hex')])
      const said = options.messages.filter(message => message.role !== 'system' && message.role !== 'developer')
      history = said.map(message => ({ role: message.role, text: blockText(message) }))
      const kept = key === undefined ? undefined : this.sessions.get(key)
      const added = kept?.config === config ? appended(kept.seen, history, said) : []
      const text = added.every(message => message.role === 'user') ? added.map(message => blockText(message)).filter(value => value.length > 0).join('\n\n') : ''
      const results = added.filter((message): message is ToolResultMessage => message.role === 'tool')
      const contexts = added.slice(results.length)
      // An idle query takes new user text; one stopped on tool calls takes their results and the context the harness adds after them.
      const answering = kept?.phase === 'awaiting-tools' && results.length > 0
        && added.slice(0, results.length).every(message => message.role === 'tool') && contexts.every(harnessContext)
      if (kept !== undefined && (answering || (kept.phase === 'idle' && text.length > 0))) {
        live = kept
      } else {
        // A changed configuration or a rewritten history reopens with the full transcript.
        if (kept !== undefined && key !== undefined) await this.forget(key, kept)
        live = new LiveQuery(this.ctx, config, this.queryOptions(cwd, options.model, effort, system), tools)
        if (key === undefined) this.open.add(live)
        else this.sessions.set(key, live)
      }
      live.phase = 'turn-running'
      live.interrupting = undefined
      clearTimeout(live.idle)
      if (answering) live.answer(results, contexts.map(message => blockText(message)).filter(value => value.length > 0).join('\n\n'))
      else live.push(live === kept ? text : prompt)
      if (aborted(signal)) onAbort()
      for await (const chunk of this.turnChunks(live, signal, stopped, turn)) {
        if (chunk.type === 'finish') finish = chunk.reason.kind
        yield chunk
      }
    } finally {
      signal?.removeEventListener('abort', onAbort)
      const settled = live === undefined ? Promise.resolve() : this.settle(key, live, history, finish, turn)
      // A conversation settles in the background; its next turn waits on the lock.
      if (unlock === undefined) await settled
      else void settled.finally(unlock)
    }
  }

  /**
   * Leave a conversation query idle for its next turn, or close it. A failed
   * turn closes it, because what the CLI then holds is unknown; an aborted turn
   * keeps it once the interrupted result has been read.
   */
  private async settle(
    key: string | undefined,
    live: LiveQuery,
    history: readonly Entry[],
    finish: string | undefined,
    turn: TurnState,
  ): Promise<void> {
    // A step that asks for tools keeps the CLI turn open for the results, unless it was interrupted meanwhile.
    const asking = finish === 'tool-calls' && live.interrupting === undefined
    const keep = key !== undefined && live.phase === 'turn-running' && finish !== 'error'
      && (asking || finish === 'stop' || finish === 'max-tokens' || turn.completed || await live.recover())
    if (keep && live.phase === 'turn-running') {
      const reply = contentText(turn.opened.map(blockOf))
      live.seen = turn.opened.length === 0 ? history : [...history, { role: 'assistant', text: reply }]
      const phase = asking ? 'awaiting-tools' : 'idle'
      live.phase = phase
      live.idle = setTimeout(() => { if (live.phase === phase) void this.forget(key, live) }, asking ? TOOL_CALL_TIMEOUT_MS : IDLE_CLOSE_MS)
      live.idle.unref()
      return
    }
    if (live.interrupting !== undefined) await live.interrupting
    this.open.delete(live)
    await (key === undefined ? live.close() : this.forget(key, live))
  }

  /** Stream one turn of `live` until its result, a failure, or `stopped`. */
  private async * turnChunks(
    live: LiveQuery,
    signal: AbortSignal | undefined,
    stopped: Promise<typeof STOP>,
    turn: TurnState,
  ): AsyncIterable<StreamChunk> {
    const blocks = new Map<number, OpenBlock>()
    const opened = turn.opened
    /** Tool calls the current assistant message made, and its usage so far. */
    let asked: string[] = []
    let usage: ApiUsage = {}
    let apiError: SDKAssistantMessageError | undefined
    let limitRejected = false
    let thrown: unknown
    try {
      for (;;) {
        const next = await live.read(stopped)
        if (next === STOP || next.done === true) break
        const message = next.value
        if (message.type === 'result') turn.completed = true
        if (aborted(signal)) break
        if (message.type === 'stream_event') {
          const event = message.event
          if (event.type === 'message_start') {
            blocks.clear()
            asked = []
            usage = event.message.usage
          } else if (event.type === 'message_delta') {
            usage = { ...usage, ...Object.fromEntries(Object.entries(event.usage).filter(([, count]) => typeof count === 'number')) }
            // The SDK's own signal that the message ends asking for tools; the CLI then waits on the handlers.
            if (event.delta.stop_reason !== 'tool_use' || asked.length === 0) continue
            const step = tokenUsage(usage)
            live.spent = sumUsage(live.spent, step)
            live.awaiting = asked
            if (Object.keys(usage).length > 0) yield { type: 'usage', usage: step }
            yield { type: 'finish', reason: { kind: 'tool-calls' } }
            return
          } else if (event.type === 'content_block_start') {
            const content = event.content_block
            if (content.type === 'tool_use') {
              // Only the tools the bridge serves reach the harness; the CLI answers any other call itself.
              const tool = content.name.slice(TOOL_PREFIX.length)
              if (!content.name.startsWith(TOOL_PREFIX) || !live.served.has(tool)) continue
              const block: OpenBlock = { kind: 'tool-call', text: '', call: { id: content.id, name: tool } }
              blocks.set(event.index, block)
              block.index = opened.push(block) - 1
              asked.push(content.id)
              yield { type: 'block-start', index: block.index, blockType: 'tool-call' }
              continue
            }
            const type = content.type
            const kind = type === 'text' ? 'text' : type === 'thinking' ? 'reasoning' : undefined
            if (kind === undefined) continue
            const block: OpenBlock = { kind, text: '' }
            blocks.set(event.index, block)
            // A thinking block starts on its first visible delta; the CLI may withhold its text.
            if (kind === 'text') {
              block.index = opened.push(block) - 1
              yield { type: 'block-start', index: block.index, blockType: kind }
            }
          } else if (event.type === 'content_block_delta') {
            const block = blocks.get(event.index)
            const delta = event.delta
            if (block?.kind === 'tool-call') {
              if (delta.type === 'input_json_delta') block.text += delta.partial_json
              continue
            }
            const text = delta.type === 'text_delta' ? delta.text : delta.type === 'thinking_delta' ? delta.thinking : ''
            if (block === undefined || text.length === 0) continue
            if (block.index === undefined) {
              block.index = opened.push(block) - 1
              yield { type: 'block-start', index: block.index, blockType: block.kind }
            }
            block.text += text
            yield { type: block.kind === 'text' ? 'text-delta' : 'reasoning-delta', index: block.index, text }
          } else if (event.type === 'content_block_stop') {
            const block = blocks.get(event.index)
            blocks.delete(event.index)
            if (block?.index !== undefined) yield { type: 'block-end', index: block.index, block: blockOf(block) }
          }
          continue
        }
        if (message.type === 'assistant' && message.error !== undefined) {
          apiError = message.error
          continue
        }
        if (message.type === 'rate_limit_event') {
          if (message.rate_limit_info.status === 'rejected') limitRejected = true
          continue
        }
        if (message.type === 'auth_status') {
          if (message.error === undefined) continue
          yield failed(AUTH_CODE, LOGIN_MESSAGE)
          return
        }
        if (message.type !== 'result') continue
        if (message.subtype !== 'success') {
          const detail = message.errors.join('; ')
          yield failed(GENERIC_CODE, `O Claude Code encerrou o turno com erro (${message.subtype})${detail.length === 0 ? '' : `: ${detail}`}`)
          return
        }
        if (message.is_error) {
          yield turnFailure(apiError, limitRejected, message.result)
          return
        }
        if (opened.length === 0 && message.result.length > 0) {
          opened.push({ kind: 'text', text: message.result, index: 0 })
          yield { type: 'block-start', index: 0, blockType: 'text' }
          yield { type: 'text-delta', index: 0, text: message.result }
          yield { type: 'block-end', index: 0, block: { type: 'text', text: message.result } }
        }
        if (opened.length === 0) {
          yield failed(EMPTY_RESPONSE_CODE, 'O Claude Code concluiu o turno sem conteúdo.')
          return
        }
        // The result counts the whole CLI turn, so the steps that asked for tools are taken out.
        yield { type: 'usage', usage: tokenUsage(message.usage, live.spent) }
        yield { type: 'finish', reason: message.stop_reason === 'max_tokens' ? { kind: 'max-tokens' } : { kind: 'stop' } }
        return
      }
    } catch (error: unknown) {
      thrown = error
    }
    if (aborted(signal)) {
      yield ABORTED
      return
    }
    // Let the managed process publish an exit observed together with the stream end.
    await Promise.resolve()
    const outcome = live.managed?.outcome
    if (thrown !== undefined) this.ctx.logger.warn('llm-claude-code: Claude Code query failed: %o', thrown)
    const diagnostic = claudeCodeFailureDiagnostic(outcome === undefined
      ? { stage: 'query-run', category: thrown === undefined ? 'invalid-result' : 'unknown' }
      : { stage: 'process', category: 'process', outcome })
    yield failed(GENERIC_CODE, `O Claude Code encerrou antes de concluir a resposta (${diagnostic}).`)
  }
}

/**
 * Register the `claude-code-local` model route and close its open queries on disposal.
 * @param ctx - context carrying the LLM and subprocess services; the orchestrator,
 *   session, and working-directory services are read when present.
 */
export function apply(ctx: Context): void {
  const adapter = new ClaudeCodeAdapter(ctx)
  ctx.effect(() => {
    const unregister = ctx.llm.registerAdapter([PROVIDER], adapter)
    return () => {
      unregister()
      adapter.dispose()
    }
  }, 'llm-claude-code: register Claude Code route')
}
