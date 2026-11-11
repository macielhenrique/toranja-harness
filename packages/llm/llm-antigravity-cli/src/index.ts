/** Direct local Antigravity CLI model route for Toranja Harness. */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import {
  LlmAdapter,
  type GenerateOptions,
  type LlmModelInfo,
  type LlmProviderInfo,
  type RequestMessage,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-subprocess'
import type {} from '@deepseek-ai/dsh-toranja-orchestrator'
import type {} from '@deepseek-ai/dsh-working-directory'
import { coordinateAntigravityTurn, requestsCodexDelegation } from './protocol.ts'
import { AgySession, type AgySessionConfig } from './session.ts'

export const name = 'llm-antigravity-cli'
export const inject = ['agents', 'llm', 'sessions', 'subprocess', 'toranjaOrchestrator', 'workingDirectory']

const PROVIDER = 'antigravity-local'
const MODEL = 'default'
/** Model and effort a Gemini Argon conversation continues on when its quota is exhausted. */
const QUOTA_FALLBACK = { model: 'gemini-3.8-flash-high', effort: 'high' } as const
const NAMED_MODELS: readonly (readonly [id: string, name: string])[] = [
  ['gemini-4-argon-medium', 'Gemini 4 Argon (Médio)'],
  ['gemini-4-argon-high', 'Gemini 4 Argon (Alto)'],
  ['gemini-4-argon-low', 'Gemini 4 Argon (Baixo)'],
  ['gemini-3.8-flash-high', 'Gemini 3.8 Flash (Alto)'],
  ['gemini-3.8-flash-medium', 'Gemini 3.8 Flash (Médio)'],
  ['gemini-3.8-flash-low', 'Gemini 3.8 Flash (Baixo)'],
  ['claude-opus-5-5-low', 'Claude Opus 5.5 (Baixo)'],
  ['claude-opus-5-5-medium', 'Claude Opus 5.5 (Médio)'],
  ['claude-opus-5-5-high', 'Claude Opus 5.5 (Alto)'],
  ['claude-sonnet-5-5-low', 'Claude Sonnet 5.5 (Baixo)'],
  ['claude-sonnet-5-5-medium', 'Claude Sonnet 5.5 (Médio)'],
  ['claude-sonnet-5-5-high', 'Claude Sonnet 5.5 (Alto)'],
  ['gpt-oss-120b-medium', 'GPT-OSS 120B (Médio)'],
]
const MODELS: readonly LlmModelInfo[] = [
  {
    provider: PROVIDER,
    id: MODEL,
    name: 'Antigravity — automático',
    description: 'Usa o modelo padrão selecionado na conta local do Antigravity.',
    inputModalities: ['text'],
  },
  ...NAMED_MODELS.map(([id, name]) => ({
    provider: PROVIDER,
    id,
    name,
    description: 'Usa este modelo com o login e os créditos da conta local do Antigravity.',
    inputModalities: ['text'] as const,
  })),
]
// Switching providers needs enough recent context to continue coherently, but
// replaying an entire long Codex conversation wastes Antigravity credits.
const MAX_HANDOFF_CHARS = 16_000

/** Configuration for the direct Antigravity CLI LLM adapter. */
export interface Config {
  /** Antigravity CLI executable resolved through `PATH` or an absolute path. */
  executable?: string
  /** Time limit of one CLI turn in milliseconds. */
  timeoutMs?: number
  /** Run the CLI with its own terminal sandbox enabled. */
  sandbox?: boolean
  /** Auto-approve headless tool prompts; requires `sandbox`. */
  autoApproveTools?: boolean
  /** Antigravity execution mode of the session. */
  mode?: 'accept-edits' | 'auto' | 'plan'
  /** Model passed to the CLI; omitted to keep the model selected in the chat. */
  model?: string
  /** Reasoning effort passed to the CLI; omitted to keep the CLI default. */
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max'
  /** Upper bound of Codex delegations one primary turn may request. */
  maxCodexDelegationsPerTurn?: number
  /** Explicit environment entries layered over the scrubbed parent environment. */
  env?: Record<string, string>
  /**
   * How long a conversation stays on the quota fallback model before the
   * selected model is tried again, in milliseconds.
   */
  quotaFallbackRetryMs?: number
}

/** Schema for {@link Config}. */
export const Config: z<Config> = z.object({
  executable: z.string().min(1).default('agy'),
  timeoutMs: z.number().default(600_000),
  sandbox: z.boolean().default(true),
  autoApproveTools: z.boolean().default(false),
  mode: z.union(['accept-edits', 'auto', 'plan'] as const).default('accept-edits'),
  model: z.string().min(1),
  effort: z.union(['low', 'medium', 'high', 'xhigh', 'max'] as const),
  maxCodexDelegationsPerTurn: z.number().default(3),
  env: z.dict(z.string()).default({}),
  quotaFallbackRetryMs: z.number().default(900_000),
})

function blockText(message: RequestMessage): string {
  return message.content.flatMap((block) => {
    if (block.type === 'text') return [block.text]
    if (block.type === 'reasoning') return []
    if (block.type === 'tool-call') return [`[chamada de ferramenta: ${block.name}]`]
    if (block.type === 'image') return ['[imagem anexada no Toranja Harness]']
    if (block.type === 'file') return [`[arquivo anexado: ${block.attachment.name}]`]
    return []
  }).join('\n').trim()
}

function collaborationInstructions(ctx: Context): string {
  const mode = ctx.toranjaOrchestrator.status().mode
  const routingRule = mode === 'team'
    ? 'Modo Equipe ativo: quando uma tarefa realmente se beneficiar de um colaborador Codex, use kind "delegate_codex" com project, role, description e task.'
    : mode === 'antigravity'
      ? 'Modo Só Antigravity ativo: execute sozinho e nunca use kind "delegate_codex".'
      : 'Modo Só Codex ativo: não solicite colaboração Codex a partir desta rota Antigravity; responda diretamente.'
  return [
    'PROTOCOLO DE COLABORAÇÃO DO TORANJA:',
    'Sua resposta final deve seguir o esquema JSON configurado pelo aplicativo.',
    'Use {"kind":"answer","text":"..."} para responder ao usuário.',
    routingRule,
    'O Toranja executará o Codex com a conta local, aguardará o resultado e devolverá a evidência nesta mesma conversa.',
    'Não simule delegações em texto. Não delegue respostas simples. Nunca solicite o próprio Antigravity por esse protocolo.',
    `Projetos disponíveis: ${JSON.stringify(ctx.toranjaOrchestrator.lanes())}`,
  ].join('\n')
}

function recentTranscript(messages: readonly RequestMessage[], cwd: string, ctx: Context): string {
  const rows = messages.flatMap((message) => {
    if (message.role === 'system' || message.role === 'developer' || message.role === 'tool') return []
    const text = blockText(message)
    if (text.length === 0) return []
    return [`${message.role === 'user' ? 'USUÁRIO' : 'ASSISTENTE'}:\n${text}`]
  })
  const transcript = rows.join('\n\n')
  const bounded = transcript.length <= MAX_HANDOFF_CHARS
    ? transcript
    : `[início anterior omitido]\n${transcript.slice(-MAX_HANDOFF_CHARS)}`
  return [
    'Você está respondendo diretamente dentro do Toranja Harness.',
    `Diretório ativo do projeto: ${cwd}`,
    'Use suas ferramentas nativas do Antigravity nesse diretório quando a solicitação exigir.',
    'Responda em português brasileiro, salvo pedido diferente do usuário.',
    collaborationInstructions(ctx),
    '',
    'CONTEXTO RECENTE DA CONVERSA:',
    bounded,
  ].join('\n')
}

function latestUserText(messages: readonly RequestMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.role !== 'user') continue
    const text = blockText(message)
    if (text.length > 0) return text
  }
  throw new Error('Antigravity direto requer uma mensagem de usuário com texto')
}

