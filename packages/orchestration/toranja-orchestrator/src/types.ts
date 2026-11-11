/** Browser-safe Toranja orchestration dashboard contracts. */

/** Identifier for a supported Toranja agent provider. */
export type ToranjaProviderId = 'codex' | 'antigravity' | 'claude-code' | 'openrouter'
/** Active agent routing mode (solo provider or `team`). */
export type ToranjaAgentMode = ToranjaProviderId | 'team'
/** Dynamic cost/quality execution profile from the Toranja architecture blueprint. */
export type ToranjaExecutionProfile = 'economico' | 'equilibrado' | 'qualidade'
/** Role assigned to a delegated project task across Phases A (investigation), B (reasoning), and C (delivery). */
export type ToranjaTaskRole =
  | 'reader'
  | 'searcher'
  | 'inspector'
  | 'planner'
  | 'architect'
  | 'implementer'
  | 'reviewer'
  | 'tester'
  | 'release'
/** Model tier a provider maps to a concrete model and reasoning effort. */
export type ToranjaModelTier = 'light' | 'advanced' | 'max'
/** Filesystem access enforced for a delegated role. */
export type ToranjaRoleAccess = 'read-only' | 'execute' | 'write'

/** Route applied when one role is delegated: who runs it, on which model, with which access. */
export interface ToranjaRoleRoute {
  readonly role: ToranjaTaskRole
  readonly provider: ToranjaProviderId
  readonly tier: ToranjaModelTier
  readonly access: ToranjaRoleAccess
  /** Concrete model; omitted when the provider's native setting applies. */
  readonly model?: string
  /** Concrete reasoning effort; omitted when the provider's native setting applies. */
  readonly effort?: string
}

/** Preferred provider per role; a role without an entry uses the built-in default. */
export type ToranjaRoleProviders = Readonly<Partial<Record<ToranjaTaskRole, ToranjaProviderId>>>
/** Lifecycle state of a delegated project task. */
export type ToranjaTaskState = 'active' | 'completed' | 'failed'

/** Request payload to change the active Toranja agent routing mode or execution profile. */
export interface ToranjaAgentModeRequest {
  readonly mode: ToranjaAgentMode
  readonly profile?: ToranjaExecutionProfile
  readonly fallbackOrder?: readonly ToranjaProviderId[]
  /** Replaces the preferred provider per role used in Team mode. */
  readonly roleProviders?: ToranjaRoleProviders
  /** Whether the delivery-gate reviewer avoids the implementing provider. */
  readonly crossReview?: boolean
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
  /** Model the task was started with; omitted for the provider's native setting. */
  readonly model?: string
  /** Reasoning effort the task was started with; omitted for the provider's native setting. */
  readonly effort?: string
  /** Access level enforced for the task. */
  readonly access?: ToranjaRoleAccess
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
  /** Active cost/quality execution profile. */
  readonly profile: ToranjaExecutionProfile
  /** Ordered provider fallback chain when the preferred provider is unavailable or exhausted. */
  readonly fallbackOrder: readonly ToranjaProviderId[]
  /** Preferred provider per role in Team mode. */
  readonly roleProviders: ToranjaRoleProviders
  /** Whether the delivery-gate reviewer avoids the implementing provider. */
  readonly crossReview: boolean
  readonly active: number
  readonly limits: {
    readonly maxConcurrentTotal: number
    readonly maxConcurrentPerProject: number
    readonly maxConcurrentPerProvider: number
    readonly allowParallelImplementation: boolean
  }
  readonly projects: readonly ToranjaProjectStatus[]
  readonly providers: readonly ToranjaProviderStatus[]
  /** Route each role takes under the current mode and profile when no provider is named. */
  readonly routes: readonly ToranjaRoleRoute[]
  /** Newest first; bounded in memory by the orchestration ledger. */
  readonly tasks: readonly ToranjaTaskStatus[]
}
