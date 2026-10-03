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
 * 7. แบ่งหน้า — หน้าละ 10 ฉบับ · กดเลขหน้า 2 แล้วได้เนื้อหาคนละชุด ไม่ซ้ำหน้า 1
 * 8. ค้นแล้วเลขหน้าต้องถูกรีเซ็ตกลับหน้า 1 (ผลค้นหาน้อยกว่า 10 ฉบับเสมอ)
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
/**
 * ⚠️ header สำหรับ **DELETE**
 *
 *   ถ้าส่ง `content-type: application/json` ไปกับ DELETE ที่ไม่มี body
 *   Fastify จะตอบ 500 "Body cannot be empty when content-type is set to 'application/json'"
 *   → เก็บกวาดไม่สำเร็จ เอกสารทดสอบค้างในระบบให้ผู้ใช้จริงเจอ
 *   (เจดียว ๆ: บรรทัดลบเอกสาร/ลบฟอร์มด้านล่างเคยล้มเหลวเงียบ ๆ ทุกครั้งที่รัน)
 */
const HD = { cookie: `docgen_session=${sid}` }

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

/**
 * เติมให้ครบ 2 หน้า (หน้าละ 10 ฉบับ) เพื่อพิสูจน์ว่าแถบแบ่งหน้าทำงานจริง
 *
 * ⚠️ ต้องลบทิ้งตอนจบด้วย — ไม่งั้นผู้ใช้จริงเปิด "ผู้ใช้แม่แบบนี้" แล้วเจอขยะ 12 ฉบับ
 */
const PAGE_TAG = `หน้า-${Date.now()}`
const FILLER = 11
const made = [created._id]
for (let i = 0; i < FILLER; i++) {
  const d = await (
    await fetch(`${API}/api/documents`, {
      method: 'POST',
      headers: H,
      body: JSON.stringify({
        templateId: tpl.versionId,
        data: { [FIELD]: `นาย${PAGE_TAG}-${i}` },
        outputFormat: 'pdf',
        label: `แบ่งหน้า ${PAGE_TAG} #${i}`,
      }),
    })
  ).json()
  made.push(d._id)
}
console.log(`สร้างเอกสารเติมอีก ${FILLER} ฉบับ (รวม ${made.length} = 2 หน้า)`)

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

// ── 2b. แบ่งหน้า ───────────────────────────────────────────────
console.log('\n[2b] แบ่งหน้า — หน้าละ 10 ฉบับ ไม่ดึงมาทั้งหมด')
const rangeText = () =>
  evaluate("document.querySelector('[data-testid=\"myhistory-pager-range\"]')?.textContent?.trim() ?? ''")
const rowCountNow = () =>
  evaluate("document.querySelectorAll('[data-testid=\"myhistory-list\"] .myhist__row').length")

check('มีแถบแบ่งหน้า', await waitFor("!!document.querySelector('[data-testid=\"myhistory-pager-page-2\"]')", 8000))
check('หน้าแรกไม่เกิน 10 แถว', rowCount === 10, `${rowCount} แถว`)
check('บอกว่าเห็นหน้าไหนของทั้งหมด', (await rangeText()).includes('หน้า 1 / 2'), await rangeText())
const firstOfPage1 = await evaluate("document.querySelector('.myhist__row')?.textContent ?? ''")

check('กดเลขหน้า 2 ได้', await realClick("document.querySelector('[data-testid=\"myhistory-pager-page-2\"]')"))
const onPage2 = await waitFor(
  "document.querySelectorAll('[data-testid=\"myhistory-list\"] .myhist__row').length === 2",
  10000,
)
const rows2 = await rowCountNow()
check('หน้า 2 เหลือ 2 แถว', onPage2 && rows2 === 2, `${rows2} แถว`)
check('ข้อความช่วงเปลี่ยนตามหน้า', (await rangeText()).includes('หน้า 2 / 2'), await rangeText())
const firstOfPage2 = await evaluate("document.querySelector('.myhist__row')?.textContent ?? ''")
check('เนื้อหาหน้า 2 ไม่ใช่หน้า 1 ซ้ำ', firstOfPage2 !== '' && firstOfPage2 !== firstOfPage1)
await shot('01b-page2.png')

