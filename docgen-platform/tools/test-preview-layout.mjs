/**
 * ตรวจเลย์เอาต์หน้าแก้แม่แบบ — ตัวอย่างเอกสารต้องอยู่ครึ่งขวาและไม่ต้องเลื่อนหา
 *
 *   node --env-file=.env tools/test-preview-layout.mjs
 *
 * ── ปัญหาที่ต้องการแก้ ────────────────────────────────────────
 * เดิมตัวอย่างเอกสารถูกวาง**ใต้**ฟอร์มในคอลัมน์ซ้ายเดียวกัน
 * ฟอร์มยิ่งยาว ตัวอย่างยิ่งถูกดันลงใต้ขอบจอ → ผู้ใช้ต้องเลื่อนหน้าจอถึงจะเห็น
 *
 * ── สิ่งที่ต้องผ่าน ────────────────────────────────────────────
 * 1. ตัวอย่างเอกสารอยู่ครึ่งขวาของหน้า (ไม่ใช่ทับล่างฟอร์ม)
 * 2. ที่ scroll = 0 ตัวอย่างต้อง**อยู่ในจอ**ทั้งหมด ไม่ต้องเลื่อน
 * 3. เลื่อนลงไปแล้วตัวอย่างยังอยู่ในจอ (sticky ทำงาน)
 * 4. เรนเดอร์แล้วรูปเอกสารอยู่ในคอลัมน์นั้น ไม่ล้นความกว้าง
 * 5. จอแคบ (< 1080px) → ซ้อนเป็นคอลัมน์เดียว ตัวอย่างลงล่างฟอร์ม
 * 6. ซ่อน AI แล้วฟอร์มยังเต็มคอลัมน์ซ้าย ไม่พัง
 */
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Redis } from 'ioredis'

const CHROME = process.env.CHROME_PATH ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const PORT = 9345
const WEB = 'http://localhost:3000'
const OUT = new URL('../tests/nav-status/output-preview-layout/', import.meta.url)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
mkdirSync(OUT, { recursive: true })

let pass = 0
let fail = 0
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`)
  ok ? pass++ : fail++
}

const redis = new Redis(process.env.VALKEY_URL)
const sid = `layout-${Date.now()}`
await redis.set(
  `session:${sid}`,
  JSON.stringify({ sub: sid, name: 'ผู้ทดสอบเลย์เอาต์', email: 'layout@test.local', avatar: '' }),
  'EX',
  1800,
)

/**
 * ⚠️ สคริปต์นี้เปิด "แม่แบบแรกในรายการ" เพื่อวัดเลย์เอาต์
 *    แต่แม่แบบแรกคือแม่แบบที่สคริปต์อื่น (`test-studio-ui`, `test-field-ai`)
 *    ใช้ทดสอบแล้ว **ลบช่องกรอกทิ้ง** ด้วยขั้น "เก็บกวาด"
 *    พอช่องหาย การเรนเดอร์จะติด validation ("ช่องกรอกไม่ครบ") แล้วไม่มี canvas ให้วัด
 *    เทสต์ก็จะตกไป 12 ข้อโดยที่ส่วนพรีวิวไม่ได้พังจริง
 *
 *    แก้โดยให้สคริปต์สร้างช่องกรอกจาก**แท็กจริงของแม่แบบ**ก่อนเปิดเสมอ
 *    (ใช้ `import-tags` ไม่ต้องเดาว่าแม่แบบนี้ต้องมีช่องอะไรบ้าง)
 *    แล้วลบทิ้งตอนเก็บกวาด คืนสภาพเดิม
 */
const H = { cookie: `docgen_session=${sid}`, 'content-type': 'application/json' }
const API = 'http://127.0.0.1:4001'
const items = (await (await fetch(`${API}/api/templates`, { headers: H })).json()).items ?? []
const first = items[0]
const seedKey = String(first?.id ?? '')
if (first?.versionId) {
  const r = await fetch(`${API}/api/form/${seedKey}/import-tags`, {
    method: 'POST',
    headers: H,
    body: JSON.stringify({ versionId: first.versionId }),
  })
  console.log(
    `เตรียมช่องกรอกจากแท็กจริงของแม่แบบแรก (${first.name}) — ${r.ok ? 'สำเร็จ' : 'ล้มเหลว ' + r.status}`,
  )
} else {
  console.log('! หา versionId ของแม่แบบแรกไม่ได้ — เทสต์อาจตกเพราะช่องกรอกไม่ครบ')
}

const profile = mkdtempSync(join(tmpdir(), 'cdp-layout-'))
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
  await sleep(250)
}

/** กล่องของตัวอย่างเอกสาร + ขนาดจอ ณ ตอนนั้น */
const boxOf = (sel) =>
  evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(sel)})
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
             bottom: Math.round(r.bottom), right: Math.round(r.right), vw: innerWidth, vh: innerHeight }
  })()`)

