/**
 * ถ่ายภาพหน้า "แม่แบบ & การแชร์" เพื่อตรวจปุ่มดาวน์โหลด / อัปโหลดแทน
 *
 *   node --env-file=../dokploy-infra/.env --env-file=../dokploy-infra/.env.development tools/shot-template-file.mjs
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Redis } from 'ioredis'

const CHROME = process.env.CHROME_PATH ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const PORT = 9368
const WEB = 'http://localhost:3000'
const API = 'http://127.0.0.1:4001'
const OUT = new URL('../tests/nav-status/output-template-file/', import.meta.url)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
mkdirSync(OUT, { recursive: true })

const redis = new Redis(process.env.VALKEY_URL)
const sid = `shot-tpl-${Date.now()}`
await redis.set(
  `session:${sid}`,
  JSON.stringify({ sub: sid, name: 'ถ่ายภาพ', email: 'shot@test.local', avatar: '' }),
  'EX',
  900,
)
const H = { cookie: `docgen_session=${sid}` }
const key = String(
  (await (await fetch(`${API}/api/templates`, { headers: H })).json()).items.find((t) =>
    (t.name ?? '').includes('หัวกระดาษ'),
  )?.id ?? '',
)
console.log('แม่แบบ:', key)

const profile = mkdtempSync(join(tmpdir(), 'cdp-shot-'))
const chrome = spawn(
  CHROME,
  ['--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run', '--window-size=1600,1000',
   `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, 'about:blank'],
  { stdio: 'ignore' },
)
let wsUrl = null
for (let i = 0; i < 40 && !wsUrl; i++) {
  await sleep(500)
  try {
    wsUrl = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find((x) => x.type === 'page')
      ?.webSocketDebuggerUrl
  } catch { /* ยังไม่พร้อม */ }
}
const ws = new WebSocket(wsUrl)
let seq = 0
const waiting = new Map()
const send = (method, params = {}) =>
  new Promise((res, rej) => {
    const id = ++seq
    waiting.set(id, { res, rej })
    ws.send(JSON.stringify({ id, method, params }))
  })
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data)
  const s = waiting.get(m.id)
  if (!s) return
  waiting.delete(m.id)
  m.error ? s.rej(new Error(JSON.stringify(m.error))) : s.res(m.result)
})
await new Promise((r) => ws.addEventListener('open', r, { once: true }))

const evaluate = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text ?? 'ล้ม')
  return r.result?.value
}
const waitFor = async (expr, ms = 45000) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    try { if (await evaluate(expr)) return true } catch { /* nav */ }
    await sleep(200)
  }
  return false
}
const shot = async (n) => {
  const { data } = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(new URL(n, OUT), Buffer.from(data, 'base64'))
}

await send('Page.enable')
await send('Runtime.enable')
await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false })
await send('Network.setCookie', { name: 'docgen_session', value: sid, url: WEB })
await send('Network.setCacheDisabled', { cacheDisabled: true })

await send('Page.navigate', { url: `${WEB}/studio/${key}?tabs=form&pane=template` })
await waitFor("!!document.querySelector('[data-testid=\"template-download\"]')")
await sleep(900)

console.log('ข้อความเดิม "เก็บที่ Carbone" ยังอยู่ไหม:', await evaluate(
  "document.body.textContent.includes('เก็บที่ Carbone')",
))
console.log('มีปุ่มดาวน์โหลด:', await evaluate("!!document.querySelector('[data-testid=\"template-download\"]')"))
console.log('มีปุ่มอัปโหลดแทน:', await evaluate("!!document.querySelector('[data-testid=\"template-replace\"]')"))
console.log('ลิงก์ดาวน์โหลดชี้ไปที่:', await evaluate(
  "document.querySelector('[data-testid=\"template-download\"]')?.getAttribute('href')",
))
await shot('01-buttons.png')

// เลื่อนให้เห็นส่วนไฟล์แม่แบบ
await evaluate("document.querySelector('[data-testid=\"template-replace\"]')?.scrollIntoView({block:'center'})")
await sleep(500)
await shot('02-file-section.png')

await send('Browser.close').catch(() => {})
chrome.kill()
await redis.del(`session:${sid}`)
redis.disconnect()
console.log('ภาพ:', OUT.pathname)
