import { writeFile } from 'node:fs/promises'

const output = process.argv[2]
if (!output) throw new Error('usage: node scripts/capture-toranja-cdp.mjs <output.png>')

const pages = await fetch('http://127.0.0.1:9333/json').then((response) => response.json())
const page = pages.find((candidate) => candidate.type === 'page' && candidate.webSocketDebuggerUrl)
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

const screenshot = await command('Page.captureScreenshot', {
  format: 'png',
  captureBeyondViewport: false,
})
await writeFile(output, Buffer.from(screenshot.data, 'base64'))
socket.close()
console.log(output)
