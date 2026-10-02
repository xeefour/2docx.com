/**
 * ตรวจการเลือกหน้า + ดาวน์โหลดรวม ZIP
 *
 *   node --env-file=.env tools/test-download-pages.mjs
 *
 * ── สิ่งที่ต้องผ่าน ────────────────────────────────────────────
 * 1. เมนูดาวน์โหลดมีช่องเลือกหน้า และนับหน้ารวมตรงกับตัวอย่างจริง
 * 2. พิมพ์ช่วงหน้า (`2-3`) แล้วจำนวนที่เลือกเปลี่ยนตาม
 * 3. พิมพ์ผิด (`99`) → ขึ้นข้อความบอกเหตุผล และกดดาวน์โหลดไม่ได้
 * 4. ปุ่มลัด ทุกหน้า / หน้าแรก / ไม่เอาปก ทำงาน
 * 5. ชี้ที่ Word → บอกตรง ๆ ว่า Word ตัดหน้าไม่ได้ (ไม่ปล่อยให้เลือกแล้วไม่มีผล)
 * 6. ดาวน์โหลด ZIP → ไฟล์ .zip บนดิสก์ เปิดอ่านได้ และมีรูปครบตามหน้าที่เลือก
 * 7. ดาวน์โหลด PDF + เลือกหน้า → ไฟล์ PDF ที่เหลือ**เฉพาะหน้าที่เลือกจริง**
 *
 * ⚠️ ข้อ 6–7 ต้องการเอกสารหลายหน้า ถ้าแม่แบบที่เปิดมีหน้าเดียว
 *    จะข้ามและ**ไม่นับว่าผ่าน** (ไม่ใช่ผ่านแบบเงียบ ๆ)
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Redis } from 'ioredis'
import { unzipSync } from 'fflate'
import { PDFDocument } from 'pdf-lib'
import { canvasDrawnJs } from './lib/canvas-drawn.mjs'
import { keyOf, pickTemplate, TEST_TEMPLATES } from './lib/pick-template.mjs'
import { FILL_FIELDS_JS, importTags, restoreForm, snapshotForm } from './lib/studio-seed.mjs'

const CHROME = process.env.CHROME_PATH ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const PORT = 9365
const WEB = 'http://localhost:3000'
const OUT = new URL('../tests/nav-status/output-download-pages/', import.meta.url)
const DL = mkdtempSync(join(tmpdir(), 'dl-pages-'))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
mkdirSync(OUT, { recursive: true })

let pass = 0
let fail = 0
let skip = 0
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`)
  ok ? pass++ : fail++
}
const skipCheck = (name, why) => {
  console.log(`  ~ ข้าม: ${name} — ${why}`)
  skip++
}

const redis = new Redis(process.env.VALKEY_URL)
const sid = `dlpage-${Date.now()}`
await redis.set(
  `session:${sid}`,
  JSON.stringify({ sub: sid, name: 'ผู้ทดสอบเลือกหน้า', email: 'dlpage@test.local', avatar: '' }),
  'EX',
  2400,
)
const H = { cookie: `docgen_session=${sid}`, 'content-type': 'application/json' }
const API = 'http://127.0.0.1:4001'

/**
 * เลือกแม่แบบที่หลายหน้า
 *
 * ⚠️ ต้องเลือก**ตามชื่อ** ไม่ใช่ `templates[0]`
 *    ลำดับรายการเปลี่ยนได้ตามที่เทสต์อื่นสร้าง/ลบแม่แบบชั่วคราว
 *    เคยตกเพราะไปหยิบแม่แบบที่มีช่องบังคับค้างอยู่ 1 ช่อง
 *    → แอปขึ้น "ยังกรอกไม่ครบ 1 ช่อง" แล้วไม่ยอมเรนเดอร์ → ไม่มี canvas ให้วัด
 *
 * ⚠️ ชื่อแม่แบบไม่ใช่ข้อเท็จจริงที่รับประกัน — แม่แบบจริงอาจเปลี่ยนไป
 *    เทสต์จึงวัดจำนวนหน้าจริงหลังเรนเดอร์ แล้วตัดสินใจว่าจะทดสอบต่อไหม
 */
const picked = await pickTemplate(H, [TEST_TEMPLATES.multipage, 'สำเนา 1', 'อำเภอเนินมะปราง'])
const key = keyOf(picked)
console.log(`ใช้แม่แบบ: ${picked.name} (key ${key})`)

/**
 * เตรียมช่องกรอก + snapshot ฟอร์มเดิมไว้ก่อน
 *
 * ⚠️ `import-tags` เขียนทับฟอร์มเดิม → ต้องคืนตอนจบ ไม่ใช่ลบทิ้ง
 *    ไม่งั้นเทสต์นี้จะไปลบฟอร์มที่เทสต์อื่นใช้อยู่
 */
const formSnap = await snapshotForm(H, key)
const seed = await importTags(H, picked)
console.log(`เตรียมช่องกรอกจากแท็กจริง — ${seed.ok ? 'สำเร็จ' : 'ล้มเหลว ' + seed.status}`)

