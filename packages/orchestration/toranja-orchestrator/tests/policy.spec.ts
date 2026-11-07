import { describe, expect, it } from 'vitest'
import {
  OrchestrationLedger,
  assertProvidersAllowed,
  defaultProvider,
  parseGateVerdict,
  slugifyProjectId,
  type OrchestrationLimits,
} from '../src/policy.ts'

const limits: OrchestrationLimits = {
  maxConcurrentTotal: 4,
  maxConcurrentPerProject: 2,
  maxConcurrentPerProvider: 2,
  allowParallelImplementation: false,
}

describe('OrchestrationLedger', () => {
  it('reserves a cross-provider read-only batch atomically and records outcomes', () => {
    const ledger = new OrchestrationLedger(limits)
    const leases = ledger.reserveBatch([
      { project: 'portal-web', provider: 'codex', role: 'reviewer' },
      { project: 'portal-web', provider: 'antigravity', role: 'tester' },
    ])

    expect(ledger.activeCount).toBe(2)
    expect(ledger.project('portal-web')).toMatchObject({ active: 2, completed: 0, failed: 0 })
    leases[0]!.settle(true)
    leases[1]!.settle(false, 'test failure')

    expect(ledger.activeCount).toBe(0)
    expect(ledger.project('portal-web')).toMatchObject({ active: 0, completed: 1, failed: 1, lastError: 'test failure' })
    expect(ledger.provider('codex')).toMatchObject({ active: 0, completed: 1, failed: 0 })
    expect(ledger.provider('antigravity')).toMatchObject({ active: 0, completed: 0, failed: 1 })
    expect(ledger.tasks()).toEqual([
      expect.objectContaining({ provider: 'antigravity', state: 'failed', error: 'test failure' }),
      expect.objectContaining({ provider: 'codex', state: 'completed' }),
    ])
  })

  it('rejects conflicting implementers before reserving any capacity', () => {
    const ledger = new OrchestrationLedger(limits)
    expect(() => ledger.reserveBatch([
      { project: 'api-pedidos', provider: 'codex', role: 'implementer' },
      { project: 'api-pedidos', provider: 'antigravity', role: 'implementer' },
    ])).toThrow(/write isolation/u)
    expect(ledger.activeCount).toBe(0)
    expect(ledger.project('api-pedidos').active).toBe(0)
  })

  it('enforces project and provider capacity without leaking rejected reservations', () => {
    const ledger = new OrchestrationLedger({ ...limits, maxConcurrentPerProvider: 1 })
    const [lease] = ledger.reserveBatch([
      { project: 'portal-web', provider: 'codex', role: 'tester' },
    ])
    expect(() => ledger.reserveBatch([
      { project: 'api-pedidos', provider: 'codex', role: 'tester' },
    ])).toThrow(/provider limit/u)
    expect(ledger.activeCount).toBe(1)
    lease!.settle(true)
    lease!.settle(false, 'ignored duplicate settlement')
    expect(ledger.activeCount).toBe(0)
    expect(ledger.provider('codex')).toMatchObject({ completed: 1, failed: 0 })
  })

  it('exposes active task identity and ignores duplicate settlement', () => {
    const ledger = new OrchestrationLedger(limits)
    const [lease] = ledger.reserveBatch([{
      project: 'api-pedidos',
      provider: 'codex',
      role: 'implementer',
      label: 'Criar tela de pedidos',
    }])
    expect(lease?.taskId).toMatch(/^toranja-/u)
    expect(ledger.tasks()[0]).toMatchObject({
      id: lease?.taskId,
      label: 'Criar tela de pedidos',
      projectId: 'api-pedidos',
      role: 'implementer',
      state: 'active',
    })
    lease?.settle(true)
    lease?.settle(false, 'ignored')
    expect(ledger.tasks()[0]).toMatchObject({ state: 'completed' })
  })
})

describe('slugifyProjectId', () => {
  it('normalizes workspace titles into valid unique lane ids', () => {
    const used = new Set<string>()
    const first = slugifyProjectId('Catálogo Digital', used)
    used.add(first)
    const second = slugifyProjectId('Catálogo Digital', used)
    expect(first).toBe('catalogo-digital')
    expect(second).toBe('catalogo-digital-2')
    expect(slugifyProjectId('123 App', used)).toBe('p-123-app')
    expect(slugifyProjectId('---', used)).toBe('project')
  })
})

describe('parseGateVerdict', () => {
  it('accepts only an exact first non-empty PASS or FAIL line', () => {
    expect(parseGateVerdict('\nTORANJA_GATE: PASS\nAll checks passed.')).toBe('pass')
    expect(parseGateVerdict('TORANJA_GATE: FAIL\nMissing tests.')).toBe('fail')
    expect(parseGateVerdict('All good. TORANJA_GATE: PASS')).toBe('invalid')
    expect(parseGateVerdict('TORANJA_GATE: PASS maybe')).toBe('invalid')
  })
})

describe('provider routing mode', () => {
  it('routes every omitted delegation to the selected solo provider', () => {
    expect(defaultProvider('reviewer', 'codex')).toBe('codex')
    expect(defaultProvider('implementer', 'antigravity')).toBe('antigravity')
  })

  it('uses role-aware routing in team mode', () => {
    expect(defaultProvider('planner', 'team')).toBe('antigravity')
    expect(defaultProvider('reviewer', 'team')).toBe('antigravity')
    expect(defaultProvider('implementer', 'team')).toBe('codex')
    expect(defaultProvider('tester', 'team')).toBe('codex')
  })

  it('keeps solo modes exclusive and permits cross-provider work only in team mode', () => {
    expect(() => assertProvidersAllowed('antigravity', ['codex'])).toThrow(/select Team/u)
    expect(() => assertProvidersAllowed('codex', ['antigravity'])).toThrow(/select Team/u)
    expect(() => assertProvidersAllowed('antigravity', ['antigravity'])).not.toThrow()
    expect(() => assertProvidersAllowed('team', ['codex', 'antigravity'])).not.toThrow()
  })
})
