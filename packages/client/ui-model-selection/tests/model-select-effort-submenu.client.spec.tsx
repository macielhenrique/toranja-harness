// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import type { ModelSelection } from '@deepseek-ai/dsh-api-remotes/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ComponentProps } from 'react'
import type { ModelDirectoryState } from '../src/client/directory.ts'
import { ModelSelect } from '../src/client/ModelSelect.tsx'
import { en } from '../src/client/locales.ts'

const t: ComponentProps<typeof ModelSelect>['t'] = (key, params) => {
  const template = (en as Record<string, string>)[key] ?? key
  return params === undefined
    ? template
    : template.replace(/\{(\w+)\}/g, (match, name: string) => name in params ? String(params[name]) : match)
}

const levels = {
  efforts: [{ id: 'low', name: 'Low' }, { id: 'medium', name: 'Medium' }, { id: 'high', name: 'High' }],
  defaultEffort: 'medium',
}

function state(overrides: Partial<ModelDirectoryState> = {}): ModelDirectoryState {
  return {
    current: { provider: 'antigravity-local', model: 'gemini-4-argon', reasoningEffort: 'high' },
    routable: true,
    groups: [{
      id: 'antigravity-local',
      name: 'Antigravity',
      models: [
        { id: 'default', name: 'Automatic' },
        { id: 'gemini-4-argon', name: 'Gemini 4 Argon', reasoning: levels },
        { id: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash', reasoning: levels },
      ],
    }],
    failures: [],
    status: 'ready',
    pending: null,
    error: null,
    ...overrides,
  }
}

function mount(initial = state()) {
  const directory = createSnapshotStore<ModelDirectoryState>(initial)
  const select = vi.fn(async (selection: ModelSelection) => {
    directory.set(state({ current: selection }))
    return { ok: true as const, value: undefined }
  })
  render(<ModelSelect locked={false} available directory={directory} load={vi.fn()} select={select} t={t} />)
  fireEvent.click(screen.getByRole('button', { name: /Select model/ }))
  fireEvent.click(screen.getByRole('menuitem', { name: /^Model/ }))
  return { select, directory }
}

const submenu = (model: string): HTMLElement => screen.getByRole('menu', { name: `Reasoning effort for ${model}` })
const arrow = (model: string): HTMLElement => screen.getByRole('menuitem', { name: `Reasoning effort for ${model}` })

beforeEach(() => {
  const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollIntoView')
  Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, writable: true, value: vi.fn() })
  onTestFinished(() => {
    if (descriptor === undefined) Reflect.deleteProperty(Element.prototype, 'scrollIntoView')
    else Object.defineProperty(Element.prototype, 'scrollIntoView', descriptor)
  })
})

afterEach(cleanup)

