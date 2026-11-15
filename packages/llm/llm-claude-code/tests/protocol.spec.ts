/**
 * Protocol compatibility of the Claude Code leader with the Claude Agent SDK, without a login.
 *
 * The CLI of the CI has no Claude login, so `real-claude.e2e.ts` skips there. These tests replay, through the
 * real adapter and bridge (`src/index.ts`, `src/bridge.ts`), the message sequences a real Claude Code CLI emitted.
 * Only the SDK is simulated: `query()` plays the recorded events in their recorded order, calls the real bridge
 * handler where the recording shows the CLI called it (with the recorded `extra._meta`), and waits where the CLI
 * waited (for the next user input, for the handler result, for `interrupt()`).
 *
 * Data: `fixtures/*.jsonl`, recorded with `@anthropic-ai/claude-agent-sdk` 0.3.263 (Claude Code 2.1.263), the
 * version this package pins. Identifiers, paths, and account data are replaced by neutral values at recording
 * time (`fixtures/gravar.mjs`, `anonymize`); the event order and the payloads the adapter reads are untouched.
 *
 * Regenerate when the SDK pin changes: sign in with `claude auth login`, then run, from the repository root,
 * `node packages/llm/llm-claude-code/tests/fixtures/gravar.mjs` (spends a little subscription quota with haiku),
 * and run this file. A protocol change in the new SDK shows up as a failure here; the fixtures are not edited by
 * hand. Not covered: the 30-minute timeout wait (the fixture marks where the CLI gave up with `signal-abort`)
 * and read-only tools running in parallel, which the adapter does not offer.
 */

import { readFileSync } from 'node:fs'
import { PassThrough } from 'node:stream'
import type { Options, SdkMcpToolDefinition, SDKMessage, SDKResultSuccess, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createAssistantMessage,
  createToolResultMessage,
  ToolCallId,
  type ContentBlock,
  type GenerateOptions,
  type LlmAdapter,
  type RequestMessage,
  type StreamChunk,
  type ToolSchema,
} from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { SubprocessHandle, SubprocessOutcome, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import type { Context } from '@deepseek-ai/cordis'

const sdk = vi.hoisted(() => ({ query: vi.fn() }))
// The real server factory stays, spied, so the replayed CLI reaches the handlers of the bridge server it was given.
vi.mock('@anthropic-ai/claude-agent-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@anthropic-ai/claude-agent-sdk')>()
  return { ...actual, query: sdk.query, createSdkMcpServer: vi.fn(actual.createSdkMcpServer) }
})
const { createSdkMcpServer } = await import('@anthropic-ai/claude-agent-sdk')
const { apply } = await import('../src/index.ts')

/** Where the CLI puts the `tool_use` id in the handler's `extra._meta`. */
const TOOL_USE_ID_META_KEY = 'claudecode/toolUseId'

type Meta = Record<string, unknown>

/** One recorded event, as `fixtures/gravar.mjs` writes it. */
type Recorded =
  | { readonly kind: 'input'; readonly text: string }
  | { readonly kind: 'message'; readonly message: SDKMessage }
  | { readonly kind: 'handler-start'; readonly tool: string; readonly args: Record<string, unknown>; readonly meta: Meta }
  | { readonly kind: 'handler-end'; readonly tool: string; readonly text: string }
  | { readonly kind: 'signal-abort'; readonly reason: string }
  | { readonly kind: 'interrupt' }

function load(name: string): Recorded[] {
  return readFileSync(new URL(`./fixtures/${name}.jsonl`, import.meta.url), 'utf8').trim().split('\n').map((line): Recorded => JSON.parse(line) as Recorded)
}

