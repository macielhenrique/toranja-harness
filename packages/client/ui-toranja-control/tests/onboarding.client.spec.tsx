// @vitest-environment jsdom
/** The first-run setup over a scripted Host: when it shows, what each step sends, and how it ends. */

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  ToranjaOrchestrationStatus,
  ToranjaProviderId,
  ToranjaProviderStatus,
  ToranjaSettingsRequest,
} from '@deepseek-ai/dsh-toranja-orchestrator/types'
import { ToranjaOnboarding, type ToranjaOnboardingProps } from '../src/client/ToranjaOnboarding.tsx'

afterEach(cleanup)

function provider(id: ToranjaProviderId, rest: Partial<ToranjaProviderStatus> = {}): ToranjaProviderStatus {
  return {
    id,
    registryName: id,
    available: true,
    connection: 'connected',
    roles: ['implementer'],
    readOnlyEnforcement: 'sandbox',
    tierModels: {},
    tierModelOverrides: {},
    tierModelsEditable: true,
    metrics: { active: 0, completed: 0, failed: 0 },
    ...rest,
  }
}

function status(rest: Partial<ToranjaOrchestrationStatus> = {}): ToranjaOrchestrationStatus {
  return {
    generatedAt: '2026-11-12T00:00:00.000Z',
    mode: 'team',
    profile: 'equilibrado',
    fallbackOrder: ['codex', 'antigravity', 'claude-code', 'openrouter'],
    roleProviders: {},
    crossReview: true,
    teamSize: 2,
    onboarded: false,
    active: 0,
    limits: {
      maxConcurrentTotal: 4, maxConcurrentPerProject: 2, maxConcurrentPerProvider: 2, maxTeamSize: 3, allowParallelImplementation: false,
    },
    projects: [],
    providers: [
      provider('codex'),
      provider('antigravity', { connection: 'signed-out', available: false }),
      provider('claude-code', { connection: 'not-installed', available: false }),
    ],
    routes: [],
    tasks: [],
    ...rest,
  }
}

interface MountOptions {
  explicit?: boolean
  /** Fail the named Host reads before the step mounts. */
  failing?: readonly ('readStatus' | 'probeProviders')[]
  /** Answer of the first sign-in check, held by the test. */
  firstCheck?: Promise<ToranjaOrchestrationStatus>
}

function mount(initial = status(), { explicit = false, failing = [], firstCheck }: MountOptions = {}) {
  let current = initial
  const complete = vi.fn()
  const host = {
    readStatus: vi.fn(() => Promise.resolve(current)),
    setMode: vi.fn((mode: ToranjaOrchestrationStatus['mode']) => {
      current = { ...current, mode }
      return Promise.resolve(current)
    }),
    updateSettings: vi.fn((request: ToranjaSettingsRequest) => {
      const { tierModels: _tierModels, ...settings } = request
      current = { ...current, ...settings }
      return Promise.resolve(current)
    }),
    probeProviders: vi.fn(() => Promise.resolve(current)),
    connectProvider: vi.fn((id: ToranjaProviderId) => Promise.resolve({ provider: id, command: ['agy'] })),
    set: (next: ToranjaOrchestrationStatus) => { current = next },
  }
  for (const read of failing) host[read].mockRejectedValue(new Error('offline'))
  if (firstCheck !== undefined) host.probeProviders.mockReturnValueOnce(firstCheck)
  // The step reads only the coordinator's props and its injected actions.
  const props = {
    stepId: 'toranja-orchestrator', explicit, complete, openSection: vi.fn(), ...host,
  } as unknown as ToranjaOnboardingProps
  render(<ToranjaOnboarding {...props} />)
  return { ...host, complete }
}

