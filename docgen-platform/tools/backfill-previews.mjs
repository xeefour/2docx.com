/**
 * สร้างรูปตัวอย่างให้แม่แบบที่มีอยู่แล้ว (backfill)
 *
 *   node --env-file=.env tools/backfill-previews.mjs
 *
 * เดินทางเหมือนผู้ใช้จริงทุกขั้น: เปิดหน้าแก้ไข → กดแท็บ "ข้อมูลแม่แบบ"
 * → กด "สร้างตัวอย่างอัตโนมัติ" → รอรูปจริงปรากฏ
 *
 * ⚠️ **แม่แบบที่มีเจ้าของอยู่แล้ว จะข้าม** เพราะกติกาคือเจ้าของเท่านั้นที่เพิ่มรูปได้
 *   (ฟังก์ชันนี้ใช้ session ชั่วคราว จึงทำแทนเจ้าของไม่ได้ — และไม่ควรทำ)
 *   รายการที่ข้ามจะถูก**รายงานออกมา** ไม่ใช่เงียบ ๆ
 *
 * ⚠️ เก็บกวาด: ไม่ลบแม่แบบใด ๆ (งานนี้เพิ่มแค่รูปตัวอย่าง)
 *   ตรวจเอกสารชั่วคราวที่ค้างในประวัติและลบทิ้ง
 */
import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Redis } from 'ioredis'

const API = process.env.API_URL ?? 'http://127.0.0.1:4001'
const WEB = 'http://localhost:3000'
const CHROME = process.env.CHROME_PATH ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const PORT = 9394
const STAMP = Date.now()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const redis = new Redis(process.env.VALKEY_URL)
const SID = `backfill-${STAMP}`
await redis.set(
  `session:${SID}`,
  JSON.stringify({ sub: SID, name: 'ระบบสร้างตัวอย่าง', email: 'bf@test.local', avatar: '' }),
  'EX',
    3600,
)
const H = { cookie: `docgen_session=${SID}` }
const PREVIEW_LABEL = 'ตัวอย่างแม่แบบ:'

const templates = (await (await fetch(`${API}/api/templates`, { headers: H })).json()).items ?? []
console.log(`พบแม่แบบ ${templates.length} ตัว\n`)

const profile = mkdtempSync(join(tmpdir(), 'cdp-backfill-'))
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
const send = (m, p = {}) =>
  new Promise((resolve, reject) => {
    const id = ++seq
    waiting.set(id, { resolve, reject })
    ws.send(JSON.stringify({ id, method: m, params: p }))
    setTimeout(() => {
      if (waiting.has(id)) { waiting.delete(id); reject(new Error(`timeout: ${m}`)) }
    }, 40000)
  })
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data)
  const s = waiting.get(m.id)
  if (!s) return
  waiting.delete(m.id)
  m.error ? s.reject(new Error(JSON.stringify(m.error))) : s.resolve(m.result)
})
await new Promise((r) => ws.addEventListener('open', r, { once: true }))
const evaluate = async (e) => {
  const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true })
  if (r.exceptionDetails) return null
  return r.result?.value
}
const waitFor = async (e, ms = 30000) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    try { if (await evaluate(e)) return true } catch {}
    await sleep(400)
  }
  return false
}
const click = async (expr) => {
  const box = await evaluate(`(() => { const el = ${expr}; if (!el) return { miss: 1 }
    el.scrollIntoView({ block: 'center' })
    const r = el.getBoundingClientRect(); const x = r.x + r.width / 2, y = r.y + r.height / 2
    const hit = document.elementFromPoint(x, y)
    return { ok: !!hit && (el.contains(hit) || hit === el), x, y, disabled: el.disabled } })()`)
  if (!box?.ok || box.disabled) return box
  for (const t of ['mousePressed', 'mouseReleased'])
    await send('Input.dispatchMouseEvent', { type: t, x: box.x, y: box.y, button: 'left', clickCount: 1 })
  return box
}

await send('Page.enable')
await send('Runtime.enable')
await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false })
await send('Network.setCookie', { name: 'docgen_session', value: SID, url: WEB })

let made = 0
let skipped = 0
let failed = 0
const report = []

