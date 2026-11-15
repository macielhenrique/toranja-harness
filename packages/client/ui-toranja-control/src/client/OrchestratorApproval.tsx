/** Approval group of the Orchestrator settings page: the policy, the file limits, and the recent plans. */

import type { ToranjaOrchestrationStatus, ToranjaPlanState, ToranjaSettingsRequest } from '@deepseek-ai/dsh-toranja-orchestrator/types'
import { Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TagTone } from '@deepseek-ai/dsh-client-ui-primitives'
import { APPROVAL_COPY, APPROVAL_OPTIONS, PLAN_LEVEL_LABELS, formatPlanDecision } from './locales.ts'
import { Stepper } from './OrchestratorControls.tsx'
import css from './OrchestratorSection.module.css'

const STATE_TONES: Readonly<Record<ToranjaPlanState, TagTone>> = {
  approved: 'success',
  rejected: 'danger',
  closed: 'quiet',
}

/**
 * Choose when the Host asks before a writing role runs, set the file limits of
 * the classification, and list the plans the Host decided recently.
 * @param props.status - Snapshot naming the policy, the limits, and the plans.
 * @param props.busy - Whether a request is in flight.
 * @param props.change - Store a settings change.
 * @returns The approval group.
 */
export function OrchestratorApproval({ status, busy, change }: {
  status: ToranjaOrchestrationStatus
  busy: boolean
  change: (request: ToranjaSettingsRequest) => void
}) {
  const { maxDirectFiles, maxInvestigatedFiles } = status.classification
  return (
    <section className={css.group}>
      <h3>{APPROVAL_COPY.heading}</h3>
      <div className={css.choices} role="radiogroup" aria-label={APPROVAL_COPY.policyAria}>
        {APPROVAL_OPTIONS.map((option) => {
          const selected = status.approvalPolicy === option.policy
          return (
            <button
              key={option.policy}
              type="button"
              role="radio"
              aria-checked={selected}
              className={selected ? css.choiceActive : css.choice}
              disabled={busy}
              onClick={() => { if (!selected) change({ approvalPolicy: option.policy }) }}
            >
              {option.label}
            </button>
          )
        })}
      </div>
      <p className={css.hint}>{APPROVAL_OPTIONS.find(option => option.policy === status.approvalPolicy)?.description}</p>
      <p className={css.hint}>{APPROVAL_COPY.hint}</p>

      {status.approvalPolicy !== 'off' && (
        <>
          <div className={css.row}>
            <div>
              <h4>{APPROVAL_COPY.directHeading}</h4>
              <p className={css.hint}>{APPROVAL_COPY.directHint}</p>
            </div>
            <Stepper
              label={APPROVAL_COPY.directHeading}
              decreaseLabel={APPROVAL_COPY.decreaseDirect}
              increaseLabel={APPROVAL_COPY.increaseDirect}
              value={maxDirectFiles}
              min={1}
              max={maxInvestigatedFiles}
              busy={busy}
              onChange={(value) => { change({ maxDirectFiles: value }) }}
            />
          </div>
          <div className={css.row}>
            <div>
              <h4>{APPROVAL_COPY.investigatedHeading}</h4>
              <p className={css.hint}>{APPROVAL_COPY.investigatedHint}</p>
            </div>
            <Stepper
              label={APPROVAL_COPY.investigatedHeading}
              decreaseLabel={APPROVAL_COPY.decreaseInvestigated}
              increaseLabel={APPROVAL_COPY.increaseInvestigated}
              value={maxInvestigatedFiles}
              min={maxDirectFiles}
              busy={busy}
              onChange={(value) => { change({ maxInvestigatedFiles: value }) }}
            />
          </div>
        </>
      )}

      <h4>{APPROVAL_COPY.plansHeading}</h4>
      {status.plans.length === 0 && <p className={css.hint}>{APPROVAL_COPY.plansEmpty}</p>}
      {status.plans.length > 0 && (
        <ul className={css.plans} aria-label={APPROVAL_COPY.plansHeading}>
          {status.plans.map(plan => (
            <li key={plan.id} className={css.plan}>
              <div className={css.providerHeading}>
                <strong>{plan.title}</strong>
                <Tag tone="neutral">{plan.project}</Tag>
                <Tag tone="info">{PLAN_LEVEL_LABELS[plan.level]}</Tag>
                <Tag tone={STATE_TONES[plan.state]}>{formatPlanDecision(plan.state, plan.decidedBy)}</Tag>
              </div>
              {plan.error !== undefined && <p className={css.hint}>{plan.error}</p>}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
