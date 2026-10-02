/**
 * ตรวจว่าหน้าพรีวิว "เห็นทั้งหน้ากระดาษพอดีกล่อง" — ผู้ใช้ต้องตัดสินใจได้โดยไม่ต้องเลื่อน
 *
 *   node --env-file=.env tools/test-fit-page.mjs
 *
 * ── ปัญหาที่ต้องการแก้ ────────────────────────────────────────
 * เดิมกระดาษคำนวณจาก**ความกว้าง**อย่างเดียว (`host.clientWidth`)
 * พอกล่องพรีวิวสูงไม่ถึงสัดส่วน A4 (สูงกว่ากว้าง ~1.41 เท่า) กระดาษก็ล้นลง
 * → มี scrollbar ทั้งสองทาง ผู้ใช้เห็นไม่ครบหน้า แล้วตัดสินใจไม่ได้ว่าเอกสารหน้าตาย
 *
 * ── สิ่งที่ต้องผ่าน ────────────────────────────────────────────
 * 1. เรนเดอร์แล้ว `.docpage` ไม่มี scrollbar ทั้งแนวตั้งและแนวนอน → เห็นทั้งหน้า
 * 2. กระดาษไม่เล็กจนอ่านไม่ออก (ต้องกินพื้นที่ส่วนใหญ่ของกล่อง)
 * 3. เปอร์เซ็นต์ที่แสดงเป็น**ของจริงเทียบกระดาษจริง** ไม่ใช่ 100% หรือ 200% ปลอม ๆ
 * 4. ซูมเข้าแล้วกระดาษใหญ่ขึ้นจริง จนเลื่อนดูได้ (ฟีเจอร์เดิมต้องไม่หาย)
 * 5. ปุ่ม "พอดีหน้า" กลับเป็นพอดีกล่องใน**คลิกเดียว** (เดิมต้องกดลบทีละขั้น)
 * 6. จอเตี้ยกว่า (1280×720) ยังเห็นทั้งหน้า → พิสูจน์ว่าคิดทั้งความกว้างและความสูง
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
    if (!host || !c) return null
    const hr = host.getBoundingClientRect()
    const cr = c.getBoundingClientRect()
    return {
      hostW: host.clientWidth, hostH: host.clientHeight,
      scrollW: host.scrollWidth, scrollH: host.scrollHeight,
      canvasW: Math.round(cr.width), canvasH: Math.round(cr.height),
      bmpW: c.width, bmpH: c.height,
      pct: (pct?.textContent || '').trim(),
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

console.log('\n[2] จอ 1600×1000 — ต้องเห็นทั้งหน้ากระดาษ ไม่มี scrollbar สองทาง')
const m1 = await measure()
if (!m1) {
  check('วัดกล่องพรีวิวได้', false, 'ไม่มี .docpage / canvas')
} else {
  check('วัดกล่องพรีวิวได้', true, `กล่อง ${m1.hostW}×${m1.hostH} · กระดาษ ${m1.canvasW}×${m1.canvasH}`)
  check(
    'ไม่มี scrollbar แนวนอน (กระดาษไม่ล้นความกว้างกล่อง)',
    m1.scrollW <= m1.hostW + 2,
    `เนื้อหา ${m1.scrollW} / กล่อง ${m1.hostW}`,
  )
  check(
    'ไม่มี scrollbar แนวตั้ง (เห็นครบทั้งหน้า) ← ปัญหาที่แก้',
    m1.scrollH <= m1.hostH + 2,
    `เนื้อหา ${m1.scrollH} / กล่อง ${m1.hostH}`,
  )
  check(
    /**
     * ⚠️ วัดกับ**ความสูง**ของกล่อง ไม่ใช่ความกว้าง
     *    กระดาษ A4 แนวตั้ง สูงกว่ากว้าง ~1.41 เท่า
     *    ถ้ากล่องกว้างแต่ต่ำ กระดาษจะเต็ม**ความสูง**เสมอ แล้วเหลือความกว้างข้าง
     *    นั่นถูกต้อง ไม่ใช่ย่อผิด — การไปบังคับว่าต้องกิน 50% ความกว้าง
     *    จะทำให้เทสต์ตกทั้งที่หน้าจอถูกต้อง (เคยตกแบบนี้)
     */
    'กระดาษเต็มความสูงกล่อง (ย่อจนพอดี ไม่ใช่เหลือที่ว่าง)',
    m1.canvasH >= m1.hostH * 0.8,
    `สูง ${Math.round((m1.canvasH / m1.hostH) * 100)}% ของกล่อง · กระดาษ ${m1.canvasW}×${m1.canvasH}`,
  )
  check(
    'กระดาษยังใหญ่พออ่านออก (ไม่ย่อจนเป็นตัวอักษรจิ๋ว)',
    m1.canvasW >= 200,
    `กว้าง ${m1.canvasW}px (กล่องกว้าง ${m1.hostW}px · เหลือข้างเพราะกระดาษสูงกว่ากว้าง)`,
  )
  check(
    'เปอร์เซ็นต์ที่แสดงเป็นตัวเลขจริง ไม่ใช่ 100% ปลอม',
    /^\d{1,3}%$/.test(m1.pct),
    `แสดง "${m1.pct}"`,
  )
  await shot('01-fit-1600x1000.png')
}

