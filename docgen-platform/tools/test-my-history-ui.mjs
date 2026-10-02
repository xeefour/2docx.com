/**
 * ทดสอบแท็บ "ประวัติ" ฝั่งซ้าย — ค้นหาแล้วกดแก้ไขได้จริง
 *
 *   node --env-file=.env tools/test-my-history-ui.mjs
 *
 * ── สิ่งที่ต้องผ่าน ────────────────────────────────────────────
 * 1. แท็บซ้ายมี "ประวัติ" · แท็บขวาเป็น "การแชร์และสิทธิ์" (ไม่มีชื่อ "ประวัติ" ซ้ำ)
 * 2. กดแท็บซ้ายแล้วเห็นรายการประวัติของฉันเอง
 * 3. ค้นด้วย**ชื่อผู้รับ** (ค่าที่กรอก) แล้วเจอ
 * 4. กด "แก้ไข" → กลับไปแท็บฟอร์ม และค่าถูกกู้กลับมาครบ
 * 5. URL สะท้อนแท็บที่เลือก (?tabs=history / ?tabs=form)
 * 6. ลิงก์ตรง ?tabs=history เปิดแท็บซ้ายถูกตัว
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Redis } from 'ioredis'

const CHROME = process.env.CHROME_PATH ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const PORT = 9366
const WEB = 'http://localhost:3000'
const API = 'http://127.0.0.1:4001'
const OUT = new URL('../tests/nav-status/output-my-history/', import.meta.url)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
mkdirSync(OUT, { recursive: true })

let pass = 0
let fail = 0
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`)
  ok ? pass++ : fail++
}

const redis = new Redis(process.env.VALKEY_URL)
const sid = `myhistui-${Date.now()}`
await redis.set(
  `session:${sid}`,
  JSON.stringify({ sub: sid, name: 'ผู้ทดสอบประวัติ', email: 'myhist@test.local', avatar: '' }),
  'EX',
  1800,
)
const H = { cookie: `docgen_session=${sid}`, 'content-type': 'application/json' }

const templates = (await (await fetch(`${API}/api/templates`, { headers: H })).json()).items ?? []
const tpl = templates.find((t) => (t.name ?? '').includes('หัวกระดาษ')) ?? templates[0]
const key = String(tpl?.id ?? '')
console.log(`ใช้แม่แบบ: ${tpl?.name} (key ${key})`)

/**
 * ค่าที่มีเอกลักษณ์เฉพาะ ใช้ยืนยันว่าค่าถูกกู้กลับมาจริง ไม่ใช่ค่าค้างจากที่อื่น
 *
 * ⚠️ ต้องใช้ key ที่**มีช่องจริง** ในฟอร์มของแม่แบบนี้
 *    ค่าที่กู้มาแล้วไม่มีช่องรับ จะอยู่แค่ใน state (เห็นในแท็บ JSON เท่านั้น)
 *    ถ้าใช้ key แต่งเอง เทสต์จะตกทั้งที่ฟีเจอร์ทำงานถูก
 *
 * ⚠️ สคริปต์อื่นลบช่องกรอกทิ้งตอนเก็บกวาด
 *    ต้องสร้างช่องจาก**แท็กจริงของแม่แบบ**ก่อน แล้วลบทิ้งตอนจบ
 */
await fetch(`${API}/api/form/${key}/import-tags`, {
  method: 'POST',
  headers: H,
  body: JSON.stringify({ versionId: tpl.versionId }),
})

const form = await (await fetch(`${API}/api/form/${key}`, { headers: H })).json()
const field = (form.fields ?? []).find((f) => f.type === 'text' || f.type === 'textarea')
if (!field) {
  console.log('✗ สร้างช่องกรอกจากแท็กแล้วยังไม่มีช่องข้อความ — ทดสอบต่อไม่ได้')
  process.exit(1)
}
const stamp = `กู้ค่า-${Date.now()}`
const FIELD = field.key
const VALUE = `นาย${stamp}`
console.log(`ใช้ช่องจริง: ${FIELD} (${field.label})`)
const created = await (
  await fetch(`${API}/api/documents`, {
    method: 'POST',
    headers: H,
    body: JSON.stringify({
      templateId: tpl.versionId,
      data: { [FIELD]: VALUE },
      outputFormat: 'pdf',
      label: `ประวัติทดสอบ UI ${stamp}`,
    }),
  })
).json()
console.log(`สร้างเอกสารประวัติไว้ 1 ฉบับ: ${created._id}`)

