/**
 * สืบหาข้อผิดพลาดของปุ่ม "สร้างตัวอย่างอัตโนมัติ" แบบเจาะจง
 *
 *   node --env-file=../dokploy-infra/.env --env-file=../dokploy-infra/.env.development tools/probe-preview-gen.mjs
 *
 * เปิดหน้าแก้ไข → กดสร้างตัวอย่าง → พิมพ์ข้อความ error ที่การ์ดแสดง
 * พร้อม console ของหน้าเว็บ (React จะโยน error ลง console เวลา render พัง)
 *
 * ⚠️ เก็บกวาดแม่แบบชั่วคราว + เอกสารที่อาจค้าง
 */
import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Redis } from 'ioredis'
import { resolveMongoUrl } from '@docgen/shared'
import { MongoClient } from 'mongodb'

const API = process.env.API_URL ?? 'http://127.0.0.1:4001'
const WEB = 'http://localhost:3000'
const CHROME = process.env.CHROME_PATH ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const PORT = 9395
const STAMP = Date.now()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const redis = new Redis(process.env.VALKEY_URL)
const SID = `probe-${STAMP}`
await redis.set(
  `session:${SID}`,
  JSON.stringify({ sub: SID, name: 'probe', email: 'p@t.local', avatar: '' }),
  'EX',
  900,
)
const h = { cookie: `docgen_session=${SID}` }
const PREFIX = 'ทดสอบprobeตัวอย่าง-'
const TMP = `${PREFIX}${STAMP}`

const listT = async () => (await (await fetch(`${API}/api/templates`, { headers: h })).json()).items ?? []
const wipe = async (k) => {
  const c = new MongoClient(await resolveMongoUrl(() => {}))
  await c.connect()
  const db = c.db(process.env.MONGO_DB ?? 'app')
  await db.collection('template_access').deleteOne({ _id: k })
  await db.collection('template_previews').deleteMany({ templateKey: k })
  await c.close()
}

for (const t of (await listT()).filter((x) => (x.name ?? '').startsWith(PREFIX))) {
  await fetch(`${API}/api/templates/${t.id}/purge`, { method: 'DELETE', headers: h })
  await wipe(String(t.id))
}
const donor = (await listT()).find((t) => (t.name ?? '').includes('หัวกระดาษ')) ?? (await listT())[0]
const bytes = new Uint8Array(await (await fetch(`${API}/api/templates/${donor.id}`, { headers: h })).arrayBuffer())
const fd = new FormData()
fd.set('versioning', 'true')
fd.set('name', TMP)
fd.set('template', new Blob([bytes], { type: 'application/octet-stream' }), 'ต้นฉบับ.docx')
const cr = await (await fetch(`${API}/api/templates`, { method: 'POST', headers: h, body: fd })).json()
const key = String(cr?.id ?? cr?.templateId ?? '')
console.log('key =', key)

const profile = mkdtempSync(join(tmpdir(), 'cdp-probe-'))
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
    const l = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
    wsUrl = l.find((x) => x.type === 'page')?.webSocketDebuggerUrl
  } catch {}
}
const ws = new WebSocket(wsUrl)
let seq = 0
const waiting = new Map()
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data)
  if (m.method === 'Network.responseReceived') {
    const u = m.params.response.url || ''
    if (/\/api\/(documents|templates\/)/.test(u) && (m.params.response.status >= 400 || /previews/.test(u))) {
      console.log('  [net!]', m.params.response.status, u.replace('http://localhost:3000', ''))
    }
  }
  if (m.method === 'Network.requestWillBeSent') {
    const u = m.params.request.url || ''
    if (/previews|\/api\/documents$/.test(u)) {
      console.log('  [net>]', m.params.request.method, u.replace('http://localhost:3000', ''))
    }
  }
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
    console.log('  [console.error]', (m.params.args ?? []).map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 300))
  }
  if (m.method === 'Runtime.exceptionThrown') {
    console.log('  [exception]', (m.params.exceptionDetails?.exception?.description ?? '').slice(0, 400))
  }
  const s = waiting.get(m.id)
  if (!s) return
  waiting.delete(m.id)
  m.error ? s.reject(new Error(JSON.stringify(m.error))) : s.resolve(m.result)
})
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++seq
    waiting.set(id, { resolve, reject })
    ws.send(JSON.stringify({ id, method, params }))
    setTimeout(() => {
      if (waiting.has(id)) { waiting.delete(id); reject(new Error(`timeout: ${method}`)) }
    }, 30000)
  })
