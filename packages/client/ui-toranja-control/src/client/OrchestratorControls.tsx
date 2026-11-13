/** Controls the Orchestrator settings page and the first-run setup share. */

import type {
  ToranjaAgentMode,
  ToranjaOrchestrationStatus,
  ToranjaProviderConnection,
  ToranjaProviderId,
} from '@deepseek-ai/dsh-toranja-orchestrator/types'
import { Button, StateDot, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type { StateDotState, TagTone } from '@deepseek-ai/dsh-client-ui-primitives'
import {
  CONNECTION_LABELS,
  COPY,
  MODE_OPTIONS,
  ORCHESTRATOR_COPY,
  formatConnectLabel,
  formatProviderHint,
  formatProviderName,
} from './locales.ts'
import css from './OrchestratorSection.module.css'

const CONNECTION_DOTS: Readonly<Record<ToranjaProviderConnection, StateDotState>> = {
  connected: 'done',
  'signed-out': 'warning',
  'not-installed': 'error',
  'probe-failed': 'error',
  unknown: 'idle',
}

const CONNECTION_TONES: Readonly<Record<ToranjaProviderConnection, TagTone>> = {
  connected: 'success',
  'signed-out': 'warning',
  'not-installed': 'neutral',
  'probe-failed': 'danger',
  unknown: 'quiet',
}

/**
 * List every provider with its sign-in state, what it still needs, and a
 * sign-in button where the provider has an official sign-in command to open.
 * @param props.providers - Provider statuses from the Host.
 * @param props.busy - Whether a request is in flight.
 * @param props.onConnect - Open the provider's sign-in.
 * @returns The provider list.
 */
export function ProviderList({ providers, busy, onConnect }: {
  providers: ToranjaOrchestrationStatus['providers']
  busy: boolean
  onConnect: (provider: ToranjaProviderId) => void
}) {
  return (
    <ul className={css.providers} aria-label={ORCHESTRATOR_COPY.providersHeading}>
      {providers.map((provider) => {
        const name = formatProviderName(provider.id)
        const hint = formatProviderHint(name, provider)
        // OpenRouter signs in with an API key, and a missing CLI has nothing to sign in to.
        const canConnect = provider.id !== 'openrouter'
          && provider.connection !== 'connected' && provider.connection !== 'not-installed'
        return (
          <li key={provider.id} className={css.provider} aria-label={name}>
            <div className={css.providerHeading}>
              <StateDot state={CONNECTION_DOTS[provider.connection]} />
              <strong>{name}</strong>
              <Tag tone={CONNECTION_TONES[provider.connection]}>{CONNECTION_LABELS[provider.connection]}</Tag>
              {canConnect && (
                <Button
                  size="sm"
                  variant="primary"
                  className={css.connect}
                  disabled={busy}
                  aria-label={formatConnectLabel(name)}
                  onClick={() => { onConnect(provider.id) }}
                >
                  {ORCHESTRATOR_COPY.connect}
                </Button>
              )}
            </div>
            {hint !== undefined && <p className={css.hint}>{hint}</p>}
          </li>
        )
      })}
    </ul>
  )
}

/**
 * Choose Team or one provider. A solo mode is offered only for a provider that can take tasks.
 * @param props.status - Snapshot naming the mode in force and the provider availability.
 * @param props.busy - Whether a request is in flight.
 * @param props.onChoose - Switch to another mode.
 * @returns The mode radio group and the description of the mode in force.
 */
export function ModePicker({ status, busy, onChoose }: {
  status: ToranjaOrchestrationStatus
  busy: boolean
  onChoose: (mode: ToranjaAgentMode) => void
}) {
  return (
    <>
      <div className={css.choices} role="radiogroup" aria-label={COPY.modePickerAria}>
        {MODE_OPTIONS.map((option) => {
          const selected = status.mode === option.mode
          const usable = option.mode === 'team'
            || status.providers.some(provider => provider.id === option.mode && provider.available)
          return (
            <button
              key={option.mode}
              type="button"
              role="radio"
              aria-checked={selected}
              className={selected ? css.choiceActive : css.choice}
              disabled={busy || (!usable && !selected)}
              onClick={() => { if (!selected) onChoose(option.mode) }}
            >
              {option.label}
            </button>
          )
        })}
      </div>
      <p className={css.hint}>{MODE_OPTIONS.find(option => option.mode === status.mode)?.description}</p>
    </>
  )
}

/**
 * Change how many agents work in one project at once, one at a time, up to the deployment limit.
 * @param props.status - Snapshot naming the team size and its limit.
 * @param props.busy - Whether a request is in flight.
 * @param props.onChange - Store another team size.
 * @returns The stepper.
 */
export function TeamSizeStepper({ status, busy, onChange }: {
  status: ToranjaOrchestrationStatus
  busy: boolean
  onChange: (teamSize: number) => void
}) {
  return (
    <div className={css.stepper} role="group" aria-label={ORCHESTRATOR_COPY.teamSizeHeading}>
      <button
        type="button"
        aria-label={ORCHESTRATOR_COPY.decreaseTeam}
        disabled={busy || status.teamSize <= 1}
        onClick={() => { onChange(status.teamSize - 1) }}
      >
        −
      </button>
      <span className={css.count}>{status.teamSize}</span>
      <button
        type="button"
        aria-label={ORCHESTRATOR_COPY.increaseTeam}
        disabled={busy || status.teamSize >= status.limits.maxTeamSize}
        onClick={() => { onChange(status.teamSize + 1) }}
      >
        +
      </button>
    </div>
  )
}
