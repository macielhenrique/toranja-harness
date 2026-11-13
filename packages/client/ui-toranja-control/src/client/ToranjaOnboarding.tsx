/** First-run setup: connect the providers the user wants, then choose how they work together. */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type {
  ToranjaOrchestrationStatus,
  ToranjaProviderId,
} from '@deepseek-ai/dsh-toranja-orchestrator/types'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import {
  ONBOARDING_COPY,
  ORCHESTRATOR_COPY,
  formatConnectNotice,
  formatProviderName,
  formatTeamSizeHint,
} from './locales.ts'
import { ModePicker, ProviderList, TeamSizeStepper } from './OrchestratorControls.tsx'
import type { OrchestratorSectionInjected } from './OrchestratorSection.tsx'
import section from './OrchestratorSection.module.css'
import css from './ToranjaOnboarding.module.css'

/** Props of the first-run setup: the onboarding coordinator's share plus the Orchestrator actions. */
export type ToranjaOnboardingProps = PropsRuntime<'settings.onboarding'> & OrchestratorSectionInjected

const ignoreImplicitDismiss = (): void => {}

/**
 * Render the first-run setup until the user finishes or skips it. It hands
 * the turn to the next onboarding step at once when the setup was already
 * finished, and also when the Host cannot be read, so it never blocks the app.
 * @param props - Coordinator props and injected Remote actions.
 * @returns The setup dialog, or null while deciding and after it ended.
 */
