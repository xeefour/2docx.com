/**
 * กดเปลี่ยนหน้าแล้ว React ต้องไม่เตือนเรื่อง style
 *
 *   node --env-file=.env tools/test-pager-style.mjs
 *
 * ── ผู้ใช้เจอ ────────────────────────────────────────────────────
 * *"Removing a style property during rerender (borderColor) when a
 *   conflicting property is set (border) can lead to styling bugs"*
 *
 * ── ต้นตอ ────────────────────────────────────────────────────────
 * ปุ่มเลขหน้าใช้ style ก้อนเดียวกัน (`btn`) ซึ่งตั้ง `border` (shorthand)
 * แต่ตอนหน้านั้น**ถูกเลือก** ทับด้วย `borderColor` (longhand)
 * พอกดเปลี่ยนหน้า ปุ่มเดิมกลับมาไม่ถูกเลือก → `borderColor` ถูกถอด
 * ขณะที่ `border` ยังอยู่ใน style object → React เตือน
 *
 * ── ทำไมต้องเทสต์ด้วยการกดจริง ──────────────────────────────────
 * ข้อความนี้เกิดตอน **rerender** เท่านั้น (เปลี่ยนจากเลือก → ไม่เลือก)
 * ถ้าแค่เปิดหน้าแล้วดู จะไม่เจอ เพราะหน้าแรกยังไม่เคยมีการสลับสถานะ
 * จึงต้องกดเปลี่ยนหน้าจริงอย่างน้อยหนึ่งครั้ง
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Redis } from 'ioredis'

const WEB = 'http://localhost:3000'
const CHROME = process.env.CHROME_PATH ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const PORT = 9421
const STAMP = Date.now()
const OUT = new URL('../tests/nav-status/output-pager-style/', import.meta.url)
mkdirSync(OUT, { recursive: true })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let pass = 0
let fail = 0
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`)
  ok ? pass++ : fail++
}

const redis = new Redis(process.env.VALKEY_URL)
const SID = `pgrstyle-${STAMP}`
await redis.set(
  `session:${SID}`,
  JSON.stringify({ sub: SID, name: 'ทดสอบสไตล์ปุ่มหน้า', email: `pgrstyle.${STAMP}@test.local`, avatar: '' }),
  'EX',
  1800,
)

const profile = mkdtempSync(join(tmpdir(), 'cdp-pgrstyle-'))
const chrome = spawn(
  CHROME,
  ['--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run', '--window-size=1280,950',
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
  await redis.del(`session:${SID}`)
  redis.disconnect()
  process.exit(1)
}

const ws = new WebSocket(wsUrl)
let seq = 0
const waiting = new Map()
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++seq
    const timer = setTimeout(() => reject(new Error(`timeout ${method}`)), 30000)
    waiting.set(id, {
      resolve: (v) => { clearTimeout(timer); resolve(v) },
      reject: (e) => { clearTimeout(timer); reject(e) },
    })
    ws.send(JSON.stringify({ id, method, params }))
  })

/** เก็บทุกข้อความที่ React พ่นออกมา */
const consoleErrors = []
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data)
  const s = waiting.get(m.id)
  if (s) {
    waiting.delete(m.id)
    m.error ? s.reject(new Error(m.error.message)) : s.resolve(m.result)
    return
  }
  if (m.method === 'Runtime.consoleAPICalled' && (m.params.type === 'error' || m.params.type === 'warning')) {
    const text = (m.params.args ?? []).map((a) => a.value ?? a.description ?? '').join(' ')
    consoleErrors.push({ type: m.params.type, text })
  }
  if (m.method === 'Runtime.exceptionThrown') {
    consoleErrors.push({ type: 'exception', text: m.params.exceptionDetails?.exception?.description ?? '' })
  }
})

await new Promise((r) => ws.addEventListener('open', r))
await send('Page.enable')
await send('Runtime.enable')
await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 950, deviceScaleFactor: 1, mobile: false })
await send('Network.setCacheDisabled', { cacheDisabled: true })
await send('Network.setCookie', { name: 'docgen_session', value: SID, url: WEB })

const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  return r.result?.value
}

/**
 * กดด้วยพิกัดจริง ไม่ใช่ `element.click()`
 * `element.click()` เรียก handler โดยไม่ผ่าน hit-testing ของเบราว์เซอร์
 * ซึ่งไม่ใช่สิ่งที่ผู้ใช้ทำจริง และผลของมันอาจต่างจากการกดจริง
 */
const clickPage = async (n) => {
  const box = await evaluate(`(() => {
    const el = document.querySelector('[data-testid="list-pager-page-${n}"]')
    if (!el) return null
    el.scrollIntoView({ block: 'center' })
    const r = el.getBoundingClientRect()
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
  })()`)
  if (!box) return false
  // ยืนยันว่าพิกัดนั้นชี้ถูกปุ่มจริง ๆ ไม่ใช่ถูกอย่างอื่นบัง
  const hit = await evaluate(`(() => {
    const el = document.elementFromPoint(${box.x}, ${box.y})
    return el?.getAttribute('data-testid') ?? null
  })()`)
  if (hit !== `list-pager-page-${n}`) return false
  for (const type of ['mousePressed', 'mouseReleased']) {
    await send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 })
  }
  return true
}

