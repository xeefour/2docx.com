/**
 * ตรวจไม้บรรทัด (ruler) บนพรีวิวเอกสาร
 *
 *   node --env-file=.env tools/test-ruler-ui.mjs
 *
 * ── สิ่งที่ต้องผ่าน ────────────────────────────────────────────
 * 1. มีปุ่มสลับไม้บรรทัดในแถบเครื่องมือ
 * 2. เปิดแล้วได้ไม้บรรทัดบน + ซ้าย พร้อมกัน
 * 3. **ตำแหน่ง 0 ของไม้บรรทัดตรงขอบกระดาษเป๊ะ** (สำคัญที่สุด — ไม้บรรทัดที่เพี้ยนแล้ววัดผิด)
 * 4. ความยาวไม้บรรทัด = ความกว้าง canvas ไม่เกิน 1px
 * 5. ตัวเลขแรกคือ 0 และตัวสุดท้ายไม่เกินขนาดกระดาษจริง (A4 = 21 ซม.)
 * 6. สลับหน่วย ซม. ↔ นิ้ว ได้ และตัวเลขเปลี่ยนตาม
 * 7. จำค่าไว้ข้ามการรีเฟรช
 * 8. ซ่อนไม้บรรทัดแล้ว canvas ไม่เลื่อน (กลับเป็นกลางจอเหมือนเดิม)
 * 9. ซูมแล้วไม้บรรทัดยังตรงขอบกระดาษ
 * 10. ปุ่มทุกปุ่มในแถบเครื่องมือสูงเท่ากัน และปุ่มซูมเป็นไอคอนแว่นขยาย (ไม่ใช่ตัวอักษร + / −)
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
const PORT = 9371
const WEB = 'http://localhost:3000'
const OUT = new URL('../tests/nav-status/output-ruler/', import.meta.url)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
mkdirSync(OUT, { recursive: true })

let pass = 0
let fail = 0
let skip = 0
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`)
  ok ? pass++ : fail++
}

const redis = new Redis(process.env.VALKEY_URL)
const sid = `ruler-${Date.now()}`
await redis.set(
  `session:${sid}`,
  JSON.stringify({ sub: sid, name: 'ผู้ทดสอบไม้บรรทัด', email: 'ruler@test.local', avatar: '' }),
  'EX',
  1800,
)
const H = { cookie: `docgen_session=${sid}`, 'content-type': 'application/json' }

/**
 * เลือกแม่แบบตามชื่อ ไม่ใช่ `items[0]` — ลำดับรายการเปลี่ยนได้ทุกครั้งที่เทสต์อื่นสร้าง/ลบแม่แบบชั่วคราว
 */
const picked = await pickTemplate(H, [TEST_TEMPLATES.multipage, 'สำเนา 1', 'อำเภอเนินมะปราง'])
const key = keyOf(picked)
console.log(`ใช้แม่แบบ: ${picked.name} (key ${key})`)

/**
 * เตรียมช่องกรอก + snapshot ฟอร์มเดิมไว้ก่อน (`import-tags` เขียนทับของเดิม)
 */
const formSnap = await snapshotForm(H, key)
const seed = await importTags(H, picked)
console.log(`เตรียมช่องกรอกจากแท็กจริง — ${seed.ok ? 'สำเร็จ' : 'ล้มเหลว ' + seed.status}`)

const profile = mkdtempSync(join(tmpdir(), 'cdp-ruler-'))
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
const waitFor = async (expr, timeoutMs = 30000, step = 200) => {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    try {
      if (await evaluate(expr)) return true
    } catch { /* กำลัง navigate */ }
    await sleep(step)
  }
  return false
}
const shot = async (name) => {
  const { data } = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(new URL(name, OUT), Buffer.from(data, 'base64'))
}
const clickTestId = async (id) => {
  const box = await evaluate(`(() => {
    const el = document.querySelector('[data-testid=${JSON.stringify(id)}]')
    if (!el) return null
    el.scrollIntoView({ block: 'center' })
    const r = el.getBoundingClientRect()
    const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)
    return { ok: !!hit && (el.contains(hit) || hit === el), x: r.x + r.width / 2, y: r.y + r.height / 2 }
  })()`)
  if (!box?.ok) return false
  for (const type of ['mousePressed', 'mouseReleased'])
    await send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 })
  return true
}

/** วัดตำแหน่งไม้บรรทัดเทียบกับ canvas — คืนค่า px ที่ต่างกัน */
const geom = () =>
  evaluate(`(() => {
    const c = document.querySelector('.docstage__page canvas')
    const h = document.querySelector('.rul--h')
    const v = document.querySelector('.rul--v')
    if (!c || !h || !v) return null
    const cr = c.getBoundingClientRect()
    const hr = h.getBoundingClientRect()
    const vr = v.getBoundingClientRect()
    return {
      page: { x: cr.x, y: cr.y, w: cr.width, h: cr.height },
      rh: { x: hr.x, y: hr.y, w: hr.width, h: hr.height },
      rv: { x: vr.x, y: vr.y, w: vr.width, h: vr.height },
      // ตัวเลขบนไม้บรรทัดแนวนอน เรียงจากซ้ายไปขวา
      nums: [...h.querySelectorAll('text')].map((t) => ({
        v: t.textContent,
        x: t.getBoundingClientRect().x + t.getBoundingClientRect().width / 2,
      })),
      unit: document.querySelector('[data-testid="ruler-toggle"]')?.dataset.unit,
      on: document.querySelector('[data-testid="ruler-toggle"]')?.getAttribute('aria-pressed'),
    }
  })()`)

