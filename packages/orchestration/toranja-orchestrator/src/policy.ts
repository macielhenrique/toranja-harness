/** Pure Toranja orchestration admission, accounting, and delivery-gate policy. */

import type {
  MetricSnapshot,
  ToranjaAgentMode,
  ToranjaRoleAccess,
  ToranjaTaskRole,
  ToranjaTaskState,
  ToranjaTaskStatus,
} from './types.ts'
export type { MetricSnapshot } from './types.ts'

/** Supported task roles in Toranja orchestration across Phases A, B, and C. */
export const ROLES = [
  'reader',
  'searcher',
  'inspector',
  'planner',
  'architect',
  'implementer',
  'reviewer',
  'tester',
  'release',
] as const
/** Read-only Phase A investigation roles that run on lightweight models. */
export const INVESTIGATION_ROLES = ['reader', 'searcher', 'inspector'] as const
/** Supported provider selection values, including dual-provider execution. */
export const PROVIDERS = ['codex', 'antigravity', 'claude-code', 'openrouter', 'both'] as const
/** Concrete runtime providers that execute tasks. */
export const RUN_PROVIDERS = ['codex', 'antigravity', 'claude-code', 'openrouter'] as const
/** Supported dynamic execution profiles. */
export const EXECUTION_PROFILES = ['economico', 'equilibrado', 'qualidade'] as const

/** Task role assigned to a delegated worker. */
export type Role = ToranjaTaskRole
/** Caller-selectable provider option (`codex`, `antigravity`, `claude-code`, `openrouter`, or `both`). */
export type ProviderChoice = typeof PROVIDERS[number]
/** Concrete provider identifier used for execution and accounting. */
export type RunProvider = typeof RUN_PROVIDERS[number]

/**
 * Resolve an omitted provider from the user's current Toranja agent mode.
 * @param role - Task role to assign.
 * @param mode - Active Toranja agent mode.
 * @returns Concrete provider selected for the task.
 */
export function defaultProvider(role: Role, mode: ToranjaAgentMode = 'team'): Exclude<ProviderChoice, 'both'> {
  if (mode !== 'team') return mode
  return role === 'reader'
    || role === 'searcher'
    || role === 'inspector'
    || role === 'planner'
    || role === 'architect'
    || role === 'reviewer'
    ? 'antigravity'
    : 'codex'
}

/**
 * Select the first available provider from the configured fallback order when
 * the preferred provider is unavailable or exhausted.
 * @param preferred - Primary provider chosen for the task.
 * @param available - Set of currently reachable runtime providers.
 * @param fallbackOrder - Ordered fallback sequence across ecosystems.
 * @returns Concrete provider to execute the task.
 */
export function resolveFallbackProvider(
  preferred: RunProvider,
  available: ReadonlySet<RunProvider>,
  fallbackOrder: readonly RunProvider[] = RUN_PROVIDERS,
): RunProvider {
  if (available.has(preferred)) return preferred
  for (const candidate of fallbackOrder) {
    if (available.has(candidate)) return candidate
  }
  return preferred
}

/**
 * Keep solo modes exclusive even when a caller names a provider explicitly.
 * @param mode - Active Toranja agent mode.
 * @param providers - Providers requested for the operation.
 */
export function assertProvidersAllowed(mode: ToranjaAgentMode, providers: readonly RunProvider[]): void {
  if (mode === 'team') return
  const forbidden = providers.find(provider => provider !== mode)
  if (forbidden !== undefined) {
    throw new Error(`Toranja mode ${mode} does not allow ${forbidden}; select Team to combine providers`)
  }
}

/**
 * Derive a valid project lane identifier (`^[a-z][a-z0-9-]{1,31}$`) from a
 * workspace title or directory name while avoiding collisions with existing ids.
 *
 * @param rawTitle - Human-readable workspace title or directory basename.
 * @param usedIds - Already allocated lane ids in the current snapshot.
 * @returns Unique normalized lane id.
 */
export function slugifyProjectId(rawTitle: string, usedIds: ReadonlySet<string> = new Set()): string {
  const ascii = rawTitle
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
  const prefixed = ascii.length === 0
    ? 'project'
    : /^[a-z]/u.test(ascii)
      ? ascii
      : `p-${ascii}`
  const base = (prefixed.length < 2 ? `${prefixed}-lane` : prefixed).slice(0, 28).replace(/-+$/gu, '') || 'project'
  if (!usedIds.has(base)) return base
  let suffix = 2
  while (usedIds.has(`${base}-${suffix}`)) suffix += 1
  return `${base}-${suffix}`
}

