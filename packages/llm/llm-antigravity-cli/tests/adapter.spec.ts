import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { GenerateOptions, LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { SubprocessHandle, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { apply } from '../src/index.ts'

function fixture(): { adapter: LlmAdapter; specs: SubprocessSpawnSpec[] } {
  const specs: SubprocessSpawnSpec[] = []
  let adapter: LlmAdapter | undefined
  const subprocess = {
    spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
      specs.push(spec)
      const stdin = new PassThrough()
      const stdout = new PassThrough()
      const stderr = new PassThrough()
      stdin.on('data', () => {
        stdout.write(`${JSON.stringify({
          event: 'result',
          result: {
            status: 'SUCCESS',
            response: JSON.stringify({ kind: 'answer', text: 'modelo selecionado' }),
            usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
          },
        })}\n`)
      })
      return {
        stdin,
        stdout,
        stderr,
        done: new Promise(() => undefined),
        terminate: () => undefined,
        waitForExit: () => Promise.resolve(true),
      } as unknown as SubprocessHandle
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
    sessions: { get: () => undefined },
    subprocess,
    toranjaOrchestrator: {
      status: () => ({ mode: 'antigravity' }),
      lanes: () => [],
    },
    workingDirectory: { get: () => process.cwd() },
  } as unknown as Context
  apply(ctx, {})
  if (adapter === undefined) throw new Error('O adaptador Antigravity não foi registrado')
  return { adapter, specs }
}

describe('AntigravityCliAdapter', () => {
  it('publishes the local Antigravity model catalog in Portuguese', async () => {
    const { adapter } = fixture()
    const models = await adapter.listModels('antigravity-local')

    expect(models.map(model => model.id)).toEqual(expect.arrayContaining([
      'default',
      'gemini-3.8-flash-low',
      'gemini-3.8-flash-medium',
      'gemini-3.8-flash-high',
      'claude-opus-5-5-medium',
      'claude-sonnet-5-5-medium',
      'gpt-oss-120b-medium',
    ]))
    expect(models.find(model => model.id === 'gemini-3.8-flash-medium')?.name)
      .toBe('Gemini 3.8 Flash (Médio)')
  })

  it('routes the selected catalog id to agy --model', async () => {
    const { adapter, specs } = fixture()
    const request: GenerateOptions = {
      provider: 'antigravity-local',
      model: 'gemini-3.8-flash-medium',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'responda diretamente' }] }],
    }

    for await (const _chunk of adapter.stream(request)) {
      // Consume the complete stream so the one-shot subprocess is closed.
    }

    expect(specs).toHaveLength(1)
    expect(specs[0]?.argv).toEqual(expect.arrayContaining([
      '--model',
      'gemini-3.8-flash-medium',
    ]))
    expect(specs[0]?.argv).not.toContain('--effort')
  })
})
