// @vitest-environment jsdom
/** What the browser half registers, and that the settings page reaches the Host through the injected actions. */

import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import type { OrchestratorSectionInjected } from '../src/client/index.ts'
import { apply, inject } from '../src/client/index.ts'

// The generated Remote contribution is a build artifact; the scripted Remote below stands in for it.
vi.mock('@deepseek-ai/dsh-toranja-orchestrator/remote', () => ({ default: {} }))

interface Registration {
  readonly name: string
  readonly id?: string
  readonly order?: number
  readonly label?: () => string
  readonly inject?: () => unknown
}

async function bench() {
  const ctx = new Context()
  const snapshot = { mode: 'team' }
  const toranja = {
    status: vi.fn(() => Promise.resolve({ ok: true, value: snapshot })),
    setMode: vi.fn(() => Promise.resolve({ ok: true, value: snapshot })),
    updateSettings: vi.fn(() => Promise.resolve({ ok: true, value: snapshot })),
    probeProviders: vi.fn(() => Promise.resolve({ ok: true, value: snapshot })),
    connectProvider: vi.fn(() => Promise.resolve({ ok: true, value: { provider: 'codex', command: ['codex', 'login'] } })),
    adoptLegacyMode: vi.fn(() => Promise.resolve({ ok: true, value: snapshot })),
  }
  ctx.provide('remote', { $mount: () => Promise.resolve(), toranja })
  const registrations: Registration[] = []
  ctx.provide('slots', {
    inject(_name: string, callback: () => () => void) { return callback() },
    register(options: Registration) {
      registrations.push(options)
      return () => { registrations.splice(registrations.indexOf(options), 1) }
    },
  })
  await ctx.plugin({ inject: [...inject], apply }).await()
  const section = registrations.find(registration => registration.name === 'settings.section')
  return { toranja, registrations, section, actions: section?.inject?.() as OrchestratorSectionInjected }
}

describe('ui-toranja-control apply', () => {
  it('registers the header panel and the Orchestrator settings page', async () => {
    const { registrations, section } = await bench()
    expect(registrations.map(registration => [registration.name, registration.id])).toEqual([
      ['conversation.session.header.actions', 'toranja-control'],
      ['settings.section', 'toranja-orchestrator'],
    ])
    expect(section?.label?.()).toBe('Orquestrador')
  })

  it('sends each page action to its Host method', async () => {
    const { actions, toranja } = await bench()
    await expect(actions.readStatus()).resolves.toEqual({ mode: 'team' })
    await actions.setMode('codex')
    expect(toranja.setMode).toHaveBeenCalledWith({ mode: 'codex' })
    await actions.updateSettings({ crossReview: false })
    expect(toranja.updateSettings).toHaveBeenCalledWith({ crossReview: false })
    await actions.probeProviders()
    expect(toranja.probeProviders).toHaveBeenCalledTimes(1)
    await expect(actions.connectProvider('codex')).resolves.toEqual({ provider: 'codex', command: ['codex', 'login'] })
    expect(toranja.connectProvider).toHaveBeenCalledWith({ provider: 'codex' })
  })

  it('reports the reason the Host gave when it rejects a change', async () => {
    const { actions, toranja } = await bench()
    toranja.updateSettings.mockResolvedValueOnce({ ok: false, error: { code: 'gateway/internal', message: 'teamSize must not exceed 8' } } as never)
    await expect(actions.updateSettings({ teamSize: 9 })).rejects.toThrow('teamSize must not exceed 8')
  })
})
