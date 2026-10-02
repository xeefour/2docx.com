/**
 * วัดสีจริงของเมนูหน่วยไม้บรรทัดตอนเอาเมาส์ไปวาง (hover)
 *
 *   node --env-file=.env tools/inspect-menu-hover.mjs
 *
 * ── ทำไมต้องมีเครื่องมือนี้ ───────────────────────────────────────
 * ผู้ใช้รายงานว่า *"mouse over เป็นสีม่วง มองไม่เห็นตัวอักษร"*
 *
 * ที่เห็นในโค้ดทุกอย่างถูกต้องอยู่แล้ว:
 *   .rulpick__opt:hover { background: var(--brand-soft); color: var(--brand-dark) }
 *   .rulpick__opt[aria-checked='true'] { background: var(--brand-soft); ... }
 *
 * แต่ `globals.css` มีกฎของทั้งระบบ:
 *   button:hover:not(:disabled) { background: var(--brand-dark) }
 *
 * ความสำคัญ (specificity) ของสองอย่างนี้**ไม่เท่ากัน**:
 *   button:hover:not(:disabled) → (0,2,1)   ชนะ
 *   .rulpick__opt:hover         → (0,2,0)   แพ้
 *   (`:not()` ไม่เพิ่มความสำคัญเอง แต่ค่าในวงเล็บคือ `:disabled` = (0,1,0))
 *
 * ผลคือตอน hover พื้นหลังกลายเป็นม่วงทึบจากกฎของทั้งระบบ
 * แต่สีตัวอักษรยังเป็นม่วงเข้มจากกฎของเมนู → **ม่วงบนม่วง = มองไม่เห็น**
 *
 * เครื่องมือนี้ยิงเมาส์จริง (Input.dispatchMouseEvent) แล้วอ่าน
 * `getComputedStyle` จริง เพื่อพิสูจน์ว่าสองสีชนกันจริง — ไม่เดาจากกฎในไฟล์
 */
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Redis } from 'ioredis'
import { canvasDrawnJs } from './lib/canvas-drawn.mjs'
import { keyOf, pickTemplate, TEST_TEMPLATES } from './lib/pick-template.mjs'
import { FILL_FIELDS_JS, importTags, restoreForm, snapshotForm } from './lib/studio-seed.mjs'

const CHROME = process.env.CHROME_PATH ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const PORT = 9376
const WEB = 'http://localhost:3000'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
mkdirSync(join(process.cwd(), 'logs'), { recursive: true })

const redis = new Redis(process.env.VALKEY_URL)
const sid = `menuhov-${Date.now()}`
await redis.set(
  `session:${sid}`,
  JSON.stringify({ sub: sid, name: 'วัดสีเมนู', email: 'menuhov@test.local', avatar: '' }),
  'EX',
  1800,
)
const H = { cookie: `docgen_session=${sid}`, 'content-type': 'application/json' }

const picked = await pickTemplate(H, [TEST_TEMPLATES.multipage, 'สำเนา 1', 'อำเภอเนินมะปราง'])
const key = keyOf(picked)
console.log(`แม่แบบ: ${picked.name} (key ${key})`)

const formSnap = await snapshotForm(H, key)
const seed = await importTags(H, picked)
console.log(`เตรียมช่องกรอก — ${seed.ok ? 'สำเร็จ' : 'ล้มเหลว ' + seed.status}`)

const profile = mkdtempSync(join(tmpdir(), 'cdp-menuhov-'))
const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--no-first-run',
    '--window-size=1600,1000',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    'about:blank',
  ],
  { stdio: 'ignore' },
)
let wsUrl = null
for (let i = 0; i < 40 && !wsUrl; i++) {
  await sleep(500)
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
    wsUrl = list.find((x) => x.type === 'page')?.webSocketDebuggerUrl
  } catch {}
}
const ws = new WebSocket(wsUrl)
let seq = 0
const waiting = new Map()
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++seq
    waiting.set(id, { resolve, reject })
    ws.send(JSON.stringify({ id, method, params }))
  })
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data)
  const s = waiting.get(m.id)
  if (!s) return
  waiting.delete(m.id)
  m.error ? s.reject(new Error(JSON.stringify(m.error))) : s.resolve(m.result)
})
await new Promise((r) => ws.addEventListener('open', r, { once: true }))
const evaluate = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text)
  return r.result?.value
}
const waitFor = async (expr, ms = 60000) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    try {
      if (await evaluate(expr)) return true
    } catch {}
    await sleep(300)
  }
  return false
}
const shot = async (name) => {
  const { data } = await send('Page.captureScreenshot', { format: 'png' })
  const file = join(process.cwd(), 'logs', `menuhov-${name}.png`)
  writeFileSync(file, Buffer.from(data, 'base64'))
  console.log('  ภาพ:', file)
}

