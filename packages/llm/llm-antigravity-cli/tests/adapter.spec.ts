import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { GenerateOptions, LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { SubprocessHandle, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { apply, isQuotaExhaustedError } from '../src/index.ts'

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
    logger: { warn: () => undefined },
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

  it('identifies quota and capacity exhaustion errors', () => {
    expect(isQuotaExhaustedError(new Error('RESOURCE_EXHAUSTED: quota exceeded for model'))).toBe(true)
    expect(isQuotaExhaustedError(new Error('Rate limit 429: insufficient quota'))).toBe(true)
    expect(isQuotaExhaustedError(new Error('Model capacity temporarily unavailable'))).toBe(true)
    expect(isQuotaExhaustedError(new Error('SyntaxError: invalid json'))).toBe(false)
    expect(isQuotaExhaustedError('raw string')).toBe(false)
  })

  it('automatically falls back from Argon to Gemini 3.8 Flash High when quota is exhausted', async () => {
    const specs: SubprocessSpawnSpec[] = []
    let callCount = 0
    let adapter: LlmAdapter | undefined
    const subprocess = {
      spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
        specs.push(spec)
        callCount += 1
        const currentCall = callCount
        const stdin = new PassThrough()
        const stdout = new PassThrough()
        const stderr = new PassThrough()
        stdin.on('data', () => {
          if (currentCall === 1) {
            // First call (Argon) fails with quota error
            stdout.write(`${JSON.stringify({
              event: 'result',
              result: {
                status: 'ERROR',
                error: 'RESOURCE_EXHAUSTED: user quota limit exceeded for gemini-4-argon',
              },
            })}\n`)
          } else {
            // Second call (Flash High fallback) succeeds
            stdout.write(`${JSON.stringify({
              event: 'result',
              result: {
                status: 'SUCCESS',
                response: JSON.stringify({ kind: 'answer', text: 'resposta recuperada no flash high' }),
                usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
              },
            })}\n`)
          }
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
      logger: { warn: () => undefined },
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

    const request: GenerateOptions = {
      provider: 'antigravity-local',
      model: 'gemini-4-argon-high',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'gere um plano complexo' }] }],
    }

    const chunks = []
    for await (const chunk of adapter.stream(request)) {
      chunks.push(chunk)
    }

    // Expect 2 subprocess spawns: first for Argon, second fallback for Flash High
    expect(specs).toHaveLength(2)
    expect(specs[0]?.argv).toEqual(expect.arrayContaining(['--model', 'gemini-4-argon-high']))
    expect(specs[1]?.argv).toEqual(expect.arrayContaining(['--model', 'gemini-3.8-flash-high', '--effort', 'high']))
    expect(chunks.some(c => c.type === 'text-delta' && c.text.includes('resposta recuperada no flash high'))).toBe(true)
  })
})
