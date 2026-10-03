/**
 * ตรวจว่าแท็บของ**หน้ารายการแม่แบบ** ผูกกับ URL เหมือนแท็บของหน้าแก้ไข
 *
 *   node --env-file=.env tools/test-list-tabs-url.mjs
 *
 * ── ที่ต้องผ่าน ────────────────────────────────────────────────
 * 1. เปิด `/studio` → แท็บแรก active และ URL ไม่มี query (สะอาด)
 * 2. กดแท็บอื่น → URL เป็น `?tabs=…` และแท็บนั้น active
 * 3. กดแท็บเดิมซ้ำ → URL ไม่ซ้ำ (ไม่กองประวัติ)
 * 4. ปุ่มย้อนกลับของเบราว์เซอร์ → ย้อนแท็บได้จริง (ต้องใช้ push ไม่ใช่ replace)
 * 5. deep link `/studio?tabs=bookmarks` → เปิดที่แท็บนั้นเลย
 * 6. ค่าใน URL ที่เป็นของ**หน้าแก้ไข** (`?tabs=form`) → หน้ารายการต้อง
 *    ไม่พังและกลับไปแท็บแรก ไม่ใช่เปิดแท็บผิด
 * 7. เปิดแม่แบบแล้ว URL เป็นของหน้าแก้ไข (`?tabs=form&pane=preview`)
 *    และกดกลับ → กลับมาที่แท็บเดิมที่เลือกไว้ ไม่ใช่แท็บแรก
 *
 * ⚠️ **กดแท็บด้วยลำดับของแท็บ ไม่ใช่ด้วยชื่อ**
 *    ชื่อแท็บเป็นภาษาไทย และเคยพั้งมาแล้วเพราะพิมพ์ชื่อไม่ตรงกับของจริง
 *    (ตัวสะกดไทยหนึ่งตัวต่างกัน เทสต์ก็หาแท็บไม่เจอโดยไม่บอกว่าหาไม่เจอ)
 *    ลำดับแท็บตายตัวใน `Studio.tsx`: ทั้งหมด · ของฉัน · แชร์กับฉัน · บุ๊กมาร์ก
 *    และ `?tabs=` ที่คาดหวังคือ all / mine / shared / bookmarks ตามลำดับ
 *
 * ⚠️ เทสต์นี้ไม่ยิง API เรนเดอร์เอกสาร เป็นแค่การคลิกแท็บกับ URL
 */
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Redis } from 'ioredis'

const CHROME = process.env.CHROME_PATH ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const PORT = 9357
const WEB = 'http://localhost:3000'
const OUT = new URL('../tests/nav-status/output-list-tabs/', import.meta.url)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
mkdirSync(OUT, { recursive: true })