export function ToranjaOnboarding({
  complete, explicit = false, readStatus, setMode, updateSettings, probeProviders, connectProvider,
}: ToranjaOnboardingProps): ReactNode {
  const [status, setStatus] = useState<ToranjaOrchestrationStatus>()
  const [step, setStep] = useState<'providers' | 'mode'>('providers')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [notice, setNotice] = useState<string>()
  const mounted = useRef(true)
  // Read through a call: the flag changes across the awaits below.
  const alive = (): boolean => mounted.current
  const ended = useRef(false)

  const end = useCallback((): void => {
    if (ended.current) return
    ended.current = true
    complete()
  }, [complete])

  // Every request takes a number; an answer is shown only while no later
  // request was made, so a slow sign-in check cannot undo a newer choice.
  const latest = useRef(0)
  const [unreadable, setUnreadable] = useState<string>()

  const load = useCallback(async (): Promise<void> => {
    const request = ++latest.current
    let known: ToranjaOrchestrationStatus
    try {
      known = await readStatus()
    } catch (reason) {
      // The user is told and may try again; the setup is not counted as done.
      if (alive() && request === latest.current) {
        setUnreadable(reason instanceof Error ? reason.message : ORCHESTRATOR_COPY.loadFailed)
      }
      return
    }
    if (!alive() || request !== latest.current) return
    setUnreadable(undefined)
    if (known.onboarded && !explicit) {
      end()
      return
    }
    setStatus(known)
    // The stored states may predate a sign-in made outside the app.
    try {
      const fresh = await probeProviders()
      if (alive() && request === latest.current) setStatus(fresh)
    } catch {
      // The last known states stay on screen; Verificar conexões retries.
    }
  }, [end, explicit, probeProviders, readStatus])

  useEffect(() => {
    mounted.current = true
    void load()
    return () => { mounted.current = false }
  }, [load])

  // The dialog owns the viewport while it shows.
  const showing = status !== undefined || unreadable !== undefined
  useEffect(() => {
    if (!showing) return
    const appRoot = document.getElementById('root')
    if (appRoot === null) return
    const previous = appRoot.inert
    appRoot.inert = true
    return () => { appRoot.inert = previous }
  }, [showing])

  if (status === undefined) {
    if (unreadable === undefined) return null
    return (
      <Modal open title={ONBOARDING_COPY.providersTitle} onClose={ignoreImplicitDismiss} headless className={css.dialog as string}>
        <div className={css.content}>
          <h2 className={css.title}>{ONBOARDING_COPY.providersTitle}</h2>
          <div role="alert" className={section.error}>{ONBOARDING_COPY.unreadable} {unreadable}</div>
          <div className={css.actions}>
            {/* Nothing is stored here: the setup shows again on the next start. */}
            <Button variant="ghost" onClick={end}>{ONBOARDING_COPY.skip}</Button>
            <span className={css.spacer} />
            <Button variant="primary" onClick={() => { setUnreadable(undefined); void load() }}>{ONBOARDING_COPY.retry}</Button>
          </div>
        </div>
      </Modal>
    )
  }

  const run = async (change: () => Promise<ToranjaOrchestrationStatus>): Promise<boolean> => {
    const request = ++latest.current
    setBusy(true)
    setNotice(undefined)
    try {
      const next = await change()
      if (mounted.current && request === latest.current) {
        setStatus(next)
        setError(undefined)
      }
      return true
    } catch (reason) {
      if (mounted.current) setError(reason instanceof Error ? reason.message : ORCHESTRATOR_COPY.saveFailed)
      return false
    } finally {
      if (mounted.current) setBusy(false)
    }
  }

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

  // Finishing and skipping both store that the setup is over; what was
  // connected and chosen along the way is already stored by each control.
  const finish = async (): Promise<void> => {
    if (await run(() => updateSettings({ onboarded: true }))) end()
  }

  const title = step === 'providers' ? ONBOARDING_COPY.providersTitle : ONBOARDING_COPY.modeTitle
  const connected = status.providers.some(provider => provider.available)

  return (
    <Modal open title={title} onClose={ignoreImplicitDismiss} headless className={css.dialog as string}>
      <div className={css.content}>
        <h2 className={css.title}>{title}</h2>
        {error !== undefined && <div role="alert" className={section.error}>{error}</div>}
        {notice !== undefined && <div role="status" className={section.notice}>{notice}</div>}
        {step === 'providers'
          ? (
            <>
              <p className={section.hint}>{ONBOARDING_COPY.providersIntro}</p>
              <ProviderList providers={status.providers} busy={busy} onConnect={(provider) => { void connect(provider) }} />
              {!connected && <p className={css.warning}>{ONBOARDING_COPY.noneConnected}</p>}
              <p className={section.hint}>{ORCHESTRATOR_COPY.providersHint}</p>
            </>
          )
          : (
            <>
              <p className={section.hint}>{ONBOARDING_COPY.modeIntro}</p>
              <ModePicker status={status} busy={busy} onChoose={(mode) => { void run(() => setMode(mode)) }} />
              {status.mode === 'team' && (
                <div className={section.row}>
                  <div>
                    <h3 className={css.subheading}>{ORCHESTRATOR_COPY.teamSizeHeading}</h3>
                    <p className={section.hint}>{formatTeamSizeHint(status.limits.maxTeamSize)}</p>
                  </div>
                  <TeamSizeStepper
                    status={status}
                    busy={busy}
                    onChange={(teamSize) => { void run(() => updateSettings({ teamSize })) }}
                  />
                </div>
              )}
              <p className={section.hint}>{ONBOARDING_COPY.later}</p>
            </>
          )}
        <div className={css.actions}>
          <Button variant="ghost" disabled={busy} onClick={() => { void finish() }}>{ONBOARDING_COPY.skip}</Button>
          <span className={css.spacer} />
          {step === 'providers'
            ? (
              <>
                <Button variant="outline" disabled={busy} onClick={() => { void run(probeProviders) }}>
                  {ORCHESTRATOR_COPY.probe}
                </Button>
                <Button variant="primary" disabled={busy} onClick={() => { setNotice(undefined); setStep('mode') }}>
                  {ONBOARDING_COPY.next}
                </Button>
              </>
            )
            : (
              <>
                <Button variant="outline" disabled={busy} onClick={() => { setStep('providers') }}>{ONBOARDING_COPY.back}</Button>
                <Button variant="primary" disabled={busy} onClick={() => { void finish() }}>{ONBOARDING_COPY.finish}</Button>
              </>
            )}
        </div>
      </div>
    </Modal>
  )
}
