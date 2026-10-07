/**
 * ทดสอบว่าหน้าเว็บ "ทนทาน" ต่อการที่ API ล่มชั่วคราวหรือไม่
 *
 *   node --env-file=../dokploy-infra/.env --env-file=../dokploy-infra/.env.development tools/test-api-retry.mjs
 *
 * ── ทำไมต้องเทสต์เรื่องนี้ ──────────────────────────────────────
 * ตอนผู้ใช้เจอ "เชื่อมต่อ API ไม่สำเร็จ — ได้ 500 Internal Server Error แทน JSON"
 * สาเหตุคือ proxy ของ Next ตอบ 500 text ธรรมดาตอน Fastify กำลังรีสตาร์ท
 * (ดู next/dist/server/base-server.js → `res.body('Internal Server Error').send()`)
 *
 * การฆ่า API จริงเพื่อทดสอบเสี่ยงทำให้ผู้ใช้ใช้งานไม่ได้
 * เลยใช้ CDP แยก request แทน — ผลเหมือนกันเป๊ะทั้งสองทาง:
 *   · `Fetch.failRequest`      → เหมือนต่อไม่ได้ (API ไม่ได้ฟังพอร์ต)
 *   · `Fetch.fulfillRequest`   → ได้ 500 text ธรรมดา (เหมือน proxy ตอบตอน API ล่ม)
 *
 * ── สิ่งที่ต้องผ่าน ──────────────────────────────────────────────
 * 1. ปกติ — หน้าโหลดและเห็นตารางแม่แบบ
 * 2. API ต่อไม่ได้ 1.2 วิ — หน้าต้องเด้งกลับมาเอง ไม่ต้องรีเฟรช
 * 3. API ตอบ 500 text 1.2 วิ — เหมือนกัน ต้องฟื้นเอง
 * 4. ตอนฟื้นแล้วต้องไม่มีข้อความ error ค้างอยู่บนหน้า
 * 5. ถ้า API ล่มนานเกิน 4 วิ — ต้องขึ้นข้อความที่บอกว่าลองไปกี่ครั้ง (ไม่เงียบทิ้ง)
 */
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Redis } from 'ioredis'

const CHROME = process.env.CHROME_PATH ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const PORT = 9341
const WEB = 'http://localhost:3000'
const OUT = new URL('../tests/nav-status/output-api-retry/', import.meta.url)

/** ระยะเวลาที่ปล่อยให้ request ล้มเหลว (มิลลิวินาที) */
const DOWN_MS = 1200

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
mkdirSync(OUT, { recursive: true })

