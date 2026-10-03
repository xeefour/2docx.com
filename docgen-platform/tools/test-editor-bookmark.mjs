/**
 * เทสต์ปุ่มดาวบุ๊กมาร์กในหน้าแก้ไขแม่แบบ
 *
 * ผู้ใช้สั่ง: *"เพิ่มปุ่มสัญาลักษ์ bookmark ขวามือ"*
 * (หมายถึงปลายขวาของแถบแท็บฝั่งซ้าย: ฟอร์ม · JSON · ประวัติ)
 *
 * ── สิ่งที่ต้องผ่าน ──────────────────────────────────────────────
 * 1. ปุ่มดาวอยู่**ปลายขวา**ของแถบแท็บ (ขวาของปุ่มแท็บตัวสุดท้ายจริง ๆ)
 * 2. อยู่ในแถบแท็บเดียวกัน และแถบนั้นยังไม่พัง (แท็บเรียงเป็นแถว มีความกว้าง)
 *    → กันบั๊กจากการมี `.tabs__list { display: contents }`
 * 3. กดแล้วสลับเป็น ★ และ **API มีบุ๊กมาร์กจริง** (ไม่ใช่แค่ดาวเปลี่ยนสีบนจอ)
 * 4. กดซ้ำแล้วกลับเป็น ☆ และ API ไม่มีแล้ว
 * 5. ปุ่มมี aria-pressed / aria-label (โปรแกรมอ่านหน้าจอต้องรู้ว่าเปิดอยู่ไหม)
 * 6. เก็บกวาด: ดาวกลับเป็นสถานะเดิมเสมอ ไม่ทิ้งบุ๊กมาร์กค้างไว้
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Redis } from 'ioredis'

const CHROME = process.env.CHROME_PATH ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const PORT = Number(process.env.PORT ?? 9388)
const WEB = 'http://localhost:3000'
const API = 'http://127.0.0.1:4001'
const OUT = join(process.cwd(), 'tests', 'nav-status', 'output-editor-bookmark')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let pass = 0
let fail = 0
const check = (name, ok, info = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${info ? ` — ${info}` : ''}`)
  ok ? pass++ : fail++
}

const redis = new Redis(process.env.VALKEY_URL)
const sid = `edstar-${Date.now()}`
await redis.set(
  `session:${sid}`,
  JSON.stringify({ sub: sid, name: 'ผู้ทดสอบปุ่มดาว', email: 'star@test.local', avatar: '' }),
  'EX',
  900,
)
const H = { cookie: `docgen_session=${sid}`, 'content-type': 'application/json' }
const HC = { cookie: `docgen_session=${sid}` }

const templates = (await (await fetch(`${API}/api/templates`, { headers: H })).json()).items ?? []
const tpl = templates.find((t) => (t.name ?? '').includes('หัวกระบาษ')) ?? templates[0]
if (!tpl) throw new Error('ไม่มีแม่แบบให้ทดสอบ')
const key = String(tpl.id ?? tpl.versionId)
console.log(`ใช้แม่แบบ: ${tpl.name} (key ${key})`)

const bookmarks = async () => (await (await fetch(`${API}/api/bookmarks`, { headers: H })).json()).items ?? []
const hadBefore = (await bookmarks()).some((b) => b.templateKey === key)
console.log(`สถานะบุ๊กมาร์กก่อนเริ่ม: ${hadBefore ? 'มีอยู่แล้ว' : 'ยังไม่มี'}`)

mkdirSync(OUT, { recursive: true })
const profile = mkdtempSync(join(tmpdir(), 'cdp-star-'))
const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--no-first-run',
    '--window-size=1600,1000',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    'about:blank',
  ],
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
if (!wsUrl) throw new Error('เปิด Chrome ไม่ได้')

const ws = new WebSocket(wsUrl)
let seq = 0
const waiting = new Map()
/**
 * ส่งคำสั่ง CDP
 *
 * ⚠️ ต้องมี timeout
 *   ถ้า socket ถูกปิดไปแล้ว (เช่น `Browser.close` ทำให้ Chrome ตายก่อน)
 *   ข้อความที่ส่งทิ้งจะไม่มีคำตอบมา**ตลอดไป**
 *   เคยเจอ: สคริปต์ค้างหลังเทสต์ผ่านหมด และทิ้ง Chrome ~45 ตัวค้าง
 *   (ลำดับต้องเป็น Browser.close → kill → แล้วค่อย ws.close())
 */
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++seq
    const timer = setTimeout(() => {
      waiting.delete(id)
      reject(new Error(`CDP ไม่ตอบภายใน 20 วิ: ${method}`))
    }, 20000)
    waiting.set(id, {
      resolve: (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      reject: (e) => {
        clearTimeout(timer)
        reject(e)
      },
    })
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
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text ?? 'evaluate ล้ม')
  return r.result?.value
}
const waitFor = async (expr, ms = 30000) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    try {
      if (await evaluate(expr)) return true
    } catch {
      /* กำลังนำว่า */
    }
    await sleep(200)
  }
  return false
}
/** คลิกแบบมีสายตรวจ — ห้าม `element.click()` เพราะจะคลิกทะลุแผง/ชั้นทับ */
const realClick = async (expr) => {
  const box = await evaluate(`(() => {
    const el = ${expr}
    if (!el) return null
    el.scrollIntoView({ block: 'center' })
    const r = el.getBoundingClientRect()
    const x = r.x + r.width / 2, y = r.y + r.height / 2
    const hit = document.elementFromPoint(x, y)
    return { ok: !!hit && (el === hit || el.contains(hit)), x, y }
  })()`)
  if (!box?.ok) return false
  for (const type of ['mousePressed', 'mouseReleased'])
    await send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 })
  return true
}
const shot = async (name) => {
  const r = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(join(OUT, name), Buffer.from(r.data, 'base64'))
}

