/**
 * ไล่อาการ "เมนูดาวน์โหลดกระพริบไม่สิ้นสุด" — เลื่อนเมาส์จากปุ่มไปหาช่อง "หน้าที่ต้องการ"
 *
 *   node --env-file=.env tools/inspect-dl-hover.mjs
 *
 * ── ที่ต้องดู ───────────────────────────────────────────────────
 * ผู้ใช้รายงานว่า *"ถ้า mouse over icon … ช่อง input หน้าที่ต้องการจะหายไป"*
 * และเกิดอาการกระพริบไม่สิ้นสุด — เครื่องมือนี้เดินเมาส์ทีละจุดตามแนวจริง
 * (ปุ่ม → ช่องว่างระหว่างปุ่มกับเมนู → ช่อง input) แล้วพิมพ์สถานะที่**ทุกจุด**
 * เพื่อดูว่าอะไรหายไปตอนเมาส์อยู่ตรงไหน ไม่ใช่เดาจากโค้ด
 *
 * ⚠️ ต้องใช้ `Input.dispatchMouseEvent` จริง เพราะ hover คือสถานะที่
 *    `element.hover()`/`element.click()` ไม่ทำให้เกิดขึ้นจริงในเบราว์เซอร์
 */
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Redis } from 'ioredis'
import { keyOf, pickTemplate, TEST_TEMPLATES } from './lib/pick-template.mjs'
import { importTags, restoreForm, snapshotForm } from './lib/studio-seed.mjs'

const CHROME = process.env.CHROME_PATH ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const PORT = 9364
const WEB = 'http://localhost:3000'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const redis = new Redis(process.env.VALKEY_URL)
const sid = `dlhover-${Date.now()}`
await redis.set(
  `session:${sid}`,
  JSON.stringify({ sub: sid, name: 'ไล่เมนูดาวน์โหลด', email: 'dlhover@test.local', avatar: '' }),
  'EX',
  1800,
)
const H = { cookie: `docgen_session=${sid}`, 'content-type': 'application/json' }
const tpl = await pickTemplate(H, [TEST_TEMPLATES.multipage])
const seedKey = keyOf(tpl)
const snap = await snapshotForm(H, seedKey)
await importTags(H, tpl)

const profile = mkdtempSync(join(tmpdir(), 'cdp-dlhover-'))
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
  } catch {
    /* ยังไม่พร้อม */
  }
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
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text)
  return r.result?.value
}
const waitFor = async (expr, ms = 120000) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    try {
      if (await evaluate(expr)) return true
    } catch {
      /* กำลัง navigate */
    }
    await sleep(400)
  }
  return false
}
const clickAt = async (x, y) => {
  for (const type of ['mousePressed', 'mouseReleased'])
    await send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 })
}
const moveTo = async (x, y) => {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, buttons: 0 })
  await sleep(120)
}
const shot = async (name) => {
  const { data } = await send('Page.captureScreenshot', { format: 'png' })
  mkdirSync(join(process.cwd(), 'logs'), { recursive: true })
  writeFileSync(join(process.cwd(), 'logs', `dl-${name}.png`), Buffer.from(data, 'base64'))
}

await send('Page.enable')
await send('Runtime.enable')
await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false })
await send('Network.setCookie', { name: 'docgen_session', value: sid, url: WEB })
await send('Network.setCacheDisabled', { cacheDisabled: true })

/** เปิดแม่แบบ + เรนเดอร์ให้เสร็จ */
console.log('เปิดแม่แบบ:', tpl.name)
await evaluate(`fetch('/studio/${seedKey}?tabs=form&pane=preview').catch(() => {})`)
await send('Page.navigate', { url: `${WEB}/studio/${seedKey}?tabs=form&pane=preview` })
const opened = await waitFor("document.querySelectorAll('.editor-split > .editor-col').length === 2", 60000)
console.log('เปิดหน้าแก้ไข:', opened)
await sleep(2500)

/**
 * ⚠️ ปุ่มดาวน์โหลดอยู่ในแถบเครื่องมือของ `DocumentPreview`
 *   ซึ่งยังไม่มีจนกว่าจะ**เรนเดอร์เสร็จ** (`previewDoc` ยังไม่มี)
 *   → ต้องกดเรนเดอร์ก่อน มิฉะนั้นหาปุ่มไม่เจอแล้วเข้าใจผิดว่าเป็นบั๊ก
 */