const realClick = async (selector) => {
  const box = await evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)})
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
 * คลิกปุ่มไอคอนด้วยเมาส์จริง
 *
 * ⚠️ ห้ามใช้ `clickText` กับปุ่มไอคอน — มันค้นจาก `textContent`
 *    แต่ปุ่มไอคอนไม่มีข้อความ (มีแต่ SVG) → จะหาไม่เจอแล้วคลิกไม่ทัน
 */
const clickIcon = async (selector) => {
  const box = await evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)})
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

await send('Page.enable')
await send('Runtime.enable')
await viewport(1600, 1000)
await send('Network.setCookie', { name: 'docgen_session', value: sid, url: WEB })
// ⚠️ ต้องปิด cache — Next dev แยก JS เป็น chunk และเบราว์เซอร์จะเก็บไว้
//    ถ้าไม่ปิด แก้โค้ดแล้วรันเทสต์ทันทีจะยังวัดโค้ดเก่า แล้วได้ผลเหมือน "แก้ไม่มีผล"
await send('Network.setCacheDisabled', { cacheDisabled: true })

await send('Page.navigate', { url: `${WEB}/studio` })
await waitFor("!document.querySelector('.bootveil')", 40000)
await waitFor("document.querySelectorAll('table tbody tr').length > 0", 30000)

console.log('\n[1] เปิดแม่แบบ — เลย์เอาต์ก่อนเรนเดอร์')
await realClick('table tbody tr td button.ghost')
// ตอนนี้มีแท็บ 2 ชุด = 2 + 4 = 6 (ซ้าย ฟอร์ม/JSON · ขวา ตัวอย่าง/แม่แบบ/ช่องฟอร์ม/ประวัติ)
await waitFor("[...document.querySelectorAll('.tabs__tab')].length >= 6", 25000)
await sleep(400)

const form = await boxOf('.editor-col')
const prev = await boxOf('.editor-preview')
check('มีทั้งคอลัมน์ฟอร์มและคอลัมน์ตัวอย่าง', !!form && !!prev, form && prev ? `ฟอร์ม x=${form.x} · ตัวอย่าง x=${prev.x}` : 'ไม่ครบ')
check('ตัวอย่างอยู่ฝั่งขวาของฟอร์ม', prev && form && prev.x > form.x, prev && form ? `ฟอร์ม x=${form.x} w=${form.w} · ตัวอย่าง x=${prev.x}` : '')
check('ตัวอย่างอยู่คนละครึ่งจริง ๆ', prev && prev.x >= prev.vw / 2, prev ? `x=${prev.x} · จอ ${prev.vw}` : '')
check('ที่ scroll = 0 ตัวอย่างอยู่ในจอ ไม่ต้องเลื่อน', prev && prev.y >= 0 && prev.bottom <= prev.vh, prev ? `y=${prev.y} ถึง ${prev.bottom} / จอสูง ${prev.vh}` : '')
await shot('01-before-render.png')

console.log('\n[2] กรอกข้อมูลแล้วกดเรนเดอร์ — รูปเอกสารต้องอยู่ในคอลัมน์ขวา')
/**
 * ⚠️ ต้อง**กรอกข้อมูลก่อน** ไม่งั้นปุ่มเรนเดอร์จะไม่ทำงาน
 *    แอปบล็อกการเรนเดอร์เมื่อช่องบังคับยังว่าง ("ช่องกรอกไม่ครบ N ช่อง")
 *    → ถ้าเทสต์แค่กดปุ่มเฉย ๆ จะไม่มี canvas ให้วัด แล้วตกไปหลายข้อ
 *    ทั้งที่พรีวิวไม่ได้พัง (นี่คือพฤติกรรมที่ถูกต้อง)
 */
{
  const filled = await evaluate(`(() => {
    const scope = document.querySelector('.editor-col:not(.editor-col--right)')
    if (!scope) return 0
    const set = (el, v) => {
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement : HTMLInputElement
      Object.getOwnPropertyDescriptor(proto.prototype, 'value').set.call(el, v)
      el.dispatchEvent(new Event('input', { bubbles: true }))
    }
    const fields = [...scope.querySelectorAll('input[type=text], input[type=email], textarea')]
    fields.forEach((el, i) => set(el, 'ทดสอบข้อมูล ' + (i + 1)))
    return fields.length
  })()`)
  console.log(`  กรอกข้อมูล ${filled} ช่อง`)
  check('มีช่องให้กรอกให้กรอก', filled > 0, `${filled} ช่อง`)
  await sleep(500)
}