let pass = 0
let fail = 0
function check(name, ok, detail = '') {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`)
  ok ? pass++ : fail++
}

const redis = new Redis(process.env.VALKEY_URL)
const sid = `retry-${Date.now()}`
await redis.set(
  `session:${sid}`,
  JSON.stringify({ sub: sid, name: 'ผู้ทดสอบ retry', email: 'retry@test.local', avatar: '' }),
  'EX',
  900,
)

const profile = mkdtempSync(join(tmpdir(), 'cdp-retry-'))
const chrome = spawn(
  CHROME,
  ['--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run', '--window-size=1440,1000',
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

/** โหมดการแยก request — เปลี่ยนจากเทสต์ได้ระหว่างทาง */
let intercept = 'off'
let blocked = 0
/**
 * เริ่มนับช่วงที่ "ปล่อยให้ล้มเหลว" ตั้งแต่คำขอแรกที่โดนตัดจริง ๆ
 *
 * ⚠️ ไม่ใช้เวลานับจากตอนกด reload เพราะหน้าเว็บ dev โหลดช้าแตกผัน
 *   (แรก ๆ ร้อน แต่พอปิด cache แล้วดึง JS ใหม่หมด → กินเวลานานกว่าหน้าต่างที่ตั้งไว้)
 *   ถ้านับจากตอน reload ช่วงที่ตั้งไว้จะหมดไปก่อนหน้าจะยิง API สักครั้ง
 *   → ตัดได้ 0 ครั้ง แต่เทสต์กลับ "ผ่าน" ทั้งที่ไม่ได้ทดสอบอะไรเลย
 */
let firstBlockAt = 0
let outageMs = 0

/** เริ่มจำลองการล่มครั้งใหม่ — คืน promise ที่ resolve เมื่อครบช่วงเวลา */
const startOutage = (mode, ms) => {
  intercept = mode
  blocked = 0
  firstBlockAt = 0
  outageMs = ms
  return sleep(ms)
}

const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++seq
    waiting.set(id, { resolve, reject })
    ws.send(JSON.stringify({ id, method, params }))
  })

ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data)

  // ── event จาก Fetch domain: ตัด request ตามโหมด ────────────────
  if (m.method === 'Fetch.requestPaused') {
    const { requestId } = m.params
    // คำขอแรกที่มาถึง = จุดเริ่มนับ (ดูคำอธิบายของ firstBlockAt)
    if (intercept !== 'off' && firstBlockAt === 0) firstBlockAt = Date.now()
    const down = firstBlockAt > 0 && Date.now() - firstBlockAt < outageMs

    if (!down) {
      send('Fetch.continueRequest', { requestId })
      return
    }
    blocked++
    if (intercept === 'refuse') {
      send('Fetch.failRequest', { requestId, errorReason: 'ConnectionRefused' })
    } else {
      // เหมือน proxy ของ Next ตอบตอน Fastify ล่ม — text ธรรมดา ไม่ใช่ JSON
      send('Fetch.fulfillRequest', {
        requestId,
        responseCode: 500,
        responseHeaders: [{ name: 'content-type', value: 'text/plain' }],
        body: Buffer.from('Internal Server Error').toString('base64'),
      })
    }
    return
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
/**
 * รอเงื่อนไขให้เป็นจริง โดยทนต่อการที่หน้ากำลัง navigate
 * (ระหว่าง reload execution context ของเบราว์เซอร์ถูกทิ้ง
 *  evaluate จะโยน error — ต้องรอต่อ ไม่ใช่พังเทสต์)
 */
const waitFor = async (expr, timeoutMs = 20000, step = 150) => {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    try {
      if (await evaluate(expr)) return true
    } catch {
      /* กำลัง navigate — รอรอบหน้าใหม่ */
    }
    await sleep(step)
  }
  return false
}
const shot = async (name) => {
  const { data } = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(new URL(name, OUT), Buffer.from(data, 'base64'))
}
const rows = () => evaluate("document.querySelectorAll('table tbody tr').length")
/** ข้อความ error ที่อาจค้างอยู่บนหน้า */
const errorText = () =>
  evaluate(`(() => {
    const el = [...document.querySelectorAll('*')]
      .filter((n) => n.children.length === 0 && /เชื่อมต่อ API ไม่สำเร็จ|ลองแล้ว \\d+ ครั้ง/.test(n.textContent || ''))
    return el.map((n) => n.textContent.trim()).join(' | ')
  })()`)

await send('Page.enable')
await send('Runtime.enable')
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false })
await send('Network.setCookie', { name: 'docgen_session', value: sid, url: WEB })
/**
 * ⚠️ ต้องปิด cache ไม่งั้นเทสต์หลอกตัวเอง
 * เบราว์เซอร์ cache `GET /api/templates` ได้ (Fastify ไม่ได้ส่ง cache-control)
 * รอบก่อนหน้าที่ API "ปกติ" จะทำให้รอบถัดไปไม่ออกเน็ตเลย
 * → ตัด request ได้ 0 ครั้ง แต่หน้าก็ยัง "ผ่าน" ทั้งที่ไม่ได้ทดสอบอะไรเลย
 */
await send('Network.setCacheDisabled', { cacheDisabled: true })
await send('Fetch.enable', { patterns: [{ urlPattern: '*/api/*', requestStage: 'Request' }] })

// ── 1. เบสไลน์ ────────────────────────────────────────────────
await send('Page.navigate', { url: `${WEB}/studio` })
await waitFor("!document.querySelector('.bootveil')", 40000)
const baseOk = await waitFor("document.querySelectorAll('table tbody tr').length > 0", 30000)
check('1. ปกติ — หน้าโหลดและเห็นตารางแม่แบบ', baseOk, `${await rows()} แถว`)
await shot('01-baseline.png')

// ── 2. API ต่อไม่ได้ ───────────────────────────────────────────
console.log(`\n  … จำลอง API ต่อไม่ได้ ${DOWN_MS} มิลลิวินาที`)
const outage2 = startOutage('refuse', DOWN_MS)
await send('Page.reload', { ignoreCache: false })
await outage2

const recoveredRefuse = await waitFor("document.querySelectorAll('table tbody tr').length > 0", 15000)
check(
  '2. API ต่อไม่ได้ชั่วคราว → หน้าฟื้นเอง ไม่ต้องรีเฟรช',
  recoveredRefuse,
  `ถูกตัด ${blocked} ครั้ง · ${await rows()} แถว`,
)
const errAfterRefuse = await errorText()
check('2b. หลังฟื้นแล้วไม่มีข้อความ error ค้าง', errAfterRefuse === '', errAfterRefuse || 'ไม่มี')
await shot('02-after-refused.png')

// ── 3. API ตอบ 500 text (เหมือน proxy ตอบตอน Fastify ล่ม) ──────
console.log(`\n  … จำลอง API ตอบ 500 text ${DOWN_MS} มิลลิวินาที (เหมือนเคสที่เจอ)`)
const outage3 = startOutage('fivehundred', DOWN_MS)
await send('Page.reload', { ignoreCache: false })
await outage3

const recovered500 = await waitFor("document.querySelectorAll('table tbody tr').length > 0", 15000)
check(
  '3. API ตอบ 500 text → หน้าฟื้นเอง',
  recovered500 && blocked > 0,
  `ถูกตัด ${blocked} ครั้ง · ${await rows()} แถว`,
)
const errAfter500 = await errorText()
check('3b. หลังฟื้นแล้วไม่มีข้อความ error ค้าง', errAfter500 === '', errAfter500 || 'ไม่มี')
await shot('03-after-500.png')

// ── 4. ล่มนานเกิน 4 วิ → ต้องบอกว่าลองไปกี่ครั้ง ───────────────────
console.log(`\n  … จำลอง API ล่มยาว 9 วินาที (เกินเวลารอของ retry)`)
startOutage('refuse', 9000)
await send('Page.reload', { ignoreCache: false })

const sawFinalError = await waitFor(
  "/ลองแล้ว \\d+ ครั้ง/.test(document.body.innerText)",
  20000,
  200,
)
const finalMsg = (await errorText()).replace(/\s+/g, ' ')
check('4. ล่มนานเกินไป → ขึ้นข้อความบอกจำนวนครั้งที่ลอง', sawFinalError, finalMsg || 'ไม่เจอข้อความ')
check('4b. ตัด request ไปตั้งแต่ 3 ครั้งขึ้นไป', blocked >= 3, `${blocked} ครั้ง`)
await shot('04-long-outage.png')

// ── ปิดการแยก แล้วยืนยันว่าฟื้นได้จริง ─────────────────────────
intercept = 'off'
await send('Fetch.disable')
await send('Page.reload', { ignoreCache: false })
const finalOk = await waitFor("document.querySelectorAll('table tbody tr').length > 0", 30000)
check('5. ปิดการจำลองแล้วหน้ากลับมาใช้งานได้ตามปกติ', finalOk, `${await rows()} แถว`)
await shot('05-recovered.png')

await send('Browser.close').catch(() => {})
chrome.kill()
await redis.del(`session:${sid}`)
redis.disconnect()

console.log(`\n── ผ่าน ${pass} · ไม่ผ่าน ${fail} ─────────────────────\n`)
process.exit(fail ? 1 : 0)
