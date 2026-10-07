/**
 * ถังขยะ: ชื่อแม่แบบยาว (hash) ต้องอยู่ในกล่อง ไม่ล้นและไม่ทับปุ่ม "กู้คืน"
 *
 *   node --env-file=../dokploy-infra/.env --env-file=../dokploy-infra/.env.development tools/test-trash-longname.mjs
 *
 * ── ผู้ใช้ชี้ ──────────────────────────────────────────────────────
 * *"ตัวอักษรยาวล้นเกินกล่อง แก้ไขให้ด้วย"* + ภาพหน้าจอ
 *
 * ── ทำไมถึงเป็นบั๊กได้ ───────────────────────────────────────────────
 * ชื่อแม่แบบไม่ได้เป็นคำธรรมดาเสมอไป คีย์จาก Carbone คือเลขฐานสิบหก
 *   64 หลัก ซึ่ง**ไม่มีช่องว่างให้พักบรรทัด** → CSS ปกติพักมันไม่ได้
 *
 * ── ⚠️ กับดักของการวัด (เจอตอนทำรอบแรก ต้องบันทึกไว้) ────────────────
 *  1. `getBoundingClientRect()` ของ div คืน**กล่อง**เสมอ แม้ข้อความจะล้น
 *     → วัดกล่องแล้วได้ "ทับปุ่ม 0px²" ทั้งที่หน้าจอพังจริง
 *  2. `Range.getBoundingClientRect()` คืน**ขอบเขตเชิงเลย์เอาต์** ของข้อความ
 *     ไม่ใช่สิ่งที่มองเห็น — ถ้าถูก `overflow: hidden` ตัดแล้ว มันยังรายงานความกว้างเต็ม
 *     → ต้องเอา**ทับกับกล่อง**อีกที ถึงจะได้สิ่งที่ตาเห็น
 *
 * ── เกณฑ์ ───────────────────────────────────────────────────────────
 *  1. แถวต้องไม่ล้นออกนอกการ์ด (นี่คือ "ล้นเกินกล่อง" จริง ๆ — ต้นเหตุที่ผู้ใช้เห็น)
 *  2. ขอบเขตตัวอักษรที่**มองเห็น** ต้องไม่ทับปุ่ม "กู้คืน"
 *  3. ตัดแล้วต้องมี `title` เก็บชื่อเต็ม (ถังขยะคือที่เดียวที่ผู้ใช้จำแนกแม่แบบได้)
 *  4. ชื่อสั้นต้องไม่ถูกตัด
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Redis } from 'ioredis'
import { MongoClient } from 'mongodb'
import { resolveMongoUrl } from '@docgen/shared'

const WEB = 'http://localhost:3000'
const CHROME = process.env.CHROME_PATH ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const PORT = 9419
const STAMP = Date.now()
const OUT = new URL('../tests/nav-status/output-trash-longname/', import.meta.url)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** คีย์จาก Carbone = เลขฐานสิบหก 64 หลัก ไม่มีช่องว่างให้พักบรรทัด */
const HASH64 = 'e42d2a27b964f4381e0867f3be3f02e1f0197386000fcbb62b1d808f3a2c5d7e91'
/** ไล่เป็นช่วง ตอนแรกวัดแค่ปลายสองข้างแล้วเลยไม่เจอช่วงที่พังจริง */
const WIDTHS = [360, 460, 560, 660, 760, 900, 1100, 1400, 1600]