const profile = mkdtempSync(join(tmpdir(), 'cdp-dlpage-'))
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
  // จับ error ที่หน้าเว็บโยนออกมา — ดาวน์โหลด PDF เป็นงาน async
  // ถ้าโค้ดพังจะไม่มีวันเห็นผลใน DOM เลย ต้องดูตรงนี้
  if (m.method === 'Runtime.exceptionThrown') {
    console.log('  [หน้าเว็บโยน error]', String(m.params.exceptionDetails?.exception?.description ?? m.params.exceptionDetails?.text ?? '').slice(0, 400))
  }
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
    console.log('  [หน้าเว็บ console.error]', (m.params.args ?? []).map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 400))
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
/** คลิกด้วยเมาส์จริง (ตรวจ `elementFromPoint` ด้วย — ถ้ามีอย่างอื่นบังก็ไม่กด) */
const realClick = async (selector, nth = 0) => {
  const box = await evaluate(`(() => {
    const el = document.querySelectorAll(${JSON.stringify(selector)})[${nth}]
    if (!el) return null
    const pop = el.closest('.dl__pop')
    ;(pop ?? el).scrollIntoView({ block: 'center', inline: 'center' })
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
/** คลิกด้วยเมาส์จริงที่หาจากข้อความบนปุ่ม */
const clickText = async (text, sel = 'button') => {
  const box = await evaluate(`(() => {
    const el = [...document.querySelectorAll(${JSON.stringify(sel)})]
      .find((x) => (x.textContent || '').includes(${JSON.stringify(text)}))
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
const setRange = async (text) =>
  evaluate(`(() => {
    const el = document.querySelector('.dl__rangeinput')
    if (!el) return false
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    setter.call(el, ${JSON.stringify(text)})
    el.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })()`)
/**
 * เลื่อนเมาส์ไปวางเหนือปุ่ม (ไม่กด)
 *
 * ⚠️ React ผูก `onMouseEnter` ผ่านการฟัง `mouseover`/`mouseout` ที่ document
 *    การยิง `dispatchEvent(new MouseEvent('mouseenter'))` แบบสังเคราะห์จะไม่มีผล
 *    ต้องใช้เมาส์จริงผ่าน CDP เหมือนการกด
 *
 * ⚠️ ห้ามใช้ `realClick` ตรงนี้ — มันจะกดปุ่มจริงแล้วเริ่มดาวน์โหลดทันที
 */
/**
 * เลื่อนเมาส์ไปวางเหนือปุ่ม (ไม่กด) แล้วยืนยันว่าเบราว์เซอร์มองว่าเมาส์ทับจริง
 *
 * ⚠️ React ผูก `onMouseEnter` ผ่านการฟัง `mouseover`/`mouseout` ที่ document
 *    การยิง `dispatchEvent(new MouseEvent('mouseenter'))` แบบสังเคราะห์จะไม่มีผล
 *    ต้องใช้เมาส์จริงผ่าน CDP เหมือนการกด
 *
 * ⚠️ ต้องย้ายออกก่อนแล้วค่อยกลับเข้า ไม่งั้นถ้าตำแหน่งเดิมทับกัน
 *    เบราว์เซอร์จะไม่ยิง `mouseover` ซ้ำ → React ไม่อัปเดต state
 *
 * ⚠️ ต้อง**ยืนยันเป็นลูป** ไม่ใช่เช็คครั้งเดียวหลังรอ 350ms
 *    สถานะ `:hover` เป็นของเบราว์เซอร์และอัปเดตตอนมีเฟรมใหม่
 *    ถ้าเครื่องหนัก (รันสคริปต์ต่อกัน) จะตกทั้งที่เมาส์จริงชี้ถูก
 *    เคยตกแบบนี้: รันเดี่ยวผ่าน 31/31 · รันต่อท้ายสคริปต์อื่นตก
 *
 * ⚠️ ต้องวัดพิกัดใหม่ทุกครั้ง — ถ้าป๊อปโอเวอร์เพิ่งย้ายตำแหน่ง พิกัดที่วัดไว้จะเก่า
 *
 * ⚠️ ห้ามใช้ `realClick` ตรงนี้ — มันจะกดปุ่มจริงแล้วเริ่มดาวน์โหลดทันที
 *
 * @returns `true` เมื่อเบราว์เซอร์ยืนยันว่าเมาส์ทับปุ่มนั้นจริง
 */
const hoverText = async (text, sel = '.dl__opt') => {
  const findBox = () =>
    evaluate(`(() => {
      const el = [...document.querySelectorAll(${JSON.stringify(sel)})]
        .find((x) => (x.textContent || '').includes(${JSON.stringify(text)}))
      if (!el) return null
      el.scrollIntoView({ block: 'center' })
      const r = el.getBoundingClientRect()
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
    })()`)
  const isHovered = () =>
    evaluate(`[...document.querySelectorAll(${JSON.stringify(sel)})]
      .find((x) => (x.textContent || '').includes(${JSON.stringify(text)}))?.matches(':hover') ?? false`)

  for (let attempt = 0; attempt < 3; attempt++) {
    const box = await findBox()
    if (!box) return false
    if (await isHovered()) return true // ทับอยู่แล้ว

    // ย้ายออกก่อน แล้วค่อยกลับเข้า — ไม่งั้นเบราว์เซอร์ไม่ยิง mouseover ซ้ำ
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 4, y: 4 })
    await sleep(150)
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y })

    // ยืนยันเป็นลูป — รอให้เบราว์เซอร์มีเฟรมอัปเดตสถานะ hover
    const deadline = Date.now() + 3000
    while (Date.now() < deadline) {
      await sleep(120)
      if (await isHovered()) return true
    }
  }
  return false
}
/**
 * ไฟล์ที่ดาวน์โหลดจริง
 *
 * ⚠️ ต้องตัด `.crdownload` (ไฟล์กำลังเขียน) และ `downloads.htm` ทิ้ง
 *    Chrome สร้างไฟล์ .htm ของหน้า chrome://downloads ไว้ในโฟลเดอร์เดียวกัน
 *    ถ้านับรวมจะไปรวมกับของจริง
 */
