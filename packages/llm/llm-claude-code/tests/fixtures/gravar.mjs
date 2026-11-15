// Regrava as fixtures de protocolo (`*.jsonl` desta pasta) com o CLI real do Claude Code, via o SDK fixado
// do pacote. Gasta cota da assinatura (modelo haiku, poucos turnos) e exige `claude auth login`.
// Uso, da raiz do repositório: node packages/llm/llm-claude-code/tests/fixtures/gravar.mjs [cenário...]
// Cenários: texto, ferramenta, duas-ferramentas, interrupcao, timeout (todos, por padrão).
// Cada linha gravada é um evento da sequência, na ordem em que ocorreu:
//   input          texto que o adaptador mandou ao CLI
//   message        SDKMessage que o CLI emitiu, sem alteração além da anonimização
//   handler-start  chamada do handler MCP: ferramenta, argumentos e `extra._meta`
//   handler-end    o handler devolveu o resultado
//   signal-abort   o SDK abortou o sinal do handler (timeout do CLI)
//   interrupt      alguém chamou `query.interrupt()`
// Os dados passam por `anonymize` antes de ir ao disco; a gravação falha se sobrar algo que pareça pessoal.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'
import { query, createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'

const SYSTEM = 'Você é um assistente de teste. Responda em português, em no máximo duas frases. Para o tempo de uma cidade, use sempre a ferramenta get_weather; nunca invente o tempo.'
const WEATHER = { lisboa: 'granizo roxo, 7 graus', recife: 'neve verde, 41 graus' }
const SCENARIOS = {
  texto: 'Conte de um a dez por extenso, separados por vírgula.',
  ferramenta: 'Qual é o tempo agora em Lisboa?',
  'duas-ferramentas': 'Qual é o tempo agora em Lisboa e em Recife? Chame get_weather para as duas cidades na mesma resposta, em paralelo.',
  interrupcao: 'Escreva os números de 1 a 300 por extenso, um por linha, sem mais nada.',
  timeout: 'Qual é o tempo agora em Lisboa?',
}
const DROPPED_KEYS = new Set([
  'memory_paths', 'messaging_socket_path', 'powershell_path', 'slash_commands', 'terminal_slash_commands', 'skills', 'agents', 'plugins',
])
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms) })

/** Replace identifiers, paths and account data of one recorded event by neutral values; ids keep their uniqueness. */
function anonymize(events) {
  const ids = new Map()
  const neutral = (kind, original) => {
    const key = `${kind}:${original}`
    if (!ids.has(key)) ids.set(key, ids.size + 1)
    return ids.get(key)
  }
  const scrub = (value, key) => {
    if (Array.isArray(value)) return value.map((item) => scrub(item))
    if (value !== null && typeof value === 'object') {
      if (key === 'rate_limit_info') return { status: value.status, rateLimitType: value.rateLimitType }
      return Object.fromEntries(Object.entries(value).filter(([name]) => !DROPPED_KEYS.has(name)).map(([name, item]) => [name, scrub(item, name)]))
    }
    if (typeof value !== 'string') return value
    if (key === 'cwd') return 'C:\\neutro\\cwd'
    if (key === 'signature' && value !== '') return 'assinatura-neutra'
    if (key === 'timestamp') return '2026-01-01T00:00:00.000Z'
    return value
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, (id) => `00000000-0000-4000-8000-${String(neutral('uuid', id)).padStart(12, '0')}`)
      .replace(/\b(toolu|msg|req)_[A-Za-z0-9]{16,}\b/g, (id, kind) => `${kind}_${String(neutral(kind, id)).padStart(4, '0')}`)
  }
  return events.map((event) => scrub(event))
}

/** Fail the recording when a sensitive-looking string survives anonymization. */
function assertClean(lines, scenario) {
  const escape = (text) => text.replaceAll(/[$()*+.?[\\\]^{|}]/g, '\\$&')
  const generic = String.raw`\\users\\|/users/|\.claude|@[a-z0-9-]+\.[a-z]{2,}|sk-ant|bearer|oauth|access_token|refresh_token|authorization|\\\\\.\\pipe`
  const leak = new RegExp(`${escape(userInfo().username)}|${escape(homedir())}|${generic}`, 'i')
  for (const line of lines) {
    const found = leak.exec(line)
    if (found !== null) throw new Error(`${scenario}: dado possivelmente pessoal sobrou na fixture (${found[0]}); ajuste anonymize()`)
  }
}

async function record(scenario) {
  const events = []
  const rec = (kind, data = {}) => { events.push({ kind, ...data }) }
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
    !/KEY|TOKEN|SECRET|PASSWORD/i.test(name) && !/^(CLAUDE|ANTHROPIC|MCP_)/i.test(name)))
  const weather = tool('get_weather', 'Devolve o tempo atual de uma cidade.', { city: z.string() }, (args, extra) => {
    rec('handler-start', { tool: 'get_weather', args, meta: extra?._meta })
    extra?.signal?.addEventListener?.('abort', () => { rec('signal-abort', { reason: String(extra.signal.reason) }) })
    return new Promise((resolve) => {
      setTimeout(() => {
        const text = WEATHER[String(args.city).toLowerCase()] ?? 'sem dados'
        rec('handler-end', { tool: 'get_weather', text })
        resolve({ content: [{ type: 'text', text }] })
      }, scenario === 'timeout' ? 8000 : 300)
    })
  })
  const server = createSdkMcpServer({ name: 'toranja', version: '0.0.1', tools: [weather], alwaysLoad: true, ...scenario === 'timeout' ? { timeout: 3000 } : {} })
  const queued = []
  let wake
  let ended = false
  const prompt = { async * [Symbol.asyncIterator]() {
    for (;;) {
      while (queued.length > 0) yield queued.shift()
      if (ended) return
      await new Promise((resolve) => { wake = resolve })
    }
  } }
  const say = (text) => {
    rec('input', { text })
    queued.push({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null })
    wake?.()
  }
  const cwd = mkdtempSync(join(tmpdir(), 'dsh-protocol-record-'))
  const q = query({ prompt, options: {
    model: 'haiku', tools: [], mcpServers: { toranja: server }, strictMcpConfig: true, settingSources: [],
    persistSession: false, includePartialMessages: true, cwd, env, systemPrompt: SYSTEM,
    allowedTools: ['mcp__toranja__get_weather'],
  } })
  say(SCENARIOS[scenario])
  let results = 0
  let deltas = 0
  for await (const message of q) {
    rec('message', { message })
    const event = message.type === 'stream_event' ? message.event : undefined
    if (scenario === 'interrupcao' && event?.type === 'content_block_delta' && event.delta.type === 'text_delta' && ++deltas === 2) {
      rec('interrupt')
      void q.interrupt()
    }
    if (message.type !== 'result') continue
    if (scenario === 'interrupcao' && ++results === 1) say('Responda apenas: pronto')
    else break
  }
  ended = true
  wake?.()
  q.close()
  await sleep(1500)
  rmSync(cwd, { recursive: true, force: true })
  return events
}

const wanted = process.argv.length > 2 ? process.argv.slice(2) : Object.keys(SCENARIOS)
for (const scenario of wanted) {
  if (!(scenario in SCENARIOS)) throw new Error(`cenário desconhecido: ${scenario}`)
  const lines = anonymize(await record(scenario)).map((event) => JSON.stringify(event))
  assertClean(lines, scenario)
  writeFileSync(join(import.meta.dirname, `${scenario}.jsonl`), `${lines.join('\n')}\n`)
  console.info(`${scenario}: ${lines.length} eventos`)
}
