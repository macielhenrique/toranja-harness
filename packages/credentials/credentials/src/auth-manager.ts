/**
 * Concrete implementation of the unified authentication service for Toranja Harness.
 * Manages provider status detection, API key validation, and login attempts.
 *
 * @module @deepseek-ai/dsh-credentials/auth-manager
 */

import type { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import { credentialRef } from './index.ts'
import type {
  AuthAttemptId,
  AuthAttemptSnapshot,
  AuthProviderId,
  ProviderAuthStatus,
  StartBrowserLoginRequest,
  SubmitApiKeyRequest,
  UnifiedAuthService,
} from './auth-providers.ts'

interface ProviderMetadata {
  id: AuthProviderId
  displayName: string
  envRef: string
  validationEndpoint?: string
}

const PROVIDERS: readonly ProviderMetadata[] = [
  {
    id: 'google-antigravity',
    displayName: 'Google Antigravity (Gemini)',
    envRef: 'ANTIGRAVITY_API_KEY',
  },
  {
    id: 'openai',
    displayName: 'OpenAI (GPT)',
    envRef: 'OPENAI_API_KEY',
    validationEndpoint: 'https://api.openai.com/v1/models',
  },
  {
    id: 'claude-code',
    displayName: 'Claude Code (Anthropic)',
    envRef: 'ANTHROPIC_API_KEY',
    validationEndpoint: 'https://api.anthropic.com/v1/models',
  },
  {
    id: 'openrouter',
    displayName: 'OpenRouter',
    envRef: 'OPENROUTER_API_KEY',
    validationEndpoint: 'https://openrouter.ai/api/v1/models',
  },
  {
    id: 'deepseek',
    displayName: 'DeepSeek',
    envRef: 'DEEPSEEK_API_KEY',
    validationEndpoint: 'https://api.deepseek.com/models',
  },
]

/**
 * Validates an API key against a provider's models endpoint.
 * @param endpoint - URL to query with authorization header.
 * @param apiKey - secret key to validate.
 * @param extraHeaders - optional provider-specific headers (e.g. anthropic-version).
 * @returns true if valid, false if rejected or failed.
 */
async function validateApiKeyWithEndpoint(
  endpoint: string,
  apiKey: string,
  extraHeaders: Record<string, string> = {},
): Promise<{ ok: boolean; reason?: 'invalid-credentials' | 'network' }> {
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => { controller.abort() }, 10_000)
    const response = await fetch(endpoint, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'x-api-key': apiKey,
        ...extraHeaders,
      },
      signal: controller.signal,
    }).finally(() => { clearTimeout(timer) })

    if (response.ok || response.status === 200) {
      return { ok: true }
    }
    if (response.status === 401 || response.status === 403) {
      return { ok: false, reason: 'invalid-credentials' }
    }
    return { ok: false, reason: 'network' }
  } catch {
    return { ok: false, reason: 'network' }
  }
}

/** Unified authentication manager coordinating credential storage and validation. */
export class UnifiedAuthManager implements UnifiedAuthService {
  private readonly activeAttempts = new Map<AuthAttemptId, AuthAttemptSnapshot>()

  constructor(private readonly ctx: Context) {}

  /**
   * Retrieve current statuses for all supported providers.
   * @returns array of statuses describing readiness and identity.
   */
  async getStatuses(): Promise<readonly ProviderAuthStatus[]> {
    const results: ProviderAuthStatus[] = []

    for (const meta of PROVIDERS) {
      const ref = credentialRef(meta.envRef)
      const desc = await this.ctx.credentials.describe(ref)

      // Look for any active attempt
      let currentAttempt: AuthAttemptSnapshot | undefined
      for (const attempt of this.activeAttempts.values()) {
        // Find matching pending attempt if present
        if (attempt.phase === 'waiting-browser' || attempt.phase === 'validating') {
          currentAttempt = attempt
          break
        }
      }

      results.push({
        providerId: meta.id,
        displayName: meta.displayName,
        configured: desc.configured,
        credentialRef: ref,
        attempt: currentAttempt,
        accountIdentity: desc.configured ? (desc.source ?? 'configurado') : undefined,
      })
    }

    return results
  }

  /**
   * Initiate an interactive browser login flow.
   * @param request - provider to authenticate and optional locale.
   * @returns initialized attempt snapshot.
   */
  async startBrowserLogin(request: StartBrowserLoginRequest): Promise<AuthAttemptSnapshot> {
    const id = brandString<AuthAttemptId>(`auth_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`)

    if (request.providerId === 'google-antigravity') {
      const snapshot: AuthAttemptSnapshot = {
        id,
        phase: 'waiting-browser',
        authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
        expiresAt: Date.now() + 300_000,
      }
      this.activeAttempts.set(id, snapshot)
      return snapshot
    }

    if (request.providerId === 'claude-code') {
      const snapshot: AuthAttemptSnapshot = {
        id,
        phase: 'waiting-browser',
        authorizeUrl: 'https://claude.ai/login',
        expiresAt: Date.now() + 300_000,
      }
      this.activeAttempts.set(id, snapshot)
      return snapshot
    }

    const failedSnapshot: AuthAttemptSnapshot = {
      id,
      phase: 'failed',
      errorCode: 'unsupported',
      errorMessage: `Login via navegador não suportado diretamente para ${request.providerId}. Utilize chave de API.`,
    }
    return failedSnapshot
  }

  /**
   * Cancel an active sign-in attempt.
   * @param attemptId - attempt to cancel.
   */
  async cancelAttempt(attemptId: AuthAttemptId): Promise<void> {
    const attempt = this.activeAttempts.get(attemptId)
    if (attempt) {
      this.activeAttempts.set(attemptId, {
        ...attempt,
        phase: 'cancelled',
      })
    }
  }

  /**
   * Validate and save an API key for the requested provider.
   * @param request - provider, key, and optional endpoint.
   * @returns updated provider status.
   */
  async submitApiKey(request: SubmitApiKeyRequest): Promise<ProviderAuthStatus> {
    const meta = PROVIDERS.find(item => item.id === request.providerId)
    const envVar = meta?.envRef ?? `${request.providerId.toUpperCase()}_API_KEY`
    const ref = credentialRef(envVar)

    const endpoint = request.baseURL
      ? `${request.baseURL.replace(/\/+$/, '')}/models`
      : meta?.validationEndpoint

    if (endpoint) {
      const extraHeaders = request.providerId === 'claude-code'
        ? { 'anthropic-version': '2023-06-01' }
        : {}

      const check = await validateApiKeyWithEndpoint(endpoint, request.apiKey, extraHeaders)
      if (!check.ok) {
        return {
          providerId: request.providerId,
          displayName: meta?.displayName ?? request.providerId,
          configured: false,
          attempt: {
            id: brandString<AuthAttemptId>(`err_${Date.now()}`),
            phase: 'failed',
            errorCode: check.reason ?? 'invalid-credentials',
            errorMessage: 'Chave de API inválida ou rejeitada pelo provedor.',
          },
        }
      }
    }

    // Persist securely using the credential seam
    await this.ctx.credentials.set(ref, request.apiKey)

    return {
      providerId: request.providerId,
      displayName: meta?.displayName ?? request.providerId,
      configured: true,
      credentialRef: ref,
      accountIdentity: 'chave configurada localmente',
    }
  }

  /**
   * Remove credentials for a provider.
   * @param providerId - provider to disconnect.
   */
  async disconnect(providerId: AuthProviderId): Promise<void> {
    const meta = PROVIDERS.find(item => item.id === providerId)
    if (meta) {
      await this.ctx.credentials.unset(credentialRef(meta.envRef))
    }
  }
}