const profile = mkdtempSync(join(tmpdir(), 'cdp-myhist-'))
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
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
    wsUrl = list.find((x) => x.type === 'page')?.webSocketDebuggerUrl
  } catch { /* ยังไม่พร้อม */ }
}
if (!wsUrl) {
  console.log('✗ ต่อ Chrome DevTools ไม่ได้')
  chrome.kill()
  process.exit(1)
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
  if (m.method === 'Runtime.exceptionThrown') {
    console.log('  [หน้าเว็บ error]', String(m.params.exceptionDetails?.exception?.description ?? '').slice(0, 300))
  }
  const s = waiting.get(m.id)
  if (!s) return
  waiting.delete(m.id)
  m.error ? s.reject(new Error(JSON.stringify(m.error))) : s.resolve(m.result)
})
await new Promise((r) => ws.addEventListener('open', r, { once: true }))

const evaluate = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text ?? 'evaluate ล้มเหลว')
  return r.result?.value
}
const waitFor = async (expr, timeoutMs = 20000) => {
  const end = Date.now() + timeoutMs
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
/** คลิกด้วยเมาส์จริง — ตรวจ elementFromPoint ด้วย ถ้ามีอย่างอื่นบังก็ไม่กด */
const realClick = async (expr) => {
  const box = await evaluate(`(() => {
    const el = ${expr}
    if (!el) return null
    el.scrollIntoView({ block: 'center' })
    const r = el.getBoundingClientRect()
    const x = r.x + r.width / 2, y = r.y + r.height / 2
    const hit = document.elementFromPoint(x, y)
    return { ok: !!hit && (el.contains(hit) || hit === el), x, y }
  })()`)
  if (!box?.ok) return false
  for (const type of ['mousePressed', 'mouseReleased'])
    await send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 })
  return true
}
/**
 * ⚠️ ฝั่งซ้ายต้องใช้ `:not(.editor-col--right)`
 *    คอลัมน์ขวามี class `editor-col` ด้วย → `.editor-col [role="tab"]`
 *    จะไปจับแท็บขวามาด้วย (เคยเจอ: ได้ป้าย 6 ตัวรวมสองฝั่งปนกัน)
 */
const LEFT_COL = '.editor-split > .editor-col:not(.editor-col--right)'
const RIGHT_COL = '.editor-col--right'
const LEFT_TABS_SEL = `${LEFT_COL} [role="tab"]`
const RIGHT_TABS_SEL = `${RIGHT_COL} [role="tab"]`
const clickLeftTab = (label) =>
  realClick(`[...document.querySelectorAll(${JSON.stringify(`${LEFT_COL} [role="tab"]`)})]
    .find((b) => b.textContent.trim() === ${JSON.stringify(label)})`)
const clickRightTab = (label) =>
  realClick(`[...document.querySelectorAll(${JSON.stringify(`${RIGHT_COL} [role="tab"]`)})]
    .find((b) => b.textContent.trim() === ${JSON.stringify(label)})`)
const setSearch = (text) =>
  evaluate(`(() => {
    const el = document.querySelector('[data-testid="myhistory-search"]')
    if (!el) return false
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    setter.call(el, ${JSON.stringify(text)})
    el.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })()`)

await send('Page.enable')
await send('Runtime.enable')
await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false })
await send('Network.setCookie', { name: 'docgen_session', value: sid, url: WEB })
await send('Network.setCacheDisabled', { cacheDisabled: true })

// ── 1. ชื่อแท็บ ───────────────────────────────────────────────
console.log('\n[1] ชื่อแท็บสองฝั่ง')
await send('Page.navigate', { url: `${WEB}/studio/${key}?tabs=form&pane=preview` })
await waitFor("!!document.querySelector('.editor-split')", 45000)
await sleep(700)

const leftLabels = await evaluate(
  `[...document.querySelectorAll(${JSON.stringify(LEFT_TABS_SEL)})].map((b) => b.textContent.trim())`,
)
const rightLabels = await evaluate(
  `[...document.querySelectorAll(${JSON.stringify(RIGHT_TABS_SEL)})].map((b) => b.textContent.trim())`,
)
check('แท็บซ้ายมี "ประวัติ"', leftLabels.includes('ประวัติ'), leftLabels.join(' · '))
check('แท็บขวาชื่อ "การแชร์และสิทธิ์"', rightLabels.includes('การแชร์และสิทธิ์'), rightLabels.join(' · '))
check('ฝั่งขวาไม่มีชื่อ "ประวัติ" ซ้ำอีก', !rightLabels.includes('ประวัติ'))
check('แท็บซ้ายเดิมยังอยู่ครบ', leftLabels.includes('ฟอร์ม') && leftLabels.includes('JSON'))

// ── 2. เปิดแท็บประวัติ ───────────────────────────────────────
console.log('\n[2] เปิดแท็บประวัติฝั่งซ้าย')
check('กดแท็บ "ประวัติ" ได้', await clickLeftTab('ประวัติ'))
check('ช่องค้นหาปรากฏ', await waitFor("!!document.querySelector('[data-testid=\"myhistory-search\"]')", 8000))
check('รายการประวัติของฉันโผล่', await waitFor("!!document.querySelector('[data-testid=\"myhistory-list\"]')", 10000))
const rowCount = await evaluate("document.querySelectorAll('[data-testid=\"myhistory-list\"] .myhist__row').length")
check('มีรายการให้เลือก', rowCount > 0, `${rowCount} แถว`)
const hasPreview = await evaluate("!!document.querySelector('.myhist__peek')")
check('แสดงตัวอย่างค่าที่กรอกไว้ (ให้รู้ว่าเป็นฉบับไหน)', hasPreview)
await shot('01-list.png')

