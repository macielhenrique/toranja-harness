import { rmSync } from 'node:fs'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import type { ToolSchema } from '@deepseek-ai/dsh-llm'
import { mount } from '../../../orchestration/toranja-orchestrator/tests/harness.ts'
import { createBridgeServer, createPendingCalls, MAX_INPUT_CHARS, MAX_RESULT_TEXT_CHARS, translateTools, type BridgeCall } from '../src/bridge.ts'

// Spy on the real server factory so the options the bridge passes can be checked.
vi.mock('@anthropic-ai/claude-agent-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@anthropic-ai/claude-agent-sdk')>()
  return { ...actual, createSdkMcpServer: vi.fn(actual.createSdkMcpServer) }
})
const { createSdkMcpServer } = await import('@anthropic-ai/claude-agent-sdk')

/** The tools the orchestrator registers, with the JSON Schema `defineTool` compiles and the harness sends to the model. */
const ORCHESTRATOR_TOOLS = [
  'list_project_lanes',
  'get_orchestration_status',
  'delegate_project_task',
  'run_delivery_gate',
  'submit_project_plan',
  'classify_project_task',
] as const

let schemas: ToolSchema[] = []

beforeAll(async () => {
  const harness = await mount()
  schemas = ORCHESTRATOR_TOOLS.map((name) => {
    const { description, parameters } = harness.tool(name) as unknown as ToolSchema
    return { name, description, parameters }
  })
  // The harness cleanup polls inside a test; a schema read only needs the context and the repository gone.
  await harness.ctx.fiber.dispose()
  rmSync(harness.repo, { recursive: true, force: true })
})

const noHandler = () => () => Promise.resolve({ content: [] })

/** Parse like the MCP server does: the registered raw shape becomes an object schema. */
function accepts(tool: { inputSchema: unknown }, input: unknown): boolean {
  return z.object(tool.inputSchema as z.ZodRawShape).safeParse(input).success
}

const scope = ['src/a.ts']
const CASES: Record<(typeof ORCHESTRATOR_TOOLS)[number], { valid: unknown[]; invalid: [string, unknown][] }> = {
  list_project_lanes: {
    valid: [{}],
    invalid: [['a string', 'x'], ['an array', []], ['null', null]],
  },
  get_orchestration_status: {
    valid: [{}],
    invalid: [['a number', 7], ['an array', [{}]]],
  },
  delegate_project_task: {
    valid: [
      { project: 'p', role: 'implementer', description: 'fix it', task: 'do' },
      { project: 'p', role: 'reader', description: 'look', task: 'do', provider: 'claude-code', writeScope: scope, planId: 'x' },
    ],
    invalid: [
      ['missing task', { project: 'p', role: 'reader', description: 'd' }],
      ['role outside the enum', { project: 'p', role: 'janitor', description: 'd', task: 't' }],
      ['provider outside the enum', { project: 'p', role: 'reader', description: 'd', task: 't', provider: 'gpt' }],
      ['wrong type for project', { project: 5, role: 'reader', description: 'd', task: 't' }],
      ['writeScope as a string', { project: 'p', role: 'reader', description: 'd', task: 't', writeScope: 'src/' }],
      ['writeScope with a number', { project: 'p', role: 'reader', description: 'd', task: 't', writeScope: ['a', 2] }],
    ],
  },
  run_delivery_gate: {
    valid: [
      { project: 'p', implementationSummary: 's', acceptanceCriteria: 'c' },
      { project: 'p', implementationSummary: 's', acceptanceCriteria: 'c', implementationTaskId: 'task-1' },
    ],
    invalid: [
      ['missing acceptanceCriteria', { project: 'p', implementationSummary: 's' }],
      ['wrong type for implementationSummary', { project: 'p', implementationSummary: 5, acceptanceCriteria: 'c' }],
      ['implementationTaskId as an array', { project: 'p', implementationSummary: 's', acceptanceCriteria: 'c', implementationTaskId: ['t'] }],
    ],
  },
  submit_project_plan: {
    valid: [
      { project: 'p', plan: '# Plan', writeScope: scope },
      { project: 'p', plan: '# Plan', writeScope: scope, evidenceTaskIds: ['t1'], level: 'complex' },
    ],
    invalid: [
      ['missing writeScope', { project: 'p', plan: '# Plan' }],
      ['level outside the enum', { project: 'p', plan: '# Plan', writeScope: scope, level: 'huge' }],
      ['evidenceTaskIds as a string', { project: 'p', plan: '# Plan', writeScope: scope, evidenceTaskIds: 't1' }],
      ['plan as an array', { project: 'p', plan: ['# Plan'], writeScope: scope }],
    ],
  },
  classify_project_task: {
    valid: [
      { project: 'p', task: 't', writeScope: scope },
      { project: 'p', task: 't', writeScope: scope, level: 'moderate' },
    ],
    invalid: [
      ['missing project', { task: 't', writeScope: scope }],
      ['level outside the enum', { project: 'p', task: 't', writeScope: scope, level: 'trivial' }],
      ['writeScope with a number', { project: 'p', task: 't', writeScope: [1] }],
      ['task as an object', { project: 'p', task: {}, writeScope: scope }],
    ],
  },
}

