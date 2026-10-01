/**
 * ตรวจว่า URL สะท้อนสิ่งที่เปิดอยู่จริง
 *
 *   node --env-file=.env tools/test-studio-url.mjs
 *
 *   /studio                                          → หน้ารายการ
 *   /studio/<key>?tabs=form&pane=preview               → ซ้าย=ฟอร์ม · ขวา=ตัวอย่างเอกสาร
 *   /studio/<key>?tabs=json&pane=fields               → ซ้าย=JSON · ขวา=ช่องฟอร์ม
 *
 * ── หน้าแก้ไขมีแท็บ 2 ชุด ─────────────────────────────────────
 *   ซ้าย (สิ่งที่กรอกลงเอกสาร) = ฟอร์ม · JSON          → `?tabs=`
 *   ขวา (เรื่องตัวแม่แบบ)       = ตัวอย่าง · แม่แบบ · ช่องฟอร์ม · ประวัติ → `?pane=`
 *   เทสต์นี้จึงต้องระวัง: สลับแท็บฝั่งหนึ่งห้ามไปกวนอีกฝั่ง
 *
 * ── สิ่งที่ต้องผ่าน ────────────────────────────────────────────
 * 1. เปิดแม่แบบ → URL มี key + tabs=form + pane=preview
 * 2. สลับแท็บแต่ละฝั่ง → URL เปลี่ยนเฉพาะฝั่งนั้น
 * 3. กดกลับ → URL กลับเป็น /studio สะอาด
 * 4. ปุ่มย้อนกลับของเบราว์เซอร์ → กลับไปเปิดแม่แบบเดิมพร้อมแท็บเดิมทั้งสองฝั่ง
 * 5. ปุ่มไป-กลับ → กลับไปหน้ารายการ
 * 6. สลับแท็บหลายครั้งแล้วกดย้อนกลับ → ต้องกลับหน้ารายการทันที
 *    (ถ้าใช้ pushState ตอนสลับแท็บ ประวัติจะกองและกดย้อนกลับหลายครั้ง)
 * 7. เปิดลิงก์ตรง /studio/<key>?tabs=json&pane=fields → เปิดได้ตรงทั้งสองฝั่ง
 *    (deep link — สิ่งที่คัดลอก URL ไปให้คนอื่นต้องใช้ได้)
 * 8. URL รุ่นเก่า ?tabs=fields → ยังเปิดได้ (คัดลอกลิงก์ไว้ก่อนอัปเดตต้องไม่พัง)
 * 9. key ที่ไม่มีอยู่ → ไม่ค้าง แจ้งว่าไม่พบ
 */
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Redis } from 'ioredis'

const CHROME = process.env.CHROME_PATH ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const PORT = 9349
const WEB = 'http://localhost:3000'
const OUT = new URL('../tests/nav-status/output-studio-url/', import.meta.url)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
mkdirSync(OUT, { recursive: true })

