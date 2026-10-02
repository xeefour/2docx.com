/**
 * ตรวจว่าแท็บในหน้าแก้ไขแบ่งเป็นสองฝั่ง ตรงกับสองคอลัมน์ของจอ
 *
 *   node --env-file=.env tools/test-editor-panes.mjs
 *
 *   ซ้าย  ฟอร์ม · JSON · ประวัติ
 *   ขวา   ตัวอย่างเอกสาร · ข้อมูลแม่แบบ · ช่องฟอร์ม · การแชร์และสิทธิ์
 *
 * ── สิ่งที่ต้องผ่าน ────────────────────────────────────────────
 * 1. มีแถบแท็บ 2 ชุด คนละฝั่งของจอ
 * 2. ซ้ายมี 3 แท็บ · ขวามี 4 แท็บ และชื่อตรงตามที่กำหนด
 * 3. กดแท็บซ้าย → เนื้อหาเปลี่ยนเฉพาะฝั่งซ้าย
 * 4. กดแท็บขวา → เนื้อหาเปลี่ยนเฉพาะฝั่งขวา
 * 5. URL เก็บทั้งสองค่า (?tabs=…&pane=…)
 * 6. deep link ที่มีทั้งสองค่า → เปิดถูกทั้งสองฝั่ง
 * 7. URL รุ่นเก่า (?tabs=fields) → ยังเปิดฝั่งขวาได้ ไม่ให้ลิงก์ที่แชร์ไว้พัง
 * 8. เลื่อนหน้าแล้วแถบแท็บขวายังอยู่บนจอ (sticky อยู่ที่คอลัมน์ ไม่ใช่ที่การ์ด)
 */
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Redis } from 'ioredis'

const CHROME = process.env.CHROME_PATH ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const PORT = 9353
const WEB = 'http://localhost:3000'
const OUT = new URL('../tests/nav-status/output-editor-panes/', import.meta.url)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
mkdirSync(OUT, { recursive: true })

let pass = 0
let fail = 0
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`)
  ok ? pass++ : fail++
}

const redis = new Redis(process.env.VALKEY_URL)
const sid = `pane-${Date.now()}`
await redis.set(
  `session:${sid}`,
  JSON.stringify({ sub: sid, name: 'ผู้ทดสอบแท็บสองฝั่ง', email: 'pane@test.local', avatar: '' }),
  'EX',
  1800,
)

const profile = mkdtempSync(join(tmpdir(), 'cdp-pane-'))
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
const where = () => evaluate('location.pathname + location.search')
const param = (n) => evaluate(`new URLSearchParams(location.search).get(${JSON.stringify(n)})`)

/** คลิกแท็บในคอลัมน์ที่ระบุ ('left' | 'right') ด้วยเมาส์จริง */
const clickPaneTab = async (side, text) => {
  /**
   * ⚠️ selector ฝั่งซ้ายต้องใช้ `:not(.editor-col--right)` แบบนี้
   *    ถ้าเขียน `.editor-col--right:not(.editor-col--right)` จะไม่มี element ไหนตรงเลย
   *    (ตัวเองขัดกับเอง) แล้วคลิกไม่ทันแต่เทสต์จะรายงานว่าหน้าเพิ่งเปลี่ยนไม่ได้
   */
  const sel = side === 'right' ? '.editor-col--right' : '.editor-split > .editor-col:not(.editor-col--right)'
  const box = await evaluate(`(() => {
    const col = document.querySelector(${JSON.stringify(sel)})
    if (!col) return null
    const el = [...col.querySelectorAll('.tabs__tab')]
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

/** เนื้อหาที่แสดงอยู่ในแต่ละคอลัมน์ (ใช้หัวข้อการ์ดแรกของแต่ละฝั่ง) */
const sideContent = () =>
  evaluate(`(() => {
    const cols = [...document.querySelectorAll('.editor-split > .editor-col')]
    return cols.map((c) => {
      const card = c.querySelector('.card')
      const active = c.querySelector('.tabs__tab--on')?.textContent?.trim() ?? null
      return {
        active,
        text: (card?.innerText || '').slice(0, 26).replace(/\\n/g, ' '),
        x: Math.round(c.getBoundingClientRect().x),
      }
    })
  })()`)

await send('Page.enable')
await send('Runtime.enable')
await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false })
await send('Network.setCookie', { name: 'docgen_session', value: sid, url: WEB })
await send('Network.setCacheDisabled', { cacheDisabled: true })

