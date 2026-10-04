/**
 * รายการแม่แบบหน้าแรก: ต้องแบ่งหน้า
 *
 *   node --env-file=.env tools/test-list-pager.mjs
 *
 * ── ผู้ใช้ชี้ ──────────────────────────────────────────────────────
 * *"เหมือนหน้านี้ไม่มี pageination นะ"* (http://localhost:3000/studio)
 *
 * ── ที่วัดได้ก่อนแก้ ────────────────────────────────────────────────
 *   แท็บ "แม่แบบทั้งหมด" → 43 แถว · หน้าสูง 5,982px = **เลื่อน 6 จอ** · ไม่มีแถบแบ่งหน้า
 *   API คืน `hasMore` มาให้ตั้งแต่แรก แต่หน้าเว็บไม่เคยเอาไปใช้เลย
 *
 * ── ทำไมต้องแบ่งหน้า**ฝั่งเบราว์เซอร์** ───────────────────────────────
 *   ตัวกรองทั้งหมด (แท็บ · หมวด · แท็ก · ค้นหา · บุ๊กมาร์ก) คำนวณที่ `filtered`
 *   ซึ่งเป็น useMemo ฝั่งเว็บ ถ้าให้ API แบ่งหน้า ผู้ใช้ที่อยู่แท็บ "ที่ฉันเป็นเจ้าของ"
 *   จะเจอหน้าว่าง เพราะ API ไม่รู้ว่าผู้ใช้อยู่แท็บไหน
 *   (เคยเป็นบั๊กจริงตอนทำถังขยะ — ต้องแยกหน้าหาก่อนตัดสินใจ)
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Redis } from 'ioredis'

const WEB = 'http://localhost:3000'
const API = process.env.API_URL ?? 'http://127.0.0.1:4001'
const CHROME = process.env.CHROME_PATH ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const PORT = 9417
const STAMP = Date.now()
const OUT = new URL('../tests/nav-status/output-list-pager/', import.meta.url)
const PAGE_SIZE = 12
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let pass = 0
let fail = 0
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`)
  ok ? pass++ : fail++
}

const redis = new Redis(process.env.VALKEY_URL)
const SID = `tlp-${STAMP}`
await redis.set(`session:${SID}`, JSON.stringify({ sub: SID, name: 'ผู้ทดสอบแบ่งหน้า', email: `tlp.${STAMP}@test.local`, avatar: '' }), 'EX', 1800)
const HD = { cookie: `docgen_session=${SID}` }

const profile = mkdtempSync(join(tmpdir(), 'cdp-tlp-'))
const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run', '--window-size=1280,950',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' })
let wsUrl = null
for (let i = 0; i < 40 && !wsUrl; i++) {
  await sleep(500)
  try { wsUrl = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find((x) => x.type === 'page')?.webSocketDebuggerUrl } catch {}
}
const ws = new WebSocket(wsUrl)
let seq = 0
const waiting = new Map()
const send = (m, p = {}) => new Promise((res, rej) => {
  const id = ++seq
  waiting.set(id, { resolve: res, reject: rej })
  ws.send(JSON.stringify({ id, method: m, params: p }))
  setTimeout(() => { if (waiting.has(id)) { waiting.delete(id); rej(new Error('timeout ' + m)) } }, 30000)
})
ws.addEventListener('message', (ev) => { const m = JSON.parse(ev.data); const s = waiting.get(m.id); if (!s) return; waiting.delete(m.id); m.error ? s.reject(new Error(JSON.stringify(m.error))) : s.resolve(m.result) })
await new Promise((r) => ws.addEventListener('open', r, { once: true }))
const evaluate = async (e) => {
  const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true })
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails.exception?.description))
  return r.result?.value
}
const waitFor = async (e, ms = 30000) => {
  const end = Date.now() + ms
  while (Date.now() < end) { try { if (await evaluate(e)) return true } catch {} await sleep(400) }
  return false
}
const shot = async (n) => {
  const { data } = await send('Page.captureScreenshot', { format: 'png' })
  mkdirSync(OUT, { recursive: true })
  writeFileSync(new URL(n, OUT), Buffer.from(data, 'base64'))
}
const ROWS = `(() => [...document.querySelectorAll('.tpllist tbody tr')].map((tr) => tr.querySelector('td')?.innerText.trim() ?? ''))()`

await send('Page.enable')
await send('Runtime.enable')
await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 950, deviceScaleFactor: 1, mobile: false })
await send('Network.setCacheDisabled', { cacheDisabled: true })
await send('Network.setCookie', { name: 'docgen_session', value: SID, url: WEB })

// ต้องรอ API พร้อม (tsx --watch restart ได้ตอนมีคนแก้ไฟล์)
let total = 0
for (let i = 0; i < 15; i++) {
  try {
    const r = await fetch(`${API}/api/templates`, { headers: HD })
    if (r.ok) { total = ((await r.json()).items ?? []).length; if (total) break }
  } catch {}
  await sleep(2000)
}
console.log(`\n[0] เตรียมข้อมูล — API คืน ${total} แม่แบบ`)
check('มีแม่แบบมากพอที่จะเห็นผลของการแบ่งหน้า', total > PAGE_SIZE, `${total} แม่แบบ`)

console.log('\n[1] หน้าแรกต้องไม่ยัดทั้งหมดลงไปในจอเดียว')
await send('Page.navigate', { url: `${WEB}/studio?_=${STAMP}` })
check('ตารางแม่แบบโหลดได้', !!(await waitFor(`document.querySelectorAll('.tpllist tbody tr').length > 0`, 45000)))
const p1 = await evaluate(`(() => ({
  rows: document.querySelectorAll('.tpllist tbody tr').length,
  pager: !!document.querySelector('[data-testid="list-pager-next"]'),
  range: document.querySelector('[data-testid="list-pager-range"]')?.innerText.trim() ?? '',
  pageH: document.documentElement.scrollHeight,
  vh: innerHeight,
  names: ${ROWS},
}))()`)
check('หน้าแรกมีไม่เกินหนึ่งหน้า', p1?.rows === PAGE_SIZE, `${p1?.rows} แถว`)
check('มีแถบแบ่งหน้า', p1?.pager === true)
check('ข้อความบอกยอดรวมตรงกับ API', new RegExp(String(total)).test(p1?.range ?? ''), p1?.range ?? '')
check('หน้าเลื่อนสั้นลงจาก 6 จอเหลือ 2 จอ', (p1?.pageH ?? 9e9) < (p1?.vh ?? 0) * 3, `${p1?.pageH}px / จอ ${p1?.vh}px`)
await shot('1-page1.png')

console.log('\n[2] หน้าถัดไปต้องเป็นรายการอื่น ไม่ใช่หน้าเดิมซ้ำ')
await evaluate(`document.querySelector('[data-testid="list-pager-next"]').click()`)
check('เปลี่ยนไปหน้า 2', !!(await waitFor(`${ROWS}[0] !== ${JSON.stringify((p1?.names ?? [])[0] ?? '')}`, 15000)))
const p2 = await evaluate(`(() => ({
  rows: document.querySelectorAll('.tpllist tbody tr').length,
  range: document.querySelector('[data-testid="list-pager-range"]')?.innerText.trim() ?? '',
  names: ${ROWS},
}))()`)
check('หน้า 2 ยังเต็มหนึ่งหน้า', p2?.rows === PAGE_SIZE, `${p2?.rows} แถว`)
check('ช่วงของหน้า 2 ถูกต้อง', new RegExp(`แสดง ${PAGE_SIZE + 1}–${PAGE_SIZE * 2}`).test(p2?.range ?? ''), p2?.range ?? '')
check('ไม่มีรายการซ้ำกับหน้า 1', !(p2?.names ?? []).some((n) => (p1?.names ?? []).includes(n)))
await shot('2-page2.png')

console.log('\n[3] หน้าสุดท้ายต้องเหลือเท่าที่เหลือ (ไม่ใช่เต็มหนึ่งหน้าปลอม ๆ)')
await evaluate(`(() => {
  const btns = [...document.querySelectorAll('[data-testid^="list-pager-page-"]')]
  btns[btns.length - 1].click()
})()`)
await sleep(2500)
const last = await evaluate(`(() => ({
  rows: document.querySelectorAll('.tpllist tbody tr').length,
  range: document.querySelector('[data-testid="list-pager-range"]')?.innerText.trim() ?? '',
  nextDisabled: document.querySelector('[data-testid="list-pager-next"]')?.disabled,
}))()`)
const expectLast = total % PAGE_SIZE === 0 ? PAGE_SIZE : total % PAGE_SIZE
check('หน้าสุดท้ายมีเฉพาะที่เหลือ', last?.rows === expectLast, `${last?.rows} แถว (คาด ${expectLast})`)
check('ช่วงของหน้าสุดท้ายจบที่ยอดรวม', new RegExp(`–${total}\\b`).test(last?.range ?? ''), last?.range ?? '')
check('ปุ่มหน้าถัดไปถูกปิดที่หน้าสุดท้าย', last?.nextDisabled === true)

console.log('\n[4] เปลี่ยนตัวกรองแล้วต้องกลับหน้า 1 ไม่ใช่ค้างหน้าสุดท้าย')
await evaluate(`(() => {
  const el = document.querySelector('.filters__q')
  el.focus()
})()`)
for (const ch of 'a') {
  await send('Input.dispatchKeyEvent', { type: 'keyDown', text: ch, unmodifiedText: ch })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', text: ch, unmodifiedText: ch })
}
await sleep(1200)
const filtered = await evaluate(`(() => ({
  rows: document.querySelectorAll('.tpllist tbody tr').length,
  range: document.querySelector('[data-testid="list-pager-range"]')?.innerText.trim() ?? '',
  pager: !!document.querySelector('[data-testid="list-pager-next"]'),
  cur: document.querySelector('[aria-current="page"]')?.textContent.trim() ?? '',
}))()`)
check('กลับมาหน้า 1 ทันทีที่เปลี่ยนตัวกรอง', filtered?.cur === '1', `หน้าปัจจุบัน ${filtered?.cur}`)
check(
  'หน้าที่เหลือไม่เกินหนึ่งหน้า (ไม่โชว์แถบแบ่งหน้าที่กดอะไรไม่ได้)',
  filtered?.rows <= PAGE_SIZE && (filtered?.rows < PAGE_SIZE ? filtered?.pager === false : true),
  `${filtered?.rows} แถว · pager=${filtered?.pager} · ${filtered?.range}`,
)
await shot('3-filtered.png')

console.log('\n[5] ค้นหาที่ไม่มีผลลัพธ์ต้องไม่พัง')
for (const ch of 'zzzqqq') {
  await send('Input.dispatchKeyEvent', { type: 'keyDown', text: ch, unmodifiedText: ch })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', text: ch, unmodifiedText: ch })
}
await sleep(1200)
const none = await evaluate(`(() => ({
  rows: document.querySelectorAll('.tpllist tbody tr').length,
  empty: (document.body.innerText || '').includes('ไม่พบแม่แบบ'),
  pager: !!document.querySelector('[data-testid="list-pager-next"]'),
}))()`)
check('ไม่มีแถวและขึ้นข้อความว่าไม่พบ', none?.rows === 0 && none?.empty === true, JSON.stringify(none))
check('ไม่มีแถบแบ่งหน้าตอนไม่มีผลลัพธ์', none?.pager === false)

await redis.del(`session:${SID}`)
redis.disconnect()
console.log(`\n── ผ่าน ${pass} · ไม่ผ่าน ${fail} ─────────────────────`)
await send('Browser.close').catch(() => {})
chrome.kill()
ws.close()
process.exit(fail === 0 ? 0 : 1)