await send('Page.enable')
await send('Runtime.enable')
await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false })
await send('Network.setCookie', { name: 'docgen_session', value: sid, url: WEB })
await send('Network.setCacheDisabled', { cacheDisabled: true })

// ── เรนเดอร์ก่อน ไม้บรรทัดวัดจากกระดาษจริง ──────────────────────────
console.log('\n[0] เปิดแม่แบบแล้วเรนเดอร์')
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
check('เรนเดอร์ตัวอย่างสำเร็จ (canvas ไม่ใช่ค่าเริ่มต้น 300×150)', rendered)
if (!rendered) {
  await shot('99-failed.png')
  console.log(`\n── ผ่าน ${pass} · ไม่ผ่าน ${fail} ─────────────────────\n`)
  process.exit(1)
}

// ── 1–2. ปุ่มสลับ + เปิดไม้บรรทัด ──────────────────────────────────
console.log('\n[1] ปุ่มสลับไม้บรรทัด')
check('มีปุ่มสลับไม้บรรทัด', await evaluate("!!document.querySelector('[data-testid=\"ruler-toggle\"]')"))
/**
 * ⚠️ ปุ่มหน่วย "ซม./นิ้ว" ถูก**ซ่อนไปแล้ว** (ผู้ใช้สั่ง)
 *   หน่วยเปลี่ยนผ่าน dropdown ที่เปิดจากปุ่มไม้บรรทัดแทน
 *   อ่านหน่วยปัจจุบันจาก `data-unit` ของปุ่มไม้บรรทัด (แหล่งจริงมีที่เดียว)
 */
check('ไม่มีปุ่มหน่วยแยกในแถบเครื่องมือแล้ว', !(await evaluate("!!document.querySelector('[data-testid=\"ruler-unit\"]')")))
const unit0 = await evaluate("document.querySelector('[data-testid=\"ruler-toggle\"]')?.dataset.unit")
check('เริ่มต้นเป็นหน่วย ซม.', unit0 === 'cm', unit0)
check('เริ่มต้นซ่อนอยู่ (ไม่บังหน้าเอกสารทันที)', !(await evaluate("!!document.querySelector('.rul--h')")))

console.log('\n[2] เปิดไม้บรรทัด')
/**
 * ⚠️ flow ใหม่: กดปุ่มไม้บรรทัด**ยังไม่โชว์ไม้บรรทัดทันที**
 *    ต้องเลือกหน่วยก่อน (ผู้ใช้สั่ง: *"คลิกที่ ซม. กับ นิ้ว แล้วค่อยแสดง ruler"*)
 *    ถ้าโชว์ทันที ผู้ใช้จะได้หน่วยค่าเริ่มต้นโดยไม่ได้ตั้งใจเลือก
 *    เทสต์ข้อ "ยังไม่โชว์" นี้คือกันไม่ให้ใครไปทำให้กดแล้วขึ้นทันทีทีหลัง
 */
check('กดปุ่มไม้บรรทัดได้', await clickTestId('ruler-toggle'))
check('กดแล้วมีเมนูหน่วยโผล่', await waitFor("!!document.querySelector('.rulpick')", 5000))
await shot('00-unit-menu.png')
const unitOpts = await evaluate(
  "[...document.querySelectorAll('.rulpick__opt')].map((b) => b.dataset.testid ?? '').filter((s) => s.startsWith('ruler-unit-'))",
)
check('เมนูมีให้เลือก ซม. และ นิ้ว', unitOpts.length === 2, unitOpts.join(' | '))
check('ยังไม่โชว์ไม้บรรทัดจนกว่าจะเลือกหน่วย', !(await evaluate("!!document.querySelector('.rul--h')")))
check('เลือกหน่วย ซม. ได้', await clickTestId('ruler-unit-cm'))
const hShown = await waitFor("!!document.querySelector('.rul--h')", 8000)
check('ไม้บรรทัดบนปรากฏหลังเลือกหน่วย', hShown)