/** Concurrency and write-isolation limits enforced by {@link OrchestrationLedger}. */
export interface OrchestrationLimits {
  readonly maxConcurrentTotal: number
  readonly maxConcurrentPerProject: number
  readonly maxConcurrentPerProvider: number
  readonly allowParallelImplementation: boolean
}

/** Single task capacity reservation request. */
export interface ReservationRequest {
  readonly project: string
  readonly provider: RunProvider
  readonly role: Role
  readonly label?: string
  readonly model?: string | undefined
  readonly effort?: string | undefined
  readonly access?: ToranjaRoleAccess
}

interface MutableMetric {
  active: number
  completed: number
  failed: number
  lastStartedAt?: string
  lastSettledAt?: string
  lastError?: string
}

/** Active capacity lease returned by {@link OrchestrationLedger.reserveBatch}. */
export interface ReservationLease {
  readonly taskId: string
  settle(success: boolean, error?: string): void
}

interface MutableTask {
  id: string
  projectId: string
  provider: RunProvider
  role: Role
  label: string
  model?: string
  effort?: string
  access?: ToranjaRoleAccess
  state: ToranjaTaskState
  startedAt: string
  settledAt?: string
  error?: string
}

const freshMetric = (): MutableMetric => ({ active: 0, completed: 0, failed: 0 })

function metricFor(map: Map<string, MutableMetric>, key: string): MutableMetric {
  let metric = map.get(key)
  if (metric === undefined) {
    metric = freshMetric()
    map.set(key, metric)
  }
  return metric
}

function snapshot(metric: MutableMetric | undefined): MetricSnapshot {
  if (metric === undefined) return freshMetric()
  return { ...metric }
}

/**
 * Atomically reserves Toranja-owned capacity before any provider process starts.
 * Core Harness limits remain authoritative; this policy adds project/provider
 * isolation and prevents conflicting implementers from sharing one worktree.
 */
export class OrchestrationLedger {
  private active = 0
  private readonly projects = new Map<string, MutableMetric>()
  private readonly providers = new Map<string, MutableMetric>()
  private readonly activeWriters = new Map<string, number>()
  private readonly writerStarts = new Map<string, number>()
  private readonly taskHistory: MutableTask[] = []
  private taskSequence = 0

  /**
   * Create a ledger enforcing the given concurrency limits.
   * @param limits - Concurrency and write-isolation limits.
   */
  constructor(private readonly limits: OrchestrationLimits) {}

  /**
   * Atomically reserve capacity for one or more delegated tasks.
   * @param requests - Tasks to reserve together.
   * @returns Settlement leases corresponding to `requests`.
   */
  reserveBatch(requests: readonly ReservationRequest[]): ReservationLease[] {
    if (requests.length === 0) throw new Error('orchestration reservation requires at least one task')
    const projectAdds = new Map<string, number>()
    const providerAdds = new Map<string, number>()
    const writerAdds = new Map<string, number>()
    for (const request of requests) {
      projectAdds.set(request.project, (projectAdds.get(request.project) ?? 0) + 1)
      providerAdds.set(request.provider, (providerAdds.get(request.provider) ?? 0) + 1)
      if (request.role === 'implementer') {
        writerAdds.set(request.project, (writerAdds.get(request.project) ?? 0) + 1)
      }
    }
    if (this.active + requests.length > this.limits.maxConcurrentTotal) {
      throw new Error(`Toranja concurrency limit reached: ${this.active}/${this.limits.maxConcurrentTotal} active tasks`)
    }
    for (const [project, count] of projectAdds) {
      const active = this.projects.get(project)?.active ?? 0
      if (active + count > this.limits.maxConcurrentPerProject) {
        throw new Error(`Toranja project limit reached for ${project}: ${active}/${this.limits.maxConcurrentPerProject} active tasks`)
      }
    }
    for (const [provider, count] of providerAdds) {
      const active = this.providers.get(provider)?.active ?? 0
      if (active + count > this.limits.maxConcurrentPerProvider) {
        throw new Error(`Toranja provider limit reached for ${provider}: ${active}/${this.limits.maxConcurrentPerProvider} active tasks`)
      }
    }
    if (!this.limits.allowParallelImplementation) {
      for (const [project, count] of writerAdds) {
        const active = this.activeWriters.get(project) ?? 0
        if (active + count > 1) {
          throw new Error(`Toranja write isolation prevents multiple implementers in project ${project}; use separate worktrees or run them sequentially`)
        }
      }
    }

    const startedAt = new Date().toISOString()
    return requests.map((request) => {
      this.active += 1
      const projectMetric = metricFor(this.projects, request.project)
      const providerMetric = metricFor(this.providers, request.provider)
      projectMetric.active += 1
      providerMetric.active += 1
      projectMetric.lastStartedAt = startedAt
      providerMetric.lastStartedAt = startedAt
      if (request.role === 'implementer') {
        this.activeWriters.set(request.project, (this.activeWriters.get(request.project) ?? 0) + 1)
        this.writerStarts.set(request.project, (this.writerStarts.get(request.project) ?? 0) + 1)
      }
      const task: MutableTask = {
        id: `toranja-${Date.now().toString(36)}-${(++this.taskSequence).toString(36)}`,
        projectId: request.project,
        provider: request.provider,
        role: request.role,
        label: request.label?.trim().slice(0, 80) || request.role,
        ...request.model === undefined ? {} : { model: request.model },
        ...request.effort === undefined ? {} : { effort: request.effort },
        ...request.access === undefined ? {} : { access: request.access },
        state: 'active',
        startedAt,
      }
      this.taskHistory.push(task)
      this.pruneTaskHistory()
      let settled = false
      return {
        taskId: task.id,
        settle: (success: boolean, error?: string): void => {
          if (settled) return
          settled = true
          this.active -= 1
          projectMetric.active -= 1
          providerMetric.active -= 1
          const settledAt = new Date().toISOString()
          task.state = success ? 'completed' : 'failed'
          task.settledAt = settledAt
          projectMetric.lastSettledAt = settledAt
          providerMetric.lastSettledAt = settledAt
          if (success) {
            projectMetric.completed += 1
            providerMetric.completed += 1
          } else {
            projectMetric.failed += 1
            providerMetric.failed += 1
            const safeError = error?.trim().slice(0, 512)
            if (safeError) {
              task.error = safeError
              projectMetric.lastError = safeError
              providerMetric.lastError = safeError
            }
          }
          if (request.role === 'implementer') {
            const writers = (this.activeWriters.get(request.project) ?? 1) - 1
            if (writers === 0) this.activeWriters.delete(request.project)
            else this.activeWriters.set(request.project, writers)
          }
          this.pruneTaskHistory()
        },
      }
    })
  }