function lastAssistantProvider(messages: readonly RequestMessage[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.role !== 'assistant') continue
    return message.source.provider
  }
  return undefined
}

/**
 * Detects whether an execution error is due to exhausted quota, rate limits, or capacity deficits.
 * @param error - raw error encountered during turn execution.
 * @returns true if the error represents quota or capacity exhaustion.
 */
export function isQuotaExhaustedError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  const msg = error.message.toLowerCase()
  return msg.includes('quota')
    || msg.includes('exhausted')
    || msg.includes('rate limit')
    || msg.includes('429')
    || msg.includes('resource_exhausted')
    || msg.includes('capacity')
    || msg.includes('credit')
    || msg.includes('insufficient')
}


class AntigravityCliAdapter extends LlmAdapter {
  private readonly sessions = new Map<string, AgySession>()
  /** Selected model a conversation left for quota, and until when it stays away. */
  private readonly quotaFallbacks = new Map<string, {
    readonly model: AgySessionConfig['model']
    readonly effort: AgySessionConfig['effort']
    readonly until: number
  }>()

  constructor(
    private readonly ctx: Context,
    private readonly config: Required<Omit<Config, 'model' | 'effort'>> & Pick<Config, 'model' | 'effort'>,
  ) { super() }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: 'Antigravity local' }
  }

  override listModels(_provider: string): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve(MODELS)
  }

  private agyConfig(model: string): AgySessionConfig {
    const configuredModel = this.config.model
    const selectedModel = configuredModel ?? (model === MODEL ? undefined : model)
    const selectedEffort = configuredModel !== undefined || model === MODEL ? this.config.effort : undefined
    return {
      executable: this.config.executable,
      timeoutMs: this.config.timeoutMs,
      sandbox: this.config.sandbox,
      autoApproveTools: this.config.autoApproveTools,
      mode: this.config.mode,
      ...selectedModel === undefined ? {} : { model: selectedModel },
      ...selectedEffort === undefined ? {} : { effort: selectedEffort },
      env: this.config.env,
    }
  }

  private cwd(options: GenerateOptions): string {
    if (options.sessionId === undefined) return process.cwd()
    const session = this.ctx.sessions.get(options.sessionId)
    return session === undefined ? process.cwd() : this.ctx.workingDirectory.get(session)
  }

  private sessionKey(options: GenerateOptions): string | undefined {
    return options.purpose === undefined && options.sessionId !== undefined ? String(options.sessionId) : undefined
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const cwd = this.cwd(options)
    const key = this.sessionKey(options)
    const priorProvider = lastAssistantProvider(options.messages)
    const selectedConfig = this.agyConfig(options.model)
    // A conversation that fell back for quota stays on the fallback model until
    // the retry interval passes or the user selects another model.
    const fallback = key === undefined ? undefined : this.quotaFallbacks.get(key)
    const onFallback = fallback !== undefined
      && fallback.model === selectedConfig.model
      && fallback.effort === selectedConfig.effort
      && Date.now() < fallback.until
    if (key !== undefined && fallback !== undefined && !onFallback) this.quotaFallbacks.delete(key)
    const agyConfig: AgySessionConfig = onFallback
      ? { ...selectedConfig, ...QUOTA_FALLBACK }
      : selectedConfig
    let driver = key === undefined ? undefined : this.sessions.get(key)
    const needsHandoff = driver === undefined
      || driver.cwd !== cwd
      || driver.model !== agyConfig.model
      || driver.effort !== agyConfig.effort
      || priorProvider !== PROVIDER
    if (driver !== undefined && needsHandoff) {
      driver.close()
      if (key !== undefined) this.sessions.delete(key)
      driver = undefined
    }
    let activeDriver = driver ?? new AgySession(cwd, this.ctx, agyConfig)
    if (key !== undefined) this.sessions.set(key, activeDriver)
    const userText = latestUserText(options.messages)
    const prompt = needsHandoff ? recentTranscript(options.messages, cwd, this.ctx) : userText
    const requireDelegation = this.ctx.toranjaOrchestrator.status().mode === 'team'
      && requestsCodexDelegation(userText)
    try {
      const coordinated = await coordinateAntigravityTurn({
        initialPrompt: prompt,
        maxDelegations: this.config.maxCodexDelegationsPerTurn,
        requireDelegation,
        ask: async (nextPrompt) => {
          try {
            return await activeDriver.ask(nextPrompt, options.signal)
          } catch (error: unknown) {
            const isArgon = agyConfig.model?.includes('argon') === true
            if (isArgon && isQuotaExhaustedError(error)) {
              this.ctx.logger.warn(`llm-antigravity-cli: quota exhausted on ${String(agyConfig.model)}; continuing on ${QUOTA_FALLBACK.model}`)
              activeDriver.close()
              const fallbackDriver = new AgySession(cwd, this.ctx, { ...agyConfig, ...QUOTA_FALLBACK })
              if (key !== undefined) {
                this.sessions.set(key, fallbackDriver)
                this.quotaFallbacks.set(key, {
                  model: selectedConfig.model,
                  effort: selectedConfig.effort,
                  until: Date.now() + this.config.quotaFallbackRetryMs,
                })
              }
              activeDriver = fallbackDriver
              // The fallback process starts without history, so it receives the
              // conversation so far; a mid-turn follow-up is appended to it.
              const transcript = recentTranscript(options.messages, cwd, this.ctx)
              return await fallbackDriver.ask(
                nextPrompt === prompt ? transcript : `${transcript}\n\n${nextPrompt}`,
                options.signal,
              )
            }
            throw error
          }
        },
        delegateCodex: async (action) => {
          if (options.sessionId === undefined) {
            throw new Error('Antigravity não pode delegar ao Codex fora de uma conversa do Toranja')
          }
          const parent = this.ctx.agents.get(options.sessionId)
          if (parent === undefined) {
            throw new Error('A conversa do Toranja não possui um agente ativo para receber a delegação')
          }
          return this.ctx.toranjaOrchestrator.delegateCodex({
            project: action.project,
            role: action.role,
            description: action.description,
            task: action.task,
            parent,
            signal: options.signal ?? new AbortController().signal,
          })
        },
      })
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: coordinated.text }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: coordinated.text } }
      yield { type: 'usage', usage: coordinated.usage }
      yield { type: 'finish', reason: { kind: 'stop' } }
    } finally {
      if (key === undefined) activeDriver.close()
    }
  }

  dispose(): void {
    for (const session of this.sessions.values()) session.close()
    this.sessions.clear()
  }
}

