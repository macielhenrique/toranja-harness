import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
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
  /** Status commands sent to the simulated provider CLIs. */
  readonly cliRuns: string[][]
  readonly started: string[]
  /** Prompt text of every started run, in start order. */
  readonly prompts: string[]
  readonly tool: (name: string) => Tool
  readonly status: () => ToranjaOrchestrationStatus
  readonly setMode: (request: Record<string, unknown>) => Promise<ToranjaOrchestrationStatus>
  /** Change settings without naming the routing mode. */
  readonly update: (request: Record<string, unknown>) => Promise<ToranjaOrchestrationStatus>
  readonly adoptLegacyMode: (mode: string) => Promise<ToranjaOrchestrationStatus>
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
  /** Answers of the simulated provider CLIs to status commands, keyed by executable path. */
  readonly cli: Map<string, { exitCode: number; stdout: string }>
  readonly probe: () => Promise<ToranjaOrchestrationStatus>
  readonly connect: (provider: string) => Promise<{ command: readonly string[] }>
  /** Start requests received by the simulated subagent service, in order. */
  readonly requests: { provider: string; agentOptions?: Record<string, unknown> }[]
  /** Credential references the simulated credential store holds. */
  readonly credentials: Set<string>
  /** When set, the simulated credential store fails with this message. */
  credentialFailure: string | undefined
  /** Executables whose status command cannot be started. */
  readonly brokenCli: Set<string>
  /** When set, every Git command the orchestrator runs fails. */
  gitBroken: boolean
  /** How many of the next Git commands fail before Git works again. */
  gitFailures: number
  /** Arguments of every Git command the orchestrator ran. */
  readonly gitRuns: string[][]
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
    cliRuns: [],
    started: [],
    prompts: [],
    tool: (name) => {
      const tool = tools.get(name)
      if (tool === undefined) throw new Error(`missing tool ${name}`)
      return tool
    },
    status: () => ctx.toranjaOrchestrator.status(),
    setMode: () => { throw new Error('controller not mounted') },
    update: () => { throw new Error('controller not mounted') },
    adoptLegacyMode: () => { throw new Error('controller not mounted') },
    agentSideEffect: () => {},
    answer: 'TORANJA_GATE: PASS\nall criteria inspected',
    hold: undefined,
    offline: new Map(),
    failing: new Map(),
    cli: new Map(),
    probe: () => { throw new Error('controller not mounted') },
    connect: () => { throw new Error('controller not mounted') },
    requests: [],
    credentials: new Set(),
    credentialFailure: undefined,
    brokenCli: new Set(),
    gitBroken: false,
    gitFailures: 0,
    gitRuns: [],
  }
  ctx.provide('subprocess', {
    spawn: (spec: { argv: readonly string[]; cwd: string }) => {
      // The orchestrator runs Git by the absolute path it resolved from PATH.
      if (/(?:^|[\\/])git(?:\.exe)?$/iu.test(spec.argv[0] ?? '')) {
        harness.gitRuns.push(spec.argv.slice(1))
        const failing = harness.gitBroken || harness.gitFailures-- > 0
        const child = spawn('git', failing ? ['not-a-git-command'] : spec.argv.slice(1), { cwd: spec.cwd, stdio: ['ignore', 'pipe', 'pipe'] })
        const done = new Promise<{ exitCode: number | null }>((resolve) => {
          child.on('close', (exitCode) => { resolve({ exitCode }) })
        })
        return { stdout: child.stdout, stderr: child.stderr, done, terminate: () => {}, waitForExit: () => done }
      }
      if (harness.brokenCli.has(spec.argv[0] ?? '')) throw new Error('spawn EPERM')
      const scripted = harness.cli.get(spec.argv[0] ?? '')
      if (scripted !== undefined && !spec.argv.includes('-p')) {
        harness.cliRuns.push([...spec.argv])
        const stdout = new PassThrough()
        const stderr = new PassThrough()
        stdout.end(scripted.stdout)
        stderr.end()
        const done = Promise.resolve({ exitCode: scripted.exitCode })
        return { stdout, stderr, done, terminate: () => {}, waitForExit: () => done }
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
      request: { cwd: string; signal?: AbortSignal; prompt: { text: string }[]; agentOptions?: Record<string, unknown> }
    }) => {
      harness.requests.push({
        provider: start.provider,
        ...start.request.agentOptions === undefined ? {} : { agentOptions: start.request.agentOptions },
      })
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
        void run.result.finally(() => { void run.dispose() })
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
  ctx.provide('credentials', {
    describe: (ref: string) => harness.credentialFailure === undefined
      ? Promise.resolve({ configured: harness.credentials.has(ref) })
      : Promise.reject(new Error(harness.credentialFailure)),
  } as never)
  ctx.provide('tools', { register: (tool: Tool) => { tools.set(tool.name, tool); return () => {} } } as never)
  ctx.provide('systemPrompt', { section: () => () => {}, getSectionOrder: () => 0 } as never)
  ctx.provide('workspaceRegistry', {
    list: () => [],
    create: () => Promise.resolve({ title: 'Demo', setTitle: () => Promise.resolve() }),
  } as never)

  await ctx.plugin(orchestrator, orchestrator.Config(Object.assign({
    projects: [{ id: 'demo', title: 'Demo', path: repo }],
  }, config)))
  mounted.push(ctx)
  const controller = (ctx as Context & { toranjaOrchestrationController: orchestrator.ToranjaOrchestrationController })
    .toranjaOrchestrationController
  return Object.assign(harness, {
    setMode: (request: Record<string, unknown>) => Promise.resolve(controller.setMode(request as never)),
    update: (request: Record<string, unknown>) => Promise.resolve(controller.updateSettings(request as never)),
    adoptLegacyMode: (mode: string) => controller.adoptLegacyMode({ mode: mode as never }),
    probe: () => controller.probeProviders(),
    connect: async (provider: string) => controller.connectProvider({ provider: provider as never }),
  })
}

/** Create empty files standing in for installed provider CLIs and return their absolute paths. */
function installed<Name extends string>(...names: Name[]): Record<Name, string> {
  const bin = mkdtempSync(join(tmpdir(), 'toranja-bin-'))
  repos.push(bin)
  const paths = {} as Record<Name, string>
  for (const name of names) {
    paths[name] = join(bin, name)
    writeFileSync(paths[name], '')
  }
  return paths
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

  it('shows the new routing to anyone notified that the stored choice changed', async () => {
    const harness = await mount({ routing: ROUTING })
    const seen: unknown[] = []
    harness.ctx.on('domain/changed', () => {
      const status = harness.status()
      seen.push([status.mode, status.profile, status.routes.find(route => route.role === 'reader')?.provider])
    })
    await harness.setMode({ mode: 'codex', profile: 'qualidade' })
    expect(seen).toEqual([['codex', 'qualidade', 'codex']])
  })

  it('adopts the mode an earlier version kept in the browser when none is stored yet', async () => {
    const disk = new MemoryMediaPool()
    const first = await mount({ routing: ROUTING }, ['codex', 'antigravity'], disk)
    expect(await first.adoptLegacyMode('codex')).toMatchObject({ mode: 'codex' })
    const restarted = await mount({ routing: ROUTING }, ['codex', 'antigravity'], disk)
    expect(restarted.status()).toMatchObject({ mode: 'codex', profile: 'equilibrado' })
  })

  it('keeps the stored mode over one an earlier version kept in the browser', async () => {
    const harness = await mount({ routing: ROUTING })
    await harness.setMode({ mode: 'antigravity' })
    expect(await harness.adoptLegacyMode('codex')).toMatchObject({ mode: 'antigravity' })
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

  it('routes a role to Claude Code in plan mode on the configured model and effort', async () => {
    const harness = await mount({
      routing: {
        ...ROUTING,
        'claude-code': {
          base: { permissionMode: 'acceptEdits' },
          models: { light: { model: 'haiku', effort: 'low' }, advanced: { model: 'sonnet', effort: 'medium' } },
        },
      },
      roleProviders: { reader: 'claude-code', implementer: 'claude-code' },
    }, ['codex', 'antigravity', 'claude-code'])
    const reader = await delegate(harness, { role: 'reader' })
    expect(reader.activations).toEqual([expect.objectContaining({
      provider: 'claude-code',
      providerName: 'claude-code~ro~haiku~low',
      access: 'read-only',
      model: 'haiku',
      effort: 'low',
    })])
    await settled(harness)
    await delegate(harness, { role: 'implementer' })
    expect(harness.started.at(-1)).toBe('claude-code~rw~sonnet~medium')
  })

  it('reports which provider CLIs are installed and signed in', async () => {
    const bin = installed('codex', 'claude')
    const harness = await mount({
      routing: ROUTING,
      executables: { codex: bin.codex, 'claude-code': bin.claude, antigravity: join(tmpdir(), 'no-such-agy') },
    }, ['codex', 'antigravity', 'claude-code'])
    harness.cli.set(bin.codex, { exitCode: 0, stdout: 'Logged in using ChatGPT' })
    harness.cli.set(bin.claude, { exitCode: 0, stdout: JSON.stringify({ loggedIn: false }) })
    const status = await harness.probe()
    expect(Object.fromEntries(status.providers.map(provider => [provider.id, provider.connection]))).toEqual({
      codex: 'connected',
      antigravity: 'not-installed',
      'claude-code': 'signed-out',
      openrouter: 'signed-out',
    })
    expect(harness.cliRuns).toEqual(expect.arrayContaining([
      [bin.codex, 'login', 'status'],
      [bin.claude, 'auth', 'status'],
    ]))
  })

  it('routes around providers that are not installed or signed out', async () => {
    const bin = installed('codex', 'claude')
    const harness = await mount({
      routing: ROUTING,
      executables: { codex: bin.codex, 'claude-code': bin.claude, antigravity: join(tmpdir(), 'no-such-agy') },
    }, ['codex', 'antigravity', 'claude-code'])
    harness.cli.set(bin.codex, { exitCode: 0, stdout: 'Logged in using ChatGPT' })
    harness.cli.set(bin.claude, { exitCode: 1, stdout: '' })
    expect(harness.status().routes.find(route => route.role === 'reader')?.provider).toBe('antigravity')
    await harness.probe()
    expect(harness.status().routes.map(route => route.provider)).toEqual(Array.from({ length: 9 }, () => 'codex'))
    const result = await delegate(harness, { role: 'reader' })
    expect(result.activations).toEqual([expect.objectContaining({ provider: 'codex' })])
    expect(result.activations).toHaveLength(1)
    expect((result.activations as object[])[0]).not.toHaveProperty('fallbackFrom')
  })

  it('lets the user set how many agents work at once, and keeps it after a restart', async () => {
    const disk = new MemoryMediaPool()
    const harness = await mount({ routing: ROUTING }, ['codex', 'antigravity', 'claude-code'], disk)
    expect(harness.status().teamSize).toBe(2)
    await harness.setMode({ mode: 'team', teamSize: 3 })
    expect(harness.status()).toMatchObject({ teamSize: 3, limits: { maxConcurrentPerProject: 3 } })

    const release = Promise.withResolvers<undefined>()
    harness.hold = release.promise
    await delegate(harness, { role: 'reader', provider: 'codex' })
    await delegate(harness, { role: 'searcher', provider: 'codex' })
    await delegate(harness, { role: 'inspector', provider: 'codex' })
    expect(harness.status().active).toBe(3)
    await expect(delegate(harness, { role: 'reader', provider: 'codex' })).rejects.toThrow('limit reached')
    release.resolve(undefined)

    const restarted = await mount({ routing: ROUTING }, ['codex', 'antigravity', 'claude-code'], disk)
    expect(restarted.status().teamSize).toBe(3)
  })

  it('rejects a team size that is not a positive whole number', async () => {
    const harness = await mount({ routing: ROUTING })
    await expect(harness.setMode({ mode: 'team', teamSize: 0 })).rejects.toThrow('teamSize must be a positive safe integer')
    await expect(harness.setMode({ mode: 'team', teamSize: 2.5 })).rejects.toThrow('teamSize must be a positive safe integer')
    expect(harness.status().teamSize).toBe(2)
  })

  it('starts one agent on every connected provider, up to the team size', async () => {
    const harness = await mount({ routing: ROUTING }, ['codex', 'antigravity', 'claude-code'])
    await harness.setMode({ mode: 'team', teamSize: 3 })
    const all = await delegate(harness, { role: 'reviewer', provider: 'all' })
    expect((all.activations as { provider: string }[]).map(run => run.provider)).toEqual(['codex', 'antigravity', 'claude-code'])
    await settled(harness)
    await harness.setMode({ mode: 'team', teamSize: 2 })
    const two = await delegate(harness, { role: 'reviewer', provider: 'all' })
    expect((two.activations as { provider: string }[]).map(run => run.provider)).toEqual(['codex', 'antigravity'])
  })

  it('runs an OpenRouter task as an internal agent on the model routed for the role', async () => {
    const harness = await mount({
      routing: { ...ROUTING, openrouter: { models: { light: { model: 'meta/llama-small' }, advanced: { model: 'meta/llama-large', effort: 'high' } } } },
      openrouterProvider: 'spawn',
      openrouterUnenforcedAccess: true,
    }, ['codex', 'antigravity', 'spawn'])
    const reader = await delegate(harness, { role: 'reader', provider: 'openrouter' })
    expect(reader.activations).toEqual([expect.objectContaining({ provider: 'openrouter', providerName: 'spawn', model: 'meta/llama-small' })])
    expect(harness.requests.at(-1)).toEqual({ provider: 'spawn', agentOptions: { provider: 'openrouter', model: 'meta/llama-small' } })
    await settled(harness)
    await delegate(harness, { role: 'planner', provider: 'openrouter' })
    expect(harness.requests.at(-1)).toEqual({
      provider: 'spawn',
      agentOptions: { provider: 'openrouter', model: 'meta/llama-large', reasoningEffort: 'high' },
    })
  })

  it('refuses an OpenRouter task when no model is routed for its tier', async () => {
    const harness = await mount({ routing: ROUTING, openrouterProvider: 'spawn' }, ['codex', 'spawn'])
    await expect(delegate(harness, { role: 'implementer', provider: 'openrouter' }))
      .rejects.toThrow('routing.openrouter.models has no model for the advanced tier')
  })

  it('reports OpenRouter as connected only while its API key is stored', async () => {
    const harness = await mount({ routing: ROUTING, openrouterProvider: 'spawn' }, ['codex', 'spawn'])
    const openrouter = async (): Promise<unknown> =>
      (await harness.probe()).providers.find(provider => provider.id === 'openrouter')?.connection
    expect(await openrouter()).toBe('signed-out')
    harness.credentials.add('OPENROUTER_API_KEY')
    expect(await openrouter()).toBe('connected')
  })

  it('opens the official sign-in command of a CLI provider in a terminal', async () => {
    const bin = installed('codex', 'claude')
    const harness = await mount({
      routing: ROUTING,
      executables: { codex: bin.codex, 'claude-code': bin.claude, antigravity: join(tmpdir(), 'no-such-agy') },
    }, ['codex', 'antigravity', 'claude-code'])
    expect((await harness.connect('codex')).command).toEqual([bin.codex, 'login'])
    expect((await harness.connect('claude-code')).command).toEqual([bin.claude, 'auth', 'login'])
    expect(harness.agyRuns.slice(-2)).toEqual([
      orchestrator.terminalArgv([bin.codex, 'login']),
      orchestrator.terminalArgv([bin.claude, 'auth', 'login']),
    ])
    await expect(harness.connect('antigravity')).rejects.toThrow('antigravity is not installed')
    await expect(harness.connect('openrouter')).rejects.toThrow('OpenRouter connects with an API key')
  })

  it('keeps OpenRouter out of routing until a model is configured for it', async () => {
    const without = await mount({ routing: ROUTING, openrouterProvider: 'spawn' }, ['spawn'])
    expect(without.status().providers.find(provider => provider.id === 'openrouter')?.available).toBe(false)
    const withModel = await mount({
      routing: { ...ROUTING, openrouter: { models: { light: { model: 'meta/llama-small' }, advanced: { model: 'meta/llama-large' } } } },
      openrouterProvider: 'spawn',
    }, ['spawn'])
    expect(withModel.status().providers.find(provider => provider.id === 'openrouter')?.available).toBe(true)
    // Without a way to keep it from writing, OpenRouter takes only the writing role.
    expect(withModel.status().routes.filter(route => route.provider === 'openrouter').map(route => route.role))
      .toEqual(['implementer'])
  })

  it('refuses to run OpenRouter in a role that must not write, unless the deployment accepts that risk', async () => {
    const routing = { ...ROUTING, openrouter: { models: { light: { model: 'meta/llama-small' }, advanced: { model: 'meta/llama-large' } } } }
    const harness = await mount({ routing, openrouterProvider: 'spawn' }, ['codex', 'antigravity', 'spawn'])
    await expect(delegate(harness, { role: 'reader', provider: 'openrouter' }))
      .rejects.toThrow('OpenRouter cannot be kept from writing, so it does not run the read-only role reader')
    await expect(delegate(harness, { role: 'tester', provider: 'openrouter' }))
      .rejects.toThrow('does not run the execute role tester')
    const implemented = await delegate(harness, { role: 'implementer', provider: 'openrouter' })
    expect(implemented.activations).toEqual([expect.objectContaining({ provider: 'openrouter' })])
  })

  it('leaves OpenRouter out when a non-writing task fans out over both or all providers', async () => {
    const routing = { ...ROUTING, openrouter: { models: { light: { model: 'meta/llama-small' }, advanced: { model: 'meta/llama-large' } } } }
    const harness = await mount({
      routing,
      openrouterProvider: 'spawn',
      fallbackOrder: ['openrouter', 'codex', 'antigravity'],
    }, ['codex', 'antigravity', 'spawn'])
    await harness.setMode({ mode: 'team', teamSize: 3 })
    const both = await delegate(harness, { role: 'reviewer', provider: 'both' })
    expect((both.activations as { provider: string }[]).map(run => run.provider)).toEqual(['codex', 'antigravity'])
    await settled(harness)
    const all = await delegate(harness, { role: 'reader', provider: 'all' })
    expect((all.activations as { provider: string }[]).map(run => run.provider)).toEqual(['codex', 'antigravity'])
    expect(harness.requests.filter(request => request.provider === 'spawn')).toEqual([])
  })

  it('treats a provider whose status command could not run as unusable', async () => {
    const bin = installed('codex', 'claude')
    const harness = await mount({
      routing: ROUTING,
      executables: { codex: bin.codex, 'claude-code': bin.claude, antigravity: join(tmpdir(), 'no-such-agy') },
    }, ['codex', 'antigravity', 'claude-code'])
    harness.brokenCli.add(bin.codex)
    harness.cli.set(bin.claude, { exitCode: 0, stdout: JSON.stringify({ loggedIn: true }) })
    const status = await harness.probe()
    expect(status.providers.find(provider => provider.id === 'codex')).toMatchObject({ connection: 'probe-failed', available: false })
    expect(status.routes.map(route => route.provider)).toEqual(Array.from({ length: 9 }, () => 'claude-code'))
  })

  it('still reports the CLI providers when the credential store cannot be read', async () => {
    const bin = installed('codex')
    const harness = await mount({
      routing: ROUTING,
      openrouterProvider: 'spawn',
      executables: { codex: bin.codex, 'claude-code': join(tmpdir(), 'no-such-claude'), antigravity: join(tmpdir(), 'no-such-agy') },
    }, ['codex', 'spawn'])
    harness.cli.set(bin.codex, { exitCode: 0, stdout: 'Logged in using ChatGPT' })
    harness.credentialFailure = 'credential store is locked'
    const status = await harness.probe()
    expect(Object.fromEntries(status.providers.map(provider => [provider.id, provider.connection]))).toEqual({
      codex: 'connected',
      antigravity: 'not-installed',
      'claude-code': 'not-installed',
      openrouter: 'probe-failed',
    })
  })

  it('delegates through the unrouted instance when Toranja owns none', async () => {
    const harness = await mount({})
    const result = await delegate(harness, { role: 'reader', provider: 'codex' })
    expect(result.activations).toEqual([expect.objectContaining({ providerName: 'codex', tier: 'light', access: 'read-only' })])
    expect(result.activations).toHaveLength(1)
    expect((result.activations as object[])[0]).not.toHaveProperty('model')
  })

  it('reports per provider the model of each tier, whether the user can change it, and how reading is enforced', async () => {
    const harness = await mount({ routing: ROUTING, openrouterProvider: 'spawn' }, ['codex', 'antigravity', 'claude-code', 'spawn'])
    const providers = Object.fromEntries(harness.status().providers.map(provider => [provider.id, provider]))
    expect(providers.codex).toMatchObject({
      readOnlyEnforcement: 'sandbox',
      tierModelsEditable: true,
      tierModelOverrides: {},
      tierModels: {
        light: { model: 'gpt-light', effort: 'low' },
        advanced: { model: 'gpt-strong', effort: 'medium' },
        max: { model: 'gpt-strong', effort: 'high' },
      },
    })
    expect(providers.antigravity).toMatchObject({
      readOnlyEnforcement: 'advisory',
      tierModelsEditable: true,
      tierModels: { light: { model: 'gemini-flash-low' }, advanced: { model: 'gemini-argon-medium' } },
    })
    // Toranja owns no Claude Code instance here, so it neither enforces reading nor applies a model.
    expect(providers['claude-code']).toMatchObject({ readOnlyEnforcement: 'none', tierModelsEditable: false, tierModels: {} })
    expect(providers.openrouter).toMatchObject({ readOnlyEnforcement: 'none', tierModelsEditable: true, tierModels: {} })
  })

  it('applies a model the user sets for a tier at once and after a restart, and restores the deployment model', async () => {
    const disk = new MemoryMediaPool()
    const codex = (harness: Harness) => harness.status().providers.find(provider => provider.id === 'codex')
    const first = await mount({ routing: ROUTING }, ['codex', 'antigravity'], disk)
    await first.setMode({ mode: 'codex', tierModels: { codex: { light: { model: 'gpt-tiny', effort: 'low' } } } })
    expect(codex(first)).toMatchObject({
      tierModelOverrides: { light: { model: 'gpt-tiny', effort: 'low' } },
      tierModels: { light: { model: 'gpt-tiny', effort: 'low' }, advanced: { model: 'gpt-strong', effort: 'medium' } },
    })
    expect(codex(first)?.tierModelOverrides).not.toHaveProperty('advanced')
    const reader = await delegate(first, { role: 'reader' })
    expect(reader.activations).toEqual([expect.objectContaining({ provider: 'codex', model: 'gpt-tiny', effort: 'low' })])
    await settled(first)

    const restarted = await mount({ routing: ROUTING }, ['codex', 'antigravity'], disk)
    expect(codex(restarted)).toMatchObject({
      tierModelOverrides: { light: { model: 'gpt-tiny', effort: 'low' } },
      tierModels: { light: { model: 'gpt-tiny', effort: 'low' } },
    })
    // An empty table for a provider drops what the user set for it.
    await restarted.setMode({ mode: 'codex', tierModels: { codex: {} } })
    expect(codex(restarted)).toMatchObject({ tierModelOverrides: {}, tierModels: { light: { model: 'gpt-light', effort: 'low' } } })
    expect(codex(restarted)?.tierModelOverrides).toEqual({})
  })

  it('keeps the models of one provider when the user changes those of another', async () => {
    const harness = await mount({ routing: ROUTING }, ['codex', 'antigravity'])
    await harness.setMode({ mode: 'team', tierModels: { codex: { max: { model: 'gpt-max', effort: 'high' } } } })
    await harness.setMode({ mode: 'team', tierModels: { antigravity: { light: { model: 'gemini-flash-medium' } } } })
    const providers = Object.fromEntries(harness.status().providers.map(provider => [provider.id, provider]))
    expect(providers.codex?.tierModels).toMatchObject({ max: { model: 'gpt-max', effort: 'high' } })
    expect(providers.antigravity?.tierModels).toMatchObject({ light: { model: 'gemini-flash-medium' }, advanced: { model: 'gemini-argon-medium' } })
  })

  it('lets the user route OpenRouter by setting its models, without a deployment table', async () => {
    const harness = await mount({ routing: ROUTING, openrouterProvider: 'spawn' }, ['codex', 'antigravity', 'spawn'])
    const openrouter = () => harness.status().providers.find(provider => provider.id === 'openrouter')
    expect(openrouter()).toMatchObject({ available: false })
    await harness.setMode({ mode: 'team', tierModels: { openrouter: { advanced: { model: 'meta/llama-large' } } } })
    expect(openrouter()).toMatchObject({ available: true, tierModels: { advanced: { model: 'meta/llama-large' } } })
    await delegate(harness, { role: 'implementer', provider: 'openrouter' })
    expect(harness.requests.at(-1)).toEqual({ provider: 'spawn', agentOptions: { provider: 'openrouter', model: 'meta/llama-large' } })
  })

  it('rejects tier models the provider cannot apply and leaves the stored ones untouched', async () => {
    const harness = await mount({ routing: ROUTING }, ['codex', 'antigravity', 'claude-code'])
    await harness.setMode({ mode: 'team', tierModels: { codex: { light: { model: 'gpt-tiny' } } } })
    await expect(harness.setMode({ mode: 'team', tierModels: { 'claude-code': { light: { model: 'haiku' } } } }))
      .rejects.toThrow('tierModels.claude-code cannot be set')
    await expect(harness.setMode({ mode: 'team', tierModels: { codex: { turbo: { model: 'x' } } } }))
      .rejects.toThrow('unknown tier "turbo"')
    await expect(harness.setMode({ mode: 'team', tierModels: { codex: { light: { model: '  ' } } } }))
      .rejects.toThrow('tierModels.codex.light.model must not be empty')
    await expect(harness.setMode({ mode: 'team', tierModels: { gemini: { light: { model: 'x' } } } }))
      .rejects.toThrow('unknown provider "gemini"')
    expect(harness.status().providers.find(provider => provider.id === 'codex')?.tierModels).toMatchObject({ light: { model: 'gpt-tiny' } })
  })

  it('reports the roles each provider may take, so OpenRouter is offered only for writing', async () => {
    const routing = { ...ROUTING, openrouter: { models: { advanced: { model: 'meta/llama-large' } } } }
    const roles = (harness: Harness, id: string) => harness.status().providers.find(provider => provider.id === id)?.roles
    const harness = await mount({ routing, openrouterProvider: 'spawn' }, ['codex', 'antigravity', 'spawn'])
    expect(roles(harness, 'openrouter')).toEqual(['implementer'])
    expect(roles(harness, 'codex')).toHaveLength(9)
    const accepting = await mount({ routing, openrouterProvider: 'spawn', openrouterUnenforcedAccess: true }, ['codex', 'spawn'])
    expect(roles(accepting, 'openrouter')).toHaveLength(9)
  })

  it('remembers that the first-run setup was finished, across restarts', async () => {
    const disk = new MemoryMediaPool()
    const first = await mount({ routing: ROUTING }, ['codex', 'antigravity'], disk)
    expect(first.status().onboarded).toBe(false)
    await first.update({ onboarded: true })
    expect(first.status().onboarded).toBe(true)
    // Another setting changed later does not undo it.
    await first.update({ crossReview: false })
    const restarted = await mount({ routing: ROUTING }, ['codex', 'antigravity'], disk)
    expect(restarted.status()).toMatchObject({ onboarded: true, crossReview: false })
  })

  it('does not pass a delivery gate whose read-only access could not be checked', async () => {
    const harness = await mount({ routing: ROUTING })
    await harness.setMode({ mode: 'codex' })
    harness.gitBroken = true
    const result = await runGate(harness)
    expect(result).toMatchObject({ passed: false })
    expect(result.results[0]).toMatchObject({ verdict: 'invalid', diagnostic: 'access could not be verified: the working tree could not be read' })
  })

  it('reads the working tree without running anything the repository configures', async () => {
    const harness = await mount({ routing: ROUTING })
    await delegate(harness, { role: 'reader', provider: 'codex' })
    await settled(harness)
    expect(harness.gitRuns.length).toBeGreaterThan(0)
    for (const args of harness.gitRuns) {
      // A file-system monitor or hook named in the repository's own Git config would run on the Host.
      expect(args.slice(0, 3)).toEqual(['--no-optional-locks', '-c', 'core.fsmonitor=false'])
      const hooks = args.find(arg => arg.startsWith('core.hooksPath='))?.slice('core.hooksPath='.length) ?? ''
      // Hooks are looked up in a directory the Host owns and keeps empty.
      expect(hooks.startsWith(harness.repo)).toBe(false)
      expect(readdirSync(hooks)).toEqual([])
    }
    expect(harness.gitRuns.find(args => args.includes('diff'))).toEqual(expect.arrayContaining(['--no-ext-diff', '--no-textconv']))
  })

  it('does not run a filter the repository configures when it reads the working tree', async () => {
    const harness = await mount({ routing: ROUTING })
    const marker = join(harness.repo, '..', `toranja-filter-ran-${Date.now()}`).replaceAll('\\', '/')
    repos.push(marker)
    const git = (...args: string[]): void => { execFileSync('git', args, { cwd: harness.repo, stdio: 'ignore' }) }
    // What an agent with write access could leave behind: a clean filter bound to a tracked file.
    git('config', 'filter.plant.clean', `touch "${marker}"; cat`)
    git('config', 'filter.plant.process', `touch "${marker}"`)
    writeFileSync(join(harness.repo, '.git', 'info', 'attributes'), 'tracked.txt filter=plant\n')
    writeFileSync(join(harness.repo, 'tracked.txt'), 'changed so Git must read it again\n')
    await delegate(harness, { role: 'reader', provider: 'codex' })
    await settled(harness)
    expect(harness.gitRuns.some(args => args.includes('diff'))).toBe(true)
    expect(existsSync(marker)).toBe(false)
  })

  /** A path beside the fixture repository that a planted command would create. */
  const markerFor = (harness: Harness, name: string): string => {
    const marker = join(harness.repo, '..', `toranja-${name}-${Date.now()}`).replaceAll('\\', '/')
    repos.push(marker)
    return marker
  }
  const gitIn = (cwd: string, ...args: string[]): void => { execFileSync('git', args, { cwd, stdio: 'ignore' }) }

  it('does not read a working tree whose filter it cannot switch off', async () => {
    const harness = await mount({ routing: ROUTING })
    await harness.setMode({ mode: 'codex' })
    const marker = markerFor(harness, 'equals-filter')
    // `-c filter.a=b.clean=` would be read as key `filter.a`, leaving this filter on.
    gitIn(harness.repo, 'config', 'filter.a=b.clean', `touch "${marker}"; cat`)
    writeFileSync(join(harness.repo, '.git', 'info', 'attributes'), 'tracked.txt filter=a=b\n')
    writeFileSync(join(harness.repo, 'tracked.txt'), 'changed so Git must read it again\n')
    const result = await runGate(harness)
    expect(result.results[0]).toMatchObject({ verdict: 'invalid', diagnostic: 'access could not be verified: the working tree could not be read' })
    expect(existsSync(marker)).toBe(false)
  })

  it('switches off a filter defined in the per-worktree configuration', async () => {
    const harness = await mount({ routing: ROUTING })
    const marker = markerFor(harness, 'worktree-config-filter')
    gitIn(harness.repo, 'config', 'extensions.worktreeConfig', 'true')
    gitIn(harness.repo, 'config', '--worktree', 'filter.plant.clean', `touch "${marker}"; cat`)
    writeFileSync(join(harness.repo, '.git', 'info', 'attributes'), 'tracked.txt filter=plant\n')
    writeFileSync(join(harness.repo, 'tracked.txt'), 'changed so Git must read it again\n')
    await delegate(harness, { role: 'reader', provider: 'codex' })
    await settled(harness)
    expect(existsSync(marker)).toBe(false)
  })

  it('still reads a working tree whose filter is marked required, as Git LFS marks its own', async () => {
    const harness = await mount({ routing: ROUTING })
    await harness.setMode({ mode: 'codex' })
    gitIn(harness.repo, 'config', 'filter.lfs.clean', 'cat')
    gitIn(harness.repo, 'config', 'filter.lfs.smudge', 'cat')
    gitIn(harness.repo, 'config', 'filter.lfs.required', 'true')
    writeFileSync(join(harness.repo, '.git', 'info', 'attributes'), 'tracked.txt filter=lfs\n')
    expect(await runGate(harness)).toMatchObject({ passed: true })
    // And a change is still seen with the filter off on both sides of the comparison.
    harness.agentSideEffect = (cwd) => { writeFileSync(join(cwd, 'tracked.txt'), 'edited by the gate\n') }
    expect((await runGate(harness)).results).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'reviewer', verdict: 'invalid', diagnostic: 'read-only role changed tracked files' }),
    ]))
  })

  it('catches a hidden file rewritten at the same size with its time put back', async () => {
    const harness = await mount({ routing: ROUTING })
    await harness.setMode({ mode: 'codex' })
    gitIn(harness.repo, 'update-index', '--skip-worktree', 'tracked.txt')
    harness.agentSideEffect = (cwd) => {
      const file = join(cwd, 'tracked.txt')
      const { atime, mtime } = statSync(file)
      writeFileSync(file, 'ORIGINAL\n')
      utimesSync(file, atime, mtime)
    }
    await delegate(harness, { role: 'tester' })
    const tasks = await settled(harness)
    expect(tasks[0]).toMatchObject({ state: 'failed', error: 'execute role changed Git state that hides file changes' })
  })

  it('catches an untracked file rewritten at the same size with its time put back', async () => {
    const harness = await mount({ routing: ROUTING })
    const notes = join(harness.repo, 'notes.txt')
    writeFileSync(notes, 'draft one\n')
    harness.agentSideEffect = () => {
      const { atime, mtime } = statSync(notes)
      writeFileSync(notes, 'DRAFT TWO\n')
      utimesSync(notes, atime, mtime)
    }
    await delegate(harness, { role: 'reader', provider: 'codex' })
    const tasks = await settled(harness)
    expect(tasks[0]).toMatchObject({ state: 'failed', error: 'read-only role created, removed, or changed untracked files' })
  })

  it('reads the working tree again when Git fails once, instead of skipping the check', async () => {
    const harness = await mount({ routing: ROUTING })
    harness.agentSideEffect = (cwd) => {
      writeFileSync(join(cwd, 'tracked.txt'), 'edited by the reader\n')
      // Git is busy for a moment when the run ends, as when another worktree is being removed.
      harness.gitFailures = 1
    }
    await delegate(harness, { role: 'reader', provider: 'codex' })
    const tasks = await settled(harness)
    expect(tasks[0]).toMatchObject({ state: 'failed', error: 'read-only role changed tracked files' })
  })

  it('catches an edit an agent hid from Git with an index flag', async () => {
    const harness = await mount({ routing: ROUTING })
    await harness.setMode({ mode: 'codex' })
    harness.agentSideEffect = (cwd) => {
      execFileSync('git', ['update-index', '--assume-unchanged', 'tracked.txt'], { cwd, stdio: 'ignore' })
      writeFileSync(join(cwd, 'tracked.txt'), 'edited behind the flag\n')
    }
    await delegate(harness, { role: 'tester' })
    const tasks = await settled(harness)
    expect(tasks[0]).toMatchObject({ state: 'failed', error: 'execute role changed Git state that hides file changes' })
  })

  it('catches an edit to a file that was already hidden from Git before the run', async () => {
    const harness = await mount({ routing: ROUTING })
    await harness.setMode({ mode: 'codex' })
    execFileSync('git', ['update-index', '--skip-worktree', 'tracked.txt'], { cwd: harness.repo, stdio: 'ignore' })
    harness.agentSideEffect = (cwd) => { writeFileSync(join(cwd, 'tracked.txt'), 'edited while hidden\n') }
    await delegate(harness, { role: 'tester' })
    const tasks = await settled(harness)
    expect(tasks[0]).toMatchObject({ state: 'failed', error: 'execute role changed Git state that hides file changes' })
  })

  it('brings a stored team size down to a limit the deployment lowered', async () => {
    const disk = new MemoryMediaPool()
    const first = await mount({ routing: ROUTING, maxTeamSize: 6 }, ['codex', 'antigravity'], disk)
    await first.update({ teamSize: 6 })
    const restarted = await mount({ routing: ROUTING, maxTeamSize: 3 }, ['codex', 'antigravity'], disk)
    expect(restarted.status()).toMatchObject({ teamSize: 3, limits: { maxConcurrentPerProject: 3, maxTeamSize: 3 } })
  })

  it('rejects a deployment fallback order that repeats a provider', async () => {
    await expect(mount({ routing: ROUTING, fallbackOrder: ['codex', 'codex'] })).rejects.toThrow('fallbackOrder repeats codex')
  })

  describe('with implementer worktrees', () => {
    /** Mount with isolation on, a fresh worktree root, and every agent's working directory recorded. */
    const isolated = async (registered = ['codex', 'antigravity']) => {
      const worktreeRoot = mkdtempSync(join(tmpdir(), 'toranja-worktrees-'))
      repos.push(worktreeRoot)
      const harness = await mount({ routing: ROUTING, implementerWorktrees: true, worktreeRoot }, registered)
      const cwds: string[] = []
      harness.agentSideEffect = (cwd) => { cwds.push(cwd) }
      return { harness, worktreeRoot, cwds }
    }
    const branches = (harness: Harness): string[] =>
      execFileSync('git', ['branch', '--list', 'toranja/*', '--format=%(refname:short)'], { cwd: harness.repo })
        .toString().split('\n').filter(Boolean)

    it('runs an implementer in its own worktree and branch, and keeps them when it changed something', async () => {
      const { harness, worktreeRoot, cwds } = await isolated()
      harness.agentSideEffect = (cwd) => {
        cwds.push(cwd)
        writeFileSync(join(cwd, 'tracked.txt'), 'written by the implementer\n')
      }
      const before = readFileSync(join(harness.repo, 'tracked.txt'), 'utf8')
      const result = await delegate(harness, { role: 'implementer', provider: 'codex' })
      const [run] = result.activations as { taskId: string; worktree: string; branch: string }[]
      expect(run?.worktree.startsWith(worktreeRoot)).toBe(true)
      expect(run?.branch).toMatch(/^toranja\/[a-z0-9]+-[a-z0-9]+$/)
      const tasks = await settled(harness)
      expect(cwds).toEqual([run?.worktree])
      // The project's own tree is untouched; the change waits on the branch.
      expect(readFileSync(join(harness.repo, 'tracked.txt'), 'utf8')).toBe(before)
      expect(readFileSync(join(run?.worktree ?? '', 'tracked.txt'), 'utf8')).toBe('written by the implementer\n')
      expect(branches(harness)).toEqual([run?.branch])
      expect(tasks.find(task => task.id === run?.taskId)).toMatchObject({ state: 'completed', worktree: run?.worktree, branch: run?.branch })
    })

    it('removes the worktree and branch of an implementer that changed nothing', async () => {
      const { harness } = await isolated()
      const result = await delegate(harness, { role: 'implementer', provider: 'codex' })
      const [run] = result.activations as { taskId: string; worktree: string }[]
      const tasks = await settled(harness)
      await expect.poll(() => existsSync(run?.worktree ?? '')).toBe(false)
      expect(branches(harness)).toEqual([])
      expect(tasks.find(task => task.id === run?.taskId)).not.toHaveProperty('worktree')
    })

    it('lets implementers work at the same time, each in its own worktree, while a reader is still checked', async () => {
      const { harness, cwds } = await isolated()
      await harness.update({ teamSize: 3 })
      const release = Promise.withResolvers<undefined>()
      harness.hold = release.promise
      const both = await delegate(harness, { role: 'implementer', provider: 'both' })
      const worktrees = (both.activations as { worktree: string }[]).map(run => run.worktree)
      expect(new Set(worktrees).size).toBe(2)
      // No implementer holds the project's own tree, so a reader's access is verified as usual.
      harness.agentSideEffect = (cwd) => { if (cwd === harness.repo) writeFileSync(join(cwd, 'tracked.txt'), 'edited by the reader\n') }
      await delegate(harness, { role: 'reader', provider: 'codex' })
      release.resolve(undefined)
      const tasks = await settled(harness)
      expect(tasks.find(task => task.role === 'reader')).toMatchObject({ state: 'failed', error: 'read-only role changed tracked files' })
      expect(cwds.sort()).toEqual([...worktrees].sort())
    })

    it('reviews an isolated implementation in its worktree', async () => {
      const { harness, cwds } = await isolated()
      harness.agentSideEffect = (cwd) => {
        cwds.push(cwd)
        if (cwds.length === 1) writeFileSync(join(cwd, 'tracked.txt'), 'written by the implementer\n')
      }
      const result = await delegate(harness, { role: 'implementer', provider: 'codex' })
      const [run] = result.activations as { taskId: string; worktree: string }[]
      await settled(harness)
      await runGate(harness, { implementationTaskId: run?.taskId })
      expect(cwds.length).toBeGreaterThan(1)
      expect(new Set(cwds)).toEqual(new Set([run?.worktree]))
    })

    it('does not run a repository filter when it checks out an implementer worktree', async () => {
      const { harness } = await isolated()
      const marker = join(harness.repo, '..', `toranja-smudge-${Date.now()}`).replaceAll('\\', '/')
      repos.push(marker)
      execFileSync('git', ['config', 'filter.plant.smudge', `touch "${marker}"; cat`], { cwd: harness.repo, stdio: 'ignore' })
      writeFileSync(join(harness.repo, '.git', 'info', 'attributes'), 'tracked.txt filter=plant\n')
      const result = await delegate(harness, { role: 'implementer', provider: 'codex' })
      expect(result.activations).toEqual([expect.objectContaining({ worktree: expect.any(String) as unknown })])
      await settled(harness)
      expect(existsSync(marker)).toBe(false)
    })

    it('does not trust the Git directory an implementer left in its worktree', async () => {
      const { harness } = await isolated()
      const marker = join(harness.repo, '..', `toranja-forged-${Date.now()}`).replaceAll('\\', '/')
      repos.push(marker)
      harness.agentSideEffect = (cwd) => {
        // The implementer points its worktree at a Git directory of its own, with a filter that would run on the Host.
        const forged = join(cwd, 'forged-git')
        rmSync(join(cwd, '.git'), { force: true })
        execFileSync('git', ['init', '-q', '--separate-git-dir', forged, cwd], { stdio: 'ignore' })
        // Tracked in the forged index first, so a later status has to read the file through the filter.
        execFileSync('git', ['add', 'tracked.txt'], { cwd, stdio: 'ignore' })
        execFileSync('git', ['-c', 'user.email=t@example.test', '-c', 'user.name=t', 'commit', '-q', '-m', 'forged'], { cwd, stdio: 'ignore' })
        execFileSync('git', ['config', 'filter.plant.clean', `touch "${marker}"; cat`], { cwd, stdio: 'ignore' })
        writeFileSync(join(forged, 'info', 'attributes'), '* filter=plant\n')
        writeFileSync(join(cwd, 'tracked.txt'), 'changed by the implementer\n')
      }
      await delegate(harness, { role: 'implementer', provider: 'codex' })
      await settled(harness)
      expect(existsSync(marker)).toBe(false)
    })

    it('keeps a worktree in which the implementer left only ignored files', async () => {
      const { harness } = await isolated()
      harness.agentSideEffect = (cwd) => { writeFileSync(join(cwd, '.env'), 'left by the implementer\n') }
      const result = await delegate(harness, { role: 'implementer', provider: 'codex' })
      const [run] = result.activations as { taskId: string; worktree: string }[]
      const tasks = await settled(harness)
      expect(readFileSync(join(run?.worktree ?? '', '.env'), 'utf8')).toBe('left by the implementer\n')
      expect(tasks.find(task => task.id === run?.taskId)).toMatchObject({ worktree: run?.worktree })
    })

    it('keeps the branch of an implementer that committed and then stepped back to where it started', async () => {
      const { harness } = await isolated()
      harness.agentSideEffect = (cwd) => {
        const git = (...args: string[]): void => {
          execFileSync('git', ['-c', 'user.email=t@example.test', '-c', 'user.name=t', ...args], { cwd, stdio: 'ignore' })
        }
        writeFileSync(join(cwd, 'tracked.txt'), 'committed by the implementer\n')
        git('commit', '-q', '-am', 'work')
        git('checkout', '-q', '--detach', 'HEAD~1')
      }
      const result = await delegate(harness, { role: 'implementer', provider: 'codex' })
      const [run] = result.activations as { taskId: string; branch: string }[]
      const tasks = await settled(harness)
      expect(branches(harness)).toEqual([run?.branch])
      expect(tasks.find(task => task.id === run?.taskId)).toMatchObject({ branch: run?.branch })
    })

    it('keeps a worktree that holds a nested repository, without looking inside it', async () => {
      const { harness } = await isolated()
      harness.agentSideEffect = (cwd) => {
        // A gitlink: Git would inspect the nested repository with that repository's own configuration.
        execFileSync('git', ['update-index', '--add', '--cacheinfo', '160000,1111111111111111111111111111111111111111,nested'], { cwd, stdio: 'ignore' })
      }
      const result = await delegate(harness, { role: 'implementer', provider: 'codex' })
      const [run] = result.activations as { taskId: string; worktree: string }[]
      const tasks = await settled(harness)
      expect(existsSync(run?.worktree ?? '')).toBe(true)
      expect(tasks.find(task => task.id === run?.taskId)).toMatchObject({ worktree: run?.worktree })
      const status = harness.gitRuns.find(args => args.includes('status'))
      expect(status).toEqual(expect.arrayContaining(['--ignore-submodules=all']))
    })

    it.each(['--assume-unchanged', '--skip-worktree'])('keeps a worktree whose edit is hidden from Git with %s', async (flag) => {
      const { harness } = await isolated()
      harness.agentSideEffect = (cwd) => {
        writeFileSync(join(cwd, 'tracked.txt'), 'edited and then hidden\n')
        execFileSync('git', ['update-index', flag, 'tracked.txt'], { cwd, stdio: 'ignore' })
      }
      const result = await delegate(harness, { role: 'implementer', provider: 'codex' })
      const [run] = result.activations as { taskId: string; worktree: string }[]
      await settled(harness)
      expect(readFileSync(join(run?.worktree ?? '', 'tracked.txt'), 'utf8')).toBe('edited and then hidden\n')
    })

    it('lists untracked files of a worktree whatever the repository configures', async () => {
      const { harness } = await isolated()
      execFileSync('git', ['config', 'status.showUntrackedFiles', 'no'], { cwd: harness.repo, stdio: 'ignore' })
      harness.agentSideEffect = (cwd) => { writeFileSync(join(cwd, 'new-file.txt'), 'new work\n') }
      const result = await delegate(harness, { role: 'implementer', provider: 'codex' })
      const [run] = result.activations as { taskId: string; worktree: string }[]
      await settled(harness)
      expect(existsSync(join(run?.worktree ?? '', 'new-file.txt'))).toBe(true)
    })

    it('rejects a worktree root that is not an absolute path', async () => {
      await expect(mount({ routing: ROUTING, implementerWorktrees: true, worktreeRoot: 'relative/worktrees' }))
        .rejects.toThrow('worktreeRoot must be an absolute path')
    })

    it('falls back to the shared tree, one implementer at a time, when no worktree can be created', async () => {
      const { harness, cwds } = await isolated()
      harness.gitBroken = true
      const release = Promise.withResolvers<undefined>()
      harness.hold = release.promise
      const result = await delegate(harness, { role: 'implementer', provider: 'codex' })
      expect(result.activations).toEqual([expect.not.objectContaining({ worktree: expect.anything() as unknown })])
      await expect(delegate(harness, { role: 'implementer', provider: 'antigravity' })).rejects.toThrow('write isolation prevents multiple implementers')
      release.resolve(undefined)
      await settled(harness)
      expect(cwds).toEqual([harness.repo])
    })
  })

  it('changes one setting without restating the mode, so a mode chosen meanwhile is kept', async () => {
    const disk = new MemoryMediaPool()
    const harness = await mount({ routing: ROUTING }, ['codex', 'antigravity'], disk)
    // Another window switched to Codex after this one last read the status.
    await harness.setMode({ mode: 'codex' })
    await harness.update({ crossReview: false })
    await harness.update({ profile: 'economico' })
    expect(harness.status()).toMatchObject({ mode: 'codex', crossReview: false, profile: 'economico' })
    const restarted = await mount({ routing: ROUTING }, ['codex', 'antigravity'], disk)
    expect(restarted.status()).toMatchObject({ mode: 'codex', crossReview: false, profile: 'economico' })
  })

  it('rejects a fallback order that repeats or misnames a provider', async () => {
    const harness = await mount({ routing: ROUTING })
    await expect(harness.update({ fallbackOrder: ['codex', 'codex'] })).rejects.toThrow('fallbackOrder repeats codex')
    await expect(harness.update({ fallbackOrder: ['codex', 'gemini'] })).rejects.toThrow('fallbackOrder names unknown provider "gemini"')
    expect(harness.status().fallbackOrder).toEqual(['codex', 'antigravity', 'claude-code', 'openrouter'])
    await harness.update({ fallbackOrder: ['antigravity', 'codex'] })
    expect(harness.status().fallbackOrder).toEqual(['antigravity', 'codex'])
  })

  it('caps the team size at the deployment limit and reports that limit', async () => {
    const harness = await mount({ routing: ROUTING, maxTeamSize: 4 })
    expect(harness.status().limits).toMatchObject({ maxTeamSize: 4 })
    await harness.update({ teamSize: 4 })
    await expect(harness.update({ teamSize: 5 })).rejects.toThrow('teamSize must not exceed 4')
    expect(harness.status().teamSize).toBe(4)
    expect((await mount({ routing: ROUTING })).status().limits).toMatchObject({ maxTeamSize: 8 })
  })

  it('keeps a running task on the model it started with when the tier model changes', async () => {
    const harness = await mount({ routing: ROUTING }, ['codex', 'antigravity'])
    await harness.setMode({ mode: 'codex' })
    const release = Promise.withResolvers<undefined>()
    harness.hold = release.promise
    await delegate(harness, { role: 'reader' })
    await harness.update({ tierModels: { codex: { light: { model: 'gpt-tiny', effort: 'low' } } } })
    expect(harness.status().tasks.find(task => task.state === 'active')).toMatchObject({ model: 'gpt-light', effort: 'low' })
    const next = await delegate(harness, { role: 'searcher' })
    expect(next.activations).toEqual([expect.objectContaining({ model: 'gpt-tiny', effort: 'low' })])
    release.resolve(undefined)
    await settled(harness)
  })

  it('rejects routing that names unknown providers, tiers, roles, or invalid provider settings', async () => {
    await expect(mount({ routing: { gemini: {} } })).rejects.toThrow('routing names unknown provider "gemini"')
    await expect(mount({ routing: { codex: { models: { turbo: { model: 'x' } } } } })).rejects.toThrow('unknown tier "turbo"')
    await expect(mount({ routing: { openrouter: { base: {} } } })).rejects.toThrow('routing.openrouter.base is not supported')
    await expect(mount({ routing: { codex: { models: { light: { model: 'gpt-light' } } } } }))
      .rejects.toThrow('routing.codex.models requires routing.codex.base')
    await expect(mount({ roleProviders: { janitor: 'codex' } })).rejects.toThrow('unknown role "janitor"')
    await expect(mount({ routing: { antigravity: { base: {}, models: { light: { effort: 'turbo' } } } } })).rejects.toThrow()
  })
})
