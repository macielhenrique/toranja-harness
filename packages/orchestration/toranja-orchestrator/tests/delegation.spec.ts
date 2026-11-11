import { execFileSync, spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { afterEach, describe, expect, it } from 'vitest'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import * as orchestrator from '../src/index.ts'
import type { ToranjaOrchestrationStatus } from '../src/index.ts'

interface RegisteredProvider {
  readonly name: string
  start(request: Record<string, unknown>): Promise<{ result: Promise<unknown>; dispose(): Promise<void> }>
}

interface Tool {
  readonly name: string
  execute(args: Record<string, unknown>, exec: { agent: unknown; signal: AbortSignal }): Promise<string>
}

interface Harness {
  readonly ctx: Context
  readonly repo: string
  readonly agyRuns: string[][]
  readonly started: string[]
  /** Prompt text of every started run, in start order. */
  readonly prompts: string[]
  readonly tool: (name: string) => Tool
  readonly status: () => ToranjaOrchestrationStatus
  readonly setMode: (request: Record<string, unknown>) => Promise<ToranjaOrchestrationStatus>
  /** Side effect each simulated agent performs in the project directory. */
  agentSideEffect: (cwd: string) => void
  /** Text every simulated agent answers with. */
  answer: string
  /** When set, simulated non-Antigravity agents settle only after it resolves. */
  hold: Promise<undefined> | undefined
  /** Providers whose start is refused, with the error they report. */
  readonly offline: Map<string, string>
  /** Providers whose run settles as failed, with the diagnostic they report. */
  readonly failing: Map<string, string>
}

const repos: string[] = []
const contexts: Context[] = []
const mounted: Context[] = []

function gitRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), 'toranja-lane-'))
  repos.push(repo)
  const git = (...args: string[]): void => {
    execFileSync('git', ['-c', 'user.email=t@example.test', '-c', 'user.name=t', ...args], { cwd: repo, stdio: 'ignore' })
  }
  git('init', '-q')
  writeFileSync(join(repo, '.gitignore'), '.env' + String.fromCharCode(10))
  writeFileSync(join(repo, 'tracked.txt'), 'original\n')
  git('add', '.')
  git('commit', '-q', '-m', 'init')
  return repo
}

/**
 * Mount the orchestrator over simulated providers. Passing the `disk` of an
 * earlier mount simulates an application restart over the same stored state.
 */
