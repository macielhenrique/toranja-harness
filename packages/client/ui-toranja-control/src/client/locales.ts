/** Toranja Control UI copy and localized formatting helpers. */

import type {
  ToranjaAgentMode,
  ToranjaProviderId,
  ToranjaTaskRole,
  ToranjaTaskState,
} from '@deepseek-ai/dsh-toranja-orchestrator/types'

/** Static Portuguese (Brazil) copy for the Toranja Control dashboard. */
export const COPY = {
  triggerAria: 'Agentes do Toranja Harness',
  triggerLabel: 'Agentes',
  panelAria: 'Agentes do Toranja Harness',
  eyebrow: 'TORANJA HARNESS',
  heading: 'Equipe de agentes',
  refreshAria: 'Atualizar',
  loading: 'Carregando…',
  loadFailed: 'Falha ao carregar o Toranja Control',
  setModeFailed: 'Não foi possível alterar o modo dos agentes',
  delegationRouting: 'Roteamento das delegações',
  modePickerAria: 'Modo de trabalho dos agentes',
  primaryHint: 'Para trocar o agente principal desta conversa, use o seletor de modelos ao lado do botão de enviar.',
  providerEyebrow: 'PROVEDOR',
  providerCodex: 'Codex',
  providerAntigravity: 'Antigravity',
  providerClaudeCode: 'Claude Code',
  providerOpenRouter: 'OpenRouter',
  providerHint: 'Pode ser o agente principal ou receber tarefas delegadas.',
  activeCapacity: 'Capacidade ativa',
  agentStateHeading: 'Estado dos agentes',
  metricActive: 'ativos',
  metricCompleted: 'concluídos',
  metricFailed: 'falhas',
  recentActivity: 'Atividade recente',
  emptyActivity: 'Nenhuma tarefa delegada nesta execução.',
  projectsHeading: 'Projetos',
} as const

/** Localized labels for task roles. */
export const ROLE_LABELS: Readonly<Record<ToranjaTaskRole, string>> = {
  reader: 'Leitura',
  searcher: 'Busca',
  inspector: 'Inspeção',
  planner: 'Planejamento',
  architect: 'Arquitetura',
  implementer: 'Implementação',
  reviewer: 'Revisão',
  tester: 'Testes',
  release: 'Entrega',
}

/** Localized labels for task states. */
export const TASK_STATE_LABELS: Readonly<Record<ToranjaTaskState, string>> = {
  active: 'em andamento',
  completed: 'concluída',
  failed: 'falhou',
}

/**Selectable delegation modes and their localized descriptions. */
export const MODE_OPTIONS: ReadonlyArray<{
  mode: ToranjaAgentMode
  label: string
  description: string
}> = [
  { mode: 'team', label: 'Equipe', description: 'O agente principal pode delegar ao outro e consolida a resposta com fallback automático.' },
  { mode: 'codex', label: 'Só Codex', description: 'Executa e delega exclusivamente com Codex.' },
  { mode: 'antigravity', label: 'Só Antigravity', description: 'Executa exclusivamente com Antigravity, sem consumir Codex.' },
  { mode: 'claude-code', label: 'Só Claude Code', description: 'Executa e delega exclusivamente com Claude Code.' },
  { mode: 'openrouter', label: 'Só OpenRouter', description: 'Executa e delega exclusivamente via gateway OpenRouter.' },
]

/**
 * Format the active delegation mode summary.
 * @param mode - Current agent orchestration mode.
 * @returns Localized mode summary label.
 */
export function formatModeSummary(mode: ToranjaAgentMode): string {
  switch (mode) {
    case 'team':
      return 'Equipe automática'
    case 'codex':
      return 'Delegar ao Codex'
    case 'antigravity':
      return 'Delegar ao Antigravity'
    case 'claude-code':
      return 'Delegar ao Claude Code'
    case 'openrouter':
      return 'Delegar ao OpenRouter'
  }
}

/**
 * Format a provider identifier for display.
 * @param id - Provider identifier (`codex`, `antigravity`, `claude-code`, or `openrouter`).
 * @returns Display name of the provider.
 */
export function formatProviderName(id: ToranjaProviderId): string {
  switch (id) {
    case 'codex':
      return COPY.providerCodex
    case 'antigravity':
      return COPY.providerAntigravity
    case 'claude-code':
      return COPY.providerClaudeCode
    case 'openrouter':
      return COPY.providerOpenRouter
  }
}

/**
 * Format provider availability status.
 * @param available - Whether the provider is reachable.
 * @returns Localized availability label.
 */
export function formatProviderAvailability(available: boolean): string {
  return available ? 'disponível' : 'indisponível'
}

/**
 * Format the per-project and per-provider concurrency limits caption.
 * @param perProject - Maximum concurrent tasks per project.
 * @param perProvider - Maximum concurrent tasks per provider.
 * @returns Localized limits summary.
 */
export function formatCapacityLimits(perProject: number, perProvider: number): string {
  return `${perProject} por projeto · ${perProvider} por provedor`
}

/**
 * Format the count of active tasks.
 * @param activeCount - Number of active tasks.
 * @returns Localized active count summary.
 */
export function formatActiveTaskCount(activeCount: number): string {
  return `${activeCount} em andamento`
}

/**
 * Format a project's current activity badge.
 * @param active - Number of active tasks in the project lane.
 * @returns Localized project activity badge.
 */
export function formatProjectActivity(active: number): string {
  return active > 0 ? `${active} ativos` : 'pronto'
}

/**
 * Format a project's completed and failed task counters.
 * @param completed - Number of completed tasks.
 * @param failed - Number of failed tasks.
 * @returns Localized project totals line.
 */
export function formatProjectTotals(completed: number, failed: number): string {
  return `${completed} concluídos · ${failed} falhas`
}

/**
 * Format the footer summary for parallel worktree implementation policy.
 * @param allowed - Whether parallel implementation in the same worktree is allowed.
 * @returns Localized footer notice.
 */
export function formatParallelWritePolicy(allowed: boolean): string {
  return `Escrita paralela no mesmo worktree: ${allowed ? 'permitida' : 'bloqueada'}`
}
