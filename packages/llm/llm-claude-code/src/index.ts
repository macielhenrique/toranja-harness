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

class ClaudeCodeAdapter extends LlmAdapter {
  private readonly open = new Set<Query>()

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
    for (const running of this.open) running.close()
    this.open.clear()
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
    const { system, prompt } = promptOf(options)
    let endInput: () => void = () => undefined
    const inputOpen = new Promise<void>((resolve) => { endInput = resolve })
    // Streaming input keeps the control channel open, which interrupt() requires.
    async function* input(): AsyncIterable<SDKUserMessage> {
      yield { type: 'user', message: { role: 'user', content: prompt }, parent_tool_use_id: null }
      await inputOpen
    }
    let child: SubprocessHandle | undefined
    let managed: ManagedClaudeCodeProcess | undefined
    const effort = CLAUDE_CODE_EFFORTS.find(candidate => candidate === options.reasoningEffort)
    const queryOptions: Options = {
      cwd: this.cwd(options),
      model: options.model,
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
      spawnClaudeCodeProcess: (spawn: SpawnOptions) => {
        child = this.ctx.subprocess.spawn(claudeSpawnSpec(spawn, DEFAULT_DISPOSE_GRACE_MS))
        managed = new ManagedClaudeCodeProcess(child)
        return managed
      },
    }
    const running = query({ prompt: input(), options: queryOptions })
    this.open.add(running)
    // Aborting the SDK controller lets the CLI start another paid reply; interrupt stops the turn first.
    const onAbort = (): void => {
      void Promise.race([running.interrupt(), delay(DEFAULT_DISPOSE_GRACE_MS, undefined, { ref: false })])
        .catch(() => undefined)
        .finally(() => { running.close() })
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    const childFailure = child?.done.then(() => new Promise<never>(() => undefined))
    void childFailure?.catch(() => undefined)
    const blocks = new Map<number, OpenBlock>()
    let nextIndex = 0
    let apiError: SDKAssistantMessageError | undefined
    let limitRejected = false
    let thrown: unknown
    try {
      try {
        const messages: AsyncIterator<SDKMessage> = running[Symbol.asyncIterator]()
        for (;;) {
          const next = await (childFailure === undefined ? messages.next() : Promise.race([messages.next(), childFailure]))
          if (next.done === true || aborted(signal)) break
          const message = next.value
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
                block.index = nextIndex++
                yield { type: 'block-start', index: block.index, blockType: kind }
              }
            } else if (event.type === 'content_block_delta') {
              const block = blocks.get(event.index)
              const delta = event.delta
              const text = delta.type === 'text_delta' ? delta.text : delta.type === 'thinking_delta' ? delta.thinking : ''
              if (block === undefined || text.length === 0) continue
              if (block.index === undefined) {
                block.index = nextIndex++
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
          if (nextIndex === 0 && message.result.length > 0) {
            yield { type: 'block-start', index: 0, blockType: 'text' }
            yield { type: 'text-delta', index: 0, text: message.result }
            yield { type: 'block-end', index: 0, block: { type: 'text', text: message.result } }
            nextIndex = 1
          }
          if (nextIndex === 0) {
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
      const outcome = managed?.outcome
      if (thrown !== undefined) this.ctx.logger.warn('llm-claude-code: Claude Code query failed: %o', thrown)
      const diagnostic = claudeCodeFailureDiagnostic(outcome === undefined
        ? { stage: 'query-run', category: thrown === undefined ? 'invalid-result' : 'unknown' }
        : { stage: 'process', category: 'process', outcome })
      yield failed(GENERIC_CODE, `O Claude Code encerrou antes de concluir a resposta (${diagnostic}).`)
    } finally {
      signal?.removeEventListener('abort', onAbort)
      endInput()
      this.open.delete(running)
      await this.release(running, child)
    }
  }

  private async release(running: Query, child: SubprocessHandle | undefined): Promise<void> {
    if (child === undefined) {
      running.close()
      return
    }
    try {
      await disposeClaudeCodeChild(running, child)
    } catch (error: unknown) {
      // The turn already reported its outcome; a teardown failure only reaches the host log.
      this.ctx.logger.warn('llm-claude-code: Claude Code teardown failed: %o', error)
    }
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