describe('translateTools', () => {
  it('translates every orchestrator tool, keeping name and description', () => {
    const { tools, refused } = translateTools(schemas, noHandler)
    expect(refused).toEqual([])
    expect(tools.map(tool => tool.name)).toEqual([...ORCHESTRATOR_TOOLS])
    for (const tool of tools) expect(tool.description).toBe(schemas.find(schema => schema.name === tool.name)?.description)
  })

  describe.each(ORCHESTRATOR_TOOLS)('%s', (name) => {
    const translated = (): { inputSchema: unknown } => {
      const tool = translateTools(schemas, noHandler).tools.find(candidate => candidate.name === name)
      if (tool === undefined) throw new Error(`tool ${name} was not translated`)
      return tool
    }

    it.each(CASES[name].valid.map((input, index) => [index, input] as const))('accepts the valid input #%s', (_index, input) => {
      expect(accepts(translated(), input)).toBe(true)
    })

    it.each(CASES[name].invalid)('rejects %s', (_label, input) => {
      expect(accepts(translated(), input)).toBe(false)
    })
  })

  it('leaves out a tool whose schema does not convert and names it, without throwing', () => {
    const broken: ToolSchema[] = [
      { name: 'dangling_ref', description: 'd', parameters: { type: 'object', properties: { a: { $ref: '#/$defs/missing' } } } },
      { name: 'not_an_object', description: 'd', parameters: { type: 'string' } },
      ...schemas.slice(0, 1),
    ]
    const { tools, refused } = translateTools(broken, noHandler)
    expect(tools.map(tool => tool.name)).toEqual(['list_project_lanes'])
    expect(refused.map(entry => entry.name)).toEqual(['dangling_ref', 'not_an_object'])
    for (const entry of refused) expect(entry.reason).not.toBe('')
  })

  it('names a tool whose handler cannot be built even when the failure is not an Error', () => {
    const { tools, refused } = translateTools(schemas.slice(0, 1), () => { throw 'sem handler' })
    expect(tools).toEqual([])
    expect(refused).toEqual([{ name: 'list_project_lanes', reason: 'sem handler' }])
  })

  it('marks readOnlyHint only for the tools the caller names', () => {
    const { tools } = translateTools(schemas, noHandler, ['list_project_lanes', 'get_orchestration_status'])
    const hints = Object.fromEntries(tools.map(tool => [tool.name, tool.annotations?.readOnlyHint]))
    expect(hints).toEqual({
      list_project_lanes: true,
      get_orchestration_status: true,
      delegate_project_task: undefined,
      run_delivery_gate: undefined,
      submit_project_plan: undefined,
      classify_project_task: undefined,
    })
  })
})

type CallResult = Awaited<ReturnType<ReturnType<ReturnType<typeof createPendingCalls>['handlerFor']>>>

/** The `extra` argument the SDK gives a handler: the tool_use id sits in an undocumented `_meta` key. */
const extra = (id?: string, signal: AbortSignal = new AbortController().signal): unknown => ({
  signal,
  _meta: id === undefined ? {} : { 'claudecode/toolUseId': id },
})

/** Track whether a handler promise settled, after letting queued microtasks run. */
function track(promise: Promise<CallResult>): { settled: () => Promise<boolean>; result: Promise<CallResult> } {
  let done = false
  const result = promise.then((value) => { done = true; return value })
  return { result, settled: async () => { await new Promise(resolve => setImmediate(resolve)); return done } }
}

const text = (result: CallResult): string => (result.content[0] as { text: string }).text

