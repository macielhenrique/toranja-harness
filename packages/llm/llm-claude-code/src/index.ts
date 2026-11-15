/** Text-only Claude Code model route over the local Claude login for Toranja Harness. */

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
  type GenerateOptions,
  type LlmModelInfo,
  type LlmProviderInfo,
  type LlmResolvedModelInfo,
  type RequestMessage,
  type StreamChunk,
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
  description: 'Usa o login e os limites da assinatura local do Claude Code, sem ferramentas.',
  inputModalities: ['text'] as const,
}))

function blockText(message: RequestMessage): string {
  return message.content.flatMap((block) => {
    if (block.type === 'text') return [block.text]
    if (block.type === 'tool-call') return [`[chamada de ferramenta: ${block.name}]`]
    if (block.type === 'image') return ['[imagem anexada no Toranja Harness]']
    if (block.type === 'file') return [`[arquivo anexado: ${block.attachment.name}]`]
    return []
  }).join('\n').trim()
}

/**
 * Split a request into the CLI system prompt and one user prompt. A lone user
 * message is sent as is; a longer history becomes a labeled transcript.
 * @param options - assembled model request.
 * @returns the system prompt text and the user prompt text.
 */
function promptOf(options: GenerateOptions): { readonly system: string; readonly prompt: string } {
  const system = options.system === undefined ? [] : [options.system]
  const rows: string[] = []
  for (const message of options.messages) {
    const text = blockText(message)
    if (text.length === 0) continue
    if (message.role === 'system' || message.role === 'developer') system.push(text)
    else if (message.role === 'user') rows.push(`USUÁRIO:\n${text}`)
    else if (message.role === 'assistant') rows.push(`ASSISTENTE:\n${text}`)
    // shortcut: tool-result messages are dropped because this route offers no tools; carry them when harness tools reach Claude Code.
  }
  const conversation = options.messages.filter(message => message.role === 'user' || message.role === 'assistant')
  const lone = conversation.length === 1 && conversation[0]?.role === 'user' ? conversation[0] : undefined
  return { system: system.join('\n\n'), prompt: lone === undefined ? rows.join('\n\n') : blockText(lone) }
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
  readonly kind: 'text' | 'reasoning'
  text: string
  /** Harness block index, assigned when the block starts. */
  index?: number
}

/** An idle conversation query closes after this long without a turn. */
const IDLE_CLOSE_MS = 10 * 60_000
const STOP = Symbol('stop')
const NEVER = new Promise<never>(() => undefined)

/** Conversation entry as the CLI sees it: role and projected text. */
interface Entry {
  readonly role: string
  readonly text: string
}

function conversationOf(messages: readonly RequestMessage[]): Entry[] {
  return messages.filter(message => message.role !== 'system' && message.role !== 'developer')
    .map(message => ({ role: message.role, text: blockText(message) }))
}

/**
 * Text of the user messages a history appends to what the CLI already holds.
 * @param seen - entries the live query already received or produced.
 * @param history - entries of the new request.
 * @returns the joined new user text, or undefined unless the history only appends user messages.
 */
function appended(seen: readonly Entry[], history: readonly Entry[]): string | undefined {
  if (history.length <= seen.length) return undefined
  if (JSON.stringify(history.slice(0, seen.length)) !== JSON.stringify(seen)) return undefined
  const added = history.slice(seen.length)
  if (added.some(entry => entry.role !== 'user')) return undefined
  const text = added.map(entry => entry.text).filter(value => value.length > 0).join('\n\n')
  return text.length === 0 ? undefined : text
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
  phase: 'idle' | 'turn-running' | 'closing' | 'closed' = 'turn-running'
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

  constructor(private readonly ctx: Context, readonly config: string, options: Options) {
    this.query = query({
      // Streaming input keeps the control channel open, which interrupt() requires.
      prompt: this.input(),
      options: {
        ...options,
        spawnClaudeCodeProcess: (spawn: SpawnOptions) => {
          const child = ctx.subprocess.spawn(claudeSpawnSpec(spawn, DEFAULT_DISPOSE_GRACE_MS))
          this.child = child
          this.managed = new ManagedClaudeCodeProcess(child)
          this.failure = child.done.then(() => NEVER)
          void this.failure.catch(() => undefined)
          const exited = (): void => { if (this.closing === undefined) this.phase = 'closed' }
          void child.done.then(exited, exited)
          return this.managed
        },
      },
    })
    this.messages = this.query[Symbol.asyncIterator]()
  }

  push(text: string): void {
    this.queued.push(text)
    this.wake()
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
      const config = JSON.stringify([cwd, options.model, effort ?? null, system])
      history = conversationOf(options.messages)
      const kept = key === undefined ? undefined : this.sessions.get(key)
      const added = kept?.phase === 'idle' && kept.config === config ? appended(kept.seen, history) : undefined
      if (kept !== undefined && added !== undefined) {
        live = kept
      } else {
        // A changed configuration or a rewritten history reopens with the full transcript.
        if (kept !== undefined && key !== undefined) await this.forget(key, kept)
        live = new LiveQuery(this.ctx, config, this.queryOptions(cwd, options.model, effort, system))
        if (key === undefined) this.open.add(live)
        else this.sessions.set(key, live)
      }
      live.phase = 'turn-running'
      live.interrupting = undefined
      clearTimeout(live.idle)
      live.push(added ?? prompt)
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
    const keep = key !== undefined && live.phase === 'turn-running' && finish !== 'error'
      && (finish === 'stop' || finish === 'max-tokens' || turn.completed || await live.recover())
    if (keep && live.phase === 'turn-running') {
      const reply = turn.opened.filter(block => block.kind === 'text').map(block => block.text).join('\n').trim()
      live.seen = turn.opened.length === 0 ? history : [...history, { role: 'assistant', text: reply }]
      live.phase = 'idle'
      live.idle = setTimeout(() => { if (live.phase === 'idle') void this.forget(key, live) }, IDLE_CLOSE_MS)
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
          } else if (event.type === 'content_block_start') {
            const type = event.content_block.type
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
            if (block?.index !== undefined) yield { type: 'block-end', index: block.index, block: { type: block.kind, text: block.text } }
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
        const usage = message.usage
        yield {
          type: 'usage',
          usage: {
            inputTokens: usage.input_tokens,
            outputTokens: usage.output_tokens,
            cacheReadTokens: usage.cache_read_input_tokens,
            cacheWriteTokens: usage.cache_creation_input_tokens,
          },
        }
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
