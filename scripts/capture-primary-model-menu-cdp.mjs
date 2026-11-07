import { writeFile } from 'node:fs/promises'

const output = process.argv[2]
if (!output) throw new Error('usage: node scripts/capture-primary-model-menu-cdp.mjs <output.png>')

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
  const current = ++id
  socket.send(JSON.stringify({ id: current, method, params }))
  return new Promise((resolve, reject) => pending.set(current, { resolve, reject }))
}
async function evaluate(expression) {
  const result = await command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text)
  return result.result.value
}

await command('Runtime.enable')
const opened = await evaluate(`(() => {
  const trigger = [...document.querySelectorAll('button[aria-haspopup="menu"]')]
    .find(button => button.closest('[data-composer-card]') && button.offsetParent !== null)
  trigger?.click()
  return Boolean(trigger)
})()`)
if (!opened) throw new Error('Primary model trigger not found')
const deadline = Date.now() + 15_000
let evidence = ''
while (Date.now() < deadline) {
  await evaluate(`(() => {
    const directModel = [...document.querySelectorAll('button[role="menuitemradio"]')]
      .some(button => button.getAttribute('title') === 'Antigravity — assinatura local')
    if (directModel) return
    const cell = [...document.querySelectorAll('button[role="menuitem"]')]
      .find(button => /modelo|agente/i.test(button.textContent ?? ''))
    cell?.click()
  })()`)
  evidence = await evaluate(`document.body.innerText`)
  if (evidence.includes('Antigravity local') && evidence.includes('Antigravity — assinatura local')) break
  await new Promise(resolve => setTimeout(resolve, 250))
}
if (!evidence.includes('Antigravity local') || !evidence.includes('Antigravity — assinatura local')) {
  throw new Error('Antigravity direct model was not visible in the model menu')
}
await evaluate(`(() => {
  const target = [...document.querySelectorAll('button[role="menuitemradio"]')]
    .find(button => button.getAttribute('title') === 'Antigravity — assinatura local')
  target?.scrollIntoView({ block: 'nearest' })
})()`)
await new Promise(resolve => setTimeout(resolve, 150))
const screenshot = await command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
await writeFile(output, Buffer.from(screenshot.data, 'base64'))
socket.close()
console.log(JSON.stringify({ output, antigravityVisible: true }))
