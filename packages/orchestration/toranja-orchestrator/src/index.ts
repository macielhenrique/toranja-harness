/**
 * Toranja-owned project catalog and role-based delegation surface.
 *
 * @module @deepseek-ai/dsh-toranja-orchestrator
 */

import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { basename, isAbsolute, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SubagentActivation, SubagentResult } from '@deepseek-ai/dsh-subagent'
import * as antigravityPlugin from '@deepseek-ai/dsh-subagent-antigravity'
import * as codexPlugin from '@deepseek-ai/dsh-subagent-codex'
import type {} from '@deepseek-ai/dsh-subprocess'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-workspace'
import {
  OrchestrationLedger,
  assertProvidersAllowed,
  defaultProvider,
  parseGateVerdict,
  resolveFallbackProvider,
  PROVIDERS,
  ROLES,
  RUN_PROVIDERS,
  slugifyProjectId,
  type Role,
  type RunProvider,
} from './policy.ts'
import {
  MODEL_TIERS,
  accessViolation,
  resolveRoute,
  variantConfig,
  variantName,
  type ProviderModels,
  type WorkspaceFingerprint,
} from './routing.ts'
import type {
  ToranjaAgentMode,
  ToranjaAgentModeRequest,
  ToranjaExecutionProfile,
  ToranjaOrchestrationStatus,
  ToranjaProviderId,
  ToranjaRoleAccess,
  ToranjaRoleRoute,
} from './types.ts'
import {
  ToranjaOrchestrator,
  type ToranjaCodexDelegationRequest,
  type ToranjaCodexDelegationResult,
} from './service.ts'

export * from './policy.ts'
export * from './routing.ts'
export * from './service.ts'
export * from './types.ts'

export const name = 'toranja-orchestrator'
export const inject = ['subagents', 'subprocess', 'systemPrompt', 'tools', 'workspaceRegistry']

const PROJECT_ID = /^[a-z][a-z0-9-]{1,31}$/
const DEFAULT_MAX_TASK_CHARS = 12_000
const GIT_GRACE_MS = 3_000

/** Provider plugins Toranja can instantiate per route to fix model, effort, and access. */
const VARIANT_PLUGINS = { codex: codexPlugin, antigravity: antigravityPlugin } as const
type VariantProvider = keyof typeof VARIANT_PLUGINS

function isVariantProvider(provider: RunProvider): provider is VariantProvider {
  return Object.hasOwn(VARIANT_PLUGINS, provider)
}

/** One stable product lane backed by a local project directory. */
export interface ProjectConfig {
  /** Stable lane identifier matching `^[a-z][a-z0-9-]{1,31}$`. */
  id: string
  /** Human-readable lane title. */
  title: string
  /** Absolute project directory. */
  path: string
}

/** Model and reasoning effort of one tier. */
export interface TierModelConfig {
  /** Provider model id; omitted to keep the provider's default model. */
  model?: string
  /** Provider reasoning effort; omitted to keep the provider's default effort. */
  effort?: string
}

/** Model routing of one provider. */
export interface ProviderRoutingConfig {
  /**
   * Base configuration of the provider plugin. When present, Toranja starts its
   * own provider instances per route and applies the model, effort, and access
   * below; when absent, delegations use the deployment's unrouted instance.
   */
  base?: Record<string, unknown>
  /** Model and reasoning effort per tier (`light`, `advanced`, `max`). */
  models?: Record<string, TierModelConfig>
}

/** Product-owned orchestration settings. */
export interface Config {
  /** Static project lanes added to the registered Workspaces. */
  projects?: ProjectConfig[]
  /** Registry name of the unrouted Codex provider. */
  codexProvider?: string
  /** Registry name of the unrouted Antigravity provider. */
  antigravityProvider?: string
  /** Registry name of the unrouted Claude Code provider. */
  claudeCodeProvider?: string
  /** Registry name of the unrouted OpenRouter provider. */
  openrouterProvider?: string
  /** Maximum Toranja-owned runs active at once. */
  maxConcurrentTotal?: number
  /** Maximum active runs in one project lane. */
  maxConcurrentPerProject?: number
  /** Maximum active runs on one provider. */
  maxConcurrentPerProvider?: number
  /** Maximum length of one delegated task or gate input. */
  maxTaskChars?: number
  /** Allow more than one implementer in the same project directory. */
  allowParallelImplementation?: boolean
  /** Routing mode in force until the controller changes it. */
  defaultMode?: ToranjaAgentMode
  /** Execution profile in force until the controller changes it. */
  defaultProfile?: ToranjaExecutionProfile
  /** Order in which registered providers replace an unavailable preferred one. */
  fallbackOrder?: ToranjaProviderId[]
  /** Per-provider model routing, keyed by provider id. */
  routing?: Record<string, ProviderRoutingConfig>
  /** Preferred provider per role in Team mode, keyed by role. */
  roleProviders?: Record<string, ToranjaProviderId>
}