await send('Page.enable')
await send('Runtime.enable')
await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false })
await send('Network.setCookie', { name: 'docgen_session', value: sid, url: WEB })
await send('Network.setCacheDisabled', { cacheDisabled: true })
await send('Page.navigate', { url: `${WEB}/studio/${key}?tabs=form&pane=preview` })
await waitFor("!!document.querySelector('.dl__btn')", 45000)
await sleep(600)
/**
 * ⚠️ ต้อง**กรอกฟอร์มให้ครบ**ก่อนกดเรนเดอร์ — แอปบล็อกเมื่อช่องบังคับยังว่าง
 *    แม่แบบ `ทดสอบหัวกระดาษ` มีช่องบังคับ "เรื่อง" ค้างอยู่ 1 ช่อง
 *    ถ้าไม่กรอก จะไม่มี canvas ให้วัด แล้วเทสต์ตกตั้งแต่ข้อแรก
 */
const filled = await evaluate(FILL_FIELDS_JS)
console.log(`  กรอกข้อมูล ${filled} ช่อง`)
await sleep(400)
const btn = await evaluate(`(() => {
  const el = [...document.querySelectorAll('button')].find((b) => b.textContent.includes('เรนเดอร์ตัวอย่าง'))
  if (!el) return null
  const r = el.getBoundingClientRect()
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
})()`)
if (btn) {
  for (const type of ['mousePressed', 'mouseReleased'])
    await send('Input.dispatchMouseEvent', { type, x: btn.x, y: btn.y, button: 'left', clickCount: 1 })
}
const rendered = await waitFor(
  /**
   * ⚠️ เช็คจากพิกเซลจริงที่ pdf.js ตั้ง ไม่ใช่ความกว้างที่เห็น
   *    `<canvas>` ที่ยังไม่เคยวาดมีค่าเริ่มต้น 300×150
   *    และกระดาษตอนนี้ถูกย่อให้พอดีกล่อง → `width > 400` ผ่านไม่ได้แม้วาดเสร็จแล้ว
   *    (เคยทำให้สคริปต์นี้ตกทั้งชุด) เกณฑ์จริงอยู่ที่ `tools/lib/canvas-drawn.mjs`
   */
  canvasDrawnJs(),
  120000,
)
if (!rendered) console.log('  ✗ เรนเดอร์ไม่สำเร็จ (มักเป็นคิว NATS ค้าง)')

// ── เปิดเมนูหน่วย ────────────────────────────────────────────────
const toggle = await evaluate(`(() => {
  const b = document.querySelector('[data-testid="ruler-toggle"]')
  if (!b) return null
  b.scrollIntoView({ block: 'nearest' })
  const r = b.getBoundingClientRect()
  const x = r.x + r.width / 2, y = r.y + r.height / 2
  const hit = document.elementFromPoint(x, y)
  return { ok: !!hit && (b.contains(hit) || hit === b), x, y }
})()`)
if (toggle?.ok) {
  for (const type of ['mousePressed', 'mouseReleased'])
    await send('Input.dispatchMouseEvent', { type, x: toggle.x, y: toggle.y, button: 'left', clickCount: 1 })
}
await waitFor("!!document.querySelector('.rulpick')", 5000)
await sleep(500)

/**
 * ⚠️ ตัวเลือก "ซ่อนไม้บรรทัด" โผล่**เฉพาะตอนที่ไม้บรรทัดเปิดอยู่**
 *   (ดูเงื่อนไข `ruler &&` ใน JSX) ถ้าไม่เปิดไม้บรรทัดก่อน
 *   จะได้แค่ 2 ราย แล้วพลาดบั๊กของ `.rulpick__opt--off` ไปเงียบ ๆ
 *   → ต้องเลือกหน่วยก่อน 1 ครั้งเพื่อเปิดไม้บรรทัด แล้วค่อยเปิดเมนูใหม่
 */