async function mount(
  config: orchestrator.Config = {},
  registered = ['codex', 'antigravity'],
  disk = new MemoryMediaPool(),
): Promise<Harness> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(Storage)
  ctx.storage.backend.register('memory', new MemoryStorageBackend(disk))
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility)
  const repo = gitRepo()
  const providers = new Map<string, RegisteredProvider>()
  const tools = new Map<string, Tool>()
  const harness: Harness = {
    ctx,
    repo,
    agyRuns: [],
    started: [],
    prompts: [],
    tool: (name) => {
      const tool = tools.get(name)
      if (tool === undefined) throw new Error(`missing tool ${name}`)
      return tool
    },
    status: () => ctx.toranjaOrchestrator.status(),
    setMode: () => { throw new Error('controller not mounted') },
    agentSideEffect: () => {},
    answer: 'TORANJA_GATE: PASS\nall criteria inspected',
    hold: undefined,
    offline: new Map(),
    failing: new Map(),
  }
  ctx.provide('subprocess', {
    spawn: (spec: { argv: readonly string[]; cwd: string }) => {
      if (spec.argv[0] === 'git') {
        const child = spawn('git', spec.argv.slice(1), { cwd: spec.cwd, stdio: ['ignore', 'pipe', 'pipe'] })
        const done = new Promise<{ exitCode: number | null }>((resolve) => {
          child.on('close', (exitCode) => { resolve({ exitCode }) })
        })
        return { stdout: child.stdout, stderr: child.stderr, done, terminate: () => {}, waitForExit: () => done }
      }
      harness.agyRuns.push([...spec.argv])
      harness.agentSideEffect(spec.cwd)
      const stdout = new PassThrough()
      const stderr = new PassThrough()
      stdout.end(JSON.stringify({ status: 'SUCCESS', response: harness.answer }))
      stderr.end()
      const done = Promise.resolve({ exitCode: 0 })
      return { stdout, stderr, done, terminate: () => {}, waitForExit: () => done }
    },
  } as never)
  ctx.provide('subagents', {
    list: () => [...registered, ...providers.keys()],
    registerProvider: (provider: RegisteredProvider) => {
      providers.set(provider.name, provider)
      return () => { providers.delete(provider.name) }
    },
    startActivation: async (start: {
      provider: string
      request: { cwd: string; signal?: AbortSignal; prompt: { text: string }[] }
    }) => {
      const family = start.provider.split('~')[0] ?? start.provider
      const refusal = harness.offline.get(family)
      if (refusal !== undefined) throw new Error(refusal)
      harness.started.push(start.provider)
      harness.prompts.push(start.request.prompt.map(block => block.text).join(''))
      const diagnostic = harness.failing.get(family)
      if (diagnostic !== undefined) {
        harness.agentSideEffect(start.request.cwd)
        return {
          childId: `child-${harness.started.length}`,
          result: Promise.resolve({ output: [], stopReason: 'error', diagnostic }),
        }
      }
      const provider = providers.get(start.provider)
      // Antigravity instances Toranja owns run through the simulated CLI;
      // every other provider settles with the configured answer.
      if (provider !== undefined && start.provider.startsWith('antigravity')) {
        const run = await provider.start({ ...start.request, signal: new AbortController().signal })
        void run.result.finally(() => run.dispose())
        return { childId: `child-${harness.started.length}`, result: run.result }
      }
      harness.agentSideEffect(start.request.cwd)
      return {
        childId: `child-${harness.started.length}`,
        result: (harness.hold ?? Promise.resolve())
          .then(() => ({ output: [{ type: 'text', text: harness.answer }], stopReason: 'completed' })),
      }
    },
  } as never)
  ctx.provide('tools', { register: (tool: Tool) => { tools.set(tool.name, tool); return () => {} } } as never)
  ctx.provide('systemPrompt', { section: () => () => {}, getSectionOrder: () => 0 } as never)
  ctx.provide('workspaceRegistry', {
    list: () => [],
    create: () => Promise.resolve({ title: 'Demo', setTitle: () => Promise.resolve() }),
  } as never)

  await ctx.plugin(orchestrator, orchestrator.Config({
    projects: [{ id: 'demo', title: 'Demo', path: repo }],
    ...config,
  }))
  mounted.push(ctx)
  const controller = (ctx as Context & { toranjaOrchestrationController: orchestrator.ToranjaOrchestrationController })
    .toranjaOrchestrationController
  return Object.assign(harness, {
    setMode: (request: Record<string, unknown>) => Promise.resolve(controller.setMode(request as never)),
  })
}

const ROUTING = {
  codex: {
    base: { env: { CODEX_HOME: '/codex' } },
    models: {
      light: { model: 'gpt-light', effort: 'low' },
      advanced: { model: 'gpt-strong', effort: 'medium' },
      max: { model: 'gpt-strong', effort: 'high' },
    },
  },
  antigravity: {
    base: { executable: 'agy', sandbox: true, autoApproveTools: true, mode: 'accept-edits' },
    models: {
      light: { model: 'gemini-flash-low' },
      advanced: { model: 'gemini-argon-medium' },
    },
  },
} as const

async function settled(harness: Harness): Promise<ToranjaOrchestrationStatus['tasks']> {
  await expect.poll(() => harness.status().active).toBe(0)
  return harness.status().tasks
}

async function implement(harness: Harness): Promise<string> {
  const result = await delegate(harness, { role: 'implementer' })
  await settled(harness)
  return (result.activations as { taskId: string }[])[0]?.taskId ?? ''
}