const messagesOf = (events: readonly Recorded[]): SDKMessage[] => events.flatMap(event => event.kind === 'message' ? [event.message] : [])
const resultsOf = (events: readonly Recorded[]): SDKResultSuccess[] => messagesOf(events).flatMap(message => message.type === 'result' && message.subtype === 'success' ? [message] : [])
const startsOf = (events: readonly Recorded[]) => events.flatMap(event => event.kind === 'handler-start' ? [event] : [])
const idOf = (meta: Meta): string => String(meta[TOOL_USE_ID_META_KEY])

type Handler = SdkMcpToolDefinition['handler']
type HandlerResult = Awaited<ReturnType<Handler>>

/** The handlers of the bridge server handed to `options`, by harness tool name. */
function bridgeHandlers(options: Options): Map<string, Handler> {
  const server = options.mcpServers?.toranja
  const calls = vi.mocked(createSdkMcpServer).mock
  const index = calls.results.findIndex(result => result.value === server)
  return new Map((index === -1 ? [] : calls.calls[index]?.[0].tools ?? []).map(tool => [tool.name, tool.handler]))
}

/** Replayed CLI: what its stdin received, what the handlers it called returned, and whether it played every event. */
interface Replay {
  /** Text of each user message the adapter sent. */
  readonly received: string[]
  /** What each bridge handler returned, by `tool_use` id. */
  readonly results: Map<string, HandlerResult>
  readonly interrupt: ReturnType<typeof vi.fn>
  /** Settles when the last recorded event has been played. */
  readonly done: Promise<void>
}

/**
 * Make `query()` play a recording as the CLI does: messages in order, handler calls where recorded, and waits
 * where the CLI waited for the harness side.
 * @param events - recorded events.
 * @returns the observable state of the replay.
 */
