const target = process.argv[2]
if (!target) throw new Error('usage: node scripts/select-primary-model-cdp.mjs <model title>')

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
const deadline = Date.now() + 30_000

await evaluate(`(() => {
  if (!document.querySelector('[data-toranja-control-panel]')) return
  document.querySelector('[data-toranja-control] button')?.click()
})()`)

let opened = false
while (Date.now() < deadline) {
  opened = await evaluate(`(() => {
    const visible = element => element instanceof HTMLElement && element.offsetParent !== null
    const trigger = [...document.querySelectorAll('button[aria-haspopup="menu"]')]
      .filter(visible)
      .find(button => button.closest('[data-composer-card]') && /modelo|agente|GPT|Antigravity/i.test(button.textContent ?? ''))
    if (!trigger) return false
    trigger.click()
    return true
  })()`)
  if (opened) break
  await new Promise(resolve => setTimeout(resolve, 300))
}
if (!opened) throw new Error('Primary model trigger not found')

let selected = false
while (Date.now() < deadline) {
  selected = await evaluate(`(() => {
    const target = [...document.querySelectorAll('button[role="menuitemradio"]')]
      .find(button => button.getAttribute('title') === ${JSON.stringify(target)})
    if (target) {
      target.click()
      return true
    }
    const modelCell = [...document.querySelectorAll('button[role="menuitem"]')]
      .find(button => /modelo/i.test(button.textContent ?? ''))
    modelCell?.click()
    return false
  })()`)
  if (selected) break
  await new Promise(resolve => setTimeout(resolve, 300))
}
if (!selected) throw new Error(`Primary model option not found: ${target}`)

let current = ''
while (Date.now() < deadline) {
  current = await evaluate(`(() => {
    const trigger = [...document.querySelectorAll('button[aria-haspopup="menu"]')]
      .find(button => button.closest('[data-composer-card]') && button.offsetParent !== null)
    return trigger?.textContent?.trim() ?? ''
  })()`)
  if (current.includes(target.split(' — ')[0])) break
  await new Promise(resolve => setTimeout(resolve, 300))
}
socket.close()
if (!current.includes(target.split(' — ')[0])) throw new Error(`Selection did not settle: ${current}`)
console.log(JSON.stringify({ selected: target, trigger: current }))