await new Promise((r) => ws.addEventListener('open', r, { once: true }))
const evaluate = async (e) => {
  const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true })
  if (r.exceptionDetails) return { __throw: r.exceptionDetails.text }
  return r.result?.value
}
const waitFor = async (e, ms = 30000) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await evaluate(e)) return true
    await sleep(400)
  }
  return false
}

await send('Page.enable')
await send('Runtime.enable')
await send('Network.enable')
await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false })
await send('Network.setCookie', { name: 'docgen_session', value: SID, url: WEB })
await send('Page.navigate', { url: `${WEB}/studio/${key}?tabs=form&pane=template` })
await waitFor('!document.querySelector(".bootveil")', 45000)
console.log('เปิดหน้าแก้ไข:', !!(await waitFor(`!!document.querySelector('[data-testid="preview-generate"]')`, 20000)))
const ready = await waitFor(
  `(() => { const b = document.querySelector('[data-testid="preview-generate"]'); return !!b && !b.disabled })()`,
  20000,
)
console.log('ปุ่มพร้อมกด (ไม่ disabled):', ready)
await sleep(600)

const btn = await evaluate(`(() => {
  const el = document.querySelector('[data-testid="preview-generate"]')
  el.scrollIntoView({ block: 'center' })
  const r = el.getBoundingClientRect()
  const x = r.x + r.width / 2, y = r.y + r.height / 2
  const hit = document.elementFromPoint(x, y)
  return { ok: !!hit && (el.contains(hit) || hit === el), x, y, disabled: el.disabled }
})()`)
console.log('ปุ่มกดได้:', JSON.stringify(btn))
if (btn?.ok) {
  for (const type of ['mousePressed', 'mouseReleased'])
    await send('Input.dispatchMouseEvent', { type, x: btn.x, y: btn.y, button: 'left', clickCount: 1 })
}

console.log('รอผล 90 วินาที…')
for (let i = 0; i < 30; i++) {
  await sleep(3000)
  const st = await evaluate(`(() => ({
    grid: !!document.querySelector('[data-testid="preview-grid"] img'),
    err: document.querySelector('.pill.err')?.textContent || '',
    busyLabel: document.querySelector('[data-testid="preview-generate"]')?.textContent || '',
  }))()`)
  if (st?.grid) { console.log('ได้รูปแล้วที่', (i + 1) * 3, 'วินาที'); break }
  if (st?.err) { console.log('เจอ error ที่', (i + 1) * 3, 'วินาที:', st.err); break }
  if (i % 3 === 2) console.log(`  ${(i + 1) * 3}s ปุ่ม="${st?.busyLabel}"`)
}

const final = await evaluate(`(() => ({
  grid: document.querySelectorAll('[data-testid="preview-grid"] img').length,
  err: document.querySelector('.pill.err')?.textContent || '',
}))()`)
console.log('ผลสุดท้าย:', JSON.stringify(final))

const pv = await (await fetch(`${API}/api/templates/${encodeURIComponent(key)}/previews`, { headers: h })).json()
console.log('บน API:', (pv.items ?? []).length, 'รูป')

console.log('\n[เก็บกวาด]')
for (const t of (await listT()).filter((x) => (x.name ?? '').startsWith(PREFIX))) {
  await fetch(`${API}/api/templates/${t.id}/purge`, { method: 'DELETE', headers: h })
  await wipe(String(t.id))
}
await redis.del(`session:${SID}`)
redis.disconnect()
await send('Browser.close').catch(() => {})
chrome.kill()
ws.close()
process.exit(0)
