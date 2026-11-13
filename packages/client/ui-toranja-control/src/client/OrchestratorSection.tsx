/** The Orchestrator settings page: providers, routing mode, team, roles, fallback, and tier models. */

import { useCallback, useEffect, useId, useRef, useState } from 'react'
import type {
  ToranjaAgentMode,
  ToranjaConnectResult,
  ToranjaOrchestrationStatus,
  ToranjaProviderId,
  ToranjaSettingsRequest,
} from '@deepseek-ai/dsh-toranja-orchestrator/types'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import {
  COPY,
  ORCHESTRATOR_COPY,
  PROFILE_OPTIONS,
  formatConnectNotice,
  formatProviderName,
  formatTeamSizeHint,
} from './locales.ts'
import { ModePicker, ProviderList, TeamSizeStepper } from './OrchestratorControls.tsx'
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
  /** Milliseconds between background reads of the Host; five seconds when omitted. */
  refreshMs?: number
}

/** Props for the Orchestrator settings page. */
export type OrchestratorSectionProps = PropsRuntime<'settings.section'> & OrchestratorSectionInjected

/** How often the page reads the Host again, so a change made elsewhere shows up. */
const REFRESH_MS = 5_000

/**
 * Render the Orchestrator settings page.
 * @param props - Settings section runtime props and injected Remote actions.
 * @returns The page element tree.
 */
export function OrchestratorSection({
  readStatus, setMode, updateSettings, probeProviders, connectProvider, refreshMs = REFRESH_MS,
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
  // Requests the user started and that have not answered yet. A background
  // read waits for them: started before a change is stored, it could answer
  // after it with the older snapshot.
  const pending = useRef(0)

  const show = useCallback(async (
    read: () => Promise<ToranjaOrchestrationStatus>,
    failure: string,
    quiet = false,
  ): Promise<boolean> => {
    if (quiet && pending.current > 0) return true
    const request = ++latest.current
    if (!quiet) {
      pending.current += 1
      setBusy(true)
    }
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
      if (!quiet) {
        pending.current -= 1
        // The controls stay locked until every request the user started answered.
        if (mounted.current && pending.current === 0) setBusy(false)
      }
    }
  }, [])

  useEffect(() => {
    mounted.current = true
    void show(readStatus, ORCHESTRATOR_COPY.loadFailed)
    const timer = setInterval(() => { void show(readStatus, ORCHESTRATOR_COPY.loadFailed, true) }, refreshMs)
    return () => {
      mounted.current = false
      clearInterval(timer)
    }
  }, [readStatus, refreshMs, show])

  const save = (request: ToranjaSettingsRequest): Promise<boolean> => {
    setNotice(undefined)
    return show(() => updateSettings(request), ORCHESTRATOR_COPY.saveFailed)
  }
  const change = (request: ToranjaSettingsRequest): void => { void save(request) }

  const connect = async (provider: ToranjaProviderId): Promise<void> => {
    pending.current += 1
    setBusy(true)
    try {
      await connectProvider(provider)
      if (!mounted.current) return
      setError(undefined)
      setNotice(formatConnectNotice(formatProviderName(provider)))
    } catch (reason) {
      if (mounted.current) setError(reason instanceof Error ? reason.message : ORCHESTRATOR_COPY.connectFailed)
    } finally {
      pending.current -= 1
      if (mounted.current && pending.current === 0) setBusy(false)
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
            <ProviderList providers={status.providers} busy={busy} onConnect={(provider) => { void connect(provider) }} />
          </section>

          <section className={css.group}>
            <h3>{ORCHESTRATOR_COPY.modeHeading}</h3>
            <ModePicker
              status={status}
              busy={busy}
              onChoose={(mode) => {
                setNotice(undefined)
                void show(() => setMode(mode), ORCHESTRATOR_COPY.saveFailed)
              }}
            />
            <p className={css.hint}>{COPY.primaryHint}</p>

            <div className={css.row}>
              <div>
                <h4>{ORCHESTRATOR_COPY.teamSizeHeading}</h4>
                <p className={css.hint}>{formatTeamSizeHint(status.limits.maxTeamSize)}</p>
              </div>
              <TeamSizeStepper status={status} busy={busy} onChange={(teamSize) => { change({ teamSize }) }} />
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
