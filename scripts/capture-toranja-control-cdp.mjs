import { writeFile } from 'node:fs/promises'

const output = process.argv[2]
const desiredMode = process.argv[3]
const allowedModes = new Set(['Equipe', 'Codex', 'Antigravity'])
if (!output || (desiredMode !== undefined && !allowedModes.has(desiredMode))) {
  throw new Error('usage: node scripts/capture-toranja-control-cdp.mjs <output.png> [Equipe|Codex|Antigravity]')
}

const pages = await fetch('http://127.0.0.1:9333/json').then(response => response.json())
const page = pages.find(candidate => candidate.type === 'page' && candidate.webSocketDebuggerUrl)
if (!page) throw new Error('Toranja Harness page not found on port 9333')

const socket = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true })
  socket.addEventListener('error', reject, { once: true })
})

let id = 0
const pending = new Map()
socket.addEventListener('message', ({ data }) => {
  const message = JSON.parse(data)
  const entry = pending.get(message.id)
  if (!entry) return
  pending.delete(message.id)
  if (message.error) entry.reject(new Error(JSON.stringify(message.error)))
  else entry.resolve(message.result)
})

function command(method, params = {}) {
  const currentId = ++id
  socket.send(JSON.stringify({ id: currentId, method, params }))
  return new Promise((resolve, reject) => pending.set(currentId, { resolve, reject }))
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
const deadline = Date.now() + 30_000
let opened = false
while (Date.now() < deadline) {
  opened = await evaluate(`(() => {
    const panel = document.querySelector('[data-toranja-control-panel]')
    if (panel) return true
    const trigger = document.querySelector('[data-toranja-control] button')
    if (!trigger) {
      const session = [...document.querySelectorAll('button, [role="button"], [role="treeitem"]')]
        .find(element => element.textContent?.trim().startsWith('teste'))
      session?.click()
      return false
    }
    trigger.click()
    return true
  })()`)
  if (opened) break
  await new Promise(resolve => setTimeout(resolve, 500))
}
if (!opened) throw new Error('Toranja Control trigger did not appear')

await evaluate(`(() => {
  const refresh = document.querySelector('[data-toranja-control-panel] button[aria-label="Atualizar"]')
  if (refresh instanceof HTMLButtonElement) refresh.click()
})()`)
await new Promise(resolve => setTimeout(resolve, 1_000))

let panelText = ''
while (Date.now() < deadline) {
  panelText = await evaluate(`document.querySelector('[data-toranja-control-panel]')?.innerText ?? ''`)
  if (panelText.includes('Codex') && panelText.includes('Antigravity')) break
  await new Promise(resolve => setTimeout(resolve, 500))
}
if (!panelText.includes('Codex') || !panelText.includes('Antigravity')) {
  throw new Error(`Toranja Control did not load provider status: ${panelText}`)
}

if (desiredMode !== undefined) {
  const changed = await evaluate(`(() => {
    const target = [...document.querySelectorAll('[role="radio"]')]
      .find(element => element.textContent?.trim() === ${JSON.stringify(desiredMode)})
    if (!target) return { found: false, checked: false }
    if (target.getAttribute('aria-checked') !== 'true') target.click()
    return { found: true, checked: target.getAttribute('aria-checked') === 'true' }
  })()`)
  if (!changed.found) throw new Error(`Agent mode control not found: ${desiredMode}`)

  let selected = false
  while (Date.now() < deadline) {
    selected = await evaluate(`[...document.querySelectorAll('[role="radio"]')]
      .some(element => element.textContent?.trim() === ${JSON.stringify(desiredMode)} && element.getAttribute('aria-checked') === 'true')`)
    if (selected) break
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  if (!selected) throw new Error(`Agent mode did not change: ${desiredMode}`)
  panelText = await evaluate(`document.querySelector('[data-toranja-control-panel]')?.innerText ?? ''`)
}

const evidence = await evaluate(`(() => {
  const body = document.body.innerText
  const logo = document.querySelector('img[alt="Toranja Tech"]')
  const rect = logo?.getBoundingClientRect()
  const selectedMode = [...document.querySelectorAll('[role="radio"]')]
    .find(element => element.getAttribute('aria-checked') === 'true')?.textContent?.trim()
  return {
    language: document.documentElement.lang,
    portuguese: body.includes('Nova tarefa') && body.includes('Projetos'),
    projects: false,
    logo: rect ? { width: rect.width, height: rect.height } : null,
    selectedMode,
  }
})()`)
evidence.projects = panelText.includes('Projetos')
if (evidence.language !== 'pt-BR' || !evidence.portuguese || !evidence.projects || evidence.logo === null
  || (desiredMode !== undefined && evidence.selectedMode !== desiredMode)) {
  throw new Error(`Toranja visual evidence incomplete: ${JSON.stringify(evidence)}`)
}

const screenshot = await command('Page.captureScreenshot', {
  format: 'png',
  captureBeyondViewport: false,
})
await writeFile(output, Buffer.from(screenshot.data, 'base64'))
socket.close()
console.log(JSON.stringify({ output, panelText, evidence }))
