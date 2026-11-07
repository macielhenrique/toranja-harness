import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-gateway/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import TYPERT_REMOTE from '@deepseek-ai/dsh-toranja-orchestrator/remote'
import type { ToranjaAgentMode } from '@deepseek-ai/dsh-toranja-orchestrator/types'
import { COPY } from './locales.ts'
import { ToranjaControl, type ToranjaControlInjected } from './ToranjaControl.tsx'

/** Required client services for the Toranja Control header action. */
export const inject = ['remote', 'slots']

/**
 * Register the Toranja Control action in every conversation header.
 * @param ctx - Client plugin context.
 * @returns Completion promise once Remote is mounted and the slot is registered.
 */
export async function apply(ctx: Context): Promise<void> {
  await ctx.remote.$mount(TYPERT_REMOTE)
  const toranja = ctx.get('remote.toranja')
  if (toranja === undefined) throw new Error('Toranja Remote namespace did not mount')
  const modeKey = 'toranja-harness.agent-mode'
  const storedMode = localStorage.getItem(modeKey)
  if (storedMode === 'codex' || storedMode === 'antigravity' || storedMode === 'team') {
    const restored = await toranja.setMode({ mode: storedMode })
    if (!restored.ok) console.warn('Toranja agent mode could not be restored')
  }
  const actions: ToranjaControlInjected = {
    async readStatus() {
      const result = await toranja.status()
      if (!result.ok) throw new Error('Toranja status is unavailable')
      return result.value
    },
    async setMode(mode: ToranjaAgentMode) {
      const result = await toranja.setMode({ mode })
      if (!result.ok) throw new Error(COPY.setModeFailed)
      localStorage.setItem(modeKey, mode)
      return result.value
    },
  }
  ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
    name: 'conversation.session.header.actions',
    id: 'toranja-control',
    order: -30,
    inject: () => actions,
  }, ToranjaControl))
}

export type { ToranjaControlInjected, ToranjaControlProps } from './ToranjaControl.tsx'