function replay(events: readonly Recorded[]): Replay {
  const received: string[] = []
  const results = new Map<string, HandlerResult>()
  const interrupt = vi.fn(() => Promise.resolve(undefined))
  let finished: () => void = () => undefined
  const done = new Promise<void>((resolve) => { finished = resolve })
  sdk.query.mockImplementation(({ prompt, options }: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => {
    options.spawnClaudeCodeProcess?.({ command: 'claude', args: [], ...options.cwd === undefined ? {} : { cwd: options.cwd }, env: options.env ?? {}, signal: new AbortController().signal })
    const handlers = bridgeHandlers(options)
    const queue: SDKMessage[] = []
    let failure: unknown
    let closed = false
    let wake: () => void = () => undefined
    let interrupted: () => void = () => undefined
    const interruption = new Promise<void>((resolve) => { interrupted = resolve })
    interrupt.mockImplementation(() => { interrupted(); return Promise.resolve(undefined) })
    const play = async (): Promise<void> => {
      const inputs = prompt[Symbol.asyncIterator]()
      /** Handlers called and not yet reported finished, with the signal the SDK aborts on a timeout. */
      const open: { readonly tool: string; readonly done: Promise<void>; readonly controller: AbortController }[] = []
      for (const event of events) {
        if (event.kind === 'input') {
          const next = await inputs.next()
          if (next.done === true) return
          const { content } = next.value.message
          received.push(typeof content === 'string' ? content : JSON.stringify(content))
        } else if (event.kind === 'message') {
          queue.push(event.message)
          wake()
        } else if (event.kind === 'handler-start') {
          const handler = handlers.get(event.tool)
          if (handler === undefined) throw new Error(`no bridge handler for ${event.tool}`)
          const controller = new AbortController()
          const running = handler(event.args, { signal: controller.signal, _meta: event.meta })
          open.push({ tool: event.tool, controller, done: running.then((value) => { results.set(idOf(event.meta), value) }) })
        } else if (event.kind === 'handler-end') {
          await open.shift()?.done
        } else if (event.kind === 'signal-abort') {
          const last = open.pop()
          last?.controller.abort(new Error(event.reason))
          await last?.done
        } else {
          await interruption
        }
      }
    }
    void play().catch((error: unknown) => { failure = error; wake() }).finally(finished)
    async function* messages(): AsyncGenerator<SDKMessage> {
      for (;;) {
        const next = queue.shift()
        if (next !== undefined) yield next
        else if (failure !== undefined) throw failure
        else if (closed) return
        else await new Promise<void>((resolve) => { wake = resolve })
      }
    }
    return Object.assign(messages(), { interrupt, close: vi.fn(() => { closed = true; wake() }) })
  })
  return { received, results, interrupt, done }
}

/** A subprocess service whose CLI processes exit only when terminated. */
function fakeSubprocess(): { spawn: (spec: SubprocessSpawnSpec) => SubprocessHandle } {
  return {
    spawn() {
      let exit: (outcome: SubprocessOutcome) => void = () => undefined
      const done = new Promise<SubprocessOutcome>((resolve) => { exit = resolve })
      const handle: Partial<SubprocessHandle> = {
        stdin: new PassThrough(),
        stdout: new PassThrough(),
        done,
        terminate: () => { exit({ exitCode: null, signal: 'SIGTERM' }) },
        waitForExit: () => Promise.resolve(true),
      }
      return handle as SubprocessHandle
    },
  }
}

function harness(): { adapter: LlmAdapter; warnings: unknown[][] } {
  const warnings: unknown[][] = []
  let adapter: LlmAdapter | undefined
  const ctx: Context = {
    effect: (register: () => (() => void)) => { register() },
    get: () => undefined,
    llm: { registerAdapter: (_providers: readonly string[], value: LlmAdapter) => { adapter = value; return () => undefined } },
    logger: { warn: (...args: unknown[]) => { warnings.push(args) } },
    subprocess: fakeSubprocess(),
  } as never
  apply(ctx)
  if (adapter === undefined) throw new Error('adapter not registered')
  return { adapter, warnings }
}

const TOOLS: ToolSchema[] = [{
  name: 'get_weather',
  description: 'Devolve o tempo atual de uma cidade.',
  parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
}]
const SYSTEM = 'Você é um assistente de teste.'
const source = { provider: 'claude-code-local', model: 'haiku' }

const user = (text: string): RequestMessage => ({ role: 'user', content: [{ type: 'text', text }] })
const reply = (content: readonly ContentBlock[]) => createAssistantMessage({ content, source })
const blocksOf = (chunks: readonly StreamChunk[]): ContentBlock[] => chunks.flatMap(chunk => chunk.type === 'block-end' ? [chunk.block] : [])
const textOf = (chunks: readonly StreamChunk[]): string => chunks.flatMap(chunk => chunk.type === 'text-delta' ? [chunk.text] : []).join('')
const toolCalls = (chunks: readonly StreamChunk[]) => blocksOf(chunks).flatMap(block => block.type === 'tool-call' ? [block] : [])
const usages = (chunks: readonly StreamChunk[]) => chunks.flatMap(chunk => chunk.type === 'usage' ? [chunk.usage] : [])
const argumentsOf = (call: { readonly arguments: string }) => JSON.parse(call.arguments) as Record<string, unknown>
const toolResult =(callId: ToolCallId, text: string) => createToolResultMessage({ callId, content: [{ type: 'text', text }], isError: false })

/** One `stream()` of the conversation. */
async function turn(
  adapter: LlmAdapter,
  history: RequestMessage[],
  signal?: AbortSignal,
  onChunk?: (chunk: StreamChunk) => void,
): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  const options: GenerateOptions = {
    provider: 'claude-code-local',
    model: 'haiku',
    sessionId: 's1' as SessionId,
    system: SYSTEM,
    messages: history,
    tools: TOOLS,
    ...signal === undefined ? {} : { signal },
  }
  for await (const chunk of adapter.stream(options)) {
    chunks.push(chunk)
    onChunk?.(chunk)
  }
  return chunks
}

