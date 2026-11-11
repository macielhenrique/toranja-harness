import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { GenerateOptions, LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { SubprocessHandle, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { apply, Config } from '../src/index.ts'

interface Spawned {
  readonly model: string | undefined
  /** Prompts written to this process, in order. */
  readonly prompts: string[]
}

/** Mount the adapter over simulated `agy` processes; `exhausted` names the models that are out of quota. */
function fixture(exhausted: Set<string>, config: Config = {}): { adapter: LlmAdapter; spawned: Spawned[] } {
  const spawned: Spawned[] = []
  let adapter: LlmAdapter | undefined
  const subprocess = {
    spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
      const model = spec.argv[spec.argv.indexOf('--model') + 1]
      const process: Spawned = { model, prompts: [] }
      spawned.push(process)
      const stdin = new PassThrough()
      const stdout = new PassThrough()
      stdin.on('data', (chunk: Buffer) => {
        process.prompts.push(chunk.toString('utf8'))
        const result = model !== undefined && exhausted.has(model)
          ? { status: 'ERROR', error: `RESOURCE_EXHAUSTED: user quota limit exceeded for ${model}` }
          : {
            status: 'SUCCESS',
            response: JSON.stringify({ kind: 'answer', text: `resposta de ${model}` }),
            usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
          }
        stdout.write(`${JSON.stringify({ event: 'result', result })}\n`)
      })
      return {
        stdin,
        stdout,
        stderr: new PassThrough(),
        done: new Promise(() => undefined),
        terminate: () => undefined,
        waitForExit: () => Promise.resolve(true),
      } as never
    },
  }
  const ctx = {
    agents: { get: () => undefined },
    effect: (register: () => (() => void)) => { register() },
    llm: {
      registerAdapter: (_providers: readonly string[], value: LlmAdapter) => {
        adapter = value
        return () => undefined
      },
    },
    logger: { warn: () => undefined },
    sessions: { get: () => undefined },
    subprocess,
    toranjaOrchestrator: { status: () => ({ mode: 'antigravity' }), lanes: () => [] },
    workingDirectory: { get: () => process.cwd() },
  } as never as Context
  apply(ctx, Config(config))
  if (adapter === undefined) throw new Error('O adaptador Antigravity não foi registrado')
  return { adapter, spawned }
}

type Message = GenerateOptions['messages'][number]

const user = (text: string): Message => ({ role: 'user', content: [{ type: 'text', text }] }) as never
const assistant = (text: string): Message => ({
  role: 'assistant',
  content: [{ type: 'text', text }],
  source: { provider: 'antigravity-local' },
}) as never

async function turn(adapter: LlmAdapter, messages: Message[]): Promise<string> {
  let text = ''
  const request = {
    provider: 'antigravity-local',
    model: 'gemini-4-argon-high',
    sessionId: 'session-1',
    messages,
  } as never as GenerateOptions
  for await (const chunk of adapter.stream(request)) {
    if (chunk.type === 'text-delta') text += chunk.text
  }
  return text
}

describe('Antigravity quota fallback across turns', () => {
  it('hands the conversation so far to the fallback model when quota runs out mid-conversation', async () => {
    const exhausted = new Set<string>()
    const { adapter, spawned } = fixture(exhausted)
    const first = await turn(adapter, [user('meu projeto se chama Aurora')])
    expect(first).toBe('resposta de gemini-4-argon-high')

    exhausted.add('gemini-4-argon-high')
    const second = await turn(adapter, [user('meu projeto se chama Aurora'), assistant(first), user('qual é o nome do projeto?')])

    expect(second).toBe('resposta de gemini-3.8-flash-high')
    expect(spawned.map(process => process.model)).toEqual(['gemini-4-argon-high', 'gemini-3.8-flash-high'])
    const handoff = spawned[1]?.prompts.join('') ?? ''
    expect(handoff).toContain('meu projeto se chama Aurora')
    expect(handoff).toContain('resposta de gemini-4-argon-high')
    expect(handoff).toContain('qual é o nome do projeto?')
  })

  it('stays on the fallback model for the following turns instead of retrying the exhausted one', async () => {
    const exhausted = new Set(['gemini-4-argon-high'])
    const { adapter, spawned } = fixture(exhausted)
    const first = await turn(adapter, [user('primeira pergunta')])
    const second = await turn(adapter, [user('primeira pergunta'), assistant(first), user('segunda pergunta')])

    expect(second).toBe('resposta de gemini-3.8-flash-high')
    expect(spawned.map(process => process.model)).toEqual(['gemini-4-argon-high', 'gemini-3.8-flash-high'])
    expect(spawned[1]?.prompts).toHaveLength(2)
  })

  it('returns to the selected model once the retry interval has passed', async () => {
    const exhausted = new Set(['gemini-4-argon-high'])
    const { adapter, spawned } = fixture(exhausted, { quotaFallbackRetryMs: 1 })
    const first = await turn(adapter, [user('primeira pergunta')])
    exhausted.clear()
    await new Promise(resolve => setTimeout(resolve, 5))
    const second = await turn(adapter, [user('primeira pergunta'), assistant(first), user('segunda pergunta')])

    expect(second).toBe('resposta de gemini-4-argon-high')
    expect(spawned.map(process => process.model)).toEqual([
      'gemini-4-argon-high',
      'gemini-3.8-flash-high',
      'gemini-4-argon-high',
    ])
  })
})
