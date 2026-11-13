/** Routing half of the Orchestrator settings page: roles, fallback order, cross-review, and tier models. */

import { useState } from 'react'
import type {
  ToranjaModelTier,
  ToranjaOrchestrationStatus,
  ToranjaProviderId,
  ToranjaProviderStatus,
  ToranjaRoleAccess,
  ToranjaSettingsRequest,
  ToranjaTierModel,
  ToranjaTierModels,
} from '@deepseek-ai/dsh-toranja-orchestrator/types'
import { Button, Switch, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TagTone } from '@deepseek-ai/dsh-client-ui-primitives'
import {
  ACCESS_LABELS,
  ENFORCEMENT_LABELS,
  MODE_OPTIONS,
  ROLE_LABELS,
  ROUTING_COPY,
  TIER_LABELS,
  formatMoveLabel,
  formatProviderName,
  formatRoleProviderLabel,
  formatRoute,
  formatSoloRoles,
  formatTierFieldLabel,
  formatTierModelsLabel,
} from './locales.ts'
import css from './OrchestratorSection.module.css'

/** Props of the routing groups. */
export interface OrchestratorRoutingProps {
  /** Snapshot the groups render. */
  status: ToranjaOrchestrationStatus
  /** Whether a request is in flight; every control waits for it. */
  busy: boolean
  /** Store a settings change; resolves to whether the Host accepted it. */
  save: (request: ToranjaSettingsRequest) => Promise<boolean>
}

const TIERS: readonly ToranjaModelTier[] = ['light', 'advanced', 'max']

const ACCESS_TONES: Readonly<Record<ToranjaRoleAccess, TagTone>> = {
  'read-only': 'neutral',
  execute: 'info',
  write: 'warning',
}

/** What the user typed for one provider and has not saved yet. */
type Draft = Partial<Record<ToranjaModelTier, { model?: string; effort?: string }>>

/** A typed value as stored: trimmed, and absent when empty. */
function entered(value: string | undefined): string | undefined {
  const text = value?.trim() ?? ''
  return text.length === 0 ? undefined : text
}

/**
 * The tier table a save sends for one provider, or undefined when the draft
 * changes nothing. It carries the tiers the user set before and the ones the
 * draft changes; a tier left empty is omitted and follows the deployment.
 */
function tableToSave(provider: ToranjaProviderStatus, draft: Draft | undefined): ToranjaTierModels | undefined {
  let changed = false
  const table: Partial<Record<ToranjaModelTier, ToranjaTierModel>> = {}
  for (const tier of TIERS) {
    const inForce = provider.tierModels[tier]
    const model = entered(draft?.[tier]?.model ?? inForce?.model)
    const effort = entered(draft?.[tier]?.effort ?? inForce?.effort)
    const differs = model !== inForce?.model || effort !== inForce?.effort
    if (differs) changed = true
    if (model === undefined && effort === undefined) continue
    if (differs || provider.tierModelOverrides[tier] !== undefined) {
      table[tier] = { ...model === undefined ? {} : { model }, ...effort === undefined ? {} : { effort } }
    }
  }
  return changed ? table : undefined
}

/**
 * Render the roles table, the fallback order, the cross-review switch, and the tier models.
 * @param props - Snapshot, in-flight flag, and the save action.
 * @returns The routing groups.
 */
