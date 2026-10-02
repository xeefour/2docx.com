/**
 * ตรวจว่าหน้าเว็บจัดการ 429 (โควตาหมด) ได้ถูกต้อง
 *
 *   node --env-file=.env tools/test-rate-limit-ui.mjs
 *
 * ── ปัญหาที่เคยเจอ ────────────────────────────────────────────────
 * ผู้ใช้กดบุ๊กมาร์กแล้วขึ้น "ยิงบ่อยเกินไป" · กดซ้ำก็ไม่ได้ · ไม่บอกว่าต้องรอนานแค่ไหน
 *
 * `call()` ใน `apps/web/app/studio/lib/api.ts` ครอบ retry ไว้แค่ 502/503/504
 * (สถานะที่แปลว่าเซิร์ฟเวอร์ "ยังไม่ได้ประมวลผล" คำขอ → ทำซ้ำปลอดภัย)
 * 429 เลยหลุดไปโดยไม่รอ ทั้งที่เซิร์ฟเวอร์ส่ง `Retry-After` กลับมาแล้ว
 *
 * ── ทำไมต้อง mock แทนที่จะยิงจริงจนโควตาหมด ──────────────────────
 * สคริปต์รุ่นแรกยิง API จนของจริงคือ 600 req/นาทีหมด
 * → ไปตีน้ำนักเอง แล้วผู้ใช้เปิดหน้าเว็บแล้วโดน 429 ทันทีโดยไม่ได้ทำอะไรผิด
 * ตอนนี้ใช้ CDP `Fetch.fulfillRequest` ตอบ 429 ปลอม ๆ แทน → โควตาจริงไม่ถูกแตะ
 *
 * ── สิ่งที่ต้องผ่าน ────────────────────────────────────────────────
 * 1. ได้ 429 ที่บอกรอสั้น ๆ (Retry-After 2 วิ) → หน้ารอแล้วลองใหม่จนสำเร็จเอง ไม่ขึ้น error
 * 2. ได้ 429 ที่รอนานเกิน (Retry-After 30 วิ) → ต้อง**ไม่รอ** แต่ขึ้นบอกว่ารออีกกี่วินาที
 * 3. Retry-After ไม่ใช่ตัวเลข → ไม่ค้าง และยังบอกผู้ใช้ได้
 * 4. 429 ไม่ถูกนับเป็น retry ของ 502/503/504 (ทำซ้ำแล้วต้องจบ ไม่วนไปเรื่อย)
 */
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Redis } from 'ioredis'

const CHROME = process.env.CHROME_PATH ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const PORT = 9346
const WEB = 'http://localhost:3000'
const OUT = new URL('../tests/nav-status/output-rate-limit-ui/', import.meta.url)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
mkdirSync(OUT, { recursive: true })