await send('Page.enable')
await send('Runtime.enable')
await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false })
await send('Network.setCookie', { name: 'docgen_session', value: sid, url: WEB })
await send('Network.setCacheDisabled', { cacheDisabled: true })

console.log('\n[1] เปิดหน้าแก้ไขแล้วต้องเห็นปุ่มดาว')
await send('Page.navigate', { url: `${WEB}/studio/${key}` })
const opened = await waitFor("!!document.querySelector('[data-testid=\"bookmark-toggle\"]')", 45000)
check('เปิดหน้าแก้ไขได้', opened)
if (!opened) {
  await shot('00-cannot-open.png')
  console.log('✗ เปิดหน้าไม่ได้ — หยุด')
  await send('Browser.close').catch(() => {})
  chrome.kill()
  await redis.del(`session:${sid}`)
  redis.disconnect()
  process.exit(1)
}
await sleep(500)

const geom = await evaluate(`(() => {
  const star = document.querySelector('[data-testid="bookmark-toggle"]')
  const bar = star.closest('.tabs')
  const tabs = [...bar.querySelectorAll('.tabs__tab')]
  const last = tabs[tabs.length - 1]
  const sr = star.getBoundingClientRect()
  const lr = last.getBoundingClientRect()
  const br = bar.getBoundingClientRect()
  return {
    tabCount: tabs.length,
    starRight: Math.round(sr.right), lastTabRight: Math.round(lr.right), barRight: Math.round(br.right),
    gapToEdge: Math.round(br.right - sr.right),
    starWidth: Math.round(sr.width), starHeight: Math.round(sr.height),
    firstTabWidth: Math.round(tabs[0].getBoundingClientRect().width),
    sameRow: Math.abs(sr.top - lr.top) < 8,
    text: star.textContent.trim(),
    pressed: star.getAttribute('aria-pressed'),
    label: star.getAttribute('aria-label'),
  }
})()`)
check('ปุ่มอยู่ในแถบแท็บเดียวกับแท็บอื่น', geom.tabCount === 3, `${geom.tabCount} แท็บ`)
check('อยู่ขวากว่าปุ่มแท็บตัวสุดท้าย', geom.starRight > geom.lastTabRight, `ดาว ${geom.starRight} > แท็บ ${geom.lastTabRight}`)
/**
 * ข้อนี้สำคัญที่สุดของงานนี้ — ผู้ใช้สั่ง *"ปุ่ม… ขวามือ"*
 * ถ้าลืม `margin-left: auto` ดาวจะเกาะติดแท็บตัวสุดท้าย (กลายเป็นแท็บที่ 4) ไม่ใช่ปลายแถบ
 */
