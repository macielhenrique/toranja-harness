import { describe, expect, it } from 'vitest'
import {
  ROLES,
  accessViolation,
  isProviderFailure,
  modelTier,
  resolveRoute,
  roleAccess,
  tierModel,
  variantConfig,
  variantName,
} from '../src/index.ts'

describe('Toranja routing policy', () => {
  it('gives every role one access level', () => {
    expect(Object.fromEntries(ROLES.map(role => [role, roleAccess(role)]))).toEqual({
      reader: 'read-only',
      searcher: 'read-only',
      inspector: 'read-only',
      planner: 'read-only',
      architect: 'read-only',
      implementer: 'write',
      reviewer: 'read-only',
      tester: 'execute',
      release: 'execute',
    })
  })

  it('maps roles to distinct tiers per execution profile', () => {
    const table = (profile: 'economico' | 'equilibrado' | 'qualidade') =>
      Object.fromEntries(ROLES.map(role => [role, modelTier(role, profile)]))
    expect(table('economico')).toEqual({
      reader: 'light', searcher: 'light', inspector: 'light',
      planner: 'advanced', architect: 'advanced', implementer: 'advanced', reviewer: 'advanced',
      tester: 'light', release: 'light',
    })
    expect(table('equilibrado')).toEqual({
      reader: 'light', searcher: 'light', inspector: 'light',
      planner: 'advanced', architect: 'advanced', implementer: 'advanced', reviewer: 'advanced',
      tester: 'advanced', release: 'advanced',
    })
    expect(table('qualidade')).toEqual({
      reader: 'light', searcher: 'light', inspector: 'light',
      planner: 'max', architect: 'max', implementer: 'advanced', reviewer: 'max',
      tester: 'advanced', release: 'advanced',
    })
  })

  it('resolves the concrete model and falls back from max to advanced', () => {
    const models = {
      light: { model: 'flash', effort: 'low' },
      advanced: { model: 'argon', effort: 'medium' },
    }
    expect(tierModel('max', models)).toEqual({ model: 'argon', effort: 'medium' })
    expect(tierModel('max', { ...models, max: { model: 'argon', effort: 'high' } })).toEqual({ model: 'argon', effort: 'high' })
    expect(tierModel('light', {})).toEqual({})
    expect(resolveRoute('reader', 'qualidade', 'antigravity', models)).toEqual({
      role: 'reader', provider: 'antigravity', tier: 'light', access: 'read-only', model: 'flash', effort: 'low',
    })
    expect(resolveRoute('implementer', 'economico', 'codex', {})).toEqual({
      role: 'implementer', provider: 'codex', tier: 'advanced', access: 'write',
    })
  })

  it('builds provider configuration that enforces read-only access', () => {
    const reader = resolveRoute('reader', 'equilibrado', 'codex', { light: { model: 'luna', effort: 'low' } })
    expect(variantName('codex', reader)).toBe('codex~ro~luna~low')
    expect(variantConfig('codex', { env: { A: 'b' }, permissionMode: 'never' }, reader, 'codex~ro~luna~low')).toEqual({
      env: { A: 'b' }, providerName: 'codex~ro~luna~low', model: 'luna', effort: 'low', permissionMode: 'read-only',
    })
    expect(variantConfig('antigravity', { autoApproveTools: true, mode: 'accept-edits' }, { ...reader, provider: 'antigravity' }, 'x')).toEqual({
      providerName: 'x', model: 'luna', effort: 'low', mode: 'plan', disableSlashCommands: false, autoApproveTools: false,
    })
    expect(variantConfig('claude-code', { permissionMode: 'acceptEdits', env: { A: 'b' } }, { ...reader, provider: 'claude-code' }, 'z')).toEqual({
      env: { A: 'b' }, providerName: 'z', model: 'luna', effort: 'low', permissionMode: 'plan',
    })
    const implementer = resolveRoute('implementer', 'equilibrado', 'antigravity', {})
    expect(variantName('antigravity', implementer)).toBe('antigravity~rw~native~native')
    expect(variantConfig('antigravity', { autoApproveTools: true, mode: 'accept-edits' }, implementer, 'y')).toEqual({
      autoApproveTools: true, mode: 'accept-edits', providerName: 'y',
    })
  })

  it('tells a provider outage or quota limit from a task that failed on its own merits', () => {
    for (const diagnostic of [
      'product: Codex; stage: turn; category: limit',
      'product: Codex; stage: turn; category: service; http status: 503',
      'product: Codex; stage: process; category: process',
      'Antigravity status: ERROR RESOURCE_EXHAUSTED: quota exceeded',
      'HTTP 429 Too Many Requests',
      'rate limit reached for this account',
      'Antigravity timed out after 600000 ms',
      'spawn agy ENOENT',
    ]) expect(isProviderFailure(diagnostic), diagnostic).toBe(true)
    for (const diagnostic of [
      undefined,
      'product: Codex; stage: turn; category: access-policy',
      'product: Codex; stage: turn; category: invalid-result',
      'the requested file does not exist',
      'read-only role changed tracked files',
    ]) expect(isProviderFailure(diagnostic), String(diagnostic)).toBe(false)
  })

  it('reports only changes the access level forbids', () => {
    const before = { tracked: 'a', untracked: 'b' }
    expect(accessViolation('write', before, { tracked: 'x', untracked: 'y' })).toBeUndefined()
    expect(accessViolation('read-only', before, before)).toBeUndefined()
    expect(accessViolation('read-only', before, { tracked: 'a', untracked: 'y' })).toBe('read-only role created, removed, or changed untracked files')
    expect(accessViolation('read-only', before, { tracked: 'x', untracked: 'b' })).toBe('read-only role changed tracked files')
    expect(accessViolation('execute', before, { tracked: 'a', untracked: 'y' })).toBeUndefined()
    expect(accessViolation('execute', before, { tracked: 'x', untracked: 'b' })).toBe('execute role changed tracked files')
  })
})
