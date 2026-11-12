// @vitest-environment jsdom
/** The Orchestrator settings page over a scripted Host: what it shows and which request each control sends. */

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  ToranjaOrchestrationStatus,
  ToranjaProviderId,
  ToranjaProviderStatus,
  ToranjaSettingsRequest,
  ToranjaTaskRole,
} from '@deepseek-ai/dsh-toranja-orchestrator/types'
import { OrchestratorSection, type OrchestratorSectionProps } from '../src/client/OrchestratorSection.tsx'

afterEach(cleanup)

const ROLES: ToranjaTaskRole[] = [
  'reader', 'searcher', 'inspector', 'planner', 'architect', 'implementer', 'reviewer', 'tester', 'release',
]

function provider(id: ToranjaProviderId, rest: Partial<ToranjaProviderStatus> = {}): ToranjaProviderStatus {
  return {
    id,
    registryName: id,
    available: true,
    connection: 'connected',
    roles: ROLES,
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
    onboarded: true,
    active: 0,
    limits: {
      maxConcurrentTotal: 4, maxConcurrentPerProject: 2, maxConcurrentPerProvider: 2, maxTeamSize: 3, allowParallelImplementation: false,
    },
    projects: [],
    providers: [
      provider('codex', {
        tierModels: {
          light: { model: 'gpt-light', effort: 'low' },
          advanced: { model: 'gpt-strong', effort: 'medium' },
        },
      }),
      provider('antigravity', { readOnlyEnforcement: 'advisory' }),
      provider('claude-code', { readOnlyEnforcement: 'permission-mode' }),
      provider('openrouter', { readOnlyEnforcement: 'none', roles: ['implementer'] }),
    ],
    routes: ROLES.map(role => ({
      role,
      provider: role === 'implementer' ? 'antigravity' : 'codex',
      tier: role === 'reader' ? 'light' : 'advanced',
      access: role === 'implementer' ? 'write' : role === 'tester' || role === 'release' ? 'execute' : 'read-only',
      model: role === 'reader' ? 'gpt-light' : 'gpt-strong',
      effort: role === 'reader' ? 'low' : 'medium',
    })),
    tasks: [],
    ...rest,
  }
}

/** Mount the page over a Host that stores what it is sent and answers with the new snapshot. */
function mount(initial = status(), refreshMs?: number) {
  let current = initial
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
  // The page reads only its injected actions; the renderer's own runtime props are not part of this seam.
  const props = { close: () => undefined, refreshMs, ...host } as unknown as OrchestratorSectionProps
  render(<OrchestratorSection {...props} />)
  return host
}

const row = async (name: string): Promise<HTMLElement> =>
  within(await screen.findByRole('list', { name: 'Provedores' })).getByRole('listitem', { name })

describe('Orchestrator settings page: providers', () => {
  it('shows the sign-in state of each provider and what to do about it', async () => {
    mount(status({
      providers: [
        provider('codex'),
        provider('antigravity', { connection: 'signed-out', available: false }),
        provider('claude-code', { connection: 'not-installed', available: false }),
        provider('openrouter', { connection: 'signed-out', available: false, roles: ['implementer'] }),
      ],
    }))
    expect((await row('Codex')).textContent).toContain('Conectado')
    expect((await row('Antigravity')).textContent).toContain('Desconectado')
    expect(within(await row('Codex')).queryByRole('button')).toBeNull()
    // A CLI that is missing cannot be signed in to, and OpenRouter has no sign-in command.
    expect((await row('Claude Code')).textContent).toContain('Não instalado')
    expect(within(await row('Claude Code')).queryByRole('button')).toBeNull()
    expect((await row('OpenRouter')).textContent).toContain('Agentes e modelos')
    expect(within(await row('OpenRouter')).queryByRole('button')).toBeNull()
  })

  it('opens the official sign-in of a signed-out provider and says where to finish it', async () => {
    const host = mount(status({
      providers: [provider('codex'), provider('antigravity', { connection: 'signed-out', available: false })],
    }))
    fireEvent.click(within(await row('Antigravity')).getByRole('button', { name: 'Conectar Antigravity' }))
    await waitFor(() => { expect(host.connectProvider).toHaveBeenCalledWith('antigravity') })
    expect((await screen.findByRole('status')).textContent).toContain('terminal')
  })

  it('reads the sign-in states again on request', async () => {
    const host = mount(status({ providers: [provider('codex', { connection: 'signed-out', available: false })] }))
    expect((await row('Codex')).textContent).toContain('Desconectado')
    host.set(status({ providers: [provider('codex')] }))
    fireEvent.click(screen.getByRole('button', { name: 'Verificar conexões' }))
    await waitFor(async () => { expect((await row('Codex')).textContent).toContain('Conectado') })
    expect(host.probeProviders).toHaveBeenCalledTimes(1)
  })

  it('says that a connected OpenRouter still needs a model before it can take tasks', async () => {
    mount(status({ providers: [provider('openrouter', { available: false, roles: ['implementer'] })] }))
    expect((await row('OpenRouter')).textContent).toContain('falta um modelo')
  })
})

