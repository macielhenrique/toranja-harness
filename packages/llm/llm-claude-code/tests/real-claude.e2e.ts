// Real Claude Code CLI over the local login: spends subscription quota, so it skips unless the
// SDK-bundled CLI reports `loggedIn: true`. Run: pnpm exec vitest run --config vitest.e2e.config.ts <this file>
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Query, SDKMessage, SDKSystemMessage } from '@anthropic-ai/claude-agent-sdk'
import { Context } from '@deepseek-ai/cordis'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import LlmRuntime, {
  createAssistantMessage,
  createToolResultMessage,
  type ContentBlock,
  type GenerateOptions,
  type RequestMessage,
  type StreamChunk,
  type ToolSchema,
} from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { scrubbedParentEnv, type SubprocessHandle, type SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'

const observed = vi.hoisted(() => ({ messages: [] as SDKMessage[], queries: 0 }))

// Observe the real SDK stream and count queries without replacing its protocol or CLI.
vi.mock('@anthropic-ai/claude-agent-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@anthropic-ai/claude-agent-sdk')>()
  return {
    ...actual,
    query(params: Parameters<typeof actual.query>[0]): Query {
      observed.queries += 1
      const query = actual.query(params)
      return new Proxy(query, {
        get(target, property) {
          if (property === Symbol.asyncIterator) {
            return async function* (): AsyncGenerator<SDKMessage, void> {
              for await (const message of target) {
                observed.messages.push(message)
                yield message
              }
            }
          }
          const value: unknown = Reflect.get(target, property, target)
          if (typeof value === 'function') return (value as (...args: unknown[]) => unknown).bind(target)
          return value
        },
      })
    },
  }
})

const claudeCode = await import('../src/index.ts')

const sdkRoot = dirname(fileURLToPath(import.meta.resolve('@anthropic-ai/claude-agent-sdk')))
const platformRoot = resolve(sdkRoot, '..', `claude-agent-sdk-${process.platform}-${process.arch}`)
const claudeBin = join(platformRoot, process.platform === 'win32' ? 'claude.exe' : 'claude')
const sdkVersion = (JSON.parse(readFileSync(join(sdkRoot, 'package.json'), 'utf8')) as { claudeCodeVersion: string }).claudeCodeVersion

/** Whether the CLI the SDK launches is signed in; any failure (absent binary, no login) skips the suite. */
function signedIn(): boolean {
  try {
    const status = execFileSync(claudeBin, ['auth', 'status'], { encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'ignore'] })
    return (JSON.parse(status) as { loggedIn?: unknown }).loggedIn === true
  } catch {
    // Not installed, not signed in (non-zero exit), or not JSON: nothing to run against.
    return false
  }
}

/** Running processes of the SDK-bundled CLI, by resolved executable path; the developer's own `claude` is not counted. */
function bundledProcesses(): number {
  const bin = realpathSync(claudeBin).toLowerCase()
  const listing = process.platform === 'win32'
    ? execFileSync('powershell', ['-NoProfile', '-Command', 'Get-CimInstance Win32_Process -Filter "Name=\'claude.exe\'" | ForEach-Object { $_.ExecutablePath }'], { encoding: 'utf8' })
    : execFileSync('ps', ['-axo', 'command='], { encoding: 'utf8' })
  return listing.split(/\r?\n/).filter(line => line.toLowerCase().startsWith(bin)).length
}

const FAKE_ENV: Readonly<Record<string, string>> = {
  ANTHROPIC_API_KEY: 'sk-ant-l5-fake-key',
  ANTHROPIC_BASE_URL: 'http://127.0.0.1:9/l5-fake',
  CLAUDE_CONFIG_DIR: join(tmpdir(), 'dsh-l5-fake-claude-config'),
  CLAUDE_L5_FAKE: 'l5-fake-claude',
  MCP_L5_FAKE: 'l5-fake-mcp',
}

const TOOLS: ToolSchema[] = [
  {
    name: 'add',
    description: 'Soma dois números.',
    parameters: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } }, required: ['a', 'b'] },
  },
  {
    name: 'get_weather',
    description: 'Devolve o tempo atual de uma cidade.',
    parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
  },
]
const SYSTEM = 'Você é um assistente de teste. Responda em português, em no máximo duas frases. Para o tempo de uma cidade, use sempre a ferramenta get_weather; nunca invente o tempo.'
// Fake readings no model could guess, so the final reply must have read the tool result.
const WEATHER: Readonly<Record<string, string>> = { lisboa: 'granizo roxo, 7 graus', recife: 'neve verde, 41 graus' }

