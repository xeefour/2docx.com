/**
 * ตรวจว่าหน้าพรีวิว "เต็มความกว้าง" และสลับไป "พอดีทั้งหน้า" ได้ — ผู้ใช้ต้องเลือกเองได้
 *
 *   node --env-file=.env tools/test-fit-page.mjs
 *
 * ── ปัญหาที่ต้องการแก้ ────────────────────────────────────────
 * รอบแรกกระดาษคำนวณจาก**ความกว้าง**อย่างเดียว พอกล่องสูงไม่ถึงสัดส่วน A4 กระดาษก็ล้นลง
 * → มี scrollbar ทั้งสองทาง ผู้ใช้เห็นไม่ครบหน้า
 *
 * แก้เป็น "พอดีทั้งหน้า" (contain) แล้วกระดาษเล็กลงมาก
 * → บนจอกว้างแต่ต่ำ กระดาษเหลือราว 53% ของกว้าง อ่านไม่ออก เสียพื้นที่ข้างทิ้ง
 *
 * สุดท้ายเลยให้**ผู้ใช้เป็นคนเลือก** เพราะคนหนึ่งอยากอ่านตัวอักษร
 * อีกคนอยากเห็นภาพรวมทั้งหน้า และความเหมาะกันขึ้นกับขนาดจอด้วย
 *
 * ── สิ่งที่ต้องผ่าน ────────────────────────────────────────────
 * 1. ค่าเริ่มต้น = เต็มความกว้างที่มี (ไม่ล้นแนวนอน)
 * 2. กด "พอดีหน้า" → เห็นทั้งหน้า ไม่มี scrollbar แนวตั้ง (รวมตอนเปิดไม้บรรทัด)
 * 3. กดกลับ → กลับเป็นเต็มความกว้าง
 * 4. ซูมเข้า/ออกยังทำงาน และเปอร์เซ็นต์ตรงกับขนาดจริง
 * 5. จอเตี้ย/จอแคบต้องไม่มีกระดาษล้นแนวนอน
 */
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Redis } from 'ioredis'
import { keyOf, pickTemplate, TEST_TEMPLATES } from './lib/pick-template.mjs'
import { FILL_FIELDS_JS, importTags, restoreForm, snapshotForm } from './lib/studio-seed.mjs'

const CHROME = process.env.CHROME_PATH ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const PORT = 9351
const WEB = 'http://localhost:3000'
const API = 'http://127.0.0.1:4001'
const OUT = new URL('../tests/nav-status/output-fit-page/', import.meta.url)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
mkdirSync(OUT, { recursive: true })

let pass = 0
let fail = 0
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`)
  ok ? pass++ : fail++
}

const redis = new Redis(process.env.VALKEY_URL)
const sid = `fitpage-${Date.now()}`
await redis.set(
  `session:${sid}`,
  JSON.stringify({ sub: sid, name: 'ผู้ทดสอบพอดีหน้า', email: 'fitpage@test.local', avatar: '' }),
  'EX',
  1800,
)
const H = { cookie: `docgen_session=${sid}`, 'content-type': 'application/json' }

/**
 * ⚠️ ใช้แม่แบบ **1 หน้า** เสมอ
 *    เอกสารหลายหน้าเปิดแถบรูปย่อ (`.docstrip`) ด้านล่างภายในกล่องเดียวกัน
 *    ทำให้พื้นที่ว่างลดลง แล้วตัวเลขที่วัดไม่ได้แปลว่ากล่องพอดี
 */
const tpl = await pickTemplate(H, [TEST_TEMPLATES.onepage])
const seedKey = keyOf(tpl)
const formSnap = await snapshotForm(H, seedKey)
const seed = await importTags(H, tpl)
console.log(`แม่แบบ: ${tpl.name} — seed ${seed.ok ? 'สำเร็จ' : 'ล้มเหลว ' + seed.status}`)
if (!seed.ok) {
  console.log('! สร้างช่องกรอกไม่ได้ — เรนเดอร์จะไม่ผ่าน validation')
}

const profile = mkdtempSync(join(tmpdir(), 'cdp-fitpage-'))
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
    const page = list.find((x) => x.type === 'page')
    if (page) wsUrl = page.webSocketDebuggerUrl
  } catch { /* ยังไม่พร้อม */ }
}
if (!wsUrl) {
  console.log('✗ ต่อ Chrome DevTools ไม่ได้')
  chrome.kill()
  await redis.del(`session:${sid}`)
  redis.disconnect()
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
const waitFor = async (expr, timeoutMs = 25000, step = 150) => {
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
const viewport = async (w, h) => {
  await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false })
  await sleep(400)
}
const clickSelector = async (selector) => {
  const box = await evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)})
    if (!el || el.disabled) return null
    el.scrollIntoView({ block: 'center' })
    const r = el.getBoundingClientRect()
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
  })()`)
  if (!box) return false
  for (const type of ['mousePressed', 'mouseReleased'])
    await send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 })
  return true
}
const clickText = async (text, selector = 'button') => {
  const box = await evaluate(`(() => {
    const el = [...document.querySelectorAll(${JSON.stringify(selector)})]
      .find((x) => (x.textContent || '').trim().includes(${JSON.stringify(text)}))
    if (!el) return null
    el.scrollIntoView({ block: 'center' })
    const r = el.getBoundingClientRect()
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
  })()`)
  if (!box) return false
  for (const type of ['mousePressed', 'mouseReleased'])
    await send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 })
  return true
}