check('กดกลับหน้า 1 ได้', await realClick("document.querySelector('[data-testid=\"myhistory-pager-page-1\"]')"))
const backToPage1 = await waitFor(
  "document.querySelectorAll('[data-testid=\"myhistory-list\"] .myhist__row').length === 10",
  10000,
)
check('หน้า 1 กลับมาครบ 10 แถว', backToPage1)
check('ปุ่มหน้าก่อนหน้าเปิดอยู่ตอนอยู่หน้า 1',
  await evaluate("[...document.querySelectorAll('[data-testid=\"myhistory-pager-prev\"]')].some((b) => b.disabled)"))

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
// ── 4b. ค้นแล้วต้องกลับไปหน้าเดียว ──────────────────────────────
console.log('\n[4b] ค้นแล้วเลขหน้าต้องถูกรีเซ็ต (ผลค้นหาน้อยกว่า 10 ฉบับเสมอ)')
check(
  'เจอแค่หน้าเดียว → แถบแบ่งหน้าหาย',
  await waitFor("!document.querySelector('[data-testid=\"myhistory-pager-page-2\"]')", 6000),
)
await setSearch('')
const backFull = await waitFor("document.querySelectorAll('.myhist__row').length === 10", 10000)
check('ล้างคำค้นแล้วกลับหน้า 1 ครบ 10 แถว', backFull)
check('กลับมาที่หน้า 1 ของ 2', (await rangeText()).includes('หน้า 1 / 2'), await rangeText())

// ── 4c. ลบประวัติ ──────────────────────────────────────────────────
console.log('\n[4c] ลบประวัติ — ต้องยืนยันก่อน แล้วค่อยหายจริง')
/**
 * ผู้ใช้สั่ง: *"เพิ่มปุ่มลบ ประวัติ"*
 *
 * ต้องพิสูจน์ให้ครบ ไม่ใช่แค่ปุ่มหาย
 *   1. กดครั้งแรก = **ขอยืนยัน** ยังไม่ลบ (กันลบผิดฉบับ)
 *   2. กดครั้งที่สอง = ลบจริง
 *   3. จำนวนบน API ลดลง 1 → ไม่ใช่แค่ซ่อนแถวบนจอ
 */
const delTag = `${PAGE_TAG}-7`
const totalFor = async (q) =>
  (await (await fetch(`${API}/api/history/${tpl.id}/mine?limit=1&q=${encodeURIComponent(q)}`, { headers: H })).json())
    .total

await setSearch(delTag)
const foundForDelete = await waitFor("document.querySelectorAll('.myhist__row').length === 1", 10000)
check('ค้นเจอฉบับที่จะลบ', foundForDelete)
const totalBefore = await totalFor(PAGE_TAG)
check(
  'มีปุ่มลบในแถวนั้น',
  !!(await evaluate("!!document.querySelector('[data-testid=\"myhistory-delete\"]')")),
)

check('กดครั้งแรกได้', await realClick("document.querySelector('[data-testid=\"myhistory-delete\"]')"))
const asking = await waitFor(
  "document.querySelector('[data-testid=\"myhistory-delete\"]')?.textContent.includes('ยืนยันลบ')",
  6000,
)
check('ปุ่มเปลี่ยนเป็น "ยืนยันลบ?"', asking)
check('ยังไม่ลบจนกว่าจะกดยืนยัน', (await evaluate("document.querySelectorAll('.myhist__row').length")) === 1)
await shot('04-delete-confirm.png')

check('กดยืนยันได้', await realClick("document.querySelector('[data-testid=\"myhistory-delete\"]')"))
const rowGone = await waitFor("document.querySelectorAll('.myhist__row').length === 0", 10000)
check('แถวหายจากรายการ', rowGone)
const delMsg = await evaluate("document.querySelector('[data-testid=\"myhistory-del-msg\"]')?.textContent ?? ''")
check('มีข้อความบอกว่าลบแล้ว', delMsg.includes('ลบฉบับนี้แล้ว'), delMsg)
const totalAfter = await totalFor(PAGE_TAG)
check('จำนวนบน API ลดลง 1 ฉบับ', totalAfter === totalBefore - 1, `${totalBefore} → ${totalAfter}`)

// ── 5. กดแก้ไข ──────────────────────────────────────────────
console.log('\n[5] กด "แก้ไข" แล้วค่าต้องกลับเข้าฟอร์ม')
// ค้นใหม่ก่อน เพราะข้อ 4b ล้างคำค้นไปแล้ว
await setSearch(VALUE)
await waitFor("document.querySelectorAll('.myhist__row').length === 1", 10000)
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
// เก็บกวาด: ลบเอกสารที่สคริปต์นี้สร้าง (ไม่ทิ้งขยะไว้ให้เจอตอนเปิดประวัติจริง)
let wiped = 0
for (const id of made) {
  const r = await fetch(`${API}/api/documents/${id}`, { method: 'DELETE', headers: HD }).catch(() => null)
  if (r?.status === 204 || r?.status === 200) wiped++
}
console.log(`ลบเอกสารทดสอบแล้ว ${wiped}/${made.length} ฉบับ`)
// เก็บกวาด: ลบช่องกรอกที่สร้างไว้ตอนต้นสคริปต์ คืนสภาพเดิม
await fetch(`${API}/api/form/${key}`, { method: 'DELETE', headers: HD }).catch(() => {})
await redis.del(`session:${sid}`)
redis.disconnect()

console.log(`\n── ผ่าน ${pass} · ไม่ผ่าน ${fail} ─────────────────────`)
console.log(`ภาพ: ${OUT.pathname}\n`)
process.exit(fail ? 1 : 0)