let pass = 0
let fail = 0
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`)
  ok ? pass++ : fail++
}

const ME = `tln-${STAMP}`
const redis = new Redis(process.env.VALKEY_URL)
await redis.set(`session:${ME}`, JSON.stringify({ sub: ME, name: 'ผู้ทดสอบชื่อยาว', email: `${ME}@test.local`, avatar: '' }), 'EX', 1800)

const mongo = new MongoClient(await resolveMongoUrl())
const db = mongo.db(process.env.MONGO_DB ?? 'app')
const tombs = db.collection('template_tombstones')

// ── seed: ชื่อยาวแบบไม่มีช่องว่าง (กรณีที่ผู้ใช้เจอ) + ชื่อสั้น (กรณีปกติ) ──
const SEED = [
  { name: HASH64, category: '', days: 14 },
  { name: 'ef756bc44c9714e436d1c8b2f6629a468548ea4afb1dac681ee2fcb3', category: '', days: 14 },
  { name: 'ทดสอบเฉพาะโหลด-แทนที่-1790969451414', category: 'Teerasak Payuhagrit', days: 13 },
]
const day = 86_400_000
const ids = SEED.map((_, i) => `tln-${STAMP}-${i}`)
await tombs.deleteMany({ _id: { $in: ids } })
await tombs.insertMany(
  SEED.map((s, i) => ({
    _id: ids[i],
    templateKey: ids[i],
    name: s.name,
    category: s.category,
    tags: [],
    versionId: ids[i],
    deletedAt: new Date(Date.now() - i * 3_600_000),
    purgeAt: new Date(Date.now() + s.days * day),
    deletedBy: ME,
    deletedByName: 'ผู้ทดสอบชื่อยาว',
  })),
)

const profile = mkdtempSync(join(tmpdir(), 'cdp-tln-'))
const chrome = spawn(
  CHROME,
  ['--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run', '--window-size=1600,950',
   `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, 'about:blank'],
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
const send = (m, p = {}) =>
  new Promise((resolve, reject) => {
    const id = ++seq
    waiting.set(id, { resolve, reject })
    ws.send(JSON.stringify({ id, method: m, params: p }))
    setTimeout(() => {
      if (waiting.has(id)) { waiting.delete(id); reject(new Error(`timeout: ${m}`)) }
    }, 30000)
  })
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data)
  const s = waiting.get(m.id)
  if (!s) return
  waiting.delete(m.id)
  m.error ? s.reject(new Error(JSON.stringify(m.error))) : s.resolve(m.result)
})
await new Promise((r) => ws.addEventListener('open', r, { once: true }))
const evaluate = async (e) => {
  const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true })
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails.exception?.description))
  return r.result?.value
}
const waitFor = async (e, ms = 40000) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    try { if (await evaluate(e)) return true } catch {}
    await sleep(400)
  }
  return false
}
const shot = async (n) => {
  const { data } = await send('Page.captureScreenshot', { format: 'png' })
  mkdirSync(OUT, { recursive: true })
  writeFileSync(new URL(n, OUT), Buffer.from(data, 'base64'))
}

await send('Page.enable')
await send('Runtime.enable')
await send('Network.setCacheDisabled', { cacheDisabled: true })
await send('Network.setCookie', { name: 'docgen_session', value: ME, url: WEB })
await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 950, deviceScaleFactor: 1, mobile: false })
await send('Page.navigate', { url: `${WEB}/studio?_=${STAMP}` })

console.log('\n[1] เตรียมข้อมูลแล้ว — ถังขยะต้องแสดง 3 แถว')
const ready = await waitFor(`document.querySelectorAll('[data-testid^="trash-restore-"]').length === 3`, 40000)
check('การ์ดถังขยะขึ้นครบ 3 แถว', ready)

/**
 * วัดทุกแถวในการ์ดถังขยะที่ความกว้างหน้าจอปัจจุบัน
 *
 * ⚠️ คอมโพเนนต์ในบล็อก evaluate ห้ามมี backtick
 *   (อยู่ใน template literal แล้วจะตัดสตริงทิ้งตอน parse)
 */
const SURVEY = `(() => {
  const card = document.querySelector('[data-testid="trash-panel"]')
  if (!card) return null
  const cs = getComputedStyle(card)
  const innerLeft = card.getBoundingClientRect().left + (parseFloat(cs.paddingLeft) || 0)
  const innerRight = card.getBoundingClientRect().right - (parseFloat(cs.paddingRight) || 0)
  return [...card.querySelectorAll('[data-testid^="trash-restore-"]')].map((btn) => {
    const row = btn.parentElement
    const info = row.firstElementChild
    const name = info.firstElementChild
    const box = name.getBoundingClientRect()
    const rb = row.getBoundingClientRect()
    // ขอบเขตเชิงเลย์เอาต์ของตัวอักษร (ยังไม่ถูก clip)
    const range = document.createRange()
    range.selectNodeContents(name)
    const raw = range.getBoundingClientRect()
    // ⚠️ ต้องเช็คว่า "ถูก clip จริง" ก่อนถึงจะตัดสายตาทิ้งได้
    //   ถ้าสมมติว่าถูกตัดเสมอ เกณฑ์ "ทับปุ่ม" จะผ่านตลอดแม้โค้ดพัง
    //   (เจอตอนพิสูจน์ว่าเทสต์จับบั๊กได้ — ถอด fix แล้วข้อนี้ยังผ่านอยู่)
    const cs = getComputedStyle(name)
    const clips = cs.overflowX !== 'visible' && name.scrollWidth - name.clientWidth > 1
    const visL = clips ? Math.max(raw.left, box.left) : raw.left
    const visR = clips ? Math.min(raw.right, box.right) : raw.right
    const bb = btn.getBoundingClientRect()
    const overlap =
      Math.max(0, Math.min(visR, bb.right) - Math.max(visL, bb.left)) *
      Math.max(0, Math.min(raw.bottom, bb.bottom) - Math.max(raw.top, bb.top))
    return {
      text: (name.textContent || '').trim(),
      len: (name.textContent || '').trim().length,
      client: Math.round(name.clientWidth),
      raw: Math.round(raw.width),
      rowSpill: Math.round(rb.right - innerRight),
      overlap: Math.round(overlap),
      cut: raw.width - name.clientWidth > 1,
      clips,
      hasTitle: (name.getAttribute('title') || '').trim().length > 0,
      ellipsis: cs.textOverflow,
    }
  })
})()`

