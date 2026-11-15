import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { ReasoningEffortId, type GenerateOptions, type LlmAdapter, type StreamChunk } from '@deepseek-ai/dsh-llm'
import type { SubprocessHandle, SubprocessOutcome, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import type { Options, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import type { SessionId } from '@deepseek-ai/dsh-session'

const sdk = vi.hoisted(() => ({ query: vi.fn() }))
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: sdk.query }))

const { apply } = await import('../src/index.ts')

type Script = readonly Record<string, unknown>[]

interface FakeQuery {
  readonly options: Options
  readonly prompt: AsyncIterable<SDKUserMessage>
  readonly interrupt: ReturnType<typeof vi.fn>
  readonly close: ReturnType<typeof vi.fn>
}

interface Harness {
  adapter: LlmAdapter
  specs: SubprocessSpawnSpec[]
  dispose: () => void
}

/** Drive the mocked SDK: each query spawns through the shared hook and yields `script`. */
function scriptQuery(script: Script, after: 'end' | 'hang' | Error = 'end', outcome?: SubprocessOutcome): FakeQuery[] {
  const queries: FakeQuery[] = []
  sdk.query.mockImplementation(({ prompt, options }: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => {
    let release: () => void = () => undefined
    const closed = new Promise<void>((resolve) => { release = resolve })
    const fake: FakeQuery = {
      options,
      prompt,
      interrupt: vi.fn(() => Promise.resolve(undefined)),
      close: vi.fn(() => { release() }),
    }
    queries.push(fake)
    options.spawnClaudeCodeProcess?.({
      command: 'claude',
      args: [],
      ...options.cwd === undefined ? {} : { cwd: options.cwd },
      env: options.env ?? {},
      signal: new AbortController().signal,
    })
    exitOutcome = outcome
    async function* messages() {
      for (const message of script) yield message
      if (after === 'hang') await closed
      if (after instanceof Error) throw after
    }
    return Object.assign(messages(), { interrupt: fake.interrupt, close: fake.close })
  })
  return queries
}

let exitOutcome: SubprocessOutcome | undefined

const orchestrator = (connection: string) => ({
  toranjaOrchestrator: { status: () => ({ providers: [{ id: 'claude-code', connection }] }) },
})

function harness(services: Record<string, unknown> = {}): Harness {
  const specs: SubprocessSpawnSpec[] = []
  let adapter: LlmAdapter | undefined
  let disposer: (() => void) | undefined
  const ctx: Context = {
    effect: (register: () => (() => void)) => { disposer = register() },
    get: (name: string) => services[name],
    llm: {
      registerAdapter: (providers: readonly string[], value: LlmAdapter) => {
        expect(providers).toEqual(['claude-code-local'])
        adapter = value
        return () => undefined
      },
    },
    logger: { warn: () => undefined },
    subprocess: {
      spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
        specs.push(spec)
        let exit: (outcome: SubprocessOutcome) => void = () => undefined
        const done = new Promise<SubprocessOutcome>((resolve) => { exit = resolve })
        queueMicrotask(() => { if (exitOutcome !== undefined) exit(exitOutcome) })
        const handle: Partial<SubprocessHandle> = {
          stdin: new PassThrough(),
          stdout: new PassThrough(),
          done,
          terminate: () => { exit({ exitCode: null, signal: 'SIGTERM' }) },
          waitForExit: () => Promise.resolve(true),
        }
        return handle as SubprocessHandle
      },
    },
  } as never
  apply(ctx)
  if (adapter === undefined || disposer === undefined) throw new Error('adapter not registered')
  return { adapter, specs, dispose: disposer }
}

function request(overrides: Partial<GenerateOptions> = {}): GenerateOptions {
  return {
    provider: 'claude-code-local',
    model: 'haiku',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'oi' }] }],
    ...overrides,
  }
}

async function collect(adapter: LlmAdapter, options: GenerateOptions): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of adapter.stream(options)) chunks.push(chunk)
  return chunks
}

