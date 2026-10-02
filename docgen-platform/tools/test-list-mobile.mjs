/**
 * ตรวจว่าหน้ารายการแม่แบบ (`/studio`) ใช้งานบนมือถือได้จริง
 *
 *   node --env-file=.env tools/test-list-mobile.mjs
 *
 * ── ที่ต้องผ่าน ────────────────────────────────────────────────
 * 1. จอ ≤ 720px → หน้าไม่ล้นแนวนอน และ**ปุ่มจัดการทุกปุ่มอยู่ในจอ** ทุกแถว
 * 2. จอ ≤ 720px → หัวตารางหายไป (กลายเป็นการ์ด) และมีป้ายกำกับแทนคอลัมน์
 * 3. จอ ≤ 720px → ปุ่มสูง ≥ 36px (แตะนิ้วได้)
 * 4. ช่องที่ไม่มีข้อมูล (ไม่มีหมวด/ไม่มีแท็ก) ต้อง**ถูกซ่อน** ไม่ใช่โชว์ "—" เปล่า ๆ
 * 5. จอกว้าง (1440px) → ต้องยังเป็น**ตารางเหมือนเดิม** คอลัมน์ครบ 5 ช่อง
 * 6. กฎมือถือต้องไม่รั่วไปกระทบตารางอื่น (ตารางที่ไม่มี `.tpllist`)
 * 7. ที่จอแคบ ปุ่ม "เปิด" ต้อง**กดได้จริง** ไม่ใช่แค่มองเห็น
 *
 * ── บั๊กที่เคยเจอและกฎกันไว้ ───────────────────────────────────
 * · การ์ดรอบตารางมี `overflow: hidden` ปุ่มที่ล้นออกไปจะ**ถูกตัดจนกดไม่ได้**
 *   ไม่ใช่แค่ "ต้องเลื่อนไปดู" (ก่อนแก้: ปุ่มขอบขวาอยู่ที่ 757px บนจอ 579px = ล้น 178px ทั้ง 11 แถว)
 * · กฎ `td.is-empty` ต้องอยู่**หลัง** `td:nth-child(2..4)` สองกฎ specificity เท่ากัน
 *   ถ้าย้ายไปก่อน `display: none` จะถูก `display: inline-flex` ทับ
 * · ต้องเช็ค**ทุกแถว** ไม่ใช่แถวแรว — ชื่อแม่แบบยาว ๆ บังคับให้ตารางกว้าง
 * · กฎต้อง scope ด้วย `.tpllist` เสมอ ตารางประวัติใน `HistoryPanel`
 *   (หน้าแก้ไข แท็บประวัติ) เป็น `<table>` ธรรมดาที่ยังต้องเป็นตาราง
 *
 * ⚠️ เทสต์นี้ไม่ยิง API เรนเดอร์เอกสาร ไม่แก้ข้อมูลจริง เป็นแค่การวัด layout
 *    ข้อ 6 ฉีด `<table>` เปล่าเข้าไปในหน้าแล้ววัด computed display
 *    เพราะ `HistoryPanel` จะเรนเดอร์ตารางเฉพาะเมื่อ `total > 0`
 *    (ต้องเรนเดอร์เอกสารจริงถึงจะมีประวัติ = เทสต์ช้าและเปราะเกินจำเป็น)
 *    เรื่องที่ต้องพิสูจน์คือ "CSS รั่วหรือไม่" ซึ่งฉีดตารางพิสูจน์ได้ตรงกว่า
 */
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Redis } from 'ioredis'

const CHROME = process.env.CHROME_PATH ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const PORT = 9364
const WEB = 'http://localhost:3000'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
mkdirSync(join(process.cwd(), 'logs'), { recursive: true })

