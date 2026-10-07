/**
 * วัดว่าหน้ารายการแม่แบบ (/studio) ล้นจอแนวนอนตอนจอแคบแค่ไหน
 *
 *   node --env-file=../dokploy-infra/.env --env-file=../dokploy-infra/.env.development tools/inspect-list-mobile.mjs
 *
 * ── ทำไมต้องมีเครื่องมือนี้ ───────────────────────────────────────
 * ผู้ใช้ทำเครื่องหมายที่ตารางรายการแม่แบบแล้วบอกว่า
 *   "ปุ่ม เปิด / ดาวน์โหลด / ลบ ถูกตัดออกจอที่ viewport 579px"
 *
 * นี่เป็นข้อตกลงที่วัดด้วยตัวเลขได้ ไม่ใช่เรื่องความรู้สึก:
 *   · หน้า**ต้องไม่ล้นแนวนอน** (scrollWidth ของ document ต้อง ≤ ความกว้างจอ)
 *   · ปุ่มจัดการทุกปุ่มต้อง**อยู่ในจอจริง** (ขอบขวาของเซลล์สุดท้าย ≤ ความกว้างจอ)
 *   · บนมือถือปุ่มต้อง**แตะง่าย** (สูงไม่น้อยกว่า 36px ตามเกณฑ์ WCAG 2.5.8)
 *
 * เทสต์บอกได้แค่ผ่าน/ไม่ผ่าน เครื่องมือนี้พิมพ์ค่าจริงทุกความกว้าง พร้อมภาพหน้าจอ
 */
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Redis } from 'ioredis'

const CHROME = process.env.CHROME_PATH ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const PORT = 9363
const WEB = 'http://localhost:3000'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** ความกว้างที่ต้องดู — รวม 579 ซึ่งเป็นความกว้างที่ผู้ใช้เจอปัญหา */
const WIDTHS = [360, 414, 579, 768, 1024, 1440]
const HEIGHT = 900

const redis = new Redis(process.env.VALKEY_URL)
const sid = `dbgmob-${Date.now()}`
await redis.set(
  `session:${sid}`,
  JSON.stringify({ sub: sid, name: 'วัดมือถือ', email: 'dbgmob@test.local', avatar: '' }),
  'EX',
  1800,
)

const profile = mkdtempSync(join(tmpdir(), 'cdp-dbgmob-'))
const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--no-first-run',
    `--window-size=1440,${HEIGHT}`,
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
  } catch {}
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
const waitFor = async (expr, ms = 60000) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    try {
      if (await evaluate(expr)) return true
    } catch {}
    await sleep(300)
  }
  return false
}
const shot = async (name) => {
  const { data } = await send('Page.captureScreenshot', { format: 'png' })
  mkdirSync(join(process.cwd(), 'logs'), { recursive: true })
  const file = join(process.cwd(), 'logs', `listmob-${name}.png`)
  writeFileSync(file, Buffer.from(data, 'base64'))
  console.log('  ภาพ:', file)
}

await send('Page.enable')
await send('Runtime.enable')
await send('Emulation.setDeviceMetricsOverride', {
  width: 1440,
  height: HEIGHT,
  deviceScaleFactor: 1,
  mobile: false,
})
await send('Network.setCookie', { name: 'docgen_session', value: sid, url: WEB })
await send('Network.setCacheDisabled', { cacheDisabled: true })
await send('Page.navigate', { url: `${WEB}/studio` })
await waitFor('!document.querySelector(".bootveil")')
await waitFor("document.querySelectorAll('table tbody tr').length > 0", 45000)

/**
 * วัดทุกอย่างที่ข้อตกลง "รองรับมือถือ" พึ่งไว้ — คืนค่าเป็นตัวเลขล้วน ๆ
 */