if (!hShown) {
  // ระบุให้ชัดว่าขาดอะไร — ไม่งั้นจะเดาว่าเป็น state, effect หรือเงื่อนไข render
  console.log('    stage:', await evaluate(`(() => {
    const st = document.querySelector('.docstage')
    const c = document.querySelector('.docstage__page canvas')
    return JSON.stringify({
      hasStage: !!st,
      grid: st ? getComputedStyle(st).gridTemplateColumns + ' | ' + getComputedStyle(st).gridTemplateRows : null,
      canvas: c ? { clientW: c.clientWidth, clientH: c.clientHeight, attrW: c.width, attrH: c.height } : null,
      children: st ? st.children.length : 0,
      html: st ? st.innerHTML.slice(0, 160) : null,
    })
  })()`))
}
check('ไม้บรรทัดซ้ายปรากฏ', await evaluate("!!document.querySelector('.rul--v')"))
check('ปุ่มถูกทำเครื่องหมายว่าเปิดอยู่', (await evaluate("document.querySelector('[data-testid=\"ruler-toggle\"]').getAttribute('aria-pressed')")) === 'true')
// ตรวจว่าค่าถูกเขียนลง localStorage จริง ไม่ใช่แค่ state ในหน่วยความจำ
check(
  'บันทึกสถานะลง localStorage',
  (await evaluate("window.localStorage.getItem('docgen.preview.ruler')")) === '1',
  `ค่า=${await evaluate("window.localStorage.getItem('docgen.preview.ruler')")}`,
)
await sleep(500)
await shot('01-cm.png')

// ── 3–5. ตำแหน่งและตัวเลข ────────────────────────────────────────
console.log('\n[3] ตำแหน่งไม้บรรทัดตรงขอบกระดาษ (สำคัญที่สุด)')
{
  const g = await geom()
  check('วัดได้ครบทุกชิ้น', !!g)
  if (g) {
    const dLeft = Math.abs(g.rh.x - g.page.x)
    const dTop = Math.abs(g.rv.y - g.page.y)
    const dRight = Math.abs(g.rh.x + g.rh.w - (g.page.x + g.page.w))
    const dBottom = Math.abs(g.rv.y + g.rv.h - (g.page.y + g.page.h))
    check('ขอบซ้ายตรงกัน', dLeft <= 1, `ต่าง ${dLeft.toFixed(1)}px`)
    check('ขอบขวาตรงกัน', dRight <= 1, `ต่าง ${dRight.toFixed(1)}px`)
    check('ขอบบนตรงกัน', dTop <= 1, `ต่าง ${dTop.toFixed(1)}px`)
    check('ขอบล่างตรงกัน', dBottom <= 1, `ต่าง ${dBottom.toFixed(1)}px`)
    check('ไม้บรรทัดซ้ายอยู่ซ้ายกระดาษจริง', g.rv.x + g.rv.w <= g.page.x + 1, `ขวาของไม้=${(g.rv.x + g.rv.w).toFixed(1)}`)
    check('ไม้บรรทัดบนอยู่เหนือกระดาษจริง', g.rh.y + g.rh.h <= g.page.y + 1, `ล่างของไม้=${(g.rh.y + g.rh.h).toFixed(1)}`)
  }
}
console.log('\n[4] ความยาวไม้บรรทัด = ความกว้างกระดาษ')
{
  const g = await geom()
  check('ยาวเท่ากัน', Math.abs(g.rh.w - g.page.w) <= 1, `ไม้ ${g.rh.w} · หน้า ${g.page.w}`)
  check('สูงเท่ากัน', Math.abs(g.rv.h - g.page.h) <= 1, `ไม้ ${g.rv.h} · หน้า ${g.page.h}`)
}
console.log('\n[5] ตัวเลขบนไม้บรรทัด')
{
  const g = await geom()
  check('ขึ้นต้นด้วย 0', g.nums[0]?.v === '0', `เริ่มด้วย "${g.nums[0]?.v}"`)
  check('มีตัวเลขมากกว่า 2 ตัว', g.nums.length > 2, `${g.nums.length} ตัว`)
  const last = Number(g.nums[g.nums.length - 1].v)
  // A4 กว้าง 21 ซม. · Letter 21.59 — ตัวเลขสุดท้ายต้องไม่เกินนั้น
  check('ตัวสุดท้ายไม่เกินความกว้างกระดาษ (A4 = 21)', last <= 21.6, `สูงสุด ${last}`)
  check('ตัวเลขเรียงจากซ้ายไปขวา', g.nums.every((n, i) => i === 0 || n.x > g.nums[i - 1].x))
  // ตำแหน่ง 0 ต้องตรงขอบซ้ายของกระดาษ
  const zero = g.nums.find((n) => n.v === '0')
  check('ตัวเลข 0 อยู่ตรงขอบซ้ายกระดาษ', !!zero && Math.abs(zero.x - g.page.x) <= 2, `ต่าง ${Math.abs((zero?.x ?? 0) - g.page.x).toFixed(1)}px`)
  // ตัวสุดท้ายต้องไม่ล้นออกมา
  const lastX = g.nums[g.nums.length - 1].x
  check('ตัวสุดท้ายไม่ล้นออกขอบขวา', lastX <= g.page.x + g.page.w + 2, `ต่าง ${(lastX - (g.page.x + g.page.w)).toFixed(1)}px`)
}

