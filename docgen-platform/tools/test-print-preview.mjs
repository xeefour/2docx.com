/**
 * ตรวจปุ่มพิมพ์รูปเอกสาร
 *
 *   node --env-file=.env tools/test-print-preview.mjs
 *
 * ── สิ่งที่ต้องผ่าน ────────────────────────────────────────────
 * 1. มีปุ่มพิมพ์ในแถบเครื่องมือ ติดกับแถบซูม และอยู่ทางซ้ายของปุ่มดาวน์โหลด
 * 2. กระดาษพิมพ์ (`.printsheet`) ต้องอยู่ใต้ `<body>` **โดยตรง**
 *    เพราะ CSS ตอนพิมพ์ซ่อนด้วย `body > *:not(.printsheet)`
 *    ถ้าซ้อนอยู่ใต้ต้นไม้ของแอป จะถูกซ่อนไปด้วยและได้กระดาษว่าง
 * 3. ตอนออนไลน์ต้อง `display: none` ไม่งั้นกระดาษจะไปกินความสูงของเพจ
 * 4. กดแล้วต้องเรนเดอร์รูปครบทุกหน้า (ไม่ใช่แค่หน้าที่เลือกอยู่บนจอ)
 * 5. รูปต้องเป็น PNG จริง และกว้างกว่า canvas บนจอมาก
 *    (ถ้าแอบเอา canvas ที่วาดไว้บนจอ จะได้ ~630px = เส้นหยักตอนพิมพ์)
 * 6. `window.print()` ถูกเรียกหลังรูปโหลดครบแล้วเท่านั้น
 * 7. พิมพ์เสร็จต้องล้างกระดาษและปล่อย object URL ทิ้ง (ไม่รั่ว)
 * 8. CSS ตอนพิมพ์ต้องซ่อนแอป และตั้ง `break-after: page` ทุกหน้า
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
const PORT = 9381
const WEB = 'http://localhost:3000'
const OUT = new URL('../tests/nav-status/output-print-preview/', import.meta.url)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
mkdirSync(OUT, { recursive: true })

let pass = 0
let fail = 0
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`)
  ok ? pass++ : fail++
}

const redis = new Redis(process.env.VALKEY_URL)
const sid = `print-${Date.now()}`
await redis.set(
  `session:${sid}`,
  JSON.stringify({ sub: sid, name: 'ผู้ทดสอบพิมพ์', email: 'print@test.local', avatar: '' }),
  'EX',
  1800,
)
const H = { cookie: `docgen_session=${sid}`, 'content-type': 'application/json' }

const tpl = await pickTemplate(H, [TEST_TEMPLATES.multipage])
const key = keyOf(tpl)
const formSnap = await snapshotForm(H, key)
await importTags(H, tpl)
console.log(`ใช้แม่แบบ: ${tpl.name} (key ${key})`)

const profile = mkdtempSync(join(tmpdir(), 'cdp-print-'))
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
    console.log('  [หน้าเว็บยิน error]', String(m.params.exceptionDetails?.exception?.description ?? '').slice(0, 300))
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
const waitFor = async (expr, timeoutMs = 60000, step = 200) => {
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
const boxOf = (sel) =>
  evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(sel)})
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }
  })()`)
const clickTestId = async (id) => {
  const b = await evaluate(`(() => {
    const el = document.querySelector('[data-testid=${JSON.stringify(id)}]')
    if (!el) return null
    el.scrollIntoView({ block: 'center' })
    const r = el.getBoundingClientRect()
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
  })()`)
  if (!b) return false
  for (const type of ['mousePressed', 'mouseReleased'])
    await send('Input.dispatchMouseEvent', { type, x: b.x, y: b.y, button: 'left', clickCount: 1 })
  return true
}

await send('Page.enable')
await send('Runtime.enable')
await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false })
await send('Network.setCookie', { name: 'docgen_session', value: sid, url: WEB })
await send('Network.setCacheDisabled', { cacheDisabled: true })

/**
 * ⚠️ ต้องแทน `window.print()` **ก่อน** โหลดหน้า
 *    เพราะโค้ดเรียกมันตอนคลิก ถ้าเรียกจริงใน headless จะค้างหรือเปิดกล่องโต้ตอบ
 *
 * ⚠️ ตัวแทนต้องเป็น**ฟังก์ชันซิงโครนัส**
 *    โค้ดแอปเรียก `print()` แล้วล้างกระดาษทันทีใน `finally`
 *    ถ้าตัวแทนเป็น async มันจะอ่านกระดาษทันทีหลังแอปล้างไปแล้ว → ได้ 0 รูปเสมอ
 *
 * ⚠️ จึง**อ่านไบต์ดิบไม่ได้** เพราะ `responseType` ตั้งบน sync XHR ไม่ได้
 *    (InvalidAccessError ตามสเปก) และการไม่ตั้งจะได้ string ที่ถอดรหัสผิด
 *    เลยตรวจสิ่งที่ผู้ใช้สำคัญกว่าแทน: **รูปต้องไม่ว่าง**
 *    (พิมพ์แล้วได้กระดาษขาว ๆ คือบั๊กที่เจอบ่อยกว่าไฟล์ผิดสกุล)
 */