export const Config: z<Config> = z.object({
  projects: z.array(z.object({
    id: z.string().min(2).max(32).required(),
    title: z.string().min(1).required(),
    path: z.string().min(1).required(),
  })).default([]),
  codexProvider: z.string().min(1).default('codex'),
  antigravityProvider: z.string().min(1).default('antigravity'),
  claudeCodeProvider: z.string().min(1).default('claude-code'),
  openrouterProvider: z.string().min(1).default('openrouter'),
  maxConcurrentTotal: z.number().default(4),
  maxConcurrentPerProject: z.number().default(2),
  maxConcurrentPerProvider: z.number().default(2),
  maxTaskChars: z.number().default(DEFAULT_MAX_TASK_CHARS),
  allowParallelImplementation: z.boolean().default(false),
  defaultMode: z.union(['codex', 'antigravity', 'claude-code', 'openrouter', 'team'] as const).default('team'),
  defaultProfile: z.union(['economico', 'equilibrado', 'qualidade'] as const).default('equilibrado'),
  fallbackOrder: z.array(z.union(['codex', 'antigravity', 'claude-code', 'openrouter'] as const)).default([
    'codex',
    'antigravity',
    'claude-code',
    'openrouter',
  ]),
  routing: z.dict(z.object({
    // A dict schema would default to `{}` and hide whether a base was configured.
    base: z.any(),
    models: z.dict(z.object({
      model: z.string().min(1),
      effort: z.string().min(1),
    })).default({}),
  })).default({}),
  roleProviders: z.dict(z.union(['codex', 'antigravity', 'claude-code', 'openrouter'] as const)).default({}),
})

interface ResolvedProject extends ProjectConfig {
  readonly id: string
  readonly title: string
  readonly path: string
}

/** Authenticated read-only dashboard surface. */
export class ToranjaOrchestrationController extends TypertRemoteService {
  constructor(
    ctx: Context,
    private readonly read: () => ToranjaOrchestrationStatus,
    private readonly writeMode: (request: ToranjaAgentModeRequest) => ToranjaOrchestrationStatus,
  ) {
    super(ctx, 'toranjaOrchestrationController', { namespace: 'toranja' })
  }

  /**
   * Read provider health, limits, and project counters without starting agents.
   * @returns Current orchestration snapshot.
   */
  @Remote
  status(): ToranjaOrchestrationStatus {
    return this.read()
  }

  /**
   * Change the provider routing, execution profile, or fallback order used by delegations.
   * @param request - Target routing mode and optional profile/fallback settings.
   * @returns Updated orchestration snapshot.
   */
  @Remote
  setMode(request: ToranjaAgentModeRequest): ToranjaOrchestrationStatus {
    return this.writeMode(request)
  }
}

const ROLE_GUIDANCE: Record<Role, string> = {
  reader: 'Phase A (Investigation - Reader): Read the target files and documentation using read-only tools. Return exact paths, key excerpts, and a concise summary in Portuguese without polluting the leader context. Never edit files.',
  searcher: 'Phase A (Investigation - Searcher): Locate relevant files and symbols using Glob and Grep. Return exact file paths, line references, and a one-line summary per file. Never edit files.',
  inspector: 'Phase A (Investigation - Inspector): Inspect logs, diagnostics, and code structure. Return the top recurring errors, exact error lines, and root-cause evidence concisely. Never edit files.',
  planner: 'Phase B (Reasoning - Planner): Analyze the request and repository state. Return an actionable plan with steps, affected files, risks, dependencies, and acceptance checks. Do not edit files unless explicitly requested.',
  architect: 'Phase B (Reasoning - Architect): Evaluate system-wide architectural impacts, boundaries, and trade-offs. Propose the cleanest minimal design following the project conventions. Do not edit files.',
  implementer: 'Phase B/C (Execution - Implementer): Implement the scoped change in this project. Preserve unrelated work, run focused validation, and report changed files plus test evidence.',
  reviewer: 'Phase C (Cross-Review - Reviewer): Independently review the requested outcome and current project state. Prioritize correctness, security, regressions, and missing acceptance evidence. Do not edit files unless explicitly asked.',
  tester: 'Phase C (Verification - Tester): Run the relevant tests and inspect failures. Report exact commands, outcomes, and diagnosis. If tests fail, provide actionable evidence for replanning.',
  release: 'Phase C (Delivery Gate - Release): Verify the delivery gate: requirements, diff, tests, build or package checks, and remaining risks. Report a clear ready/not-ready decision with evidence.',
}

function normalizePathKey(path: string): string {
  return process.platform === 'win32' ? path.toLowerCase() : path
}