/** Token counts the recorded result reports for the whole CLI turn, in harness names. */
function resultUsage(events: readonly Recorded[]) {
  const usage = resultsOf(events).at(-1)?.usage
  return {
    inputTokens: usage?.input_tokens,
    outputTokens: usage?.output_tokens,
    cacheReadTokens: usage?.cache_read_input_tokens,
    cacheWriteTokens: usage?.cache_creation_input_tokens,
  }
}

function sumUsages(chunks: readonly StreamChunk[]) {
  const all = usages(chunks)
  const sum = (pick: (usage: (typeof all)[number]) => number | undefined) => all.reduce((total, usage) => total + (pick(usage) ?? 0), 0)
  return {
    inputTokens: sum(usage => usage.inputTokens),
    outputTokens: sum(usage => usage.outputTokens),
    cacheReadTokens: sum(usage => usage.cacheReadTokens),
    cacheWriteTokens: sum(usage => usage.cacheWriteTokens),
  }
}

beforeEach(() => {
  sdk.query.mockReset()
  vi.mocked(createSdkMcpServer).mockClear()
})

describe('Claude Code protocol: a text turn', () => {
  it('streams several text deltas, then usage and finish stop', async () => {
    const events = load('texto')
    const cli = replay(events)
    const { adapter, warnings } = harness()
    const chunks = await turn(adapter, [user('Conte de um a dez.')])
    await cli.done

    const recorded = messagesOf(events)
    const deltas = recorded.filter(message => message.type === 'stream_event' && message.event.type === 'content_block_delta' && message.event.delta.type === 'text_delta')
    expect(deltas.length).toBeGreaterThan(1)
    expect(chunks.filter(chunk => chunk.type === 'text-delta')).toHaveLength(deltas.length)
    expect(textOf(chunks)).toBe(resultsOf(events)[0]?.result)
    expect(chunks.at(-2)).toEqual({ type: 'usage', usage: resultUsage(events) })
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
    expect(cli.received).toEqual(['USUÁRIO:\nConte de um a dez.'])
    expect(warnings).toEqual([])
  })
})