const listDownloads = () =>
  readdirSync(DL).filter((f) => !f.endsWith('.crdownload') && !f.endsWith('.htm'))

/** รอให้ไฟล์ดาวน์โหลดครบ (นับจากตอนกด) */
const waitFile = async (ext, timeoutMs = 180_000) => {
  const end = Date.now() + timeoutMs
  const seen = new Set()
  while (Date.now() < end) {
    const files = readdirSync(DL).filter((f) => f.toLowerCase().endsWith(ext) && !f.endsWith('.crdownload'))
    for (const f of files) if (!seen.has(f) && statSync(join(DL, f)).size > 0) seen.add(f)
    if (files.length > 0 && files.every((f) => !f.endsWith('.crdownload'))) {
      await sleep(700) // ให้ไฟล์สุดท้ายเขียนเสร็จ
      return files
    }
    await sleep(400)
  }
  return []
}

await send('Page.enable')
await send('Runtime.enable')
await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false })
await send('Network.setCookie', { name: 'docgen_session', value: sid, url: WEB })
await send('Network.setCacheDisabled', { cacheDisabled: true })
await send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: DL })

/**
 * เก็บกวาด — คืนฟอร์มแม่แบบ + ปิดเบราว์เซอร์ + ลบเซสชันทดสอบ
 *
 * ⚠️ ต้อง "คืน" ฟอร์มเดิม ไม่ใช่ลบทิ้ง เพราะ `import-tags` เขียนทับของเดิมไปแล้ว
 *    ถ้าลบทิ้ง เทสต์ถัดไปที่ใช้แม่แบบนี้จะเจอฟอร์มหาย
 */
const cleanup = async () => {
  await restoreForm(H, key, formSnap)
  await send('Browser.close').catch(() => {})
  chrome.kill()
  await redis.del(`session:${sid}`)
  redis.disconnect()
}

// ── เปิดแม่แบบ + เรนเดอร์ ─────────────────────────────────────────
console.log('\n[0] เปิดแม่แบบแล้วเรนเดอร์ตัวอย่าง')
await send('Page.navigate', { url: `${WEB}/studio/${key}?tabs=form&pane=preview` })
await waitFor("!!document.querySelector('.dl__btn')", 45000)
await sleep(600)
/**
 * ⚠️ ต้อง**กรอกฟอร์มให้ครบ**ก่อนกดเรนเดอร์
 *    แอปบล็อกปุ่มเรนเดอร์เมื่อช่องบังคับยังว่าง ("ยังกรอกไม่ครบ N ช่อง")
 *    ถ้าไม่กรอก จะไม่มี canvas ให้วัด แล้วเทสต์ตกทั้งชุด
 *    ทั้งที่ของจริงไม่ได้พัง — เคยเจอแบบนี้จากแม่แบบ `ทดสอบหัวกระดาษ`
 *    ที่มีช่องบังคับ "เรื่อง" ค้างอยู่ 1 ช่อง
 */
const filled = await evaluate(FILL_FIELDS_JS)
console.log(`  กรอกข้อมูล ${filled} ช่อง`)
check('มีช่องให้กรอกและกรอกได้', filled > 0, `${filled} ช่อง`)
await sleep(400)
await clickText('เรนเดอร์ตัวอย่าง')
/**
 * ⚠️ เกณฑ์ "วาดเสร็จแล้ว" ต้องมาจากตัวกลาง ไม่ใช่ `width > 400` ที่เขียนเอง
 *    ตอนนี้กระดาษถูกย่อให้พอดีกล่อง → กว้างไม่ถึง 400px แม้วาดเสร็จแล้ว
 *    (เคยทำให้สคริปต์นี้ตกทั้งชุด ทั้งที่พรีวิวไม่ได้พัง)
 */