const user = (text: string): RequestMessage => ({ role: 'user', content: [{ type: 'text', text }] })
const textOf = (chunks: readonly StreamChunk[]): string => chunks.flatMap(chunk => chunk.type === 'text-delta' ? [chunk.text] : []).join('')
const finishOf = (chunks: readonly StreamChunk[]) => chunks.at(-1)
const toolCalls = (chunks: readonly StreamChunk[]) => chunks.flatMap(chunk => chunk.type === 'block-end' && chunk.block.type === 'tool-call' ? [chunk.block] : [])
const resultsSince = (start: number) => observed.messages.slice(start).flatMap(message => message.type === 'result' ? [message] : [])
const reply = (content: readonly ContentBlock[]) => createAssistantMessage({ content, source: { provider: 'claude-code-local', model: 'haiku' } })
const blocksOf = (chunks: readonly StreamChunk[]): ContentBlock[] => chunks.flatMap(chunk => chunk.type === 'block-end' ? [chunk.block] : [])

describe.skipIf(!signedIn())(`real Claude Code ${sdkVersion} as the claude-code-local leader`, { timeout: 120_000, retry: 0 }, () => {
  const ctx = new Context()
  const handles: SubprocessHandle[] = []
  const specs: SubprocessSpawnSpec[] = []
  const saved = new Map<string, string | undefined>()
  let cwd = ''
  const history: RequestMessage[] = []
  let baseline = 0
  /** Chunks of the first turn, which case 2 reads. */
  const turns: { first?: StreamChunk[] } = {}

  /** One `stream()` of the conversation, bounded so a step that never closes fails instead of hanging. */
  async function turn(signal: AbortSignal = AbortSignal.timeout(60_000), onChunk?: (chunk: StreamChunk) => void): Promise<StreamChunk[]> {
    const options: GenerateOptions = {
      provider: 'claude-code-local',
      model: 'haiku',
      sessionId: 'l5-leader' as SessionId,
      system: SYSTEM,
      messages: history,
      tools: TOOLS,
      signal,
    }
    const chunks: StreamChunk[] = []
    for await (const chunk of ctx.llm.stream(options)) {
      chunks.push(chunk)
      onChunk?.(chunk)
    }
    return chunks
  }

  beforeAll(async () => {
    cwd = mkdtempSync(join(tmpdir(), 'dsh-l5-leader-'))
    // A harmless project command (plain text, no shell line): case 1 records whether the CLI loads it.
    mkdirSync(join(cwd, '.claude', 'commands'), { recursive: true })
    writeFileSync(join(cwd, '.claude', 'commands', 'marcador.md'), 'Responda apenas: marcador do projeto.')
    baseline = bundledProcesses()
    for (const [name, value] of Object.entries(FAKE_ENV)) {
      saved.set(name, process.env[name])
      process.env[name] = value
    }
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(LocalSubprocessRuntime)
    const spawn = ctx.subprocess.spawn.bind(ctx.subprocess)
    vi.spyOn(ctx.subprocess, 'spawn').mockImplementation((spec) => {
      specs.push(spec)
      const handle = spawn(spec)
      handles.push(handle)
      return handle
    })
    // The adapter reads the Session's working directory through these two services.
    const session = { id: 'l5-leader' }
    ctx.provide('sessions', { get: () => session } as never)
    ctx.provide('workingDirectory', { get: () => cwd } as never)
    await ctx.plugin(claudeCode)
  })

  afterAll(async () => {
    await ctx.fiber.dispose()
    for (const handle of handles) await handle.waitForExit()
    for (const [name, value] of saved) {
      if (value === undefined) Reflect.deleteProperty(process.env, name)
      else process.env[name] = value
    }
    rmSync(cwd, { recursive: true, force: true })
    // total_cost_usd is cumulative over the query, so the single query costs its last result.
    const costs = observed.messages.flatMap(message => message.type === 'result' ? [message.total_cost_usd] : [])
    console.info(`[L5] queries=${observed.queries} processes=${specs.length} total_cost_usd per result=${JSON.stringify(costs)}`)
  })

  it('1. isolates the CLI: only toranja tools and server, no API key', async () => {
    history.push(user('Conte de um a dez por extenso, separados por vírgula.'))
    const chunks = await turn()
    const init = observed.messages.find((message): message is SDKSystemMessage => message.type === 'system' && message.subtype === 'init')
    expect(init).toBeDefined()
    console.info('[L5] init', JSON.stringify({
      model: init?.model,
      cwd: init?.cwd === cwd,
      tools: init?.tools,
      mcp_servers: init?.mcp_servers,
      apiKeySource: init?.apiKeySource,
      plugins: init?.plugins,
      agents: init?.agents,
      skills: init?.skills,
      slash_commands: init?.slash_commands,
      permissionMode: init?.permissionMode,
    }))
    // Informational: settingSources is empty, so a project command should stay out of the CLI.
    console.info('[L5] project command marcador in init.slash_commands:', init?.slash_commands.includes('marcador') === true)
    expect([...init?.tools ?? []].sort()).toEqual(['mcp__toranja__add', 'mcp__toranja__get_weather'])
    expect(init?.mcp_servers.map(server => server.name)).toEqual(['toranja'])
    expect(init?.apiKeySource).toBe('none')
    expect(init?.cwd).toBe(cwd)
    history.push(reply(blocksOf(chunks)))
    turns.first = chunks
  })


  it('2. streams a text turn in several deltas and ends with usage, then finish stop', () => {
    const chunks = turns.first ?? []
    console.info('[L5] text', JSON.stringify(textOf(chunks)), 'deltas', chunks.filter(chunk => chunk.type === 'text-delta').length)
    expect(chunks.filter(chunk => chunk.type === 'text-delta').length).toBeGreaterThan(1)
    expect(chunks.at(-2)?.type).toBe('usage')
    expect(finishOf(chunks)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
  })

  it('3. relays one get_weather call and uses its result, on one query', async () => {
    const start = observed.messages.length
    history.push(user('Qual é o tempo agora em Lisboa?'))
    const asked = await turn()
    const deltas = observed.messages.slice(start).flatMap(message => message.type === 'stream_event' && message.event.type === 'message_delta' ? [message.event.delta.stop_reason] : [])
    console.info('[L5] tool step finish', JSON.stringify(finishOf(asked)), 'message_delta stop_reasons', JSON.stringify(deltas))
    expect(deltas).toContain('tool_use')
    expect(finishOf(asked)).toEqual({ type: 'finish', reason: { kind: 'tool-calls' } })
    const calls = toolCalls(asked)
    expect(calls.map(call => call.name)).toEqual(['get_weather'])
    expect((JSON.parse(calls[0]?.arguments ?? '{}') as { city?: string }).city?.toLowerCase()).toContain('lisboa')

    history.push(reply(blocksOf(asked)), ...calls.map(call => createToolResultMessage({ callId: call.id, content: [{ type: 'text', text: WEATHER.lisboa ?? '' }], isError: false })))
    const answered = await turn()
    console.info('[L5] tool reply', JSON.stringify(textOf(answered)))
    expect(finishOf(answered)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
    expect(textOf(answered)).toMatch(/granizo|7/i)
    expect(observed.queries).toBe(1)
    expect(specs).toHaveLength(1)
    history.push(reply(blocksOf(answered)))
  })

  it('4. relays two calls of one step and uses both results', async () => {
    history.push(user('Qual é o tempo agora em Lisboa e em Recife? Chame get_weather para as duas cidades na mesma resposta, em paralelo.'))
    const asked = await turn()
    expect(finishOf(asked)).toEqual({ type: 'finish', reason: { kind: 'tool-calls' } })
    const calls = toolCalls(asked)
    const cities = calls.map(call => ((JSON.parse(call.arguments) as { city?: string }).city ?? '').toLowerCase())
    console.info('[L5] two calls', JSON.stringify(calls.map(call => [call.name, call.arguments])))
    expect(calls.map(call => call.name)).toEqual(['get_weather', 'get_weather'])
    expect(cities.some(city => city.includes('lisboa')) && cities.some(city => city.includes('recife'))).toBe(true)

    history.push(reply(blocksOf(asked)), ...calls.map((call, index) => createToolResultMessage({
      callId: call.id,
      content: [{ type: 'text', text: (cities[index]?.includes('recife') === true ? WEATHER.recife : WEATHER.lisboa) ?? '' }],
      isError: false,
    })))
    const answered = await turn()
    console.info('[L5] two-call reply', JSON.stringify(textOf(answered)))
    expect(finishOf(answered)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
    expect(textOf(answered)).toMatch(/granizo/i)
    expect(textOf(answered)).toMatch(/neve/i)
    history.push(reply(blocksOf(answered)))
  })

  it('5. runs a later text turn on the same CLI process', async () => {
    history.push(user('Responda apenas: ok'))
    const chunks = await turn()
    expect(finishOf(chunks)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
    history.push(reply(blocksOf(chunks)))
    expect(observed.queries).toBe(1)
    expect(specs).toHaveLength(1)
    expect(bundledProcesses()).toBe(baseline + 1)
  })

  it('6. aborts a reply mid-stream, then answers the next turn on the same session', async () => {
    const controller = new AbortController()
    let deltas = 0
    history.push(user('Escreva os números de 1 a 300 por extenso, um por linha, sem mais nada.'))
    const cut = await turn(AbortSignal.any([controller.signal, AbortSignal.timeout(60_000)]), (chunk) => {
      if (chunk.type === 'text-delta' && ++deltas === 2) controller.abort()
    })
    expect(controller.signal.aborted).toBe(true)
    expect(finishOf(cut)).toMatchObject({ type: 'finish', reason: { kind: 'aborted' } })
    // What the harness keeps of an interrupted reply: the text it streamed.
    history.push(reply([{ type: 'text', text: textOf(cut) }]))

    history.push(user('Responda apenas: pronto'))
    const next = await turn()
    console.info('[L5] after abort', JSON.stringify(textOf(next)))
    expect(finishOf(next)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
    expect(textOf(next).toLowerCase()).toContain('pronto')
    expect(observed.queries).toBe(1)
    expect(specs).toHaveLength(1)
    history.push(reply(blocksOf(next)))
  })

  it('7. keeps the fake Anthropic, Claude, and MCP variables out of the CLI environment', () => {
    const spec = specs[0]
    expect(spec).toBeDefined()
    // What the local runtime hands the child: the scrubbed parent environment under the spec overlay.
    const overlaid = Object.entries({ ...scrubbedParentEnv(), ...spec?.env })
    const effective = Object.fromEntries(overlaid.filter(([, value]) => value !== undefined))
    const leaked = Object.keys(FAKE_ENV).filter(name => name in effective)
    const fakeValues = new Set(Object.values(FAKE_ENV))
    console.info('[L5] CLAUDE/ANTHROPIC/MCP names in the child env', JSON.stringify(Object.keys(effective).filter(name => /^(?:CLAUDE|ANTHROPIC|MCP_)/i.test(name))))
    expect(leaked).toEqual([])
    expect(Object.values(effective).filter(value => fakeValues.has(value ?? ''))).toEqual([])
    // The login still worked although a fake key, base URL, and config directory were in the parent environment.
    const init = observed.messages.find((message): message is SDKSystemMessage => message.type === 'system' && message.subtype === 'init')
    expect(init?.apiKeySource).toBe('none')
  })

  // The CLI runs user text that starts with '/' as its own slash command; the adapter labels it so the model answers.
  it('8. sends text starting with "/" to the model instead of running a built-in command', async () => {
    const start = observed.messages.length
    history.push(user('/help'))
    const chunks = await turn()
    const seen = observed.messages.slice(start)
    console.info('[L5] /help', JSON.stringify({
      finish: finishOf(chunks),
      text: textOf(chunks),
      types: seen.map(message => message.type === 'stream_event' ? `stream_event:${message.event.type}` : `${message.type}${'subtype' in message ? `:${message.subtype}` : ''}`),
      result: resultsSince(start).map(result => ({ num_turns: result.num_turns, cost: result.total_cost_usd })),
    }))
    // A model reply streams message_start; a local slash command answers without calling the model.
    expect(seen.some(message => message.type === 'stream_event' && message.event.type === 'message_start')).toBe(true)
    expect(finishOf(chunks)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
    expect(textOf(chunks)).not.toContain("isn't available in this environment")
    expect(observed.queries).toBe(1)
    history.push(reply(blocksOf(chunks)))
  })

  // Informational: whether the model sees the skills, agents, or commands the CLI lists from the user profile.
  it('9. records which profile skills, agents, or commands the model says it has', async () => {
    history.push(user('Sem usar ferramentas, liste os nomes exatos de todas as skills, agentes (subagents) e comandos de barra que você tem disponíveis nesta sessão. Se não tiver nenhum, responda apenas: nenhum.'))
    const chunks = await turn()
    expect(finishOf(chunks)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
    history.push(reply(blocksOf(chunks)))
    const init = observed.messages.find((message): message is SDKSystemMessage => message.type === 'system' && message.subtype === 'init')
    const text = textOf(chunks).toLowerCase()
    const listed = [...init?.skills ?? [], ...init?.agents ?? [], 'dataviz', 'design-sync', 'code-review', 'simplify', 'loop', 'schedule']
    console.info('[L5] model on its skills/agents/commands', JSON.stringify({ reply: textOf(chunks), named: [...new Set(listed.filter(name => text.includes(name.toLowerCase())))] }))
  })

  it('leaves no CLI process running after disposal', async () => {
    await ctx.fiber.dispose()
    for (const handle of handles) await expect(handle.waitForExit()).resolves.toBe(true)
    expect(bundledProcesses()).toBe(baseline)
  })
})