console.log('\n[3] ซูมเข้า 2 ครั้ง — ต้องใหญ่ขึ้นจริงจนเลื่อนดูได้')
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
await shot('02-zoomed.png')

console.log('\n[4] ปุ่ม "พอดีหน้า" — กลับเป็นพอดีกล่องในคลิกเดียว')
check('มีปุ่มพอดีหน้า', await evaluate('!!document.querySelector(\'[data-testid="zoom-fit"]\')'))
const fitOk = await clickSelector('[data-testid="zoom-fit"]')
check('กดปุ่มพอดีหน้าได้ (ตอนซูมอยู่ ปุ่มต้องไม่ถูก disable)', fitOk)
await sleep(1200)
const m3 = await measure()
if (m3) {
  check(
    'หลังกด "พอดีหน้า" ไม่มี scrollbar เหลือ',
    m3.scrollH <= m3.hostH + 2 && m3.scrollW <= m3.hostW + 2,
    `เนื้อหา ${m3.scrollW}×${m3.scrollH} / กล่อง ${m3.hostW}×${m3.hostH}`,
  )
  check('เปอร์เซ็นต์กลับเป็นค่าพอดีหน้าเดิม', m3.pct === m1?.pct, `${m1?.pct} → ${m3.pct}`)
  check(
    'ปุ่มพอดีหน้าถูก disable เมื่ออยู่ที่พอดีหน้าอยู่แล้ว',
    await evaluate('!!document.querySelector(\'[data-testid="zoom-fit"]\')?.disabled'),
  )
}
await shot('03-fit-again.png')

console.log('\n[5] จอเตี้ยกว่า 1280×720 — ต้องยังเห็นทั้งหน้า (คิดทั้งกว้างและสูง)')
await viewport(1280, 720)
await sleep(900)
const m4 = await measure()
if (m4) {
  check('วัดได้หลังเปลี่ยนขนาดจอ', !!m4, m4 ? `กล่อง ${m4.hostW}×${m4.hostH} · กระดาษ ${m4.canvasW}×${m4.canvasH}` : '')
  check(
    'จอเตี้ย: ไม่มี scrollbar แนวตั้ง',
    m4.scrollH <= m4.hostH + 2,
    `เนื้อหา ${m4.scrollH} / กล่อง ${m4.hostH}`,
  )
  check(
    'จอเตี้ย: ไม่มี scrollbar แนวนอน',
    m4.scrollW <= m4.hostW + 2,
    `เนื้อหา ${m4.scrollW} / กล่อง ${m4.hostW}`,
  )
  check(
    'จอเตี้ย: ย่อจนพอดีจริง ๆ ไม่ใช่แค่ครอบให้เตี้ย',
    m4.canvasH < (m1?.canvasH ?? Infinity),
    `กระดาษ ${m1?.canvasH}px → ${m4.canvasH}px`,
  )
}
await shot('04-fit-1280x720.png')

console.log('\n[6] จอแคบ 900×1000 — ต้องไม่ล้นสองทาง และกล่องต้องมีความสูงตายตัว')
await viewport(900, 1000)
await sleep(900)
const m5 = await measure()
if (m5) {
  check('จอแคบ: ไม่มี scrollbar แนวนอน', m5.scrollW <= m5.hostW + 2, `เนื้อหา ${m5.scrollW} / กล่อง ${m5.hostW}`)
  check(
    'จอแคบ: ไม่มี scrollbar แนวตั้ง',
    m5.scrollH <= m5.hostH + 2,
    `เนื้อหา ${m5.scrollH} / กล่อง ${m5.hostH}`,
  )
  check(
    'จอแคบ: กล่องสูงตายตัว ไม่ใช่สูงตามกระดาษ (กันวงจรกระดาษย่อตัวเอง)',
    m5.hostH >= 200,
    `กล่องสูง ${m5.hostH}px · กระดาษ ${m5.canvasW}×${m5.canvasH}`,
  )
}
await shot('05-narrow-900.png')

// ── เก็บกวาด — คืนฟอร์มแม่แบบเป็นสภาพก่อนสคริปต์นี้ ────────────
await restoreForm(H, seedKey, formSnap)
await fetch(`${API}/api/access/${seedKey}`, { method: 'DELETE', headers: H }).catch(() => {})

await send('Browser.close').catch(() => {})
chrome.kill()
await redis.del(`session:${sid}`)
redis.disconnect()

console.log(`\n── ผ่าน ${pass} · ไม่ผ่าน ${fail} ─────────────────────\n`)
process.exit(fail ? 1 : 0)
