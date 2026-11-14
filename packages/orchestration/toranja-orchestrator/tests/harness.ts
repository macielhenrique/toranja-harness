/** Shared harness of the orchestrator tests: simulated providers, Git repositories, and tool helpers. */

import { execFileSync, spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { expect } from 'vitest'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import * as orchestrator from '../src/index.ts'
import type { ToranjaOrchestrationStatus } from '../src/index.ts'

interface RegisteredProvider {
  readonly name: string
  start(request: Record<string, unknown>): Promise<{ result: Promise<unknown>; dispose(): Promise<void> }>
}

interface Tool {
  readonly name: string
  execute(args: Record<string, unknown>, exec: { agent: unknown; signal: AbortSignal; callId?: string }): Promise<string>
}

export interface Harness {
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
  /**
   * Called before each Git command; when it returns a promise, the command
   * starts only after it resolves, and one that never resolves holds the
   * command until its abort signal fires.
   */
  gitGate: ((args: readonly string[]) => Promise<unknown> | undefined) | undefined
}

export const repos: string[] = []
const contexts: Context[] = []
const mounted: Context[] = []

export function gitRepo(): string {
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
export async function mount(
  config: orchestrator.Config = {},
  registered = ['codex', 'antigravity'],
  disk = new MemoryMediaPool(),
  /** Simulated `userQuestions` service; left out, the orchestrator finds none. */
  userQuestions?: unknown,
): Promise<Harness> {
  const ctx = new Context()
  contexts.push(ctx)
  if (userQuestions !== undefined) ctx.provide('userQuestions', userQuestions as never)
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
    gitGate: undefined,
  }
  ctx.provide('subprocess', {
    spawn: (spec: { argv: readonly string[]; cwd: string; signal?: AbortSignal }) => {
      // The orchestrator runs Git by the absolute path it resolved from PATH.
      if (/(?:^|[\\/])git(?:\.exe)?$/iu.test(spec.argv[0] ?? '')) {
        const args = spec.argv.slice(1)
        harness.gitRuns.push(args)
        const failing = harness.gitBroken || harness.gitFailures-- > 0
        const stdout = new PassThrough()
        const stderr = new PassThrough()
        const done = new Promise<{ exitCode: number | null }>((resolve) => {
          // Like the real service, an abort ends the command.
          spec.signal?.addEventListener('abort', () => { stdout.end(); stderr.end(); resolve({ exitCode: null }) }, { once: true })
          void Promise.resolve(harness.gitGate?.(args)).then(() => {
            if (spec.signal?.aborted === true) return
            const child = spawn('git', failing ? ['not-a-git-command'] : args, { cwd: spec.cwd, stdio: ['ignore', 'pipe', 'pipe'] })
            spec.signal?.addEventListener('abort', () => { child.kill() }, { once: true })
            child.stdout.pipe(stdout)
            child.stderr.pipe(stderr)
            child.on('close', (exitCode) => { resolve({ exitCode }) })
          })
        })
        return { stdout, stderr, done, terminate: () => {}, waitForExit: () => done }
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
export function installed<Name extends string>(...names: Name[]): Record<Name, string> {
  const bin = mkdtempSync(join(tmpdir(), 'toranja-bin-'))
  repos.push(bin)
  const paths = {} as Record<Name, string>
  for (const name of names) {
    paths[name] = join(bin, name)
    writeFileSync(paths[name], '')
  }
  return paths
}

export const ROUTING = {
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

export async function settled(harness: Harness): Promise<ToranjaOrchestrationStatus['tasks']> {
  await expect.poll(() => harness.status().active).toBe(0)
  return harness.status().tasks
}

export async function implement(harness: Harness): Promise<string> {
  const result = await delegate(harness, { role: 'implementer' })
  await settled(harness)
  return (result.activations as { taskId: string }[])[0]?.taskId ?? ''
}

export function delegate(harness: Harness, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  return harness.tool('delegate_project_task').execute({
    project: 'demo',
    description: 'check the lane',
    task: 'do the work',
    ...args,
  }, { agent: {}, signal: new AbortController().signal }).then(text => JSON.parse(text) as Record<string, unknown>)
}

export interface GateOutcome {
  readonly passed: boolean
  readonly implementerProvider?: string
  readonly independentReview?: boolean
  readonly replan?: Record<string, unknown>
  readonly results: Record<string, unknown>[]
}

export function runGate(harness: Harness, args: Record<string, unknown> = {}): Promise<GateOutcome> {
  return harness.tool('run_delivery_gate').execute({
    project: 'demo',
    implementationSummary: 'done',
    acceptanceCriteria: 'tests pass',
    ...args,
  }, { agent: {}, signal: new AbortController().signal }).then(text => JSON.parse(text) as GateOutcome)
}

/** Wait for every delegation to settle, then dispose the contexts and remove the repositories. */
export async function cleanup(): Promise<void> {
  // A delegation's working-tree check outlives the tool call; let it finish
  // before its Git processes lose their directory.
  for (const ctx of mounted.splice(0)) await expect.poll(() => ctx.toranjaOrchestrator.status().active).toBe(0)
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const repo of repos.splice(0)) rmSync(repo, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
}
