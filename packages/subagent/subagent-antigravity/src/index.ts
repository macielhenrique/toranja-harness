/**
 * One-shot Antigravity CLI provider for Toranja Harness. Each accepted run
 * starts the user's installed `agy` in the selected child workspace and
 * returns its final JSON response through the standard external-subagent seam.
 *
 * @module @deepseek-ai/dsh-subagent-antigravity
 */

import { randomUUID } from 'node:crypto'
import type { Readable } from 'node:stream'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-subprocess'
import {
  assertPositiveFinite,
  assertUsableCwd,
  NO_START_CAPABILITIES,
  settleRunResult,
  subprocessRunHandle,
  type ResolvedSubagentStartRequest,
  type SubagentCapabilities,
  type SubagentProvider,
  type SubagentRun,
} from '@deepseek-ai/dsh-subagent'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'

export const name = 'subagent-antigravity'
export const inject = ['subagents', 'subprocess']

const DEFAULT_PROVIDER_NAME = 'antigravity'
const DEFAULT_EXECUTABLE = 'agy'
const DEFAULT_TIMEOUT_MS = 600_000
const DEFAULT_DISPOSE_GRACE_MS = 3_000
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024

const MODES = ['accept-edits', 'auto', 'plan'] as const
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
type AntigravityMode = typeof MODES[number]
type AntigravityEffort = typeof EFFORTS[number]

/** Deployment-owned Antigravity CLI settings. */
export interface Config {
  providerName?: string
  executable?: string
  timeoutMs?: number
  sandbox?: boolean
  /** Auto-approve headless tool prompts. Accepted only while sandbox is enabled. */
  autoApproveTools?: boolean
  mode?: AntigravityMode
  model?: string
  effort?: AntigravityEffort
  env?: Record<string, string>
  disposeGraceMs?: number
}

export const Config: z<Config> = z.object({
  providerName: z.string().min(1).default(DEFAULT_PROVIDER_NAME),
  executable: z.string().min(1).default(DEFAULT_EXECUTABLE),
  timeoutMs: z.number().default(DEFAULT_TIMEOUT_MS),
  sandbox: z.boolean().default(true),
  autoApproveTools: z.boolean().default(false),
  mode: z.union([...MODES]).default('accept-edits'),
  model: z.string().min(1),
  effort: z.union([...EFFORTS]),
  env: z.dict(z.string()).default({}),
  disposeGraceMs: z.number().default(DEFAULT_DISPOSE_GRACE_MS),
})

type ResolvedConfig = Required<Omit<Config, 'model' | 'effort'>>
  & Pick<Config, 'model' | 'effort'>

interface AntigravityEnvelope {
  readonly status?: unknown
  readonly response?: unknown
  readonly error?: unknown
}

function taskText(prompt: readonly ContentBlock[]): string {
  if (prompt.length === 0) throw new Error('subagent-antigravity: task must contain text')
  const parts: string[] = []
  for (const block of prompt) {
    if (block.type !== 'text') {
      throw new Error('subagent-antigravity: only text task blocks are supported')
    }
    parts.push(block.text)
  }
  const task = parts.join('\n\n').trim()
  if (task.length === 0) throw new Error('subagent-antigravity: task must not be empty')
  return task
}

function readBounded(stream: Readable | undefined, label: string): Promise<Buffer> {
  if (stream === undefined) return Promise.resolve(Buffer.alloc(0))
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let bytes = 0
    stream.on('data', (chunk: Buffer | string) => {
      const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
      bytes += buffer.length
      if (bytes > MAX_OUTPUT_BYTES) {
        reject(new Error(`subagent-antigravity: ${label} exceeded ${MAX_OUTPUT_BYTES} bytes`))
        return
      }
      chunks.push(buffer)
    })
    stream.once('end', () => { resolve(Buffer.concat(chunks)) })
    stream.once('error', reject)
  })
}

function repairJsonControls(text: string): string {
  let output = ''
  let inString = false
  let escaped = false
  for (const char of text) {
    if (!inString) {
      output += char
      if (char === '"') inString = true
      continue
    }
    if (escaped) {
      output += char
      escaped = false
      continue
    }
    if (char === '\\') {
      output += char
      escaped = true
    } else if (char === '"') {
      output += char
      inString = false
    } else if (char === '\n') output += '\\n'
    else if (char === '\r') output += '\\r'
    else if (char === '\t') output += '\\t'
    else if (char.charCodeAt(0) < 0x20) {
      output += `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`
    } else output += char
  }
  return output
}

function parseEnvelope(raw: string): AntigravityEnvelope {
  const text = raw.trim()
  if (text.length === 0) throw new Error('subagent-antigravity: agy returned empty stdout')
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    parsed = JSON.parse(repairJsonControls(text))
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('subagent-antigravity: agy returned a non-object JSON envelope')
  }
  return parsed
}

function safeDiagnostic(envelope: AntigravityEnvelope, stderr: Buffer): string {
  const status = typeof envelope.status === 'string' ? envelope.status : 'UNKNOWN'
  const parts = [`Antigravity status: ${status}`]
  if (typeof envelope.error === 'string' && envelope.error.trim().length > 0) {
    parts.push(envelope.error.trim())
  }
  const stderrText = stderr.toString('utf8').trim()
  if (stderrText.length > 0) parts.push(stderrText)
  return parts.join('\n')
}

