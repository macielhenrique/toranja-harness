import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { SubprocessHandle, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { AgySession } from '../src/session.ts'

function fakeContext(): { ctx: Context; specs: SubprocessSpawnSpec[] } {
  const specs: SubprocessSpawnSpec[] = []
  const subprocess = {
    spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
      specs.push(spec)
      const stdin = new PassThrough()
      const stdout = new PassThrough()
      const stderr = new PassThrough()
      let inputTokens = 0
      let outputTokens = 0
      let cacheReadTokens = 0
      let buffer = ''
      stdin.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('utf8')
        let newline = buffer.indexOf('\n')
        while (newline >= 0) {
          const line = buffer.slice(0, newline)
          buffer = buffer.slice(newline + 1)
          const request = JSON.parse(line) as { message: { content: string } }
          const text = JSON.stringify({ kind: 'answer', text: `resposta:${request.message.content}` })
          inputTokens += 100
          outputTokens += 10
          cacheReadTokens += 20
          stdout.write(`${JSON.stringify({
            event: 'result',
            result: {
              status: 'SUCCESS',
              response: text,
              usage: {
                input_tokens: inputTokens,
                output_tokens: outputTokens,
                thinking_tokens: outputTokens / 2,
                cache_read_tokens: cacheReadTokens,
                total_tokens: inputTokens + outputTokens,
              },
            },
          })}\n`)
          newline = buffer.indexOf('\n')
        }
      })
      return {
        stdin,
        stdout,
        stderr,
        done: new Promise(() => undefined),
        terminate: () => undefined,
        waitForExit: () => new Promise(() => undefined),
      } as unknown as SubprocessHandle
    },
  }
  return { ctx: { subprocess } as unknown as Context, specs }
}

const config = {
  executable: 'agy-test',
  timeoutMs: 1_000,
  sandbox: true,
  autoApproveTools: true,
  mode: 'accept-edits' as const,
  env: {},
}

describe('AgySession', () => {
  it('uses one continuous NDJSON process and reports per-turn usage deltas', async () => {
    const { ctx, specs } = fakeContext()
    const session = new AgySession('C:\\projeto', ctx, config)

    await expect(session.ask('primeiro')).resolves.toEqual({
      text: JSON.stringify({ kind: 'answer', text: 'resposta:primeiro' }),
      usage: {
        inputTokens: 80,
        outputTokens: 10,
        reasoningTokens: 5,
        cacheReadTokens: 20,
        totalTokens: 110,
      },
    })
    await expect(session.ask('segundo')).resolves.toEqual({
      text: JSON.stringify({ kind: 'answer', text: 'resposta:segundo' }),
      usage: {
        inputTokens: 80,
        outputTokens: 10,
        reasoningTokens: 5,
        cacheReadTokens: 20,
        totalTokens: 110,
      },
    })

    expect(specs).toHaveLength(1)
    expect(specs[0]?.argv).toContain('--input-format')
    expect(specs[0]?.argv).toContain('--output-format')
    expect(specs[0]?.argv).toContain('--json-schema')
    expect(specs[0]?.argv).not.toContain('-p')
    session.close()
  })

  it('forwards the selected Antigravity model to the agy process', () => {
    const { ctx, specs } = fakeContext()
    const session = new AgySession('C:\\projeto', ctx, {
      ...config,
      model: 'gemini-3.8-flash-medium',
    })

    expect(specs[0]?.argv).toEqual(expect.arrayContaining([
      '--model',
      'gemini-3.8-flash-medium',
    ]))
    expect(session.model).toBe('gemini-3.8-flash-medium')
    session.close()
  })
})