await clickText('เรนเดอร์ตัวอย่าง')
/**
 * ⚠️ ต้องรอให้ pdf.js **วาดเสร็จ** ไม่ใช่แค่มี element `<canvas>`
 *   canvas ถูกสร้างทันทีแต่ยังกว้าง 0 อยู่ → ถ้ารอแค่ element จะได้ภาพกระดาษเปล่า
 *   แล้วเผลอไป "ผ่าน" ทั้งที่พรีวิวไม่ได้วาดอะไรเลย
 */
const rendered = await waitFor(
  "(() => { const c = document.querySelector('.docpage canvas'); return !!c && c.width > 200 && c.height > 200 })()",
  90000,
)
check('เรนเดอร์สำเร็จและ pdf.js วาดรูปเสร็จแล้ว', rendered)
const canvasSize = await evaluate(
  "(() => { const c = document.querySelector('.docpage canvas'); return c ? c.width + 'x' + c.height : 'ไม่มี canvas' })()",
)
check('canvas มีขนาดจริง (ไม่ใช่ 0 ซึ่งแปลว่ายังไม่ได้วาด)', !canvasSize.includes('x0') && canvasSize !== 'ไม่มี canvas', canvasSize)

const prev2 = await boxOf('.editor-preview')
const canvas = await boxOf('.docpage canvas')
check('กล่องตัวอย่างยังอยู่ฝั่งขวา', prev2 && prev2.x >= prev2.vw / 2, prev2 ? `x=${prev2.x} / จอ ${prev2.vw}` : '')
check('กล่องตัวอย่างยังอยู่ในจอ (ไม่ล้นล่าง)', prev2 && prev2.y >= 0 && prev2.bottom <= prev2.vh + 1, prev2 ? `y=${prev2.y} ถึง ${prev2.bottom} / จอสูง ${prev2.vh}` : '')
check('รูปเอกสารไม่ล้นความกว้างคอลัมน์', canvas && prev2 && canvas.right <= prev2.right + 2, canvas && prev2 ? `รูปถึง ${canvas.right} · กล่องถึง ${prev2.right}` : '')

// หัวการ์ดถูกถอดออกแล้ว → ที่เหลือคือแถบซูมบรรทัดเดียว ต้องไม่สูงเปล่า
const bar = await evaluate(`(() => {
  const el = document.querySelector('.editor-preview .doctools')
  if (!el) return null
  const r = el.getBoundingClientRect()
  return { h: Math.round(r.height), w: Math.round(r.width) }
})()`)
check(
  'แถบซูมสูงเท่าปุ่มเดียว ไม่มีหัวการ์ดส่วนเกิน',
  bar && bar.h < 70,
  bar ? `สูง ${bar.h}px · กว้าง ${bar.w}px` : 'ไม่พบแถบ',
)
await shot('02-after-render.png')

console.log('\n[3] เลื่อนหน้าจอลง — ตัวอย่างต้องยังอยู่ในสายตา (sticky)')
await evaluate('scrollTo(0, document.body.scrollHeight)')
await sleep(500)
const prev3 = await boxOf('.editor-preview')
const scrollY = await evaluate('Math.round(window.scrollY)')
check('เลื่อนลงสุดแล้วตัวอย่างยังอยู่ในจอครบ', prev3 && prev3.y >= 0 && prev3.bottom <= prev3.vh + 1, prev3 ? `scrollY=${scrollY} · ตัวอย่าง y=${prev3.y} ถึง ${prev3.bottom} / จอสูง ${prev3.vh}` : '')
check('ไม่ต้องเลื่อนกลับขึ้นเพื่อดูตัวอย่าง', prev3 && prev3.y >= 0, prev3 ? `y=${prev3.y}` : '')
await shot('03-scrolled-sticky.png')
await evaluate('scrollTo(0, 0)')
await sleep(300)

