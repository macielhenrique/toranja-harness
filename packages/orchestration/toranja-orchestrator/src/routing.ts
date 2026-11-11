/** Pure role-to-model routing and per-role access policy for Toranja delegations. */

import type { Role, RunProvider } from './policy.ts'
import type {
  ToranjaExecutionProfile,
  ToranjaModelTier,
  ToranjaRoleAccess,
  ToranjaRoleRoute,
} from './types.ts'

/** Model tiers a provider can map to a concrete model and reasoning effort. */
export const MODEL_TIERS = ['light', 'advanced', 'max'] as const satisfies readonly ToranjaModelTier[]

/** Concrete model and reasoning effort configured for one provider tier. */
export interface TierModel {
  readonly model?: string | undefined
  readonly effort?: string | undefined
}

/** Tier-to-model table of one provider; an omitted tier keeps the provider's native settings. */
export type ProviderModels = Readonly<Partial<Record<ToranjaModelTier, TierModel>>>

/**
 * How a provider enforces `read-only` access: `sandbox` and `permission-mode`
 * are enforced outside the model; `advisory` relies on the model following the
 * provider's plan directive and is only detected afterwards.
 */
export type ReadOnlyEnforcement = 'sandbox' | 'permission-mode' | 'advisory' | 'none'

/** Read-only enforcement each provider offers when Toranja owns its instance. */
export const READ_ONLY_ENFORCEMENT: Readonly<Record<RunProvider, ReadOnlyEnforcement>> = {
  codex: 'sandbox',
  antigravity: 'advisory',
  'claude-code': 'permission-mode',
  openrouter: 'none',
}

/**
 * Filesystem access a role needs. `execute` may run commands and create build
 * output but must leave tracked files unchanged.
 * @param role - Assigned task role.
 * @returns Access level enforced for the role.
 */
export function roleAccess(role: Role): ToranjaRoleAccess {
  switch (role) {
    case 'implementer':
      return 'write'
    case 'tester':
    case 'release':
      return 'execute'
    case 'reader':
    case 'searcher':
    case 'inspector':
    case 'planner':
    case 'architect':
    case 'reviewer':
      return 'read-only'
  }
}

/**
 * Select the model tier for a role under an execution profile. Investigation
 * always stays light. `economico` also runs verification light; `qualidade`
 * raises planning, architecture, and review to `max`.
 * @param role - Assigned task role.
 * @param profile - Active execution profile.
 * @returns Model tier for the delegation.
 */
export function modelTier(role: Role, profile: ToranjaExecutionProfile): ToranjaModelTier {
  if (role === 'reader' || role === 'searcher' || role === 'inspector') return 'light'
  if (role === 'tester' || role === 'release') return profile === 'economico' ? 'light' : 'advanced'
  if (role === 'implementer') return 'advanced'
  return profile === 'qualidade' ? 'max' : 'advanced'
}

/**
 * Resolve the concrete model for a tier. `max` uses the `advanced` entry when
 * the provider configures no dedicated one.
 * @param tier - Requested model tier.
 * @param models - Provider tier table.
 * @returns Configured model and effort, or an empty object for native settings.
 */
export function tierModel(tier: ToranjaModelTier, models: ProviderModels): TierModel {
  return models[tier] ?? (tier === 'max' ? models.advanced : undefined) ?? {}
}

/**
 * Resolve the complete route applied when a role is delegated to a provider.
 * @param role - Assigned task role.
 * @param profile - Active execution profile.
 * @param provider - Concrete provider that will execute the task.
 * @param models - Tier table of `provider`.
 * @returns Tier, access, and the concrete model and effort.
 */
export function resolveRoute(
  role: Role,
  profile: ToranjaExecutionProfile,
  provider: RunProvider,
  models: ProviderModels,
): ToranjaRoleRoute {
  const tier = modelTier(role, profile)
  const { model, effort } = tierModel(tier, models)
  return {
    role,
    provider,
    tier,
    access: roleAccess(role),
    ...model === undefined ? {} : { model },
    ...effort === undefined ? {} : { effort },
  }
}

/**
 * Registry name of the Toranja-owned provider instance for a route. Routes with
 * equal model, effort, and enforced access share one instance.
 * @param baseName - Registry name of the deployment's unrouted provider.
 * @param route - Resolved route.
 * @returns Stable instance name.
 */
export function variantName(baseName: string, route: ToranjaRoleRoute): string {
  const access = route.access === 'read-only' ? 'ro' : 'rw'
  return `${baseName}~${access}~${route.model ?? 'native'}~${route.effort ?? 'native'}`
}

/**
 * Build the provider plugin configuration for a route. Read-only access maps to
 * the provider's own non-writing mode; `execute` and `write` keep the
 * deployment's base permissions.
 * @param provider - Provider whose plugin is configured.
 * @param base - Deployment-owned base configuration of that plugin.
 * @param route - Resolved route.
 * @param providerName - Registry name for the instance.
 * @returns Configuration accepted by the provider plugin's `Config` schema.
 */
export function variantConfig(
  provider: 'codex' | 'antigravity' | 'claude-code',
  base: Readonly<Record<string, unknown>>,
  route: ToranjaRoleRoute,
  providerName: string,
): Record<string, unknown> {
  const config: Record<string, unknown> = { ...base, providerName }
  if (route.model !== undefined) config.model = route.model
  if (route.effort !== undefined) config.effort = route.effort
  if (route.access !== 'read-only') return config
  switch (provider) {
    case 'codex':
      config.permissionMode = 'read-only'
      return config
    case 'antigravity':
      config.mode = 'plan'
      config.disableSlashCommands = false
      config.autoApproveTools = false
      return config
    case 'claude-code':
      config.permissionMode = 'plan'
      return config
  }
}

/** Content hashes of a working tree taken before and after a delegation. */
export interface WorkspaceFingerprint {
  /** Hash of tracked-file changes relative to `HEAD`. */
  readonly tracked: string
  /** Hash of the path, size, and modification time of untracked and ignored entries. */
  readonly untracked: string
}

/**
 * Describe a working-tree change that the role's access forbids.
 * @param access - Access level of the delegated role.
 * @param before - Fingerprint taken before the run.
 * @param after - Fingerprint taken after the run.
 * @returns Violation text, or `undefined` when the access level was respected.
 */
export function accessViolation(
  access: ToranjaRoleAccess,
  before: WorkspaceFingerprint,
  after: WorkspaceFingerprint,
): string | undefined {
  if (access === 'write') return undefined
  if (before.tracked !== after.tracked) return `${access} role changed tracked files`
  if (access === 'read-only' && before.untracked !== after.untracked) return 'read-only role created, removed, or changed untracked files'
  return undefined
}

const PROVIDER_FAILURE = new RegExp([
  String.raw`category: (?:limit|service|transport|process)\b`,
  'resource_exhausted|quota|rate limit|usage limit|credit limit',
  String.raw`\b429\b|\b50[234]\b|overloaded|unavailable|timed out`,
  String.raw`\bENOENT\b|\bECONNRESET\b|\bECONNREFUSED\b|\bENOTFOUND\b`,
].join('|'), 'i')

/**
 * Tell a failure of the provider itself (quota, rate limit, outage, missing or
 * crashed process, timeout) from a task that failed on its own merits. Only the
 * former justifies rerunning the same task on another provider.
 * @param diagnostic - Failure diagnostic reported by the provider run.
 * @returns True when another provider could plausibly complete the task.
 */
export function isProviderFailure(diagnostic: string | undefined): boolean {
  return diagnostic !== undefined && PROVIDER_FAILURE.test(diagnostic)
}