export function OrchestratorRouting({ status, busy, save }: OrchestratorRoutingProps) {
  const [drafts, setDrafts] = useState<Partial<Record<ToranjaProviderId, Draft>>>({})
  const solo = status.mode === 'team' ? undefined : status.mode
  const order = [
    ...status.fallbackOrder,
    ...status.providers.map(provider => provider.id).filter(id => !status.fallbackOrder.includes(id)),
  ]

  const move = (index: number, step: -1 | 1): void => {
    const next = [...order]
    const [moved] = next.splice(index, 1)
    if (moved === undefined) return
    next.splice(index + step, 0, moved)
    void save({ fallbackOrder: next })
  }

  const type = (provider: ToranjaProviderId, tier: ToranjaModelTier, field: 'model' | 'effort', value: string): void => {
    setDrafts(current => ({
      ...current,
      [provider]: { ...current[provider], [tier]: { ...current[provider]?.[tier], [field]: value } },
    }))
  }

  const saveModels = async (provider: ToranjaProviderId, table: ToranjaTierModels): Promise<void> => {
    // The draft goes only once the Host accepted it, so a rejected model stays on screen to be corrected.
    if (await save({ tierModels: { [provider]: table } })) setDrafts(({ [provider]: _saved, ...rest }) => rest)
  }

  return (
    <>
      <section className={css.group}>
        <h3>{ROUTING_COPY.rolesHeading}</h3>
        <p className={css.hint}>
          {solo === undefined
            ? ROUTING_COPY.rolesHint
            : formatSoloRoles(MODE_OPTIONS.find(option => option.mode === solo)?.label ?? solo, formatProviderName(solo))}
        </p>
        <table className={css.roles} aria-label={ROUTING_COPY.rolesHeading}>
          <thead>
            <tr>
              <th scope="col">{ROUTING_COPY.roleColumn}</th>
              <th scope="col">{ROUTING_COPY.providerColumn}</th>
              <th scope="col">{ROUTING_COPY.routeColumn}</th>
              <th scope="col">{ROUTING_COPY.accessColumn}</th>
            </tr>
          </thead>
          <tbody>
            {status.routes.map((route) => {
              const roleName = ROLE_LABELS[route.role]
              const preferred = status.roleProviders[route.role]
              const routed = status.providers.find(provider => provider.id === route.provider)
              return (
                <tr key={route.role}>
                  <th scope="row">{roleName}</th>
                  <td>
                    <select
                      className={css.field}
                      aria-label={formatRoleProviderLabel(roleName)}
                      value={preferred ?? ''}
                      disabled={busy || solo !== undefined}
                      onChange={(event) => {
                        const { [route.role]: _replaced, ...others } = status.roleProviders
                        const chosen = status.providers.find(provider => provider.id === event.target.value)?.id
                        void save({ roleProviders: chosen === undefined ? others : { ...others, [route.role]: chosen } })
                      }}
                    >
                      <option value="">{ROUTING_COPY.roleDefault}</option>
                      {status.providers
                        // A provider that cannot be kept from writing is offered only for roles that write.
                        .filter(provider => provider.roles.includes(route.role) || provider.id === preferred)
                        .map(provider => <option key={provider.id} value={provider.id}>{formatProviderName(provider.id)}</option>)}
                    </select>
                  </td>
                  <td>{formatRoute(formatProviderName(route.provider), route.model, route.effort)}</td>
                  <td>
                    <Tag tone={ACCESS_TONES[route.access]}>{ACCESS_LABELS[route.access]}</Tag>
                    {route.access === 'read-only' && routed !== undefined && (
                      <span className={css.enforcement}>{ENFORCEMENT_LABELS[routed.readOnlyEnforcement]}</span>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </section>

      <section className={css.group}>
        <h3>{ROUTING_COPY.fallbackHeading}</h3>
        <p className={css.hint}>{ROUTING_COPY.fallbackHint}</p>
        <ol className={css.order} aria-label={ROUTING_COPY.fallbackHeading}>
          {order.map((id, index) => {
            const name = formatProviderName(id)
            return (
              <li key={id} aria-label={name}>
                <span className={css.position}>{index + 1}</span>
                <strong>{name}</strong>
                <button
                  type="button"
                  aria-label={formatMoveLabel('up', name)}
                  disabled={busy || index === 0}
                  onClick={() => { move(index, -1) }}
                >
                  ↑
                </button>
                <button
                  type="button"
                  aria-label={formatMoveLabel('down', name)}
                  disabled={busy || index === order.length - 1}
                  onClick={() => { move(index, 1) }}
                >
                  ↓
                </button>
              </li>
            )
          })}
        </ol>
        <div className={css.row}>
          <div>
            <h4>{ROUTING_COPY.crossReviewHeading}</h4>
            <p className={css.hint}>{ROUTING_COPY.crossReviewHint}</p>
          </div>
          <Switch
            checked={status.crossReview}
            label={ROUTING_COPY.crossReviewLabel}
            disabled={busy}
            onChange={(next) => { void save({ crossReview: next }) }}
          />
        </div>
      </section>

      <section className={css.group}>
        <h3>{ROUTING_COPY.tierModelsHeading}</h3>
        <p className={css.hint}>{ROUTING_COPY.tierModelsHint}</p>
        {status.providers.map((provider) => {
          const name = formatProviderName(provider.id)
          const draft = drafts[provider.id]
          const table = tableToSave(provider, draft)
          return (
            <div key={provider.id} className={css.models} role="group" aria-label={formatTierModelsLabel(name)}>
              <h4>{name}</h4>
              {!provider.tierModelsEditable
                ? <p className={css.hint}>{ROUTING_COPY.notEditable}</p>
                : (
                  <>
                    {TIERS.map((tier) => {
                      const tierName = TIER_LABELS[tier]
                      const inherits = tier === 'max' ? provider.tierModels.advanced : undefined
                      return (
                        <div key={tier} className={css.tier}>
                          <span className={css.tierName}>
                            {tierName}
                            {provider.tierModelOverrides[tier] !== undefined && <Tag tone="info">{ROUTING_COPY.customized}</Tag>}
                          </span>
                          {(['model', 'effort'] as const).map(field => (
                            <input
                              key={field}
                              type="text"
                              className={css.field}
                              aria-label={formatTierFieldLabel(field, tierName)}
                              placeholder={inherits?.[field] === undefined ? ROUTING_COPY.nativeModel : ROUTING_COPY.inheritsAdvanced}
                              value={draft?.[tier]?.[field] ?? provider.tierModels[tier]?.[field] ?? ''}
                              disabled={busy}
                              onChange={(event) => { type(provider.id, tier, field, event.target.value) }}
                            />
                          ))}
                        </div>
                      )
                    })}
                    <div className={css.actions}>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy || Object.keys(provider.tierModelOverrides).length === 0}
                        onClick={() => { void saveModels(provider.id, {}) }}
                      >
                        {ROUTING_COPY.restore}
                      </Button>
                      <Button
                        size="sm"
                        variant="primary"
                        disabled={busy || table === undefined}
                        onClick={() => { if (table !== undefined) void saveModels(provider.id, table) }}
                      >
                        {ROUTING_COPY.save}
                      </Button>
                    </div>
                  </>
                )}
            </div>
          )
        })}
      </section>
    </>
  )
}
