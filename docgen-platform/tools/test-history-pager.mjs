/**
 * แถบแบ่งหน้าในแท็บประวัติ — ผู้ใช้สั่ง *"ข้อมูลเยอะมาก แก้ไขให้มี pageination"*
 *
 *   node --env-file=../dokploy-infra/.env --env-file=../dokploy-infra/.env.development tools/test-history-pager.mjs
 *
 * ── ทำไมต้องมี ─────────────────────────────────────────────────
 * เปิดแม่แบบที่คนใช้เยอะ (เช่นนี้ 350 ฉบับ / 100 คน) แล้วการ์ด "ผู้ใช้แม่แบบนี้"
 * ยาวจนหาชื่อคนที่อยู่ล่างสุดไม่เจอ และตาราง "ฉบับล่าสุด" โหลดมาแค่ 30 แถว
 * โดยไม่บอกว่ามีอีกเท่าไร
 *
 * ── สิ่งที่ต้องผ่าน ─────────────────────────────────────────────
 * API
 *  1. หน้าแรกได้ `limit` รายการ และ `total` เป็นจำนวนเต็ม (ไม่ใช่ของหน้าเดียว)
 *  2. `skip` ทำให้ได้หน้าถัดไปจริง (หัวเอกสารต่างกัน)
 *  3. สองหน้าติดกันไม่มีฉบับซ้ำกันเลย
 *  4. `skip` เกินจำนวนจริง → รายการว่าง แต่ `total` ยังถูก
 *  5. `skip` ติดลบ หรือเกินเพดาน 50,000 → 422
 *
 * UI
 *  6. รายชื่อผู้ใช้หน้าแรกไม่เกิน 10 คน
 *  7. กด "หน้าถัดไป" แล้วเห็นคนอื่น และยังไม่เกิน 10 คน
 *  8. ตารางฉบับล่าสุดหน้าแรกไม่เกิน 20 แถว
 *  9. กด "หน้าถัดไป" แล้วแถวเปลี่ยน (ไม่ใช่หน้าเดิมซ้ำ)
 * 10. ข้อความบอกช่วงที่เห็น ("1–20 จาก 350")
 * 11. ปุ่ม "หน้าก่อนหน้า" ถูกปิดตอนอยู่หน้าแรก
 * 12. เปลี่ยนแม่แบบแล้วเลขหน้าถูกรีเซ็ตกลับเป็นหน้า 1
 */
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Redis from 'ioredis'

const API = process.env.API_URL ?? 'http://127.0.0.1:4001'
const WEB = 'http://localhost:3000'
const CHROME = process.env.CHROME_PATH ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const PORT = 9384
const STAMP = Date.now()
const OUT = new URL('../tests/nav-status/output-history-pager/', import.meta.url)
mkdirSync(OUT, { recursive: true })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** แม่แบบที่มีประวัติเยอะพอจะทดสอบการแบ่งหน้าได้จริง */
const KEY = process.env.HISTORY_KEY ?? '1521017977904182340'
const PAGE_USERS = 10
const PAGE_DOCS = 20