class AntigravityProvider implements SubagentProvider {
  readonly capabilities: SubagentCapabilities = NO_START_CAPABILITIES
  readonly inheritsParentContext = false

  constructor(
    readonly name: string,
    private readonly ctx: Context,
    private readonly config: ResolvedConfig,
  ) {}

  start(request: ResolvedSubagentStartRequest): Promise<SubagentRun> {
    const cwd = assertUsableCwd('subagent-antigravity', 'child cwd', request.cwd)
    const argv = [
      this.config.executable,
      '-p', taskText(request.prompt),
      '--output-format', 'json',
      '--print-timeout', `${this.config.timeoutMs}ms`,
      '--disable-slash-commands',
      '--mode', this.config.mode,
    ]
    if (this.config.sandbox) argv.push('--sandbox')
    if (this.config.autoApproveTools) argv.push('--dangerously-skip-permissions')
    if (this.config.model !== undefined) argv.push('--model', this.config.model)
    if (this.config.effort !== undefined) argv.push('--effort', this.config.effort)

    const runAbort = new AbortController()
    const child = this.ctx.subprocess.spawn({
      argv,
      cwd,
      stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
      graceMs: this.config.disposeGraceMs,
      signal: runAbort.signal,
      env: this.config.env,
    })
    const stdout = readBounded(child.stdout, 'stdout')
    const stderr = readBounded(child.stderr, 'stderr')
    let output: readonly ContentBlock[] = []
    let diagnostic: string | undefined
    let timedOut = false

    const requestCancel = (): void => {
      if (!runAbort.signal.aborted) runAbort.abort(new Error('subagent-antigravity: cancelled'))
      child.terminate()
    }
    const onAbort = (): void => { requestCancel() }
    request.signal.addEventListener('abort', onAbort, { once: true })
    const timer = setTimeout(() => {
      timedOut = true
      diagnostic = `Antigravity timed out after ${this.config.timeoutMs} ms`
      requestCancel()
    }, this.config.timeoutMs)

    const result = settleRunResult({
      attempt: async () => {
        const outcome = await child.done
        const [stdoutBytes, stderrBytes] = await Promise.all([stdout, stderr])
        const envelope = parseEnvelope(stdoutBytes.toString('utf8'))
        const status = typeof envelope.status === 'string' ? envelope.status : 'UNKNOWN'
        const response = typeof envelope.response === 'string' ? envelope.response.trim() : ''
        if (timedOut || status !== 'SUCCESS' || response.length === 0 || outcome.exitCode !== 0) {
          diagnostic ??= safeDiagnostic(envelope, stderrBytes)
          throw new Error(`subagent-antigravity: ${diagnostic}`)
        }
        output = [{ type: 'text', text: response }]
        return { output, stopReason: 'completed' }
      },
      collectOutput: () => output,
      collectDiagnostic: () => diagnostic,
      cancelled: () => runAbort.signal.aborted,
      onError: (error, stopReason) => {
        this.ctx.logger.warn(
          `subagent-antigravity "${this.name}": child run failed (${stopReason}): ${error.message}`,
        )
      },
      signal: request.signal,
      onAbort,
    })

    return Promise.resolve(subprocessRunHandle({
      id: brandString<SessionId>(randomUUID()),
      result,
      signal: request.signal,
      onAbort,
      requestCancel,
      teardown: async () => {
        clearTimeout(timer)
        child.terminate()
        await child.waitForExit()
        await child.done.catch(() => undefined)
      },
    }))
  }
}

/** Register the local Antigravity CLI provider. */
export function apply(ctx: Context, config: Config): void {
  const resolved: ResolvedConfig = {
    providerName: config.providerName ?? DEFAULT_PROVIDER_NAME,
    executable: config.executable ?? DEFAULT_EXECUTABLE,
    timeoutMs: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    sandbox: config.sandbox ?? true,
    autoApproveTools: config.autoApproveTools ?? false,
    mode: config.mode ?? 'accept-edits',
    ...config.model === undefined ? {} : { model: config.model },
    ...config.effort === undefined ? {} : { effort: config.effort },
    env: config.env ?? {},
    disposeGraceMs: config.disposeGraceMs ?? DEFAULT_DISPOSE_GRACE_MS,
  }
  assertPositiveFinite('subagent-antigravity', 'timeoutMs', resolved.timeoutMs)
  assertPositiveFinite('subagent-antigravity', 'disposeGraceMs', resolved.disposeGraceMs)
  if (resolved.autoApproveTools && !resolved.sandbox) {
    throw new Error('subagent-antigravity: autoApproveTools requires sandbox=true')
  }
  if (resolved.timeoutMs > MAX_TIMER_DELAY_MS || resolved.disposeGraceMs > MAX_TIMER_DELAY_MS) {
    throw new Error(`subagent-antigravity: timeout values must be <= ${MAX_TIMER_DELAY_MS}`)
  }
  ctx.subagents.registerProvider(new AntigravityProvider(resolved.providerName, ctx, resolved))
}