let pass = 0
let fail = 0
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`)
  ok ? pass++ : fail++
}

const redis = new Redis(process.env.VALKEY_URL)
const sid = `listmob-${Date.now()}`
await redis.set(
  `session:${sid}`,
  JSON.stringify({ sub: sid, name: 'ทดสอบมือถือ', email: 'listmob@test.local', avatar: '' }),
  'EX',
  1800,
)

const profile = mkdtempSync(join(tmpdir(), 'cdp-listmob-'))
const chrome = spawn(
  CHROME,
  ['--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run', '--window-size=1440,900',
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
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text)
  return r.result?.value
}

/** รอเงื่อนไขที่จะใช้จริงถัดไปเสมอ ห้ามรอแค่ "มีปุ่มโผล่" (เคยตกเพราะรอผิดอย่าง) */
const waitFor = async (expr, ms = 60000) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    try {
      if (await evaluate(expr)) return true
    } catch { /* ยังไม่พร้อม */ }
    await sleep(300)
  }
  return false
}
const setWidth = async (width, height = 900) => {
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false })
  await sleep(600) // รอ reflow + media query มีผลจริง
}
const shot = async (name) => {
  const { data } = await send('Page.captureScreenshot', { format: 'png' })
  const file = join(process.cwd(), 'logs', `listmob-${name}.png`)
  writeFileSync(file, Buffer.from(data, 'base64'))
  return file
}

await send('Page.enable')
await send('Runtime.enable')
await setWidth(1440)
await send('Network.setCookie', { name: 'docgen_session', value: sid, url: WEB })
await send('Network.setCacheDisabled', { cacheDisabled: true })
await send('Page.navigate', { url: `${WEB}/studio` })
await waitFor('!document.querySelector(".bootveil")')
// รอปุ่มที่จะใช้จริง ไม่ใช่รอแค่มีแถว
const gotRows = await waitFor(
  "[...document.querySelectorAll('.tpllist tbody tr')].filter(tr => [...tr.querySelectorAll('button')].some(b => b.textContent.trim() === 'เปิด')).length > 0",
  45000,
)
if (!gotRows) {
  console.log('✗ โหลดตารางรายการแม่แบบไม่ได้ — ทดสอบต่อไม่ได้')
  console.log('  ภาพ:', await shot('cannot-load'))
  await send('Browser.close').catch(() => {})
  chrome.kill()
  await redis.del(`session:${sid}`)
  redis.disconnect()
  process.exit(1)
}

/**
 * วัดทุกอย่างที่ต้องผ่านในจอหนึ่งความกว้าง
 * ⚠️ เช็คทุกแถว ไม่ใช่แถวแรก — ชื่อแม่แบบยาว ๆ บังคับให้ตารางกว้างเกินจอ
 */
const probe = () =>
  evaluate(`(() => {
  const de = document.documentElement
  const rows = [...document.querySelectorAll('.tpllist tbody tr')]
  const info = rows.map((tr) => {
    const c = tr.lastElementChild
    const btns = [...c.querySelectorAll('button, a')]
    return {
      right: Math.round(c.getBoundingClientRect().right),
      /** ปุ่มที่โดนจอขอาง — นี่คือ "ถูกตัดจนกดไม่ได้" */
      out: btns.filter((x) => x.getBoundingClientRect().right > innerWidth + 0.5).length,
      h: btns.length ? Math.min(...btns.map((x) => Math.round(x.getBoundingClientRect().height))) : 0,
    }
  })
  const thead = document.querySelector('.tpllist thead')
  const cells = [...document.querySelectorAll('.tpllist tbody td')]
  return {
    w: innerWidth,
    overflow: Math.max(de.scrollWidth, document.body.scrollWidth) - innerWidth,
    rows: rows.length,
    outRows: info.filter((r) => r.out > 0).length,
    minH: info.length ? Math.min(...info.map((r) => r.h)) : 0,
    theadShown: !!thead?.getClientRects().length,
    rowDisplay: rows[0] ? getComputedStyle(rows[0]).display : '?',
    cols: rows[0] ? rows[0].children.length : 0,
    emptyHidden: cells.filter((td) => td.classList.contains('is-empty')).every((td) => getComputedStyle(td).display === 'none'),
    emptyTotal: cells.filter((td) => td.classList.contains('is-empty')).length,
    labels: [...new Set([...document.querySelectorAll('.tpllist tbody td[data-label]')].map((td) => getComputedStyle(td, '::before').content).filter((c) => c && c !== 'none' && c !== 'normal'))],
  }
})()`)

// ── 1–4 · จอมือถือ ────────────────────────────────────────────────
for (const w of [360, 414, 579]) {
  console.log(`\nจอ ${w}px`)
  await setWidth(w)
  const p = await probe()
  check('หน้าไม่ล้นแนวนอน', p.overflow <= 0, `ล้น ${p.overflow}px`)
  check('ปุ่มจัดการอยู่ในจอทุกแถว', p.outRows === 0, `ล้น ${p.outRows}/${p.rows} แถว`)
  check('หัวตารางซ่อน (กลายเป็นการ์ด)', !p.theadShown && p.rowDisplay === 'flex', `thead=${p.theadShown} tr=${p.rowDisplay}`)
  check('ปุ่มสูงพอแตะนิ้ว (≥36px)', p.minH >= 36, `${p.minH}px`)
  check('ช่องว่างถูกซ่อน', p.emptyHidden, `มี ${p.emptyTotal} ช่องว่าง`)
  check('มีป้ายกำกับแทนคอลัมน์', p.labels.length >= 2, p.labels.join(' '))
  if (w === 579) console.log('  ภาพ:', await shot('w579'))
}

// ── 5 · จอกว้างต้องยังเป็นตารางเหมือนเดิม ──────────────────────────
console.log('\nจอ 1440px (ต้องไม่กระทบเดสก์ท็อป)')
await setWidth(1440)
const d = await probe()
check('ยังเป็นตาราง (tr=table-row)', d.rowDisplay === 'table-row', d.rowDisplay)
check('หัวตารางยังอยู่', d.theadShown === true)
check('คอลัมน์ครบ 5 ช่อง', d.cols === 5, `${d.cols} ช่อง`)
check('ช่องว่างกลับมาเป็นตารางปกติ', d.emptyHidden === false || d.emptyTotal === 0, `ซ่อนไป ${d.emptyHidden}`)

// ── 6 · กฎต้องไม่รั่วไปตารางอื่น ───────────────────────────────────
console.log('\nไม่กระทบตารางอื่น')
await setWidth(390)
const leak = await evaluate(`(() => {
  const t = document.createElement('table')
  t.id = 'probe-plain'
  t.innerHTML = '<thead><tr><th>a</th></tr></thead><tbody><tr><td>b</td></tr></tbody>'
  document.body.appendChild(t)
  const row = t.querySelector('tbody tr')
  const th = t.querySelector('th')
  const out = {
    tr: getComputedStyle(row).display,
    td: getComputedStyle(row.querySelector('td')).display,
    th: getComputedStyle(th).display,
    thead: getComputedStyle(t.querySelector('thead')).display,
  }
  t.remove()
  return out
})()`)
check('ตารางธรรมดายังเป็นตาราง', leak.tr === 'table-row' && leak.td === 'table-cell', JSON.stringify(leak))
/**
 * ⚠️ ค่า `thead` ของเบราว์เซอร์คือ `table-header-group` (ไม่ใช่ `table-group`)
 *    เคยเขียนเกณฑ์ผิดตัวนี้ เทสต์ตกทั้งที่ CSS ถูกอยู่แล้ว
 *    → ถ้าเทสต์ตก ต้องแยกให้ออกก่อนว่า "โค้ดผิด" หรือ "เกณฑ์ผิด"
 */
check('หัวตารางธรรมดายังโชว์', leak.th === 'table-cell' && leak.thead === 'table-header-group', JSON.stringify(leak))

// ── 7 · กดปุ่ม "เปิด" ที่จอแคบต้องได้จริง ────────────────────────────
console.log('\nกดปุ่มที่จอแคบ')
const target = await evaluate(`(() => {
  const row = [...document.querySelectorAll('.tpllist tbody tr')]
    .find((tr) => [...tr.querySelectorAll('button')].some((b) => b.textContent.trim() === 'เปิด'))
  if (!row) return { miss: 'ไม่เจอแถว' }
  const btn = [...row.querySelectorAll('button')].find((b) => b.textContent.trim() === 'เปิด')
  btn.scrollIntoView({ block: 'center' })
  const r = btn.getBoundingClientRect()
  const x = r.x + r.width / 2
  const y = r.y + r.height / 2
  const hit = document.elementFromPoint(x, y)
  return { x, y, hit: hit ? hit.tagName + '.' + (hit.className || '') : 'null' }
})()`)
if (target.miss) {
  check('หาปุ่มเปิดได้', false, target.miss)
} else {
  check('จุดกดโดนปุ่มจริง (ไม่โดนอย่างอื่นบัง)', target.hit?.includes('BUTTON'), target.hit)
  for (const type of ['mousePressed', 'mouseReleased'])
    await send('Input.dispatchMouseEvent', { type, x: target.x, y: target.y, button: 'left', clickCount: 1 })
  const opened = await waitFor("location.pathname !== '/studio' && document.querySelectorAll('.tabs__tab').length > 0", 30000)
  check('กดแล้วเปิดหน้าแก้ไขได้จริง', opened, await evaluate('location.pathname'))
}

console.log(`\nผ่าน ${pass} · ตก ${fail}`)
await send('Browser.close').catch(() => {})
chrome.kill()
await redis.del(`session:${sid}`)
redis.disconnect()
process.exit(fail ? 1 : 0)