// ── 6. สลับหน่วย ────────────────────────────────────────────────
console.log('\n[6] สลับหน่วย ซม. ↔ นิ้ว')
{
  const before = await geom()
  check('เปิดเมนูหน่วยได้', await clickTestId('ruler-toggle'))
  const sawIn = await waitFor("!!document.querySelector('[data-testid=\"ruler-unit-in\"]')", 5000)
  check('เมนูหน่วยโผล่ตอนไม้บรรทัดเปิดอยู่', sawIn)
  // ตอนนี้เมนูมีตัวเลือก "ซ่อนไม้บรรทัด" เพิ่มด้วย — ข้อความยาวที่สุดในเมนู
  // เคยล้นออกนอกกล่องตอนกำหนด `min-width: 100%` จึงต้องมีภาพกัน
  // ต้องรอ animation fade-in (120ms) ก่อนถ่าย ไม่งั้นภาพจะออกมาโปร่งใส
  // แล้วเข้าใจผิดว่าเมนูโปร่งใสให้เลขบนไม้บรรทัดทะลุ
  await sleep(400)
  await shot('00b-unit-menu-on.png')
  const hideW = await evaluate(`(() => {
    const box = document.querySelector('.rulpick')
    const off = document.querySelector('[data-testid="ruler-hide"]')
    if (!box || !off) return null
    const b = box.getBoundingClientRect()
    const o = off.getBoundingClientRect()
    return { over: Math.round(o.right - b.right), boxW: Math.round(b.width) }
  })()`)
  check('ข้อความ "ซ่อนไม้บรรทัด" ไม่ล้นออกกล่อง', hideW && hideW.over <= 0, hideW ? `ล้น ${hideW.over}px · กล่อง ${hideW.boxW}px` : 'ไม่พบเมนู')
  /**
   * ⚠️ เมนูต้อง**ทึบ**ไม้บรรทัด ไม่ใช่โปร่งใสให้เลขทะลุ
   *    เคยเห็นเลข 15–20 โผล่ผ่านกล่องเมนู — เมนูกับไม้บรรทัดอยู่คนละชั้นวาด
   *    จึงต้องพิสูจน์ด้วย `elementFromPoint` ว่าจุดที่ทับเมนูคือเมนูจริง
   *    (ดูภาพอย่างเดียวอาจเข้าใจผิดว่าเป็นเงาหรือ antialiasing)
   */
  const topAt = await evaluate(`(() => {
    const box = document.querySelector('.rulpick')
    if (!box) return null
    const r = box.getBoundingClientRect()
    const hit = document.elementFromPoint(r.x + r.width / 2, r.y + 4)
    return { tag: hit?.tagName ?? 'null', cls: hit?.getAttribute('class') ?? '', inMenu: !!hit && box.contains(hit) }
  })()`)
  check('เมนูทึบไม้บรรทัด (เลขบนไม้บรรทัดต้องไม่ทะลุกล่อง)', topAt?.inMenu === true, topAt ? `${topAt.tag}.${topAt.cls}` : 'ไม่พบเมนู')
  check('เลือกหน่วย นิ้ว ได้', sawIn && (await clickTestId('ruler-unit-in')))
  await sleep(600)
  const after = await geom()
  check('หน่วยเปลี่ยนเป็น นิ้ว', after.unit === 'in', after.unit)

  check('ตัวเลขเปลี่ยนไปจริง', after.nums.at(-1)?.v !== before.nums.at(-1)?.v, `${before.nums.at(-1)?.v} → ${after.nums.at(-1)?.v}`)
  const lastIn = Number(after.nums.at(-1).v)
  // A4 กว้าง 8.27 นิ้ว — ขั้นปกติคือ 1 นิ้ว จึงได้เลขสูงสุด 8
  check('ตัวสุดท้ายสมเหตุสมผลกับหน่วยนิ้ว (≤ 8.3)', lastIn <= 8.3, `สูงสุด ${lastIn}`)
  check('ยังขึ้นต้นด้วย 0', after.nums[0]?.v === '0')
  check('ยังตรงขอบกระดาษหลังสลับหน่วย', Math.abs(after.rh.x - after.page.x) <= 1 && Math.abs(after.rh.w - after.page.w) <= 1)
  await shot('02-inch.png')
  await clickTestId('ruler-toggle') // เปิดเมนูเพื่อกลับเป็น ซม.
  await waitFor("!!document.querySelector('[data-testid=\"ruler-unit-cm\"]')", 5000)
  await clickTestId('ruler-unit-cm')
  await sleep(500)
}