describe('createPendingCalls', () => {
  const setup = () => {
    const seen: BridgeCall[] = []
    const calls = createPendingCalls((call) => { seen.push(call) })
    return { seen, calls, handler: calls.handlerFor('delegate_project_task') }
  }

  it('reports the call with the tool_use id and waits for the harness result', async () => {
    const { seen, calls, handler } = setup()
    const call = track(handler({ project: 'p' }, extra('toolu_1')))
    expect(seen).toEqual([{ id: 'toolu_1', name: 'delegate_project_task', input: { project: 'p' } }])
    expect(await call.settled()).toBe(false)
    expect(calls.resolve('toolu_1', { content: 'delegated' })).toBe(true)
    expect(await call.result).toEqual({ content: [{ type: 'text', text: 'delegated' }] })
    expect(calls.size).toBe(0)
  })

  it('passes isError through to the model', async () => {
    const { calls, handler } = setup()
    const call = handler({}, extra('toolu_1'))
    calls.resolve('toolu_1', { content: 'boom', isError: true })
    expect(await call).toEqual({ content: [{ type: 'text', text: 'boom' }], isError: true })
  })

  it('resolves two calls of the same turn out of order', async () => {
    const { calls, handler } = setup()
    const first = track(handler({ n: 1 }, extra('toolu_1')))
    const second = track(handler({ n: 2 }, extra('toolu_2')))
    expect(calls.resolve('toolu_2', { content: 'two' })).toBe(true)
    expect(await second.settled()).toBe(true)
    expect(await first.settled()).toBe(false)
    expect(text(await second.result)).toBe('two')
    expect(calls.resolve('toolu_1', { content: 'one' })).toBe(true)
    expect(text(await first.result)).toBe('one')
  })

  it('refuses a second resolution of the same id and an unknown id', async () => {
    const { calls, handler } = setup()
    const call = handler({}, extra('toolu_1'))
    expect(calls.resolve('toolu_1', { content: 'a' })).toBe(true)
    await call
    expect(calls.resolve('toolu_1', { content: 'b' })).toBe(false)
    expect(calls.resolve('toolu_unknown', { content: 'c' })).toBe(false)
  })

  it('drops an abandoned call: the late resolve is ignored and returns false', async () => {
    const { calls, handler } = setup()
    const controller = new AbortController()
    const call = track(handler({}, extra('toolu_1', controller.signal)))
    controller.abort()
    expect(await call.settled()).toBe(true)
    expect((await call.result).isError).toBe(true)
    expect(calls.size).toBe(0)
    expect(calls.resolve('toolu_1', { content: 'too late' })).toBe(false)
  })

  it('does not report a call whose signal is already aborted', async () => {
    const { seen, calls, handler } = setup()
    const controller = new AbortController()
    controller.abort()
    expect((await handler({}, extra('toolu_1', controller.signal))).isError).toBe(true)
    expect(seen).toEqual([])
    expect(calls.size).toBe(0)
  })

  it('rejectAll releases every pending call with the reason as an error', async () => {
    const { calls, handler } = setup()
    const first = handler({}, extra('toolu_1'))
    const second = handler({}, extra('toolu_2'))
    calls.rejectAll('o processo do Claude Code morreu')
    for (const result of await Promise.all([first, second])) {
      expect(result.isError).toBe(true)
      expect(text(result)).toContain('o processo do Claude Code morreu')
    }
    expect(calls.size).toBe(0)
    expect(calls.resolve('toolu_1', { content: 'late' })).toBe(false)
  })

  it.each([
    ['without extra', undefined],
    ['without _meta', {}],
    ['without the toolUseId key', { _meta: {} }],
    ['with an empty toolUseId', { _meta: { 'claudecode/toolUseId': '' } }],
    ['with a non-string toolUseId', { _meta: { 'claudecode/toolUseId': 7 } }],
  ])('returns an error to the model for a call %s, without reporting it', async (_label, given) => {
    const { seen, calls, handler } = setup()
    const result = await handler({}, given)
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('toolUseId')
    expect(seen).toEqual([])
    expect(calls.size).toBe(0)
  })

  it('answers a duplicate id with an error and keeps the first call pending', async () => {
    const { seen, calls, handler } = setup()
    const first = track(handler({ n: 1 }, extra('toolu_1')))
    const duplicate = await handler({ n: 2 }, extra('toolu_1'))
    expect(duplicate.isError).toBe(true)
    expect(text(duplicate)).toContain('toolu_1')
    expect(seen).toHaveLength(1)
    expect(await first.settled()).toBe(false)
    expect(calls.resolve('toolu_1', { content: 'ok' })).toBe(true)
    expect(text(await first.result)).toBe('ok')
  })

  it('turns a throwing onCall into an error result and does not keep the call', async () => {
    const calls = createPendingCalls(() => { throw new Error('fila cheia') })
    const result = await calls.handlerFor('t')({}, extra('toolu_1'))
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('fila cheia')
    expect(calls.size).toBe(0)
  })

  it('turns an onCall that throws a non-Error into an error result with its text', async () => {
    const calls = createPendingCalls(() => { throw 'fila cheia' })
    const result = await calls.handlerFor('t')({}, extra('toolu_1'))
    expect(result.isError).toBe(true)
    expect(text(result)).toBe('fila cheia')
    expect(calls.size).toBe(0)
  })

  describe('limits', () => {
    it('keeps a result of exactly the maximum size whole', async () => {
      const { calls, handler } = setup()
      const call = handler({}, extra('toolu_1'))
      const content = 'a'.repeat(MAX_RESULT_TEXT_CHARS)
      calls.resolve('toolu_1', { content })
      expect(text(await call)).toBe(content)
    })

    it('truncates a longer result and warns how much was cut', async () => {
      const { calls, handler } = setup()
      const call = handler({}, extra('toolu_1'))
      calls.resolve('toolu_1', { content: 'a'.repeat(MAX_RESULT_TEXT_CHARS) + 'b'.repeat(500) })
      const result = text(await call)
      expect(result.startsWith('a'.repeat(MAX_RESULT_TEXT_CHARS))).toBe(true)
      expect(result).not.toContain('b')
      expect(result).toContain('truncado')
      expect(result).toContain('500')
      expect(result.length).toBeLessThan(MAX_RESULT_TEXT_CHARS + 200)
    })

    it('does not cut a surrogate pair in half', async () => {
      const { calls, handler } = setup()
      const call = handler({}, extra('toolu_1'))
      calls.resolve('toolu_1', { content: 'a'.repeat(MAX_RESULT_TEXT_CHARS - 1) + '😀' })
      const result = text(await call)
      expect(result.startsWith('a'.repeat(MAX_RESULT_TEXT_CHARS - 1))).toBe(true)
      expect(result).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/u)
    })

    it('rejects arguments above the limit with an error, without reporting the call', async () => {
      const { seen, calls, handler } = setup()
      const result = await handler({ task: 'x'.repeat(MAX_INPUT_CHARS) }, extra('toolu_1'))
      expect(result.isError).toBe(true)
      expect(text(result)).toContain(String(MAX_INPUT_CHARS))
      expect(seen).toEqual([])
      expect(calls.size).toBe(0)
    })

    it('accepts arguments just under the limit', () => {
      const { seen, handler } = setup()
      void handler({ task: 'x'.repeat(MAX_INPUT_CHARS - 20) }, extra('toolu_1'))
      expect(seen).toHaveLength(1)
    })
  })
})

