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

/** Model and reasoning effort of one tier; an omitted field keeps the provider's native setting. */
export interface ToranjaTierModel {
  readonly model?: string | undefined
  readonly effort?: string | undefined
}

/** Tier-to-model table of one provider. `max` uses the `advanced` entry when it has none. */
export type ToranjaTierModels = Readonly<Partial<Record<ToranjaModelTier, ToranjaTierModel>>>

/**
 * How a provider keeps a `read-only` task from writing: `sandbox` and
 * `permission-mode` block writes outside the model, `advisory` relies on the
 * model following the provider's plan directive, and `none` means nothing
 * prevents writing and only the working-tree check detects it afterwards.
 */
export type ToranjaReadOnlyEnforcement = 'sandbox' | 'permission-mode' | 'advisory' | 'none'

/** Preferred provider per role; a role without an entry uses the built-in default. */
export type ToranjaRoleProviders = Readonly<Partial<Record<ToranjaTaskRole, ToranjaProviderId>>>
/** Lifecycle state of a delegated project task. */
export type ToranjaTaskState = 'active' | 'completed' | 'failed'

/**
 * Orchestration settings a request changes. Each omitted field keeps its
 * stored value, so a request names only what the user changed.
 */
export interface ToranjaSettingsRequest {
  readonly profile?: ToranjaExecutionProfile
  readonly fallbackOrder?: readonly ToranjaProviderId[]
  /** Replaces the preferred provider per role used in Team mode. */
  readonly roleProviders?: ToranjaRoleProviders
  /** Whether the delivery-gate reviewer avoids the implementing provider. */
  readonly crossReview?: boolean
  /** How many agents may work in one project at the same time, up to the deployment's `maxTeamSize`. */
  readonly teamSize?: number
  /**
   * Tier models the user sets, per provider. Each named provider's table
   * replaces what the user set for it before: a tier it omits follows the
   * deployment configuration, and an empty table drops the user's models for
   * that provider. Providers not named keep theirs.
   */
  readonly tierModels?: Readonly<Partial<Record<ToranjaProviderId, ToranjaTierModels>>>
  /** Whether the user finished or dismissed the first-run setup. */
  readonly onboarded?: boolean
}

/** Request to change the routing mode, optionally together with other settings. */
export interface ToranjaAgentModeRequest extends ToranjaSettingsRequest {
  readonly mode: ToranjaAgentMode
}

/** Routing mode an earlier client version kept in browser storage. */
export interface ToranjaLegacyModeRequest {
  readonly mode: ToranjaAgentMode
}

/** Request to start the sign-in of one provider. */
export interface ToranjaConnectRequest {
  readonly provider: ToranjaProviderId
}

/** Sign-in command opened in a terminal for the user to complete. */
export interface ToranjaConnectResult {
  readonly provider: ToranjaProviderId
  /** Executable and arguments running in the terminal. */
  readonly command: readonly string[]
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

/**
 * Sign-in state of a provider: `connected` and `signed-out` come from its
 * official status command, `not-installed` means its CLI was not found,
 * `probe-failed` means the status could not be read, and `unknown` means the
 * provider was never probed. Only `connected` and `unknown` providers are routed.
 */
export type ToranjaProviderConnection = 'connected' | 'signed-out' | 'not-installed' | 'probe-failed' | 'unknown'

/** Runtime status and counters for one agent provider. */
export interface ToranjaProviderStatus {
  readonly id: ToranjaProviderId
  readonly registryName: string
  /** Registered and not known to be missing or signed out. */
  readonly available: boolean
  /** Sign-in state from the last probe. */
  readonly connection: ToranjaProviderConnection
  /** Executable the sign-in state was read from, when one is installed. */
  readonly executable?: string
  /** Roles this provider may take; one that cannot be kept from writing takes only writing roles. */
  readonly roles: readonly ToranjaTaskRole[]
  /** How this provider keeps a `read-only` task from writing in this deployment. */
  readonly readOnlyEnforcement: ToranjaReadOnlyEnforcement
  /** Model and effort in force per tier: what the user set over the deployment configuration. */
  readonly tierModels: ToranjaTierModels
  /** Tiers the user set for this provider; the other tiers follow the deployment configuration. */
  readonly tierModelOverrides: ToranjaTierModels
  /** Whether tier models can be applied to this provider in this deployment. */
  readonly tierModelsEditable: boolean
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
  /** Git worktree an isolated implementer wrote in, while it is kept for review. */
  readonly worktree?: string
  /** Branch of that worktree, holding the implementer's changes. */
  readonly branch?: string
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
  /** How many agents may work in one project at the same time. */
  readonly teamSize: number
  /** Whether the user finished or dismissed the first-run setup. */
  readonly onboarded: boolean
  readonly active: number
  readonly limits: {
    readonly maxConcurrentTotal: number
    readonly maxConcurrentPerProject: number
    readonly maxConcurrentPerProvider: number
    /** Largest team size the deployment accepts. */
    readonly maxTeamSize: number
    readonly allowParallelImplementation: boolean
  }
  readonly projects: readonly ToranjaProjectStatus[]
  readonly providers: readonly ToranjaProviderStatus[]
  /** Route each role takes under the current mode and profile when no provider is named. */
  readonly routes: readonly ToranjaRoleRoute[]
  /** Newest first; bounded in memory by the orchestration ledger. */
  readonly tasks: readonly ToranjaTaskStatus[]
  /**
   * Implementer worktrees an earlier run left behind that were kept when this
   * one started, because they hold work or are too recent to judge. Absent
   * until the search at start has finished.
   */
  readonly leftoverWorktrees?: readonly ToranjaLeftoverWorktree[]
}

/** An implementer worktree left by an earlier run, waiting for review, merge, or removal by hand. */
export interface ToranjaLeftoverWorktree {
  readonly project: string
  readonly worktree: string
  readonly branch: string
}
