/** Structured primary-agent protocol used between Antigravity and Toranja. */

import type { TokenUsage } from '@deepseek-ai/dsh-llm'
import type { Role, ToranjaCodexDelegationResult } from '@deepseek-ai/dsh-toranja-orchestrator'

const ROLES = ['planner', 'implementer', 'reviewer', 'tester', 'release'] as const satisfies readonly Role[]

/** One final answer or a request to run a managed Codex collaborator. */
export type AntigravityAction =
  | { readonly kind: 'answer'; readonly text: string }
  | {
    readonly kind: 'delegate_codex'
    readonly project: string
    readonly role: Role
    readonly description: string
    readonly task: string
  }

/** JSON Schema enforced by the Antigravity CLI for every completed turn. */
export const ANTIGRAVITY_ACTION_SCHEMA = JSON.stringify({
  type: 'object',
  oneOf: [
    {
      properties: {
        kind: { const: 'answer' },
        text: { type: 'string' },
      },
      required: ['kind', 'text'],
      additionalProperties: false,
    },
    {
      properties: {
        kind: { const: 'delegate_codex' },
        project: { type: 'string' },
        role: { type: 'string', enum: ROLES },
        description: { type: 'string' },
        task: { type: 'string' },
      },
      required: ['kind', 'project', 'role', 'description', 'task'],
      additionalProperties: false,
    },
  ],
})

/** One Antigravity turn result before protocol decoding. */
export interface AntigravityStructuredTurn {
  readonly text: string
  readonly usage: TokenUsage
}

/** Dependencies used to resolve a final answer across optional Codex calls. */
export interface AntigravityCoordinatorOptions {
  readonly initialPrompt: string
  readonly maxDelegations: number
  readonly requireDelegation?: boolean
  readonly ask: (prompt: string) => Promise<AntigravityStructuredTurn>
  readonly delegateCodex: (
    action: Extract<AntigravityAction, { kind: 'delegate_codex' }>,
  ) => Promise<ToranjaCodexDelegationResult>
}

/**
 * Detect an explicit user instruction to collaborate with Codex.
 * @param text - User message text.
 * @returns `true` when the message explicitly requests Codex delegation.
 */
export function requestsCodexDelegation(text: string): boolean {
  return /\b(?:delegue|delegar|delegate)\b[\s\S]{0,240}\bcodex\b/iu.test(text)
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function requiredText(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string') throw new Error(`Resposta estruturada do Antigravity sem ${field}`)
  const text = value.trim()
  if (text.length === 0) throw new Error(`Resposta estruturada do Antigravity com ${field} vazio`)
  if (text.length > max) throw new Error(`Resposta estruturada do Antigravity excedeu ${field}`)
  return text
}

function isRole(value: string): value is Role {
  return ROLES.some(role => role === value)
}

function decodeAction(decoded: unknown): AntigravityAction | undefined {
  const value = record(decoded)
  if (value === undefined || typeof value.kind !== 'string') return undefined
  if (value.kind === 'answer') {
    return { kind: 'answer', text: requiredText(value.text, 'text', 100_000) }
  }
  if (value.kind !== 'delegate_codex') throw new Error('Antigravity retornou uma ação desconhecida ao Toranja')
  const role = requiredText(value.role, 'role', 32)
  if (!isRole(role)) throw new Error(`Antigravity solicitou função inválida: ${role}`)
  return {
    kind: 'delegate_codex',
    project: requiredText(value.project, 'project', 64),
    role,
    description: requiredText(value.description, 'description', 80),
    task: requiredText(value.task, 'task', 12_000),
  }
}

/**
 * Parse the last valid action while ignoring CLI progress lines around it.
 * @param text - Raw output text emitted by the Antigravity CLI.
 * @returns Decoded structured action.
 */
export function parseAntigravityAction(text: string): AntigravityAction {
  const candidates = [text.trim(), ...text.split(/\r?\n/u).map(line => line.trim()).reverse()]
  for (const candidate of candidates) {
    if (candidate.length === 0) continue
    let decoded: unknown
    try { decoded = JSON.parse(candidate) } catch { continue }
    const action = decodeAction(decoded)
    if (action !== undefined) return action
  }
  throw new Error('Antigravity retornou uma resposta fora do protocolo estruturado do Toranja')
}

function addUsage(left: TokenUsage, right: TokenUsage): TokenUsage {
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    cacheReadTokens: (left.cacheReadTokens ?? 0) + (right.cacheReadTokens ?? 0),
    reasoningTokens: (left.reasoningTokens ?? 0) + (right.reasoningTokens ?? 0),
    totalTokens: (left.totalTokens ?? 0) + (right.totalTokens ?? 0),
  }
}

/**
 * Resolve an Antigravity answer, returning managed Codex evidence when requested.
 * @param options - Turn coordination inputs and callbacks.
 * @returns Final user-facing answer text and aggregated token usage.
 */
export async function coordinateAntigravityTurn(
  options: AntigravityCoordinatorOptions,
): Promise<{ text: string; usage: TokenUsage }> {
  let prompt = options.initialPrompt
  let usage: TokenUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, reasoningTokens: 0, totalTokens: 0 }
  let delegations = 0
  let corrections = 0
  const maxRounds = options.maxDelegations + (options.requireDelegation ? 2 : 0) + 1
  for (let round = 0; round < maxRounds; round += 1) {
    const result = await options.ask(prompt)
    usage = addUsage(usage, result.usage)
    const action = parseAntigravityAction(result.text)
    if (action.kind === 'answer') {
      if (!options.requireDelegation || delegations > 0) return { text: action.text, usage }
      corrections += 1
      if (corrections > 2) {
        throw new Error('Antigravity não executou a delegação Codex exigida pelo usuário')
      }
      prompt = [
        'CORREÇÃO OBRIGATÓRIA DO PROTOCOLO TORANJA:',
        'O usuário exigiu colaboração real com Codex e nenhuma delegação foi executada.',
        'Não responda kind "answer" e não simule o resultado.',
        'Responda agora somente com kind "delegate_codex", preenchendo project, role, description e task a partir da solicitação original.',
        '',
        'SOLICITAÇÃO ORIGINAL:',
        options.initialPrompt,
      ].join('\n')
      continue
    }
    if (delegations === options.maxDelegations) {
      throw new Error(`Antigravity excedeu ${options.maxDelegations} delegações ao Codex no mesmo turno`)
    }
    delegations += 1
    const delegated = await options.delegateCodex(action)
    prompt = [
      'RESULTADO DO COLABORADOR CODEX GERENCIADO PELO TORANJA:',
      JSON.stringify(delegated),
      '',
      'Analise a evidência acima. Você pode solicitar outra delegação Codex se ainda for necessária e houver capacidade; caso contrário, responda ao usuário com kind "answer".',
    ].join('\n')
  }
  throw new Error('Antigravity não encerrou o turno estruturado dentro do limite')
}