function resolveProjects(projects: readonly ProjectConfig[]): ResolvedProject[] {
  const ids = new Set<string>()
  const paths = new Set<string>()
  return projects.map((project) => {
    const id = project.id.trim()
    const title = project.title.trim()
    const path = project.path.trim()
    if (!PROJECT_ID.test(id)) throw new Error(`toranja-orchestrator: invalid project id ${JSON.stringify(project.id)}`)
    if (title.length === 0) throw new Error(`toranja-orchestrator: project ${id} has an empty title`)
    if (!isAbsolute(path)) throw new Error(`toranja-orchestrator: project ${id} path must be absolute`)
    const pathKey = normalizePathKey(path)
    if (ids.has(id)) throw new Error(`toranja-orchestrator: duplicate project id ${id}`)
    if (paths.has(pathKey)) throw new Error(`toranja-orchestrator: duplicate project path ${path}`)
    ids.add(id)
    paths.add(pathKey)
    return { id, title, path }
  })
}

function rolePrompt(
  project: ResolvedProject,
  route: ToranjaRoleRoute,
  task: string,
  profile: ToranjaExecutionProfile,
): ContentBlock[] {
  return [{
    type: 'text',
    text: [
      `Toranja Harness project lane: ${project.title} (${project.id}).`,
      `Working directory boundary: ${project.path}.`,
      `Assigned role: ${route.role}. Model tier: ${route.tier}. Filesystem access: ${route.access}.`,
      `Execution profile: ${profile}.`,
      ROLE_GUIDANCE[route.role],
      '',
      'Task:',
      task.trim(),
    ].join('\n'),
  }]
}

function positiveInteger(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`toranja-orchestrator: ${name} must be a positive safe integer`)
  }
  return value
}

function requiredAt<T>(items: readonly T[], index: number, label: string): T {
  const item = items[index]
  if (item === undefined) throw new Error(`toranja-orchestrator: missing ${label} at index ${index}`)
  return item
}

function contentText(content: readonly ContentBlock[]): string {
  return content
    .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join('\n')
    .trim()
}

function gatePrompt(
  project: ResolvedProject,
  role: 'reviewer' | 'tester',
  implementationSummary: string,
  acceptanceCriteria: string,
): ContentBlock[] {
  const assignment = role === 'reviewer'
    ? 'Independently inspect the current diff and repository state for correctness, security, regressions, scope, and missing evidence.'
    : 'Run the focused tests, build, lint, or other checks needed to verify the acceptance criteria. Diagnose any failure.'
  return [{
    type: 'text',
    text: [
      `Toranja Harness delivery gate for ${project.title} (${project.id}).`,
      `Working directory boundary: ${project.path}.`,
      'Do not modify product files. This is an independent verification pass.',
      assignment,
      '',
      'Your first non-empty line MUST be exactly one of:',
      'TORANJA_GATE: PASS',
      'TORANJA_GATE: FAIL',
      'Use PASS only when the evidence you personally inspected satisfies every criterion. Explain evidence and remaining risks after the verdict line.',
      '',
      'Implementation summary:',
      implementationSummary.trim(),
      '',
      'Acceptance criteria:',
      acceptanceCriteria.trim(),
    ].join('\n'),
  }]
}

function monitorActivation(
  activation: SubagentActivation,
  lease: { settle(success: boolean, error?: string): void },
  verify: () => Promise<string | undefined>,
): void {
  void activation.result.then(
    async (result) => {
      const violation = await verify()
      lease.settle(
        result.stopReason === 'completed' && violation === undefined,
        violation ?? result.diagnostic ?? result.stopReason,
      )
    },
    (error: unknown) => {
      lease.settle(false, error instanceof Error ? error.message : 'subagent result infrastructure failure')
    },
  )
}

interface ProviderRouting {
  readonly base?: Record<string, unknown>
  readonly models: ProviderModels
}

function parseRouting(config: Config): Map<RunProvider, ProviderRouting> {
  const routing = new Map<RunProvider, ProviderRouting>()
  for (const [key, value] of Object.entries(config.routing ?? {})) {
    const provider = RUN_PROVIDERS.find(candidate => candidate === key)
    if (provider === undefined) throw new Error(`toranja-orchestrator: routing names unknown provider ${JSON.stringify(key)}`)
    const models: Partial<Record<typeof MODEL_TIERS[number], { model?: string; effort?: string }>> = {}
    for (const [tierKey, model] of Object.entries(value.models ?? {})) {
      const tier = MODEL_TIERS.find(candidate => candidate === tierKey)
      if (tier === undefined) throw new Error(`toranja-orchestrator: routing.${key}.models names unknown tier ${JSON.stringify(tierKey)}`)
      models[tier] = model
    }
    if (value.base !== undefined && (typeof value.base !== 'object' || value.base === null || Array.isArray(value.base))) {
      throw new Error(`toranja-orchestrator: routing.${key}.base must be a mapping`)
    }
    if (value.base !== undefined && !isVariantProvider(provider)) {
      throw new Error(`toranja-orchestrator: routing.${key}.base is not supported; ${key} has no Toranja-owned instances`)
    }
    if (value.base === undefined && Object.keys(models).length > 0) {
      throw new Error(`toranja-orchestrator: routing.${key}.models requires routing.${key}.base; without it no model is applied`)
    }
    routing.set(provider, { ...value.base === undefined ? {} : { base: value.base }, models })
  }
  return routing
}