export function apply(ctx: Context, config: Config): void {
  const resolved = {
    executable: config.executable ?? 'agy',
    timeoutMs: config.timeoutMs ?? 600_000,
    sandbox: config.sandbox ?? true,
    autoApproveTools: config.autoApproveTools ?? false,
    mode: config.mode ?? 'accept-edits',
    ...config.model === undefined ? {} : { model: config.model },
    ...config.effort === undefined ? {} : { effort: config.effort },
    maxCodexDelegationsPerTurn: config.maxCodexDelegationsPerTurn ?? 3,
    env: config.env ?? {},
    quotaFallbackRetryMs: config.quotaFallbackRetryMs ?? 900_000,
  }
  if (!Number.isFinite(resolved.quotaFallbackRetryMs) || resolved.quotaFallbackRetryMs < 0) {
    throw new Error('llm-antigravity-cli: quotaFallbackRetryMs deve ser um número não negativo')
  }
  if (!Number.isSafeInteger(resolved.timeoutMs) || resolved.timeoutMs < 1) {
    throw new Error('llm-antigravity-cli: timeoutMs deve ser um inteiro positivo')
  }
  if (resolved.autoApproveTools && !resolved.sandbox) {
    throw new Error('llm-antigravity-cli: autoApproveTools exige sandbox=true')
  }
  if (!Number.isSafeInteger(resolved.maxCodexDelegationsPerTurn) || resolved.maxCodexDelegationsPerTurn < 1) {
    throw new Error('llm-antigravity-cli: maxCodexDelegationsPerTurn deve ser um inteiro positivo')
  }
  const adapter = new AntigravityCliAdapter(ctx, resolved)
  ctx.effect(() => {
    const unregister = ctx.llm.registerAdapter([PROVIDER], adapter)
    return () => {
      unregister()
      adapter.dispose()
    }
  }, 'llm-antigravity-cli: register direct Antigravity route')
}