const rendered = await waitFor(canvasDrawnJs(), 120000)
check('เรนเดอร์ตัวอย่างสำเร็จ', rendered)
if (!rendered) {
  await shot('99-failed.png')
  // บันทึกข้อความที่ UI รายงานไว้ด้วย ไม่งั้นต้องเดาว่าทำไมถึงไม่เรนเดอร์
  const why = await evaluate(
    "document.querySelector('.notice--error, .editor-col .notice')?.textContent?.trim() ?? '(ไม่มีข้อความ)'",
  )
  console.log(`  เรนเดอร์ไม่สำเร็จ — UI บอก: ${why}`)
  await cleanup()
  console.log(`\n── ผ่าน ${pass} · ไม่ผ่าน ${fail} ─────────────────────\n`)
  process.exit(1)
}

// ── 1. เมนูมี 3 ตัวเลือก และกล่องเลือกหน้ายังไม่โผล่ ────────────────────
console.log('\n[1] เมนูมี 3 ตัวเลือก — กล่อง "หน้าที่ต้องการ" ยังไม่โผล่')
await realClick('.dl__btn')
check('เปิดเมนูได้', await waitFor("!!document.querySelector('.dl__pop')", 8000))
const opts = await evaluate("[...document.querySelectorAll('.dl__opt')].map((b) => b.innerText.replace(/\\n+/g, ' ').trim())")
check('มี 3 ตัวเลือก (PDF · Word · รูปภาพ)', opts.length === 3, `${opts.length}: ${opts.join(' | ')}`)
check('ไม่มีตัวเลือก ZIP แยกแล้ว', !opts.some((o) => o.includes('ZIP')), opts.join(' | '))
/**
 * ⚠️ PDF / Word ต้อง**ไม่มีคำอธิบายใต้ชื่อ**
 *   ผู้ใช้สั่ง "ไม่ต้องแสดงข้อความนี้ ทั้ง pdf word" (เคยเขียนว่า
 *   "ฉบับส่งมอบ ทั้งเล่ม" กับ "แก้ต่อได้ ทั้งเล่ม")
 *   เหลือเฉพาะรูปภาพที่ต้องบอกว่า "เลือกหน้าที่ต้องการ" เพราะเป็นตัวเดียวที่ต้องเลือกหน้า
 *   เช็คที่ element `<small>` จริง ไม่ใช่แค่ข้อความ เพราะข้อความชื่อไฟล์ก็อยู่ในปุ่มเดียวกัน
 */
const hints = await evaluate("[...document.querySelectorAll('.dl__opt')].map((b) => b.querySelector('small')?.textContent?.trim() ?? '')")
check('PDF ไม่มีคำอธิบายใต้ชื่อ', hints[0] === '', JSON.stringify(hints[0]))
check('Word ไม่มีคำอธิบายใต้ชื่อ', hints[1] === '', JSON.stringify(hints[1]))
check('รูปภาพยังบอกว่าให้เลือกหน้า', hints[2] === 'เลือกหน้าที่ต้องการ', JSON.stringify(hints[2]))

/**
 * ⚠️ กติกาใหม่: กล่อง "หน้าที่ต้องการ" ซ่อนไว้จนกว่าผู้ใช้จะ**คลิกรูปภาพ**
 *   ต้องไม่มีทั้งช่องพิมพ์และปุ่มยืนยันตั้งแต่เปิดเมนู
 */
check('ยังไม่มีช่องพิมพ์ช่วงหน้า', !(await evaluate("!!document.querySelector('.dl__rangeinput')")))
check('ยังไม่มีปุ่มยืนยันดาวน์โหลดรูป', !(await evaluate("!!document.querySelector('.dl__go')")))
check('ยังไม่เริ่มดาวน์โหลดอะไร', listDownloads().length === 0, listDownloads().join(', '))
/**
 * จำนวนหน้าต้องอ่านจากตัวบอกของพรีวิว เพราะ `.dl__count` ยังไม่มีใน DOM
 * พรีวิย์แสดง**ทีละหน้า** มีตัวบอก "หน้า 1 / 3" ดังนั้น
 * `document.querySelectorAll('.docpage canvas').length` จะเป็น 1 เสมอ
 * นับ canvas แล้วเทียบกับเมนู = เทสต์ผิด ไม่ใช่แอปผิด
 */
const previewLabel = await evaluate("document.querySelector('.doctools .muted')?.textContent?.trim() ?? ''")
const total = Number(previewLabel.match(/\/\s*(\d+)/)?.[1] ?? 0)
check('อ่านจำนวนหน้าจากพรีวิวได้', total > 0, previewLabel)
check('พรีวิววาดครบทีละหน้า (ไม่ใช่ทุกหน้าพร้อมกัน)', total > 0 && (await evaluate("document.querySelectorAll('.docpage canvas').length")) === 1)
await shot('01-menu.png')