  private pruneTaskHistory(): void {
    const settled = this.taskHistory.filter(task => task.state !== 'active')
    const excess = this.taskHistory.length - 24
    if (excess <= 0) return
    const removable = new Set(settled.slice(0, excess).map(task => task.id))
    if (removable.size === 0) return
    const retained = this.taskHistory.filter(task => !removable.has(task.id))
    this.taskHistory.splice(0, this.taskHistory.length, ...retained)
  }

  /**
   * Whether an implementer currently holds the project's working tree, which
   * makes a concurrent working-tree comparison meaningless.
   * @param project - Project lane identifier.
   * @returns True while at least one implementer is active in `project`.
   */
  hasActiveWriter(project: string): boolean {
    return (this.activeWriters.get(project) ?? 0) > 0
  }

  /**
   * Count implementers ever started in the project. An unchanged count across a
   * run, with no active writer, means no implementer touched the working tree
   * during that run.
   * @param project - Project lane identifier.
   * @returns Monotonic number of implementer reservations for `project`.
   */
  writerStartCount(project: string): number {
    return this.writerStarts.get(project) ?? 0
  }

  /** Number of currently active reservations across all projects and providers. */
  get activeCount(): number {
    return this.active
  }

  /**
   * Read the metric snapshot for a project lane.
   * @param project - Project lane identifier.
   * @returns Immutable metric snapshot for `project`.
   */
  project(project: string): MetricSnapshot {
    return snapshot(this.projects.get(project))
  }

  /**
   * Read the metric snapshot for a provider.
   * @param provider - Concrete provider identifier.
   * @returns Immutable metric snapshot for `provider`.
   */
  provider(provider: RunProvider): MetricSnapshot {
    return snapshot(this.providers.get(provider))
  }

  /**
   * List recent tasks in reverse chronological order.
   * @returns Bounded list of recent task snapshots.
   */
  tasks(): readonly ToranjaTaskStatus[] {
    return this.taskHistory.slice().reverse().map(task => ({ ...task }))
  }
}

/** Verdict parsed from a reviewer or tester delivery-gate response. */
export type GateVerdict = 'pass' | 'fail' | 'invalid'

/**
 * Only an explicit first non-empty line can pass a delivery gate.
 * @param text - Reviewer or tester response text.
 * @returns Parsed gate verdict (`pass`, `fail`, or `invalid`).
 */
export function parseGateVerdict(text: string): GateVerdict {
  const first = text.split(/\r?\n/u).map(line => line.trim()).find(Boolean)
  if (first === 'TORANJA_GATE: PASS') return 'pass'
  if (first === 'TORANJA_GATE: FAIL') return 'fail'
  return 'invalid'
}
