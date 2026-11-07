/** Browser-safe Toranja orchestration dashboard contracts. */

/** Identifier for a supported Toranja agent provider. */
export type ToranjaProviderId = 'codex' | 'antigravity'
/** Active agent routing mode (`codex` solo, `antigravity` solo, or `team`). */
export type ToranjaAgentMode = 'codex' | 'antigravity' | 'team'
/** Role assigned to a delegated project task. */
export type ToranjaTaskRole = 'planner' | 'implementer' | 'reviewer' | 'tester' | 'release'
/** Lifecycle state of a delegated project task. */
export type ToranjaTaskState = 'active' | 'completed' | 'failed'

/** Request payload to change the active Toranja agent routing mode. */
export interface ToranjaAgentModeRequest {
  readonly mode: ToranjaAgentMode
}

/** Counters and timestamps for a project lane or provider. */
export interface MetricSnapshot {
  readonly active: number
  readonly completed: number
  readonly failed: number
  readonly lastStartedAt?: string
  readonly lastSettledAt?: string
  readonly lastError?: string
}

/** Runtime status and counters for one agent provider. */
export interface ToranjaProviderStatus {
  readonly id: ToranjaProviderId
  readonly registryName: string
  readonly available: boolean
  readonly metrics: MetricSnapshot
}

/** Runtime status and counters for one project lane. */
export interface ToranjaProjectStatus {
  readonly id: string
  readonly title: string
  readonly path: string
  readonly metrics: MetricSnapshot
}

/** One managed delegation shown in the local activity dashboard. */
export interface ToranjaTaskStatus {
  readonly id: string
  readonly projectId: string
  readonly provider: ToranjaProviderId
  readonly role: ToranjaTaskRole
  readonly label: string
  readonly state: ToranjaTaskState
  readonly startedAt: string
  readonly settledAt?: string
  readonly error?: string
}

/** Complete snapshot of Toranja orchestration state served over Remote. */
export interface ToranjaOrchestrationStatus {
  readonly generatedAt: string
  /** Routing used whenever a delegation omits an explicit provider. */
  readonly mode: ToranjaAgentMode
  readonly active: number
  readonly limits: {
    readonly maxConcurrentTotal: number
    readonly maxConcurrentPerProject: number
    readonly maxConcurrentPerProvider: number
    readonly allowParallelImplementation: boolean
  }
  readonly projects: readonly ToranjaProjectStatus[]
  readonly providers: readonly ToranjaProviderStatus[]
  /** Newest first; bounded in memory by the orchestration ledger. */
  readonly tasks: readonly ToranjaTaskStatus[]
}
