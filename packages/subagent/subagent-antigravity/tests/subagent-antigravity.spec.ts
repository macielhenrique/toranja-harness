import { PassThrough } from 'node:stream'
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import * as antigravity from '../src/index.ts'

interface Provider {
  readonly name: string
  start(request: Record<string, unknown>): Promise<{ result: Promise<unknown>; dispose(): Promise<void> }>
}

async function mount(config: antigravity.Config): Promise<{ provider: Provider; runs: string[][]; ctx: Context }> {
  const ctx = new Context()
  const runs: string[][] = []
  let provider: Provider | undefined
  ctx.provide('subagents', {
    registerProvider: (registered: Provider) => { provider = registered; return () => {} },
  } as never)
  ctx.provide('subprocess', {
    spawn: (spec: { argv: readonly string[] }) => {
      runs.push([...spec.argv])
      const stdout = new PassThrough()
      const stderr = new PassThrough()
      stdout.end(JSON.stringify({ status: 'SUCCESS', response: 'answer' }))
      stderr.end()
      const done = Promise.resolve({ exitCode: 0 })
      return { stdout, stderr, done, terminate: () => {}, waitForExit: () => done }
    },
  } as never)
  await ctx.plugin(antigravity, antigravity.Config(config))
  if (provider === undefined) throw new Error('provider was not registered')
  return { provider, runs, ctx }
}

async function run(provider: Provider): Promise<unknown> {
  const started = await provider.start({
    cwd: process.cwd(),
    prompt: [{ type: 'text', text: 'inspect the project' }],
    signal: new AbortController().signal,
  })
  const result = await started.result
  await started.dispose()
  return result
}

describe('subagent-antigravity', () => {
  it('runs plan mode with slash commands enabled and no tool auto-approval', async () => {
    const { provider, runs, ctx } = await mount({
      providerName: 'antigravity-reader',
      mode: 'plan',
      disableSlashCommands: false,
      model: 'gemini-3.8-flash-low',
      effort: 'low',
    })
    expect(provider.name).toBe('antigravity-reader')
    await expect(run(provider)).resolves.toEqual({ output: [{ type: 'text', text: 'answer' }], stopReason: 'completed' })
    expect(runs).toEqual([[
      'agy', '-p', 'inspect the project',
      '--output-format', 'json',
      '--print-timeout', '600000ms',
      '--mode', 'plan',
      '--sandbox',
      '--model', 'gemini-3.8-flash-low',
      '--effort', 'low',
    ]])
    await ctx.fiber.dispose()
  })

  it('keeps slash commands disabled and auto-approves tools in the sandboxed edit mode', async () => {
    const { provider, runs, ctx } = await mount({ autoApproveTools: true })
    await run(provider)
    expect(runs[0]).toEqual([
      'agy', '-p', 'inspect the project',
      '--output-format', 'json',
      '--print-timeout', '600000ms',
      '--mode', 'accept-edits',
      '--disable-slash-commands',
      '--sandbox',
      '--dangerously-skip-permissions',
    ])
    await ctx.fiber.dispose()
  })

  it('rejects plan mode settings the CLI would ignore or that defeat it', async () => {
    await expect(mount({ mode: 'plan' })).rejects.toThrow('mode=plan requires disableSlashCommands=false')
    await expect(mount({ mode: 'plan', disableSlashCommands: false, autoApproveTools: true }))
      .rejects.toThrow('mode=plan cannot be combined with autoApproveTools')
    await expect(mount({ autoApproveTools: true, sandbox: false })).rejects.toThrow('autoApproveTools requires sandbox=true')
  })
})