/**
 * ขนาดกล่องพรีวิว + กระดาษ + scrollbar + เปอร์เซ็นต์ที่แสดง
 * ⚠️ ต้องวัดความกว้างกระดาษจาก `.docpage` ไม่ใช่พ่อ canvas (ห้ามวนวง)
 */
const measure = () =>
  evaluate(`(() => {
    const host = document.querySelector('.docpage')
    const c = document.querySelector('.docpage .docstage__page canvas')
    const pct = document.querySelector('.doctools .mono')
    const fit = document.querySelector('[data-testid="zoom-fit"]')
    if (!host || !c) return null
    const hr = host.getBoundingClientRect()
    const cr = c.getBoundingClientRect()
    return {
      hostW: host.clientWidth, hostH: host.clientHeight,
      scrollW: host.scrollWidth, scrollH: host.scrollHeight,
      canvasW: Math.round(cr.width), canvasH: Math.round(cr.height),
      bmpW: c.width, bmpH: c.height,
      pct: (pct?.textContent || '').trim(),
      mode: fit?.dataset.mode ?? '',
      fitLabel: (fit?.textContent || '').trim(),
      ruler: !!document.querySelector('.rul--h'),
    }
  })()`)

/**
 * รอให้ pdf.js วาดเสร็จ
 *
 * ⚠️ ห้ามใช้เกณฑ์กว้าง 400px เหมือนเทสต์อื่น
 *    ตอนนี้กระดาษถูกย่อให้พอดีกล่อง บนจอเตี้ยกว้างแค่ ~110px ได้
 *    เกณฑ์ 400px จะผ่าน**ไม่ได้แม้กระดาษวาดเสร็จแล้ว** แล้วไปตกข้ออื่นเป็นวง
 *
 * ⚠️ ต้องกัน `<canvas>` ที่ยังไม่เคยวาด (ค่าเริ่มต้น 300×150)
 *    ด้วยการเช็คส่วนสูง > 200 (A4 แนวตั้งสูงกว่ากว้างเสมอ)
 */
const waitDrawn = (timeoutMs = 90000) =>
  waitFor(
    "(() => { const c = document.querySelector('.docpage .docstage__page canvas'); return !!c && c.width > 100 && c.height > 200 })()",
    timeoutMs,
    250,
  )

const renderNow = async () => {
  await clickText('เรนเดอร์ตัวอย่าง')
  return waitDrawn()
}

await send('Page.enable')
await send('Runtime.enable')
await viewport(1600, 1000)
await send('Network.setCookie', { name: 'docgen_session', value: sid, url: WEB })
// ⚠️ ต้องปิด cache ไม่งั้นจะวัด JS เก่าแล้วเห็นว่า "แก้ไม่มีผล"
await send('Network.setCacheDisabled', { cacheDisabled: true })

