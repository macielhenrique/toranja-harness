import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { UnifiedAuthManager } from '../src/index.ts'
import { MemoryCredentials } from './memory.ts'

describe('UnifiedAuthManager', () => {
  it('returns default unconfigured statuses for all main providers', async () => {
    const ctx = new Context()
    new MemoryCredentials(ctx)
    const manager = new UnifiedAuthManager(ctx)

    const statuses = await manager.getStatuses()
    expect(statuses).toHaveLength(5)
    expect(statuses.map(s => s.providerId)).toEqual([
      'google-antigravity',
      'openai',
      'claude-code',
      'openrouter',
      'deepseek',
    ])
    expect(statuses.every(s => !s.configured)).toBe(true)
  })

  it('starts browser login for Google Antigravity with OAuth authorize URL', async () => {
    const ctx = new Context()
    new MemoryCredentials(ctx)
    const manager = new UnifiedAuthManager(ctx)

    const attempt = await manager.startBrowserLogin({ providerId: 'google-antigravity' })
    expect(attempt.phase).toBe('waiting-browser')
    expect(attempt.authorizeUrl).toContain('accounts.google.com')

    await manager.cancelAttempt(attempt.id)
  })

  it('starts browser login for Claude Code with login URL', async () => {
    const ctx = new Context()
    new MemoryCredentials(ctx)
    const manager = new UnifiedAuthManager(ctx)

    const attempt = await manager.startBrowserLogin({ providerId: 'claude-code' })
    expect(attempt.phase).toBe('waiting-browser')
    expect(attempt.authorizeUrl).toContain('claude.ai')
  })

  it('disconnects stored credentials properly', async () => {
    const ctx = new Context()
    new MemoryCredentials(ctx, { ANTIGRAVITY_API_KEY: 'test-key' })
    const manager = new UnifiedAuthManager(ctx)

    const before = await manager.getStatuses()
    const agyBefore = before.find(s => s.providerId === 'google-antigravity')
    expect(agyBefore?.configured).toBe(true)

    await manager.disconnect('google-antigravity')

    const after = await manager.getStatuses()
    const agyAfter = after.find(s => s.providerId === 'google-antigravity')
    expect(agyAfter?.configured).toBe(false)
  })
})
