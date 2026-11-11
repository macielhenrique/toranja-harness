/**
 * Toranja-owned project catalog and role-based delegation surface.
 *
 * @module @deepseek-ai/dsh-toranja-orchestrator
 */

import { existsSync } from 'node:fs'
import { basename, isAbsolute } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SubagentActivation, SubagentResult } from '@deepseek-ai/dsh-subagent'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-workspace'
import {
  OrchestrationLedger,
  assertProvidersAllowed,
  defaultProvider,
  parseGateVerdict,
  recommendedModelTier,
  resolveFallbackProvider,
  PROVIDERS,
  ROLES,
  RUN_PROVIDERS,
  slugifyProjectId,
  type Role,
  type RunProvider,
} from './policy.ts'
import type {
  ToranjaAgentMode,
  ToranjaAgentModeRequest,
  ToranjaExecutionProfile,
  ToranjaOrchestrationStatus,
  ToranjaProviderId,
} from './types.ts'
import {
  ToranjaOrchestrator,
  type ToranjaCodexDelegationRequest,
  type ToranjaCodexDelegationResult,
} from './service.ts'

export * from './policy.ts'
export * from './service.ts'
export * from './types.ts'

export const name = 'toranja-orchestrator'
export const inject = ['subagents', 'systemPrompt', 'tools', 'workspaceRegistry']

const PROJECT_ID = /^[a-z][a-z0-9-]{1,31}$/
const DEFAULT_MAX_TASK_CHARS = 12_000

/** One stable product lane backed by a local project directory. */
export interface ProjectConfig {
  id: string
  title: string
  path: string
}

