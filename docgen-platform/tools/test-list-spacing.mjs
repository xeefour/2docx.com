/**
 * ตรวจช่องว่างระหว่างกล่องบนหน้ารายการ Studio
 *
 *   node --env-file=.env tools/test-list-spacing.mjs
 *
 * ── ปัญหาที่ต้องการแก้ ────────────────────────────────────────
 * สลับไปแท็บ "บุ๊กมาร์ก" ตอนที่ยังไม่มีบุ๊กมาร์ก จะขึ้นกล่องสองใบซ้อนกัน
 * กล่อง "ยังไม่มีบุ๊กมาร์ก" ชิดกับกล่องตารางเป๊ะ ไม่มีช่องว่าง
 *
 * ── วิธีทำให้เกิดสถานการณ์นั้น ─────────────────────────────────
 * session ใหม่ = ผู้ใช้ใหม่ = ยังไม่มีบุ๊กมาร์ก
 * (บุ๊กมาร์กเก็บแยกรายคน ไม่กระทบของผู้ใช้อื่น)
 */
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Redis } from 'ioredis'

const CHROME = process.env.CHROME_PATH ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const PORT = 9351
const WEB = 'http://localhost:3000'
const OUT = new URL('../tests/nav-status/output-list-spacing/', import.meta.url)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
mkdirSync(OUT, { recursive: true })

let pass = 0
let fail = 0
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`)
  ok ? pass++ : fail++
}

const redis = new Redis(process.env.VALKEY_URL)
const sid = `gap-${Date.now()}`
await redis.set(
  `session:${sid}`,
  JSON.stringify({ sub: sid, name: 'ผู้ทดสอบช่องว่าง', email: 'gap@test.local', avatar: '' }),
  'EX',
  900,
)

const profile = mkdtempSync(join(tmpdir(), 'cdp-gap-'))
const chrome = spawn(
  CHROME,
  ['--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run', '--window-size=1280,1000',
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
const waitFor = async (expr, timeoutMs = 30000, step = 150) => {
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
const clickTab = async (text) => {
  const box = await evaluate(`(() => {
    const el = [...document.querySelectorAll('.tabs__tab')]
      .find((x) => (x.textContent || '').trim().startsWith(${JSON.stringify(text)}))
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
  })()`)
  if (!box) return false
  for (const type of ['mousePressed', 'mouseReleased'])
    await send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 })
  return true
}

/** ระยะห่างแนวตั้งระหว่างกล่อง `.card` ที่เรียงติดกันในหน้ารายการ */
const gaps = () =>
  evaluate(`(() => {
    const page = document.querySelector('.studio-list') || document.body
    const cards = [...page.querySelectorAll('.card')]
      .map((c) => ({ r: c.getBoundingClientRect(), t: (c.innerText || '').slice(0, 22).replace(/\\n/g, ' ') }))
      .sort((a, b) => a.r.y - b.r.y)
    const out = []
    for (let i = 1; i < cards.length; i++) {
      out.push({
        below: cards[i - 1].t,
        above: cards[i].t,
        gap: Math.round(cards[i].r.y - cards[i - 1].r.bottom),
      })
    }
    return out
  })()`)

await send('Page.enable')
await send('Runtime.enable')
await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 1000, deviceScaleFactor: 1, mobile: false })
await send('Network.setCookie', { name: 'docgen_session', value: sid, url: WEB })
await send('Network.setCacheDisabled', { cacheDisabled: true })

await send('Page.navigate', { url: `${WEB}/studio` })
await waitFor("document.querySelectorAll('table tbody tr').length > 0", 40000)
await shot('01-list.png')

console.log('\n[1] แท็บแม่แบบทั้งหมด — ช่องว่างปกติ')
const g1 = await gaps()
check('ไม่มีกล่องไหนชิดกันจนชน (gap ต้อง ≥ 8px)', g1.every((g) => g.gap >= 8), g1.map((g) => `${g.gap}px`).join(' · '))

console.log('\n[2] แท็บบุ๊กมาร์กตอนยังไม่มีบุ๊กมาร์ก — กล่องสองใบต้องมีช่องว่าง')
await clickTab('บุ๊กมาร์ก')
const twoCards = await waitFor(
  "document.body.innerText.includes('ยังไม่มีบุ๊กมาร์ก')",
  20000,
)
check('แสดงกล่อง "ยังไม่มีบุ๊กมาร์ก"', twoCards)
const g2 = await gaps()
check('มีกล่อง 2 ใบเรียงกัน', g2.length >= 1, `${g2.length} คู่`)
for (const g of g2) {
  check(
    `มีช่องว่างระหว่าง "${g.below}" กับ "${g.above}"`,
    g.gap >= 8,
    `${g.gap}px`,
  )
}
await shot('02-bookmarks-empty.png')

console.log('\n[3] กลับไปแท็บทั้งหมด — ต้องกลับสู่ปกติ')
await clickTab('แม่แบบทั้งหมด')
await sleep(600)
const g3 = await gaps()
check('กลับมาแล้วช่องว่างยังถูกต้อง', g3.every((g) => g.gap >= 8), g3.map((g) => `${g.gap}px`).join(' · '))
await shot('03-back.png')

await send('Browser.close').catch(() => {})
chrome.kill()
await redis.del(`session:${sid}`)
redis.disconnect()

console.log(`\n── ผ่าน ${pass} · ไม่ผ่าน ${fail} ─────────────────────\n`)
process.exit(fail ? 1 : 0)