await send('Page.addScriptToEvaluateOnNewDocument', {
  source: `
    window.__printCalls = []
    window.print = function () {
      const imgs = [...document.querySelectorAll('.printsheet img')]
      const ink = imgs.map((img) => {
        try {
          const c = document.createElement('canvas')
          c.width = img.naturalWidth
          c.height = img.naturalHeight
          const g = c.getContext('2d')
          g.drawImage(img, 0, 0)
          const d = g.getImageData(0, 0, c.width, c.height).data
          let n = 0
          for (let i = 0; i < d.length; i += 4) {
            if (d[i] < 240 || d[i + 1] < 240 || d[i + 2] < 240) n++
          }
          return Math.round((n / (d.length / 4)) * 1000) / 10
        } catch { return -1 }
      })
      window.__printCalls.push({
        images: imgs.length,
        // ทุกรูปต้องถูกถอดรหัสเสร็จแล้ว ไม่งั้นพิมพ์ออกมาหน้าว่าง
        decoded: imgs.length > 0 && imgs.every((i) => i.complete && i.naturalWidth > 0),
        widths: imgs.map((i) => i.naturalWidth),
        ink,
      })
    }
  `,
})

console.log('\n[1] เปิดแม่แบบแล้วเรนเดอร์')
await send('Page.navigate', { url: `${WEB}/studio/${key}?tabs=form&pane=preview` })
await waitFor("!!document.querySelector('.dl__btn')", 45000)
await sleep(600)
await evaluate(FILL_FIELDS_JS)
await sleep(400)
await evaluate(`[...document.querySelectorAll('button')].find((b) => b.textContent.includes('เรนเดอร์ตัวอย่าง'))?.click()`)
const rendered = await waitFor(canvasDrawnJs(), 120000)
check('เรนเดอร์ตัวอย่างสำเร็จ', rendered)

const total = await evaluate(
  "Number((document.querySelector('.doctools .muted')?.textContent ?? '').match(/\\/\\s*(\\d+)/)?.[1] ?? 0)",
)
console.log(`  เอกสาร ${total} หน้า`)

console.log('\n[2] ปุ่มพิมพ์อยู่บนแถบเครื่องมือ')
const printBtn = await boxOf('[data-testid="print-doc"]')
const zoomBox = await boxOf('.doctools .mono')
const dlBox = await boxOf('.dl__btn')
check('มีปุ่มพิมพ์', !!printBtn, printBtn ? `x=${printBtn.x} y=${printBtn.y}` : 'ไม่พบ')
check('ปุ่มพิมพ์อยู่บรรทัดเดียวกับแถบซูม', printBtn && zoomBox && Math.abs(printBtn.y - zoomBox.y) < 24, printBtn && zoomBox ? `พิมพ์ y=${printBtn.y} · ซูม y=${zoomBox.y}` : 'วัดไม่ได้')
check('ปุ่มพิมพ์อยู่ทางซ้ายของปุ่มดาวน์โหลด', printBtn && dlBox && printBtn.x < dlBox.x, printBtn && dlBox ? `พิมพ์ x=${printBtn.x} · ดาวน์โหลด x=${dlBox.x}` : 'วัดไม่ได้')

console.log('\n[3] กระดาษพิมพ์อยู่ใต้ <body> โดยตรง')
const sheet = await evaluate(`(() => {
  const el = document.querySelector('.printsheet')
  if (!el) return null
  const cs = getComputedStyle(el)
  return {
    parentIsBody: el.parentElement === document.body,
    display: cs.display,
    // ต้องเป็นลูกของ body ระดับเดียว ไม่ซ้อนลึกกว่านั้น
    bodyChildren: [...document.body.children].map((c) => c.tagName + '.' + (c.className || '')).join(' | '),
  }
})()`)
check('มีกระดาษพิมพ์ .printsheet', !!sheet)
check('อยู่เป็นลูกโดยตรงของ <body>', sheet?.parentIsBody === true, sheet?.bodyChildren ?? '')
check('ตอนออนไลน์ซ่อนอยู่ (display:none)', sheet?.display === 'none', `display=${sheet?.display}`)