const cmOpt = await evaluate(`(() => {
  const b = document.querySelector('[data-testid="ruler-unit-cm"]')
  if (!b) return null
  const r = b.getBoundingClientRect()
  const x = r.x + r.width / 2, y = r.y + r.height / 2
  const hit = document.elementFromPoint(x, y)
  return { ok: !!hit && (b.contains(hit) || hit === b), x, y }
})()`)
if (cmOpt?.ok) {
  for (const type of ['mousePressed', 'mouseReleased'])
    await send('Input.dispatchMouseEvent', { type, x: cmOpt.x, y: cmOpt.y, button: 'left', clickCount: 1 })
  await sleep(600)
  // เปิดเมนูอีกครั้ง — คราวนี้ต้องมีตัวเลือก "ซ่อนไม้บรรทัด" ด้วย
  const t2 = await evaluate(`(() => {
    const b = document.querySelector('[data-testid="ruler-toggle"]')
    if (!b) return null
    b.scrollIntoView({ block: 'nearest' })
    const r = b.getBoundingClientRect()
    const x = r.x + r.width / 2, y = r.y + r.height / 2
    const hit = document.elementFromPoint(x, y)
    return { ok: !!hit && (b.contains(hit) || hit === b), x, y }
  })()`)
  if (t2?.ok) {
    for (const type of ['mousePressed', 'mouseReleased'])
      await send('Input.dispatchMouseEvent', { type, x: t2.x, y: t2.y, button: 'left', clickCount: 1 })
  }
  await waitFor("!!document.querySelector('.rulpick')", 5000)
  await sleep(500)
  const n = await evaluate("document.querySelectorAll('.rulpick__opt').length")
  console.log(`  ตัวเลือกในเมนูหลังเปิดไม้บรรทัด: ${n} ราย (ต้องเป็น 3)`)
}

/** อ่านสีที่คำนวณแล้วของทุกตัวเลือก + เทียบว่าตัวอักษรกับพื้นชนกันไหม */
const readColors = () =>
  evaluate(`(() => {
  const parse = (s) => (s.match(/[\\d.]+/g) || []).slice(0, 3).map(Number)
  const opts = [...document.querySelectorAll('.rulpick__opt')]
  return opts.map((o) => {
    const cs = getComputedStyle(o)
    const fg = parse(cs.color)
    const bg = parse(cs.backgroundColor)
    /** ต่างกันน้อยกว่า 30 ในช่องสี → ตาแยกไม่ออก = อ่านไม่ออก */
    const dist = Math.max(...fg.map((v, i) => Math.abs(v - bg[i])))
    return {
      id: o.dataset.testid || o.className,
      label: o.textContent.trim().slice(0, 18),
      fg: cs.color,
      bg: cs.backgroundColor,
      dist,
      unreadable: dist < 30,
    }
  })
})()`)

const before = await readColors()
/**
 * ยิงเมาส์จริงไปวางบนแต่ละตัวเลือกทีละอัน
 * ⚠️ ต้องใช้ `Input.dispatchMouseEvent` ชนิด `mouseMoved` เท่านั้น
 *    การสั่ง `el.matches(':hover')` หรือเติม class เองไม่ทำให้ CSS `:hover` ทำงาน
 */
const centers = await evaluate(`(() =>
  [...document.querySelectorAll('.rulpick__opt')].map((o) => {
    const r = o.getBoundingClientRect()
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
  }))()`)

console.log('\n=== ก่อน hover ===')
for (const o of before) console.log(`  ${o.id.padEnd(22)} ตัวอักษร ${o.fg.padEnd(20)} พื้น ${o.bg.padEnd(20)} ต่าง ${o.dist}`)

const hovered = []
for (let i = 0; i < centers.length; i++) {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: centers[i].x, y: centers[i].y })
  await sleep(250)
  const now = await readColors()
  const cur = now[i]
  hovered.push(cur)
  console.log(
    `  hover "${cur.label}" → ตัวอักษร ${cur.fg.padEnd(20)} พื้น ${cur.bg.padEnd(20)} ต่าง ${cur.dist}${cur.unreadable ? '  ✗ อ่านไม่ออก' : ''}`,
  )
  if (i === 0) await shot('hover-1')
  if (i === 1) await shot('hover-2')
}

const bad = hovered.filter((h) => h.unreadable)
console.log('\nสรุป')
if (bad.length === 0) {
  console.log('  ✓ ทุกตัวเลือกอ่านออกตอน hover')
} else {
  console.log(`  ✗ อ่านไม่ออก ${bad.length}/${hovered.length} ราย:`)
  for (const b of bad) console.log(`      "${b.label}" ตัวอักษร ${b.fg} บนพื้น ${b.bg} (ต่างกัน ${b.dist})`)
}

await send('Browser.close').catch(() => {})
chrome.kill()
await restoreForm(H, key, formSnap)
await redis.del(`session:${sid}`)
redis.disconnect()
process.exit(0)