describe('Orchestrator settings page: mode, team size, and profile', () => {
  it('changes the routing mode through setMode and nothing else', async () => {
    const host = mount()
    const modes = await screen.findByRole('radiogroup', { name: 'Modo de trabalho dos agentes' })
    expect(within(modes).getByRole('radio', { name: 'Equipe' }).getAttribute('aria-checked')).toBe('true')
    fireEvent.click(within(modes).getByRole('radio', { name: 'Só Codex' }))
    await waitFor(() => { expect(host.setMode).toHaveBeenCalledWith('codex') })
    await waitFor(() => {
      expect(within(modes).getByRole('radio', { name: 'Só Codex' }).getAttribute('aria-checked')).toBe('true')
    })
    expect(host.updateSettings).not.toHaveBeenCalled()
  })

  it('does not offer a solo mode on a provider that cannot take tasks', async () => {
    mount(status({ providers: [provider('codex'), provider('antigravity', { connection: 'signed-out', available: false })] }))
    const modes = await screen.findByRole('radiogroup', { name: 'Modo de trabalho dos agentes' })
    expect(within(modes).getByRole<HTMLButtonElement>('radio', { name: 'Só Antigravity' }).disabled).toBe(true)
    expect(within(modes).getByRole<HTMLButtonElement>('radio', { name: 'Só Codex' }).disabled).toBe(false)
  })

  it('changes the team size one agent at a time, up to the deployment limit, without restating the mode', async () => {
    const host = mount()
    const size = await screen.findByRole('group', { name: 'Tamanho da equipe' })
    expect(within(size).getByText('2')).toBeTruthy()
    fireEvent.click(within(size).getByRole('button', { name: 'Aumentar a equipe' }))
    await waitFor(() => { expect(host.updateSettings).toHaveBeenCalledWith({ teamSize: 3 }) })
    await waitFor(() => { expect(within(size).getByText('3')).toBeTruthy() })
    expect(within(size).getByRole<HTMLButtonElement>('button', { name: 'Aumentar a equipe' }).disabled).toBe(true)
    fireEvent.click(within(size).getByRole('button', { name: 'Diminuir a equipe' }))
    await waitFor(() => { expect(host.updateSettings).toHaveBeenLastCalledWith({ teamSize: 2 }) })
  })

  it('changes the cost and quality profile', async () => {
    const host = mount()
    const profiles = await screen.findByRole('radiogroup', { name: 'Perfil de custo e qualidade' })
    fireEvent.click(within(profiles).getByRole('radio', { name: 'Qualidade' }))
    await waitFor(() => { expect(host.updateSettings).toHaveBeenCalledWith({ profile: 'qualidade' }) })
  })

  it('does not read the Host again over a change that is still being stored', async () => {
    const host = mount(status(), 15)
    const profiles = await screen.findByRole('radiogroup', { name: 'Perfil de custo e qualidade' })
    const stored = Promise.withResolvers<ToranjaOrchestrationStatus>()
    host.updateSettings.mockReturnValueOnce(stored.promise)
    fireEvent.click(within(profiles).getByRole('radio', { name: 'Qualidade' }))
    await waitFor(() => { expect(host.updateSettings).toHaveBeenCalledTimes(1) })
    const readsBefore = host.readStatus.mock.calls.length
    // Several refresh intervals pass while the change is in flight.
    await new Promise((resolve) => { setTimeout(resolve, 80) })
    expect(host.readStatus.mock.calls.length).toBe(readsBefore)
    expect(within(profiles).getByRole<HTMLButtonElement>('radio', { name: 'Econômico' }).disabled).toBe(true)
    host.set(status({ profile: 'qualidade' }))
    stored.resolve(status({ profile: 'qualidade' }))
    await waitFor(() => {
      expect(within(profiles).getByRole('radio', { name: 'Qualidade' }).getAttribute('aria-checked')).toBe('true')
    })
    // Reading resumes once the change is stored.
    await waitFor(() => { expect(host.readStatus.mock.calls.length).toBeGreaterThan(readsBefore) })
  })

  it('shows why a change was rejected and keeps what the Host has stored', async () => {
    const host = mount()
    host.updateSettings.mockRejectedValueOnce(new Error('teamSize must not exceed 3'))
    const size = await screen.findByRole('group', { name: 'Tamanho da equipe' })
    fireEvent.click(within(size).getByRole('button', { name: 'Aumentar a equipe' }))
    expect((await screen.findByRole('alert')).textContent).toContain('teamSize must not exceed 3')
    expect(within(size).getByText('2')).toBeTruthy()
  })
})