// ── เปิดหน้ารายการ แล้วเข้าแม่แบบแรก ─────────────────────────
await send('Page.navigate', { url: `${WEB}/studio` })
await waitFor("document.querySelectorAll('table tbody tr').length > 0", 40000)
const key = await evaluate(
  "document.querySelector('table tbody tr td .mono')?.textContent?.slice(0,0) ?? null",
)
const openedKey = await evaluate(`(() => {
  const b = [...document.querySelectorAll('table tbody tr td button')].find((x) => (x.textContent||'').trim() === 'เปิด')
  if (!b) return null
  const r = b.getBoundingClientRect()
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
})()`)
for (const type of ['mousePressed', 'mouseReleased'])
  await send('Input.dispatchMouseEvent', { type, x: openedKey.x, y: openedKey.y, button: 'left', clickCount: 1 })
void key
await waitFor("document.querySelectorAll('.editor-split > .editor-col').length === 2", 30000)

console.log('\n[1] โครงสองฝั่ง')
const tabBars = await evaluate(`(() => {
  const cols = [...document.querySelectorAll('.editor-split > .editor-col')]
  return cols.map((c) => ({
    x: Math.round(c.getBoundingClientRect().x),
    vw: innerWidth,
    tabs: [...c.querySelectorAll('.tabs__tab')].map((t) => t.textContent.trim().replace(/\\d+$/, '')),
  }))
})()`)
check('มีคอลัมน์ 2 ฝั่ง', tabBars.length === 2, `${tabBars.length} คอลัมน์`)
check('ซ้ายมี 3 แท็บ', tabBars[0]?.tabs.length === 3, tabBars[0]?.tabs.join(' · '))
check('ขวามี 4 แท็บ', tabBars[1]?.tabs.length === 4, tabBars[1]?.tabs.join(' · '))
check('ฝั่งซ้ายอยู่ครึ่งซ้ายจริง', tabBars[0] && tabBars[0].x < tabBars[0].vw / 2, tabBars[0] ? `x=${tabBars[0].x} / จอ ${tabBars[0].vw}` : '')
check('ฝั่งขวาอยู่ครึ่งขวาจริง', tabBars[1] && tabBars[1].x >= tabBars[1].vw / 2, tabBars[1] ? `x=${tabBars[1].x} / จอ ${tabBars[1].vw}` : '')
check(
  'ชื่อแท็บตรงตามที่กำหนด',
  tabBars[0]?.tabs.join(',') === 'ฟอร์ม,JSON,ประวัติ' && tabBars[1]?.tabs.join(',') === 'ตัวอย่างเอกสาร,ข้อมูลแม่แบบ,ช่องฟอร์ม,การแชร์และสิทธิ์',
  `ซ้าย=[${tabBars[0]?.tabs.join(' | ')}] ขวา=[${tabBars[1]?.tabs.join(' | ')}]`,
)
check('เริ่มต้นเปิดฝั่งซ้าย=ฟอร์ม ขวา=ตัวอย่างเอกสาร', (await param('tabs')) === 'form' && (await param('pane')) === 'preview', await where())
await shot('01-default.png')