check('ชิดขอบขวาของแถบจริง ๆ', geom.gapToEdge >= 0 && geom.gapToEdge <= 30, `เหลือช่องถึงขอบแถบ ${geom.gapToEdge}px`)
check('อยู่บรรทัดเดียวกับแท็บ', geom.sameRow, `สูง ${geom.starWidth}×${geom.starHeight}`)
check('แถบแท็บไม่พัง (แท็บแรกยังมีความกว้าง)', geom.firstTabWidth > 20, `${geom.firstTabWidth}px`)
check('มี aria-pressed บอกสถานะ', geom.pressed === 'false', `aria-pressed=${geom.pressed}`)
check('มี aria-label อธิบายการกด', !!geom.label && geom.label.length > 4, geom.label ?? '')
check('เริ่มต้นเป็น ☆', geom.text === '☆', geom.text)
await shot('01-star-off.png')

console.log('\n[2] กดดาวแล้วต้องเพิ่มบุ๊กมาร์กจริง')
check('คลิกปุ่มดาวได้', await realClick("document.querySelector('[data-testid=\"bookmark-toggle\"]')"))
const flipped = await waitFor(
  "document.querySelector('[data-testid=\"bookmark-toggle\"]')?.getAttribute('aria-pressed') === 'true'",
  10000,
)
const nowOn = (await bookmarks()).some((b) => b.templateKey === key)
check('ดาวกลายเป็น ★', flipped)
check('เป็น ★ ใน DOM ด้วย', (await evaluate("document.querySelector('[data-testid=\"bookmark-toggle\"]').textContent.trim()")) === '★')
check('API มีบุ๊กมาร์กของแม่แบบนี้จริง', nowOn, nowOn ? 'มี' : 'ไม่มี')
await shot('02-star-on.png')

console.log('\n[3] กดซ้ำแล้วต้องเอาออก')
check('คลิกดาวอีกครั้งได้', await realClick("document.querySelector('[data-testid=\"bookmark-toggle\"]')"))
const flipped2 = await waitFor(
  "document.querySelector('[data-testid=\"bookmark-toggle\"]')?.getAttribute('aria-pressed') === 'false'",
  10000,
)
const nowOff = (await bookmarks()).some((b) => b.templateKey === key)
check('ดาวกลับเป็น ☆', flipped2)
check('API ไม่มีบุ๊กมาร์กแล้ว', !nowOff)

// ── เก็บกวาด: คืนสถานะเดิมเสมอ ─────────────────────────────────
const nowHas = (await bookmarks()).some((b) => b.templateKey === key)
if (nowHas !== hadBefore) {
  if (nowHas) await fetch(`${API}/api/bookmarks/${encodeURIComponent(key)}`, { method: 'DELETE', headers: HC })
  else
    await fetch(`${API}/api/bookmarks`, {
      method: 'POST',
      headers: H,
      body: JSON.stringify({ templateKey: key, versionId: tpl.versionId, templateName: tpl.name }),
    })
}
const restored = (await bookmarks()).some((b) => b.templateKey === key) === hadBefore
check('เก็บกวาดแล้วบุ๊กมาร์กกลับเป็นสถานะเดิม', restored, `เดิม=${hadBefore ? 'มี' : 'ไม่มี'}`)

console.log(`\n── ผ่าน ${pass} · ไม่ผ่าน ${fail} ─────────────────────`)
console.log(`ภาพ: ${OUT}`)

const exited = new Promise((r) => chrome.once('exit', r))
// ⚠️ ลำดับสำคัญ — สั่งปิดเบราว์เซอร์ก่อน แล้วค่อยปิด socket
//   ถ้าปิด socket ก่อน คำสั่ง Browser.close จะไม่มีวันได้คำตอบ (ค้างถาวร)
await send('Browser.close').catch(() => {})
chrome.kill()
await Promise.race([exited, sleep(3000)])
ws.close()
await redis.del(`session:${sid}`)
redis.disconnect()
process.exit(fail === 0 ? 0 : 1)
