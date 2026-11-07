// @vitest-environment jsdom
import { Context } from '@deepseek-ai/cordis'
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { ToranjaBrandName, ToranjaHeroMark, ToranjaSidebarMark } from '../src/client/Brand.tsx'
import { apply, inject } from '../src/client/index.ts'

afterEach(cleanup)

const HOLES = ['sidebar.brand.mark', 'sidebar.brand.name', 'conversation.hero.brand.mark'] as const

describe('Toranja browser-brand plugin', () => {
  it('fills all three declared product-brand slots', async () => {
    const ctx = new Context()
    await ctx.plugin(SlotRegistry).await()
    const slots = ctx.get('slots') as SlotRegistry
    slots.register({
      name: 'root',
      children: Object.fromEntries(HOLES.map(name => [name, { kind: 'single', scope: 'root' }])),
    } as never, () => null)
    await ctx.plugin({ inject: [...inject], apply }).await()
    for (const hole of HOLES) expect(slots.entries(hole)).toHaveLength(1)
  })

  it('renders the official artwork at host-requested sizes', () => {
    const sidebar = render(<ToranjaSidebarMark size={24} />)
    expect(sidebar.container.querySelector('img')?.getAttribute('width')).toBe('24')
    sidebar.unmount()
    const hero = render(<ToranjaHeroMark size={34} className="host" />)
    expect(hero.container.querySelector('img')?.classList.contains('host')).toBe(true)
    hero.unmount()
    expect(render(<ToranjaBrandName />).getByAltText('Toranja Tech')).toBeTruthy()
  })
})