describe('ModelSelect reasoning effort submenu', () => {
  it('lists each model once and gives a side arrow only to models with reasoning levels', () => {
    mount()
    expect(screen.getAllByRole('menuitemradio').map(row => row.textContent)).toEqual([
      'Automatic', 'Gemini 4 Argon', 'Gemini 3.8 Flash',
    ])
    expect(arrow('Gemini 4 Argon').getAttribute('aria-haspopup')).toBe('menu')
    expect(arrow('Gemini 4 Argon').getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByRole('menuitem', { name: 'Reasoning effort for Automatic' })).toBeNull()
  })

  it('opens the levels beside the model and selects model and level in one step', async () => {
    const { select } = mount()
    fireEvent.click(arrow('Gemini 3.8 Flash'))
    expect(arrow('Gemini 3.8 Flash').getAttribute('aria-expanded')).toBe('true')
    const rows = within(submenu('Gemini 3.8 Flash')).getAllByRole('menuitemradio')
    expect(rows.map(row => [row.textContent, row.getAttribute('aria-checked')])).toEqual([
      ['Low', 'false'], ['Medium', 'true'], ['High', 'false'],
    ])
    fireEvent.click(rows[0]!)
    await waitFor(() => {
      expect(select).toHaveBeenCalledWith({ provider: 'antigravity-local', model: 'gemini-3.8-flash', reasoningEffort: 'low' })
    })
    expect(screen.queryByRole('menu', { name: 'Reasoning effort for Gemini 3.8 Flash' })).toBeNull()
  })

  it('checks the level in use for the current model and closes without a request when it is chosen again', () => {
    const { select } = mount()
    fireEvent.click(arrow('Gemini 4 Argon'))
    const high = within(submenu('Gemini 4 Argon')).getByRole('menuitemradio', { name: 'High' })
    expect(high.getAttribute('aria-checked')).toBe('true')
    fireEvent.click(high)
    expect(select).not.toHaveBeenCalled()
    expect(screen.queryByRole('menu', { name: 'Reasoning effort for Gemini 4 Argon' })).toBeNull()
  })

  it('opens one submenu at a time and closes it from its arrow', () => {
    mount()
    fireEvent.click(arrow('Gemini 4 Argon'))
    fireEvent.click(arrow('Gemini 3.8 Flash'))
    expect(screen.queryByRole('menu', { name: 'Reasoning effort for Gemini 4 Argon' })).toBeNull()
    expect(submenu('Gemini 3.8 Flash')).toBeTruthy()
    fireEvent.click(arrow('Gemini 3.8 Flash'))
    expect(screen.queryByRole('menu', { name: 'Reasoning effort for Gemini 3.8 Flash' })).toBeNull()
  })

  it('opens with ArrowRight on the level in use, walks with arrows, and returns to the model with ArrowLeft', () => {
    mount()
    const model = screen.getByRole('menuitemradio', { name: 'Gemini 4 Argon' })
    model.focus()
    fireEvent.keyDown(model, { key: 'ArrowRight' })
    const rows = within(submenu('Gemini 4 Argon')).getAllByRole('menuitemradio')
    expect(document.activeElement).toBe(rows[2])
    fireEvent.keyDown(rows[2]!, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(rows[0])
    fireEvent.keyDown(rows[0]!, { key: 'ArrowUp' })
    expect(document.activeElement).toBe(rows[2])
    fireEvent.keyDown(rows[2]!, { key: 'ArrowLeft' })
    expect(screen.queryByRole('menu', { name: 'Reasoning effort for Gemini 4 Argon' })).toBeNull()
    expect(document.activeElement).toBe(model)
  })

  it('closes only the submenu on Escape and settles the focused level with Tab', async () => {
    const { select } = mount()
    const model = screen.getByRole('menuitemradio', { name: 'Gemini 3.8 Flash' })
    model.focus()
    fireEvent.keyDown(model, { key: 'ArrowRight' })
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
    expect(screen.queryByRole('menu', { name: 'Reasoning effort for Gemini 3.8 Flash' })).toBeNull()
    expect(screen.getByRole('menuitemradio', { name: 'Gemini 3.8 Flash' })).toBeTruthy()
    expect(document.activeElement).toBe(model)

    fireEvent.keyDown(model, { key: 'ArrowRight' })
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' })
    fireEvent.keyDown(document.activeElement!, { key: 'Tab' })
    await waitFor(() => {
      expect(select).toHaveBeenCalledWith({ provider: 'antigravity-local', model: 'gemini-3.8-flash', reasoningEffort: 'high' })
    })
  })

  it('ignores ArrowRight on a model without reasoning levels', () => {
    mount()
    const model = screen.getByRole('menuitemradio', { name: 'Automatic' })
    model.focus()
    fireEvent.keyDown(model, { key: 'ArrowRight' })
    expect(screen.queryByRole('menu', { name: /Reasoning effort for/ })).toBeNull()
  })

  it('keeps the menu open for a press inside the submenu and closes both for a press outside', () => {
    mount()
    fireEvent.click(arrow('Gemini 4 Argon'))
    fireEvent.mouseDown(submenu('Gemini 4 Argon'))
    expect(submenu('Gemini 4 Argon')).toBeTruthy()
    fireEvent.mouseDown(document.body)
    expect(screen.queryByRole('menu', { name: /Reasoning effort for/ })).toBeNull()
    expect(screen.queryByRole('menuitemradio', { name: 'Gemini 4 Argon' })).toBeNull()
  })

  it('opens the levels of the highlighted model from the search box in a large catalog', () => {
    const group = state().groups[0]!
    mount(state({
      groups: [{ ...group, models: [...group.models, { id: 'm4', name: 'Model 4' }, { id: 'm5', name: 'Model 5' }] }],
    }))
    const search = screen.getByRole('searchbox')
    fireEvent.change(search, { target: { value: 'flash' } })
    fireEvent.keyDown(search, { key: 'ArrowRight' })
    const rows = within(submenu('Gemini 3.8 Flash')).getAllByRole('menuitemradio')
    expect(document.activeElement).toBe(rows[1])
    fireEvent.keyDown(rows[1]!, { key: 'ArrowLeft' })
    expect(document.activeElement).toBe(search)
  })
})