const probe = () =>
  evaluate(`(() => {
  const de = document.documentElement
  const rows = [...document.querySelectorAll('.tpllist tbody tr')]
  const cell = (tr) => tr.lastElementChild
  /**
   * ⚠️ ต้องเช็คทุกแถว ไม่ใช่แถวแรก
   *    ชื่อแม่แบบยาว ๆ บังคับให้ตารางกว้างเกินจอ ต่อให้แถวสั้น ๆ จะพอดี
   *    (เคยเจอ: แถวแรกพอดีจอ แต่แถวที่ชื่อยาวที่สุดล้น)
   */
  const rowInfo = rows.map((tr) => {
    const c = cell(tr)
    const b = c.getBoundingClientRect()
    const btns = [...c.querySelectorAll('button, a')].filter((x) => x.offsetParent !== null || x.getClientRects().length)
    const nameBtn = tr.querySelector('td button')
    return {
      name: (nameBtn?.textContent || '').trim().slice(0, 22),
      cellRight: Math.round(b.right),
      cellW: Math.round(b.width),
      btns: btns.length,
      minBtnH: btns.length ? Math.min(...btns.map((x) => Math.round(x.getBoundingClientRect().height))) : 0,
      /** ปุ่มที่ล้นออกนอกจอ (ขอบขวาเกินความกว้างจอ) — ตัวเลขนี้คือ "ถูกตัด" */
      offscreen: btns.filter((x) => x.getBoundingClientRect().right > innerWidth + 0.5).length,
    }
  })
  const w = innerWidth
  return {
    w,
    /** หน้าล้นแนวนอนหรือไม่ */
    overflowX: Math.max(de.scrollWidth, document.body.scrollWidth) - w,
    rows: rows.length,
    offscreenRows: rowInfo.filter((r) => r.offscreen > 0).length,
    widestCellRight: Math.max(0, ...rowInfo.map((r) => r.cellRight)),
    minBtnH: rowInfo.length ? Math.min(...rowInfo.map((r) => r.minBtnH)) : 0,
    theadVisible: !!document.querySelector('.tpllist thead')?.getClientRects().length,
    /** ตารางยังเป็นตารางอยู่ไหม — ถ้ากลายเป็นการ์ด บรรทัด head ต้องหาย */
    tableDisplay: getComputedStyle(document.querySelector('.tpllist')).display,
    rowDisplay: rows[0] ? getComputedStyle(rows[0]).display : '?',
    worst: rowInfo.slice().sort((a, b) => b.cellRight - a.cellRight)[0] ?? null,
  }
})()`)

console.log(`\n=== หน้ารายการแม่แบบที่ความกว้างจอต่าง ๆ (สูง ${HEIGHT}) ===\n`)
const results = []
for (const width of WIDTHS) {
  await send('Emulation.setDeviceMetricsOverride', {
    width,
    height: HEIGHT,
    deviceScaleFactor: 1,
    mobile: false,
  })
  await sleep(700) // รอ reflow + media query มีผล
  const p = await probe()
  results.push(p)
  console.log(
    `จอ ${String(width).padStart(4)}px → ล้นแนวนอน ${String(p.overflowX).padStart(4)}px · ` +
      `ปุ่มล้นจอ ${p.offscreenRows}/${p.rows} แถว · ` +
      `ปุ่มต่ำสุด ${p.minBtnH}px · ` +
      `หัวตาราง${p.theadVisible ? 'ยังอยู่' : 'ซ่อนแล้ว'} · ` +
      `tr=${p.rowDisplay} · แถวกว้างสุดขอบขวา ${p.widestCellRight}`,
  )
  if (width === 579 || width === 360) await shot(`w${width}`)
}

console.log('\nสรุป')
for (const p of results) {
  const bad = []
  if (p.overflowX > 0) bad.push(`ล้นแนวนอน ${p.overflowX}px`)
  if (p.offscreenRows > 0) bad.push(`ปุ่มล้นจอ ${p.offscreenRows} แถว`)
  if (p.w <= 720 && p.minBtnH < 36) bad.push(`ปุ่มสูง ${p.minBtnH}px (< 36)`)
  console.log(`  จอ ${String(p.w).padStart(4)}px: ${bad.length ? '✗ ' + bad.join(' · ') : '✓ ปกติ'}`)
}

await send('Browser.close').catch(() => {})
chrome.kill()
await redis.del(`session:${sid}`)
redis.disconnect()
process.exit(0)
