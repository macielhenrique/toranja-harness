/**
 * Unified authentication contracts and state definitions for onboarding and settings.
 * Covers Google Antigravity, OpenAI, Claude Code, and custom API key providers.
 *
 * @module @deepseek-ai/dsh-credentials/auth-providers
 */

import type { Branded } from '@deepseek-ai/dsh-brand'
import type { CredentialRef } from './types.ts'

/** Supported identity and model provider identifiers in Toranja Harness onboarding. */
export type AuthProviderId =
  | 'google-antigravity'
  | 'openai'
  | 'claude-code'
  | 'openrouter'
  | 'deepseek'
  | 'custom'

/** Nominal identifier for an active browser or terminal sign-in attempt. */
export type AuthAttemptId = Branded<'AuthAttemptId'>

/** Granular states of an authentication attempt. */
export type AuthPhase =
  | 'idle'
  | 'initializing'
  | 'waiting-browser'
  | 'validating'
  | 'committing'
  | 'succeeded'
  | 'cancelled'
  | 'failed'

/** Failure classification rendered via localized client messages. */
export type AuthErrorCode =
  | 'network'
  | 'invalid-credentials'
  | 'browser-cancelled'
  | 'timeout'
  | 'storage'
  | 'unsupported'

/** Safe snapshot of an in-flight or recently settled login attempt. */
export interface AuthAttemptSnapshot {
  /** Unique id for this login attempt. */
  readonly id: AuthAttemptId
  /** Current phase of the attempt. */
  readonly phase: AuthPhase
  /** Authorization URL to be opened in browser for OAuth/consent, if applicable. */
  readonly authorizeUrl?: string | undefined
  /** Timestamp when the attempt expires. */
  readonly expiresAt?: number | undefined
  /** Error code if the attempt failed. */
  readonly errorCode?: AuthErrorCode | undefined
  /** Human-readable or system diagnostic reason for failure. */
  readonly errorMessage?: string | undefined
}

/** Operational status of one provider's authentication. */
export interface ProviderAuthStatus {
  /** Provider identifier. */
  readonly providerId: AuthProviderId
  /** Human-friendly name for UI display. */
  readonly displayName: string
  /** Whether a valid credential is saved and ready for requests. */
  readonly configured: boolean
  /** Connected account identifier or masked email, if known. */
  readonly accountIdentity?: string | undefined
  /** Environment variable reference backing this credential (e.g. `OPENAI_API_KEY`). */
  readonly credentialRef?: CredentialRef | undefined
  /** Active login attempt, if in progress. */
  readonly attempt?: AuthAttemptSnapshot | undefined
}

/** Input payload for submitting an API key manually. */
export interface SubmitApiKeyRequest {
  /** Target provider. */
  readonly providerId: AuthProviderId
  /** Plain-text API key provided by the user. */
  readonly apiKey: string
  /** Optional custom base URL for custom providers. */
  readonly baseURL?: string | undefined
}

/** Input payload to initiate an interactive browser-based login flow. */
export interface StartBrowserLoginRequest {
  /** Target provider. */
  readonly providerId: AuthProviderId
  /** Active UI locale for server-rendered consent pages. */
  readonly locale?: string | undefined
}

/** Service definition for unified authentication operations across all supported providers. */
export interface UnifiedAuthService {
  /**
   * Retrieve the current authentication and configuration state for all providers.
   * @returns array of statuses for each supported provider.
   */
  getStatuses(): Promise<readonly ProviderAuthStatus[]>

  /**
   * Start an interactive browser login flow for providers supporting OAuth or web consent.
   * @param request - parameters specifying the provider and UI preferences.
   * @returns snapshot of the initialized attempt including authorizeUrl.
   */
  startBrowserLogin(request: StartBrowserLoginRequest): Promise<AuthAttemptSnapshot>

  /**
   * Cancel an in-progress authentication attempt.
   * @param attemptId - attempt identifier to abort.
   */
  cancelAttempt(attemptId: AuthAttemptId): Promise<void>

  /**
   * Validate and save an API key for a provider.
   * @param request - provider, API key, and optional endpoint.
   * @returns updated provider status.
   */
  submitApiKey(request: SubmitApiKeyRequest): Promise<ProviderAuthStatus>

  /**
   * Disconnect or remove stored credentials for a provider.
   * @param providerId - provider to sign out or clear.
   */
  disconnect(providerId: AuthProviderId): Promise<void>
}
