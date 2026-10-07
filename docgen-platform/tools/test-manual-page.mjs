/**
 * ตรวจหน้าคู่มือภาษาไทยที่ /docs ผ่าน gateway
 *
 *   node tools/test-manual-page.mjs
 *
 * ── ทำไมต้องตรวจระดับเบราว์เซอร์ ไม่ใช่แค่ curl ──────────────────
 *   `curl /docs/` ได้ 200 ก็จริง แต่ไม่ได้แปลว่าหน้าจะวาดออกมา
 *   ของพังที่เจอจริงกับ static site หลัง reverse proxy:
 *     · ไฟล์อ้างอิงเป็นแบบสัมพัทฤ์ (`assets/…`) แต่ถูกถอด prefix ผิดที่
 *       → HTML 200 · CSS/JS 404 · หน้าเปล่า ไม่มี error ในหน้า
 *     · `handle` แทน `handle_path` ทำให้ file_server หาไฟล์ไม่เจอทั้งเว็บ
 *     · JS โหลดมาแต่พังตอนรัน (สังเกตได้จาก console เท่านั้น)
 *   เกณฑ์ชั้นนี้จึงต้องดูของจริงที่วาดอยู่บนหน้า
 *
 * ── เกณฑ์เป็นสี่ชั้น ───────────────────────────────────────────
 *   1 · ไม่มี request ไหนได้ 4xx/5xx ตอนเปิดหน้า
 *   2 · เนื้อหาหลักวาดจริง และอยู่**ในหน้าจอ** ไม่ใช่แค่มีใน DOM
 *   3 · ฟอนต์ภาษาไทยทำงาน (วัดความกว้างกล่อง — ถ้าไม่มีฟอนต์ไทยจะเล็กผิดปกติ)
 *   4 · ส่วนโต้ตอบจริง: ค้นหา · เช็กบล็อก · เมนูจอเล็ก
 */
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CHROME = process.env.CHROME_PATH ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const PORT = 9483
const URL = 'http://127.0.0.1:8090/docs'
const OUT = 'D:/2docx.com/docgen-platform/tests/nav-status/output-manual/'
const SRC = 'D:/2docx.com/docgen-platform/manual/index.html'
mkdirSync(OUT, { recursive: true })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * อ่านความคาดหวังจากไฟล์แม่แบบจริง ไม่ใช่เขียนตัวเลขตายตัวไว้
 *
 * ⚠️ เหตุผลที่ต้องทำแบบนี้
 *   เคยเขียนว่า "ต้องมี 10 หัวข้อ" ไว้ตายตัว พอแก้เนื้อหาเป็น 14 หัวข้อ
 *   เกณฑ์ก็ตกทั้งที่หน้าเว็บถูกต้อง ทำให้ต้องไปแก้สคริปต์ทุกครั้งที่เพิ่มหัวข้อ
 *   การอ่านจากไฟล์ต้นทางจริงทำให้เกณฑ์โตตามเนื้อหาโดยอัตโนมัติ
 */
const SRC_HTML = readFileSync(SRC, 'utf8')
/** id ของทุก section ตามลำดับที่ปรากฏในไฟล์ */
const SECTION_IDS = [...SRC_HTML.matchAll(/<section id="([^"]+)"/g)].map((m) => m[1])
/** หัวข้อที่ใช้ทดสอบ scrollspy — เลือกหัวข้อที่อยู่กลาง ๆ รายการ */
const SPY_ID = SECTION_IDS[Math.min(5, SECTION_IDS.length - 1)]
/** จำนวนหัวข้อที่คาดหวัง */
const EXPECTED = SECTION_IDS.length

let pass = 0
let fail = 0
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'}${name}${detail ? ` — ${detail}` : ''}`)
  ok ? pass++ : fail++
}

