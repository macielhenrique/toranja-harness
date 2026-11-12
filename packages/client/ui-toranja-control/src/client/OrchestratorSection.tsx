/** The Orchestrator settings page: providers, routing mode, team, roles, fallback, and tier models. */

import { useCallback, useEffect, useId, useRef, useState } from 'react'
import type {
  ToranjaAgentMode,
  ToranjaConnectResult,
  ToranjaOrchestrationStatus,
  ToranjaProviderConnection,
  ToranjaProviderId,
  ToranjaSettingsRequest,
} from '@deepseek-ai/dsh-toranja-orchestrator/types'
import { Button, StateDot, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type { StateDotState, TagTone } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import {
  CONNECTION_LABELS,
  COPY,
  MODE_OPTIONS,
  ORCHESTRATOR_COPY,
  PROFILE_OPTIONS,
  formatConnectLabel,
  formatConnectNotice,
  formatProviderHint,
  formatProviderName,
  formatTeamSizeHint,
} from './locales.ts'
import { OrchestratorRouting } from './OrchestratorRouting.tsx'
import css from './OrchestratorSection.module.css'

/** Injected Remote actions for the Orchestrator settings page. */
export interface OrchestratorSectionInjected {
  /** Read the current orchestration snapshot. */
  readStatus: () => Promise<ToranjaOrchestrationStatus>
  /** Change the routing mode. */
  setMode: (mode: ToranjaAgentMode) => Promise<ToranjaOrchestrationStatus>
  /** Change settings other than the routing mode; omitted fields keep their value. */
  updateSettings: (request: ToranjaSettingsRequest) => Promise<ToranjaOrchestrationStatus>
  /** Read every provider's sign-in state again. */
  probeProviders: () => Promise<ToranjaOrchestrationStatus>
  /** Open a provider's official sign-in command in a terminal. */
  connectProvider: (provider: ToranjaProviderId) => Promise<ToranjaConnectResult>
}

/** Props for the Orchestrator settings page. */
export type OrchestratorSectionProps = PropsRuntime<'settings.section'> & OrchestratorSectionInjected

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

/** How often the page reads the Host again, so a change made elsewhere shows up. */
const REFRESH_MS = 5_000

/**
 * Render the Orchestrator settings page.
 * @param props - Settings section runtime props and injected Remote actions.
 * @returns The page element tree.
 */
export function OrchestratorSection({
  readStatus, setMode, updateSettings, probeProviders, connectProvider,
}: OrchestratorSectionProps) {
  const [status, setStatus] = useState<ToranjaOrchestrationStatus>()
  const [error, setError] = useState<string>()
  const [notice, setNotice] = useState<string>()
  const [busy, setBusy] = useState(false)
  const headingId = useId()
  // The newest request wins: a refresh that started before a change must not
  // put the older snapshot back when it answers after it.
  const latest = useRef(0)
  const mounted = useRef(true)

  const show = useCallback(async (
    read: () => Promise<ToranjaOrchestrationStatus>,
    failure: string,
    quiet = false,
  ): Promise<boolean> => {
    const request = ++latest.current
    if (!quiet) setBusy(true)
    try {
      const next = await read()
      if (mounted.current && request === latest.current) {
        setStatus(next)
        setError(undefined)
      }
      return true
    } catch (reason) {
      // A background refresh that fails keeps the page as it is.
      if (mounted.current && !quiet) setError(reason instanceof Error ? reason.message : failure)
      return false
    } finally {
      if (mounted.current && !quiet) setBusy(false)
    }
  }, [])

  useEffect(() => {
    mounted.current = true
    void show(readStatus, ORCHESTRATOR_COPY.loadFailed)
    const timer = setInterval(() => { void show(readStatus, ORCHESTRATOR_COPY.loadFailed, true) }, REFRESH_MS)
    return () => {
      mounted.current = false
      clearInterval(timer)
    }
  }, [readStatus, show])

  const save = (request: ToranjaSettingsRequest): Promise<boolean> => {
    setNotice(undefined)
    return show(() => updateSettings(request), ORCHESTRATOR_COPY.saveFailed)
  }
  const change = (request: ToranjaSettingsRequest): void => { void save(request) }

  const connect = async (provider: ToranjaProviderId): Promise<void> => {
    setBusy(true)
    try {
      await connectProvider(provider)
      if (!mounted.current) return
      setError(undefined)
      setNotice(formatConnectNotice(formatProviderName(provider)))
    } catch (reason) {
      if (mounted.current) setError(reason instanceof Error ? reason.message : ORCHESTRATOR_COPY.connectFailed)
    } finally {
      if (mounted.current) setBusy(false)
    }
  }

  return (
    <div className={css.section}>
      <h2 id={headingId} className={css.heading}>{ORCHESTRATOR_COPY.heading}</h2>
      <p className={css.intro}>{ORCHESTRATOR_COPY.intro}</p>
      {error !== undefined && <div role="alert" className={css.error}>{error}</div>}
      {notice !== undefined && <div role="status" className={css.notice}>{notice}</div>}
      {status === undefined && error === undefined && <p className={css.intro}>{ORCHESTRATOR_COPY.loading}</p>}
      {status !== undefined && (
        <>
          <section className={css.group}>
            <header className={css.groupHeader}>
              <h3>{ORCHESTRATOR_COPY.providersHeading}</h3>
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => { setNotice(undefined); void show(probeProviders, ORCHESTRATOR_COPY.loadFailed) }}
              >
                {ORCHESTRATOR_COPY.probe}
              </Button>
            </header>
            <p className={css.hint}>{ORCHESTRATOR_COPY.providersHint}</p>
            <ul className={css.providers} aria-label={ORCHESTRATOR_COPY.providersHeading}>
              {status.providers.map((provider) => {
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
                          onClick={() => { void connect(provider.id) }}
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
          </section>

          <section className={css.group}>
            <h3>{ORCHESTRATOR_COPY.modeHeading}</h3>
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
                    onClick={() => {
                      if (selected) return
                      setNotice(undefined)
                      void show(() => setMode(option.mode), ORCHESTRATOR_COPY.saveFailed)
                    }}
                  >
                    {option.label}
                  </button>
                )
              })}
            </div>
            <p className={css.hint}>{MODE_OPTIONS.find(option => option.mode === status.mode)?.description}</p>
            <p className={css.hint}>{COPY.primaryHint}</p>

            <div className={css.row}>
              <div>
                <h4>{ORCHESTRATOR_COPY.teamSizeHeading}</h4>
                <p className={css.hint}>{formatTeamSizeHint(status.limits.maxTeamSize)}</p>
              </div>
              <div className={css.stepper} role="group" aria-label={ORCHESTRATOR_COPY.teamSizeHeading}>
                <button
                  type="button"
                  aria-label={ORCHESTRATOR_COPY.decreaseTeam}
                  disabled={busy || status.teamSize <= 1}
                  onClick={() => { change({ teamSize: status.teamSize - 1 }) }}
                >
                  −
                </button>
                <span className={css.count}>{status.teamSize}</span>
                <button
                  type="button"
                  aria-label={ORCHESTRATOR_COPY.increaseTeam}
                  disabled={busy || status.teamSize >= status.limits.maxTeamSize}
                  onClick={() => { change({ teamSize: status.teamSize + 1 }) }}
                >
                  +
                </button>
              </div>
            </div>

            <h4>{ORCHESTRATOR_COPY.profileHeading}</h4>
            <div className={css.choices} role="radiogroup" aria-label={ORCHESTRATOR_COPY.profileAria}>
              {PROFILE_OPTIONS.map((option) => {
                const selected = status.profile === option.profile
                return (
                  <button
                    key={option.profile}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    className={selected ? css.choiceActive : css.choice}
                    disabled={busy}
                    onClick={() => { if (!selected) change({ profile: option.profile }) }}
                  >
                    {option.label}
                  </button>
                )
              })}
            </div>
            <p className={css.hint}>{PROFILE_OPTIONS.find(option => option.profile === status.profile)?.description}</p>
          </section>

          <OrchestratorRouting status={status} busy={busy} save={save} />
        </>
      )}
    </div>
  )
}