/** Product-owned orchestration settings. */
export interface Config {
  projects?: ProjectConfig[]
  codexProvider?: string
  antigravityProvider?: string
  claudeCodeProvider?: string
  openrouterProvider?: string
  maxConcurrentTotal?: number
  maxConcurrentPerProject?: number
  maxConcurrentPerProvider?: number
  maxTaskChars?: number
  allowParallelImplementation?: boolean
  defaultMode?: ToranjaAgentMode
  defaultProfile?: ToranjaExecutionProfile
  fallbackOrder?: ToranjaProviderId[]
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
  role: Role,
  task: string,
  profile: ToranjaExecutionProfile = 'equilibrado',
): ContentBlock[] {
  const tier = recommendedModelTier(role, profile)
  const tierLabel = tier === 'light'
    ? 'LIGHTWEIGHT INVESTIGATION (Haiku 5.5 / Gemini 3.8 Flash / GPT-5.6 Luna-Terra — Read-only & Concise Summary)'
    : 'ADVANCED REASONING (Gemini 4 Argon / Claude Opus-Sonnet / GPT-6.1 Sol)'
  return [{
    type: 'text',
    text: [
      `Toranja Harness project lane: ${project.title} (${project.id}).`,
      `Working directory boundary: ${project.path}.`,
      `Assigned role: ${role} [${tierLabel}].`,
      `Execution profile: ${profile}.`,
      ROLE_GUIDANCE[role],
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
): void {
  void activation.result.then(
    (result) => {
      lease.settle(result.stopReason === 'completed', result.diagnostic ?? result.stopReason)
    },
    (error: unknown) => {
      lease.settle(false, error instanceof Error ? error.message : 'subagent result infrastructure failure')
    },
  )
}

interface GateRun {
  readonly role: 'reviewer' | 'tester'
  readonly provider: RunProvider
  readonly providerName: string
  readonly activation: SubagentActivation
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
    const [lease] = ledger.reserveBatch([{
      project: project.id,
      provider: 'codex',
      role: request.role,
      label: description,
    }])
    if (lease === undefined) throw new Error('toranja-orchestrator: missing Codex delegation reservation')
    try {
      const activation = await ctx.subagents.startActivation({
        provider: codexProvider,
        label: `${project.title}: ${description} (codex)`,
        request: {
          cwd: project.path,
          prompt: rolePrompt(project, request.role, task, profile),
          parent: request.parent,
        },
        signal: request.signal,
        delivery: 'caller',
      })
      const result = await activation.result
      const output = contentText(result.output).slice(0, 20_000)
      const success = result.stopReason === 'completed'
      lease.settle(success, result.diagnostic ?? (success ? undefined : result.stopReason))
      return {
        project: project.id,
        role: request.role,
        taskId: lease.taskId,
        subagentId: activation.childId,
        stopReason: result.stopReason,
        output,
        ...(result.diagnostic === undefined ? {} : { diagnostic: result.diagnostic }),
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
        defaults: Object.fromEntries(ROLES.map(role => [role, defaultProvider(role, mode)])),
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
      const available = availableRunProviders()
      const providerChoice = args.provider ?? (
        mode === 'team'
          ? resolveFallbackProvider(defaultProvider(role, mode), available, fallbackOrder)
          : defaultProvider(role, mode)
      )
      const selected: readonly RunProvider[] = providerChoice === 'both' ? ['codex', 'antigravity'] : [providerChoice]
      assertProvidersAllowed(mode, selected)
      const { project, description, task } = validateAssignment(args)
      const prompt = rolePrompt(project, role, task, profile)
      const leases = ledger.reserveBatch(selected.map(provider => ({
        project: project.id,
        provider,
        role,
        label: description,
      })))
      const results = await Promise.all(selected.map(async (provider, index) => {
        const registryName = providerName(provider)
        const lease = requiredAt(leases, index, 'delegation reservation')
        try {
          const activation = await ctx.subagents.startActivation({
            provider: registryName,
            label: `${project.title}: ${description} (${provider})`,
            request: {
              cwd: project.path,
              prompt,
              parent,
            },
            signal: exec.signal,
            delivery: 'parent',
          })
          monitorActivation(activation, lease)
          return {
            ok: true as const,
            provider,
            providerName: registryName,
            taskId: lease.taskId,
            subagentId: activation.childId,
          }
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : 'unknown provider startup failure'
          lease.settle(false, message)
          return { ok: false as const, provider, providerName: registryName, error: message.slice(0, 4096) }
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
    description: 'Run the Toranja release gate for one project. An Antigravity reviewer and a Codex tester independently inspect the current repository without editing it. The tool waits for both and passes only when both return an explicit PASS verdict.',
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
      const assignments = [
        { role: 'reviewer' as const, provider: 'antigravity' as const },
        { role: 'tester' as const, provider: 'codex' as const },
      ]
      const leases = ledger.reserveBatch(assignments.map(({ role, provider }) => ({
        project: project.id,
        role,
        provider,
        label: `Portão de entrega: ${role}`,
      })))
      const starts = await Promise.all(assignments.map(async ({ role, provider }, index): Promise<GateRun | GateResult> => {
        const registryName = providerName(provider)
        try {
          const activation = await ctx.subagents.startActivation({
            provider: registryName,
            label: `${project.title}: delivery ${role} (${provider})`,
            request: {
              cwd: project.path,
              prompt: gatePrompt(project, role, implementationSummary, acceptanceCriteria),
              parent,
            },
            signal: exec.signal,
            delivery: 'caller',
          })
          return { role, provider, providerName: registryName, activation }
        } catch (error: unknown) {
          const diagnostic = error instanceof Error ? error.message : 'unknown provider startup failure'
          requiredAt(leases, index, 'delivery gate reservation').settle(false, diagnostic)
          return {
            role,
            provider,
            providerName: registryName,
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
          const verdict = parseGateVerdict(output)
          const successful = result.stopReason === 'completed' && verdict === 'pass'
          requiredAt(leases, index, 'delivery gate reservation')
            .settle(successful, result.diagnostic ?? (successful ? undefined : `${result.stopReason}/${verdict}`))
          return {
            role: start.role,
            provider: start.provider,
            providerName: start.providerName,
            subagentId: start.activation.childId,
            stopReason: result.stopReason,
            verdict,
            output,
            ...(result.diagnostic === undefined ? {} : { diagnostic: result.diagnostic }),
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