/**
 * เปิดหน้า studio แล้วรอจนรายการแม่แบบขึ้นจริง
 *
 * ⚠️ ครั้งแรกหลังแก้โค้ด Next dev ยัง compile ไม่ทัน หน้าเปิดได้แต่รายการยังไม่มา
 *    ถ้ารอครั้งเดียวแล้วเดินต่อ เทสต์จะไปวัดกล่องที่ยังไม่มีอะไร
 *    แล้วตกเป็น "ไม่มี .docpage" ทั้งชุด ทั้งที่โค้ดปกติดี
 *    → ถ้ารอไม่ขึ้นจริง ๆ ให้โหลดหน้าใหม่อีกรอบ
 */
const openStudio = async () => {
  for (let attempt = 1; attempt <= 3; attempt++) {
    await send('Page.navigate', { url: `${WEB}/studio` })
    const boot = await waitFor("!document.querySelector('.bootveil')", 90000)
    if (boot) {
      const rows = await waitFor("document.querySelectorAll('table tbody tr').length > 0", 45000)
      if (rows) return true
    }
    console.log(`  · รอบที่ ${attempt}: หน้ายังไม่พร้อม (boot=${boot}) — โหลดใหม่`)
  }
  return false
}

console.log('\n[1] เปิดแม่แบบแล้วเรนเดอร์')
check('หน้า studio โหลดได้และมีรายการแม่แบบ', await openStudio())
/**
 * ⚠️ ต้องกดแถวของแม่แบบ**ที่เลือกไว้** ไม่ใช่แถวแรกในตาราง
 *    ไม่งั้นจะไปเปิดแม่แบบของสคริปต์อื่น → ช่องกรอกไม่ตรงที่ seed ไว้
 *    → เรนเดอร์ไม่ผ่าน แล้ววัดอะไรก็ไม่ได้
 */
const openRow = await evaluate(`(() => {
  const row = [...document.querySelectorAll('table tbody tr')]
    .find((tr) => (tr.textContent || '').includes(${JSON.stringify(tpl.name)}))
  const btn = row?.querySelector('button.ghost')
  if (!btn) return null
  btn.scrollIntoView({ block: 'center' })
  const r = btn.getBoundingClientRect()
  return { x: r.x + r.width / 2, y: r.y + r.height / 2, text: (row.textContent || '').trim().slice(0, 40) }
})()`)
check('เจอแถวแม่แบบที่เลือกไว้', !!openRow, openRow?.text ?? tpl.name)
if (openRow) {
  for (const type of ['mousePressed', 'mouseReleased'])
    await send('Input.dispatchMouseEvent', { type, x: openRow.x, y: openRow.y, button: 'left', clickCount: 1 })
  await waitFor("[...document.querySelectorAll('.tabs__tab')].length >= 6", 25000)
  await sleep(400)

  const filled = await evaluate(FILL_FIELDS_JS)
  console.log(`  กรอกข้อมูล ${filled} ช่อง`)
  check('มีช่องให้กรอก', filled > 0, `${filled} ช่อง`)
  await sleep(400)

  const ok = await renderNow()
  check('เรนเดอร์สำเร็จและ pdf.js วาดเสร็จ', ok)
}

