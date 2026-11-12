/** Toranja Control UI copy and localized formatting helpers. */

import type {
  ToranjaAgentMode,
  ToranjaExecutionProfile,
  ToranjaModelTier,
  ToranjaProviderConnection,
  ToranjaProviderId,
  ToranjaProviderStatus,
  ToranjaReadOnlyEnforcement,
  ToranjaRoleAccess,
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

/** Static Portuguese (Brazil) copy for the Orchestrator settings page. */
export const ORCHESTRATOR_COPY = {
  nav: 'Orquestrador',
  heading: 'Orquestrador',
  intro: 'Escolha quais agentes trabalham, em que papel e com qual modelo. O Toranja distribui as tarefas para gastar o mínimo de créditos.',
  loading: 'Carregando…',
  loadFailed: 'Não foi possível ler a configuração do orquestrador',
  saveFailed: 'Não foi possível salvar a alteração',
  connectFailed: 'Não foi possível abrir o login',
  providersHeading: 'Provedores',
  providersHint: 'O login é feito pelo comando oficial de cada provedor; o Toranja nunca vê a sua senha.',
  probe: 'Verificar conexões',
  connect: 'Conectar',
  modeHeading: 'Modo de trabalho',
  teamSizeHeading: 'Tamanho da equipe',
  decreaseTeam: 'Diminuir a equipe',
  increaseTeam: 'Aumentar a equipe',
  profileHeading: 'Perfil',
  profileAria: 'Perfil de custo e qualidade',
} as const

/** Localized labels for provider sign-in states. */
export const CONNECTION_LABELS: Readonly<Record<ToranjaProviderConnection, string>> = {
  connected: 'Conectado',
  'signed-out': 'Desconectado',
  'not-installed': 'Não instalado',
  'probe-failed': 'Falha ao verificar',
  unknown: 'Não verificado',
}

/** Selectable execution profiles and what each does to the model tier of a role. */
export const PROFILE_OPTIONS: ReadonlyArray<{
  profile: ToranjaExecutionProfile
  label: string
  description: string
}> = [
  { profile: 'economico', label: 'Econômico', description: 'Leitura, testes e entrega no modelo leve; planejar, implementar e revisar no avançado.' },
  { profile: 'equilibrado', label: 'Equilibrado', description: 'Leitura no modelo leve; todo o resto no avançado.' },
  { profile: 'qualidade', label: 'Qualidade', description: 'Como o equilibrado, com planejamento, arquitetura e revisão no modelo máximo.' },
]

/**
 * Format the accessible name of a provider's sign-in button.
 * @param name - Display name of the provider.
 * @returns Localized button name.
 */
export function formatConnectLabel(name: string): string {
  return `Conectar ${name}`
}

/**
 * Format the notice shown after a sign-in command was opened.
 * @param name - Display name of the provider.
 * @returns Localized notice telling the user where to finish the sign-in.
 */
export function formatConnectNotice(name: string): string {
  return `Conclua o login do ${name} na janela de terminal que abriu e depois clique em Verificar conexões.`
}

/**
 * Format the caption under the team size.
 * @param max - Largest team size the deployment accepts.
 * @returns Localized caption.
 */
export function formatTeamSizeHint(max: number): string {
  return `Quantos agentes trabalham ao mesmo tempo em um projeto (até ${max}).`
}

/**
 * Explain what a provider needs before it can take tasks.
 * @param name - Display name of the provider.
 * @param provider - Provider status from the Host.
 * @returns Localized next step, or undefined when the provider is ready.
 */
export function formatProviderHint(name: string, provider: ToranjaProviderStatus): string | undefined {
  if (provider.id === 'openrouter') {
    if (provider.connection === 'connected') {
      return provider.available ? undefined : 'A chave está configurada, mas falta um modelo: defina um em Modelos por nível.'
    }
    return 'Adicione a chave do OpenRouter em Configurações → Agentes e modelos e clique em Verificar conexões.'
  }
  switch (provider.connection) {
    case 'connected':
      return undefined
    case 'signed-out':
      return `Entre na sua conta do ${name} para usá-lo.`
    case 'not-installed':
      return `O comando do ${name} não foi encontrado neste computador. Instale-o e clique em Verificar conexões.`
    case 'probe-failed':
      return 'Não foi possível ler o estado do login. Clique em Verificar conexões para tentar de novo.'
    case 'unknown':
      return 'Clique em Verificar conexões para ler o estado do login.'
  }
}

/** Static Portuguese (Brazil) copy for the routing half of the Orchestrator settings page. */
export const ROUTING_COPY = {
  rolesHeading: 'Papéis',
  rolesHint: 'No modo Equipe, cada papel vai para o provedor escolhido aqui. Padrão deixa o Toranja escolher pelo tipo de trabalho.',
  roleColumn: 'Papel',
  providerColumn: 'Provedor',
  routeColumn: 'Rota em uso',
  accessColumn: 'Acesso',
  roleDefault: 'Padrão',
  nativeModel: 'padrão do provedor',
  fallbackHeading: 'Ordem de fallback',
  fallbackHint: 'Quando o provedor de um papel fica sem cota ou indisponível, a tarefa passa para o próximo desta lista.',
  crossReviewHeading: 'Revisão cruzada',
  crossReviewLabel: 'Revisar com um provedor diferente do que implementou',
  crossReviewHint: 'Na verificação de entrega, quem revisa não é o mesmo provedor que escreveu o código, quando houver outro conectado.',
  tierModelsHeading: 'Modelos por nível',
  tierModelsHint: 'Vale para as próximas tarefas; as que já estão rodando continuam no modelo com que começaram.',
  modelColumn: 'Modelo',
  effortColumn: 'Esforço',
  inheritsAdvanced: 'usa o Avançado',
  customized: 'personalizado',
  save: 'Salvar',
  restore: 'Restaurar padrão',
  notEditable: 'Esta instalação não dá ao Toranja uma instância própria deste provedor, então vale o modelo configurado no próprio provedor.',
} as const

/** Localized labels for the access a role is given. */
export const ACCESS_LABELS: Readonly<Record<ToranjaRoleAccess, string>> = {
  'read-only': 'Só leitura',
  execute: 'Executa comandos',
  write: 'Escreve',
}

/** Localized description of how a provider keeps a read-only task from writing. */
export const ENFORCEMENT_LABELS: Readonly<Record<ToranjaReadOnlyEnforcement, string>> = {
  sandbox: 'bloqueio por sandbox',
  'permission-mode': 'bloqueio pelo modo de permissão',
  advisory: 'sem bloqueio: só orientação ao modelo',
  none: 'sem bloqueio: escrita só é detectada depois',
}

/** Localized labels for model tiers. */
export const TIER_LABELS: Readonly<Record<ToranjaModelTier, string>> = {
  light: 'Leve',
  advanced: 'Avançado',
  max: 'Máximo',
}

/**
 * Format the route a role takes: provider, model, and reasoning effort.
 * @param provider - Display name of the provider.
 * @param model - Concrete model, when one is applied.
 * @param effort - Concrete reasoning effort, when one is applied.
 * @returns Localized route summary.
 */
export function formatRoute(provider: string, model: string | undefined, effort: string | undefined): string {
  return [provider, model ?? ROUTING_COPY.nativeModel, ...effort === undefined ? [] : [effort]].join(' · ')
}

/**
 * Format the accessible name of a role's provider selector.
 * @param role - Display name of the role.
 * @returns Localized selector name.
 */
export function formatRoleProviderLabel(role: string): string {
  return `Provedor do papel ${role}`
}

/**
 * Format the note shown while a solo mode overrides the role preferences.
 * @param mode - Display label of the solo mode.
 * @param provider - Display name of its provider.
 * @returns Localized note.
 */
export function formatSoloRoles(mode: string, provider: string): string {
  return `No modo ${mode} todos os papéis usam ${provider}; as preferências abaixo voltam a valer no modo Equipe.`
}

/**
 * Format the accessible name of a fallback-order move button.
 * @param direction - Whether the provider moves earlier or later.
 * @param provider - Display name of the provider.
 * @returns Localized button name.
 */
export function formatMoveLabel(direction: 'up' | 'down', provider: string): string {
  return `${direction === 'up' ? 'Subir' : 'Descer'} ${provider}`
}

/**
 * Format the accessible name of a provider's tier-model group.
 * @param provider - Display name of the provider.
 * @returns Localized group name.
 */
export function formatTierModelsLabel(provider: string): string {
  return `Modelos de ${provider}`
}

/**
 * Format the accessible name of one tier-model field.
 * @param field - Whether the field holds the model or the reasoning effort.
 * @param tier - Display name of the tier.
 * @returns Localized field name.
 */
export function formatTierFieldLabel(field: 'model' | 'effort', tier: string): string {
  return `${field === 'model' ? 'Modelo' : 'Esforço'} do nível ${tier}`
}