// ── 7. จำค่าไว้ข้ามการรีเฟรช ─────────────────────────────────────
console.log('\n[7] จำค่าไว้ข้ามการรีเฟรช')
{
  await send('Page.reload')
  await waitFor("!!document.querySelector('.dl__btn')", 60000)
  await sleep(800)
  /**
   * ⚠️ หลังรีเฟรช ฟอร์มกลับเป็นค่าว่าง → ต้องกรอกใหม่ก่อน มิฉะนั้นปุ่มเรนเดอร์จะถูกบล็อก
   *    เพราะช่องบังคับ (เช่น "เรื่อง") ยังว่าง แล้วข้อนี้จะตกทั้งที่ localStorage ทำงานถูก
   */
  await evaluate(FILL_FIELDS_JS)
  await sleep(400)
  /**
   * ⚠️ หลังรีเฟรช พรีวิวยังไม่มีรูป — ผู้ใช้ต้องกด "เรนเดอร์ตัวอย่าง" ใหม่
   *    แถบเครื่องมือ (ปุ่มไม้บรรทัด) จึงยังไม่มี ต้องเรนเดอร์ก่อนจึงจะเช็คได้
   *    ถ้าเช็คตรนี้เลย เทสต์จะตกทั้งที่ localStorage ทำงานถูก
   */
  const again = await evaluate(`(() => {
    const el = [...document.querySelectorAll('button')].find((b) => b.textContent.includes('เรนเดอร์ตัวอย่าง'))
    if (!el) return null
    el.scrollIntoView({ block: 'center' })
    const r = el.getBoundingClientRect()
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
  })()`)
  check('หลังรีเฟรชต้องกดเรนเดอร์ใหม่ (พรีวิวยังไม่มีรูป)', again !== null)
  if (again) {
    for (const type of ['mousePressed', 'mouseReleased'])
      await send('Input.dispatchMouseEvent', { type, x: again.x, y: again.y, button: 'left', clickCount: 1 })
  }
  const ok = await waitFor(canvasDrawnJs(), 120000)
  check('เรนเดอร์หลังรีเฟรชสำเร็จ', ok)
  if (ok) {
    /**
     * ⚠️ ต้องรอไม้บรรทัดจริง ห้ามเช็คทันทีที่ canvas โผล่
     *    pdf.js ตั้ง `canvas.width` ตั้งแต่ต้นก่อนที่ `setStage` จะ commit
     *    ถ้าเช็คตรนี้เลย เทสต์จะแพ้เสมอแม้แอปทำถูก
     */
    const rulBack = await waitFor("!!document.querySelector('.rul--h')", 10000)
    const stored = await evaluate("window.localStorage.getItem('docgen.preview.ruler')")
    console.log('    localStorage หลังรีเฟรช:', JSON.stringify(stored))
    check(
      'ไม้บรรทัดยังเปิดอยู่ตามที่เลือกไว้ก่อนรีเฟรช',
      rulBack,
      rulBack ? '' : 'รอ 10 วินาทีแล้วยังไม่ปรากฏ',
    )
    check('หน่วยยังเป็น ซม. ตามที่เลือกไว้', (await evaluate("document.querySelector('[data-testid=\"ruler-toggle\"]')?.dataset.unit")) === 'cm', await evaluate("document.querySelector('[data-testid=\"ruler-toggle\"]')?.dataset.unit"))
  }
}

// ── 8. ซ่อนแล้วกระดาษกลับเป็นกลางจอ ─────────────────────────────
console.log('\n[8] ซ่อนไม้บรรทัด')
{
  // ถ้ารีเฟรชแล้วไม้บรรทัดยังไม่กลับมา ให้กดเปิดให้ครบก่อนจะได้วัดเทียบก่อน–หลัง
  if (!(await evaluate("!!document.querySelector('.rul--h')"))) {
    const clicked = await clickTestId('ruler-toggle')
    const sawCm = clicked && (await waitFor("!!document.querySelector('[data-testid=\"ruler-unit-cm\"]')", 5000))
    if (sawCm) await clickTestId('ruler-unit-cm')
    const shown = sawCm ? await waitFor("!!document.querySelector('.rul--h')", 10000) : false
    check('เปิดไม้บรรทัดกลับได้ก่อนวัด', shown, shown ? '' : 'กดแล้วรอ 10 วินาทียังไม่ปรากฏ')
  }
  const before = await geom()
  if (!before) {
    check('วัดไม้บรรทัดก่อนซ่อนได้', false, 'ยังไม่มี .rul--h — ข้าส่วนที่วัดเทียบไม่ได้')
  }
  // ซ่อนผ่านตัวเลือกในเมนูหน่วย (ปุ่มไม้บรรทัดตอนนี้เปิดเมนู ไม่ได้ซ่อนตรง ๆ)
  check('เปิดเมนูได้', await clickTestId('ruler-toggle'))
  const sawHide = await waitFor("!!document.querySelector('[data-testid=\"ruler-hide\"]')", 5000)
  check('เมนูมีตัวเลือก "ซ่อนไม้บรรทัด" ตอนที่มันเปิดอยู่', sawHide)
  check('กดซ่อนได้', sawHide && (await clickTestId('ruler-hide')))
  await sleep(800)
  check('ไม้บรรทัดหายไป', !(await evaluate("!!document.querySelector('.rul--h')")))
  const after = await evaluate(`(() => {
    const c = document.querySelector('.docstage__page canvas')
    const host = document.querySelector('.docpage')
    if (!c || !host) return null
    const cr = c.getBoundingClientRect(), hr = host.getBoundingClientRect()
    return { left: Math.abs(cr.x - hr.x), right: Math.abs(cr.right - hr.right), w: cr.width, pw: hr.width }
  })()`)
  check('กระดาษกลับมาเต็มความกว้างที่มี', !!before && after.w > before.page.w - 1, before ? `${before.page.w} → ${after.w}` : '(ไม่มีข้อมูลก่อน)')
  /**
   * ⚠️ ต้องเช็คว่า**อยู่กลาง** ไม่ใช่ว่า "ไม่มีช่องว่างข้าง"
   *
   *   เดิมกระดาษเต็มความกว้างกล่องเสมอ (คำนวณจากความกว้างอย่างเดียว)
   *   ตอนนี้กระดาษถูกย่อให้**พอดีทั้งหน้า** กล่องกว้างกว่ากระดาษก็เหลือข้างสองข้าง
   *   ซึ่งถูกต้อง (A4 แนวตั้งสูงกว่ากว้าง พอดีความสูงแล้วจะกว้างเกินมาเสมอ)
   *   เกณฑ์เดิม `< 40px` จึงไปบังคับสิ่งที่ผิด แล้วรายงานว่าหน้าจอพัง
   */
  check(
    'กระดาษอยู่กลางพื้นที่พรีวิว (ช่องว่างสองข้างเท่ากัน)',
    Math.abs(after.left - after.right) <= 2,
    `ซ้าย ${after.left.toFixed(0)} · ขวา ${after.right.toFixed(0)} · กระดาษ ${after.w}px / กล่อง ${after.pw}px`,
  )
  await shot('03-hidden.png')
}