console.log('\n[2] จอ 1600×1000 — ค่าเริ่มต้นต้อง "เต็มความกว้าง"')
const m1 = await measure()
if (!m1) {
  check('วัดกล่องพรีวิวได้', false, 'ไม่มี .docpage / canvas')
} else {
  check('วัดกล่องพรีวิวได้', true, `กล่อง ${m1.hostW}×${m1.hostH} · กระดาษ ${m1.canvasW}×${m1.canvasH} · ${m1.pct}`)
  check('เริ่มต้นเป็นโหมดเต็มความกว้าง', m1.mode === 'width', `โหมด "${m1.mode}" · ปุ่มขึ้น "${m1.fitLabel}"`)
  check(
    'ไม่มี scrollbar แนวนอน (กระดาษไม่ล้นความกว้างกล่อง)',
    m1.scrollW <= m1.hostW + 2,
    `เนื้อหา ${m1.scrollW} / กล่อง ${m1.hostW}`,
  )
  check(
    /**
     * ⚠️ "เต็มความกว้าง" แปลว่ากินพื้นที่**ที่ว่างได้** ไม่ใช่กินทั้งกล่อง
     *    ใน `.docpage` ยังมีระยะขอบ 16px ข้าง และเผื่อไม้บรรทัดแนวตั้งอีก 18px
     *    เทียบกับ *พื้นที่ใช้ได้จริง* (กล่อง − ระยะขอบ − ช่อง scrollbar)
     */
    'กระดาษกินพื้นที่ใช้ได้เกือบทั้งหมด (ไม่เหลือช่องว่างข้างที่ควรเต็ม)',
    m1.canvasW >= m1.hostW - 32 - 28 - 12,
    `กระดาษ ${m1.canvasW}px / ใช้ได้ ~${m1.hostW - 32 - (m1.ruler ? 28 : 0)}px`,
  )
  /**
   * ⚠️ กันกระดาษ "สั่น" ระหว่างสองขนาด
   *   ต้นเหตุ: กระดาษวาดเต็ม `clientWidth` → ล้น → scrollbar โผล่ → `clientWidth` หด
   *   → กระดาษแคบลง → scrollbar หาย → กล่องกว้างอีก → วนไป
   *   แก้ที่ CSS ด้วย `scrollbar-gutter: stable both-edges` ต้องวัดซ้ำแล้วได้ค่าเดิม
   */
  await sleep(700)
  const m1b = await measure()
  check(
    'กระดาษนิ่ง ไม่สั่นไปมอระหว่างสองขนาด (กัน scrollbar ชนกันเอง)',
    !!m1b && Math.abs(m1b.canvasW - m1.canvasW) <= 2,
    `${m1.canvasW}px → ${m1b?.canvasW}px`,
  )
  /**
   * ⚠️ ช่อง scrollbar ที่จองไว้ต้องอยู่**ทั้งสองข้าง**
   *    ถ้าจองข้างเดียว (ค่าเริ่มต้นของ `scrollbar-gutter`) กระดาษจะเยื้องไป ~15px
   *    เห็นได้ชัดตอนกระดาษเต็มความกว้าง เพราะไม่เหลือช่องข้างให้กลบ
   */
  const gapLR = await evaluate(`(() => {
    const host = document.querySelector('.docpage')
    const c = document.querySelector('.docpage .docstage__page canvas')
    if (!host || !c) return null
    const hr = host.getBoundingClientRect(), cr = c.getBoundingClientRect()
    return { left: Math.round(cr.x - hr.x), right: Math.round(hr.right - cr.right) }
  })()`)
  check(
    'กระดาษอยู่กลางกล่องพอดี (ช่อง scrollbar จองสองข้าง)',
    !!gapLR && Math.abs(gapLR.left - gapLR.right) <= 2,
    `ซ้าย ${gapLR?.left}px · ขวา ${gapLR?.right}px`,
  )
  check(
    'เปอร์เซ็นต์ที่แสดงเป็นตัวเลขจริง ไม่ใช่ 100% ปลอม',
    /^\d{1,3}%$/.test(m1.pct) && m1.pct !== '100%',
    `แสดง "${m1.pct}"`,
  )
  await shot('01-width-1600x1000.png')
}

console.log('\n[3] เปิดไม้บรรทัด — ต้องไม่ล้นแนวนอน (ไม้บรรทัดกินความกว้างไป 18px)')
await clickSelector('[data-testid="ruler-toggle"]')
await sleep(900)
const mRuler = await measure()
if (mRuler) {
  check('ไม้บรรทัดแสดงจริง', mRuler.ruler, '')
  check(
    'เปิดไม้บรรทัดแล้วยังไม่ล้นแนวนอน',
    mRuler.scrollW <= mRuler.hostW + 2,
    `เนื้อหา ${mRuler.scrollW} / กล่อง ${mRuler.hostW} · กระดาษ ${mRuler.canvasW}px`,
  )
  check(
    'กระดาษย่อลงให้เหลือที่ให้ไม้บรรทัด',
    mRuler.canvasW < m1.canvasW,
    `${m1.canvasW}px → ${mRuler.canvasW}px`,
  )
}
await shot('02-ruler-on.png')
await clickSelector('[data-testid="ruler-toggle"]')
await sleep(900)