beforeEach(() => {
  sdk.query.mockReset()
  exitOutcome = undefined
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('ClaudeCodeAdapter catalog', () => {
  it('lists the Claude Code aliases with every reasoning level of the subagent', async () => {
    const { adapter } = harness()
    expect(adapter.providerInfo('claude-code-local')).toEqual({ id: 'claude-code-local', name: 'Claude Code (login local)' })
    const models = await adapter.listModels('claude-code-local')
    expect(models.map(model => model.id)).toEqual(['opus', 'sonnet', 'haiku'])
    const sonnet = await adapter.resolveModel('claude-code-local', 'sonnet')
    expect(sonnet.reasoning?.efforts.map(effort => effort.id)).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
    expect(sonnet.reasoning?.defaultEffort).toBeUndefined()
  })
})

const event = (value: Record<string, unknown>) => ({ type: 'stream_event', event: value, parent_tool_use_id: null })
const success = (extra: Record<string, unknown> = {}) => ({
  type: 'result',
  subtype: 'success',
  is_error: false,
  result: 'Olá mundo',
  stop_reason: 'end_turn',
  usage: { input_tokens: 10, output_tokens: 4, cache_read_input_tokens: 3, cache_creation_input_tokens: 2 },
  ...extra,
})

describe('ClaudeCodeAdapter streaming', () => {
  it('streams thinking and text deltas, then usage and stop, and nothing after', async () => {
    const { adapter } = harness()
    scriptQuery([
      { type: 'system', subtype: 'init', apiKeySource: 'none' },
      event({ type: 'message_start', message: {} }),
      event({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } }),
      event({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'pensando' } }),
      event({ type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig' } }),
      event({ type: 'content_block_stop', index: 0 }),
      event({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }),
      event({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Olá' } }),
      event({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: ' mundo' } }),
      event({ type: 'content_block_stop', index: 1 }),
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Olá mundo' }] } },
      event({ type: 'message_stop' }),
      success(),
      { type: 'system', subtype: 'session_state_changed' },
    ])

    expect(await collect(adapter, request())).toEqual([
      { type: 'block-start', index: 0, blockType: 'reasoning' },
      { type: 'reasoning-delta', index: 0, text: 'pensando' },
      { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'pensando' } },
      { type: 'block-start', index: 1, blockType: 'text' },
      { type: 'text-delta', index: 1, text: 'Olá' },
      { type: 'text-delta', index: 1, text: ' mundo' },
      { type: 'block-end', index: 1, block: { type: 'text', text: 'Olá mundo' } },
      { type: 'usage', usage: { inputTokens: 10, outputTokens: 4, cacheReadTokens: 3, cacheWriteTokens: 2 } },
      { type: 'finish', reason: { kind: 'stop' } },
    ])
  })

  it('omits a thinking block whose content the CLI does not reveal', async () => {
    const { adapter } = harness()
    scriptQuery([
      event({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } }),
      event({ type: 'content_block_stop', index: 0 }),
      event({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }),
      event({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'ok' } }),
      event({ type: 'content_block_stop', index: 1 }),
      success({ result: 'ok' }),
    ])

    const chunks = await collect(adapter, request())
    expect(chunks.filter(chunk => chunk.type === 'block-start')).toEqual([{ type: 'block-start', index: 0, blockType: 'text' }])
  })
})

async function firstPrompt(fake: FakeQuery | undefined): Promise<SDKUserMessage | undefined> {
  if (fake === undefined) return undefined
  for await (const message of fake.prompt) return message
  return undefined
}