for (const [n, t] of templates.entries()) {
  const key = String(t.id ?? t.versionId)
  const name = t.name
  const have = (await (await fetch(`${API}/api/templates/${encodeURIComponent(key)}/previews`, { headers: H })).json()).items ?? []
  if (have.length) {
    console.log(`[${n + 1}/${templates.length}] ข้าม — มีตัวอย่างแล้ว: ${name}`)
    continue
  }

  await send('Page.navigate', { url: `${WEB}/studio/${key}?tabs=form&pane=template&_=${STAMP}-${n}` })
  if (!(await waitFor('!document.querySelector(".bootveil")', 45000))) {
    console.log(`[${n + 1}/${templates.length}] ✗ โหลดหน้าไม่ได้: ${name}`)
    report.push(`โหลดหน้าไม่ได้ — ${name}`)
    failed++
    continue
  }
  // กดแท็บ "ข้อมูลแม่แบบ" เอง (ไม่พึ่ง ?pane= ซึ่งไม่เสถียรข้ามผู้ใช้)
  await waitFor(`[...document.querySelectorAll('.tabs__tab')].some(t => (t.textContent||'').includes('ข้อมูลแม่แบบ'))`, 20000)
  await click(`[...document.querySelectorAll('.tabs__tab')].find(t => (t.textContent||'').includes('ข้อมูลแม่แบบ'))`)
  const hasBtn = await waitFor(`!!document.querySelector('[data-testid="preview-generate"]')`, 10000)

  if (!hasBtn) {
    console.log(`[${n + 1}/${templates.length}] — ข้าม (ไม่มีสิทธิ์เจ้าของ): ${name}`)
    report.push(`ข้าม — มีเจ้าของอยู่แล้ว ต้องให้เจ้าของกดเอง: ${name}`)
    skipped++
    continue
  }

  const c = await click(`document.querySelector('[data-testid="preview-generate"]')`)
  if (!c?.ok) {
    console.log(`[${n + 1}/${templates.length}] ✗ กดปุ่มไม่ได้: ${name}`)
    report.push(`กดปุ่มไม่ได้ — ${name}`)
    failed++
    continue
  }

  const ok = await waitFor(
    `!!document.querySelector('[data-testid="preview-grid"] img')`,
    150000,
  )
  const err = await evaluate(`document.querySelector('.pill.err')?.textContent || ''`)
  if (ok) {
    made++
    console.log(`[${n + 1}/${templates.length}] ✓ สร้างตัวอย่างแล้ว: ${name}`)
  } else {
    failed++
    console.log(`[${n + 1}/${templates.length}] ✗ ไม่สำเร็จ: ${name}${err ? ` — ${err}` : ''}`)
    report.push(`สร้างไม่สำเร็จ${err ? ` (${err})` : ''} — ${name}`)
  }
}

console.log(`\nสร้างใหม่ ${made} · ข้ามเพราะไม่ใช่เจ้าของ ${skipped} · ล้มเหลว ${failed}`)
if (report.length) {
  console.log('\nรายการที่ต้องให้เจ้าของทำเอง:')
  for (const r of report) console.log('  · ' + r)
}

// ตรวจว่าไม่มีเอกสารชั่วคราวค้างในประวัติ
const docs = (await (await fetch(`${API}/api/documents?limit=100`, { headers: H })).json()).items ?? []
const junk = docs.filter((d) => String(d.label ?? '').startsWith(PREVIEW_LABEL))
console.log(`\nเอกสารตัวอย่างที่ค้างในประวัติ: ${junk.length} รายการ`)
if (junk.length) {
  for (const d of junk) {
    await fetch(`${API}/api/documents/${d._id}`, { method: 'DELETE', headers: H })
    console.log('  · ลบ ' + d._id + ' (' + d.label + ')')
  }
  const after = (await (await fetch(`${API}/api/documents?limit=100`, { headers: H })).json()).items ?? []
  console.log(`  เหลือ: ${after.filter((d) => String(d.label ?? '').startsWith(PREVIEW_LABEL)).length} รายการ`)
}

await redis.del(`session:${SID}`)
redis.disconnect()
await send('Browser.close').catch(() => {})
chrome.kill()
ws.close()
process.exit(0)
