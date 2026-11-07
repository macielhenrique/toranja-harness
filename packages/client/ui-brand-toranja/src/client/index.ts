import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { ToranjaBrandName, ToranjaHeroMark, ToranjaSidebarMark } from './Brand.tsx'

export const inject = ['slots']

/** Fill every declared product-brand location with Toranja Tech artwork. */
export function apply(ctx: ClientContext): void {
  ctx.slots.inject('sidebar.brand.mark', () =>
    ctx.slots.inject('sidebar.brand.name', () =>
      ctx.slots.inject('conversation.hero.brand.mark', function* () {
        yield ctx.slots.register({ name: 'sidebar.brand.mark' }, ToranjaSidebarMark)
        yield ctx.slots.register({ name: 'sidebar.brand.name' }, ToranjaBrandName)
        yield ctx.slots.register({ name: 'conversation.hero.brand.mark' }, ToranjaHeroMark)
      })))
}