console.log('\n[2] สลับแท็บฝั่งซ้าย — ขวาต้องไม่ขยับ')
await clickPaneTab('left', 'JSON')
await sleep(500)
const s2 = await sideContent()
check('ซ้ายเปลี่ยนเป็น JSON', s2[0]?.active?.startsWith('JSON'), s2[0]?.active)
check('ฝั่งขวายังเป็นตัวอย่างเอกสาร', s2[1]?.active === 'ตัวอย่างเอกสาร', s2[1]?.active)
check('URL เก็บทั้งสองค่า', (await param('tabs')) === 'json' && (await param('pane')) === 'preview', await where())
await shot('02-left-json.png')

console.log('\n[3] สลับแท็บฝั่งขวา — ซ้ายต้องไม่ขยับ')
await clickPaneTab('right', 'ช่องฟอร์ม')
await sleep(600)
const s3 = await sideContent()
check('ขวาเปลี่ยนเป็นช่องฟอร์ม', s3[1]?.active?.startsWith('ช่องฟอร์ม'), s3[1]?.active)
check('ฝั่งซ้ายยังเป็น JSON', s3[0]?.active?.startsWith('JSON'), s3[0]?.active)
check('URL เก็บทั้งสองค่า', (await param('tabs')) === 'json' && (await param('pane')) === 'fields', await where())
check('เนื้อหาฝั่งขวาถูกเปลี่ยนจริง ไม่ใช่แค่แท็บที่ active', /ช่อง/.test(s3[1]?.text ?? ''), s3[1]?.text)
await shot('03-right-fields.png')

console.log('\n[4] ทุกแท็บฝั่งขวาต้องเปิดเนื้อหาของตัวเอง')
for (const label of ['ข้อมูลแม่แบบ', 'การแชร์และสิทธิ์', 'ตัวอย่างเอกสาร']) {
  const ok = await clickPaneTab('right', label)
  await sleep(800)
  const st = await sideContent()
  check(`เปิดแท็บ "${label}" ได้`, ok && st[1]?.active?.startsWith(label), st[1]?.active ?? 'ไม่พบแท็บ')
}

console.log('\n[5] sticky — แท็บฝั่งขวาต้องเกาะจอ เว้นแต่แท็บพรีวิว')
/**
 * ⚠️ ตอนนี้ `sticky` ใช้**เฉพาะแท็บที่สูงไม่เกินจอ** (ประวัติ/ช่องฟอร์ม/ผู้ใช้แม่แบบนี้)
 *    ส่วนแท็บพรีวิวถอนออกโดยเจตนา เพราะการ์ดสูงเต็มจอ (`.docpage` = 100vh)
 *    คอลัมน์ `sticky` ที่สูงเกินจอจะ**กินระยะเลื่อนของตัวเอง**
 *    → แถบรูปย่อที่อยู่ใต้การ์ดถูกตรึงไว้นอกจอ ผู้ใช้เลื่อนถึงไม่ได้
 *
 *    จึงต้องทดสอบทั้งสองแบบ: ต้องเกาะจริงในแท็บที่ควรเกาะ
 *    และต้อง**ไม่**เกาะในแท็บพรีวิว (ไม่งั้นแถบรูปย่อจะเข้าไม่ถึง)
 */
// ต้องทำให้หน้ายาวพอจะเลื่อนก่อน มิฉะนั้นทดสอบผ่านโดยไม่ได้ทดสอบอะไร
await clickPaneTab('left', 'ฟอร์ม')
await clickPaneTab('right', 'ช่องฟอร์ม')
await sleep(600)
await evaluate('scrollTo(0, document.body.scrollHeight)')
await sleep(600)
const rightBar = await evaluate(`(() => {
  const col = document.querySelector('.editor-col--right')
  if (!col) return null
  const r = col.querySelector('.tabs').getBoundingClientRect()
  return { y: Math.round(r.y), vh: innerHeight, sy: Math.round(scrollY), pos: getComputedStyle(col).position }
})()`)
check('หน้าเลื่อนได้จริง (ไม่ใช่ทดสอบกับหน้าที่สั้นเกินจนเลื่อนไม่ได้)', rightBar && rightBar.sy > 0, rightBar ? `scrollY=${rightBar.sy}` : 'ไม่พบ')
check(
  'แท็บที่ไม่ใช่พรีวิว: เลื่อนลงแล้วแถบแท็บยังอยู่ในจอ (sticky ทำงาน)',
  rightBar && rightBar.pos === 'sticky' && rightBar.y >= 0 && rightBar.y < rightBar.vh,
  rightBar ? `position=${rightBar.pos} · scrollY=${rightBar.sy} · แท็บ y=${rightBar.y} / จอสูง ${rightBar.vh}` : 'ไม่พบ',
)
await shot('04-scrolled.png')