describe('Claude Code protocol: one tool call', () => {
  it('finishes the step on the tool call, then the result releases the handler and the turn ends', async () => {
    const events = load('ferramenta')
    const [start] = startsOf(events)
    const cli = replay(events)
    const { adapter, warnings } = harness()

    const asked = await turn(adapter, [user('Qual é o tempo agora em Lisboa?')])
    expect(asked.at(-1)).toEqual({ type: 'finish', reason: { kind: 'tool-calls' } })
    const calls = toolCalls(asked)
    expect(calls.map(({ id, name }) => ({ id, name }))).toEqual([{ id: ToolCallId(idOf(start?.meta ?? {})), name: 'get_weather' }])
    expect(calls[0] === undefined ? undefined : argumentsOf(calls[0])).toEqual(start?.args)

    const call = calls[0]
    if (call === undefined) throw new Error('no tool call')
    const answered = await turn(adapter, [user('Qual é o tempo agora em Lisboa?'), reply(blocksOf(asked)), toolResult(call.id, 'granizo roxo, 7 graus')])
    await cli.done

    expect(cli.results.get(call.id)).toEqual({ content: [{ type: 'text', text: 'granizo roxo, 7 graus' }] })
    expect(textOf(answered)).toBe(resultsOf(events)[0]?.result)
    expect(answered.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
    expect(sumUsages([...asked, ...answered])).toEqual(resultUsage(events))
    expect(sdk.query).toHaveBeenCalledOnce()
    expect(warnings).toEqual([])
  })

  it('correlates the call by _meta[claudecode/toolUseId]: a handler call without that key is refused', async () => {
    const events = load('ferramenta').map(event => event.kind === 'handler-start' ? { ...event, meta: { progressToken: 1 } } : event)
    const cli = replay(events)
    const { adapter } = harness()

    const asked = await turn(adapter, [user('Qual é o tempo agora em Lisboa?')])
    const [call] = toolCalls(asked)
    await turn(adapter, [user('Qual é o tempo agora em Lisboa?'), reply(blocksOf(asked)), toolResult(call?.id ?? ToolCallId(''), 'granizo roxo, 7 graus')])
    await cli.done

    const [refused] = [...cli.results.values()]
    expect(refused).toMatchObject({ isError: true, content: [{ type: 'text', text: expect.stringContaining('toolUseId') as string }] })
  })
})

describe('Claude Code protocol: two tools in one step', () => {
  it('relays both calls, and the serial handler delivery of the CLI finds each result', async () => {
    const events = load('duas-ferramentas')
    const starts = startsOf(events)
    expect(starts).toHaveLength(2)
    const cli = replay(events)
    const { adapter, warnings } = harness()

    const asked = await turn(adapter, [user('Tempo em Lisboa e Recife?')])
    expect(asked.at(-1)).toEqual({ type: 'finish', reason: { kind: 'tool-calls' } })
    const calls = toolCalls(asked)
    expect(calls.map(call => [call.id, call.name, argumentsOf(call)])).toEqual(starts.map(start => [idOf(start.meta), 'get_weather', start.args]))

    const texts = calls.map((_, index) => `resultado ${index}`)
    const answered = await turn(adapter, [user('Tempo em Lisboa e Recife?'), reply(blocksOf(asked)), ...calls.map((call, index) => toolResult(call.id, texts[index] ?? ''))])
    await cli.done

    calls.forEach((call, index) => {
      expect(cli.results.get(call.id)).toEqual({ content: [{ type: 'text', text: texts[index] }] })
    })
    expect(textOf(answered)).toBe(resultsOf(events)[0]?.result)
    expect(answered.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
    expect(sumUsages([...asked, ...answered])).toEqual(resultUsage(events))
    expect(sdk.query).toHaveBeenCalledOnce()
    expect(warnings).toEqual([])
  })
})

describe('Claude Code protocol: a tool call the CLI timed out', () => {
  it('fails the handler, drops the late result, and ends the turn on the reply the CLI gave', async () => {
    const events = load('timeout')
    const cli = replay(events)
    const { adapter, warnings } = harness()

    const asked = await turn(adapter, [user('Qual é o tempo agora em Lisboa?')])
    const call = toolCalls(asked)[0]
    if (call === undefined) throw new Error('no tool call')
    const answered = await turn(adapter, [user('Qual é o tempo agora em Lisboa?'), reply(blocksOf(asked)), toolResult(call.id, 'granizo roxo, 7 graus')])
    await cli.done

    expect(cli.results.get(call.id)).toMatchObject({ isError: true })
    expect(textOf(answered)).toBe(resultsOf(events)[0]?.result)
    expect(answered.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
    expect(warnings).toEqual([])
  })
})

describe('Claude Code protocol: an interrupted reply', () => {
  it('interrupts the CLI mid-stream, then runs the next turn on the same query', async () => {
    const events = load('interrupcao')
    const cli = replay(events)
    const { adapter, warnings } = harness()
    const controller = new AbortController()
    let deltas = 0

    const cut = await turn(adapter, [user('Escreva os números de 1 a 300.')], controller.signal, (chunk) => {
      if (chunk.type === 'text-delta' && ++deltas === 2) controller.abort()
    })
    expect(cut.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'aborted' } })

    const next = await turn(adapter, [user('Escreva os números de 1 a 300.'), reply([{ type: 'text', text: textOf(cut) }]), user('Responda apenas: pronto')])
    await cli.done

    expect(cli.interrupt).toHaveBeenCalledOnce()
    expect(cli.received).toEqual(['USUÁRIO:\nEscreva os números de 1 a 300.', 'USUÁRIO:\nResponda apenas: pronto'])
    expect(textOf(next)).toBe(resultsOf(events).at(-1)?.result)
    expect(next.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
    expect(sdk.query).toHaveBeenCalledOnce()
    expect(warnings).toEqual([])
  })
})