const profile = mkdtempSync(join(tmpdir(), 'cdp-manual-'))
const chrome = spawn(
  CHROME,
  ['--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
   `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, 'about:blank'],
  { stdio: 'ignore' },
)
let wsUrl = null
for (let i = 0; i < 40 && !wsUrl; i++) {
  await sleep(500)
  try {
    const l = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
    wsUrl = l.find((x) => x.type === 'page')?.webSocketDebuggerUrl
  } catch { /* ยังไม่พร้อม */ }
}
if (!wsUrl) { chrome.kill(); console.log('✗ ต่อ Chrome ไม่ได้'); process.exit(1) }

const ws = new WebSocket(wsUrl)
let seq = 0
const waiting = new Map()
const responses = []
const consoleErrors = []

const send = (m, p = {}) =>
  new Promise((resolve, reject) => {
    const id = ++seq
    const t = setTimeout(() => { waiting.delete(id); reject(new Error(`timeout: ${m}`)) }, 30000)
    waiting.set(id, { resolve: (v) => { clearTimeout(t); resolve(v) }, reject: (e) => { clearTimeout(e); reject(e) } })
    ws.send(JSON.stringify({ id, method: m, params: p }))
  })
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data)
  if (m.method === 'Network.responseReceived') {
    responses.push({ url: m.params.response.url, status: m.params.response.status })
    return
  }
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
    consoleErrors.push((m.params.args ?? []).map((a) => a.value ?? a.description ?? '').join(' '))
    return
  }
  if (m.method === 'Runtime.exceptionThrown') {
    consoleErrors.push(m.params.exceptionDetails?.text ?? 'exception')
    return
  }
  const s = waiting.get(m.id)
  if (!s) return
  waiting.delete(m.id)
  m.error ? s.reject(new Error(JSON.stringify(m.error))) : s.resolve(m.result)
})
await new Promise((r) => ws.addEventListener('open', r))
await send('Page.enable')
await send('Runtime.enable')
await send('Network.enable')
await send('Network.setCacheDisabled', { cacheDisabled: true })

const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text ?? 'evaluate พัง')
  return r.result?.value
}
const waitFor = async (expr, ms = 20000) => {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    try { if (await evaluate(`!!(${expr})`)) return true } catch { /* ระหว่าง navigate */ }
    await sleep(300)
  }
  return false
}

console.log(`\n── คู่มือภาษาไทย ${URL} ──────────────────────────────\n`)

await send('Page.navigate', { url: URL })
await waitFor(`document.querySelector('.content h1')`, 25000)
await sleep(1200)

// ── ชั้น 1 · ไม่มีไฟล์โหลดไม่ขึ้น ────────────────────────────────
const bad = responses.filter((r) => r.status >= 400)
check('ไม่มีไฟล์ที่โหลดไม่ขึ้น (4xx/5xx)', bad.length === 0,
  bad.length ? bad.map((b) => `${b.status} ${b.url}`).join(' · ') : `${responses.length} คำขอ`)

const cssLoaded = responses.find((r) => r.url.endsWith('/assets/manual.css') && r.status === 200)
const jsLoaded = responses.find((r) => r.url.endsWith('/assets/manual.js') && r.status === 200)
check('CSS และ JS โหลดได้จริง (ไม่ใช่แค่ HTML 200)', !!cssLoaded && !!jsLoaded,
  `css=${!!cssLoaded} js=${!!jsLoaded}`)

// ── ชั้น 2 · เนื้อหาวาดจริงและอยู่บนจอ ─────────────────────────
const page = await evaluate(`(() => {
  const h1 = document.querySelector('.content h1')
  const rect = h1.getBoundingClientRect()
  const secs = [...document.querySelectorAll('.content section')]
  return {
    title: document.title,
    h1: h1.textContent.trim(),
    h1Width: Math.round(rect.width),
    h1Visible: rect.top < innerHeight && rect.bottom > 0 && rect.width > 0 && rect.height > 0,
    sections: secs.length,
    navLinks: document.querySelectorAll('.sidenav a').length,
    thaiChars: (document.body.innerText.match(/[฀-๿]/g) || []).length,
  }
})()`)
check('หัวเรื่องแสดงผลจริง (ไม่ใช่แค่มีใน DOM)', page.h1Visible === true, `${page.h1} · ${page.h1Width}px`)
check(`มีครบ ${EXPECTED} หัวข้อ`, page.sections === EXPECTED, `${page.sections} section`)
check(`เมนูด้านข้างครบ ${EXPECTED} รายการ`, page.navLinks === EXPECTED, `${page.navLinks} รายการ`)
check('ข้อความภาษาไทยแสดงจริง', page.thaiChars > 500, `${page.thaiChars} ตัวอักษร`)

// ── ชั้น 3 · ฟอนต์ไทยทำงาน ────────────────────────────────────
/**
 * ถ้าฟอนต์ไทยหายไปทั้งหมด กล่องจะแคบลงมาก
 * วัดความกว้างจริงเทียบกับตัวอักษรไทย แทนการเชื่อว่ามีฟอนต์อยู่
 */
const font = await evaluate(`(() => {
  const probe = (txt, fam) => {
    const s = document.createElement('span')
    s.style.cssText = 'position:absolute;left:-9999px;font-size:40px;white-space:nowrap'
    s.style.fontFamily = fam
    s.textContent = txt
    document.body.appendChild(s)
    const w = s.getBoundingClientRect().width
    s.remove()
    return Math.round(w)
  }
  return {
    thaiStack: probe('ทดสอบภาษาไทย', 'var(--font-th)'),
    thaiFallback: probe('ทดสอบภาษาไทย', 'sans-serif'),
    mono: probe('ทดสอบ', 'monospace'),
  }
})()`)
check('ฟอนต์ไทยเรนเดอร์เป็นตัวอักษรจริง (กว้างกว่า latin)',
  font.thaiStack > font.mono * 2, `ไทย=${font.thaiStack}px · mono=${font.mono}px`)

const bodyFont = await evaluate(`getComputedStyle(document.body).fontFamily`)
check('body ใช้ฟอนต์ไทยที่ประกาศไว้', /Sarabun|Noto Sans Thai|Leelawadee|Tahoma/.test(bodyFont), bodyFont.slice(0, 60))

check('ไม่มี error ใน console ตอนเปิดหน้า', consoleErrors.length === 0,
  consoleErrors.length ? consoleErrors.slice(0, 2).join(' | ') : 'console สะอาด')

// ── ชั้น 4 · ส่วนโต้ตอบจริง ────────────────────────────────────
/**
 * เมนูข้างต้องไฮไลต์ตามหัวข้อที่เลื่อนไป
 *
 * ⚠️ ต้องปิด `scroll-behavior: smooth` ก่อน ไม่งั้น `scrollIntoView()`
 *   จะสั่งเลื่อนแบบอนิเมชัน แล้วรอค่าเวลานิ่ง ๆ สั้น ๆ ไม่พอ
 *   → วัดตอนยังเลื่อนไม่ถึง → ไฮไลต์คนละหัวข้อ → เกณฑ์ตกทั้งที่ของถูก
 *   (เจอตอนรันรอบแรก: scrollIntoView() แล้ว active เป็น #be แทน #fmt)
 *
 * ⚠️ และต้องรอ IntersectionObserver เสร็จด้วย ไม่ใช่แค่รอ scroll นิ่ง
 *   ถ้ารอผิดลำดับจะอ่านค่าเก่า
 */
await evaluate(`(() => {
  document.documentElement.style.scrollBehavior = 'auto'
  document.querySelector('#${SPY_ID}').scrollIntoView({ block: 'start' })
})()`)

// รอจน scrollY หยุดเปลี่ยน
let lastY = -1
for (let i = 0; i < 30; i++) {
  const y = await evaluate(`Math.round(window.scrollY)`)
  if (y === lastY) break
  lastY = y
  await sleep(150)
}
await sleep(700) // ให้ IntersectionObserver ยิง callback เสร็จ

const active = await evaluate(`(() => {
  const a = document.querySelector('.sidenav a.active')
  return a ? a.getAttribute('href') : null
})()`)
check(`เลื่อนไปหัวข้อ #${SPY_ID} แล้วเมนูไฮไลต์ตรงกัน`, active === `#${SPY_ID}`, `active=${active} · scrollY=${lastY}`)

// ค้นหาแล้วต้องกรองหัวข้อจริง
await evaluate(`(() => {
  const s = document.getElementById('search')
  s.value = 'พ.ศ.'
  s.dispatchEvent(new Event('input', { bubbles: true }))
})()`)
await sleep(600)
const search = await evaluate(`(() => {
  const shown = [...document.querySelectorAll('.content section')].filter((s) => !s.hidden)
  return {
    shown: shown.map((s) => s.id),
    marks: document.querySelectorAll('mark').length,
    navVisible: [...document.querySelectorAll('.sidenav a')].filter((a) => a.style.display !== 'none').length,
  }
})()`)
check('ค้น “พ.ศ.” แล้วเหลือเฉพาะหัวข้อที่เกี่ยวข้อง',
  search.shown.length > 0 && search.shown.length < EXPECTED, `${search.shown.length} section: ${search.shown.join(', ')}`)
check('คำที่ค้นถูกไฮไลต์', search.marks > 0, `${search.marks} จุด`)

// ล้างคำค้นกลับ
await evaluate(`(() => {
  const s = document.getElementById('search')
  s.value = ''
  s.dispatchEvent(new Event('input', { bubbles: true }))
})()`)
await sleep(600)
const cleared = await evaluate(`[...document.querySelectorAll('.content section')].filter((s) => !s.hidden).length`)
check('ล้างคำค้นแล้วทุกหัวข้อกลับมา', cleared === EXPECTED, `${cleared} section`)
const marksGone = await evaluate(`document.querySelectorAll('mark').length`)
check('ไฮไลต์ถูกลบหมดแล้ว', marksGone === 0, `${marksGone} mark เหลือ`)

// เช็กบล็อกต้องกดได้และจำสถานะได้
const before = await evaluate(`document.querySelectorAll('.check input:checked').length`)
await evaluate(`document.querySelector('.check input').click()`)
await sleep(400)
const afterClick = await evaluate(`document.querySelectorAll('.check input:checked').length`)
check('คลิกเช็กบล็อกได้', afterClick === before + 1, `${before} → ${afterClick}`)

await send('Page.navigate', { url: URL })
await waitFor(`document.querySelector('.check input')`, 20000)
await sleep(1000)
const afterReload = await evaluate(`document.querySelectorAll('.check input:checked').length`)
check('จำสถานะเช็กบล็อกไว้ข้ามการโหลดหน้าใหม่', afterReload === afterClick, `${afterReload} ถูกติ๊ก`)

// เก็บกลับเป็นสถานะว่าง ไม่ให้เหลือรอยในเครื่องผู้ใช้
await evaluate(`(() => { localStorage.removeItem('carbone-th-manual-checklist') })()`)

const { data } = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true })
writeFileSync(join(OUT, 'manual.png'), Buffer.from(data, 'base64'))

console.log(`\n── ผ่าน ${pass} · ไม่ผ่าน ${fail} ─────────────────────\n`)
console.log(`ภาพ: ${OUT}`)

await send('Browser.close').catch(() => undefined)
chrome.kill()
ws.close()
process.exit(fail ? 1 : 0)