function delegate(harness: Harness, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  return harness.tool('delegate_project_task').execute({
    project: 'demo',
    description: 'check the lane',
    task: 'do the work',
    ...args,
  }, { agent: {}, signal: new AbortController().signal }).then(text => JSON.parse(text) as Record<string, unknown>)
}

interface GateOutcome {
  readonly passed: boolean
  readonly implementerProvider?: string
  readonly independentReview?: boolean
  readonly replan?: Record<string, unknown>
  readonly results: Record<string, unknown>[]
}

function runGate(harness: Harness, args: Record<string, unknown> = {}): Promise<GateOutcome> {
  return harness.tool('run_delivery_gate').execute({
    project: 'demo',
    implementationSummary: 'done',
    acceptanceCriteria: 'tests pass',
    ...args,
  }, { agent: {}, signal: new AbortController().signal }).then(text => JSON.parse(text) as GateOutcome)
}

afterEach(async () => {
  // A delegation's working-tree check outlives the tool call; let it finish
  // before its Git processes lose their directory.
  for (const ctx of mounted.splice(0)) await expect.poll(() => ctx.toranjaOrchestrator.status().active).toBe(0)
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const repo of repos.splice(0)) rmSync(repo, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

describe('Toranja routed delegation', () => {
  it('starts a reader on the light model in the provider plan mode without auto-approval', async () => {
    const harness = await mount({ routing: ROUTING })
    const result = await delegate(harness, { role: 'reader' })
    expect(result.activations).toEqual([expect.objectContaining({
      provider: 'antigravity',
      providerName: 'antigravity~ro~gemini-flash-low~native',
      tier: 'light',
      access: 'read-only',
      model: 'gemini-flash-low',
    })])
    const argv = harness.agyRuns.at(-1) ?? []
    expect(argv.slice(argv.indexOf('--mode'), argv.indexOf('--mode') + 2)).toEqual(['--mode', 'plan'])
    expect(argv.slice(argv.indexOf('--model'), argv.indexOf('--model') + 2)).toEqual(['--model', 'gemini-flash-low'])
    expect(argv).not.toContain('--dangerously-skip-permissions')
    expect(argv).not.toContain('--disable-slash-commands')
    expect((await settled(harness))[0]).toMatchObject({ state: 'completed', access: 'read-only', model: 'gemini-flash-low' })
  })

  it('starts an implementer with the deployment write permissions on the advanced model', async () => {
    const harness = await mount({ routing: ROUTING, roleProviders: { implementer: 'antigravity' } })
    await delegate(harness, { role: 'implementer' })
    const argv = harness.agyRuns.at(-1) ?? []
    expect(argv).toEqual(expect.arrayContaining(['--mode', 'accept-edits', '--model', 'gemini-argon-medium', '--dangerously-skip-permissions']))
    expect(harness.started).toEqual(['antigravity~rw~gemini-argon-medium~native'])
  })

  it('changes the routed model with the execution profile', async () => {
    const harness = await mount({ routing: ROUTING })
    const route = (role: string) => harness.status().routes.find(candidate => candidate.role === role)
    expect(route('tester')).toMatchObject({ provider: 'codex', tier: 'advanced', model: 'gpt-strong', effort: 'medium', access: 'execute' })
    await harness.setMode({ mode: 'team', profile: 'economico' })
    expect(route('tester')).toMatchObject({ tier: 'light', model: 'gpt-light', effort: 'low' })
    await harness.setMode({ mode: 'codex', profile: 'qualidade' })
    expect(route('reviewer')).toMatchObject({ provider: 'codex', tier: 'max', model: 'gpt-strong', effort: 'high', access: 'read-only' })
    await delegate(harness, { role: 'reviewer' })
    expect(harness.started).toEqual(['codex~ro~gpt-strong~high'])
  })

  it('fails a read-only task that created a file', async () => {
    const harness = await mount({ routing: ROUTING })
    harness.agentSideEffect = (cwd) => { writeFileSync(join(cwd, 'proof.txt'), 'WRITTEN') }
    await delegate(harness, { role: 'reader' })
    expect((await settled(harness))[0]).toMatchObject({
      state: 'failed',
      error: 'read-only role created, removed, or changed untracked files',
    })
  })

  it('fails a read-only task that wrote an ignored file', async () => {
    const harness = await mount({ routing: ROUTING })
    harness.agentSideEffect = (cwd) => { writeFileSync(join(cwd, '.env'), 'TOKEN=leaked') }
    await delegate(harness, { role: 'reader' })
    expect((await settled(harness))[0]).toMatchObject({
      state: 'failed',
      error: 'read-only role created, removed, or changed untracked files',
    })
  })

  it('fails a read-only task that rewrote an existing untracked file', async () => {
    const harness = await mount({ routing: ROUTING })
    writeFileSync(join(harness.repo, 'notes.txt'), 'draft')
    harness.agentSideEffect = (cwd) => { writeFileSync(join(cwd, 'notes.txt'), 'rewritten by the reader') }
    await delegate(harness, { role: 'reader' })
    expect((await settled(harness))[0]).toMatchObject({ state: 'failed' })
  })

  it('refuses the delivery gate while an implementer holds the project', async () => {
    const harness = await mount({ routing: ROUTING, maxConcurrentPerProject: 3 })
    const release = Promise.withResolvers<undefined>()
    harness.hold = release.promise
    await delegate(harness, { role: 'implementer' })
    await expect(harness.tool('run_delivery_gate').execute({
      project: 'demo',
      implementationSummary: 'in progress',
      acceptanceCriteria: 'tests pass',
    }, { agent: {}, signal: new AbortController().signal }))
      .rejects.toThrow('an implementer is still active in project demo')
    release.resolve(undefined)
  })

  it('invalidates a gate verdict when an implementer starts during the gate', async () => {
    const harness = await mount({ routing: ROUTING, maxConcurrentPerProject: 3, maxConcurrentPerProvider: 3 })
    await harness.setMode({ mode: 'codex' })
    const release = Promise.withResolvers<undefined>()
    harness.hold = release.promise
    const gate = harness.tool('run_delivery_gate').execute({
      project: 'demo',
      implementationSummary: 'done',
      acceptanceCriteria: 'tests pass',
    }, { agent: {}, signal: new AbortController().signal })
    await expect.poll(() => harness.started.length).toBe(2)
    await delegate(harness, { role: 'implementer' })
    release.resolve(undefined)
    const result = JSON.parse(await gate) as { passed: boolean; results: { verdict: string; diagnostic?: string }[] }
    expect(result.passed).toBe(false)
    expect(result.results[0]).toMatchObject({
      verdict: 'invalid',
      diagnostic: 'access could not be verified: an implementer ran in the project during this run',
    })
  })

  it('lets a tester create build output but not change tracked files', async () => {
    const harness = await mount({ routing: ROUTING })
    harness.agentSideEffect = (cwd) => { writeFileSync(join(cwd, 'build.log'), 'ok') }
    await delegate(harness, { role: 'tester' })
    expect((await settled(harness))[0]).toMatchObject({ state: 'completed', access: 'execute' })
    harness.agentSideEffect = (cwd) => { writeFileSync(join(cwd, 'tracked.txt'), 'changed\n') }
    await delegate(harness, { role: 'tester' })
    expect((await settled(harness))[0]).toMatchObject({ state: 'failed', error: 'execute role changed tracked files' })
  })

  it('does not blame a read-only task for an implementer that ran meanwhile', async () => {
    const harness = await mount({ routing: ROUTING })
    harness.agentSideEffect = (cwd) => { writeFileSync(join(cwd, 'tracked.txt'), 'implemented\n') }
    await delegate(harness, { role: 'implementer' })
    expect((await settled(harness))[0]).toMatchObject({ role: 'implementer', state: 'completed', access: 'write' })
  })

  it('routes the delivery gate through the selected mode and rejects a gate run that edits files', async () => {
    const harness = await mount({ routing: ROUTING })
    await harness.setMode({ mode: 'codex' })
    const gate = (): Promise<Record<string, unknown>> => harness.tool('run_delivery_gate').execute({
      project: 'demo',
      implementationSummary: 'changed tracked.txt',
      acceptanceCriteria: 'tests pass',
    }, { agent: {}, signal: new AbortController().signal }).then(text => JSON.parse(text) as Record<string, unknown>)
    expect(await gate()).toMatchObject({ passed: true, decision: 'ready' })
    expect(harness.started).toEqual(['codex~ro~gpt-strong~medium', 'codex~rw~gpt-strong~medium'])
    harness.agentSideEffect = (cwd) => { writeFileSync(join(cwd, 'tracked.txt'), 'edited by the gate\n') }
    const failed = await gate()
    expect(failed).toMatchObject({ passed: false, decision: 'not-ready' })
    expect(failed.results).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'reviewer', verdict: 'invalid', diagnostic: 'read-only role changed tracked files' }),
    ]))
  })

  it('uses only the providers that are connected', async () => {
    const harness = await mount({ routing: ROUTING }, ['codex'])
    expect(harness.status().routes.map(route => route.provider)).toEqual(Array.from({ length: 9 }, () => 'codex'))
    const result = await delegate(harness, { role: 'searcher' })
    expect(result.activations).toEqual([expect.objectContaining({ provider: 'codex', providerName: 'codex~ro~gpt-light~low' })])
  })

  it('falls back to the next connected provider when the routed one refuses to start', async () => {
    const harness = await mount({ routing: ROUTING })
    harness.offline.set('antigravity', 'agy is not installed')
    const result = await delegate(harness, { role: 'reader' })
    expect(result.activations).toEqual([expect.objectContaining({
      provider: 'codex',
      providerName: 'codex~ro~gpt-light~low',
      fallbackFrom: [{ provider: 'antigravity', error: 'agy is not installed' }],
    })])
    const tasks = await settled(harness)
    expect(tasks.map(task => [task.provider, task.state])).toEqual([['codex', 'completed'], ['antigravity', 'failed']])
  })

  it('reruns the task on the next provider when the routed one runs out of quota', async () => {
    const harness = await mount({ routing: ROUTING })
    harness.failing.set('antigravity', 'Antigravity status: ERROR' + String.fromCharCode(10) + 'RESOURCE_EXHAUSTED: quota exceeded')
    await delegate(harness, { role: 'reader' })
    const tasks = await settled(harness)
    expect(tasks.map(task => [task.provider, task.state])).toEqual([['codex', 'completed'], ['antigravity', 'failed']])
    expect(harness.started).toEqual(['antigravity~ro~gemini-flash-low~native', 'codex~ro~gpt-light~low'])
  })

  it('keeps a task that failed on its own merits on the provider that ran it', async () => {
    const harness = await mount({ routing: ROUTING })
    harness.failing.set('antigravity', 'Antigravity status: ERROR' + String.fromCharCode(10) + 'the requested file does not exist')
    await delegate(harness, { role: 'reader' })
    const tasks = await settled(harness)
    expect(tasks.map(task => [task.provider, task.state])).toEqual([['antigravity', 'failed']])
  })

  it('reruns a gate reviewer on the next provider and reports the provider it left', async () => {
    const harness = await mount({ routing: ROUTING })
    harness.failing.set('antigravity', 'Antigravity timed out after 600000 ms')
    const result = JSON.parse(await harness.tool('run_delivery_gate').execute({
      project: 'demo',
      implementationSummary: 'done',
      acceptanceCriteria: 'tests pass',
    }, { agent: {}, signal: new AbortController().signal })) as { passed: boolean; results: Record<string, unknown>[] }
    expect(result.passed).toBe(true)
    expect(result.results[0]).toMatchObject({
      role: 'reviewer',
      provider: 'codex',
      verdict: 'pass',
      fallbackFrom: [{ provider: 'antigravity', error: 'Antigravity timed out after 600000 ms' }],
    })
  })

  it('reviews an implementation on a different provider than the one that wrote it', async () => {
    const harness = await mount({ routing: ROUTING, roleProviders: { implementer: 'codex', reviewer: 'codex' } })
    const result = await runGate(harness, { implementationTaskId: await implement(harness) })
    expect(result).toMatchObject({ passed: true, implementerProvider: 'codex', independentReview: true })
    expect(result.results[0]).toMatchObject({ role: 'reviewer', provider: 'antigravity' })
  })

  it('reports a review as not independent when only the implementing provider is connected', async () => {
    const harness = await mount({ routing: ROUTING }, ['codex'])
    const result = await runGate(harness, { implementationTaskId: await implement(harness) })
    expect(result).toMatchObject({ implementerProvider: 'codex', independentReview: false })
    expect(result.results[0]).toMatchObject({ role: 'reviewer', provider: 'codex' })
  })

  it('keeps the preferred reviewer when cross-review is switched off', async () => {
    const harness = await mount({
      routing: ROUTING,
      crossReview: false,
      roleProviders: { implementer: 'codex', reviewer: 'codex' },
    })
    const result = await runGate(harness, { implementationTaskId: await implement(harness) })
    expect(result).toMatchObject({ implementerProvider: 'codex', independentReview: false })
    expect(result.results[0]).toMatchObject({ role: 'reviewer', provider: 'codex' })
  })

  it('sends a failed gate back to a planner with the failure evidence', async () => {
    const harness = await mount({ routing: ROUTING })
    harness.answer = 'TORANJA_GATE: FAIL' + String.fromCharCode(10) + '2 assertions failed in checkout.spec.ts'
    const result = await runGate(harness)
    expect(result).toMatchObject({ passed: false, replan: { role: 'planner', provider: 'antigravity' } })
    expect(harness.started.at(-1)).toBe('antigravity~ro~gemini-argon-medium~native')
    expect(harness.prompts.at(-1)).toContain('Assigned role: planner')
    expect(harness.prompts.at(-1)).toContain('2 assertions failed in checkout.spec.ts')
    expect(harness.prompts.at(-1)).toContain('tests pass')
  })

  it('does not replan a gate that passed, was inconclusive, or has replanning switched off', async () => {
    const passing = await mount({ routing: ROUTING })
    expect(await runGate(passing)).not.toHaveProperty('replan')
    const inconclusive = await mount({ routing: ROUTING })
    inconclusive.answer = 'I could not decide'
    expect(await runGate(inconclusive)).not.toHaveProperty('replan')
    const disabled = await mount({ routing: ROUTING, replanOnGateFailure: false })
    disabled.answer = 'TORANJA_GATE: FAIL' + String.fromCharCode(10) + 'broken'
    expect(await runGate(disabled)).not.toHaveProperty('replan')
  })

  it('does not rerun an implementer whose provider failed after it may have written', async () => {
    const harness = await mount({ routing: ROUTING })
    harness.failing.set('codex', 'product: Codex; stage: turn; category: limit')
    harness.agentSideEffect = (cwd) => { writeFileSync(join(cwd, 'tracked.txt'), 'half written') }
    await delegate(harness, { role: 'implementer' })
    const tasks = await settled(harness)
    expect(tasks.map(task => [task.provider, task.state])).toEqual([['codex', 'failed']])
    expect(harness.started).toEqual(['codex~rw~gpt-strong~medium'])
  })

  it('does not infer the implementer of a gate from earlier work in the project', async () => {
    const harness = await mount({ routing: ROUTING, roleProviders: { implementer: 'antigravity' } })
    await implement(harness)
    const result = await runGate(harness)
    expect(result).not.toHaveProperty('implementerProvider')
    expect(result).not.toHaveProperty('independentReview')
    expect(result.results[0]).toMatchObject({ role: 'reviewer', provider: 'antigravity' })
  })

  it('rejects a gate bound to a task that is not a completed implementation of the project', async () => {
    const harness = await mount({ routing: ROUTING })
    await expect(runGate(harness, { implementationTaskId: 'toranja-missing' }))
      .rejects.toThrow('implementationTaskId toranja-missing is not a completed implementer task of project demo')
    const reader = await delegate(harness, { role: 'reader' })
    await settled(harness)
    const readerTask = (reader.activations as { taskId: string }[])[0]?.taskId
    await expect(runGate(harness, { implementationTaskId: readerTask }))
      .rejects.toThrow('is not a completed implementer task of project demo')
  })

  it('keeps the gate evidence in the replan task when summary and criteria fill the task budget', async () => {
    const harness = await mount({ routing: ROUTING, maxTaskChars: 600 })
    harness.answer = 'TORANJA_GATE: FAIL' + String.fromCharCode(10) + '2 assertions failed in checkout.spec.ts'
    await runGate(harness, {
      implementationSummary: 'S'.repeat(300),
      acceptanceCriteria: 'C'.repeat(300),
    })
    expect(harness.prompts.at(-1)).toContain('Assigned role: planner')
    expect(harness.prompts.at(-1)).toContain('2 assertions failed in checkout.spec.ts')
  })

  it('restores mode, profile, and fallback order after a restart', async () => {
    const disk = new MemoryMediaPool()
    const first = await mount({ routing: ROUTING }, ['codex', 'antigravity'], disk)
    await first.setMode({ mode: 'codex', profile: 'qualidade', fallbackOrder: ['antigravity', 'codex'] })
    const restarted = await mount({ routing: ROUTING }, ['codex', 'antigravity'], disk)
    expect(restarted.status()).toMatchObject({
      mode: 'codex',
      profile: 'qualidade',
      fallbackOrder: ['antigravity', 'codex'],
    })
  })

  it('applies a changed provider per role and cross-review setting at once and after a restart', async () => {
    const disk = new MemoryMediaPool()
    const first = await mount({ routing: ROUTING }, ['codex', 'antigravity'], disk)
    const route = (harness: Harness, role: string) => harness.status().routes.find(candidate => candidate.role === role)?.provider
    expect(route(first, 'planner')).toBe('antigravity')
    await first.setMode({ mode: 'team', roleProviders: { planner: 'codex', reviewer: 'codex' }, crossReview: false })
    expect(route(first, 'planner')).toBe('codex')
    expect(first.status()).toMatchObject({ crossReview: false, roleProviders: { planner: 'codex', reviewer: 'codex' } })

    const restarted = await mount({ routing: ROUTING }, ['codex', 'antigravity'], disk)
    expect(route(restarted, 'planner')).toBe('codex')
    expect(restarted.status()).toMatchObject({ crossReview: false, roleProviders: { planner: 'codex', reviewer: 'codex' } })
    const result = await runGate(restarted, { implementationTaskId: await implement(restarted) })
    expect(result.results[0]).toMatchObject({ role: 'reviewer', provider: 'codex' })
  })

  it('keeps the routing in force when storing a change fails', async () => {
    const disk = new MemoryMediaPool()
    const harness = await mount({ routing: ROUTING }, ['codex', 'antigravity'], disk)
    disk.failNextWrites = 1
    await expect(harness.setMode({
      mode: 'codex',
      profile: 'qualidade',
      fallbackOrder: ['antigravity', 'codex'],
      roleProviders: { reader: 'codex' },
      crossReview: false,
    })).rejects.toThrow('injected write failure')
    expect(harness.status()).toMatchObject({
      mode: 'team',
      profile: 'equilibrado',
      fallbackOrder: ['codex', 'antigravity', 'claude-code', 'openrouter'],
      roleProviders: {},
      crossReview: true,
    })
    const result = await delegate(harness, { role: 'reader' })
    expect(result.activations).toEqual([expect.objectContaining({ provider: 'antigravity' })])
  })

  it('stores only what the user changed, so untouched defaults follow the deployment', async () => {
    const disk = new MemoryMediaPool()
    const first = await mount({ routing: ROUTING, defaultProfile: 'equilibrado' }, ['codex', 'antigravity'], disk)
    await first.setMode({ mode: 'codex' })
    const restarted = await mount({
      routing: ROUTING,
      defaultProfile: 'qualidade',
      fallbackOrder: ['antigravity', 'codex'],
      roleProviders: { planner: 'codex' },
      crossReview: false,
    }, ['codex', 'antigravity'], disk)
    expect(restarted.status()).toMatchObject({
      mode: 'codex',
      profile: 'qualidade',
      fallbackOrder: ['antigravity', 'codex'],
      roleProviders: { planner: 'codex' },
      crossReview: false,
    })
  })

  it('keeps earlier stored choices when a later change touches another field', async () => {
    const disk = new MemoryMediaPool()
    const first = await mount({ routing: ROUTING }, ['codex', 'antigravity'], disk)
    await first.setMode({ mode: 'team', profile: 'economico' })
    await first.setMode({ mode: 'team', crossReview: false })
    const restarted = await mount({ routing: ROUTING }, ['codex', 'antigravity'], disk)
    expect(restarted.status()).toMatchObject({ mode: 'team', profile: 'economico', crossReview: false })
  })

  it('keeps both changes when two settings are changed at the same time', async () => {
    const disk = new MemoryMediaPool()
    const first = await mount({ routing: ROUTING }, ['codex', 'antigravity'], disk)
    await Promise.all([
      first.setMode({ mode: 'team', profile: 'economico' }),
      first.setMode({ mode: 'team', crossReview: false }),
      first.setMode({ mode: 'team', roleProviders: { planner: 'codex' } }),
    ])
    const expected = { profile: 'economico', crossReview: false, roleProviders: { planner: 'codex' } }
    expect(first.status()).toMatchObject(expected)
    const restarted = await mount({ routing: ROUTING }, ['codex', 'antigravity'], disk)
    expect(restarted.status()).toMatchObject(expected)
  })

  it('starts from the deployment defaults when nothing was stored', async () => {
    const harness = await mount({ routing: ROUTING, defaultMode: 'antigravity', defaultProfile: 'economico' })
    expect(harness.status()).toMatchObject({ mode: 'antigravity', profile: 'economico', crossReview: true, roleProviders: {} })
  })

  it('does not fall back when the caller named the provider or selected a solo mode', async () => {
    const harness = await mount({ routing: ROUTING })
    harness.offline.set('antigravity', 'agy is not installed')
    await expect(delegate(harness, { role: 'reader', provider: 'antigravity' }))
      .rejects.toThrow('no project agent started: antigravity: agy is not installed')
    await harness.setMode({ mode: 'antigravity' })
    await expect(delegate(harness, { role: 'reader' }))
      .rejects.toThrow('no project agent started: antigravity: agy is not installed')
  })

  it('delegates through the unrouted instance when Toranja owns none', async () => {
    const harness = await mount({})
    const result = await delegate(harness, { role: 'reader', provider: 'codex' })
    expect(result.activations).toEqual([expect.objectContaining({ providerName: 'codex', tier: 'light', access: 'read-only' })])
    expect(result.activations).toEqual([expect.not.objectContaining({ model: expect.anything() })])
  })

  it('rejects routing that names unknown providers, tiers, roles, or invalid provider settings', async () => {
    await expect(mount({ routing: { gemini: {} } })).rejects.toThrow('routing names unknown provider "gemini"')
    await expect(mount({ routing: { codex: { models: { turbo: { model: 'x' } } } } })).rejects.toThrow('unknown tier "turbo"')
    await expect(mount({ routing: { 'claude-code': { base: {} } } })).rejects.toThrow('routing.claude-code.base is not supported')
    await expect(mount({ routing: { codex: { models: { light: { model: 'gpt-light' } } } } }))
      .rejects.toThrow('routing.codex.models requires routing.codex.base')
    await expect(mount({ roleProviders: { janitor: 'codex' } })).rejects.toThrow('unknown role "janitor"')
    await expect(mount({ routing: { antigravity: { base: {}, models: { light: { effort: 'turbo' } } } } })).rejects.toThrow()
  })
})