// ── 3. URL ───────────────────────────────────────────────────
console.log('\n[3] URL สะท้อนแท็บซ้าย')
const url1 = await evaluate("location.search")
check('URL เป็น ?tabs=history', url1.includes('tabs=history'), url1)

// ── 4. ค้นด้วยชื่อผู้รับ ─────────────────────────────────────
console.log('\n[4] ค้นด้วยชื่อผู้รับ (ค่าที่กรอก ไม่ใช่ชื่อฉบับ)')
check('พิมพ์คำค้นได้', await setSearch(VALUE))
const found = await waitFor(
  `(() => [...document.querySelectorAll('.myhist__row')]
     .some((r) => r.textContent.includes(${JSON.stringify(VALUE)})))()`,
  10000,
)
check('ค้นด้วยชื่อผู้รับแล้วเจอฉบับนั้น', found)
await shot('02-search.png')

// ── 5. กดแก้ไข ──────────────────────────────────────────────
console.log('\n[5] กด "แก้ไข" แล้วค่าต้องกลับเข้าฟอร์ม')
const before = await evaluate(`(() => {
  const el = document.querySelector('[data-testid="myhistory-restore"]')
  if (!el) return null
  el.scrollIntoView({ block: 'center' })
  const r = el.getBoundingClientRect()
  const x = r.x + r.width / 2, y = r.y + r.height / 2
  const hit = document.elementFromPoint(x, y)
  return { ok: !!hit && (el.contains(hit) || hit === el), x, y }
})()`)
if (before?.ok) {
  for (const type of ['mousePressed', 'mouseReleased'])
    await send('Input.dispatchMouseEvent', { type, x: before.x, y: before.y, button: 'left', clickCount: 1 })
}
check('กดปุ่ม "แก้ไข" ได้', !!before?.ok)
check('พากลับไปแท็บฟอร์มให้เอง', await waitFor("!!document.querySelector('.fieldbox')", 10000))
const url2 = await evaluate("location.search")
check('URL กลับเป็น ?tabs=form', url2.includes('tabs=form'), url2)

const restored = await evaluate(`(() => {
  const nodes = [...document.querySelectorAll('.fieldbox input, .fieldbox textarea, .fieldbox select')]
  const hit = nodes.find((n) => n.value && n.value.includes(${JSON.stringify(VALUE)}))
  return hit ? hit.value : ''
})()`)
check('ค่าที่กู้ปรากฏในช่องฟอร์มจริง', restored.includes(VALUE), restored || '(ไม่พบค่าในช่องใดเลย)')
await shot('03-restored.png')

// ── 6. ลิงก์ตรง ─────────────────────────────────────────────
console.log('\n[6] ลิงก์ตรง ?tabs=history ต้องเปิดแท็บซ้ายถูกตัว')
await send('Page.navigate', { url: `${WEB}/studio/${key}?tabs=history` })
await waitFor("!!document.querySelector('[data-testid=\"myhistory-search\"]')", 30000)
check('เปิดแล้วเป็นแท็บประวัติฝั่งซ้าย', true)
const leftOn = await evaluate(
  `document.querySelector(${JSON.stringify(`${LEFT_TABS_SEL}[aria-selected="true"]`)})?.textContent?.trim()`,
)
check('แท็บที่ active คือ "ประวัติ"', leftOn === 'ประวัติ', leftOn ?? '(ไม่มี)')
const rightOn = await evaluate(
  `document.querySelector(${JSON.stringify(`${RIGHT_TABS_SEL}[aria-selected="true"]`)})?.textContent?.trim()`,
)
check('ฝั่งขวาไม่ถูกเปิดผิดเป็นการแชร์และสิทธิ์', rightOn !== 'การแชร์และสิทธิ์', rightOn ?? '(ไม่มี)')

await send('Browser.close').catch(() => {})
chrome.kill()
// เก็บกวาด: ลบช่องกรอกที่สร้างไว้ตอนต้นสคริปต์ คืนสภาพเดิม
await fetch(`${API}/api/form/${key}`, { method: 'DELETE', headers: H }).catch(() => {})
await redis.del(`session:${sid}`)
redis.disconnect()

console.log(`\n── ผ่าน ${pass} · ไม่ผ่าน ${fail} ─────────────────────`)
console.log(`ภาพ: ${OUT.pathname}\n`)
process.exit(fail ? 1 : 0)