// ── 9. ซูมแล้วยังตรง ────────────────────────────────────────────
console.log('\n[9] ซูมแล้วไม้บรรทัดยังตรงขอบกระดาษ')
{
  await clickTestId('ruler-toggle')
  await waitFor("!!document.querySelector('[data-testid=\"ruler-unit-cm\"]')", 5000)
  await clickTestId('ruler-unit-cm')
  await sleep(500)
  await waitFor("!!document.querySelector('.rul--h')", 10000)

  /**
   * ⚠️ ต้องวัดตำแหน่งปุ่มใหม่ทุกครั้ง และต้องยืนยันว่าซูมขึ้นจริง
   *    ตอนซูมออกจากพอดีหน้า ปุ่ม "พอดีหน้า" จะโผล่ข้าง `+` ทำให้แถบเครื่องมือยาวขึ้น
   *    ถ้าใช้พิกัดเดิมซ้ำ จะคลิกผิดปุ่ม และถ้าไม่เช็คค่าซูม
   *    ข้อ "หลังซูมยังตรง" จะผ่านมั่วทั้งที่ยังอยู่ที่ขนาดเดิม (เคยเจอ)
   *
   * ⚠️ เทียบกับ**ค่าก่อนซูม** ไม่ใช่กับเลข 100 ตายตัว
   *    ตอนนี้ตัวเลขคือเปอร์เซ็นต์จริงเทียบกระดาษจริง (พอดีหน้าอาจได้ 50% ตอนจอเตี้ย)
   *    การกด `+` สองครั้ง = ซูม 2 เท่า → ตัวเลขต้องโตเป็น 2 เท่าของเดิม
   */
  const zoomNow = () => evaluate("document.querySelector('.doctools .mono')?.textContent?.trim() ?? ''")
  const before = await zoomNow()
  for (let i = 0; i < 2; i++) {
    const box = await evaluate(`(() => {
      // ⚠️ หาด้วย aria-label ไม่ใช่ข้อความ "+"
      //   ปุ่มซูมเปลี่ยนจากตัวอักษรเป็นไอคอนแว่นขยายแล้ว → textContent ว่างเปล่า
      //   เคยหาด้วยข้อความแล้วพังทันทีตอนเปลี่ยนเป็น SVG
      const b = document.querySelector('.doctools [aria-label="ซูมเข้า"]')
      if (!b || b.disabled) return null
      b.scrollIntoView({ block: 'nearest' })
      const r = b.getBoundingClientRect()
      const x = r.x + r.width / 2, y = r.y + r.height / 2
      const hit = document.elementFromPoint(x, y)
      return { ok: !!hit && (b.contains(hit) || hit === b), x, y }
    })()`)
    if (!box?.ok) {
      check('กดปุ่มซูมได้', false, box ? 'มีอะไรบังปุ่มซูมเข้า' : 'หาปุ่มซูมเข้าไม่เจอ')
      break
    }
    for (const type of ['mousePressed', 'mouseReleased'])
      await send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 })
    await sleep(1200)
  }
  const after = await zoomNow()
  const bNum = Number.parseInt(before)
  const aNum = Number.parseInt(after)
  check(
    'ซูมได้จริงก่อนวัดว่าไม้ยังตรง',
    after !== before && Number.isFinite(bNum) && Number.isFinite(aNum) && aNum > bNum * 1.5,
    `${before} → ${after} (กด + 2 ครั้ง = ซูม 2 เท่า)`,
  )

  const g = await geom()
  // ⚠️ ถ้า `g` เป็น null แปลว่าไม้บรรทัดไม่ขึ้น — รายงานเป็นข้อ ไม่ใช่ปล่อยให้สคริปต์พัง
  if (!g) {
    check('หลังซูมไม้บรรทัดยังอยู่', false, 'วัดไม่ได้ ไม่มี .rul--h')
    await shot('04-zoomed.png')
  } else {
    check('หลังซูม ขอบซ้ายยังตรง', Math.abs(g.rh.x - g.page.x) <= 1, `ต่าง ${Math.abs(g.rh.x - g.page.x).toFixed(1)}px`)
    check('หลังซูม ขอบขวายังตรง', Math.abs(g.rh.x + g.rh.w - (g.page.x + g.page.w)) <= 1, `ต่าง ${Math.abs(g.rh.x + g.rh.w - (g.page.x + g.page.w)).toFixed(1)}px`)
    check('หลังซูม ขอบล่างยังตรง', Math.abs(g.rv.y + g.rv.h - (g.page.y + g.page.h)) <= 1, `ต่าง ${Math.abs(g.rv.y + g.rv.h - (g.page.y + g.page.h)).toFixed(1)}px`)
    check('หลังซูม ตัวเลข 0 ยังที่ขอบซ้าย', Math.abs((g.nums.find((n) => n.v === '0')?.x ?? 0) - g.page.x) <= 2)
    const last = Number(g.nums.at(-1).v)
    check('หลังซูม ตัวเลขยังไม่เกินกระดาษ', last <= 21.6, `สูงสุด ${last}`)
  }
  await shot('04-zoomed.png')
}

