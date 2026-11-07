import { createInterface } from 'node:readline'
import type { Writable } from 'node:stream'
import type { Context } from '@deepseek-ai/cordis'
import type { TokenUsage } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-subprocess'
import { ANTIGRAVITY_ACTION_SCHEMA } from './protocol.ts'

const MAX_DIAGNOSTIC_CHARS = 8_192

/** Configuration for a persistent `agy` stream-json subprocess session. */
export interface AgySessionConfig {
  executable: string
  timeoutMs: number
  sandbox: boolean
  autoApproveTools: boolean
  mode: 'accept-edits' | 'auto' | 'plan'
  model?: string
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max'
  env: Record<string, string>
}

interface AgyUsage {
  input_tokens?: unknown
  output_tokens?: unknown
  thinking_tokens?: unknown
  cache_read_tokens?: unknown
  total_tokens?: unknown
}

interface AgyResult {
  conversation_id?: unknown
  status?: unknown
  response?: unknown
  error?: unknown
  usage?: AgyUsage
}

interface PendingTurn {
  resolve(result: AgyResult): void
  reject(error: Error): void
  cleanup(): void
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0
}

function usageDelta(current: AgyUsage | undefined, previous: TokenUsage): TokenUsage {
  const cache = Math.max(0, count(current?.cache_read_tokens) - (previous.cacheReadTokens ?? 0))
  const providerInput = Math.max(0, count(current?.input_tokens) - previous.inputTokens - (previous.cacheReadTokens ?? 0))
  const output = Math.max(0, count(current?.output_tokens) - previous.outputTokens)
  const reasoning = Math.max(0, count(current?.thinking_tokens) - (previous.reasoningTokens ?? 0))
  const total = Math.max(0, count(current?.total_tokens) - (previous.totalTokens ?? 0))
  return {
    inputTokens: Math.max(0, providerInput - cache),
    outputTokens: output,
    cacheReadTokens: cache,
    reasoningTokens: reasoning,
    totalTokens: total,
  }
}

function cumulativeUsage(value: AgyUsage | undefined): TokenUsage {
  const cache = count(value?.cache_read_tokens)
  return {
    inputTokens: Math.max(0, count(value?.input_tokens) - cache),
    outputTokens: count(value?.output_tokens),
    cacheReadTokens: cache,
    reasoningTokens: count(value?.thinking_tokens),
    totalTokens: count(value?.total_tokens),
  }
}

/** Persistent `agy` stream-json subprocess session bound to one working directory. */
export class AgySession {
  private pending: PendingTurn | undefined
  private stderr = ''
  private closed = false
  private cumulative: TokenUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, reasoningTokens: 0, totalTokens: 0 }
  private readonly child
  private readonly input: Writable
  /** Exact `agy --model` value bound to this subprocess, when selected explicitly. */
  readonly model: string | undefined
  /** Exact `agy --effort` value bound to this subprocess, when configured separately. */
  readonly effort: AgySessionConfig['effort']

  /**
   * Spawn a persistent `agy` stream-json subprocess.
   * @param cwd - Working directory for the subprocess.
   * @param ctx - Cordis context providing `subprocess`.
   * @param config - Subprocess and model flags.
   */
  constructor(readonly cwd: string, ctx: Context, config: AgySessionConfig) {
    this.model = config.model
    this.effort = config.effort
    const argv = [
      config.executable,
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--print-timeout', `${config.timeoutMs}ms`,
      '--disable-slash-commands',
      '--json-schema', ANTIGRAVITY_ACTION_SCHEMA,
      '--mode', config.mode,
    ]
    if (config.sandbox) argv.push('--sandbox')
    if (config.autoApproveTools) argv.push('--dangerously-skip-permissions')
    if (config.model !== undefined) argv.push('--model', config.model)
    if (config.effort !== undefined) argv.push('--effort', config.effort)
    this.child = ctx.subprocess.spawn({
      argv,
      cwd,
      stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
      env: config.env,
      graceMs: 3_000,
    })
    if (this.child.stdin === undefined || this.child.stdout === undefined) {
      throw new Error('Antigravity direto não conseguiu abrir os canais do processo agy')
    }
    this.input = this.child.stdin
    const lines = createInterface({ input: this.child.stdout })
    lines.on('line', (line) => { this.acceptLine(line) })
    this.child.stderr?.on('data', (chunk: Buffer | string) => {
      this.stderr = `${this.stderr}${String(chunk)}`.slice(-MAX_DIAGNOSTIC_CHARS)
    })
    void this.child.done.then(
      (outcome) => { this.fail(new Error(`Antigravity encerrou (código ${outcome.exitCode ?? 'desconhecido'}): ${this.stderr.trim()}`)) },
      (error: unknown) => { this.fail(error instanceof Error ? error : new Error(String(error))) },
    )
  }

  private acceptLine(line: string): void {
    let envelope: unknown
    try { envelope = JSON.parse(line) } catch { return }
    if (typeof envelope !== 'object' || envelope === null) return
    const record = envelope as { event?: unknown; result?: unknown }
    if (record.event !== 'result' || typeof record.result !== 'object' || record.result === null) return
    const pending = this.pending
    if (pending === undefined) return
    this.pending = undefined
    pending.cleanup()
    pending.resolve(record.result)
  }

  private fail(error: Error): void {
    if (this.closed) return
    this.closed = true
    const pending = this.pending
    this.pending = undefined
    pending?.cleanup()
    pending?.reject(error)
  }

  /**
   * Send a user prompt and await the next structured result line.
   * @param prompt - User prompt string sent over `stream-json`.
   * @param signal - Optional abort signal for turn cancellation.
   * @returns Raw response text and incremental token usage for the turn.
   */
  async ask(prompt: string, signal?: AbortSignal): Promise<{ text: string; usage: TokenUsage }> {
    if (this.closed) throw new Error('A sessão direta do Antigravity foi encerrada')
    if (this.pending !== undefined) throw new Error('A sessão direta do Antigravity já está executando um turno')
    signal?.throwIfAborted()
    const result = await new Promise<AgyResult>((resolve, reject) => {
      const onAbort = (): void => {
        this.close()
        reject(signal?.reason instanceof Error ? signal.reason : new Error('Turno do Antigravity cancelado'))
      }
      const cleanup = (): void => { signal?.removeEventListener('abort', onAbort) }
      this.pending = { resolve, reject, cleanup }
      signal?.addEventListener('abort', onAbort, { once: true })
      this.input.write(`${JSON.stringify({ event: 'user', message: { content: prompt } })}\n`, (error) => {
        if (error === null || error === undefined) return
        this.pending = undefined
        cleanup()
        reject(error)
      })
    })
    if (result.status !== 'SUCCESS' || typeof result.response !== 'string' || result.response.trim().length === 0) {
      const message = typeof result.error === 'string' ? result.error : `status ${String(result.status)}`
      throw new Error(`Antigravity não concluiu o turno: ${message}`)
    }
    const usage = usageDelta(result.usage, this.cumulative)
    this.cumulative = cumulativeUsage(result.usage)
    return { text: result.response.trim(), usage }
  }

  /** Terminate the underlying `agy` subprocess and reject any pending turn. */
  close(): void {
    if (this.closed) return
    this.closed = true
    this.input.end()
    this.child.terminate()
    const pending = this.pending
    this.pending = undefined
    pending?.cleanup()
    pending?.reject(new Error('Sessão direta do Antigravity encerrada'))
  }
}