describe('Toranja first-run setup', () => {
  it('stays out of the way once the setup was finished', async () => {
    const host = mount(status({ onboarded: true }))
    await waitFor(() => { expect(host.complete).toHaveBeenCalledTimes(1) })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('says so and offers another try when the Host cannot be read, without counting the setup as done', async () => {
    const host = mount(status(), { failing: ['readStatus', 'probeProviders'] })
    const dialog = await screen.findByRole('dialog', { name: 'Conecte seus agentes' })
    expect(within(dialog).getByRole('alert').textContent).toContain('offline')
    expect(host.complete).not.toHaveBeenCalled()
    host.readStatus.mockResolvedValue(status())
    host.probeProviders.mockResolvedValue(status())
    fireEvent.click(within(dialog).getByRole('button', { name: 'Tentar de novo' }))
    // The dialog is drawn again with the providers once the Host answers.
    expect(await screen.findByRole('list', { name: 'Provedores' })).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('lets the user leave an unreadable setup for this session, to see it again next time', async () => {
    const host = mount(status(), { failing: ['readStatus', 'probeProviders'] })
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Pular por agora' }))
    await waitFor(() => { expect(host.complete).toHaveBeenCalledTimes(1) })
    // Nothing was stored: the Host could not be reached, so the setup shows again on the next start.
    expect(host.updateSettings).not.toHaveBeenCalled()
  })

  it('keeps a choice the user made while the first sign-in check was still running', async () => {
    const check = Promise.withResolvers<ToranjaOrchestrationStatus>()
    const host = mount(status(), { firstCheck: check.promise })
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Continuar' }))
    const dialog = await screen.findByRole('dialog', { name: 'Como você quer trabalhar' })
    fireEvent.click(within(dialog).getByRole('radio', { name: 'Só Codex' }))
    await waitFor(() => { expect(within(dialog).getByRole('radio', { name: 'Só Codex' }).getAttribute('aria-checked')).toBe('true') })
    // The check answers late, with the snapshot from before the choice.
    // Awaited inside act, so the late answer is fully handled before the assertion.
    await act(async () => {
      check.resolve(status())
      await check.promise
    })
    expect(within(dialog).getByRole('radio', { name: 'Só Codex' }).getAttribute('aria-checked')).toBe('true')
    expect(host.setMode).toHaveBeenCalledTimes(1)
  })

  it('says why a change made in the second step was rejected, however late the answer comes', async () => {
    const host = mount()
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Continuar' }))
    const dialog = await screen.findByRole('dialog', { name: 'Como você quer trabalhar' })
    const slow = Promise.withResolvers<ToranjaOrchestrationStatus>()
    host.updateSettings.mockReturnValueOnce(slow.promise)
    fireEvent.click(within(within(dialog).getByRole('group', { name: 'Tamanho da equipe' })).getByRole('button', { name: 'Aumentar a equipe' }))
    await waitFor(() => { expect(host.updateSettings).toHaveBeenCalledTimes(1) })
    await act(async () => {
      slow.reject(new Error('too late to matter'))
      await slow.promise.catch(() => undefined)
    })
    expect((await within(dialog).findByRole('alert')).textContent).toContain('too late to matter')
  })

  it('shows the last known sign-in states when reading them fresh fails', async () => {
    const host = mount(status(), { failing: ['probeProviders'] })
    const dialog = await screen.findByRole('dialog', { name: 'Conecte seus agentes' })
    expect(within(dialog).getByRole('listitem', { name: 'Codex' }).textContent).toContain('Conectado')
    expect(host.complete).not.toHaveBeenCalled()
  })

  it('reads the sign-in states fresh and lists every provider with what it needs', async () => {
    const host = mount()
    const dialog = await screen.findByRole('dialog', { name: 'Conecte seus agentes' })
    expect(host.probeProviders).toHaveBeenCalledTimes(1)
    const providers = within(dialog).getByRole('list', { name: 'Provedores' })
    expect(within(providers).getByRole('listitem', { name: 'Codex' }).textContent).toContain('Conectado')
    expect(within(providers).getByRole('listitem', { name: 'Claude Code' }).textContent).toContain('Não instalado')
    fireEvent.click(within(providers).getByRole('button', { name: 'Conectar Antigravity' }))
    await waitFor(() => { expect(host.connectProvider).toHaveBeenCalledWith('antigravity') })
    expect((await within(dialog).findByRole('status')).textContent).toContain('terminal')
  })

  it('lets the user go on with some providers left unconnected, choose how to work, and finish', async () => {
    const host = mount()
    fireEvent.click(within(await screen.findByRole('dialog', { name: 'Conecte seus agentes' })).getByRole('button', { name: 'Continuar' }))
    const dialog = await screen.findByRole('dialog', { name: 'Como você quer trabalhar' })
    const modes = within(dialog).getByRole('radiogroup', { name: 'Modo de trabalho dos agentes' })
    expect(within(modes).getByRole<HTMLButtonElement>('radio', { name: 'Só Antigravity' }).disabled).toBe(true)
    fireEvent.click(within(modes).getByRole('radio', { name: 'Só Codex' }))
    await waitFor(() => { expect(host.setMode).toHaveBeenCalledWith('codex') })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Concluir' }))
    await waitFor(() => { expect(host.updateSettings).toHaveBeenCalledWith({ onboarded: true }) })
    await waitFor(() => { expect(host.complete).toHaveBeenCalledTimes(1) })
  })

  it('offers the team size only for Team mode', async () => {
    const host = mount()
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Continuar' }))
    const dialog = await screen.findByRole('dialog', { name: 'Como você quer trabalhar' })
    fireEvent.click(within(within(dialog).getByRole('group', { name: 'Tamanho da equipe' })).getByRole('button', { name: 'Aumentar a equipe' }))
    await waitFor(() => { expect(host.updateSettings).toHaveBeenCalledWith({ teamSize: 3 }) })
    fireEvent.click(within(dialog).getByRole('radio', { name: 'Só Codex' }))
    await waitFor(() => { expect(within(dialog).queryByRole('group', { name: 'Tamanho da equipe' })).toBeNull() })
  })

  it('goes back to the providers from the second step', async () => {
    mount()
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Continuar' }))
    fireEvent.click(within(await screen.findByRole('dialog', { name: 'Como você quer trabalhar' })).getByRole('button', { name: 'Voltar' }))
    expect(await screen.findByRole('dialog', { name: 'Conecte seus agentes' })).toBeTruthy()
  })

  it('can be skipped at once, and is not shown again', async () => {
    const host = mount()
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Pular por agora' }))
    await waitFor(() => { expect(host.updateSettings).toHaveBeenCalledWith({ onboarded: true }) })
    await waitFor(() => { expect(host.complete).toHaveBeenCalledTimes(1) })
  })

  it('stays open and says why when finishing could not be stored', async () => {
    const host = mount()
    host.updateSettings.mockRejectedValueOnce(new Error('storage is read-only'))
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Pular por agora' }))
    expect((await screen.findByRole('alert')).textContent).toContain('storage is read-only')
    expect(host.complete).not.toHaveBeenCalled()
  })

  it('warns before the user goes on with no agent connected', async () => {
    mount(status({ providers: [provider('codex', { connection: 'signed-out', available: false })] }))
    const dialog = await screen.findByRole('dialog', { name: 'Conecte seus agentes' })
    expect(dialog.textContent).toContain('Nenhum agente conectado')
  })

  it('opens again on request even after it was finished', async () => {
    const host = mount(status({ onboarded: true }), { explicit: true })
    expect(await screen.findByRole('dialog', { name: 'Conecte seus agentes' })).toBeTruthy()
    expect(host.complete).not.toHaveBeenCalled()
  })
})