await clickPaneTab('right', 'ตัวอย่างเอกสาร')
await sleep(600)
await evaluate('scrollTo(0, 0)')
await sleep(400)
const previewCol = await evaluate(`(() => {
  const col = document.querySelector('.editor-col--preview')
  if (!col) return null
  return {
    pos: getComputedStyle(col).position,
    h: Math.round(col.getBoundingClientRect().height),
    vh: innerHeight,
    hasDoc: !!document.querySelector('.docpage'),
  }
})()`)
/**
 * ⚠️ เทสต์นี้ไม่ได้กด "เรนเดอร์" → ยังไม่มี `.docpage` การ์ดจึงสั้น (หน้าว่าง)
 *    เงื่อนไข "สูงกว่าจอ" จึงตรวจเฉพาะตอนที่มีเอกสารวาดจริง
 */
check(
  'แท็บพรีวิว: คอลัมน์ไม่ sticky โดยเจตนา (การ์ดสูงเกินจอ ถ้า sticky แถบรูปย่อจะเลื่อนไม่ถึง)',
  previewCol && previewCol.pos === 'static' && (!previewCol.hasDoc || previewCol.h > previewCol.vh),
  previewCol
    ? `position=${previewCol.pos} · การ์ดสูง ${previewCol.h}px / จอ ${previewCol.vh}px · ยังไม่ได้เรนเดอร์=${!previewCol.hasDoc}`
    : 'ไม่พบ',
)
await evaluate('scrollTo(0, 0)')
await sleep(300)

console.log('\n[6] deep link ที่มีทั้งสองค่า')
const k = await evaluate('location.pathname.replace(/^\\/studio\\//, "")')
await send('Page.navigate', { url: `${WEB}/studio/${k}?tabs=json&pane=history` })
await waitFor("document.querySelectorAll('.editor-split > .editor-col').length === 2", 40000)
await sleep(600)
const s6 = await sideContent()
check('เปิดลิงก์ตรง → ซ้าย=JSON', s6[0]?.active?.startsWith('JSON'), s6[0]?.active)
check('เปิดลิงก์ตรง → ขวา=การแชร์และสิทธิ์', s6[1]?.active === 'การแชร์และสิทธิ์', s6[1]?.active)
await shot('05-deeplink.png')

console.log('\n[7] URL รุ่นเก่า ?tabs=fields — ลิงก์ที่แชร์ไว้ต้องยังใช้ได้')
await send('Page.navigate', { url: `${WEB}/studio/${k}?tabs=fields` })
await waitFor("document.querySelectorAll('.editor-split > .editor-col').length === 2", 40000)
await sleep(600)
const s7 = await sideContent()
check('URL เก่า → เปิดฝั่งขวาที่ "ช่องฟอร์ม" ได้', s7[1]?.active?.startsWith('ช่องฟอร์ม'), s7[1]?.active)
check('URL เก่า → ฝั่งซ้ายยังเป็นฟอร์ม', s7[0]?.active === 'ฟอร์ม', s7[0]?.active)

await send('Browser.close').catch(() => {})
chrome.kill()
await redis.del(`session:${sid}`)
redis.disconnect()

console.log(`\n── ผ่าน ${pass} · ไม่ผ่าน ${fail} ─────────────────────\n`)
process.exit(fail ? 1 : 0)