let pass = 0
let fail = 0
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`)
  ok ? pass++ : fail++
}

const redis = new Redis(process.env.VALKEY_URL)
const sid = `url-${Date.now()}`
await redis.set(
  `session:${sid}`,
  JSON.stringify({ sub: sid, name: 'ผู้ทดสอบ URL', email: 'url@test.local', avatar: '' }),
  'EX',
  1800,
)

const profile = mkdtempSync(join(tmpdir(), 'cdp-url-'))
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

const where = () => evaluate('location.pathname + location.search')
const pathOnly = () => evaluate('location.pathname')
const tabsParam = () => evaluate("new URLSearchParams(location.search).get('tabs')")
const paneParam = () => evaluate("new URLSearchParams(location.search).get('pane')")
const openKey = () => evaluate('location.pathname.replace(/^\\/studio\\/?/, "") || null')
/**
 * เปิดหน้าแก้ไขแล้วหรือยัง — นับ**คอลัมน์** ไม่ใช่แท็บ
 *
 * ⚠️ ห้ามนับแท็บรวมทั้งหน้า — ตอนนี้มี 2 ชุด (ซ้าย 2 · ขวา 4 = 6)
 *    และจำนวนจะเปลี่ยนไปเรื่อย ๆ ถ้ามีการเพิ่มแท็บ → เทสต์พังโดยไม่ตรงเหตุ
 *    ห้ามใช้ `.editor-preview` เช่นกัน เพราะการ์ดนั้นมีเฉพาะตอนอยู่แท็บตัวอย่าง
 */
const editorOpen = () => evaluate("document.querySelectorAll('.editor-split > .editor-col').length === 2")
/** ชื่อแท็บที่ active ของแต่ละฝั่ง */
const activeTab = (side) =>
  evaluate(
    `document.querySelector(${JSON.stringify(
      side === 'right' ? '.editor-col--right' : '.editor-split > .editor-col:not(.editor-col--right)',
    )})?.querySelector('.tabs__tab--on')?.textContent?.trim() ?? null`,
  )
/** คลิกแท็บด้วยเมาส์จริงที่พิกัดกึ่งกลาง — ต้องระบุฝั่ง เพราะมีแท็บ 2 ชุด */
const clickTab = async (text, side = 'left') => {
  const sel =
    side === 'right'
      ? '.editor-col--right .tabs__tab'
      : '.editor-split > .editor-col:not(.editor-col--right) .tabs__tab'
  const box = await evaluate(`(() => {
    const el = [...document.querySelectorAll(${JSON.stringify(sel)})]
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
const clickButton = async (text) => {
  const box = await evaluate(`(() => {
    const el = [...document.querySelectorAll('button')]
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
const goBack = () => send('Page.navigateToHistoryEntry', { entryId: -1 })
const goForward = () => send('Page.navigateToHistoryEntry', { entryId: 0 }).catch(() => {})

await send('Page.enable')
await send('Runtime.enable')
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false })
await send('Network.setCookie', { name: 'docgen_session', value: sid, url: WEB })
await send('Network.setCacheDisabled', { cacheDisabled: true })

// ── เปิดหน้ารายการ ──────────────────────────────────────────────
await send('Page.navigate', { url: `${WEB}/studio` })
await waitFor("document.querySelectorAll('table tbody tr').length > 0", 40000)
check('หน้าเริ่มต้นอยู่ที่ /studio ไม่มี query', (await where()) === '/studio', await where())

// ── 1. เปิดแม่แบบ → URL ต้องมี key + ทั้งสอง query ─────────────────
console.log('\n[1] เปิดแม่แบบจากตาราง')
await clickButton('เปิด')
await waitFor("document.querySelectorAll('.editor-split > .editor-col').length === 2", 30000)
const url1 = await where()
const key1 = await openKey()
check('URL เปลี่ยนเป็น /studio/<key>', /^\/studio\/[^/]+$/.test(await pathOnly()), await pathOnly())
check('มี key ของแม่แบบใน URL', !!key1 && /^\d+$/.test(key1), `key=${key1}`)
check('ฝั่งซ้ายเริ่มที่ฟอร์ม (?tabs=form)', (await tabsParam()) === 'form', `tabs=${await tabsParam()}`)
check('ฝั่งขวาเริ่มที่ตัวอย่างเอกสาร (?pane=preview)', (await paneParam()) === 'preview', `pane=${await paneParam()}`)
check('URL มี query ครบทั้งสองฝั่ง', url1 === `/studio/${key1}?tabs=form&pane=preview`, url1)
await shot('01-opened.png')

// ── 2. สลับแท็บ → URL เปลี่ยนเฉพาะฝั่งที่กด ─────────────────────
console.log('\n[2] สลับแท็บ — URL ต้องตาม และไม่กวนอีกฝั่ง')
await clickTab('JSON', 'left')
await sleep(400)
check('กด JSON (ซ้าย) → ?tabs=json', (await tabsParam()) === 'json', `tabs=${await tabsParam()} · ${await where()}`)
check('แท็บซ้ายที่ active ตรงกับ URL', (await activeTab('left'))?.startsWith('JSON'), await activeTab('left'))
check('กดฝั่งซ้ายแล้วฝั่งขวาไม่เปลี่ยน', (await paneParam()) === 'preview', `pane=${await paneParam()}`)

await clickTab('ช่องฟอร์ม', 'right')
await sleep(400)
check('กด "ช่องฟอร์ม" (ขวา) → ?pane=fields', (await paneParam()) === 'fields', `pane=${await paneParam()}`)
check('แท็บขวาที่ active ตรงกับ URL', (await activeTab('right'))?.startsWith('ช่องฟอร์ม'), await activeTab('right'))
check('กดฝั่งขวาแล้วฝั่งซ้ายไม่เปลี่ยน', (await tabsParam()) === 'json', `tabs=${await tabsParam()}`)
await shot('02-tab-json.png')

await clickTab('ฟอร์ม', 'left')
await sleep(400)
check('กลับมาแท็บฟอร์ม (ซ้าย) → ?tabs=form', (await tabsParam()) === 'form', `tabs=${await tabsParam()}`)
check('ฝั่งขวายังอยู่ที่ช่องฟอร์ม', (await paneParam()) === 'fields', `pane=${await paneParam()}`)

// ── 3. กดกลับ → /studio สะอาด ──────────────────────────────────
console.log('\n[3] กดปุ่ม "กลับ" ในหน้าแม่แบบ')
await clickButton('กลับ')
await sleep(600)
check('URL กลับเป็น /studio สะอาด (ไม่มี key ไม่มี query)', (await where()) === '/studio', await where())
check('กลับมาเห็นตารางแม่แบบ', await waitFor("document.querySelectorAll('table tbody tr').length > 0", 15000))

// ── 4. ปุ่มย้อนกลับของเบราว์เซอร์ ──────────────────────────────
console.log('\n[4] ปุ่มย้อนกลับ / ไป-กลับ ของเบราว์เซอร์')
await send('Runtime.evaluate', { expression: 'history.back()' })
await waitFor("document.querySelectorAll('.editor-split > .editor-col').length === 2", 15000)
const urlBack = await where()
check('ย้อนกลับ → เปิดแม่แบบเดิมกลับมา', (await editorOpen()) === true, `เปิดแม่แบบ=${await editorOpen()}`)
check(
  // คาด `pane=fields` ไม่ใช่ `preview` เพราะสลับแท็บใช้ replaceState —
  // รายการประวัติที่เปิดแม่แบบไว้ถูก**แทนที่**ด้วยแท็บล่าสุด ไม่ได้เพิ่มรายการใหม่
  // (ถ้าคาด preview คือ replaceState ไม่ทำงาน แล้วจะกดย้อนกลับแล้วเจอสถานะเก่า)
  'ย้อนกลับ → ได้สถานะแท็บล่าสุด ?tabs=form&pane=fields',
  urlBack === `/studio/${key1}?tabs=form&pane=fields`,
  urlBack,
)
check('แท็บที่แสดงตรงกับ URL หลังย้อนกลับ', (await activeTab('right'))?.startsWith('ช่องฟอร์ม'), await activeTab('right'))

await send('Runtime.evaluate', { expression: 'history.forward()' })
await sleep(800)
check('ไป-กลับ → กลับหน้ารายการ', (await where()) === '/studio', await where())
check('หน้ารายการแสดงผลจริง', await waitFor("document.querySelectorAll('table tbody tr').length > 0", 15000))

// ── 5. สลับแท็บหลายครั้งแล้วย้อนกลับต้องกลับรายการทันที ────────
console.log('\n[5] สลับแท็บหลายครั้ง — ประวัติต้องไม่กอง')
await clickButton('เปิด')
await waitFor("document.querySelectorAll('.editor-split > .editor-col').length === 2", 20000)
for (const [t, side] of [
  ['JSON', 'left'],
  ['ช่องฟอร์ม', 'right'],
  ['ประวัติ', 'right'],
  ['JSON', 'left'],
  ['ฟอร์ม', 'left'],
]) {
  await clickTab(t, side)
  await sleep(250)
}
check('สลับ 5 ครั้งแล้ว URL ยังมี key เดิม', (await openKey()) === key1, await where())
await send('Runtime.evaluate', { expression: 'history.back()' })
await sleep(900)
check(
  'กดย้อนกลับครั้งเดียว → กลับหน้ารายการ (ไม่ต้องกดหลายครั้ง)',
  (await where()) === '/studio',
  await where(),
)

// ── 6. deep link ───────────────────────────────────────────────
console.log('\n[6] เปิดลิงก์ตรง — ต้องเปิดแม่แบบบนแท็บที่ระบุทั้งสองฝั่ง')
await send('Page.navigate', { url: `${WEB}/studio/${key1}?tabs=json&pane=fields` })
await waitFor("document.querySelectorAll('.editor-split > .editor-col').length === 2", 40000)
check('เปิดลิงก์ตรง → เปิดแม่แบบได้', (await editorOpen()) === true)
check('เปิดบนแท็บ JSON (ฝั่งซ้าย)', (await activeTab('left'))?.startsWith('JSON'), await activeTab('left'))
check('เปิดบนแท็บช่องฟอร์ม (ฝั่งขวา)', (await activeTab('right'))?.startsWith('ช่องฟอร์ม'), await activeTab('right'))
check(
  'URL ยังเป็น /studio/<key>?tabs=json&pane=fields',
  (await where()) === `/studio/${key1}?tabs=json&pane=fields`,
  await where(),
)
await shot('03-deeplink-json.png')

console.log('\n[7] URL รุ่นเก่า ?tabs=fields — ลิงก์ที่คัดลอกไว้ก่อนอัปเดตต้องยังใช้ได้')
await send('Page.navigate', { url: `${WEB}/studio/${key1}?tabs=fields` })
await waitFor("document.querySelectorAll('.editor-split > .editor-col').length === 2", 40000)
check('เปิด URL เก่า → เปิดแม่แบบได้', (await editorOpen()) === true)
check('map ?tabs=fields ไปเป็นแท็บช่องฟอร์มทางขวา', (await activeTab('right'))?.startsWith('ช่องฟอร์ม'), await activeTab('right'))

console.log('\n[8] key ที่ไม่มีอยู่จริง')
await send('Page.navigate', { url: `${WEB}/studio/999999999999999999` })
const shown = await waitFor("document.body.innerText.includes('ไม่พบแม่แบบ')", 30000)
check('key ผิด → บอกว่าไม่พบ ไม่ค้างหน้าว่าง', shown)
check('key ผิด → ยังเห็นตารางแม่แบบได้', await waitFor("document.querySelectorAll('table tbody tr').length > 0", 20000))
await shot('04-not-found.png')

await send('Browser.close').catch(() => {})
chrome.kill()
await redis.del(`session:${sid}`)
redis.disconnect()

console.log(`\n── ผ่าน ${pass} · ไม่ผ่าน ${fail} ─────────────────────\n`)
process.exit(fail ? 1 : 0)