console.log(`\n── กดเปลี่ยนหน้าแล้ว React ต้องไม่เตือน ────────────\n`)

await send('Page.navigate', { url: `${WEB}/studio` })
await sleep(9000)

const ready = await evaluate(`(() => ({
  pages: document.querySelectorAll('[data-testid^="list-pager-page-"]').length,
  range: document.querySelector('[data-testid="list-pager-range"]')?.innerText.trim() ?? '',
}))()`)
check('แถบแบ่งหน้าโชว์อยู่', (ready?.pages ?? 0) >= 2, `${ready?.pages} ปุ่ม · ${ready?.range}`)

if ((ready?.pages ?? 0) < 2) {
  check('มีอย่างน้อย 2 หน้าให้ทดสอบ (ข้อมูลไม่พอ)', false, 'เพิ่มแม่แบบหรือปล่อยข้อมูลตัวอย่างก่อน')
} else {
  // จับ error ที่เกิดระหว่างกดจริง ๆ
  consoleErrors.length = 0

  for (const n of [2, 1, 3, 2]) {
    const clicked = await clickPage(n)
    await sleep(2200)
    check(`กดไปหน้า ${n} ได้`, clicked, clicked ? '' : 'พิกัดชี้ไม่ถูกปุ่ม')
  }

  const styleWarn = consoleErrors.filter((e) => /style property|conflicting property|borderColor/i.test(e.text))
  const other = consoleErrors.filter((e) => !/style property|conflicting property|borderColor/i.test(e.text))

  if (other.length) {
    console.log('    error อื่นที่เจอ:')
    other.slice(0, 5).forEach((e) => console.log(`      [${e.type}] ${e.text.slice(0, 160)}`))
  }

  check(
    'ไม่มี warning เรื่อง shorthand/longhand ชนกัน',
    styleWarn.length === 0,
    styleWarn.length ? `${styleWarn.length} ครั้ง · ${styleWarn[0].text.slice(0, 90)}` : 'สะอาด',
  )
  check('ไม่มี error อื่นระหว่างกดเปลี่ยนหน้า', other.length === 0, `${other.length} รายการ`)

  // กันไว้ให้ดูด้วยตา: หน้าตาต้องเหมือนเดิมหลังแก้ (ขอบหน้าที่เลือก = สีแบรนด์)
  const look = await evaluate(`(() => {
    const on = document.querySelector('[aria-current="page"]')
    if (!on) return null
    const cs = getComputedStyle(on)
    const off = document.querySelector('[data-testid^="list-pager-page-"]:not([aria-current="page"])')
    const co = off ? getComputedStyle(off) : null
    return {
      onBorder: cs.borderColor, onBg: cs.backgroundColor,
      offBorder: co?.borderColor ?? null, offBg: co?.backgroundColor ?? null,
    }
  })()`)
  check('ปุ่มหน้าที่เลือกมีสีแบรนด์', /109,\s*59,\s*191/.test(look?.onBorder ?? ''), look?.onBorder ?? '')
  // ⚠️ เช็คค่าจริง ไม่ใช่แค่ "ต่างจากอีกอัน"
  //   ตอนมีบั๊ก เส้นขอบของปุ่มที่ไม่ถูกเลือกกลายเป็นโปร่งใส (rgba(0,0,0,0))
  //   เพราะ `borderColor` ถูกถอดทิ้งแต่ shorthand `border` ยังค้างอยู่
  //   → เส้นขอบหายไปเฉย ๆ (ข้อความ React เตือนไว้ถูกแล้ว ไม่ใช่แค่เตือนลอย ๆ)
  check(
    'ปุ่มหน้าที่ไม่เลือกยังมีเส้นขอบสีเส้น (ไม่หายไป)',
    /230,\s*225,\s*238/.test(look?.offBorder ?? ''),
    look?.offBorder ?? '',
  )

  const png = await send('Page.captureScreenshot', { format: 'png' })
  const { writeFileSync } = await import('node:fs')
  const { fileURLToPath } = await import('node:url')
  // ⚠️ ห้ามใช้ `join(OUT.pathname, …)` บน Windows — pathname ของ file URL
  //    ขึ้นต้นด้วย "/" แล้ว drive ซ้ำกันเป็น "D:\D:\…"
  writeFileSync(join(fileURLToPath(OUT), 'pager-after-switch.png'), Buffer.from(png.data, 'base64'))
}

console.log(`\n── ผ่าน ${pass} · ไม่ผ่าน ${fail} ─────────────────────\n`)

await send('Browser.close').catch(() => undefined)
chrome.kill()
ws.close()
await redis.del(`session:${SID}`)
redis.disconnect()
process.exit(fail ? 1 : 0)