describe('Orchestrator settings page: roles, fallback, and cross-review', () => {
  const roleRow = async (name: string): Promise<HTMLElement> =>
    within(await screen.findByRole('table', { name: 'Papéis' })).getByRole('rowheader', { name }).closest('tr')!
  const options = (name: string): (string | null)[] =>
    within(screen.getByRole('combobox', { name })).getAllByRole('option').map(option => option.textContent)

  it('shows the route each role takes and how reading is enforced on it', async () => {
    mount()
    const reader = await roleRow('Leitura')
    expect(reader.textContent).toContain('Codex · gpt-light · low')
    expect(reader.textContent).toContain('Só leitura')
    expect(reader.textContent).toContain('bloqueio por sandbox')
    const implementer = await roleRow('Implementação')
    expect(implementer.textContent).toContain('Antigravity · gpt-strong · medium')
    expect(implementer.textContent).toContain('Escreve')
    expect(implementer.textContent).not.toContain('bloqueio')
  })

  it('sets and clears the preferred provider of a role, keeping the other roles', async () => {
    const host = mount(status({ roleProviders: { reviewer: 'antigravity' } }))
    fireEvent.change(await screen.findByRole('combobox', { name: 'Provedor do papel Planejamento' }), { target: { value: 'claude-code' } })
    await waitFor(() => {
      expect(host.updateSettings).toHaveBeenCalledWith({ roleProviders: { reviewer: 'antigravity', planner: 'claude-code' } })
    })
    await waitFor(() => {
      expect(screen.getByRole<HTMLSelectElement>('combobox', { name: 'Provedor do papel Planejamento' }).value).toBe('claude-code')
    })
    fireEvent.change(screen.getByRole('combobox', { name: 'Provedor do papel Revisão' }), { target: { value: '' } })
    await waitFor(() => {
      expect(host.updateSettings).toHaveBeenLastCalledWith({ roleProviders: { planner: 'claude-code' } })
    })
  })

  it('offers a role only the providers that may take it', async () => {
    mount()
    await roleRow('Leitura')
    expect(options('Provedor do papel Leitura')).toEqual(['Padrão', 'Codex', 'Antigravity', 'Claude Code'])
    expect(options('Provedor do papel Implementação')).toEqual(['Padrão', 'Codex', 'Antigravity', 'Claude Code', 'OpenRouter'])
  })

  it('locks the role preferences in a solo mode, where every role uses that provider', async () => {
    mount(status({ mode: 'codex' }))
    await roleRow('Leitura')
    expect(screen.getByRole<HTMLSelectElement>('combobox', { name: 'Provedor do papel Leitura' }).disabled).toBe(true)
    expect(screen.getByText(/todos os papéis usam Codex/)).toBeTruthy()
  })

  it('moves a provider up and down the fallback order', async () => {
    const host = mount()
    const order = await screen.findByRole('list', { name: 'Ordem de fallback' })
    const names = (): (string | null)[] => within(order).getAllByRole('listitem').map(item => item.getAttribute('aria-label'))
    expect(names()).toEqual(['Codex', 'Antigravity', 'Claude Code', 'OpenRouter'])
    expect(within(order).getByRole<HTMLButtonElement>('button', { name: 'Subir Codex' }).disabled).toBe(true)
    expect(within(order).getByRole<HTMLButtonElement>('button', { name: 'Descer OpenRouter' }).disabled).toBe(true)
    fireEvent.click(within(order).getByRole('button', { name: 'Subir Antigravity' }))
    await waitFor(() => {
      expect(host.updateSettings).toHaveBeenCalledWith({ fallbackOrder: ['antigravity', 'codex', 'claude-code', 'openrouter'] })
    })
    await waitFor(() => { expect(names()).toEqual(['Antigravity', 'Codex', 'Claude Code', 'OpenRouter']) })
    fireEvent.click(within(order).getByRole('button', { name: 'Descer Codex' }))
    await waitFor(() => {
      expect(host.updateSettings).toHaveBeenLastCalledWith({ fallbackOrder: ['antigravity', 'claude-code', 'codex', 'openrouter'] })
    })
  })

  it('switches cross-review', async () => {
    const host = mount()
    const toggle = await screen.findByRole('switch', { name: 'Revisar com um provedor diferente do que implementou' })
    expect(toggle.getAttribute('aria-checked')).toBe('true')
    fireEvent.click(toggle)
    await waitFor(() => { expect(host.updateSettings).toHaveBeenCalledWith({ crossReview: false }) })
  })
})