let pass = 0
let fail = 0
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`)
  ok ? pass++ : fail++
}

const redis = new Redis(process.env.VALKEY_URL)
/** ⚠️ sid ต้องเป็น ASCII — sid ไปอยู่ใน cookie ซึ่งเป็น HTTP header */
const sid = `hist-${STAMP}`
await redis.set(
  `session:${sid}`,
  JSON.stringify({ sub: sid, name: 'ผู้ทดสอบ', email: `hist-${STAMP}@test.local`, avatar: '' }),
  'EX',
  1800,
)
const H = { cookie: `docgen_session=${sid}` }
const getJson = async (q = '') => {
  const r = await fetch(`${API}/api/history/${KEY}?limit=${PAGE_DOCS}${q}`, { headers: H })
  return { status: r.status, body: await r.json().catch(() => null) }
}

console.log(`\n── แบ่งหน้าประวัติ (แม่แบบ ${KEY}) ─────────────\n`)

// ── 1 ─────────────────────────────────────────────────────────
console.log('[1] API แบ่งหน้า')
const p1 = await getJson('&skip=0')
check('หน้าแรกได้ครบตาม limit', p1.body?.items?.length === PAGE_DOCS, `${p1.body?.items?.length} รายการ`)
check('total เป็นจำนวนเต็ม ไม่ใช่ของหน้าเดียว', (p1.body?.total ?? 0) > PAGE_DOCS, `total = ${p1.body?.total}`)
check('รายชื่อผู้ใช้มาครบทุกคน', (p1.body?.users?.length ?? 0) > 1, `${p1.body?.users?.length} คน`)

// ── 2–3 ──────────────────────────────────────────────────────
const p2 = await getJson(`&skip=${PAGE_DOCS}`)
const idA = p1.body?.items?.[0]?._id
const idB = p2.body?.items?.[0]?._id
check('skip ทำให้ได้หน้าถัดไปจริง', !!idA && !!idB && idA !== idB, `${idA} vs ${idB}`)
const set1 = new Set((p1.body?.items ?? []).map((x) => x._id))
const overlap = (p2.body?.items ?? []).filter((x) => set1.has(x._id)).length
check('สองหน้าติดกันไม่มีฉบับซ้ำกัน', overlap === 0, `ซ้ำ ${overlap} รายการ`)

// ── 4 ─────────────────────────────────────────────────────────
const beyond = await getJson(`&skip=${(p1.body?.total ?? 0) + 500}`)
check('skip เกินจำนวนจริง → รายการว่าง', (beyond.body?.items?.length ?? -1) === 0, `${beyond.body?.items?.length} รายการ`)
check('แต่ total ยังถูก', beyond.body?.total === p1.body?.total, `total = ${beyond.body?.total}`)

// ── 5 ─────────────────────────────────────────────────────────
const neg = await getJson('&skip=-1')
check('skip ติดลบ → 422', neg.status === 422, `HTTP ${neg.status}`)
const huge = await getJson('&skip=999999')
check('skip เกินเพดาน 50,000 → 422', huge.status === 422, `HTTP ${huge.status}`)

// ── 6–12 UI ──────────────────────────────────────────────────
console.log('\n[2] หน้าเว็บ')
const profile = mkdtempSync(join(tmpdir(), 'cdp-histpager-'))
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
    const l = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
    wsUrl = l.find((x) => x.type === 'page')?.webSocketDebuggerUrl
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
const waitFor = async (expr, ms = 25000) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    try {
      if (await evaluate(expr)) return true
    } catch {}
    await sleep(250)
  }
  return false
}
/** เลื่อนให้การ์ดที่จะถ่ายภาพอยู่บนสุด — ไม่งั้นภาพจะเป็นกลางตารางอ่านไม่ออก */
const scrollTo = (testId) =>
  evaluate(
    `document.querySelector('[data-testid=${JSON.stringify(testId)}]')?.scrollIntoView({ block: 'start' })`,
  )
const shot = async (name, topOf) => {
  if (topOf) {
    await scrollTo(topOf)
    await sleep(300)
  }
  const { data } = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(new URL(name, OUT), Buffer.from(data, 'base64'))
}
await send('Page.enable')
await send('Runtime.enable')
await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false })
await send('Network.setCacheDisabled', { cacheDisabled: true })
await send('Network.setCookie', { name: 'docgen_session', value: sid, url: WEB })
await send('Page.navigate', { url: `${WEB}/studio/${KEY}?tabs=form&pane=history` })
await waitFor('!document.querySelector(".bootveil")', 45000)
await waitFor('!!document.querySelector(\'[data-testid="history-users"]\')', 25000)

/** โยนเหตุการณ์คลิกจริง (ห้ามใช้ element.click()) */
const click = async (testId) => {
  const hit = await evaluate(`(() => {
    const b = document.querySelector('[data-testid=${JSON.stringify(testId)}]')
    if (!b) return { ok: false }
    b.scrollIntoView({ block: 'center' })
    const r = b.getBoundingClientRect()
    const x = r.x + r.width / 2, y = r.y + r.height / 2
    const el = document.elementFromPoint(x, y)
    return { ok: !!el && (el === b || b.contains(el)), x, y }
  })()`)
  if (!hit?.ok) return false
  for (const type of ['mousePressed', 'mouseReleased'])
    await send('Input.dispatchMouseEvent', { type, x: hit.x, y: hit.y, button: 'left', clickCount: 1 })
  return true
}
const userRows = () =>
  evaluate(`document.querySelectorAll('[data-testid="history-users"] .who').length`)
/**
 * ข้อความทั้งแถว ไม่ใช่แค่ชื่อ
 *
 * ⚠️ ชื่อที่แสดง**ซ้ำได้** — คนละ `sub` แต่ชื่อเดียวกัน (เช่น session ของเทสต์
 *    ที่ตั้งชื่อเหมือนกันทั้งหมด) ถ้าเทียบแค่ `.who__name` จะเห็นชื่อเดิมข้ามหน้า
 *    แล้วรายงานว่า "หน้าไม่เปลี่ยน" ทั้งที่จริง ๆ เปลี่ยนแล้ว
 *    แถวเต็มมีชื่อ + เวลาล่าสุด + จำนวนฉบับ รวมกันแล้วแทบไม่ซ้ำ
 */
const userRowsText = () =>
  evaluate(
    `Array.from(document.querySelectorAll('[data-testid="history-users"] .who')).map((e) => e.textContent)`,
  )
const userNames = () =>
  evaluate(
    `Array.from(document.querySelectorAll('[data-testid="history-users"] .who__name')).map((e) => e.textContent)`,
  )
const docRows = () => evaluate(`document.querySelectorAll('[data-testid="history-docs-body"] tr').length`)
const docFirst = () =>
  evaluate(`document.querySelector('[data-testid="history-docs-body"] tr')?.textContent ?? ''`)

// ── 6 ─────────────────────────────────────────────────────────
const u1 = await userRows()
check(`รายชื่อผู้ใช้หน้าแรกไม่เกิน ${PAGE_USERS} คน`, u1 > 0 && u1 <= PAGE_USERS, `${u1} คน`)
const names1 = await userRowsText()
const totalUsers = p1.body?.users?.length ?? 0
if (totalUsers > PAGE_USERS) {
  check('มีปุ่มหน้าถัดไป', await click('history-users-pager-next'))
  await sleep(400)
  const names2 = await userRowsText()
  check('หน้า 2 ไม่ซ้ำหน้า 1', names2.join('|') !== names1.join('|'), '')
  check(`หน้า 2 ก็ไม่เกิน ${PAGE_USERS} คน`, names2.length <= PAGE_USERS, `${names2.length} คน`)
  check('ไม่มีแถวซ้ำข้ามหน้า', !names2.some((n) => names1.includes(n)), '')
  await click('history-users-pager-prev')
  await sleep(400)
  check('ย้อนกลับแล้วได้หน้าเดิม', (await userRowsText()).join('|') === names1.join('|'), '')
} else {
  console.log(`  · ข้ามการแบ่งหน้ารายชื่อ — มีแค่ ${totalUsers} คน`)
}
await shot('01-users.png', 'history-users')

// ── 8 ─────────────────────────────────────────────────────────
const d1 = await docRows()
check(`ตารางฉบับล่าสุดหน้าแรกไม่เกิน ${PAGE_DOCS} แถว`, d1 > 0 && d1 <= PAGE_DOCS, `${d1} แถว`)
const firstRow1 = await docFirst()
check('ปุ่ม "หน้าก่อนหน้า" ถูกปิดตอนอยู่หน้าแรก', await evaluate(`!!document.querySelector('[data-testid="history-docs-pager-prev"]')?.disabled`))
const range = await evaluate(`document.querySelector('[data-testid="history-docs-pager-range"]')?.textContent ?? ''`)
check('ข้อความบอกช่วงที่เห็น', /1–20 จาก \d+/.test(range), range)

// ── 9 ─────────────────────────────────────────────────────────
check('มีปุ่มหน้าถัดไปของตาราง', await click('history-docs-pager-next'))
await waitFor(`document.querySelectorAll('[data-testid="history-docs-body"] tr').length > 0`, 20000)
await sleep(600)
const firstRow2 = await docFirst()
check('กดหน้าถัดไปแล้วแถวเปลี่ยนจริง', firstRow2 !== firstRow1, firstRow1.slice(0, 30))
check('หน้า 2 ยังไม่เกิน limit', (await docRows()) <= PAGE_DOCS, `${await docRows()} แถว`)
const range2 = await evaluate(`document.querySelector('[data-testid="history-docs-pager-range"]')?.textContent ?? ''`)
check('ช่วงเปลี่ยนตามหน้า', /21–40 จาก \d+/.test(range2), range2)
await shot('02-docs-page2.png', 'history-docs')

// ── 12 ────────────────────────────────────────────────────────
console.log('\n[3] เปลี่ยนแม่แบบแล้วเลขหน้าต้องกลับเป็นหน้า 1')
const otherKey = process.env.HISTORY_KEY2 ?? '1521834214022732219'
await send('Page.navigate', { url: `${WEB}/studio/${otherKey}?tabs=form&pane=history` })
await waitFor('!document.querySelector(".bootveil")', 45000)
/**
 * ⚠️ ต้อง**รอเงื่อนไข** ไม่ใช่ `sleep` ตายตัว
 *   ตอนเปลี่ยนแม่แบบ `data` เก่ายังอยู่ใน state ระหว่างรอ fetch หน้าใหม่
 *   แถบเลขหน้าจึงยังโชว์ของแม่แบบเก่าอยู่ชั่วขณะ
 */
const settled = await waitFor(
  `!!document.querySelector('[data-testid="history-docs-pager-page-1"][aria-current="page"]')`,
  25000,
)
check('กลับมาหน้า 1 ทันที ไม่ค้างที่หน้าเก่า', settled, '')
await shot('03-other-template.png', 'history-users')

await send('Browser.close').catch(() => {})
chrome.kill()

await redis.del(`session:${sid}`)
redis.disconnect()
console.log(`\n── ผ่าน ${pass} · ไม่ผ่าน ${fail} ─────────────────────`)
console.log(`ภาพ: ${OUT.pathname}\n`)
process.exit(fail ? 1 : 0)