const renderBox = await evaluate(`(() => {
  const b = [...document.querySelectorAll('button')].find((x) => (x.textContent || '').includes('เรนเดอร์ตัวอย่าง'))
  if (!b) return null
  b.scrollIntoView({ block: 'center' })
  const r = b.getBoundingClientRect()
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
})()`)
if (renderBox) {
  await clickAt(renderBox.x, renderBox.y)
  const done = await waitFor("!!document.querySelector('.dl__btn')", 120000)
  console.log('เรนเดอร์เสร็จและมีแถบเครื่องมือ:', done)
  await sleep(1200)
} else {
  console.log('! ไม่เจอปุ่มเรนเดอร์ตัวอย่าง')
}

/** สถานะของเมนูที่ต้องรู้ทุกจุดที่เมาส์วาง */
const state = () =>
  evaluate(`(() => {
  const pop = document.querySelector('.dl__pop')
  const input = document.querySelector('.dl__rangeinput')
  const btn = document.querySelector('.dl__btn')
  const hit = document.elementFromPoint(...(window.__mx ?? [0, 0]))
  return {
    pop: !!pop,
    input: !!input,
    inputY: input ? Math.round(input.getBoundingClientRect().y) : null,
    popH: pop ? Math.round(pop.getBoundingClientRect().height) : null,
    btnOpen: btn?.getAttribute('data-open') ?? null,
    hoverBtn: !!btn?.matches(':hover'),
    hit: hit ? (hit.tagName + '.' + String(hit.className).slice(0, 18)) : null,
  }
})()`)

const btnBox = await evaluate(`(() => {
  const b = document.querySelector('.dl__btn')
  if (!b) return null
  b.scrollIntoView({ block: 'center' })
  const r = b.getBoundingClientRect()
  return { x: r.x + r.width / 2, y: r.y + r.height / 2, bottom: Math.round(r.bottom) }
})()`)
if (!btnBox) {
  console.log('✗ ไม่เจอปุ่มดาวน์โหลด')
  chrome.kill()
  await redis.del(`session:${sid}`)
  redis.disconnect()
  process.exit(1)
}

/** กดเปิดเมนู */
await clickAt(btnBox.x, btnBox.y)
await sleep(600)
console.log('หลังคลิกปุ่ม:', JSON.stringify(await state()))

/** เดินเมาส์จากปุ่มลงไปหาช่อง input ทีละจุด ตามแนวจริง */
const inBox = await evaluate(`(() => {
  const i = document.querySelector('.dl__rangeinput')
  if (!i) return null
  const r = i.getBoundingClientRect()
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
})()`)
console.log('ช่อง input อยู่ที่:', JSON.stringify(inBox))

if (inBox) {
  const steps = 8
  for (let i = 0; i <= steps; i++) {
    const y = btnBox.y + ((inBox.y - btnBox.y) * i) / steps
    await evaluate(`window.__mx = [${btnBox.x}, ${y}]`)
    await moveTo(btnBox.x, y)
    const s = await state()
    console.log(
      `  y=${Math.round(y)} (ช่องว่างจากปุ่ม ${Math.round(y - btnBox.bottom)}px) →`,
      `เมนู=${s.pop} ช่อง=${s.input} hoverปุ่ม=${s.hoverBtn} โดน=${s.hit}`,
    )
  }
}
await shot('hover-input')

/** เดินเมาส์ผ่านตัวเลือกรูปแบบ (PDF → Word → รูปภาพ → ZIP) แล้วดูว่าช่อง input เหลือไหม */
const opts = await evaluate(`[...document.querySelectorAll('.dl__opt')].map((b) => {
  const r = b.getBoundingClientRect()
  return { x: r.x + r.width / 2, y: r.y + r.height / 2, label: b.textContent.trim().slice(0, 10) }
})`)
console.log('ตัวเลือกรูปแบบ:', JSON.stringify(opts))
for (const o of opts) {
  await evaluate(`window.__mx = [${o.x}, ${o.y}]`)
  await moveTo(o.x, o.y)
  const s = await state()
  console.log(`  ${o.label} → เมนู=${s.pop} ช่อง=${s.input} สูงเมนู=${s.popH} โดน=${s.hit}`)
}
await shot('hover-opt')

await send('Browser.close').catch(() => {})
chrome.kill()
await restoreForm(H, seedKey, snap)
await redis.del(`session:${sid}`)
redis.disconnect()
console.log('เสร็จ')
