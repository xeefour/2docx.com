/**
 * เก็บภาพหน้าจอของแถบสถานะ เพื่อดูด้วยตา — ไม่ต้องเดาว่าหน้าตาเป็นยังไง
 *
 *   node --env-file=.env tools/shot-nav-status.mjs
 *
 * จำลองเครือข่ายช้าผ่าน CDP เพื่อถ่าย "ระหว่างเปลี่ยนหน้า" และ "หน้าค้างเกิน 15 วินาที"
 * (สองช่วงนี้เกิดขึ้นในชีวิตจริงเฉพาะตอนเน็ตช้า ถ้าไม่จำลองจะถ่ายไม่ทัน)
 */
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Redis } from 'ioredis'

const CHROME = process.env.CHROME_PATH ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const PORT = 9336
const WEB = 'http://localhost:3000'
const OUT = new URL('../tests/nav-status/output-shots/', import.meta.url)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
mkdirSync(OUT, { recursive: true })

const redis = new Redis(process.env.VALKEY_URL)
const sid = `shot-${Date.now()}`
await redis.set(`session:${sid}`, JSON.stringify({ sub: 'shot', name: 'shot' }), 'EX', 900)

const profile = mkdtempSync(join(tmpdir(), 'cdp-shot-'))
const chrome = spawn(
  CHROME,
  ['--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run', '--window-size=1280,860',
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
if (!wsUrl) { console.log('ต่อ CDP ไม่ได้'); chrome.kill(); process.exit(1) }

const ws = new WebSocket(wsUrl)
let seq = 0
const waiting = new Map()
const send = (method, params = {}) => new Promise((resolve, reject) => {
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
  return r.result?.value
}
const waitFor = async (expr, timeoutMs, step = 120) => {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    if (await evaluate(expr)) return true
    await sleep(step)
  }
  return false
}
const shot = async (name) => {
  const { data } = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(new URL(name, OUT), Buffer.from(data, 'base64'))
  console.log(`  ถ่าย ${name}`)
}
const clickAt = async (selector) => {
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
const setLatency = (ms) => send('Network.emulateNetworkConditions', {
  offline: false, latency: ms, downloadThroughput: 5_000_000, uploadThroughput: 2_000_000,
})
const goHome = async () => {
  await send('Page.navigate', { url: `${WEB}/` })
  await waitFor("!document.querySelector('.bootveil')", 40000, 150)
  await waitFor("!!document.querySelector('.urlbar__panel')", 5000, 100)
}

await send('Page.enable')
await send('Runtime.enable')
await send('Network.enable')
await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 860, deviceScaleFactor: 1, mobile: false })
await send('Network.setCookie', { name: 'docgen_session', value: sid, url: WEB })

// 1) แถบ URL เปิดค้างไว้ พร้อมปุ่มคัดลอก
await goHome()
await shot('1-urlbar.png')

// 2) กำลังเปลี่ยนหน้า — ผ้าคลุมบอกปลายทาง
await setLatency(1500)
await clickAt('a[href="/studio"]')
await waitFor("!!document.querySelector('.veil')", 5000, 50)
await shot('2-navigating.png')

// 3) หน้าค้างเกิน 15 วินาที — ปลดผ้าคลุม ขึ้นคำเตือน + ปุ่มรีเฟรช
//    ต้องกลับไปหน้าแรกก่อน แล้วค่อยทำให้ช้ามาก ๆ ไม่งั้นนำทางข้างต้นจะจบไปแล้ว
await goHome()
await setLatency(18_000)
await clickAt('a[href="/studio"]')
await waitFor("!!document.querySelector('.veil')", 5000, 50)
const stuck = await waitFor("!!document.querySelector('.urlbar__slow')", 22000, 250)
if (!stuck) console.log('  ! ไม่ขึ้นสถานะ "ค้าง" ตามคาด — ภาพนี้ใช้ไม่ได้')
await shot('3-stuck-warning.png')

await setLatency(0)
await waitFor("location.pathname === '/studio'", 25000)
await sleep(1500)
await shot('4-studio-loaded.png')

ws.close()
const exited = new Promise((r) => chrome.once('exit', r))
chrome.kill()
await Promise.race([exited, sleep(5000)])
try { rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }) } catch { /* ignore */ }
await redis.del(`session:${sid}`)
redis.disconnect()
console.log(`บันทึกที่ ${OUT.pathname}`)
process.exit(0)