/** คลิกปุ่มตัวเลือกด้วยเมาส์จริง หาจากข้อความใน `.dl__opt` (ไม่ใช่ทุกปุ่มในเมนู) */
const clickOpt = async (text) => {
  const box = await evaluate(`(() => {
    const el = [...document.querySelectorAll('.dl__opt')].find((b) => (b.innerText || '').includes(${JSON.stringify(text)}))
    if (!el) return null
    const pop = el.closest('.dl__pop')
    ;(pop ?? el).scrollIntoView({ block: 'center' })
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
 * เปิดกล่องเลือกหน้าให้ครบ — เผื่อกรณีเมนูถูกปิดไปแล้วจากการดาวน์โหลดรอบก่อน
 * (เมนูปิดตัวเองทุกครั้งที่กดดาวน์โหลดสำเร็จ)
 */
const openImagePanel = async () => {
  if (!(await evaluate("!!document.querySelector('.dl__imgpanel')"))) {
    if (!(await evaluate("!!document.querySelector('.dl__pop')"))) {
      await realClick('.dl__btn')
      await waitFor("!!document.querySelector('.dl__pop')", 8000)
    }
    await clickOpt('รูปภาพ')
    await waitFor("!!document.querySelector('.dl__imgpanel')", 5000)
  }
  await sleep(300)
}

// ── 2. คลิกรูปภาพแล้วกล่องเลือกหน้าต้องโผล่ใต้ปุ่ม ──────────────────
console.log('\n[2] คลิก "รูปภาพ" — กล่องเลือกหน้าต้องโผล่ใต้ปุ่มนี้')
const geoBefore = await evaluate(`(() => {
  const pop = document.querySelector('.dl__pop')
  if (!pop) return null
  const pr = pop.getBoundingClientRect()
  return { popH: Math.round(pr.height), hasPanel: !!document.querySelector('.dl__imgpanel'),
           relY: [...document.querySelectorAll('.dl__opt')].map((o) => Math.round(o.getBoundingClientRect().y - pr.y)) }
})()`)
check('คลิกปุ่มรูปภาพได้', await clickOpt('รูปภาพ'))
const panelShown = await waitFor("!!document.querySelector('.dl__imgpanel')", 5000)
check('กล่องเลือกหน้าโผล่หลังคลิกรูปภาพ', panelShown)
check('มีช่องพิมพ์ช่วงหน้า', await evaluate("!!document.querySelector('.dl__rangeinput')"))
check('มีปุ่มยืนยันดาวน์โหลดรูป', await evaluate("!!document.querySelector('.dl__go')"))
/**
 * ⚠️ "ใต้ปุ่มรูปภาพ" = วัดตำแหน่ง**เทียบกับกล่องเมนู** ไม่ใช่พิกัดบนจอ
 *   `scrollIntoView` ทำให้ทุกอย่างขยับพร้อมกัน ถ้าเทียบพิกัดจอจะเทียบผิด
 */
const geoAfter = await evaluate(`(() => {
  const pop = document.querySelector('.dl__pop')
  const panel = document.querySelector('.dl__imgpanel')
  if (!pop || !panel) return null
  const pr = pop.getBoundingClientRect()
  const png = [...document.querySelectorAll('.dl__opt')].find((o) => (o.innerText || '').includes('รูปภาพ'))
  return {
    popH: Math.round(pr.height),
    relY: [...document.querySelectorAll('.dl__opt')].map((o) => Math.round(o.getBoundingClientRect().y - pr.y)),
    panelRelY: Math.round(panel.getBoundingClientRect().y - pr.y),
    pngRelY: png ? Math.round(png.getBoundingClientRect().y - pr.y) : null,
    pngH: png ? Math.round(png.getBoundingClientRect().height) : null,
  }
})()`)
check('กล่องเลือกหน้าอยู่ใต้ปุ่มรูปภาพจริง', geoAfter && geoAfter.panelRelY > geoAfter.pngRelY, `ปุ่มรูปภาพ y=${geoAfter?.pngRelY} · กล่อง y=${geoAfter?.panelRelY}`)
check('ปุ่มรูปภาพกว้างเต็มแถว ไม่ใช่ครึ่งแถว', geoAfter && geoAfter.relY.length === 3 && geoAfter.relY[2] > geoAfter.relY[1] + 30, `relY=${geoAfter?.relY.join()}`)
check('กล่องที่เพิ่งมาทำให้เมนูสูงขึ้น (แปลว่ามีอะไรเพิ่มจริง)', geoBefore && geoAfter && geoAfter.popH > geoBefore.popH, `${geoBefore?.popH} → ${geoAfter?.popH}px`)
const countText = await evaluate("document.querySelector('.dl__count')?.textContent ?? ''")
check('บอกจำนวนหน้ารวมตรงกับพรีวิว', countText.includes(`ทั้งหมด ${total}`), `${countText} · พรีวิว ${total} หน้า`)
check('เริ่มต้นเป็นทุกหน้า', countText.includes('ทั้งหมด'), countText)
check('ยังไม่เริ่มดาวน์โหลดอะไร (คลิกครั้งแรกแค่เปิดกล่อง)', listDownloads().length === 0, listDownloads().join(', '))
await shot('02-image-panel.png')

// ── 3. พิมพ์ช่วงหน้า ────────────────────────────────────────────
console.log('\n[3] พิมพ์ช่วงหน้า — จำนวนที่เลือกต้องเปลี่ยน และปุ่มยืนยันต้องบอกชนิดไฟล์')
if (total >= 3) {
  await setRange('2-3')
  await sleep(400)
  const c2 = await evaluate("document.querySelector('.dl__count')?.textContent ?? ''")
  check('เลือก 2 หน้า', c2 === '2 จาก ' + total + ' หน้า', c2)
  const hint = await evaluate("document.querySelector('.dl__hint')?.textContent ?? ''")
  check('ใบ้ว่าจะได้กี่หน้า', hint.includes('จะได้ 2 หน้า'), hint)
  check('บอกว่าจะรวมเป็น ZIP (มากกว่า 1 หน้า)', hint.includes('ZIP'), hint)
  const go2 = await evaluate("document.querySelector('.dl__go')?.textContent ?? ''")
  check('ปุ่มยืนยันบอกว่า 2 รูปเป็น ZIP', go2.includes('2 รูป') && go2.includes('ZIP'), go2)
} else {
  skipCheck('เลือกช่วงหน้า', `เอกสารมี ${total} หน้า`)
}
await shot('03-range.png')

// ── 4. พิมพ์ผิด ─────────────────────────────────────────────────
console.log('\n[4] พิมพ์ผิด — ต้องบอกเหตุผลและปิดปุ่มยืนยัน ไม่ใช่เงียบ')
await setRange('99')
await sleep(400)
const err = await evaluate("document.querySelector('.dl__hint--err')?.textContent ?? ''")
check('ขึ้นข้อความบอกว่าเอกสารมีกี่หน้า', err.includes(`เอกสารมีแค่ ${total} หน้า`), err)
check('ปุ่มยืนยันถูกปิดใช้งานเมื่อช่วงหน้าผิด', await evaluate("!!document.querySelector('.dl__go')?.disabled"))
await shot('04-bad-range.png')
await setRange('')
await sleep(300)

// ── 5. ปุ่มลัด ─────────────────────────────────────────────────
console.log('\n[5] ปุ่มลัดเลือกหน้า')
await clickText('หน้าแรก', '.dl__quick button')
await sleep(300)
check('ปุ่ม "หน้าแรก" ได้ 1 หน้า', (await evaluate("document.querySelector('.dl__count')?.textContent ?? ''")).includes('1 จาก'))
check('1 หน้า → ปุ่มยืนยันต้องเป็นไฟล์รูปเดียว ไม่ใช่ ZIP', (await evaluate("document.querySelector('.dl__go')?.textContent ?? ''")).includes('PNG'))
await clickText('ทุกหน้า', '.dl__quick button')
await sleep(300)
check('ปุ่ม "ทุกหน้า" กลับเป็นทั้งหมด', (await evaluate("document.querySelector('.dl__count')?.textContent ?? ''")).includes('ทั้งหมด'))
if (total > 1) {
  await clickText('ไม่เอาปก', '.dl__quick button')
  await sleep(300)
  check('ปุ่ม "ไม่เอาปก" ตัดหน้าแรกออก', (await evaluate("document.querySelector('.dl__count')?.textContent ?? ''")).includes(`${total - 1} จาก`))
  await clickText('ทุกหน้า', '.dl__quick button')
  await sleep(200)
}

// ── 6. เลื่อนเมาส์ผ่านปุ่มแล้วเมนูต้องไม่ขยับ ────────────────────────
console.log('\n[6] เลื่อนเมาส์ผ่านปุ่ม — เมนูต้องนิ่ง (กันกระพริบไม่สิ้นสุด)')
/**
 * ⚠️ เคยพั้งมาแล้วสองรอบ (ผู้ใช้รายงานว่าเมนูกระพริบไม่สิ้นสุด)
 *   รอบแรก: กล่อง "หน้าที่ต้องการ" ซ่อน/โชว์ตาม `peek` ตอน hover
 *             → เมนูสูงลดลง ~121px → ปุ่มที่เมาส์ชี้ขยับขึ้นมาทับเมาส์ → วนไม่จบ
 *   รอบสอง: แก้ด้วยการคงกล่องไว้ + `disabled` แต่ผู้ใช้ยังอยากได้กล่องที่ซ่อนไว้
 *   ตอนนี้: กล่องซ่อนด้วย**การคลิก** ไม่ผูกกับ hover เลย → ต้องไม่มีอะไรขยับตอนชี้
 *
 *   ต้องวัดตำแหน่งปุ่ม**เทียบกับกล่องเมนู** ไม่ใช่พิกัดบนจอ
 *   `hoverText` เรียก `scrollIntoView` → ถ้าหน้าเลื่อน พิกัดทุกอย่างขยับพร้อมกัน
 */
const dlGeo = () =>
  evaluate(`(() => {
  const pop = document.querySelector('.dl__pop')
  if (!pop) return null
  const pr = pop.getBoundingClientRect()
  return {
    popH: Math.round(pr.height),
    /** ระยะจากขอบบนเมนูถึงปุ่มแต่ละปุ่ม — ไม่ขึ้นกับการเลื่อนหน้า */
    relY: [...document.querySelectorAll('.dl__opt')].map((o) => Math.round(o.getBoundingClientRect().y - pr.y)),
  }
})()`)

const geoPdf = await dlGeo()
const hoveredWord = await hoverText('Word')
const geoWord = await dlGeo()
check('เมาส์จริงชี้ปุ่ม Word ได้', hoveredWord === true)
check('ชี้ Word → ความสูงเมนูเท่าเดิม ไม่หด', geoPdf && geoWord && Math.abs(geoWord.popH - geoPdf.popH) <= 1, `สูง ${geoPdf?.popH} → ${geoWord?.popH}px`)
check('ชี้ Word → ปุ่มรูปแบบไม่ขยับจากใต้เคอร์เซอร์', geoPdf && geoWord && geoWord.relY.join() === geoPdf.relY.join(), `${geoPdf?.relY.join()} → ${geoWord?.relY.join()}`)
const geoPng = await (async () => { await hoverText('รูปภาพ'); return dlGeo() })()
check('ชี้รูปภาพ → เมนูก็ยังนิ่ง (กล่องที่เปิดไว้ต้องไม่ถูก hover ปิด)', geoWord && geoPng && geoPng.relY.join() === geoWord.relY.join(), `${geoWord?.relY.join()} → ${geoPng?.relY.join()}`)
check('ยังไม่เริ่มดาวน์โหลดอะไร (แค่ชี้ ไม่ใช่กด)', listDownloads().length === 0, listDownloads().join(', '))
await shot('05-hover.png')

// ── 7. ดาวน์โหลดรูป 1 หน้า → ไฟล์ PNG เดียว ─────────────────────────
console.log('\n[7] ดาวน์โหลดรูป 1 หน้า — ต้องได้ไฟล์ .png ไฟล์เดียว (ไม่ใช่ ZIP)')
if (total >= 1) {
  await openImagePanel()
  await setRange('1')
  await sleep(400)
  const goLabel = await evaluate("document.querySelector('.dl__go')?.textContent ?? ''")
  check('1 หน้า → ปุ่มยืนยันสัญญาว่าจะได้ PNG ไม่ใช่ ZIP', goLabel.includes('PNG') && !goLabel.includes('ZIP'), goLabel)
  check('กดปุ่มยืนยันได้', await realClick('.dl__go'))

  const files = await waitFile('.png')
  check('ได้ไฟล์ .png บนดิสก์', files.length === 1, files.join(', '))
  check('ไม่ได้ไฟล์ .zip มาด้วย', listDownloads().filter((f) => f.endsWith('.zip')).length === 0, listDownloads().join(', '))
  if (files.length) {
    const bytes = new Uint8Array(readFileSync(join(DL, files[0])))
    check('ไฟล์เป็น PNG จริง (magic %PNG)', bytes[0] === 0x89 && bytes[1] === 0x50, `${bytes.length} ไบต์`)
    check('ชื่อไฟล์บอกเลขหน้า', /หน้า1\.png$/.test(files[0]), files[0])
    check('รูปไม่ใช่ไฟล์ว่าง', bytes.length > 2000, `${bytes.length} ไบต์`)
  }
  await shot('06-after-png.png')
} else {
  skipCheck('ดาวน์โหลดรูป 1 หน้า', `เอกสารมี ${total} หน้า`)
}

// ── 7b. ปิดแล้วเปิดใหม่ = เริ่มใหม่ทุกครั้ง ─────────────────────────
console.log('\n[7b] ปิดเมนูแล้วเปิดใหม่ — ต้องกลับเป็นสถานะเริ่มต้น')
/**
 * ⚠️ ผู้ใช้สั่ง: *"ถ้า popup นี้ปิดให้ซ่อนส่วนนี้เหมือนเริ่มใหม่ ครั้งแรกจะไม่แสดงหน้าที่ต้องการ"*
 *
 *   ข้างล่างสำคัญกว่าที่เห็น: ถ้าปิดเมนูแล้วช่วงหน้ายังค้างอยู่
 *   รอบถัดไปผู้ใช้กดดาวน์โหลดรูปโดยไม่ได้เลือกอะไร → ได้ไม่ครบทุกหน้าเงียบ ๆ
 *   ตรงนี้เพิ่งเลือก `1` ไว้ ถ้าไม่ถูกล้าง รอบถัดไปต้องได้หน้า 1 ทันที (ผิดจากที่ตั้งใจ)
 */
check('หลังดาวน์โหลด เมนูปิดไปแล้ว', !(await evaluate("!!document.querySelector('.dl__pop')")))
await realClick('.dl__btn')
check('เปิดเมนูได้อีกครั้ง', await waitFor("!!document.querySelector('.dl__pop')", 8000))
check('กล่องหน้าที่ต้องการไม่โผล่เอง (ต้องกดรูปภาพก่อน)', !(await evaluate("!!document.querySelector('.dl__imgpanel')")))
check('กดรูปภาพแล้วกล่องกลับมา', await clickOpt('รูปภาพ') && (await waitFor("!!document.querySelector('.dl__imgpanel')", 5000)))
const rangeVal = await evaluate("document.querySelector('.dl__rangeinput')?.value ?? '(ไม่มีช่อง)'")
check('ช่องช่วงหน้าว่าง (กลับเป็นทุกหน้า ไม่ตกหลุดจากรอบก่อน)', rangeVal === '', JSON.stringify(rangeVal))
const countFresh = await evaluate("document.querySelector('.dl__count')?.textContent ?? ''")
check('ตัวบอกจำนวนหน้าบอก "ทั้งหมด" อีกครั้ง', countFresh.includes('ทั้งหมด'), countFresh)

// ── 8. ดาวน์โหลดรูปหลายหน้า → ไฟล์ ZIP ────────────────────────────
console.log('\n[8] ดาวน์โหลดรูปมากกว่า 1 หน้า — ต้องได้ไฟล์ .zip ไฟล์เดียว')
if (total >= 2) {
  const want = Math.min(2, total)
  await openImagePanel()
  await setRange(`1-${want}`)
  await sleep(400)
  const goLabel = await evaluate("document.querySelector('.dl__go')?.textContent ?? ''")
  check('หลายหน้า → ปุ่มยืนยันสัญญาว่าจะได้ ZIP', goLabel.includes('ZIP'), goLabel)
  check('กดปุ่มยืนยันได้', await realClick('.dl__go'))

  const files = await waitFile('.zip')
  check('ได้ไฟล์ .zip บนดิสก์', files.length === 1, files.join(', '))
  if (files.length) {
    const bytes = new Uint8Array(readFileSync(join(DL, files[0])))
    check('ไฟล์ไม่ว่าง', bytes.length > 0, `${bytes.length} ไบต์`)
    const entries = unzipSync(bytes)
    const names = Object.keys(entries)
    check('เปิด ZIP ได้', names.length > 0, names.join(', '))
    check(`มีรูปครบ ${want} หน้า`, names.length === want, `${names.length} ไฟล์`)
    check('ชื่อไฟล์บอกเลขหน้า', names.every((n) => /หน้า\d+\.png$/.test(n)), names.join(', '))
    const allPng = Object.values(entries).every((d) => d[0] === 0x89 && d[1] === 0x50)
    check('ข้างในเป็น PNG จริง (magic %PNG)', allPng)
    const onePng = Object.values(entries)[0]
    check('รูปไม่ใช่ไฟล์ว่าง', onePng && onePng.length > 2000, `${onePng?.length ?? 0} ไบต์`)
  }
  await shot('07-after-zip.png')
} else {
  skipCheck('ดาวน์โหลดรูปหลายหน้า', `เอกสารมี ${total} หน้า`)
}

// ── 9. ดาวน์โหลด PDF → ทั้งเล่ม ไม่ตัดหน้า ─────────────────────────
console.log('\n[9] ดาวน์โหลด PDF — ต้องได้ทั้งเล่ม ไม่ใช่เฉพาะหน้าที่เลือกไว้')
{
  if (!(await evaluate("!!document.querySelector('.dl__pop')"))) {
    await realClick('.dl__btn')
    await waitFor("!!document.querySelector('.dl__pop')", 8000)
  }
  check('กด PDF ได้', await clickOpt('PDF'))

  const files = await waitFile('.pdf')
  if (!files.length) {
    await realClick('.dl__btn').catch(() => {})
    await sleep(500)
    const msg = await evaluate("document.querySelector('.dl__status')?.textContent ?? '(ไม่มีข้อความ)'")
    check('ได้ไฟล์ .pdf', false, `UI บอก: ${msg}`)
  } else {
    check('ได้ไฟล์ .pdf', true, files.join(', '))
  }
  if (files.length) {
    const bytes = new Uint8Array(readFileSync(join(DL, files[0])))
    check('ไฟล์เป็น PDF จริง (magic %PDF-)', String.fromCharCode(...bytes.slice(0, 5)) === '%PDF-')
    const doc = await PDFDocument.load(bytes)
    check('ได้ทั้งเล่ม ไม่ใช่หน้าเดียว', doc.getPageCount() === total, `ได้ ${doc.getPageCount()} / ${total} หน้า`)
    check('ชื่อไฟล์ไม่มีเลขหน้าต่อท้าย (ไม่ได้ตัดหน้า)', !/หน้า\d*\.pdf$/.test(files[0]), files[0])
  }
  await shot('08-after-pdf.png')
}


await cleanup()

console.log(`\n── ผ่าน ${pass} · ไม่ผ่าน ${fail} · ข้าม ${skip} ─────────────────────`)
console.log(`ไฟล์ที่ดาวน์โหลด: ${DL}`)
console.log(`ภาพ: ${OUT.pathname}\n`)
process.exit(fail ? 1 : 0)