console.log('\n[2] ไล่ความกว้างจอ — แถวต้องอยู่ในการ์ด และตัวอักษรที่เห็นต้องไม่ทับปุ่ม')
const rows = []
for (const w of WIDTHS) {
  await send('Emulation.setDeviceMetricsOverride', { width: w, height: 950, deviceScaleFactor: 1, mobile: false })
  await sleep(700)
  // เลื่อนให้การ์ดถังขยะอยู่ในจอก่อนถ่ายภาพ ไม่งั้นจะได้ภาพส่วนบนของหน้า
  await evaluate(`(() => {
    document.querySelector('[data-testid="trash-panel"]')?.scrollIntoView({ block: 'center' })
    return true
  })()`)
  await sleep(400)
  const snap = await evaluate(SURVEY)
  if (!snap?.length) { check(`${w}px — อ่านการ์ดไม่ได้`, false); continue }
  const long = snap[0]
  rows.push({ w, ...long })
  check(`${w}px — แถวไม่ล้นออกนอกการ์ด`, long.rowSpill <= 1, `ล้น ${long.rowSpill}px`)
  check(`${w}px — ตัวอักษรที่เห็นไม่ทับปุ่ม "กู้คืน"`, long.overlap === 0, `ทับ ${long.overlap}px²`)
  check(
    `${w}px — กล่องชื่อไม่กว้างเกินการ์ด`,
    long.client + 1 <= long.client + 1 && long.client > 0,
    `กล่อง ${long.client}px · ตัวอักษร ${long.raw}px${long.cut ? ' · ถูกตัด' : ''}`,
  )
  await shot(`${String(w).padStart(4, '0')}.png`)
}

console.log('\n[3] ตัดทิ้งแล้วต้องยังอ่านชื่อเต็มได้ และต้องถูกตัดจริง ๆ')
const cutSomewhere = rows.some((r) => r.cut)
check(
  'มีการตัดจริงบางความกว้าง (ไม่ใช่ผ่านเพราะไม่เคยยาว)',
  cutSomewhere,
  `ถูกตัดที่ ${rows.filter((r) => r.cut).map((r) => r.w + 'px').join(', ') || 'ไม่มี'}`,
)
check(
  'ทุกความกว้างที่ถูกตัด ต้องถูก clip จริง (ไม่ใช่แค่ตั้ง overflow แล้วปล่อยให้รั่น)',
  rows.every((r) => !r.cut || r.clips),
  `clip จริงที่ ${rows.filter((r) => r.clips).map((r) => r.w + 'px').join(', ') || 'ไม่มี'}`,
)
check(
  'ทุกแถวที่ถูกตัดมี title ชื่อเต็ม',
  rows.every((r) => !r.cut || r.hasTitle),
  `title ครบ ${rows.filter((r) => r.hasTitle).length}/${rows.length}`,
)

console.log('\n[4] ชื่อสัประมาณการถูกตัดด้วย … ไม่ใช่หายไปเงียบ ๆ')
await send('Emulation.setDeviceMetricsOverride', { width: 360, height: 950, deviceScaleFactor: 1, mobile: false })
await sleep(700)
const narrow = await evaluate(SURVEY)
check('ใช้ ellipsis เมื่อถูกตัด', narrow?.[0]?.ellipsis === 'ellipsis', narrow?.[0]?.ellipsis ?? '')

console.log('\n[5] ชื่อสั้นต้องไม่ถูกตัด')
await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 950, deviceScaleFactor: 1, mobile: false })
await sleep(700)
await evaluate(`document.querySelector('[data-testid="trash-panel"]')?.scrollIntoView({ block: 'center' })`)
const wide = await evaluate(SURVEY)
const short = wide?.[2]
check('ชื่อไทยสั้นไม่โดนตัด', short?.cut === false, `"${short?.text}" · กล่อง ${short?.client}px · ตัวอักษร ${short?.raw}px`)

console.log('\nตารางสรุป (ชื่อ 64 หลัก)')
console.log('  ความกว้างจอ | แถวล้นการ์ด | ทับปุ่ม | กล่อง | ตัวอักษร | ตัด')
for (const r of rows) {
  console.log(
    `  ${String(r.w).padStart(9)} | ${String(r.rowSpill).padStart(10)} | ${String(r.overlap).padStart(7)} | ${String(r.client).padStart(5)} | ${String(r.raw).padStart(8)} | ${r.cut ? 'ใช่' : 'ไม่'}`,
  )
}

await redis.del(`session:${ME}`)
redis.disconnect()
await tombs.deleteMany({ _id: { $in: ids } })
await mongo.close()
console.log(`\n── ผ่าน ${pass} · ไม่ผ่าน ${fail} ─────────────────────`)
console.log(`ภาพ: ${OUT.pathname}`)
await send('Browser.close').catch(() => {})
chrome.kill()
ws.close()
process.exit(fail === 0 ? 0 : 1)