console.log('\n[4] กด "พอดีหน้า" — ต้องเห็นทั้งหน้า ไม่มี scrollbar แนวตั้ง')
check('มีปุ่มสลับโหมด', await evaluate('!!document.querySelector(\'[data-testid="zoom-fit"]\')'))
check(
  'ป้ายปุ่มบอกสิ่งที่จะเกิดเมื่อกด ไม่ใช่สถานะปัจจุบัน',
  m1?.fitLabel === 'พอดีหน้า',
  `ป้าย "${m1?.fitLabel}"`,
)
const fitOk = await clickSelector('[data-testid="zoom-fit"]')
check('กดปุ่มพอดีหน้าได้', fitOk)
await sleep(1200)
const m3 = await measure()
if (m3) {
  check('สลับเป็นโหมดพอดีทั้งหน้าแล้ว', m3.mode === 'page', `โหมด "${m3.mode}"`)
  check(
    'ไม่มี scrollbar แนวตั้ง ← หัวใจของโหมดนี้',
    m3.scrollH <= m3.hostH + 2,
    `เนื้อหา ${m3.scrollH} / กล่อง ${m3.hostH}`,
  )
  check(
    'ไม่มี scrollbar แนวนอน',
    m3.scrollW <= m3.hostW + 2,
    `เนื้อหา ${m3.scrollW} / กล่อง ${m3.hostW}`,
  )
  check(
    'กระดาษย่อลงจากโหมดเต็มความกว้าง (แลกความกว้างมาเป็นความสูง)',
    m3.canvasW < m1.canvasW && m3.canvasH < m1.canvasH,
    `${m1.canvasW}×${m1.canvasH} → ${m3.canvasW}×${m3.canvasH}`,
  )
  check('ป้ายปุ่มเปลี่ยนเป็นทางกลับ', m3.fitLabel === 'เต็มความกว้าง', `ป้าย "${m3.fitLabel}"`)
}
await shot('03-fit-page.png')

console.log('\n[5] กดกลับ — ต้องกลับเป็นเต็มความกว้าง')
await clickSelector('[data-testid="zoom-fit"]')
await sleep(1200)
const mBack = await measure()
if (mBack && m1) {
  check('กลับเป็นโหมดเต็มความกว้าง', mBack.mode === 'width', `โหมด "${mBack.mode}"`)
  check(
    'กระดาษกลับมากว้างเท่าเดิม',
    Math.abs(mBack.canvasW - m1.canvasW) <= 2,
    `${m1.canvasW}px → ${mBack.canvasW}px`,
  )
  check('ป้ายปุ่มกลับเป็น "พอดีหน้า"', mBack.fitLabel === 'พอดีหน้า', `ป้าย "${mBack.fitLabel}"`)
}
await shot('04-back-to-width.png')

console.log('\n[6] ซูมเข้า 2 ครั้ง — ต้องใหญ่ขึ้นจริงและเลื่อนดูได้')
const hasZoomIn = await evaluate('!!document.querySelector(\'[aria-label="ซูมเข้า"]\')')
check('ปุ่มซูมเข้ามี aria-label (กดด้วยการอ่านหน้าจอได้)', hasZoomIn)
const beforeZoom = await measure()
for (let i = 0; i < 2; i++) {
  await clickSelector('[aria-label="ซูมเข้า"]')
  await sleep(1200)
}
const m2 = await measure()
if (m2 && beforeZoom) {
  check('กระดาษใหญ่ขึ้นจริงหลังซูม', m2.canvasW > beforeZoom.canvasW, `${beforeZoom.canvasW}px → ${m2.canvasW}px`)
  check(
    'เปอร์เซ็นต์โตเป็น 2 เท่าของเดิม (zoom = 2)',
    Math.abs(Number.parseInt(m2.pct) - Number.parseInt(beforeZoom.pct) * 2) <= 2,
    `${beforeZoom.pct} → ${m2.pct}`,
  )
  check(
    'ซูมแล้วเลื่อนดูได้ (เกิด scrollbar ได้ ไม่ใช่ห้ามซูม)',
    m2.scrollH > m2.hostH + 2 || m2.scrollW > m2.hostW + 2,
    `เนื้อหา ${m2.scrollW}×${m2.scrollH} / กล่อง ${m2.hostW}×${m2.hostH}`,
  )
}
await shot('05-zoomed.png')
/**
 * ⚠️ คืนซูมด้วยปุ่ม "ซูมออก" ห้าครั้ง 2 ครั้ง **อย่ากดปุ่มสลับโหมด**
 *    ปุ่มนั้นเปลี่ยนโหมดด้วย → ถ้ากดเพื่อคืนซูม ขั้นถัดไปจะวัดผิดโหมด
 *    แล้วไปตั้งข้อความว่า "พอดีหน้าต้องไม่ล้น" ทั้งที่กำลังอยู่โหมดเต็มความกว้าง
 */
