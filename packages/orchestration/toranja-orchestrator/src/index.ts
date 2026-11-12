/**
 * Toranja-owned project catalog and role-based delegation surface.
 *
 * @module @deepseek-ai/dsh-toranja-orchestrator
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { readFile, stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { ReasoningEffortId, type ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SubagentActivation, SubagentResult } from '@deepseek-ai/dsh-subagent'
import * as antigravityPlugin from '@deepseek-ai/dsh-subagent-antigravity'
import * as claudeCodePlugin from '@deepseek-ai/dsh-subagent-claude-code'
import * as codexPlugin from '@deepseek-ai/dsh-subagent-codex'
import type {} from '@deepseek-ai/dsh-storage-domain'
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
  type ReservationLease,
  type Role,
  type RunProvider,
} from './policy.ts'
import {
  CLI_PROVIDERS,
  DEFAULT_EXECUTABLES,
  LOGIN_COMMANDS,
  STATUS_COMMANDS,
  commandArgv,
  findExecutable,
  terminalArgv,
  type ProviderConnection,
} from './connection.ts'
import {
  MODEL_TIERS,
  READ_ONLY_ENFORCEMENT,
  accessViolation,
  isProviderFailure,
  resolveRoute,
  roleAccess,
  variantConfig,
  variantName,
  type ProviderModels,
  type WorkspaceFingerprint,
} from './routing.ts'
import type {
  ToranjaAgentMode,
  ToranjaAgentModeRequest,
  ToranjaSettingsRequest,
  ToranjaConnectRequest,
  ToranjaConnectResult,
  ToranjaLegacyModeRequest,
  ToranjaExecutionProfile,
  ToranjaOrchestrationStatus,
  ToranjaProviderId,
  ToranjaRoleAccess,
  ToranjaRoleRoute,
} from './types.ts'
import { toranjaOrchestrationDomain, type ToranjaOrchestrationState } from './state.ts'
import {
  ToranjaOrchestrator,
  type ToranjaCodexDelegationRequest,
  type ToranjaCodexDelegationResult,
} from './service.ts'

export * from './connection.ts'
export * from './policy.ts'
export * from './routing.ts'
export * from './service.ts'
export * from './state.ts'
export * from './types.ts'

export const name = 'toranja-orchestrator'
export const inject = ['storageDomain', 'subagents', 'subprocess', 'systemPrompt', 'tools', 'workspaceRegistry']

const PROJECT_ID = /^[a-z][a-z0-9-]{1,31}$/
const DEFAULT_MAX_TASK_CHARS = 12_000
const GIT_GRACE_MS = 3_000

/** Provider plugins Toranja can instantiate per route to fix model, effort, and access. */
const VARIANT_PLUGINS = {
  codex: codexPlugin,
  antigravity: antigravityPlugin,
  'claude-code': claudeCodePlugin,
} as const
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
  /** Largest team size the user may set; it bounds how far the team size raises the concurrency limits. */
  maxTeamSize?: number
  /**
   * Run each implementer in a Git worktree and branch of its own instead of
   * the project's working tree, so implementers can work at the same time and
   * a change waits on its branch for review. Off by default.
   */
  implementerWorktrees?: boolean
  /** Directory the implementer worktrees are created under; by default `.toranja-worktrees` beside each project. */
  worktreeRoot?: string
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
  /**
   * Route the delivery-gate reviewer to a provider other than the one that
   * implemented the change whenever another provider is connected.
   */
  crossReview?: boolean
  /**
   * When a delivery gate returns an explicit `FAIL`, start a planner with the
   * gate evidence so the change returns to planning.
   */
  replanOnGateFailure?: boolean
  /**
   * Executable of each CLI provider (`codex`, `antigravity`, `claude-code`),
   * as a command name searched in `PATH` or an absolute path.
   */
  executables?: Record<string, string>
  /** Probe the provider CLIs once when the plugin starts. */
  probeOnStart?: boolean
  /** Time limit of one provider status command, in milliseconds. */
  probeTimeoutMs?: number
  /** LLM provider id that OpenRouter tasks select on the internal agent. */
  openrouterLlmProvider?: string
  /** Credential reference holding the OpenRouter API key. */
  openrouterKeyRef?: string
  /**
   * Let OpenRouter run `read-only` and `execute` roles. The internal agent it
   * runs on has no mode that prevents writing, so by default it takes only the
   * `write` role; with this set, the working-tree check is the only safeguard.
   */
  openrouterUnenforcedAccess?: boolean
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
  maxTeamSize: z.number().default(8),
  implementerWorktrees: z.boolean().default(false),
  worktreeRoot: z.string().min(1),
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
  crossReview: z.boolean().default(true),
  replanOnGateFailure: z.boolean().default(true),
  executables: z.dict(z.string().min(1)).default({}),
  probeOnStart: z.boolean().default(false),
  probeTimeoutMs: z.number().default(20_000),
  openrouterLlmProvider: z.string().min(1).default('openrouter'),
  openrouterKeyRef: z.string().min(1).default('OPENROUTER_API_KEY'),
  openrouterUnenforcedAccess: z.boolean().default(false),
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
    private readonly write: (
      request: ToranjaSettingsRequest & { readonly mode?: ToranjaAgentMode },
    ) => Promise<ToranjaOrchestrationStatus>,
    private readonly adoptMode: (mode: ToranjaAgentMode) => Promise<ToranjaOrchestrationStatus>,
    private readonly probe: () => Promise<ToranjaOrchestrationStatus>,
    private readonly connect: (request: ToranjaConnectRequest) => ToranjaConnectResult,
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
   * Change the routing mode, optionally together with other settings, and
   * store the result durably.
   * @param request - Target routing mode and the optional settings to replace.
   * @returns Updated orchestration snapshot, after the change is durable.
   */
  @Remote
  setMode(request: ToranjaAgentModeRequest): Promise<ToranjaOrchestrationStatus> {
    return this.write(request)
  }

  /**
   * Change the execution profile, fallback order, provider per role,
   * cross-review setting, team size, or tier models, and store the result
   * durably. The routing mode is left as stored, so a caller holding an older
   * snapshot does not undo a mode chosen meanwhile. A change applies to tasks
   * started afterwards; a running task keeps the route it started with.
   * @param request - The settings to replace; omitted ones keep their value.
   * @returns Updated orchestration snapshot, after the change is durable.
   */
  @Remote
  updateSettings(request: ToranjaSettingsRequest): Promise<ToranjaOrchestrationStatus> {
    // Remote input is untyped at run time: a `mode` slipped into this request
    // must not change the routing mode.
    const { mode: _mode, ...settings } = request as ToranjaSettingsRequest & { readonly mode?: unknown }
    return this.write(settings)
  }

  /**
   * Look for each provider CLI and run its official status command, then
   * route around providers that are not installed or signed out.
   * @returns Orchestration snapshot with the refreshed connection states.
   */
  @Remote
  probeProviders(): Promise<ToranjaOrchestrationStatus> {
    return this.probe()
  }

  /**
   * Open the provider's official sign-in command in a terminal window. The
   * user completes the sign-in there; call {@link probeProviders} afterwards to
   * read the result. Toranja never sees the account credentials.
   * @param request - Provider to sign in to.
   * @returns The command that was opened.
   */
  @Remote
  connectProvider(request: ToranjaConnectRequest): ToranjaConnectResult {
    return this.connect(request)
  }

  /**
   * Store the routing mode that an earlier client version kept in browser
   * storage. It applies only while no mode is stored, so repeating the call or
   * calling it after the user chose a mode changes nothing.
   * @param request - Mode read from the earlier client's browser storage.
   * @returns Orchestration snapshot after the mode was adopted or ignored.
   */
  @Remote
  adoptLegacyMode(request: ToranjaLegacyModeRequest): Promise<ToranjaOrchestrationStatus> {
    return this.adoptMode(request.mode)
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

/** One provider that was tried before the provider that ran the task. */
interface FallbackAttempt {
  readonly provider: RunProvider
  readonly error: string
}

/** A role-scoped task and how its child is started on whichever provider accepts it. */
interface RoutedRequest {
  readonly project: ResolvedProject
  readonly role: Role
  readonly description: string
  readonly prompt: (route: ToranjaRoleRoute) => ContentBlock[]
  readonly label: (provider: RunProvider) => string
  readonly parent: Agent
  readonly signal: AbortSignal
  readonly delivery: 'caller' | 'parent'
  readonly strict?: boolean
  /** Worktree the run works in instead of the project's own tree. */
  readonly lane?: IsolatedLane
}

/** Git worktree and branch created for one implementer. */
interface IsolatedLane {
  readonly project: ResolvedProject
  readonly path: string
  readonly branch: string
  /** Commit the worktree started from. */
  readonly base: string
  /** Git directory of the worktree, read before any agent ran in it. */
  readonly gitDir: string
}

interface StartedRun {
  readonly activation: SubagentActivation
  readonly providerName: string
  readonly verify: () => Promise<string | undefined>
  readonly route: ToranjaRoleRoute
  readonly lease: ReservationLease
  readonly fallbackFrom: readonly FallbackAttempt[]
  readonly remaining: readonly RunProvider[]
  readonly request: RoutedRequest
}

/** Final state of a routed task after any rerun on another provider. */
interface RoutedOutcome {
  /** The run that produced the outcome; a rerun replaces the original. */
  readonly run: StartedRun
  /** Settled result, or `undefined` when the result itself could not be read. */
  readonly result?: SubagentResult
  /** Forbidden working-tree change, when the access check found one. */
  readonly violation?: string
  /** Infrastructure failure while reading the result. */
  readonly error?: string
}

/** Every candidate provider refused to start the task. */
class RoutedStartError extends Error {
  constructor(readonly attempts: readonly FallbackAttempt[]) {
    super(attempts.map(attempt => `${attempt.provider}: ${attempt.error}`).join('; '))
  }
}

/** Routing choices in force: the stored user choices over the deployment defaults. */
interface LiveSettings {
  readonly mode: ToranjaAgentMode
  readonly profile: ToranjaExecutionProfile
  readonly fallbackOrder: readonly ToranjaProviderId[]
  readonly roleProviders: ReadonlyMap<Role, RunProvider>
  readonly crossReview: boolean
  readonly teamSize: number
  /** Tier models in force per provider: the user's over the deployment's. */
  readonly models: ReadonlyMap<RunProvider, ProviderModels>
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
    // `base` reaches here unvalidated (the schema accepts any value), so its
    // declared type is not trusted.
    const base: unknown = value.base
    if (base !== undefined && (typeof base !== 'object' || base === null || Array.isArray(base))) {
      throw new Error(`toranja-orchestrator: routing.${key}.base must be a mapping`)
    }
    if (value.base !== undefined && !isVariantProvider(provider)) {
      throw new Error(`toranja-orchestrator: routing.${key}.base is not supported; ${key} has no Toranja-owned instances`)
    }
    // OpenRouter runs on the internal agent, which takes its model per start
    // and needs no provider instance of its own.
    if (value.base === undefined && provider !== 'openrouter' && Object.keys(models).length > 0) {
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

interface GateResult {
  readonly role: 'reviewer' | 'tester'
  readonly provider: RunProvider
  readonly providerName: string
  readonly subagentId: string
  readonly fallbackFrom?: readonly FallbackAttempt[]
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
  const configuredLimits = {
    maxConcurrentTotal: positiveInteger('maxConcurrentTotal', config.maxConcurrentTotal ?? 4),
    maxConcurrentPerProject: positiveInteger('maxConcurrentPerProject', config.maxConcurrentPerProject ?? 2),
    maxConcurrentPerProvider: positiveInteger('maxConcurrentPerProvider', config.maxConcurrentPerProvider ?? 2),
    allowParallelImplementation: config.allowParallelImplementation ?? false,
  }
  // The team size is the number of agents working in one project at once. The
  // total and per-provider limits never fall below it, so a team the user
  // sized can actually run, even on a single connected provider.
  const limitsFor = (teamSize: number): typeof configuredLimits => ({
    maxConcurrentTotal: Math.max(configuredLimits.maxConcurrentTotal, teamSize),
    maxConcurrentPerProject: teamSize,
    maxConcurrentPerProvider: Math.max(configuredLimits.maxConcurrentPerProvider, teamSize),
    allowParallelImplementation: configuredLimits.allowParallelImplementation,
  })
  // The deployment's own default team size is never above the limit it reports.
  const maxTeamSize = Math.max(
    positiveInteger('maxTeamSize', config.maxTeamSize ?? 8),
    configuredLimits.maxConcurrentPerProject,
  )
  const ledger = new OrchestrationLedger(() => limitsFor(live().teamSize))
  const domain = await ctx.storageDomain.open(toranjaOrchestrationDomain)
  ctx.effect(() => () => domain.close(), 'toranja-orchestrator.domainClose')
  const routing = parseRouting(config)
  /** Check a fallback order: every entry a known provider, none repeated. */
  const parseFallbackOrder = (order: readonly string[]): ToranjaProviderId[] => order.map((key, index) => {
    const provider = RUN_PROVIDERS.find(candidate => candidate === key)
    if (provider === undefined) throw new Error(`toranja-orchestrator: fallbackOrder names unknown provider ${JSON.stringify(key)}`)
    if (order.indexOf(key) !== index) throw new Error(`toranja-orchestrator: fallbackOrder repeats ${provider}`)
    return provider
  })
  /**
   * Whether tier models reach a provider's tasks: Toranja starts its own
   * instance of the provider per model, or the provider takes the model per
   * task as OpenRouter does.
   */
  const tierModelsEditable = (provider: RunProvider): boolean =>
    provider === 'openrouter' || (isVariantProvider(provider) && routing.get(provider)?.base !== undefined)
  /** Tier models in force: per tier, what the user stored over the deployment table. */
  const modelsInForce = (stored: ToranjaOrchestrationState['tierModels']): Map<RunProvider, ProviderModels> =>
    new Map(RUN_PROVIDERS.map((provider) => {
      const editable = tierModelsEditable(provider)
      return [provider, {
        ...editable ? routing.get(provider)?.models : {},
        ...editable ? stored?.[provider] : {},
      }]
    }))
  const defaults = {
    mode: config.defaultMode ?? 'team',
    profile: config.defaultProfile ?? 'equilibrado',
    fallbackOrder: config.fallbackOrder === undefined ? RUN_PROVIDERS : parseFallbackOrder(config.fallbackOrder),
    roleProviders: parseRoleProviders(config),
    crossReview: config.crossReview ?? true,
    teamSize: configuredLimits.maxConcurrentPerProject,
    models: modelsInForce(undefined),
  } satisfies LiveSettings
  // The stored global is the only source of the live routing: every reader
  // resolves it over the deployment defaults, so a change is visible to
  // routing the moment the storage domain holds it, never before or after.
  let resolvedFrom: ToranjaOrchestrationState | undefined
  let resolved: LiveSettings = defaults
  const live = (): LiveSettings => {
    const stored = domain.global.get()
    if (stored !== resolvedFrom) {
      resolvedFrom = stored
      resolved = {
        mode: stored.mode ?? defaults.mode,
        profile: stored.profile ?? defaults.profile,
        // An order stored by an earlier version may repeat a provider.
        fallbackOrder: stored.fallbackOrder === undefined ? defaults.fallbackOrder : [...new Set(stored.fallbackOrder)],
        roleProviders: stored.roleProviders === undefined
          ? defaults.roleProviders
          : parseRoleProviders({ roleProviders: stored.roleProviders }),
        crossReview: stored.crossReview ?? defaults.crossReview,
        // The deployment may have lowered the limit since the size was stored.
        teamSize: Math.min(stored.teamSize ?? defaults.teamSize, maxTeamSize),
        models: stored.tierModels === undefined ? defaults.models : storedModelsInForce(stored.tierModels),
      }
    }
    return resolved
  }
  const replanOnGateFailure = config.replanOnGateFailure ?? true
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

  const routeFor = (role: Role, provider: RunProvider): ToranjaRoleRoute =>
    resolveRoute(role, live().profile, provider, live().models.get(provider) ?? {})
  /**
   * Check that every instance a tier table can lead to has a valid provider
   * configuration, so a model or effort the provider rejects fails when it is
   * set and not when a task first needs it.
   */
  const validateVariants = (provider: RunProvider, models: ProviderModels): void => {
    const base = routing.get(provider)?.base
    if (base === undefined || !isVariantProvider(provider)) return
    for (const role of ROLES) {
      for (const candidate of ['economico', 'equilibrado', 'qualidade'] as const) {
        const route = resolveRoute(role, candidate, provider, models)
        VARIANT_PLUGINS[provider].Config(variantConfig(provider, base, route, variantName(providerName(provider), route)))
      }
    }
  }
  for (const [provider, entry] of routing) validateVariants(provider, entry.models)
  /**
   * Tier models in force from a stored table. A provider whose stored models
   * its current configuration no longer accepts falls back to the deployment
   * table, with a warning, so routing keeps working after such a change.
   */
  const storedModelsInForce = (stored: NonNullable<ToranjaOrchestrationState['tierModels']>): Map<RunProvider, ProviderModels> => {
    const models = modelsInForce(stored)
    for (const provider of RUN_PROVIDERS) {
      if (stored[provider] === undefined) continue
      try {
        validateVariants(provider, models.get(provider) ?? {})
      } catch (error: unknown) {
        ctx.logger.warn(`toranja-orchestrator: stored tier models of ${provider} are no longer valid and are ignored: ${String(error)}`)
        models.set(provider, defaults.models.get(provider) ?? {})
      }
    }
    return models
  }
  /** Validate the tier models of a settings request and return them trimmed. */
  const parseTierModels = (
    requested: NonNullable<ToranjaAgentModeRequest['tierModels']>,
  ): NonNullable<ToranjaOrchestrationState['tierModels']> => {
    const parsed: NonNullable<ToranjaOrchestrationState['tierModels']> = {}
    for (const [key, table] of Object.entries(requested)) {
      const provider = RUN_PROVIDERS.find(candidate => candidate === key)
      if (provider === undefined) throw new Error(`toranja-orchestrator: tierModels names unknown provider ${JSON.stringify(key)}`)
      if (!tierModelsEditable(provider)) {
        throw new Error(`toranja-orchestrator: tierModels.${provider} cannot be set; the deployment gives Toranja no instance of ${provider} to apply a model to`)
      }
      const models: Partial<Record<typeof MODEL_TIERS[number], { model?: string; effort?: string }>> = {}
      for (const [tierKey, entry] of Object.entries(table)) {
        const tier = MODEL_TIERS.find(candidate => candidate === tierKey)
        if (tier === undefined) throw new Error(`toranja-orchestrator: tierModels.${provider} names unknown tier ${JSON.stringify(tierKey)}`)
        const text = (field: 'model' | 'effort'): string | undefined => {
          const value: unknown = entry[field]
          if (value === undefined) return undefined
          if (typeof value !== 'string' || value.trim().length === 0) {
            throw new Error(`toranja-orchestrator: tierModels.${provider}.${tier}.${field} must not be empty`)
          }
          return value.trim()
        }
        const model = text('model')
        const effort = text('effort')
        models[tier] = { ...model === undefined ? {} : { model }, ...effort === undefined ? {} : { effort } }
      }
      validateVariants(provider, { ...routing.get(provider)?.models, ...models })
      parsed[provider] = models
    }
    return parsed
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

  // The repository belongs to the agents being checked, so nothing its own Git
  // configuration names may run on the Host: no file-system monitor, hooks
  // looked up in a directory the Host owns and keeps empty, and no lock or
  // index refresh a reading command would otherwise take. Git itself is
  // resolved once from PATH, never from the project directory.
  const noHooks = mkdtempSync(join(tmpdir(), 'toranja-no-hooks-'))
  ctx.effect(() => () => { rmSync(noHooks, { recursive: true, force: true }) }, 'toranja-orchestrator.noHooks')
  const gitExecutable = findExecutable('git') ?? 'git'
  const gitOutput = async (
    cwd: string,
    args: readonly string[],
    overrides: readonly string[] = [],
  ): Promise<Buffer | undefined> => {
    const child = ctx.subprocess.spawn({
      argv: [
        gitExecutable, '--no-optional-locks',
        '-c', 'core.fsmonitor=false', '-c', `core.hooksPath=${noHooks}`,
        ...overrides.flatMap(override => ['-c', override]),
        ...args,
      ],
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
  /**
   * Overrides that switch off every content filter Git would apply in a
   * repository, read from all configuration scopes (repository, per-worktree,
   * includes, and the user's own). Reading the configuration runs nothing. A
   * clean, smudge, or process filter would otherwise run on the Host whenever
   * Git reads or checks out a file. A filter stays usable by the repository:
   * `required` is switched off too, so Git does not abort on the emptied
   * command, as it would for Git LFS.
   * @param scope - Git arguments selecting the repository, placed before the command.
   * @returns The overrides and the filter names, or undefined when the
   *   configuration cannot be read or names a filter `-c` cannot override.
   */
  const filtersOff = async (
    cwd: string,
    scope: readonly string[] = [],
  ): Promise<{ readonly overrides: readonly string[]; readonly names: readonly string[] } | undefined> => {
    const listed = await gitOutput(cwd, [...scope, 'config', '--includes', '--null', '--list'])
    if (listed === undefined) return undefined
    const names = new Set<string>()
    for (const entry of listed.toString('utf8').split('\0')) {
      const key = entry.split('\n', 1)[0] ?? ''
      const name = /^filter\.(.+)\.(?:clean|smudge|process|required)$/u.exec(key)?.[1]
      if (name === undefined) continue
      // `-c key=value` splits at the first `=`, so such a filter could not be
      // switched off; the tree is then treated as unreadable.
      if (name.includes('=')) return undefined
      names.add(name)
    }
    const sorted = [...names].sort()
    return {
      names: sorted,
      overrides: sorted.flatMap(name => [
        `filter.${name}.clean=`, `filter.${name}.smudge=`, `filter.${name}.process=`, `filter.${name}.required=false`,
      ]),
    }
  }
  const fingerprint = async (cwd: string): Promise<WorkspaceFingerprint | undefined> => {
    try {
      const filters = await filtersOff(cwd)
      if (filters === undefined) return undefined
      const off = filters.overrides
      const [tracked, untracked, ignored, index] = await Promise.all([
        // A submodule would be inspected with its own configuration, which is not read here.
        gitOutput(cwd, ['diff', '--no-ext-diff', '--no-textconv', '--ignore-submodules=all', 'HEAD', '--binary'], off),
        gitOutput(cwd, ['ls-files', '--others', '--exclude-standard', '-z'], off),
        gitOutput(cwd, ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z'], off),
        gitOutput(cwd, ['ls-files', '-v', '-z'], off),
      ])
      if (tracked === undefined || untracked === undefined || ignored === undefined || index === undefined) return undefined
      // `ls-files -v` tags a file Git was told to skip with a lowercase letter
      // (assume-unchanged) or `S` (skip-worktree). The diff above does not see
      // such a file, so its flag and its content are compared here.
      const hidden = index.toString('utf8').split('\0').filter(entry => /^[a-zS] /u.test(entry))
      const state = createHash('sha256').update(filters.names.join('\0')).update('\0\0')
      for (const entry of hidden) {
        const content = await readFile(join(cwd, entry.slice(2))).then(
          bytes => createHash('sha256').update(bytes).digest('hex'),
          () => 'missing',
        )
        state.update(`${entry}\0${content}\0`)
      }
      return {
        tracked: createHash('sha256').update(tracked).digest('hex'),
        untracked: await untrackedHash(cwd, [untracked, ignored]),
        state: state.digest('hex'),
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
   * could not be verified, and any other run reports nothing. The same holds
   * when the directory is not a Git work tree with a commit or Git fails.
   */
  const guardAccess = async (
    project: ResolvedProject,
    access: ToranjaRoleAccess,
    strict: boolean,
  ): Promise<() => Promise<string | undefined>> => {
    const unverifiable = strict
      ? 'access could not be verified: an implementer ran in the project during this run'
      : undefined
    const unreadable = strict
      ? 'access could not be verified: the working tree could not be read'
      : undefined
    if (access === 'write') return () => Promise.resolve(undefined)
    if (ledger.hasActiveWriter(project.id)) return () => Promise.resolve(unverifiable)
    const writersBefore = ledger.writerStartCount(project.id)
    const before = await fingerprint(project.path)
    if (before === undefined) return () => Promise.resolve(unreadable)
    return async () => {
      if (ledger.writerStartCount(project.id) !== writersBefore) return unverifiable
      const after = await fingerprint(project.path)
      if (after === undefined) return unreadable
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
    const { route } = request
    if (!canRun(route.provider, route.role)) {
      throw new Error(`toranja-orchestrator: OpenRouter cannot be kept from writing, so it does not run the ${route.access} role ${route.role}; set openrouterUnenforcedAccess to accept that`)
    }
    if (route.provider === 'openrouter' && route.model === undefined) {
      throw new Error(`toranja-orchestrator: routing.openrouter.models has no model for the ${route.tier} tier`)
    }
    const verify = await guardAccess(request.project, request.route.access, request.strict ?? false)
    const activation = await ctx.subagents.startActivation({
      provider: instance,
      label: request.label,
      request: {
        cwd: request.project.path,
        prompt: request.prompt,
        parent: request.parent,
        ...route.provider !== 'openrouter' || route.model === undefined
          ? {}
          : {
            agentOptions: {
              provider: openrouterLlmProvider,
              model: route.model,
              ...route.effort === undefined ? {} : { reasoningEffort: ReasoningEffortId(route.effort) },
            },
          },
      },
      signal: request.signal,
      delivery: request.delivery,
    })
    return { activation, providerName: instance, verify }
  }
  const reservation = (project: ResolvedProject, route: ToranjaRoleRoute, label: string, lane?: IsolatedLane) => ({
    project: project.id,
    provider: route.provider,
    role: route.role,
    label,
    model: route.model,
    effort: route.effort,
    access: route.access,
    worktree: lane?.path,
    branch: lane?.branch,
  })

  const implementerWorktrees = config.implementerWorktrees ?? false
  const worktreeRoot = config.worktreeRoot
  if (worktreeRoot !== undefined && !isAbsolute(worktreeRoot)) {
    throw new Error('toranja-orchestrator: worktreeRoot must be an absolute path')
  }
  let laneSequence = 0
  // Worktrees whose implementer has not settled. When the plugin stops, the
  // ones left untouched are removed; one with work in it is kept.
  const lanes = new Set<IsolatedLane>()
  ctx.effect(() => async () => {
    for (const lane of [...lanes]) await releaseLane(lane)
  }, 'toranja-orchestrator.worktrees')
  /**
   * Create a worktree and branch of the project's current commit for one
   * implementer. Returns undefined when the project is not a Git work tree
   * with a commit or Git refuses, and the implementer then runs in the
   * project's own tree under the one-implementer-at-a-time rule.
   */
  const isolate = async (project: ResolvedProject): Promise<IsolatedLane | undefined> => {
    if (!implementerWorktrees) return undefined
    const name = `${Date.now().toString(36)}-${(++laneSequence).toString(36)}`
    const path = join(worktreeRoot ?? join(dirname(project.path), '.toranja-worktrees'), project.id, name)
    const branch = `toranja/${name}`
    try {
      const head = await gitOutput(project.path, ['rev-parse', 'HEAD'])
      // The checkout would run the repository's smudge filters on the Host.
      const filters = await filtersOff(project.path)
      if (head === undefined || filters === undefined) return undefined
      const added = await gitOutput(project.path, ['worktree', 'add', '-q', '-b', branch, path, 'HEAD'], filters.overrides)
      const gitDir = added === undefined ? undefined : await gitOutput(path, ['rev-parse', '--absolute-git-dir'])
      if (gitDir === undefined) {
        // A refused or half-made worktree must not stay registered.
        await gitOutput(project.path, ['worktree', 'remove', '--force', path])
        await gitOutput(project.path, ['branch', '-D', branch])
        return undefined
      }
      const lane = { project, path, branch, base: head.toString('utf8').trim(), gitDir: gitDir.toString('utf8').trim() }
      lanes.add(lane)
      return lane
    } catch (error: unknown) {
      ctx.logger.warn(`toranja-orchestrator: worktree for project ${project.id} could not be created: ${String(error)}`)
      return undefined
    }
  }
  /**
   * Remove the worktree and branch of an implementer that left nothing
   * behind. One with changes, commits, or files Git ignores is kept for
   * review and merge. The worktree is inspected through the Git directory
   * recorded when it was created, never through the `.git` entry the
   * implementer could have replaced, and with the repository's filters off.
   * @returns Whether the worktree was removed.
   */
  const releaseLane = async (lane: IsolatedLane): Promise<boolean> => {
    lanes.delete(lane)
    try {
      const scope = [`--git-dir=${lane.gitDir}`, `--work-tree=${lane.path}`]
      const filters = await filtersOff(lane.project.path, scope)
      if (filters === undefined) return false
      const [changes, head] = await Promise.all([
        gitOutput(lane.project.path, [...scope, 'status', '--porcelain', '--ignored'], filters.overrides),
        gitOutput(lane.project.path, [...scope, 'rev-parse', 'HEAD']),
      ])
      if (changes === undefined || head === undefined) return false
      if (changes.length > 0 || head.toString('utf8').trim() !== lane.base) return false
      if (await gitOutput(lane.project.path, ['worktree', 'remove', '--force', lane.path]) === undefined) return false
      await gitOutput(lane.project.path, ['branch', '-D', lane.branch])
      return true
    } catch (error: unknown) {
      ctx.logger.warn(`toranja-orchestrator: worktree ${lane.path} could not be inspected: ${String(error)}`)
      return false
    }
  }

  /**
   * Providers to try for a role, in order. Only a Team-mode delegation that
   * named no provider may move to another connected provider.
   */
  const candidatesFor = (first: RunProvider, allowFallback: boolean, role: Role): readonly RunProvider[] => {
    if (!allowFallback || live().mode !== 'team') return [first]
    const available = availableRunProviders()
    return [
      first,
      ...live().fallbackOrder.filter(provider => provider !== first && available.has(provider) && canRun(provider, role)),
    ]
  }
  /**
   * Start a role on the first candidate provider that accepts it. Each refused
   * candidate settles its own ledger task as failed and is reported in
   * `fallbackFrom`; when every candidate refuses, the rejection carries them all.
   */
  const startRouted = async (
    request: RoutedRequest,
    providers: readonly RunProvider[],
    firstLease?: ReservationLease,
    attempted: readonly FallbackAttempt[] = [],
  ): Promise<StartedRun> => {
    const fallbackFrom = [...attempted]
    let lease = firstLease
    for (const [index, provider] of providers.entries()) {
      const route = routeFor(request.role, provider)
      try {
        lease ??= requiredAt(
          ledger.reserveBatch([reservation(request.project, route, request.description, request.lane)]),
          0,
          'delegation reservation',
        )
        const launched = await launch({
          // An isolated implementer works in its worktree, not the project's tree.
          project: request.lane === undefined ? request.project : { ...request.project, path: request.lane.path },
          route,
          prompt: request.prompt(route),
          label: request.label(provider),
          parent: request.parent,
          signal: request.signal,
          delivery: request.delivery,
          ...request.strict === undefined ? {} : { strict: request.strict },
        })
        return { ...launched, route, lease, fallbackFrom, remaining: providers.slice(index + 1), request }
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : 'unknown provider startup failure'
        lease?.settle(false, message)
        lease = undefined
        fallbackFrom.push({ provider, error: message.slice(0, 4096) })
      }
    }
    throw new RoutedStartError(fallbackFrom)
  }

  /**
   * Await a routed run. When the provider itself failed and another candidate
   * remains, settle that task as failed and rerun the identical request on the
   * next candidate. The caller settles the lease of the returned run.
   */
  const awaitRouted = async (run: StartedRun): Promise<RoutedOutcome> => {
    let result: SubagentResult
    try {
      result = await run.activation.result
    } catch (error: unknown) {
      return { run, error: error instanceof Error ? error.message : 'subagent result infrastructure failure' }
    }
    const violation = await run.verify()
    // A write-capable run that failed midway leaves the working tree in an
    // unknown state, so only non-writing roles are rerun on another provider.
    if (
      result.stopReason !== 'completed'
      && violation === undefined
      && run.route.access !== 'write'
      && run.remaining.length > 0
      && isProviderFailure(result.diagnostic)
    ) {
      const error = (result.diagnostic ?? result.stopReason).slice(0, 4096)
      run.lease.settle(false, error)
      const attempted = [...run.fallbackFrom, { provider: run.route.provider, error }]
      try {
        return await awaitRouted(await startRouted(run.request, run.remaining, undefined, attempted))
      } catch (failure: unknown) {
        if (!(failure instanceof RoutedStartError)) throw failure
        return { run: { ...run, fallbackFrom: failure.attempts }, result }
      }
    }
    return { run, result, ...violation === undefined ? {} : { violation } }
  }

  /** Settle the ledger task of a run whose result is delivered to the parent agent. */
  const settleInBackground = (started: StartedRun): void => {
    void awaitRouted(started).then(async ({ run, result, violation, error }) => {
      const { lane } = run.request
      if (lane !== undefined && await releaseLane(lane)) ledger.dropWorktree(run.lease.taskId)
      run.lease.settle(
        result?.stopReason === 'completed' && violation === undefined,
        violation ?? error ?? result?.diagnostic ?? result?.stopReason,
      )
    })
  }

  const executables: Record<string, string> = { ...DEFAULT_EXECUTABLES, ...config.executables }
  for (const key of Object.keys(config.executables ?? {})) {
    if (!CLI_PROVIDERS.some(provider => provider === key)) {
      throw new Error(`toranja-orchestrator: executables names unknown CLI provider ${JSON.stringify(key)}`)
    }
  }
  const probeTimeoutMs = positiveInteger('probeTimeoutMs', config.probeTimeoutMs ?? 20_000)
  const connections = new Map<RunProvider, ProviderConnection>()
  const connectionOf = (provider: RunProvider): ProviderConnection =>
    connections.get(provider) ?? { connection: 'unknown' }
  /** A provider is usable unless a probe found its CLI missing or signed out. */
  const usable = (provider: RunProvider): boolean => {
    // OpenRouter has no default model: until one is routed it cannot run a task.
    if (provider === 'openrouter' && Object.keys(live().models.get('openrouter') ?? {}).length === 0) return false
    const { connection } = connectionOf(provider)
    return connection === 'connected' || connection === 'unknown'
  }
  const probeProvider = async (provider: typeof CLI_PROVIDERS[number]): Promise<ProviderConnection> => {
    const executable = findExecutable(executables[provider] ?? DEFAULT_EXECUTABLES[provider])
    if (executable === undefined) return { connection: 'not-installed' }
    const command = STATUS_COMMANDS[provider]
    try {
      const child = ctx.subprocess.spawn({
        argv: commandArgv(executable, command.args),
        cwd: process.cwd(),
        stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
        graceMs: GIT_GRACE_MS,
        signal: AbortSignal.timeout(probeTimeoutMs),
      })
      child.stderr?.resume()
      const chunks: Buffer[] = []
      for await (const chunk of child.stdout as NonNullable<typeof child.stdout>) chunks.push(chunk as Buffer)
      const outcome = await child.done
      const connected = command.connected(outcome.exitCode, Buffer.concat(chunks).toString('utf8'))
      return { connection: connected ? 'connected' : 'signed-out', executable }
    } catch (error: unknown) {
      // An unreadable status must not count as connected: the provider stays
      // out of routing until a later probe succeeds.
      ctx.logger.warn(`toranja-orchestrator: ${provider} status command failed: ${String(error)}`)
      return { connection: 'probe-failed', executable }
    }
  }
  const openrouterLlmProvider = config.openrouterLlmProvider ?? 'openrouter'
  const openrouterKeyRef = credentialRef(config.openrouterKeyRef ?? 'OPENROUTER_API_KEY')
  /** OpenRouter is connected while its API key is stored; without a credential store its state is unknown. */
  const probeOpenrouter = async (): Promise<ProviderConnection> => {
    const credentials = ctx.get('credentials')
    if (credentials === undefined) return { connection: 'unknown' }
    try {
      return { connection: (await credentials.describe(openrouterKeyRef)).configured ? 'connected' : 'signed-out' }
    } catch (error: unknown) {
      ctx.logger.warn(`toranja-orchestrator: OpenRouter credential could not be read: ${String(error)}`)
      return { connection: 'probe-failed' }
    }
  }
  const probeProviders = async (): Promise<void> => {
    const [probed, openrouter] = await Promise.all([
      Promise.all(CLI_PROVIDERS.map(async provider => [provider, await probeProvider(provider)] as const)),
      probeOpenrouter(),
    ])
    for (const [provider, connection] of probed) connections.set(provider, connection)
    connections.set('openrouter', openrouter)
  }
  const connectProvider = (request: ToranjaConnectRequest): ToranjaConnectResult => {
    const provider = CLI_PROVIDERS.find(candidate => candidate === request.provider)
    if (provider === undefined) {
      throw new Error('toranja-orchestrator: OpenRouter connects with an API key stored in Settings, not with a sign-in command')
    }
    const executable = findExecutable(executables[provider] ?? DEFAULT_EXECUTABLES[provider])
    if (executable === undefined) throw new Error(`toranja-orchestrator: ${provider} is not installed`)
    const command = [executable, ...LOGIN_COMMANDS[provider]]
    const child = ctx.subprocess.spawn({
      argv: terminalArgv(command),
      cwd: process.cwd(),
      stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
      graceMs: GIT_GRACE_MS,
    })
    child.stdout?.resume()
    child.stderr?.resume()
    void child.done.catch((error: unknown) => {
      ctx.logger.warn(`toranja-orchestrator: ${provider} sign-in terminal failed: ${String(error)}`)
    })
    return { provider, command }
  }

  const openrouterUnenforcedAccess = config.openrouterUnenforcedAccess ?? false
  /**
   * Whether a provider may take a role. OpenRouter runs on the internal agent,
   * which nothing keeps from writing, so it takes non-writing roles only when
   * the deployment accepts detection after the fact as the sole safeguard.
   */
  const canRun = (provider: RunProvider, role: Role): boolean =>
    provider !== 'openrouter' || openrouterUnenforcedAccess || roleAccess(role) === 'write'

  const availableRunProviders = (): ReadonlySet<RunProvider> => {
    const registered = new Set(ctx.subagents.list())
    const available = new Set<RunProvider>()
    for (const provider of RUN_PROVIDERS) {
      if (registered.has(providerName(provider)) && usable(provider)) {
        available.add(provider)
      }
    }
    return available
  }

  /** Provider a role uses when the caller names none: the mode, else the role preference with fallback. */
  const providerFor = (role: Role): RunProvider => {
    const { mode, roleProviders } = live()
    if (mode !== 'team') return mode
    return resolveFallbackProvider(
      roleProviders.get(role) ?? defaultProvider(role, mode),
      new Set([...availableRunProviders()].filter(provider => canRun(provider, role))),
      live().fallbackOrder,
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
      mode: live().mode,
      profile: live().profile,
      fallbackOrder: live().fallbackOrder,
      roleProviders: Object.fromEntries(live().roleProviders),
      crossReview: live().crossReview,
      teamSize: live().teamSize,
      onboarded: domain.global.get().onboarded === true,
      active: ledger.activeCount,
      limits: { ...limitsFor(live().teamSize), maxTeamSize },
      projects: lanes.map(project => ({ ...project, metrics: ledger.project(project.id) })),
      providers: RUN_PROVIDERS.map(provider => ({
        id: provider,
        registryName: providerName(provider),
        available: registered.has(providerName(provider)) && usable(provider),
        ...connectionOf(provider),
        roles: ROLES.filter(role => canRun(provider, role)),
        readOnlyEnforcement: provider !== 'openrouter' && tierModelsEditable(provider) ? READ_ONLY_ENFORCEMENT[provider] : 'none',
        tierModels: live().models.get(provider) ?? {},
        tierModelOverrides: tierModelsEditable(provider) ? domain.global.get().tierModels?.[provider] ?? {} : {},
        tierModelsEditable: tierModelsEditable(provider),
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
    assertProvidersAllowed(live().mode, ['codex'])
    const { project, description, task } = validateAssignment(request)
    const route = routeFor(request.role, 'codex')
    const [lease] = ledger.reserveBatch([reservation(project, route, description)])
    if (lease === undefined) throw new Error('toranja-orchestrator: missing Codex delegation reservation')
    try {
      const { activation, verify } = await launch({
        project,
        route,
        prompt: rolePrompt(project, route, task, live().profile),
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
  // Each change reads the stored overrides, merges, stores, and applies as one
  // step. Running the steps one after another keeps overlapping changes from
  // starting at the same stored value and overwriting each other.
  let settingsQueue: Promise<unknown> = Promise.resolve()
  const applySettings = async (
    request: ToranjaSettingsRequest & { readonly mode?: ToranjaAgentMode },
  ): Promise<ToranjaOrchestrationStatus> => {
    // Only the fields this request names join the stored overrides, so a field
    // the user never changed keeps following the deployment configuration.
    const stored = domain.global.get()
    // A named provider's table replaces what was stored for it, and an empty
    // table drops it; providers the request does not name keep theirs.
    const tierModels = request.tierModels === undefined
      ? undefined
      : Object.fromEntries(Object.entries({ ...stored.tierModels, ...parseTierModels(request.tierModels) })
        .filter(([, table]) => Object.keys(table).length > 0))
    const fallbackOrder = request.fallbackOrder === undefined || request.fallbackOrder.length === 0
      ? undefined
      : parseFallbackOrder(request.fallbackOrder)
    if (request.teamSize !== undefined && positiveInteger('teamSize', request.teamSize) > maxTeamSize) {
      throw new Error(`toranja-orchestrator: teamSize must not exceed ${maxTeamSize}, the deployment's maxTeamSize`)
    }
    const next: ToranjaOrchestrationState = {
      ...stored,
      // The mode changes only when the request names one, so a setting changed
      // from a stale snapshot cannot undo a mode chosen meanwhile.
      ...request.mode === undefined ? {} : { mode: request.mode },
      ...request.profile === undefined ? {} : { profile: request.profile },
      ...fallbackOrder === undefined ? {} : { fallbackOrder },
      ...request.roleProviders === undefined ? {} : { roleProviders: { ...request.roleProviders } },
      ...request.crossReview === undefined ? {} : { crossReview: request.crossReview },
      ...request.teamSize === undefined ? {} : { teamSize: positiveInteger('teamSize', request.teamSize) },
      ...tierModels === undefined ? {} : { tierModels },
      ...request.onboarded === undefined ? {} : { onboarded: request.onboarded },
    }
    // Validate before storing. The live routing derives from the stored
    // value, so a failed write leaves the routing in force untouched.
    if (next.roleProviders !== undefined) parseRoleProviders({ roleProviders: next.roleProviders })
    await domain.global.set(next)
    return readStatus()
  }
  const enqueueSettings = (change: () => Promise<ToranjaOrchestrationStatus>): Promise<ToranjaOrchestrationStatus> => {
    const result = settingsQueue.then(change)
    // A rejected change must not block the changes queued after it.
    settingsQueue = result.catch(() => undefined)
    return result
  }
  const controller = new ToranjaOrchestrationController(
    ctx,
    readStatus,
    request => enqueueSettings(() => applySettings(request)),
    // Checked inside the queue, so a mode the user stores meanwhile wins.
    legacyMode => enqueueSettings(() =>
      domain.global.get().mode === undefined ? applySettings({ mode: legacyMode }) : Promise.resolve(readStatus())),
    async () => {
      await probeProviders()
      return readStatus()
    },
    connectProvider,
  )
  if (config.probeOnStart === true) {
    // Not awaited: slow CLIs must not delay startup; routing treats an
    // unprobed provider as usable until the probe settles.
    void probeProviders().catch((error: unknown) => {
      ctx.logger.warn(`toranja-orchestrator: startup provider probe failed: ${String(error)}`)
    })
  }

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
        mode: live().mode,
        profile: live().profile,
        fallbackOrder: live().fallbackOrder,
        defaults: Object.fromEntries(ROLES.map(role => [role, providerFor(role)])),
        routes: ROLES.map(role => routeFor(role, providerFor(role))),
        teamSize: live().teamSize,
        limits: limitsFor(live().teamSize),
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
    description: 'Start a managed role-scoped task in one configured Toranja project. Select codex, antigravity, claude-code, openrouter, both, or all; both starts the first two connected providers and all starts every connected provider up to the team size, concurrently in the same project lane. Fan out only when independent answers materially improve confidence, because each provider spends its own credits. The tool returns immediately and normal subtask updates deliver results.',
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
      // `both` and `all` fan the task out over connected providers in fallback
      // order: two for `both`, and as many as the team size allows for `all`.
      // A provider that may not take the role stays out of the fan-out.
      const available = availableRunProviders()
      const connected = live().fallbackOrder.filter(provider => available.has(provider) && canRun(provider, role))
      const selected: readonly RunProvider[] = providerChoice === 'both'
        ? connected.slice(0, 2)
        : providerChoice === 'all'
          ? connected.slice(0, live().teamSize)
          : [providerChoice]
      if (selected.length === 0) throw new Error('delegate_project_task: no connected provider is available')
      assertProvidersAllowed(live().mode, selected)
      const { project, description, task } = validateAssignment(args)
      // Each implementer gets a worktree of its own when the deployment asks for it.
      const lanes = await Promise.all(selected.map(() => role === 'implementer' ? isolate(project) : Promise.resolve(undefined)))
      let leases: ReservationLease[]
      try {
        leases = ledger.reserveBatch(selected.map((provider, index) =>
          reservation(project, routeFor(role, provider), description, lanes[index])))
      } catch (error: unknown) {
        for (const lane of lanes) if (lane !== undefined) await releaseLane(lane)
        throw error
      }
      const requestFor = (lane: IsolatedLane | undefined): RoutedRequest => {
        const place = lane === undefined ? project : { ...project, path: lane.path }
        return {
          project,
          role,
          description,
          prompt: route => rolePrompt(place, route, task, live().profile),
          label: provider => `${project.title}: ${description} (${provider})`,
          parent,
          signal: exec.signal,
          delivery: 'parent',
          ...lane === undefined ? {} : { lane },
        }
      }
      const results = await Promise.all(selected.map(async (first, index) => {
        const lane = lanes[index]
        try {
          const started = await startRouted(
            requestFor(lane),
            candidatesFor(first, args.provider === undefined, role),
            requiredAt(leases, index, 'delegation reservation'),
          )
          const { route } = started
          settleInBackground(started)
          return {
            ok: true as const,
            provider: route.provider,
            providerName: started.providerName,
            tier: route.tier,
            access: route.access,
            ...route.model === undefined ? {} : { model: route.model },
            ...route.effort === undefined ? {} : { effort: route.effort },
            ...started.fallbackFrom.length === 0 ? {} : { fallbackFrom: started.fallbackFrom },
            taskId: started.lease.taskId,
            subagentId: started.activation.childId,
            // The change stays on this branch, in this worktree, until it is reviewed and merged.
            ...lane === undefined ? {} : { worktree: lane.path, branch: lane.branch },
          }
        } catch (error: unknown) {
          if (lane !== undefined) await releaseLane(lane)
          if (!(error instanceof RoutedStartError)) throw error
          return { ok: false as const, attempts: error.attempts }
        }
      }))
      const activations = results.filter(result => result.ok)
      const failures = results.flatMap(result => result.ok ? [] : result.attempts)
        .map(attempt => ({ ...attempt, providerName: providerName(attempt.provider) }))
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
      implementationTaskId: { type: 'string', description: 'taskId returned by the delegate_project_task implementer run under review. Supply it so the reviewer runs on a different provider; omit it only when no delegated implementer wrote the change.' },
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
      const roles = ['reviewer', 'tester'] as const
      // The implementer is taken only from the task the caller names; inferring
      // it from project history could bind the review to an unrelated change.
      const implementationTaskId = args.implementationTaskId?.trim()
      const implementation = implementationTaskId === undefined || implementationTaskId.length === 0
        ? undefined
        : ledger.tasks().find(task => task.id === implementationTaskId)
      if (
        implementationTaskId !== undefined && implementationTaskId.length > 0
        && (implementation?.projectId !== project.id || implementation.role !== 'implementer' || implementation.state !== 'completed')
      ) {
        throw new Error(`run_delivery_gate: implementationTaskId ${implementationTaskId} is not a completed implementer task of project ${project.id}`)
      }
      const implementerProvider = implementation?.provider
      // Cross-review moves the implementing provider to the end of the
      // reviewer's candidates, so it reviews its own work only as a last resort.
      const gateCandidates = (role: typeof roles[number]): readonly RunProvider[] => {
        const candidates = candidatesFor(providerFor(role), true, role)
        if (role !== 'reviewer' || !live().crossReview || implementerProvider === undefined) return candidates
        return [
          ...candidates.filter(provider => provider !== implementerProvider),
          ...candidates.filter(provider => provider === implementerProvider),
        ]
      }
      const candidates = { reviewer: gateCandidates('reviewer'), tester: gateCandidates('tester') }
      // An isolated implementation is reviewed where it was written: its worktree.
      const place = implementation?.worktree === undefined ? project : { ...project, path: implementation.worktree }
      const leases = ledger.reserveBatch(roles.map(role => reservation(
        project,
        routeFor(role, requiredAt(candidates[role], 0, 'gate provider')),
        `Portão de entrega: ${role}`,
      )))
      const results = await Promise.all(roles.map(async (role, index): Promise<GateResult> => {
        let started: StartedRun
        try {
          started = await startRouted({
            project: place,
            role,
            description: `Portão de entrega: ${role}`,
            prompt: () => gatePrompt(place, role, implementationSummary, acceptanceCriteria),
            label: provider => `${project.title}: delivery ${role} (${provider})`,
            parent,
            signal: exec.signal,
            delivery: 'caller',
            strict: true,
          }, candidates[role], requiredAt(leases, index, 'delivery gate reservation'))
        } catch (error: unknown) {
          if (!(error instanceof RoutedStartError)) throw error
          const last = requiredAt(error.attempts, error.attempts.length - 1, 'gate start attempt')
          return {
            role,
            provider: last.provider,
            providerName: providerName(last.provider),
            subagentId: '',
            stopReason: 'startup-error',
            verdict: 'invalid',
            output: '',
            diagnostic: error.message.slice(0, 4096),
          }
        }
        const { run, result, violation, error } = await awaitRouted(started)
        const base = {
          role,
          provider: run.route.provider,
          providerName: run.providerName,
          subagentId: run.activation.childId,
          ...run.fallbackFrom.length === 0 ? {} : { fallbackFrom: run.fallbackFrom },
        }
        if (result === undefined) {
          const diagnostic = error ?? 'subagent result infrastructure failure'
          run.lease.settle(false, diagnostic)
          return { ...base, stopReason: 'infrastructure-error', verdict: 'invalid', output: '', diagnostic: diagnostic.slice(0, 4096) }
        }
        const output = contentText(result.output).slice(0, 20_000)
        const verdict = violation === undefined ? parseGateVerdict(output) : 'invalid'
        const successful = result.stopReason === 'completed' && verdict === 'pass'
        const diagnostic = violation ?? result.diagnostic
        run.lease.settle(successful, diagnostic ?? (successful ? undefined : `${result.stopReason}/${verdict}`))
        return {
          ...base,
          stopReason: result.stopReason,
          verdict,
          output,
          ...(diagnostic === undefined ? {} : { diagnostic }),
        }
      }))
      const passed = results.every(result => result.stopReason === 'completed' && result.verdict === 'pass')
      let replan: Record<string, unknown> | undefined
      if (replanOnGateFailure && results.some(result => result.verdict === 'fail')) {
        // Evidence comes first and each part has its own budget, so a long
        // summary or criteria can never push the gate answers out of the task.
        const evidenceBudget = Math.floor(maxTaskChars / 2 / results.length)
        const contextBudget = Math.floor(maxTaskChars / 5)
        const task = [
          'The delivery gate rejected this change. Diagnose the failures and return a corrected plan.',
          '',
          'Gate evidence:',
          ...results.map(result =>
            `[${result.role} on ${result.provider}: ${result.verdict}]\n${(result.output || result.diagnostic || '').slice(0, evidenceBudget)}`),
          '',
          'Acceptance criteria:',
          acceptanceCriteria.slice(0, contextBudget),
          '',
          'Implementation summary:',
          implementationSummary.slice(0, contextBudget),
        ].join('\n').slice(0, maxTaskChars)
        try {
          const started = await startRouted({
            project,
            role: 'planner',
            description: 'Replanejar após portão',
            prompt: route => rolePrompt(project, route, task, live().profile),
            label: provider => `${project.title}: replan after gate (${provider})`,
            parent,
            signal: exec.signal,
            delivery: 'parent',
          }, candidatesFor(providerFor('planner'), true, 'planner'))
          settleInBackground(started)
          replan = {
            role: 'planner',
            provider: started.route.provider,
            taskId: started.lease.taskId,
            subagentId: started.activation.childId,
          }
        } catch (error: unknown) {
          if (!(error instanceof RoutedStartError)) throw error
          replan = { role: 'planner', error: error.message.slice(0, 4096) }
        }
      }
      return JSON.stringify({
        project: project.id,
        passed,
        decision: passed ? 'ready' : 'not-ready',
        ...implementerProvider === undefined
          ? {}
          : {
            implementerProvider,
            independentReview: results.some(result => result.role === 'reviewer' && result.provider !== implementerProvider),
          },
        ...replan === undefined ? {} : { replan },
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