describe('Orchestrator settings page: tier models', () => {
  const models = (name: string): Promise<HTMLElement> => screen.findByRole('group', { name: 'Modelos de ' + name })
  const field = (group: HTMLElement, name: string): HTMLInputElement => within(group).getByRole<HTMLInputElement>('textbox', { name })
  const button = (group: HTMLElement, name: string): HTMLButtonElement => within(group).getByRole<HTMLButtonElement>('button', { name })

  it('shows the model in force per tier and where an empty tier takes its model from', async () => {
    mount()
    const codex = await models('Codex')
    expect(field(codex, 'Modelo do nível Leve').value).toBe('gpt-light')
    expect(field(codex, 'Esforço do nível Leve').value).toBe('low')
    expect(field(codex, 'Modelo do nível Máximo').value).toBe('')
    expect(field(codex, 'Modelo do nível Máximo').placeholder).toBe('usa o Avançado')
    expect(field(await models('Antigravity'), 'Modelo do nível Leve').placeholder).toBe('padrão do provedor')
    expect(button(codex, 'Salvar').disabled).toBe(true)
    expect(button(codex, 'Restaurar padrão').disabled).toBe(true)
  })

  it('saves only the tier the user changed, for that provider alone', async () => {
    const host = mount()
    const codex = await models('Codex')
    fireEvent.change(field(codex, 'Modelo do nível Máximo'), { target: { value: ' gpt-max ' } })
    fireEvent.change(field(codex, 'Esforço do nível Máximo'), { target: { value: 'high' } })
    fireEvent.click(button(codex, 'Salvar'))
    await waitFor(() => {
      expect(host.updateSettings).toHaveBeenCalledWith({ tierModels: { codex: { max: { model: 'gpt-max', effort: 'high' } } } })
    })
  })

  it('keeps the tiers set earlier when another is saved, and restores the deployment models on request', async () => {
    const host = mount(status({
      providers: [provider('codex', {
        tierModels: { light: { model: 'gpt-tiny', effort: 'low' }, advanced: { model: 'gpt-strong', effort: 'medium' } },
        tierModelOverrides: { light: { model: 'gpt-tiny', effort: 'low' } },
      })],
    }))
    const codex = await models('Codex')
    expect(within(codex).getAllByText('personalizado')).toHaveLength(1)
    fireEvent.change(field(codex, 'Modelo do nível Avançado'), { target: { value: 'gpt-stronger' } })
    fireEvent.click(button(codex, 'Salvar'))
    await waitFor(() => {
      expect(host.updateSettings).toHaveBeenCalledWith({
        tierModels: { codex: { light: { model: 'gpt-tiny', effort: 'low' }, advanced: { model: 'gpt-stronger', effort: 'medium' } } },
      })
    })
    fireEvent.click(button(codex, 'Restaurar padrão'))
    await waitFor(() => { expect(host.updateSettings).toHaveBeenLastCalledWith({ tierModels: { codex: {} } }) })
  })

  it('keeps what the user is typing when the page reads the Host again', async () => {
    const host = mount()
    const codex = await models('Codex')
    fireEvent.change(field(codex, 'Modelo do nível Máximo'), { target: { value: 'gpt-max' } })
    host.set(status({ providers: [provider('codex', { tierModels: { light: { model: 'gpt-other' } } })] }))
    fireEvent.click(screen.getByRole('button', { name: 'Verificar conexões' }))
    await waitFor(() => { expect(field(codex, 'Modelo do nível Leve').value).toBe('gpt-other') })
    expect(field(codex, 'Modelo do nível Máximo').value).toBe('gpt-max')
  })

  it('explains why a provider without a Toranja instance has no models to edit', async () => {
    mount(status({ providers: [provider('claude-code', { tierModelsEditable: false, readOnlyEnforcement: 'none' })] }))
    const group = await models('Claude Code')
    expect(within(group).queryByRole('textbox')).toBeNull()
    expect(group.textContent).toContain('instância própria')
  })
})