describe('ClaudeCodeAdapter query isolation', () => {
  it('opens a text-only, non-persistent query without host settings, MCP servers, or tools', async () => {
    const { adapter, specs } = harness()
    const queries = scriptQuery([success()])
    await collect(adapter, request({ model: 'opus', reasoningEffort: ReasoningEffortId('high') }))

    expect(queries).toHaveLength(1)
    const options = queries[0]?.options
    expect(options).toMatchObject({
      model: 'opus',
      effort: 'high',
      tools: [],
      mcpServers: {},
      strictMcpConfig: true,
      settingSources: [],
      persistSession: false,
      includePartialMessages: true,
      cwd: process.cwd(),
    })
    expect(specs).toHaveLength(1)
    const decision = await options?.canUseTool?.('Bash', {}, { signal: new AbortController().signal, toolUseID: 't' } as never)
    expect(decision?.behavior).toBe('deny')
  })

  it('keeps credentials and Claude, Anthropic, MCP, and harness variables out of the CLI environment', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-secret')
    vi.stubEnv('ANTHROPIC_BASE_URL', 'https://desvio.example')
    vi.stubEnv('CLAUDE_CODE_X', '1')
    vi.stubEnv('MCP_X', '1')
    vi.stubEnv('DSH_X', '1')
    vi.stubEnv('TORANJA_KEEP', 'mantida')
    const { adapter } = harness()
    const queries = scriptQuery([success()])
    await collect(adapter, request())

    const env = queries[0]?.options.env ?? {}
    for (const removed of ['ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_X', 'MCP_X', 'DSH_X']) {
      expect(env).not.toHaveProperty(removed)
    }
    expect(env.TORANJA_KEEP).toBe('mantida')
  })

  it('sends system messages as its own system prompt and a lone user message as the prompt', async () => {
    const { adapter } = harness()
    const queries = scriptQuery([success()])
    await collect(adapter, request({
      messages: [
        { role: 'system', content: [{ type: 'text', text: 'Seja breve.' }] },
        { role: 'user', content: [{ type: 'text', text: 'Qual é a capital?' }] },
      ] as GenerateOptions['messages'],
    }))

    expect(queries[0]?.options.systemPrompt).toBe('Seja breve.')
    expect((await firstPrompt(queries[0]))?.message).toEqual({ role: 'user', content: 'Qual é a capital?' })
  })

  it('sends a longer conversation as a labeled transcript', async () => {
    const { adapter } = harness()
    const queries = scriptQuery([success()])
    await collect(adapter, request({
      system: 'Título curto.',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'oi' }] },
        { role: 'assistant', content: [{ type: 'reasoning', text: 'oculto' }, { type: 'text', text: 'olá' }] },
        { role: 'user', content: [{ type: 'text', text: 'resuma' }] },
      ] as GenerateOptions['messages'],
      purpose: 'session-title',
    }))

    expect(queries[0]?.options.systemPrompt).toBe('Título curto.')
    expect((await firstPrompt(queries[0]))?.message.content).toBe('USUÁRIO:\noi\n\nASSISTENTE:\nolá\n\nUSUÁRIO:\nresuma')
  })
})

const apiError = (error: string) => ({
  type: 'assistant',
  error,
  message: { content: [{ type: 'text', text: 'API Error: token sk-ant-secret' }] },
  parent_tool_use_id: null,
})
const failedTurn = (result = 'API Error: sk-ant-secret') => success({ is_error: true, result })

async function finishOf(adapter: LlmAdapter, options = request()): Promise<StreamChunk> {
  const chunks = await collect(adapter, options)
  const last = chunks.at(-1)
  expect(last?.type).toBe('finish')
  expect(chunks.filter(chunk => chunk.type === 'finish')).toHaveLength(1)
  if (last === undefined) throw new Error('empty stream')
  return last
}

function failureOf(chunk: StreamChunk): { code: string; message: string } {
  if (chunk.type !== 'finish' || chunk.reason.kind !== 'error') throw new Error(`not an error finish: ${JSON.stringify(chunk)}`)
  return chunk.reason.failure
}