console.log('\n[4] กดพิมพ์แล้วต้องได้รูปครบทุกหน้า')
const screenW = await evaluate("document.querySelector('.docpage canvas')?.width ?? 0")
await clickTestId('print-doc')
const called = await waitFor('window.__printCalls.length > 0', 120000)
check('เรียก window.print()', called)
const call = (await evaluate('window.__printCalls[0] ?? null')) ?? {}
check('รูปในกระดาษพิมพ์ครบทุกหน้า', call.images === total, `ได้ ${call.images} หน้า · เอกสาร ${total} หน้า`)
check('ทุกรูปถูกถอดรหัสเสร็จก่อนพิมพ์ (ไม่ใช่หน้าว่าง)', call.decoded === true, `decoded=${call.decoded}`)
/**
 * ⚠️ ต้องกว้างกว่า canvas บนจอมาก
 *    canvas บนจอถูกย่อให้พอดีคอลัมน์ (~630px) ถ้าเอามาพิมพ์ตรง ๆ จะเป็นเส้นหยัก
 *    `toPng(n, 2)` ให้ A4 ≈ 1190px
 */
const w = call.widths?.[0] ?? 0
check('รูปความละเอียดสำหรับพิมพ์ ไม่ใช่ canvas ที่ย่อตามจอ', w > Math.max(1000, screenW * 1.5), `กว้าง ${w}px · canvas บนจอ ${screenW}px`)
/**
 * ⚠️ เกณฑ์ต้องต่ำพอสำหรับหน้าที่มีข้อความน้อย
 *    หน้าหัวกระดาษราชการที่มีแค่หัวเรื่องกับเลขที่ วัดได้จริงแค่ ~0.3% หมึก
 *    กระดาษว่างจริงได้ 0.0% → ใช้เกณฑ์ 0.05% ที่ยังแยกสองกรณีนี้ออกจากกันได้
 */
check(
  'รูปไม่ว่าง (พิมพ์แล้วได้เนื้อหาจริง ไม่ใช่กระดาษขาว)',
  Array.isArray(call.ink) && call.ink.length === total && call.ink.every((p) => p > 0.05),
  `หมึก ${call.ink?.join('%, ') ?? '-'}% ต่อหน้า (เกณฑ์ > 0.05%)`,
)
await shot('01-print-button.png')

console.log('\n[5] พิมพ์เสร็จต้องเก็บกวาด')
const cleaned = await waitFor("document.querySelectorAll('.printsheet img').length === 0", 15000)
check('ล้างรูปออกจากกระดาษหลังพิมพ์', cleaned)
const disabled = await evaluate("!!document.querySelector('[data-testid=\"print-doc\"]')?.disabled")
check('ปุ่มไม่ค้าง disabled (ใช้ซ้ำได้)', disabled === false)

console.log('\n[6] CSS ตอนพิมพ์')
const css = await (await fetch('http://localhost:3000/_next/static/css/app/layout.css')).text()
check('ซ่อนแอปตอนพิมพ์ (body > *:not(.printsheet))', css.includes('body > *:not(.printsheet)'))
check('กระดาษพิมพ์แสดงตอนพิมพ์ (display: block !important)', /\.printsheet\{display:block!important/.test(css.replace(/\s+/g, '')))
// ⚠️ อย่าเขียน regex แบบ `/@page\{margin:0\}/` — minifier อาจคง `;` ท้ายค่าไว้
//    ใช้รูปแบบที่ไม่สนคำสั่งว่าง/เครื่องหมาย `;` แทน
check('ตัดหน้าให้พอดีขอบกระดาษ (@page margin 0)', /@page\s*\{[^}]*margin:\s*0/.test(css))
check('แต่ละหน้าขึ้นกระดาษใหม่ (break-after: page)', css.includes('break-after: page'))

// เก็บกวาด
await restoreForm(H, key, formSnap)
await send('Browser.close').catch(() => {})
chrome.kill()
await redis.del(`session:${sid}`)
redis.disconnect()

console.log(`\n── ผ่าน ${pass} · ไม่ผ่าน ${fail} ─────────────────────`)
console.log(`ภาพ: ${OUT.pathname}\n`)
process.exit(fail ? 1 : 0)