let pass = 0
let fail = 0
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`)
  ok ? pass++ : fail++
}

const redis = new Redis(process.env.VALKEY_URL)
const sid = `rlui-${Date.now()}`
await redis.set(
  `session:${sid}`,
  JSON.stringify({ sub: sid, name: 'ผู้ทดสอบโควตา', email: 'rlui@test.local', avatar: '' }),
  'EX',
  900,
)

const profile = mkdtempSync(join(tmpdir(), 'cdp-rlui-'))
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
    wsUrl = list.find((x) => x.type === 'page')?.webSocketDebuggerUrl
  } catch { /* ยังไม่พร้อม */ }
}
if (!wsUrl) {
  console.log('✗ ต่อ Chrome DevTools ไม่ได้')
  chrome.kill()
  await redis.del(`session:${sid}`)
  redis.disconnect()
  process.exit(1)
}

/**
 * โหมดการตอบ 429 ปลอม
 * @type {{ on: boolean, header: string, hits: number, ttl: number }}
 */
const rl = { on: false, header: '2', hits: 0, ttl: 0 }

/** ตั้งให้ตอบ 429 อีก `ttl` ครั้งถัดไป แล้วปล่อยผ่าน */
const startFakeRateLimit = (retryAfter, ttl) => {
  rl.on = true
  rl.header = String(retryAfter)
  rl.hits = 0
  rl.ttl = ttl
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
  if (m.method === 'Fetch.requestPaused') {
    const { requestId } = m.params
    if (rl.on && rl.hits < rl.ttl) {
      rl.hits++
      const headers = [
        { name: 'content-type', value: 'application/json; charset=utf-8' },
        { name: 'retry-after', value: rl.header },
      ]
      const body = JSON.stringify({
        code: 'RATE_LIMITED',
        message: 'ยิงบ่อยเกินไป ลองอีกครั้งในอีกสัครู่',
      })
      send('Fetch.fulfillRequest', {
        requestId,
        responseCode: 429,
        responseHeaders: headers,
        body: Buffer.from(body).toString('base64'),
      })
      return
    }
    send('Fetch.continueRequest', { requestId })
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
const waitFor = async (expr, timeoutMs = 20000, step = 150) => {
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
const rows = () => evaluate('document.querySelectorAll(\'table tbody tr\').length')
const bodyText = () => evaluate("document.body.innerText.replace(/\\s+/g, ' ')")

await send('Page.enable')
await send('Runtime.enable')
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false })
await send('Network.setCookie', { name: 'docgen_session', value: sid, url: WEB })
await send('Network.setCacheDisabled', { cacheDisabled: true })
await send('Fetch.enable', { patterns: [{ urlPattern: '*/api/*', requestStage: 'Request' }] })

console.log('\n[1] เบสไลน์ — ปกติต้องเห็นตารางแม่แบบ')
await send('Page.navigate', { url: `${WEB}/studio` })
const baseOk = await waitFor("!document.querySelector('.bootveil')", 60000)
  .then(() => waitFor("document.querySelectorAll('table tbody tr').length > 0", 45000))
check('ปกติ: หน้าโหลดและเห็นรายการแม่แบบ', baseOk, `${await rows()} แถว`)
await shot('01-baseline.png')

console.log('\n[2] 429 ที่บอกรอสั้น (Retry-After 2 วิ) — ต้องรอแล้วลองใหม่จนได้')
startFakeRateLimit(2, 1)
const t0 = Date.now()
await send('Page.reload', { ignoreCache: false })
const recovered = await waitFor("document.querySelectorAll('table tbody tr').length > 0", 25000)
const waited = Date.now() - t0
check('หน้าฟื้นเอง ไม่ต้องรีเฟรช', recovered && rl.hits >= 1, `โดน 429 ${rl.hits} ครั้ง · รอรวม ${waited} ms · ${await rows()} แถว`)
check('มันรอตามที่เซิร์ฟเวอร์บอกจริง (ไม่ยิงรัวทันที)', waited >= 1500, `${waited} ms`)
const txtAfter = await bodyText()
check('ไม่มีข้อความ error ค้างหลังฟื้น', !/ยิงบ่อยเกินไป|เชื่อมต่อ API ไม่สำเร็จ/.test(txtAfter), txtAfter.slice(0, 60))
await shot('02-recovered-after-short-wait.png')

console.log('\n[3] 429 ที่รอนานเกิน (Retry-After 30 วิ) — ต้องไม่รอ แต่บอกว่ารออีกกี่วินาที')
rl.on = false
await waitFor("document.querySelectorAll('table tbody tr').length > 0", 25000)
startFakeRateLimit(30, 99)
const t1 = Date.now()
await send('Page.reload', { ignoreCache: false })
const sawWait = await waitFor('/โควตาจะเต็มใหม่ใน \\d+ วินาที|ยิงบ่อยเกินไป/.test(document.body.innerText)', 25000)
const waitedLong = Date.now() - t1
const longTxt = (await bodyText()).replace(/\s+/g, ' ')
check('ขึ้นข้อความบอกผู้ใช้ตรง ๆ', sawWait, longTxt.slice(0, 110))
check('บอกจำนวนวินาทีที่ต้องรอจริง', /โควตาจะเต็มใหม่ใน 3\d วินาที/.test(longTxt), longTxt.match(/โควตาจะเต็มใหม่ใน \d+ วินาที/)?.[0] ?? 'ไม่เจอ')
check(
  'ไม่ยืนรอ 30 วินาที (เกินเพดาน 12 วินาที → บอกผู้ใช้แทนที่จะค้างหน้าจอ)',
  waitedLong < 12_000,
  `ใช้เวลา ${waitedLong} ms`,
)
await shot('03-long-wait-message.png')

console.log('\n[4] Retry-After ที่อ่านไม่ออก — ต้องไม่ค้าง และยังบอกผู้ใช้ได้')
rl.on = false
await waitFor("document.querySelectorAll('table tbody tr').length > 0", 25000)
startFakeRateLimit('ไม่ใช่ตัวเลข', 99)
const t2 = Date.now()
await send('Page.reload', { ignoreCache: false })
const sawBad = await waitFor('/ยิงบ่อยเกินไป|โควตาจะเต็มใหม่/.test(document.body.innerText)', 20000)
const waitedBad = Date.now() - t2
check('ไม่ค้าง และขึ้นข้อความแทน', sawBad && waitedBad < 12_000, `${waitedBad} ms · ${(await bodyText()).slice(0, 90)}`)
await shot('04-bad-retry-after.png')

console.log('\n[5] ปิดการจำลอง — หน้าต้องกลับมาใช้งานได้ตามปกติ')
rl.on = false
await send('Fetch.disable')
await send('Page.reload', { ignoreCache: false })
const finalOk = await waitFor("document.querySelectorAll('table tbody tr').length > 0", 30000)
check('กลับมาใช้งานได้ตามปกติ', finalOk, `${await rows()} แถว`)
await shot('05-normal-again.png')

await send('Browser.close').catch(() => {})
chrome.kill()
await redis.del(`session:${sid}`)
redis.disconnect()

console.log(`\n── ผ่าน ${pass} · ไม่ผ่าน ${fail} ─────────────────────\n`)
process.exit(fail ? 1 : 0)