let pass = 0
let fail = 0
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`)
  ok ? pass++ : fail++
}

/** ลำดับแท็บ ↔ ค่าใน `?tabs=` (ดู `LIST_TABS` ใน `Studio.tsx`) */
const TAB_EXPECT = [
  { value: 'all', label: 'แม่แบบทั้งหมด' },
  { value: 'mine', label: 'เจ้าของ' },
  { value: 'shared', label: 'แชร์' },
  { value: 'bookmarks', label: 'บุ๊กมาร์ก' },
]

const redis = new Redis(process.env.VALKEY_URL)
const sid = `listtab-${Date.now()}`
await redis.set(
  `session:${sid}`,
  JSON.stringify({ sub: sid, name: 'ผู้ทดสอบแท็บหน้ารายการ', email: 'listtab@test.local', avatar: '' }),
  'EX',
  1800,
)

const profile = mkdtempSync(join(tmpdir(), 'cdp-listtab-'))
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
/**
 * อ่านค่าโดยไม่ล้มเมื่อหน้ากำลัง navigate
 *
 * ⚠️ `history.back()` แล้วรอสั้น ๆ แล้วอ่านต่อ จะเจอ error
 *    "Inspected target navigated or closed" เสมอ (คำสั่งที่ค้างอยู่ถูกตัดทิ้ง)
 *    ถ้าไม่จับ เทสต์จะตกทั้งชุดทั้งที่แอปทำงานถูกต้อง
 */
const read = async (expr) => {
  try {
    return await evaluate(expr)
  } catch {
    return null
  }
}
const waitFor = async (expr, timeoutMs = 30000, step = 200) => {
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
const where = () => read('location.pathname + location.search')
const param = (n) => read(`new URLSearchParams(location.search).get(${JSON.stringify(n)})`)

/** ชื่อแท็บทั้งหมดตามที่หน้าเว็บแสดงจริง (ตัดตัวเลขจำนวนท้ายแท็บออก) */
const tabLabels = () =>
  read(`[...document.querySelectorAll('.tabs__tab')]
    .map((t) => (t.textContent || '').trim().replace(/\\d+$/, '').trim())`)
/** เลขลำดับของแท็บที่กำลังเปิดอยู่ หรือ -1 */
const activeIndex = () =>
  read(`(() => {
    const list = [...document.querySelectorAll('.tabs__tab')]
    return list.findIndex((t) => t.classList.contains('tabs__tab--on'))
  })()`)

/**
 * กดแท็บตามลำดับด้วยเมาส์จริง
 *
 * ⚠️ ต้องยืนยันด้วย `elementFromPoint` ว่าจุดนั้นโดนปุ่มนั้นจริง
 *    แผนอื่นอาจคร่อมอยู่เหนือปุ่ม → คลิกเงียบโดยไม่มี error ให้เห็น
 */
const clickTab = async (i) => {
  const box = await read(`(() => {
    const el = document.querySelectorAll('.tabs__tab')[${i}]
    if (!el) return null
    el.scrollIntoView({ block: 'center' })
    const r = el.getBoundingClientRect()
    const x = r.x + r.width / 2
    const y = r.y + r.height / 2
    const hit = document.elementFromPoint(x, y)
    return { x, y, ok: hit === el || el.contains(hit), hit: hit ? String(hit.className) : 'ไม่มีอะไร' }
  })()`)
  if (!box) return { ok: false, detail: `ไม่มีแท็บลำดับที่ ${i}` }
  if (!box.ok) return { ok: false, detail: `จุดคลิกโดน ${box.hit}` }
  for (const type of ['mousePressed', 'mouseReleased'])
    await send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 })
  await sleep(500)
  return { ok: true, detail: '' }
}

const back = async () => {
  await read('history.back()')
  await sleep(900)
}

await send('Page.enable')
await send('Runtime.enable')
await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false })
await send('Network.setCookie', { name: 'docgen_session', value: sid, url: WEB })
// ⚠️ ต้องปิด cache ไม่งั้นจะวัด JS เก่าแล้วเห็นว่า "แก้ไม่มีผล"
await send('Network.setCacheDisabled', { cacheDisabled: true })

/**
 * เปิดหน้ารายการ รอจนรายการแม่แบบขึ้นจริง
 *
 * ⚠️ ครั้งแรกหลังแก้โค้ด Next dev ยัง compile ไม่ทัน ถ้ารอครั้งเดียวแล้วเดินต่อ
 *    เทสต์จะไปกดแท็บบนหน้าที่ยังไม่มีอะไร แล้วตกเป็น "ไม่เจอแท็บ" ทั้งชุด
 */
const openList = async (query = '') => {
  for (let attempt = 1; attempt <= 3; attempt++) {
    await send('Page.navigate', { url: `${WEB}/studio${query}` })
    // แถบแท็บโผล่ = React mount เสร็จแล้ว (ข้อมูลยังอาจไม่มา)
    if (!(await waitFor("document.querySelectorAll('.tabs__tab').length === 4", 60000))) {
      console.log(`  · รอบที่ ${attempt}: ยังไม่เห็นแถบแท็บ — โหลดใหม่`)
      continue
    }
    /**
     * ⚠️ **รอ `table tbody` ไม่ได้** เพราะสองกรณีนี้ไม่มีตารางเลย
     *    · กำลังโหลด — มีแต่กล่อง "กำลังโหลด…"
     *    · รายการว่าง (เช่นแท็บบุ๊กมาร์กที่ยังไม่มีของ) — มีแต่การ์ด "ยังไม่มีบุ๊กมาร์ก"
     *    เคยรอ `tbody tr` แล้วตกทั้งชุดเพราะเงื่อนไขไม่มีวันเป็นจริง
     *
     *    จึงรอให้กล่อง "กำลังโหลด" (div.muted ที่อยู่ในการ์ด) หายไป
     *    แล้วให้เวลาหน้าเว็บนิ่งอีกนิด — ไม่ต้องพิมพ์ข้อความไทยให้ตรงเป๊ะ
     */
    await waitFor("!document.querySelector('div.card > div.muted')", 10000, 200)
    await sleep(700)
    return true
  }
  return false
}

console.log('\n[1] เปิดหน้ารายการ — แท็บแรกต้อง active และ URL สะอาด')
check('เปิดหน้ารายการได้', await openList())
const labels = await tabLabels()
check('มีแท็บครบ 4 แท็บ', Array.isArray(labels) && labels.length === 4, JSON.stringify(labels))
check(
  'ชื่อแท็บตรงตาม `Studio.tsx`',
  Array.isArray(labels) &&
    labels[0].startsWith(TAB_EXPECT[0].label) &&
    labels[1].includes(TAB_EXPECT[1].label) &&
    labels[2].includes(TAB_EXPECT[2].label) &&
    labels[3].includes(TAB_EXPECT[3].label),
  JSON.stringify(labels),
)
check('เริ่มต้นเปิดแท็บแรก', (await activeIndex()) === 0, `ลำดับ ${await activeIndex()}`)
check('URL ไม่มี query ตอนอยู่แท็บแรก', (await where()) === '/studio', String(await where()))
await shot('01-default.png')

console.log('\n[2] กดแท็บอื่น — ต้องเขียนลง URL')
for (const i of [1, 3]) {
  const c = await clickTab(i)
  check(`กดแท็บลำดับ ${i} ได้`, c.ok, c.detail)
  check(`แท็บ ${i} → ?tabs=${TAB_EXPECT[i].value}`, (await param('tabs')) === TAB_EXPECT[i].value, String(await where()))
  check(`แท็บที่เปิดอยู่เปลี่ยนตาม`, (await activeIndex()) === i, `ลำดับ ${await activeIndex()}`)
}
await shot('02-bookmarks.png')

console.log('\n[3] กดแท็บเดิมซ้ำ — ต้องไม่กองประวัติ (URL เดิม จึงไม่ต้องแตะ history)')
const lenBefore = await evaluate('history.length')
await clickTab(3)
const lenAfter = await evaluate('history.length')
check('กดแท็บเดิมซ้ำแล้วประวัติไม่เพิ่ม', lenAfter === lenBefore, `${lenBefore} → ${lenAfter}`)

console.log('\n[4] ปุ่มย้อนกลับของเบราว์เซอร์ — ต้องย้อนแท็บได้')
await back()
check('ย้อนกลับแล้ว URL กลับเป็น ?tabs=mine', (await param('tabs')) === 'mine', String(await where()))
check('ย้อนกลับแล้วแท็บบนจอเปลี่ยนตามด้วย', (await activeIndex()) === 1, `ลำดับ ${await activeIndex()}`)
await back()
check('ย้อนกลับอีกครั้งกลับไปแท็บแรก และ URL สะอาด', (await where()) === '/studio', String(await where()))
check('แท็บกลับเป็นแรก', (await activeIndex()) === 0, `ลำดับ ${await activeIndex()}`)
await shot('03-back-to-first.png')

console.log('\n[5] deep link — เปิดลิงก์ตรงต้องได้แท็บนั้นเลย')
check('เปิด /studio?tabs=bookmarks ได้', await openList('?tabs=bookmarks'))
check('เปิดมาแล้วเป็นแท็บบุ๊กมาร์ก', (await activeIndex()) === 3, `ลำดับ ${await activeIndex()}`)
await shot('04-deeplink.png')

console.log('\n[6] ค่าที่เป็นของหน้าแก้ไข — หน้ารายการต้องไม้พัง')
// ⚠️ `form` เป็นแท็บ**ซ้าย**ของหน้าแก้ไข ไม่ใช่แท็บของหน้านี้
check('เปิด /studio?tabs=form ได้ (ค่านี้เป็นแท็บซ้ายของหน้าแก้ไข)', await openList('?tabs=form'))
check('กลับไปแท็บแรก ไม่ใช่เปิดแท็บผิด', (await activeIndex()) === 0, `ลำดับ ${await activeIndex()}`)

console.log('\n[7] เปิดแม่แบบแล้วกดกลับ — ต้องกลับมาแท็บเดิม')
/**
 * ⚠️ ผู้ใช้ชั่วคราวของเทสต์นี้**ไม่มีแม่แบบผูกกับตัวเองและไม่มีแม่แบบที่ถูกแชร์ให้**
 *    ทำให้แท็บ "ของฉัน"/"แชร์กับฉัน" ว่างเปล่า → ไม่มีปุ่ม "เปิด" ให้กด
 *
 *    ทางแก้คือให้เทสต์**กดดาวเก็บบุ๊กมาร์กแม่แบบตัวแรกก่อน**
 *    แล้วค่อยเปิดจากในแท็บบุ๊กมาร์ก — ได้ทั้งการพิสูจน์ว่า
 *    "กดกลับแล้วกลับมาแท็บเดิม" โดยไม่หลุดไปแท็บแรก
 *    (ถ้าใช้แท็บแรกเปิด URL จะเหมือนกันทั้งสองทาง ทดสอบอะไรไม่ได้เลย)
 */
const star = await read(`(() => {
  // ⚠️ ปุ่มแรกในแถวคือ**ชื่อแม่แบบ** (คลิกแล้วเปิดหน้าแก้ไขทันที) ไม่ใช่ปุ่มดาว
  //    ปุ่มดาวอยู่ปุ่มแรกในเซลล์สุดท้าย (คอลัมน์ "จัดการ") และข้อความเป็น ★/☆
  // ⚠️ ช่องปุ่มต้องเลือกด้วย**คลาส** ไม่ใช่ td:last-child
  //    ตอนนี้คอลัมน์ภาพย่อ (tplrow__thumb) อยู่ต่อท้ายสุดแล้ว
  //    → td:last-child ชี้ไปที่ช่องรูป ซึ่งไม่มีปุ่มเลย
  //    (เจอตอนรันซ้ำหลังเพิ่มฟีเจอร์รูปตัวอย่าง ชุดนี้ตก 4 ข้อรวด)
  const cells = [...document.querySelectorAll('.tpllist tbody tr td.tplrow__acts')]
  const btn = cells.length ? cells[0].querySelector('button') : null
  if (!btn || !'★☆'.includes(btn.textContent.trim())) return null
  btn.scrollIntoView({ block: 'center' })
  const r = btn.getBoundingClientRect()
  return { x: r.x + r.width / 2, y: r.y + r.height / 2, mark: btn.textContent.trim() }
})()`)
if (star) {
  for (const type of ['mousePressed', 'mouseReleased'])
    await send('Input.dispatchMouseEvent', { type, x: star.x, y: star.y, button: 'left', clickCount: 1 })
  await sleep(900)
}
check('กดดาวเก็บบุ๊กมาร์กแม่แบบตัวแรกได้', !!star, star ? `ปุ่ม ${star.mark}` : 'ไม่เจอปุ่มดาว')

const c3 = await clickTab(3)
check(`กดแท็บบุ๊กมาร์กได้`, c3.ok, c3.detail)
check(`แท็บลำดับ 3 → ?tabs=${TAB_EXPECT[3].value}`, (await param('tabs')) === TAB_EXPECT[3].value, String(await where()))
check(
  'ในแท็บบุ๊กมาร์กต้องมีแม่แบบให้เปิด (ผู้ใช้ชั่วคราวไม่มีอะไรในแท็บอื่น)',
  (await read("document.querySelectorAll('table tbody tr').length")) > 0,
  `แถว ${await read("document.querySelectorAll('table tbody tr').length")}`,
)
await shot('05-bookmarked.png')

const openBtn = await read(`(() => {
  const b = [...document.querySelectorAll('table tbody tr td button')].find((x) => (x.textContent||'').trim() === 'เปิด')
  if (!b) return null
  b.scrollIntoView({ block: 'center' })
  const r = b.getBoundingClientRect()
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
})()`)
if (openBtn) {
  for (const type of ['mousePressed', 'mouseReleased'])
    await send('Input.dispatchMouseEvent', { type, x: openBtn.x, y: openBtn.y, button: 'left', clickCount: 1 })
}
check('เปิดหน้าแก้ไขได้', await waitFor("document.querySelectorAll('.editor-split > .editor-col').length === 2", 30000))
check('URL ตอนเปิดแม่แบบเป็นของหน้าแก้ไข', (await param('tabs')) === 'form' && (await param('pane')) === 'preview', String(await where()))
await shot('06-editor.png')

// ปุ่ม "← กลับ" ของหน้าแก้ไข
const backBtn = await read(`(() => {
  const b = [...document.querySelectorAll('button')].find((x) => (x.textContent||'').includes('กลับ'))
  if (!b) return null
  b.scrollIntoView({ block: 'center' })
  const r = b.getBoundingClientRect()
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
})()`)
if (backBtn) {
  for (const type of ['mousePressed', 'mouseReleased'])
    await send('Input.dispatchMouseEvent', { type, x: backBtn.x, y: backBtn.y, button: 'left', clickCount: 1 })
}
check('กดกลับแล้วกลับมาหน้ารายการ', await waitFor("document.querySelectorAll('.tabs__tab').length === 4", 30000))
check(
  `กลับมาแล้ว URL ยังเป็น ?tabs=${TAB_EXPECT[3].value} (ไม่หลุดไปแท็บแรก)`,
  (await param('tabs')) === TAB_EXPECT[3].value,
  String(await where()),
)
check('แท็บบนจอกลับมาแท็บเดิม', (await activeIndex()) === 3, `ลำดับ ${await activeIndex()}`)
await shot('07-back-to-bookmarks.png')

await send('Browser.close').catch(() => {})
chrome.kill()
await redis.del(`session:${sid}`)
redis.disconnect()

console.log(`\n── ผ่าน ${pass} · ไม่ผ่าน ${fail} ─────────────────────\n`)
process.exit(fail ? 1 : 0)
