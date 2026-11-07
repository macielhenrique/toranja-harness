import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type {
  ToranjaAgentMode, ToranjaOrchestrationStatus,
} from '@deepseek-ai/dsh-toranja-orchestrator/types'
import {
  IconGaugeOutlineRegular,
  IconRefreshOutlineRegular,
  StateDot,
  useAnchoredPosition,
  useDismissOnOutsidePointer,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import {
  COPY,
  MODE_OPTIONS,
  ROLE_LABELS,
  TASK_STATE_LABELS,
  formatActiveTaskCount,
  formatCapacityLimits,
  formatModeSummary,
  formatParallelWritePolicy,
  formatProjectActivity,
  formatProjectTotals,
  formatProviderAvailability,
  formatProviderName,
} from './locales.ts'
import css from './ToranjaControl.module.css'

/** Injected Remote actions for the Toranja Control header panel. */
export interface ToranjaControlInjected {
  /** Read the current Toranja orchestration status snapshot. */
  readStatus: () => Promise<ToranjaOrchestrationStatus>
  /** Update the active delegation routing mode. */
  setMode: (mode: ToranjaAgentMode) => Promise<ToranjaOrchestrationStatus>
}

/** Props for the Toranja Control conversation-header action. */
export type ToranjaControlProps =
  PropsRuntime<'conversation.session.header.actions'> & ToranjaControlInjected

function Metric({ label, value }: { label: string; value: number }) {
  return <span className={css.metric}><strong>{value}</strong>{label}</span>
}

const timeFormatter = new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit' })

/**
 * Render the provider health and project-lane dashboard anchored to the conversation header.
 * @param props - Runtime slot props and injected Remote actions.
 * @returns The Toranja Control header button and popover portal.
 */
export function ToranjaControl({ readStatus, setMode }: ToranjaControlProps) {
  const [open, setOpen] = useState(false)
  const [status, setStatus] = useState<ToranjaOrchestrationStatus>()
  const [error, setError] = useState<string>()
  const [loading, setLoading] = useState(false)
  const [changingMode, setChangingMode] = useState<ToranjaAgentMode>()
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const position = useAnchoredPosition({ open, anchorRef: triggerRef, panelRef, gap: 5, margin: 16 })

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      setStatus(await readStatus())
      setError(undefined)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : COPY.loadFailed)
    } finally {
      setLoading(false)
    }
  }, [readStatus])

  useEffect(() => {
    if (!open) return
    void refresh()
    const timer = setInterval(() => { void refresh() }, 3_000)
    return () => { clearInterval(timer) }
  }, [open, refresh])

  useLayoutEffect(() => {
    if (open && position !== null) panelRef.current?.focus()
  }, [open, position])

  useDismissOnOutsidePointer(rootRef, open, setOpen, panelRef)

  useEffect(() => {
    if (!open) return
    const dismiss = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      setOpen(false)
      triggerRef.current?.focus()
    }
    document.addEventListener('keydown', dismiss)
    return () => { document.removeEventListener('keydown', dismiss) }
  }, [open])

  const used = status?.active ?? 0
  const total = status?.limits.maxConcurrentTotal ?? 0
  const capacity = total === 0 ? 0 : Math.min(100, Math.round((used / total) * 100))

  const chooseMode = useCallback(async (mode: ToranjaAgentMode) => {
    if (status?.mode === mode || changingMode !== undefined) return
    setChangingMode(mode)
    try {
      setStatus(await setMode(mode))
      setError(undefined)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : COPY.setModeFailed)
    } finally {
      setChangingMode(undefined)
    }
  }, [changingMode, setMode, status?.mode])

  return (
    <div ref={rootRef} className={css.root} data-toranja-control>
      <button
        ref={triggerRef}
        type="button"
        className={css.trigger}
        aria-label={COPY.triggerAria}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => { setOpen(current => !current) }}
      >
        <IconGaugeOutlineRegular size={14} />
        <span className={css.triggerLabel}>{COPY.triggerLabel}</span>
      </button>
      {open && createPortal(
        <div
          ref={panelRef}
          className={css.panel}
          style={position ?? { visibility: 'hidden', left: 0, top: 0 }}
          role="dialog"
          tabIndex={-1}
          aria-label={COPY.panelAria}
          data-toranja-control-panel
        >
          <header className={css.header}>
            <div>
              <span className={css.eyebrow}>{COPY.eyebrow}</span>
              <h2>{COPY.heading}</h2>
            </div>
            <button type="button" className={css.refresh} onClick={() => { void refresh() }} aria-label={COPY.refreshAria}>
              <IconRefreshOutlineRegular size={15} className={loading ? css.spinning : undefined} />
            </button>
          </header>

          {error !== undefined && <div className={css.error}><StateDot state="error" />{error}</div>}
          {status === undefined && error === undefined && <div className={css.notice}><StateDot state="ongoing" />{COPY.loading}</div>}
          {status !== undefined && (
            <div className={css.body}>
              <section className={css.modeSection}>
                <div className={css.sectionTitle}>
                  <span>{COPY.delegationRouting}</span>
                  <strong>{formatModeSummary(status.mode)}</strong>
                </div>
                <div className={css.modePicker} role="radiogroup" aria-label={COPY.modePickerAria}>
                  {MODE_OPTIONS.map(option => (
                    <button
                      key={option.mode}
                      type="button"
                      role="radio"
                      data-toranja-agent-mode={option.mode}
                      aria-checked={status.mode === option.mode}
                      className={status.mode === option.mode ? css.modeActive : css.modeOption}
                      disabled={changingMode !== undefined}
                      title={option.description}
                      onClick={() => { void chooseMode(option.mode) }}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
                <p className={css.modeDescription}>
                  {MODE_OPTIONS.find(option => option.mode === status.mode)?.description}
                </p>
                <p className={css.primaryHint}>
                  {COPY.primaryHint}
                </p>
              </section>

              <section className={css.teamRoles}>
                <div className={css.roleCard}>
                  <span className={css.roleLabel}>{COPY.providerEyebrow}</span>
                  <strong>{COPY.providerCodex}</strong>
                  <small>{COPY.providerHint}</small>
                </div>
                <div className={css.roleArrow} aria-hidden="true">+</div>
                <div className={css.roleCard}>
                  <span className={css.roleLabel}>{COPY.providerEyebrow}</span>
                  <strong>{COPY.providerAntigravity}</strong>
                  <small>{COPY.providerHint}</small>
                </div>
              </section>

              <section className={css.capacity}>
                <div className={css.sectionTitle}>
                  <span>{COPY.activeCapacity}</span>
                  <strong>{used} / {total}</strong>
                </div>
                <div className={css.track}><span style={{ width: `${capacity}%` }} /></div>
                <small>
                  {formatCapacityLimits(status.limits.maxConcurrentPerProject, status.limits.maxConcurrentPerProvider)}
                </small>
              </section>

              <section>
                <h3>{COPY.agentStateHeading}</h3>
                <div className={css.grid}>
                  {status.providers.map(provider => (
                    <article key={provider.id} className={css.card}>
                      <div className={css.cardHeading}>
                        <StateDot state={!provider.available ? 'error' : provider.metrics.active > 0 ? 'ongoing' : 'done'} />
                        <strong>{formatProviderName(provider.id)}</strong>
                        <span>{formatProviderAvailability(provider.available)}</span>
                      </div>
                      <div className={css.metrics}>
                        <Metric label={COPY.metricActive} value={provider.metrics.active} />
                        <Metric label={COPY.metricCompleted} value={provider.metrics.completed} />
                        <Metric label={COPY.metricFailed} value={provider.metrics.failed} />
                      </div>
                      {provider.metrics.lastError !== undefined && <p className={css.diagnostic}>{provider.metrics.lastError}</p>}
                    </article>
                  ))}
                </div>
              </section>

              <section>
                <div className={css.sectionTitle}>
                  <span>{COPY.recentActivity}</span>
                  <strong>{formatActiveTaskCount(status.tasks.filter(task => task.state === 'active').length)}</strong>
                </div>
                {status.tasks.length === 0
                  ? <div className={css.emptyActivity}>{COPY.emptyActivity}</div>
                  : (
                    <div className={css.activityList}>
                      {status.tasks.slice(0, 6).map((task) => {
                        const project = status.projects.find(candidate => candidate.id === task.projectId)
                        return (
                          <article key={task.id} className={css.activity} data-toranja-task={task.id}>
                            <StateDot state={task.state === 'active' ? 'ongoing' : task.state === 'completed' ? 'done' : 'error'} />
                            <div className={css.activityText}>
                              <strong>{task.label}</strong>
                              <span>
                                {project?.title ?? task.projectId} · {formatProviderName(task.provider)} · {ROLE_LABELS[task.role]}
                              </span>
                              {task.error !== undefined && <small>{task.error}</small>}
                            </div>
                            <div className={css.activityState}>
                              <span>{TASK_STATE_LABELS[task.state]}</span>
                              <time dateTime={task.startedAt}>{timeFormatter.format(new Date(task.startedAt))}</time>
                            </div>
                          </article>
                        )
                      })}
                    </div>
                  )}
              </section>

              <section>
                <h3>{COPY.projectsHeading}</h3>
                <div className={css.projects}>
                  {status.projects.map(project => (
                    <article key={project.id} className={css.project}>
                      <div className={css.cardHeading}>
                        <StateDot state={project.metrics.failed > 0 ? 'warning' : project.metrics.active > 0 ? 'ongoing' : 'idle'} />
                        <strong>{project.title}</strong>
                        <span>{formatProjectActivity(project.metrics.active)}</span>
                      </div>
                      <code title={project.path}>{project.path}</code>
                      <div className={css.projectTotals}>
                        {formatProjectTotals(project.metrics.completed, project.metrics.failed)}
                      </div>
                    </article>
                  ))}
                </div>
              </section>

              <footer>
                {formatParallelWritePolicy(status.limits.allowParallelImplementation)}
              </footer>
            </div>
          )}
        </div>,
        document.body,
      )}
    </div>
  )
}