console.log('\n[4] ซ่อน AI — ฟอร์มต้องเต็มคอลัมน์ซ้าย ไม่พัง')
await clickText('ซ่อน AI')
await sleep(400)
const noAi = await boxOf('.editor-col')
check('แผง AI หายไป', !(await evaluate("!!document.querySelector('.chat')")))
check('คอลัมน์ซ้ายยังกว้างประมาณครึ่งจอ', noAi && noAi.w >= noAi.vw * 0.4, noAi ? `กว้าง ${noAi.w} / จอ ${noAi.vw}` : '')
await shot('04-ai-hidden.png')
await clickText('AI ช่วยกรอก')
await sleep(400)

console.log('\n[5] จอแคบ 900px — ต้องซ้อนเป็นคอลัมน์เดียว')
await viewport(900, 1000)
await sleep(500)
const narrow = await boxOf('.editor-preview')
const narrowForm = await boxOf('.editor-col')
check('จอแคว: ตัวอย่างไม่ได้อยู่ฝั่งขวาแล้ว', narrow && narrow.x < narrow.vw / 2, narrow ? `x=${narrow.x} / จอ ${narrow.vw}` : '')
check('จอแคบ: ตัวอย่างอยู่ใต้ฟอร์ม', narrow && narrowForm && narrow.y > narrowForm.y, narrow && narrowForm ? `ฟอร์ม y=${narrowForm.y} · ตัวอย่าง y=${narrow.y}` : '')
check('จอแคบ: ตัวอย่างกว้างเต็มคอลัมน์', narrow && narrow.w > narrow.vw * 0.85, narrow ? `กว้าง ${narrow.w} / จอ ${narrow.vw}` : '')
await shot('05-narrow-900.png')

console.log('\n[6] กลับจอกว้าง — ต้องกลับเป็นสองครึ่ง')
await viewport(1600, 1000)
await sleep(400)
const wide = await boxOf('.editor-preview')
check('จอกว้าง: ตัวอย่างกลับมาอยู่ครึ่งขวา', wide && wide.x >= wide.vw / 2, wide ? `x=${wide.x} / จอ ${wide.vw}` : '')
await shot('06-wide-again.png')

console.log('\n[7] เมนูดาวน์โหลด — ไอคอนติดแถบซูม · เลือกรูปแบบหลังคลิก')
await viewport(1600, 1000)
await sleep(400)
// ต้องเรนเดอร์ใหม่ก่อน เพราะรอบก่อนสลับจอจนพรีวิวอาจหลุดจาก DOM
const stillHasCanvas = await evaluate("!!document.querySelector('.docpage canvas')")
if (!stillHasCanvas) {
  await clickText('เรนเดอร์ตัวอย่าง')
  await waitFor(
    "(() => { const c = document.querySelector('.docpage canvas'); return !!c && c.width > 200 })()",
    90000,
  )
}

check('ไม่มีหัวข้อ "ตัวอย่างเอกสาร" ในการ์ดพรีวิว', !(await evaluate(
  "(() => { const c = document.querySelector('.editor-preview'); return !!c && c.innerText.includes('ตัวอย่างเอกสาร') })()",
)))
check('ไม่มี dropdown <select> ในการ์ดพรีวิว', !(await evaluate(
  "!!document.querySelector('.editor-preview select')",
)))

const dlBox = await boxOf('.dl__btn')
// ⚠️ ต้องวัดใน `.doctools` — `.docpage` เป็นแค่พื้นที่รูป ไม่ใช่แถบเครื่องมือ
const zoomBox = await boxOf('.doctools .mono')
check('มีปุ่มดาวน์โหลดเป็นไอคอน', !!dlBox, dlBox ? `x=${dlBox.x} y=${dlBox.y} ${dlBox.w}x${dlBox.h}` : 'ไม่พบ')
check('ปุ่มดาวน์โหลดอยู่บรรทัดเดียวกับแถบซูม', dlBox && zoomBox && Math.abs(dlBox.y - zoomBox.y) < 24, dlBox && zoomBox ? `ดาวน์โหลด y=${dlBox.y} · ซูม y=${zoomBox.y}` : 'วัดไม่ได้')
check('ปุ่มดาวน์โหลดอยู่ทางขวาของซูม', dlBox && zoomBox && dlBox.x > zoomBox.x, dlBox && zoomBox ? `ดาวน์โหลด x=${dlBox.x} · ซูม x=${zoomBox.x}` : 'วัดไม่ได้')
check('เมนูยังไม่เปิดก่อนคลิก', !(await evaluate("!!document.querySelector('.dl__pop')")))

