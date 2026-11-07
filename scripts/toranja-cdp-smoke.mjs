const prompt = process.argv[2]
const markers = process.argv.slice(3)
const expectedSubagentDelta = Number.parseInt(process.env.TORANJA_EXPECT_SUBAGENT_DELTA ?? '0', 10)

if (!prompt || markers.length === 0) {
  throw new Error('usage: node scripts/toranja-cdp-smoke.mjs <prompt> <marker> [...]')
}

const pages = await fetch('http://127.0.0.1:9333/json').then((response) => response.json())
const page = pages.find((candidate) => candidate.type === 'page' && candidate.webSocketDebuggerUrl)

if (!page) throw new Error('Toranja Harness page not found on port 9333')

const socket = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true })
  socket.addEventListener('error', reject, { once: true })
})

let commandId = 0
const pending = new Map()
socket.addEventListener('message', ({ data }) => {
  const message = JSON.parse(data)
  if (!message.id) return
  const entry = pending.get(message.id)
  if (!entry) return
  pending.delete(message.id)
  if (message.error) entry.reject(new Error(JSON.stringify(message.error)))
  else entry.resolve(message.result)
})

function command(method, params = {}) {
  const id = ++commandId
  socket.send(JSON.stringify({ id, method, params }))
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }))
}

async function evaluate(expression) {
  const result = await command('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  })
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text)
  return result.result.value
}

await command('Runtime.enable')

const beforeText = await evaluate('document.body.innerText')
const beforeFailures = beforeText.split('This turn failed').length - 1
const beforeStatusUpdates = beforeText.split('Subtask status updated').length - 1
const beforeSubagents = Math.max(
  0,
  ...[...beforeText.matchAll(/(\d+) subagents/g)].map((match) => Number.parseInt(match[1], 10)),
)
const beforeMarkers = Object.fromEntries(
  markers.map((marker) => [marker, beforeText.split(marker).length - 1]),
)

const inserted = await evaluate(`(() => {
  const editor = document.querySelector('[data-composer-input="true"]')
  if (!(editor instanceof HTMLElement) || editor.offsetParent === null) return false
  editor.focus()
  const range = document.createRange()
  range.selectNodeContents(editor)
  const selection = window.getSelection()
  selection?.removeAllRanges()
  selection?.addRange(range)
  return document.execCommand('insertText', false, ${JSON.stringify(prompt)})
})()`)

if (!inserted) throw new Error('Visible chat editor not found')

let submitted = false
const submitDeadline = Date.now() + 10_000
while (Date.now() < submitDeadline) {
  submitted = await evaluate(`(() => {
    const button = document.querySelector('[data-composer-card] button[aria-label="Send message"]')
    if (!(button instanceof HTMLButtonElement) || button.disabled) return false
    button.click()
    return true
  })()`)
  if (submitted) break
  await new Promise(resolve => setTimeout(resolve, 250))
}
if (!submitted) throw new Error('Send message button did not become available')

const deadline = Date.now() + 360_000
let bodyText = ''
while (Date.now() < deadline) {
  await new Promise((resolve) => setTimeout(resolve, 2_000))
  bodyText = await evaluate('document.body.innerText')
  const allReturned = markers.every(
    (marker) => bodyText.split(marker).length - 1 >= beforeMarkers[marker] + 2,
  )
  const currentSubagents = Math.max(
    0,
    ...[...bodyText.matchAll(/(\d+) subagents/g)].map((match) => Number.parseInt(match[1], 10)),
  )
  const statusUpdates = bodyText.split('Subtask status updated').length - 1 - beforeStatusUpdates
  if (
    allReturned &&
    currentSubagents >= beforeSubagents + expectedSubagentDelta &&
    statusUpdates >= expectedSubagentDelta
  ) break
  if (bodyText.split('This turn failed').length - 1 > beforeFailures) break
}

const summary = {
  markers: Object.fromEntries(
    markers.map((marker) => [marker, bodyText.split(marker).length - 1 - beforeMarkers[marker]]),
  ),
  failed: bodyText.split('This turn failed').length - 1 > beforeFailures,
  subagents: {
    before: beforeSubagents,
    after: Math.max(
      0,
      ...[...bodyText.matchAll(/(\d+) subagents/g)].map((match) => Number.parseInt(match[1], 10)),
    ),
  },
  statusUpdates: bodyText.split('Subtask status updated').length - 1 - beforeStatusUpdates,
  tail: bodyText.slice(-4_000),
}

console.log(JSON.stringify(summary, null, 2))
socket.close()

if (
  summary.failed ||
  Object.values(summary.markers).some((count) => count < 2) ||
  summary.subagents.after < summary.subagents.before + expectedSubagentDelta ||
  summary.statusUpdates < expectedSubagentDelta
) process.exitCode = 1
