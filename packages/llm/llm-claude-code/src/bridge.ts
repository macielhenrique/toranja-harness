/**
 * Tool pass-through of the Claude Code chat leader: the harness tools reach Claude as an in-process
 * MCP server whose handlers never execute anything. A handler registers the call as pending and waits
 * for the result the harness loop returns later.
 */

import { createSdkMcpServer, tool, type McpSdkServerConfigWithInstance, type SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk'
import type { ToolSchema } from '@deepseek-ai/dsh-llm'
import { z } from 'zod'

/** The tool handler shape `tool()` expects. */
export type BridgeHandler = Parameters<typeof tool>[3]

/** A tool left out of the server because its JSON Schema does not convert. */
export interface RefusedTool {
  /** Harness name of the tool. */
  readonly name: string
  /** Why the conversion failed. */
  readonly reason: string
}

/** Where the CLI puts the `tool_use` id in the handler's `extra._meta`. Undocumented: its absence is an error. */
const TOOL_USE_ID_META_KEY = 'claudecode/toolUseId'

/** Largest result text handed to the model; the excess is cut and the model is told. */
export const MAX_RESULT_TEXT_CHARS = 100_000

/** Largest accepted size of a call's arguments, measured on their JSON text; a bigger call is refused. */
export const MAX_INPUT_CHARS = 100_000

/** Cut the text to the limit, never splitting a surrogate pair, and append a notice with the omitted amount. */
function limitResultText(content: string): string {
  if (content.length <= MAX_RESULT_TEXT_CHARS) return content
  const last = content.charCodeAt(MAX_RESULT_TEXT_CHARS - 1)
  const end = last >= 0xd800 && last <= 0xdbff ? MAX_RESULT_TEXT_CHARS - 1 : MAX_RESULT_TEXT_CHARS
  return `${content.slice(0, end)}\n[resultado truncado: ${content.length - end} caracteres omitidos]`
}

/** A tool call Claude made, waiting for the harness to run it. */
export interface BridgeCall {
  /** The `tool_use` id of the call. */
  readonly id: string
  /** Harness name of the tool. */
  readonly name: string
  /** Arguments, already validated by the translated schema. */
  readonly input: Record<string, unknown>
}

/** What the harness returns for a call. */
export interface BridgeResult {
  /** Text the model sees. */
  readonly content: string
  /** Marks the result as a tool failure. */
  readonly isError?: boolean
}

/** What a handler hands back to the SDK. */
type HandlerResult = Awaited<ReturnType<BridgeHandler>>

const failure = (message: string): HandlerResult => ({ content: [{ type: 'text', text: message }], isError: true })

/**
 * Registry of calls the model made and the harness has not answered yet, keyed by `tool_use` id.
 * @param onCall - told about each new pending call; the harness runs it and later calls `resolve`.
 * @returns Handlers to register in the server, plus `resolve`, `rejectAll` and the pending count.
 */
export function createPendingCalls(onCall: (call: BridgeCall) => void): {
  /** Builds the handler of one tool: it registers the call as pending and settles when the harness answers. */
  handlerFor: (name: string) => BridgeHandler
  /** Release a pending call with the harness result; false when the id is not pending (already answered or abandoned). */
  resolve: (id: string, result: BridgeResult) => boolean
  /** Release every pending call as an error (the CLI closed or died). */
  rejectAll: (reason: string) => void
  /** Number of calls still pending. */
  readonly size: number
} {
  const pending = new Map<string, (result: HandlerResult) => void>()
  return {
    handlerFor: name => (args, extra) => {
      const { signal, _meta } = (extra ?? {}) as { signal?: AbortSignal; _meta?: Record<string, unknown> }
      const id = _meta?.[TOOL_USE_ID_META_KEY]
      if (typeof id !== 'string' || id === '') {
        return Promise.resolve(failure(`A chamada de ${name} chegou sem o toolUseId; não dá para associá-la ao resultado.`))
      }
      if (pending.has(id)) return Promise.resolve(failure(`Já existe uma chamada pendente com o toolUseId ${id}.`))
      if (signal?.aborted === true) return Promise.resolve(failure(`A chamada ${id} foi abandonada antes de começar.`))
      if (JSON.stringify(args).length > MAX_INPUT_CHARS) {
        return Promise.resolve(failure(`Os argumentos de ${name} passam do limite de ${MAX_INPUT_CHARS} caracteres.`))
      }
      return new Promise((settle) => {
        pending.set(id, settle)
        signal?.addEventListener('abort', () => {
          if (pending.delete(id)) settle(failure(`A chamada ${id} foi abandonada.`))
        }, { once: true })
        try {
          onCall({ id, name, input: args })
        } catch (error) {
          pending.delete(id)
          settle(failure(error instanceof Error ? error.message : String(error)))
        }
      })
    },
    resolve(id, { content, isError }) {
      const settle = pending.get(id)
      if (settle === undefined) return false
      pending.delete(id)
      settle({ content: [{ type: 'text', text: limitResultText(content) }], ...isError === true ? { isError: true } : {} })
      return true
    },
    rejectAll(reason) {
      for (const settle of pending.values()) settle(failure(reason))
      pending.clear()
    },
    get size() { return pending.size },
  }
}

/** Smallest per-call timeout the SDK honors; below it the SDK silently falls back to its own default. */
export const MIN_TOOL_TIMEOUT_MS = 1000

/** Name of the bridge server; the model sees its tools as `mcp__toranja__<tool>`. */
export const BRIDGE_SERVER_NAME = 'toranja'

/** Options of {@link createBridgeServer}. */
export interface BridgeServerOptions {
  /** Harness tool definitions, as in `GenerateOptions.tools`. */
  readonly tools: readonly ToolSchema[]
  /** Told about each call the model makes; the harness answers it later through `resolve`. */
  readonly onCall: (call: BridgeCall) => void
  /** Hard wall-clock limit of one call, in ms (at least {@link MIN_TOOL_TIMEOUT_MS}); it must cover the whole harness round trip. */
  readonly timeoutMs: number
  /** Tools the caller vouches for as read-only; see {@link translateTools}. */
  readonly readOnlyTools?: Iterable<string>
}

/**
 * Assemble the in-process MCP server named `toranja` that exposes the harness tools to Claude.
 * @param options - tools, call callback, timeout, and the read-only names.
 * @returns The server config for `query()`, the tools left out, and the registry controls.
 * @throws {RangeError} When `timeoutMs` is not a finite number.
 */
export function createBridgeServer(options: BridgeServerOptions): {
  server: McpSdkServerConfigWithInstance
  refused: RefusedTool[]
  resolve: (id: string, result: BridgeResult) => boolean
  rejectAll: (reason: string) => void
} {
  const { tools, onCall, timeoutMs, readOnlyTools } = options
  if (!Number.isFinite(timeoutMs)) throw new RangeError(`timeoutMs precisa ser um número finito, recebeu ${timeoutMs}`)
  const calls = createPendingCalls(onCall)
  const translated = translateTools(tools, calls.handlerFor, readOnlyTools)
  return {
    server: createSdkMcpServer({
      name: BRIDGE_SERVER_NAME,
      tools: translated.tools,
      alwaysLoad: true,
      timeout: Math.max(MIN_TOOL_TIMEOUT_MS, timeoutMs),
    }),
    refused: translated.refused,
    resolve: calls.resolve,
    rejectAll: calls.rejectAll,
  }
}

/**
 * Translate harness tool definitions (JSON Schema parameters) into SDK tool definitions.
 *
 * The SDK only takes a Zod raw shape as `inputSchema`, never raw JSON Schema, so each root object
 * schema goes through `z.fromJSONSchema` (zod 4). A schema that does not convert leaves its tool out
 * and appears in `refused`; this function never throws for a bad schema.
 * @param tools - harness tool definitions, as in `GenerateOptions.tools`.
 * @param handlerFor - builds the handler of one tool from its harness name.
 * @param readOnlyTools - names the caller vouches for as read-only; only those get `readOnlyHint`,
 * which lets the model's parallel calls reach the handlers together.
 * @returns The translated tools and the refused ones.
 */
export function translateTools(
  tools: readonly ToolSchema[],
  handlerFor: (name: string) => BridgeHandler,
  readOnlyTools: Iterable<string> = [],
): { tools: SdkMcpToolDefinition[]; refused: RefusedTool[] } {
  const readOnly = new Set(readOnlyTools)
  const translated: SdkMcpToolDefinition[] = []
  const refused: RefusedTool[] = []
  for (const { name, description, parameters } of tools) {
    try {
      const schema = z.fromJSONSchema(parameters)
      if (!(schema instanceof z.ZodObject)) throw new Error('os parâmetros precisam ser um objeto JSON Schema')
      const extras = readOnly.has(name) ? { annotations: { readOnlyHint: true } } : undefined
      translated.push(tool(name, description, schema.shape, handlerFor(name), extras))
    } catch (error) {
      refused.push({ name, reason: error instanceof Error ? error.message : String(error) })
    }
  }
  return { tools: translated, refused }
}