await clickIcon('.dl__btn')
const popOpen = await waitFor("!!document.querySelector('.dl__pop')", 8000)
check('คลิกแล้วเมนูรูปแบบโผล่', popOpen)
const options = await evaluate("[...document.querySelectorAll('.dl__opt')].map(b => b.innerText.replace(/\\n+/g,' ').trim())")
check('มีตัวเลือกรูปแบบให้เลือก', options.length >= 2, options.join(' | '))
check('ตัวเลือกมีทั้ง PDF และ Word', options.some((o) => o.includes('PDF')) && options.some((o) => o.includes('Word')), options.join(' | '))
check('เมนูเป็นไอคอน + ชื่อ ไม่ใช่ dropdown', await evaluate("!!document.querySelector('.dl__badge')"))
await shot('07-download-menu.png')

// คลิกที่อื่นต้องปิดเมนู
// ⚠️ ต้องใช้เมาส์จริง — `element.click()` ยิงแค่ event 'click' ไม่ยิง 'mousedown'
//    ซึ่งเป็น event ที่โค้ดใช้ปิดเมนู → เทสต์จะตกทั้งที่ของจริงใช้งานได้
await clickText('รีเซ็ต', 'button').catch(() => {})
await evaluate("document.querySelector('.doctools .mono')?.scrollIntoView({ block: 'center' })")
await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 400, y: 300, button: 'left', clickCount: 1 })
await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 400, y: 300, button: 'left', clickCount: 1 })
const popClosed = await waitFor("!document.querySelector('.dl__pop')", 5000)
check('คลิกที่อื่นแล้วเมนูปิด', popClosed)
await shot('08-menu-closed.png')

// ── กดเลือกรูปแบบแล้วต้องได้ไฟล์จริง ──────────────────────────
console.log('\n[8] เลือกรูปแบบแล้วต้องได้ไฟล์จริง')
const dlDir = mkdtempSync(join(tmpdir(), 'dl-'))
// ให้เบราว์เซอร์ดาวน์โหลดลงโฟลเดอร์ที่ระบุ แทนที่จะเปิด dialog
// (Chrome รุ่นใหม่ใช้ Browser.setDownloadBehavior ไม่ใช่ Page domain แล้ว)
await send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: dlDir })

await clickIcon('.dl__btn')
await waitFor("!!document.querySelector('.dl__pop')", 8000)
const pdfOpt = await evaluate(`(() => {
  const el = [...document.querySelectorAll('.dl__opt')].find((b) => b.innerText.includes('PDF'))
  if (!el) return null
  const r = el.getBoundingClientRect()
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
})()`)
check('มีตัวเลือก PDF ให้กด', !!pdfOpt)
if (pdfOpt) {
  for (const type of ['mousePressed', 'mouseReleased'])
    await send('Input.dispatchMouseEvent', { type, x: pdfOpt.x, y: pdfOpt.y, button: 'left', clickCount: 1 })

  // ต้องรอ worker เรนเดอร์ใหม่ก่อน จึงใช้เวลานานกว่าปกติ
  const end = Date.now() + 150_000
  let files = []
  while (Date.now() < end) {
    files = readdirSync(dlDir).filter((f) => !f.endsWith('.crdownload'))
    if (files.some((f) => f.endsWith('.pdf'))) break
    await sleep(500)
  }
  check('กด PDF แล้วได้ไฟล์ .pdf จริง', files.some((f) => f.endsWith('.pdf')), files.join(', ') || 'ไม่มีไฟล์')
  check('กดแล้วเมนูปิดตัวเอง', await waitFor("!document.querySelector('.dl__pop')", 5000))
}
await shot('09-after-download.png')

// ── เก็บกวาด — คืนช่องกรอกแม่แบบแรกให้เป็นสภาพก่อนสคริปต์นี้ ──────
if (seedKey) {
  await fetch(`${API}/api/form/${seedKey}`, { method: 'DELETE', headers: H })
  await fetch(`${API}/api/access/${seedKey}`, { method: 'DELETE', headers: H })
}

await send('Browser.close').catch(() => {})
chrome.kill()
await redis.del(`session:${sid}`)
redis.disconnect()

console.log(`\n── ผ่าน ${pass} · ไม่ผ่าน ${fail} ─────────────────────\n`)
process.exit(fail ? 1 : 0)