describe('ClaudeCodeAdapter failures', () => {
  it.each([
    ['authentication_failed', [apiError('authentication_failed'), failedTurn()], 'AUTH'],
    ['rate_limit', [apiError('rate_limit'), failedTurn()], 'RATE_LIMIT'],
    ['billing_error', [apiError('billing_error'), failedTurn()], 'QUOTA'],
    ['rejected subscription limit', [
      { type: 'rate_limit_event', rate_limit_info: { status: 'rejected', rateLimitType: 'five_hour' } },
      apiError('rate_limit'),
      failedTurn(),
    ], 'QUOTA'],
    ['auth_status error', [{ type: 'auth_status', isAuthenticating: false, output: [], error: 'sk-ant-secret' }], 'AUTH'],
    ['context overflow', [failedTurn('Prompt is too long for the model context window')], 'CONTEXT_WINDOW_EXCEEDED'],
  ] as const)('maps %s to its failure code without echoing secrets', async (_label, script, code) => {
    const { adapter } = harness()
    scriptQuery(script, 'hang')
    const failure = failureOf(await finishOf(adapter))
    expect(failure.code).toBe(code)
    expect(failure.message).not.toContain('sk-ant')
  })

  it('ignores a non-rejected rate limit report', async () => {
    const { adapter } = harness()
    scriptQuery([{ type: 'rate_limit_event', rate_limit_info: { status: 'allowed_warning' } }, success()])
    expect(await finishOf(adapter)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
  })

  it('reports an error result subtype with its errors', async () => {
    const { adapter } = harness()
    scriptQuery([{ type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['falha interna'], usage: {} }])
    const failure = failureOf(await finishOf(adapter))
    expect(failure.code).toBe('CLAUDE_CODE_ERROR')
    expect(failure.message).toContain('error_during_execution')
    expect(failure.message).toContain('falha interna')
  })

  it('reports a process that ends before a result with its exit code and without the thrown text', async () => {
    const { adapter } = harness()
    scriptQuery([], new Error('stderr: sk-ant-secret'), { exitCode: 1, signal: null })
    const failure = failureOf(await finishOf(adapter))
    expect(failure.code).toBe('CLAUDE_CODE_ERROR')
    expect(failure.message).toContain('exit code: 1')
    expect(failure.message).not.toContain('sk-ant')
  })

  it('reports an empty successful turn as an empty response', async () => {
    const { adapter } = harness()
    scriptQuery([success({ result: '' })])
    expect(failureOf(await finishOf(adapter)).code).toBe('EMPTY_RESPONSE')
  })

  it('reports a turn cut by the output limit as max-tokens', async () => {
    const { adapter } = harness()
    scriptQuery([
      event({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
      event({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'parcial' } }),
      event({ type: 'content_block_stop', index: 0 }),
      success({ stop_reason: 'max_tokens' }),
    ])
    expect(await finishOf(adapter)).toEqual({ type: 'finish', reason: { kind: 'max-tokens' } })
  })
})

describe('ClaudeCodeAdapter login and lifecycle', () => {
  it.each(['signed-out', 'not-installed'])('fails with AUTH without opening the CLI when the orchestrator reports %s', async (connection) => {
    const { adapter, specs } = harness(orchestrator(connection))
    scriptQuery([success()])
    const failure = failureOf(await finishOf(adapter))
    expect(failure).toEqual({ code: 'AUTH', message: 'Conecte o Claude Code em Configurações → Orquestrador (claude auth login).' })
    expect(sdk.query).not.toHaveBeenCalled()
    expect(specs).toHaveLength(0)
  })

  it.each([['an unknown connection', orchestrator('unknown')], ['no orchestrator', {}]] as const)('opens the CLI with %s', async (_label, services) => {
    const { adapter, specs } = harness(services)
    scriptQuery([success()])
    expect(await finishOf(adapter)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
    expect(specs).toHaveLength(1)
  })

  it('runs in the working directory of the requesting session', async () => {
    const session = { id: 's1' }
    const { adapter } = harness({
      sessions: { get: (id: string) => id === 's1' ? session : undefined },
      workingDirectory: { get: (value: unknown) => value === session ? 'C:/projeto' : 'C:/outro' },
    })
    const queries = scriptQuery([success()])
    await collect(adapter, request({ sessionId: 's1' as SessionId }))
    expect(queries[0]?.options.cwd).toBe('C:/projeto')
  })

  it('interrupts and then closes the query on abort and finishes as aborted', async () => {
    const { adapter } = harness()
    const controller = new AbortController()
    const queries = scriptQuery([
      event({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
      event({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'parc' } }),
    ], 'hang')
    const chunks: StreamChunk[] = []
    for await (const chunk of adapter.stream(request({ signal: controller.signal }))) {
      chunks.push(chunk)
      if (chunk.type === 'text-delta') controller.abort()
    }
    const fake = queries[0]
    expect(fake?.interrupt).toHaveBeenCalledOnce()
    expect(fake?.close).toHaveBeenCalled()
    expect(fake?.interrupt.mock.invocationCallOrder[0]).toBeLessThan(fake?.close.mock.invocationCallOrder[0] ?? 0)
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'aborted' } })
    expect(chunks.filter(chunk => chunk.type === 'finish')).toHaveLength(1)
  })

  it('finishes as aborted without opening the CLI when the signal is already aborted', async () => {
    const { adapter, specs } = harness()
    scriptQuery([success()])
    const controller = new AbortController()
    controller.abort()
    expect(await finishOf(adapter, request({ signal: controller.signal }))).toMatchObject({ reason: { kind: 'aborted' } })
    expect(specs).toHaveLength(0)
  })

  it('closes open queries when the plugin is disposed', async () => {
    const { adapter, dispose } = harness()
    const queries = scriptQuery([], 'hang')
    const pending = collect(adapter, request())
    await vi.waitFor(() => { expect(queries).toHaveLength(1) })
    dispose()
    await pending
    expect(queries[0]?.close).toHaveBeenCalled()
  })
})

interface SessionTurn {
  readonly script: Script
  /** `hang` waits for interrupt (then yields an error result) or close; `die` kills the process and throws. */
  readonly then?: 'hang' | 'die'
}

interface FakeSession extends FakeQuery {
  readonly received: string[]
}

/** Drive the mocked SDK as a live CLI: every queued user message runs the next scripted turn. */
function sessionQuery(turns: SessionTurn[]): FakeSession[] {
  const fakes: FakeSession[] = []
  sdk.query.mockImplementation(({ prompt, options }: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => {
    let wake: () => void = () => undefined
    let interrupted = false
    let closed = false
    const fake: FakeSession = {
      options,
      prompt,
      received: [],
      interrupt: vi.fn(() => {
        interrupted = true
        wake()
        return Promise.resolve(undefined)
      }),
      close: vi.fn(() => {
        closed = true
        wake()
      }),
    }
    fakes.push(fake)
    const child = options.spawnClaudeCodeProcess?.({
      command: 'claude',
      args: [],
      ...options.cwd === undefined ? {} : { cwd: options.cwd },
      env: options.env ?? {},
      signal: new AbortController().signal,
    })
    async function* messages() {
      for await (const message of prompt) {
        if (closed) return
        fake.received.push(message.message.content as string)
        const turn: SessionTurn = turns.shift() ?? { script: [success()] }
        interrupted = false
        for (const scripted of turn.script) yield scripted
        if (turn.then === 'die') {
          child?.kill('SIGTERM')
          throw new Error('stderr: sk-ant-secret')
        }
        if (turn.then === 'hang') {
          await new Promise<void>((resolve) => {
            wake = resolve
            if (interrupted || closed) resolve()
          })
          if (closed) return
          yield { type: 'result', subtype: 'error_during_execution', is_error: true, errors: [], usage: {} }
        }
      }
    }
    return Object.assign(messages(), { interrupt: fake.interrupt, close: fake.close })
  })
  return fakes
}

const user = (text: string) => ({ role: 'user', content: [{ type: 'text', text }] })
const assistant = (text: string) => ({ role: 'assistant', content: [{ type: 'reasoning', text: 'oculto' }, { type: 'text', text }] })
const reply = (text: string) => [
  event({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
  event({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }),
  event({ type: 'content_block_stop', index: 0 }),
  success({ result: text }),
]

function conversation(history: readonly Record<string, unknown>[], overrides: Partial<GenerateOptions> = {}): GenerateOptions {
  return request({ sessionId: 's1' as SessionId, messages: history as unknown as GenerateOptions['messages'], ...overrides })
}

const transcriptOfSecondTurn = 'USUÁRIO:\noi\n\nASSISTENTE:\nOlá\n\nUSUÁRIO:\nmais'
const STOP_FINISH = { type: 'finish', reason: { kind: 'stop' } }

describe('ClaudeCodeAdapter live session', () => {
  it('runs the second turn of a conversation on the same query, sending only the new user message', async () => {
    const { adapter } = harness()
    const fakes = sessionQuery([{ script: reply('Olá') }, { script: reply('Tudo bem') }])
    expect(await finishOf(adapter, conversation([user('oi')]))).toEqual(STOP_FINISH)
    const second = await collect(adapter, conversation([user('oi'), assistant('Olá'), user('como vai?')]))

    expect(sdk.query).toHaveBeenCalledOnce()
    expect(fakes[0]?.received).toEqual(['oi', 'como vai?'])
    expect(second.filter(chunk => chunk.type === 'text-delta')).toEqual([{ type: 'text-delta', index: 0, text: 'Tudo bem' }])
    expect(second.at(-1)).toEqual(STOP_FINISH)
    expect(fakes[0]?.close).not.toHaveBeenCalled()
  })

  it.each([
    ['model', { model: 'sonnet' }],
    ['effort', { reasoningEffort: ReasoningEffortId('high') }],
    ['system prompt', { system: 'Outra instrução.' }],
  ] as const)('reopens the query with a transcript when the %s changes', async (_label, change) => {
    const { adapter } = harness()
    const fakes = sessionQuery([{ script: reply('Olá') }, { script: reply('ok') }])
    await collect(adapter, conversation([user('oi')]))
    await collect(adapter, conversation([user('oi'), assistant('Olá'), user('mais')], change))

    expect(sdk.query).toHaveBeenCalledTimes(2)
    expect(fakes[0]?.close).toHaveBeenCalled()
    expect(fakes[1]?.received).toEqual([transcriptOfSecondTurn])
  })

  it('reopens the query when the working directory of the session changes', async () => {
    let directory = 'C:/a'
    const session = { id: 's1' }
    const { adapter } = harness({ sessions: { get: () => session }, workingDirectory: { get: () => directory } })
    const fakes = sessionQuery([{ script: reply('Olá') }, { script: reply('ok') }])
    await collect(adapter, conversation([user('oi')]))
    directory = 'C:/b'
    await collect(adapter, conversation([user('oi'), assistant('Olá'), user('mais')]))

    expect(fakes.map(fake => fake.options.cwd)).toEqual(['C:/a', 'C:/b'])
  })

  it.each([
    ['an earlier message was edited', [user('oi editado'), assistant('Olá'), user('mais')]],
    ['the recorded reply differs', [user('oi'), assistant('Outra resposta'), user('mais')]],
    ['earlier messages were removed', [user('mais')]],
    ['the new message is not from the user', [user('oi'), assistant('Olá'), assistant('extra')]],
  ] as const)('reopens the query when %s', async (_label, history) => {
    const { adapter } = harness()
    sessionQuery([{ script: reply('Olá') }, { script: reply('ok') }])
    await collect(adapter, conversation([user('oi')]))
    await collect(adapter, conversation(history))
    expect(sdk.query).toHaveBeenCalledTimes(2)
  })

  it.each(['compaction', 'session-title'] as const)('keeps a %s call on its own disposable query', async (purpose) => {
    const { adapter } = harness()
    const fakes = sessionQuery([{ script: reply('Olá') }, { script: reply('resumo') }, { script: reply('ok') }])
    await collect(adapter, conversation([user('oi')]))
    await collect(adapter, conversation([user('oi'), assistant('Olá'), user('resuma')], { purpose }))
    expect(fakes[1]?.close).toHaveBeenCalled()
    await collect(adapter, conversation([user('oi'), assistant('Olá'), user('mais')]))

    expect(sdk.query).toHaveBeenCalledTimes(2)
    expect(fakes[0]?.received).toEqual(['oi', 'mais'])
  })

  it('makes a concurrent turn of the same conversation wait for the running one', async () => {
    const { adapter } = harness()
    const fakes = sessionQuery([{ script: reply('Olá') }, { script: reply('ok') }])
    const finishes = await Promise.all([
      finishOf(adapter, conversation([user('oi')])),
      finishOf(adapter, conversation([user('oi'), assistant('Olá'), user('mais')])),
    ])

    expect(finishes).toEqual([STOP_FINISH, STOP_FINISH])
    expect(sdk.query).toHaveBeenCalledOnce()
    expect(fakes[0]?.received).toEqual(['oi', 'mais'])
  })

  it('interrupts an aborted turn without closing the query and runs the next turn on it', async () => {
    const { adapter } = harness()
    const fakes = sessionQuery([{ script: reply('parcial').slice(0, 2), then: 'hang' }, { script: reply('ok') }])
    const controller = new AbortController()
    const chunks: StreamChunk[] = []
    for await (const chunk of adapter.stream(conversation([user('oi')], { signal: controller.signal }))) {
      chunks.push(chunk)
      if (chunk.type === 'text-delta') controller.abort()
    }
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'aborted' } })
    expect(fakes[0]?.interrupt).toHaveBeenCalledOnce()

    expect(await finishOf(adapter, conversation([user('oi'), assistant('parcial'), user('continue')]))).toEqual(STOP_FINISH)
    expect(sdk.query).toHaveBeenCalledOnce()
    expect(fakes[0]?.received).toEqual(['oi', 'continue'])
    expect(fakes[0]?.close).not.toHaveBeenCalled()
  })

  it('reports a process that dies mid-turn and reopens the next turn with a transcript', async () => {
    const { adapter } = harness()
    const fakes = sessionQuery([{ script: reply('Olá') }, { script: [], then: 'die' }, { script: reply('ok') }])
    await collect(adapter, conversation([user('oi')]))
    const failure = failureOf(await finishOf(adapter, conversation([user('oi'), assistant('Olá'), user('mais')])))
    expect(failure.code).toBe('CLAUDE_CODE_ERROR')
    expect(failure.message).not.toContain('sk-ant')
    await collect(adapter, conversation([user('oi'), assistant('Olá'), user('mais')]))

    expect(sdk.query).toHaveBeenCalledTimes(2)
    expect(fakes[0]?.close).toHaveBeenCalled()
    expect(fakes[1]?.received).toEqual([transcriptOfSecondTurn])
  })

  it('closes the session after a failed turn and reopens on the next one', async () => {
    const { adapter } = harness()
    const fakes = sessionQuery([{ script: [apiError('rate_limit'), failedTurn()] }, { script: reply('ok') }])
    expect(failureOf(await finishOf(adapter, conversation([user('oi')]))).code).toBe('RATE_LIMIT')
    await collect(adapter, conversation([user('oi')]))
    expect(sdk.query).toHaveBeenCalledTimes(2)
    expect(fakes[0]?.close).toHaveBeenCalled()
  })

  it('closes an idle session after ten minutes', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const { adapter } = harness()
      const fakes = sessionQuery([{ script: reply('Olá') }])
      await collect(adapter, conversation([user('oi')]))
      vi.advanceTimersByTime(10 * 60_000 - 1)
      expect(fakes[0]?.close).not.toHaveBeenCalled()
      vi.advanceTimersByTime(1)
      expect(fakes[0]?.close).toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('closes a live session when the plugin is disposed', async () => {
    const { adapter, dispose } = harness()
    const fakes = sessionQuery([{ script: reply('Olá') }])
    await collect(adapter, conversation([user('oi')]))
    expect(fakes[0]?.close).not.toHaveBeenCalled()
    dispose()
    expect(fakes[0]?.close).toHaveBeenCalled()
  })
})
