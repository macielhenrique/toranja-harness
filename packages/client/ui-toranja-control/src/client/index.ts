import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-gateway/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: pulls the settings shell's SlotMap merge (the 'settings.section' entry).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import TYPERT_REMOTE from '@deepseek-ai/dsh-toranja-orchestrator/remote'
import type { ToranjaAgentMode } from '@deepseek-ai/dsh-toranja-orchestrator/types'
import { COPY, ORCHESTRATOR_COPY } from './locales.ts'
import { OrchestratorSection, type OrchestratorSectionInjected } from './OrchestratorSection.tsx'
import { ToranjaControl, type ToranjaControlInjected } from './ToranjaControl.tsx'

/** Required client services for the Toranja Control header action and the Orchestrator settings page. */
export const inject = ['remote', 'slots']

/**
 * Register the Toranja Control action in every conversation header and the
 * Orchestrator page in Settings.
 * @param ctx - Client plugin context.
 * @returns Completion promise once Remote is mounted and the slots are registered.
 */
export async function apply(ctx: Context): Promise<void> {
  await ctx.remote.$mount(TYPERT_REMOTE)
  // Mounting the contribution installs its namespace on the Remote service.
  const { toranja } = ctx.remote
  // The Host stores the routing mode durably. A version before that kept it in
  // browser storage: hand that value to the Host once, and drop the key only
  // after the Host answered, so a failed attempt is retried on the next load.
  // Blocked storage or an unreachable Host must not keep the control from
  // registering, so the migration only logs its failure.
  const legacyModeKey = 'toranja-harness.agent-mode'
  try {
    const legacyMode = localStorage.getItem(legacyModeKey)
    if (
      legacyMode === 'codex'
      || legacyMode === 'antigravity'
      || legacyMode === 'claude-code'
      || legacyMode === 'openrouter'
      || legacyMode === 'team'
    ) {
      const adopted = await toranja.adoptLegacyMode({ mode: legacyMode })
      if (adopted.ok) localStorage.removeItem(legacyModeKey)
      else console.warn('Toranja agent mode from the earlier version could not be migrated')
    } else if (legacyMode !== null) {
      localStorage.removeItem(legacyModeKey)
    }
  } catch (error: unknown) {
    console.warn('Toranja agent mode from the earlier version could not be migrated', error)
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
      return result.value
    },
  }
  ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
    name: 'conversation.session.header.actions',
    id: 'toranja-control',
    order: -30,
    inject: () => actions,
  }, ToranjaControl))

  // The Host's own message says why a change was rejected (an unknown model, a
  // team size over the limit), so the page shows it instead of a generic text.
  const answer = <Value>(result: { ok: true; value: Value } | { ok: false; error: { message: string } }, failure: string): Value => {
    if (result.ok) return result.value
    throw new Error(result.error.message.length > 0 ? result.error.message : failure)
  }
  const sectionActions: OrchestratorSectionInjected = {
    readStatus: async () => answer(await toranja.status(), ORCHESTRATOR_COPY.loadFailed),
    setMode: async mode => answer(await toranja.setMode({ mode }), ORCHESTRATOR_COPY.saveFailed),
    updateSettings: async request => answer(await toranja.updateSettings(request), ORCHESTRATOR_COPY.saveFailed),
    probeProviders: async () => answer(await toranja.probeProviders(), ORCHESTRATOR_COPY.loadFailed),
    connectProvider: async provider => answer(await toranja.connectProvider({ provider }), ORCHESTRATOR_COPY.connectFailed),
  }
  // After Models: connecting a provider comes before deciding how the team uses it.
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'toranja-orchestrator',
    order: 15,
    label: () => ORCHESTRATOR_COPY.nav,
    inject: () => sectionActions,
  }, OrchestratorSection))
}

export type { OrchestratorSectionInjected, OrchestratorSectionProps } from './OrchestratorSection.tsx'
export type { ToranjaControlInjected, ToranjaControlProps } from './ToranjaControl.tsx'