describe('createBridgeServer', () => {
  const build = (timeoutMs = 60_000, tools: readonly ToolSchema[] = schemas) => {
    const seen: BridgeCall[] = []
    const bridge = createBridgeServer({ tools, onCall: (call) => { seen.push(call) }, timeoutMs, readOnlyTools: ['list_project_lanes'] })
    const options = vi.mocked(createSdkMcpServer).mock.lastCall?.[0]
    return { seen, bridge, options }
  }

  it('builds the toranja server with every tool always loaded and the caller timeout', () => {
    const { bridge, options } = build(45_000)
    expect(bridge.server.type).toBe('sdk')
    expect(bridge.server.name).toBe('toranja')
    expect(options).toMatchObject({ name: 'toranja', alwaysLoad: true, timeout: 45_000 })
    expect(options?.tools?.map(tool => tool.name)).toEqual([...ORCHESTRATOR_TOOLS])
    expect(bridge.refused).toEqual([])
  })

  it('raises a timeout below the 1000 ms the SDK honors', () => {
    expect(build(250).options?.timeout).toBe(1000)
    expect(build(-5).options?.timeout).toBe(1000)
  })

  it.each([Number.NaN, Number.POSITIVE_INFINITY])('refuses the timeout %s', (timeoutMs) => {
    expect(() => build(timeoutMs)).toThrow(RangeError)
  })

  it('reports the refused tools and still serves the rest', () => {
    const { bridge, options } = build(5000, [{ name: 'bad', description: 'd', parameters: { type: 'string' } }, ...schemas.slice(0, 1)])
    expect(bridge.refused.map(entry => entry.name)).toEqual(['bad'])
    expect(options?.tools?.map(tool => tool.name)).toEqual(['list_project_lanes'])
  })

  it('wires the handlers to the registry: the call is reported and the harness result reaches the model', async () => {
    const { seen, bridge, options } = build()
    const handler = options?.tools?.find(tool => tool.name === 'classify_project_task')?.handler
    if (handler === undefined) throw new Error('classify_project_task was not served')
    const args = { project: 'p', task: 't', writeScope: scope }
    const call = handler(args, extra('toolu_7'))
    expect(seen).toEqual([{ id: 'toolu_7', name: 'classify_project_task', input: args }])
    expect(bridge.resolve('toolu_7', { content: '{"level":"simple"}' })).toBe(true)
    expect(await call).toEqual({ content: [{ type: 'text', text: '{"level":"simple"}' }] })
    const orphan = handler(args, extra('toolu_8'))
    bridge.rejectAll('encerrado')
    expect(await orphan).toMatchObject({ isError: true })
  })
})