for (let i = 0; i < 2; i++) {
  await clickSelector('[aria-label="ซูมออก"]')
  await sleep(900)
}

console.log('\n[7] จอเตี้ยกว่า 1280×720 — ทั้งสองโหมดต้องไม่ล้นแนวนอน')
await viewport(1280, 720)
await sleep(900)
const m4 = await measure()
if (m4) {
  check('จอเตี้ย: วัดได้', true, `กล่อง ${m4.hostW}×${m4.hostH} · กระดาษ ${m4.canvasW}×${m4.canvasH} · ${m4.pct} · โหมด ${m4.mode}`)
  check('จอเตี้ย: ยังอยู่โหมดเต็มความกว้าง (ไม่ถูกสลับโดยไม่ตั้งใจ)', m4.mode === 'width', `โหมด "${m4.mode}"`)
  check('จอเตี้ย: โหมดเต็มความกว้างไม่ล้นแนวนอน', m4.scrollW <= m4.hostW + 2, `เนื้อหา ${m4.scrollW} / กล่อง ${m4.hostW}`)
  await clickSelector('[data-testid="zoom-fit"]')
  await sleep(1200)
  const m4b = await measure()
  if (m4b) {
    check('จอเตี้ย: สลับเป็นพอดีหน้าได้', m4b.mode === 'page', `โหมด "${m4b.mode}"`)
    check(
      'จอเตี้ย: โหมดพอดีหน้าไม่ล้นสองทาง',
      m4b.scrollW <= m4b.hostW + 2 && m4b.scrollH <= m4b.hostH + 2,
      `เนื้อหา ${m4b.scrollW}×${m4b.scrollH} / กล่อง ${m4b.hostW}×${m4b.hostH} · กระดาษ ${m4b.canvasW}×${m4b.canvasH}`,
    )
  }
  await clickSelector('[data-testid="zoom-fit"]')
  await sleep(900)
}
await shot('06-narrow-height-1280x720.png')

console.log('\n[8] จอแคบ 900×1000 — ต้องไม่ล้นสองทาง และกล่องต้องมีความสูงตายตัว')
await viewport(900, 1000)
await sleep(900)
const m5 = await measure()
if (m5) {
  check('จอแคบ: ไม่มี scrollbar แนวนอน', m5.scrollW <= m5.hostW + 2, `เนื้อหา ${m5.scrollW} / กล่อง ${m5.hostW}`)
  check(
    'จอแคบ: กล่องสูงตายตัว ไม่ใช่สูงตามกระดาษ (กันวงจรกระดาษย่อตัวเอง)',
    m5.hostH >= 200,
    `กล่องสูง ${m5.hostH}px · กระดาษ ${m5.canvasW}×${m5.canvasH}`,
  )
}
await shot('07-narrow-900.png')

// ── เก็บกวาด — คืนฟอร์มแม่แบบเป็นสภาพก่อนสคริปต์นี้ ────────────
await restoreForm(H, seedKey, formSnap)
await fetch(`${API}/api/access/${seedKey}`, { method: 'DELETE', headers: H }).catch(() => {})

await send('Browser.close').catch(() => {})
chrome.kill()
await redis.del(`session:${sid}`)
redis.disconnect()

console.log(`\n── ผ่าน ${pass} · ไม่ผ่าน ${fail} ─────────────────────\n`)
process.exit(fail ? 1 : 0)