function parseRoleProviders(config: Config): Map<Role, RunProvider> {
  const roleProviders = new Map<Role, RunProvider>()
  for (const [key, provider] of Object.entries(config.roleProviders ?? {})) {
    const role = ROLES.find(candidate => candidate === key)
    if (role === undefined) throw new Error(`toranja-orchestrator: roleProviders names unknown role ${JSON.stringify(key)}`)
    roleProviders.set(role, provider)
  }
  return roleProviders
}

interface GateRun {
  readonly role: 'reviewer' | 'tester'
  readonly provider: RunProvider
  readonly providerName: string
  readonly activation: SubagentActivation
  readonly verify: () => Promise<string | undefined>
}

interface GateResult {
  readonly role: GateRun['role']
  readonly provider: RunProvider
  readonly providerName: string
  readonly subagentId: string
  readonly stopReason: SubagentResult['stopReason'] | 'startup-error' | 'infrastructure-error'
  readonly verdict: ReturnType<typeof parseGateVerdict>
  readonly output: string
  readonly diagnostic?: string
}

/**
 * Register durable project lanes and model-facing orchestration tools.
 * @param ctx - Plugin context.
 * @param config - Validated orchestration configuration.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const configuredProjects = resolveProjects(config.projects ?? [])
  const codexProvider = config.codexProvider ?? 'codex'
  const antigravityProvider = config.antigravityProvider ?? 'antigravity'
  const claudeCodeProvider = config.claudeCodeProvider ?? 'claude-code'
  const openrouterProvider = config.openrouterProvider ?? 'openrouter'
  const distinctProviders = new Set([codexProvider, antigravityProvider, claudeCodeProvider, openrouterProvider])
  if (distinctProviders.size !== 4) {
    throw new Error('toranja-orchestrator: Codex, Antigravity, Claude Code, and OpenRouter provider names must be distinct')
  }
  const maxTaskChars = positiveInteger('maxTaskChars', config.maxTaskChars ?? DEFAULT_MAX_TASK_CHARS)
  const limits = {
    maxConcurrentTotal: positiveInteger('maxConcurrentTotal', config.maxConcurrentTotal ?? 4),
    maxConcurrentPerProject: positiveInteger('maxConcurrentPerProject', config.maxConcurrentPerProject ?? 2),
    maxConcurrentPerProvider: positiveInteger('maxConcurrentPerProvider', config.maxConcurrentPerProvider ?? 2),
    allowParallelImplementation: config.allowParallelImplementation ?? false,
  }
  const ledger = new OrchestrationLedger(limits)
  let mode: ToranjaAgentMode = config.defaultMode ?? 'team'
  let profile: ToranjaExecutionProfile = config.defaultProfile ?? 'equilibrado'
  let fallbackOrder: readonly ToranjaProviderId[] = config.fallbackOrder ?? RUN_PROVIDERS
  const providerName = (provider: RunProvider): string => {
    switch (provider) {
      case 'codex':
        return codexProvider
      case 'antigravity':
        return antigravityProvider
      case 'claude-code':
        return claudeCodeProvider
      case 'openrouter':
        return openrouterProvider
    }
  }

  const routing = parseRouting(config)
  const roleProviders = parseRoleProviders(config)
  const routeFor = (role: Role, provider: RunProvider): ToranjaRoleRoute => {
    const entry = routing.get(provider)
    return resolveRoute(role, profile, provider, entry?.base === undefined ? {} : entry.models)
  }
  for (const [provider, entry] of routing) {
    if (entry.base === undefined || !isVariantProvider(provider)) continue
    for (const role of ROLES) {
      for (const candidate of ['economico', 'equilibrado', 'qualidade'] as const) {
        const route = resolveRoute(role, candidate, provider, entry.models)
        VARIANT_PLUGINS[provider].Config(variantConfig(provider, entry.base, route, variantName(providerName(provider), route)))
      }
    }
  }
  const variants = new Map<string, Promise<string>>()
  /** Registry name of the provider instance that enforces `route`, started on first use. */
  const instanceFor = (route: ToranjaRoleRoute): Promise<string> => {
    const provider = route.provider
    const base = routing.get(provider)?.base
    if (base === undefined || !isVariantProvider(provider)) return Promise.resolve(providerName(provider))
    const instance = variantName(providerName(provider), route)
    let pending = variants.get(instance)
    if (pending === undefined) {
      pending = Promise.resolve(ctx.plugin(VARIANT_PLUGINS[provider], variantConfig(provider, base, route, instance)))
        .then(() => instance)
      variants.set(instance, pending)
      pending.catch(() => { variants.delete(instance) })
    }
    return pending
  }

  const gitOutput = async (cwd: string, args: readonly string[]): Promise<Buffer | undefined> => {
    const child = ctx.subprocess.spawn({
      argv: ['git', ...args],
      cwd,
      stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
      graceMs: GIT_GRACE_MS,
    })
    child.stderr?.resume()
    const chunks: Buffer[] = []
    for await (const chunk of child.stdout as NonNullable<typeof child.stdout>) chunks.push(chunk as Buffer)
    const outcome = await child.done
    return outcome.exitCode === 0 ? Buffer.concat(chunks) : undefined
  }
  /**
   * Hash path, size, and modification time of every untracked file and of each
   * ignored file or collapsed ignored directory. A change deep inside an
   * ignored directory does not alter that directory's own entry.
   */
  const untrackedHash = async (cwd: string, listings: readonly Buffer[]): Promise<string> => {
    const hash = createHash('sha256')
    const paths = listings.flatMap(listing => listing.toString('utf8').split('\0').filter(Boolean)).sort()
    for (const path of paths) {
      const facts = await stat(join(cwd, path)).then(
        entry => `${entry.size}:${entry.mtimeMs}`,
        () => 'missing',
      )
      hash.update(`${path}\0${facts}\0`)
    }
    return hash.digest('hex')
  }
  const fingerprint = async (cwd: string): Promise<WorkspaceFingerprint | undefined> => {
    try {
      const [tracked, untracked, ignored] = await Promise.all([
        gitOutput(cwd, ['diff', 'HEAD', '--binary']),
        gitOutput(cwd, ['ls-files', '--others', '--exclude-standard', '-z']),
        gitOutput(cwd, ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z']),
      ])
      if (tracked === undefined || untracked === undefined || ignored === undefined) return undefined
      return {
        tracked: createHash('sha256').update(tracked).digest('hex'),
        untracked: await untrackedHash(cwd, [untracked, ignored]),
      }
    } catch (error: unknown) {
      ctx.logger.warn(`toranja-orchestrator: working-tree fingerprint failed in ${cwd}: ${String(error)}`)
      return undefined
    }
  }
  /**
   * Capture the working tree before a non-writing run. The returned check
   * reports a change the role's access forbids. A concurrent implementer makes
   * the comparison meaningless: a `strict` run then reports that its access
   * could not be verified, and any other run reports nothing. The check also
   * reports nothing when the directory is not a Git work tree with a commit.
   */
  const guardAccess = async (
    project: ResolvedProject,
    access: ToranjaRoleAccess,
    strict: boolean,
  ): Promise<() => Promise<string | undefined>> => {
    const unverifiable = strict
      ? 'access could not be verified: an implementer ran in the project during this run'
      : undefined
    if (access === 'write') return () => Promise.resolve(undefined)
    if (ledger.hasActiveWriter(project.id)) return () => Promise.resolve(unverifiable)
    const writersBefore = ledger.writerStartCount(project.id)
    const before = await fingerprint(project.path)
    if (before === undefined) return () => Promise.resolve(undefined)
    return async () => {
      if (ledger.writerStartCount(project.id) !== writersBefore) return unverifiable
      const after = await fingerprint(project.path)
      if (after === undefined) return undefined
      const violation = accessViolation(access, before, after)
      if (violation !== undefined) {
        ctx.logger.warn(`toranja-orchestrator: ${violation} in project ${project.id}`)
      }
      return violation
    }
  }
  /** Start one routed delegation on the provider instance that enforces its route. */
  const launch = async (request: {
    readonly project: ResolvedProject
    readonly route: ToranjaRoleRoute
    readonly prompt: ContentBlock[]
    readonly label: string
    readonly parent: Agent
    readonly signal: AbortSignal
    readonly delivery: 'caller' | 'parent'
    /** Treat an unverifiable working tree as a failure instead of skipping the check. */
    readonly strict?: boolean
  }): Promise<{ activation: SubagentActivation; providerName: string; verify: () => Promise<string | undefined> }> => {
    const instance = await instanceFor(request.route)
    const verify = await guardAccess(request.project, request.route.access, request.strict ?? false)
    const activation = await ctx.subagents.startActivation({
      provider: instance,
      label: request.label,
      request: {
        cwd: request.project.path,
        prompt: request.prompt,
        parent: request.parent,
      },
      signal: request.signal,
      delivery: request.delivery,
    })
    return { activation, providerName: instance, verify }
  }
  const reservation = (project: ResolvedProject, route: ToranjaRoleRoute, label: string) => ({
    project: project.id,
    provider: route.provider,
    role: route.role,
    label,
    model: route.model,
    effort: route.effort,
    access: route.access,
  })

  const availableRunProviders = (): ReadonlySet<RunProvider> => {
    const registered = new Set(ctx.subagents.list())
    const available = new Set<RunProvider>()
    for (const provider of RUN_PROVIDERS) {
      if (registered.has(providerName(provider))) {
        available.add(provider)
      }
    }
    return available
  }

  /** Provider a role uses when the caller names none: the mode, else the role preference with fallback. */
  const providerFor = (role: Role): RunProvider => {
    if (mode !== 'team') return mode
    return resolveFallbackProvider(
      roleProviders.get(role) ?? defaultProvider(role, mode),
      availableRunProviders(),
      fallbackOrder,
    )
  }

  const currentProjects = (): ResolvedProject[] => {
    const merged: ResolvedProject[] = [...configuredProjects]
    const usedIds = new Set(merged.map(project => project.id))
    const usedPaths = new Set(merged.map(project => normalizePathKey(project.path)))
    for (const workspace of ctx.workspaceRegistry.list()) {
      const pathKey = normalizePathKey(workspace.path)
      if (usedPaths.has(pathKey)) continue
      const title = workspace.title.trim() || basename(workspace.path) || 'Workspace'
      const id = slugifyProjectId(title, usedIds)
      usedIds.add(id)
      usedPaths.add(pathKey)
      merged.push({ id, title, path: workspace.path })
    }
    return merged
  }

  const findProject = (projectRef: string): ResolvedProject | undefined => {
    const normalized = projectRef.trim().toLowerCase()
    const lanes = currentProjects()
    return lanes.find(project =>
      project.id === projectRef.trim()
      || project.id.toLowerCase() === normalized
      || project.title.toLowerCase() === normalized,
    )
  }

  const readStatus = (): ToranjaOrchestrationStatus => {
    const registered = new Set(ctx.subagents.list())
    const lanes = currentProjects()
    return {
      generatedAt: new Date().toISOString(),
      mode,
      profile,
      fallbackOrder,
      active: ledger.activeCount,
      limits,
      projects: lanes.map(project => ({ ...project, metrics: ledger.project(project.id) })),
      providers: RUN_PROVIDERS.map(provider => ({
        id: provider,
        registryName: providerName(provider),
        available: registered.has(providerName(provider)),
        metrics: ledger.provider(provider),
      })),
      routes: ROLES.map(role => routeFor(role, providerFor(role))),
      tasks: ledger.tasks(),
    }
  }
  const validateAssignment = (request: {
    readonly project: string
    readonly role: Role
    readonly description: string
    readonly task: string
  }): { project: ResolvedProject; description: string; task: string } => {
    const project = findProject(request.project)
    if (project === undefined) throw new Error(`unknown Toranja project lane ${JSON.stringify(request.project)}`)
    const task = request.task.trim()
    if (task.length === 0) throw new Error('delegate_project_task requires a non-empty task')
    if (task.length > maxTaskChars) throw new Error(`delegate_project_task task exceeds ${maxTaskChars} characters`)
    const description = request.description.trim()
    if (description.length === 0) throw new Error('delegate_project_task requires a non-empty description')
    if (description.length > 80) throw new Error('delegate_project_task description exceeds 80 characters')
    return { project, description, task }
  }
  const startCodexAndWait = async (
    request: ToranjaCodexDelegationRequest,
  ): Promise<ToranjaCodexDelegationResult> => {
    assertProvidersAllowed(mode, ['codex'])
    const { project, description, task } = validateAssignment(request)
    const route = routeFor(request.role, 'codex')
    const [lease] = ledger.reserveBatch([reservation(project, route, description)])
    if (lease === undefined) throw new Error('toranja-orchestrator: missing Codex delegation reservation')
    try {
      const { activation, verify } = await launch({
        project,
        route,
        prompt: rolePrompt(project, route, task, profile),
        label: `${project.title}: ${description} (codex)`,
        parent: request.parent,
        signal: request.signal,
        delivery: 'caller',
      })
      const result = await activation.result
      const violation = await verify()
      const output = contentText(result.output).slice(0, 20_000)
      const success = result.stopReason === 'completed' && violation === undefined
      const diagnostic = violation ?? result.diagnostic
      lease.settle(success, diagnostic ?? (success ? undefined : result.stopReason))
      return {
        project: project.id,
        role: request.role,
        taskId: lease.taskId,
        subagentId: activation.childId,
        stopReason: result.stopReason,
        output,
        ...(diagnostic === undefined ? {} : { diagnostic }),
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Codex delegation infrastructure failure'
      lease.settle(false, message)
      throw error
    }
  }
  new ToranjaOrchestrator(
    ctx,
    currentProjects,
    readStatus,
    startCodexAndWait,
  )
  const controller = new ToranjaOrchestrationController(ctx, readStatus, (request) => {
    mode = request.mode
    if (request.profile !== undefined) profile = request.profile
    if (request.fallbackOrder !== undefined && request.fallbackOrder.length > 0) {
      fallbackOrder = request.fallbackOrder
    }
    return readStatus()
  })

  for (const project of configuredProjects) {
    if (!existsSync(project.path)) {
      ctx.logger.warn(`toranja-orchestrator: configured project path does not exist: ${project.path}`)
      continue
    }
    const workspace = await ctx.workspaceRegistry.create(project.path, project.title)
    if (workspace.title !== project.title) await workspace.setTitle(project.title)
  }

  ctx.tools.register(defineTool({
    name: 'list_project_lanes',
    description: 'List Toranja Harness project lanes, their exact working directories, available agent roles, and provider routing defaults.',
    parameters: {},
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    execute() {
      return Promise.resolve(JSON.stringify({
        projects: currentProjects(),
        roles: ROLES,
        providers: PROVIDERS,
        mode,
        profile,
        fallbackOrder,
        defaults: Object.fromEntries(ROLES.map(role => [role, providerFor(role)])),
        routes: ROLES.map(role => routeFor(role, providerFor(role))),
        limits,
      }))
    },
  }))

  ctx.tools.register(defineTool({
    name: 'get_orchestration_status',
    description: 'Inspect Toranja provider availability, active task counts, success/failure history, project capacity, and write-isolation policy without starting agents.',
    parameters: {},
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    execute() {
      return Promise.resolve(JSON.stringify(controller.status()))
    },
  }))

  ctx.tools.register(defineTool({
    name: 'delegate_project_task',
    description: 'Start a managed role-scoped task in one configured Toranja project. Select codex, antigravity, claude-code, openrouter, or both; both starts the two primary providers concurrently in the same project lane. The tool returns immediately and normal subtask updates deliver results.',
    parameters: {
      project: { type: 'string', required: true, description: 'Project lane id from list_project_lanes.' },
      role: { type: 'string', required: true, enum: [...ROLES], description: 'Responsibility and output contract for the delegated agent.' },
      provider: { type: 'string', enum: [...PROVIDERS], description: 'Provider choice. Omit to use the role default with automatic fallback.' },
      description: { type: 'string', required: true, description: 'Short 3-5 word label shown in the subtask UI.' },
      task: { type: 'string', required: true, description: 'Complete self-contained task and acceptance criteria.' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const parent = exec.agent
      if (parent === undefined) throw new Error('delegate_project_task requires a calling agent')
      const role = args.role
      const providerChoice = args.provider ?? providerFor(role)
      const selected: readonly RunProvider[] = providerChoice === 'both' ? ['codex', 'antigravity'] : [providerChoice]
      assertProvidersAllowed(mode, selected)
      const { project, description, task } = validateAssignment(args)
      const routes = selected.map(provider => routeFor(role, provider))
      const leases = ledger.reserveBatch(routes.map(route => reservation(project, route, description)))
      const results = await Promise.all(routes.map(async (route, index) => {
        const provider = route.provider
        const lease = requiredAt(leases, index, 'delegation reservation')
        try {
          const { activation, providerName: registryName, verify } = await launch({
            project,
            route,
            prompt: rolePrompt(project, route, task, profile),
            label: `${project.title}: ${description} (${provider})`,
            parent,
            signal: exec.signal,
            delivery: 'parent',
          })
          monitorActivation(activation, lease, verify)
          return {
            ok: true as const,
            provider,
            providerName: registryName,
            tier: route.tier,
            access: route.access,
            ...route.model === undefined ? {} : { model: route.model },
            ...route.effort === undefined ? {} : { effort: route.effort },
            taskId: lease.taskId,
            subagentId: activation.childId,
          }
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : 'unknown provider startup failure'
          lease.settle(false, message)
          return { ok: false as const, provider, providerName: providerName(provider), error: message.slice(0, 4096) }
        }
      }))
      const activations = results.filter(result => result.ok)
      const failures = results.filter(result => !result.ok)
      if (activations.length === 0) {
        throw new Error(`no project agent started: ${failures.map(failure => `${failure.provider}: ${failure.error}`).join('; ')}`)
      }
      return JSON.stringify({ project: project.id, role, activations, failures })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'run_delivery_gate',
    description: 'Run the Toranja release gate for one project. A reviewer and a tester, routed by the current mode and role preferences, independently inspect the current repository without editing tracked files. The tool waits for both and passes only when both return an explicit PASS verdict.',
    parameters: {
      project: { type: 'string', required: true, description: 'Project lane id from list_project_lanes.' },
      implementationSummary: { type: 'string', required: true, description: 'What changed, including relevant files and claimed validation.' },
      acceptanceCriteria: { type: 'string', required: true, description: 'Concrete conditions that must all hold before delivery.' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const parent = exec.agent
      if (parent === undefined) throw new Error('run_delivery_gate requires a calling agent')
      const project = findProject(args.project)
      if (project === undefined) throw new Error(`unknown Toranja project lane ${JSON.stringify(args.project)}`)
      const implementationSummary = args.implementationSummary.trim()
      const acceptanceCriteria = args.acceptanceCriteria.trim()
      if (implementationSummary.length === 0 || acceptanceCriteria.length === 0) {
        throw new Error('run_delivery_gate requires a non-empty implementation summary and acceptance criteria')
      }
      if (implementationSummary.length + acceptanceCriteria.length > maxTaskChars) {
        throw new Error(`run_delivery_gate input exceeds ${maxTaskChars} characters`)
      }
      if (ledger.hasActiveWriter(project.id)) {
        throw new Error(`run_delivery_gate: an implementer is still active in project ${project.id}; run the gate after it settles`)
      }
      const routes = (['reviewer', 'tester'] as const).map(role => ({ role, route: routeFor(role, providerFor(role)) }))
      const leases = ledger.reserveBatch(routes.map(({ route }) => reservation(project, route, `Portão de entrega: ${route.role}`)))
      const starts = await Promise.all(routes.map(async ({ role, route }, index): Promise<GateRun | GateResult> => {
        const provider = route.provider
        try {
          const { activation, providerName: registryName, verify } = await launch({
            project,
            route,
            prompt: gatePrompt(project, role, implementationSummary, acceptanceCriteria),
            label: `${project.title}: delivery ${role} (${provider})`,
            parent,
            signal: exec.signal,
            delivery: 'caller',
            strict: true,
          })
          return { role, provider, providerName: registryName, activation, verify }
        } catch (error: unknown) {
          const diagnostic = error instanceof Error ? error.message : 'unknown provider startup failure'
          requiredAt(leases, index, 'delivery gate reservation').settle(false, diagnostic)
          return {
            role,
            provider,
            providerName: providerName(provider),
            subagentId: '',
            stopReason: 'startup-error',
            verdict: 'invalid',
            output: '',
            diagnostic: diagnostic.slice(0, 4096),
          }
        }
      }))
      const results = await Promise.all(starts.map(async (start, index): Promise<GateResult> => {
        if ('stopReason' in start) return start
        try {
          const result = await start.activation.result
          const output = contentText(result.output).slice(0, 20_000)
          const violation = await start.verify()
          const verdict = violation === undefined ? parseGateVerdict(output) : 'invalid'
          const successful = result.stopReason === 'completed' && verdict === 'pass'
          const diagnostic = violation ?? result.diagnostic
          requiredAt(leases, index, 'delivery gate reservation')
            .settle(successful, diagnostic ?? (successful ? undefined : `${result.stopReason}/${verdict}`))
          return {
            role: start.role,
            provider: start.provider,
            providerName: start.providerName,
            subagentId: start.activation.childId,
            stopReason: result.stopReason,
            verdict,
            output,
            ...(diagnostic === undefined ? {} : { diagnostic }),
          }
        } catch (error: unknown) {
          const diagnostic = error instanceof Error ? error.message : 'subagent result infrastructure failure'
          requiredAt(leases, index, 'delivery gate reservation').settle(false, diagnostic)
          return {
            role: start.role,
            provider: start.provider,
            providerName: start.providerName,
            subagentId: start.activation.childId,
            stopReason: 'infrastructure-error',
            verdict: 'invalid',
            output: '',
            diagnostic: diagnostic.slice(0, 4096),
          }
        }
      }))
      const passed = results.every(result => result.stopReason === 'completed' && result.verdict === 'pass')
      return JSON.stringify({
        project: project.id,
        passed,
        decision: passed ? 'ready' : 'not-ready',
        results,
      })
    },
  }))

  ctx.systemPrompt.section({
    name: 'toranja:orchestration',
    order: ctx.systemPrompt.getSectionOrder('TOOL_SUBAGENT'),
    text: 'Toranja Harness manages named project lanes. Use `list_project_lanes` instead of guessing paths and `get_orchestration_status` before expensive parallel work. Use `delegate_project_task` so every child starts in the correct repository with an explicit role. The Toranja Agents panel is authoritative: Solo Codex permits only Codex, Solo Antigravity permits only Antigravity, and Team permits role-aware cross-provider collaboration. In Team mode, the primary agent remains responsible for reviewing and consolidating delegated results. Independent read-only work should start together. Use provider `both` only when independent cross-provider verification materially improves confidence; otherwise respect the selected routing mode to avoid duplicate credit use. Toranja write isolation rejects simultaneous implementers in the same worktree. For material multi-step deliveries, mirror the plan on the durable Team task board with dependencies and write scopes. Before reporting such work complete, call `run_delivery_gate`; report completion only when its decision is `ready`, and route a `not-ready` finding back to an implementer before running the gate again.',
  })
}