// ── 10. ปุ่มในแถบเครื่องมือต้องสูงเท่ากัน ───────────────────────
console.log('\n[10] ความสูงปุ่มในแถบเครื่องมือ — ต้องเท่ากันทุกปุ่ม')
{
  /**
   * ⚠️ ผู้ใช้สั่ง "ทำให้ปุ่มต่างๆมีขนาดความสูงเท่ากัน"
   *   วัดจริงก่อนแก้: ซูม 42px · พอดีหน้า/ไม้บรรทัด/ซม./พิมพ์ 29px · ดาวน์โหลด 36px
   *
   *   ต้องวัดจากทุกปุ่มใน `.doctools` รวมปุ่มที่มาจาก component อื่น
   *   (ดาวน์โหลดถูกส่งเข้ามาเป็น `toolbarExtra`) ไม่งั้นการแก้แค่ปุ่มซูม
   *   จะผ่านทั้งที่ปุ่มอื่นยังสูงไม่เท่ากัน
   */
  const btns = await evaluate(`[...document.querySelectorAll('.doctools button')].map((b) => {
    const r = b.getBoundingClientRect()
    return {
      name: b.getAttribute('aria-label') || b.textContent.trim().slice(0, 10),
      h: Math.round(r.height * 10) / 10,
      w: Math.round(r.width * 10) / 10,
    }
  })`)
  const heights = btns.map((b) => b.h)
  const min = Math.min(...heights)
  const max = Math.max(...heights)
  check('วัดปุ่มได้ครบ (อย่างน้อย 6 ปุ่ม)', btns.length >= 6, JSON.stringify(btns))
  check(
    'ทุกปุ่มในแถบสูงเท่ากัน',
    max - min <= 1,
    `ต่ำสุด ${min}px · สูงสุด ${max}px · ${btns.map((b) => b.name + ':' + b.h).join(' ')}`,
  )
  /**
   * ⚠️ ปุ่มไอคอน(ซูม/ดาวน์โหลด) ต้องเป็น**สี่เหลี่ยมจัตุรัส**
   *   ถ้าสูงเท่ากันแล้วกว้างไม่เท่า จะเป็นวงรี/วงรีแบน ดูเหมือนปุ่มคนละชนิด
   */
  const iconBtns = btns.filter((b) => /ซูม|ดาวน์โหลด/.test(b.name))
  check(
    'ปุ่มไอคอนเป็นสี่เหลี่ยมจัตุรัส (กว้าง = สูง)',
    iconBtns.length >= 3 && iconBtns.every((b) => Math.abs(b.w - b.h) <= 1),
    iconBtns.map((b) => b.name + ' ' + b.w + '×' + b.h).join(' '),
  )
  check(
    'ปุ่มซูมเป็นไอคอนแว่นขยาย ไม่ใช่ตัวอักษร + / −',
    await evaluate(`(() => {
      const out = document.querySelector('.doctools [aria-label="ซูมเข้า"]')
      const inn = document.querySelector('.doctools [aria-label="ซูมออก"]')
      return !!out?.querySelector('svg') && !!inn?.querySelector('svg') && out.textContent.trim() === '' 
    })()`),
    'ต้องเป็น <svg> และไม่มีข้อความข้างใน',
  )
  await shot('05-buttons.png')
// ── 11. จอเล็ก: เมนูหน่วยต้องไม่ล้นจอและไม่ตัดข้อความ ──────────────
console.log('\n[11] จอเล็ก — เมนูหน่วยต้องอยู่ในจอและอ่านออก')
/**
 * ⚠️ ผู้ใช้รายงานจากภาพหน้าจอเล็ก: เมนูยื่นออกไปโดนขอบจอ
 *   และข้อความ "ซ่อนไม้บรรทัด" ถูกตัดหายท้าย
 *
 *   เดิมใช้ `left: 0` + `width: 186px` ตายตัว
 *   → ชิดซ้ายของปุ่มที่อยู่ทางขวา เมนูจึงยื่นไปขวาโดนขอบจอ
 *   → กว้างตายตัว พอฟอนต์เรนเดอร์ใหญ่ขึ้นข้อความยาว ๆ ก็โดนตัด
 *   แก้เป็น `right: 0` + `min-width` (ให้กล่องกว้างตามเนื้อหาจริง)
 *
 *   ⚠️ ต้องวัดที่**จอเล็กจริง** ไม่ใช่จอกว้าง
 *      ที่ 1600px เมนูไม่มีทางล้นเลย ข้อนี้จะผ่านมั่วตลอด
 */
for (const narrow of [390, 579]) {
  await send('Emulation.setDeviceMetricsOverride', {
    width: narrow,
    height: 844,
    deviceScaleFactor: 1,
    mobile: false,
  })
  await sleep(700)
  // จอแคบปุ่มไม้บรรทัดยังอยู่ (ซ่อนแค่ข้อความ) — เปิดเมนูได้ตามปกติ
  await clickTestId('ruler-toggle')
  const opened = await waitFor("!!document.querySelector('.rulpick')", 5000)
  check(`จอ ${narrow}px · เปิดเมนูได้`, opened)
  await sleep(400) // รอ fade-in ก่อนถ่าย
  const box = await evaluate(`(() => {
    const el = document.querySelector('.rulpick')
    if (!el) return null
    const r = el.getBoundingClientRect()
    const opts = [...el.querySelectorAll('.rulpick__opt')].map((o) => ({
      id: o.dataset.testid ?? '',
      // scrollWidth > clientWidth = ข้อความล้นกรอบภายใน
      clipped: o.scrollWidth - o.clientWidth,
      cx: Math.round(o.getBoundingClientRect().x + o.getBoundingClientRect().width / 2),
    }))
    return { left: Math.round(r.left), right: Math.round(r.right), w: Math.round(r.width), cx: Math.round(r.x + r.width / 2), vw: innerWidth, opts }
  })()`)
  check(`จอ ${narrow}px · เมนูอยู่ในจอ (ไม่ล้นขวา)`, box && box.right <= box.vw + 0.5, box ? `ขวา ${box.right} / จอ ${box.vw}px` : 'ไม่พบเมนู')
  check(`จอ ${narrow}px · เมนูไม่ล้นซ้าย`, box && box.left >= -0.5, box ? `ซ้าย ${box.left}px` : 'ไม่พบเมนู')
  const clipped = box ? box.opts.filter((o) => o.clipped > 0) : []
  check(`จอ ${narrow}px · ไม่มีตัวเลือกไหนถูกตัดข้อความ`, clipped.length === 0, box ? box.opts.map((o) => `${o.id}:${o.clipped}px`).join(' ') : '')
  /**
   * ชื่อหน่วยต้อง**ตรงกลาง** (ผู้ใช้เลือกแบบนี้จากสองทาง: ชิดซ้าย หรือ ตรงกลาง)
   * เทียบกึ่งกลางของแต่ละแถวกับกึ่งกลางกล่อง ต่างกันเกิน 2px = ไม่ตรงกลาง
   * เช็ค**ทุกแถว** เพราะรายที่มีเครื่องหมาย ✓ เคยดูเลื่อนกว่ารายที่ไม่มี
   */
  const offCenter = box ? box.opts.filter((o) => Math.abs(o.cx - box.cx) > 2) : []
  check(`จอ ${narrow}px · ชื่อทุกแถวตรงกลางกล่อง`, offCenter.length === 0, box ? box.opts.map((o) => `${o.id}:${o.cx - box.cx}`).join(' ') : '')
  await shot(`06-narrow-${narrow}.png`)
  // ปิดเมนูก่อนวัดจอถัดไป
  await evaluate("document.querySelector('[data-testid=\"ruler-toggle\"]')?.click()")
  await sleep(250)
}
// คืนความกว้างจอเดิม ไม่งั้นภาพหลังจากนี้จะเล็กไปเรื่อย
await send('Emulation.setDeviceMetricsOverride', {
  width: 1600,
  height: 1000,
  deviceScaleFactor: 1,
  mobile: false,
})
await sleep(500)

}
// ── เก็บกวาด — คืนฟอร์มแม่แบบให้เป็นสภาพก่อนสคริปต์นี้ ────────────
await restoreForm(H, key, formSnap)
await send('Browser.close').catch(() => {})
chrome.kill()
await redis.del(`session:${sid}`)
redis.disconnect()

console.log(`\n── ผ่าน ${pass} · ไม่ผ่าน ${fail} · ข้าม ${skip} ─────────────────────`)
console.log(`ภาพ: ${OUT.pathname}\n`)
process.exit(fail ? 1 : 0)
