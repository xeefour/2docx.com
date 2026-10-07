/**
 * ถังขยะ: ต้องแบ่งหน้า
 *
 *   node --env-file=../dokploy-infra/.env --env-file=../dokploy-infra/.env.development tools/test-trash-pager.mjs
 *
 * ── ผู้ใช้ชี้ ──────────────────────────────────────────────────────
 * *"เหมือนหน้านี้ไม่มี pagination นะ"* (หน้ารายการ → การ์ด 🗑️ ถังขยะ)
 *
 * ── ทำไมต้องเทสต์ ───────────────────────────────────────────────────
 * เดิม `GET /api/templates/trash` คืนรายการ**ทั้งหมด** ไม่มี limit
 *   และ `TrashPanel` เรนเดอร์ทุกแถวรวดเดียว
 *   ถังขยะดูเหมือนเล็กเสมอ (เพราะถูกลบไม่กี่ชิ้น) แต่ถ้าผู้ใช้ลบทีละเอกสาร
 *   แล้วไม่กดกู้คืน ภายใน 14 วันสะสมได้หลายร้อยรายการ
 *   → ยิงใหญ่ขึ้นเรื่อย ๆ ทั้งที่หน้าจอยังแสดงแค่ 10 รายการ
 *
 * จุดที่พังง่ายที่สุดของการแบ่งหน้าแบบนี้:
 *   1. `total` ต้องนับแยก ใช้จำนวนที่คืนมาต่อหน้าไม่ได้ (กู้คืน/ลบระหว่างหน้า)
 *   2. อยู่หน้าสุดท้ายแล้วกดกู้คืนหมด → ต้องถูกดึงกลับ ไม่ใช่ค้างหน้าว่าง
 *   3. หน้าเดียวต้อง**ไม่โชว์**แถบปุ่ม (ปุ่ม ‹ 1 › ที่กดอะไรไม่ได้ = ดูเหมือนพัง)
 */
import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Redis } from 'ioredis'
import { MongoClient } from 'mongodb'
import { resolveMongoUrl } from '@docgen/shared'

const WEB = 'http://localhost:3000'
const API = process.env.API_URL ?? 'http://127.0.0.1:4001'
const CHROME = process.env.CHROME_PATH ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const PORT = 9413
const STAMP = Date.now()
const OUT = new URL('../tests/nav-status/output-trash-pager/', import.meta.url)
const TOTAL = 12 // มากกว่า TRASH_PAGE_SIZE (10) พอดี → 2 หน้า
const PAGE_SIZE = 10
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let pass = 0
let fail = 0
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`)
  ok ? pass++ : fail++
}

const ME = `tpp-${STAMP}`
const redis = new Redis(process.env.VALKEY_URL)
const mkSession = async (sub, name) => {
  await redis.set(`session:${sub}`, JSON.stringify({ sub, name, email: `${sub}@test.local`, avatar: '' }), 'EX', 1800)
  return { cookie: `docgen_session=${sub}` }
}
const HD = await mkSession(ME, 'ผู้ทดสอบถังขยะ')

const mongo = new MongoClient(await resolveMongoUrl())
const db = mongo.db(process.env.MONGO_DB ?? 'app')
const tombs = db.collection('template_tombstones')

// ── seed tombstone จำนวน TOTAL รายการ ────────────────────────────────
const ids = Array.from({ length: TOTAL }, (_, i) => `tpp-${STAMP}-${i}`)
await tombs.deleteMany({ _id: { $in: ids } })
const day = 86_400_000
await tombs.insertMany(
  ids.map((id, i) => ({
    _id: id,
    templateKey: id,
    name: `แม่แบบทดสอบ ${i + 1}`,
    category: 'ทดสอบ',
    tags: [],
    versionId: id,
    deletedAt: new Date(Date.now() - i * 3_600_000),
    // ให้วันที่เหลือต่างกัน เพื่อดูว่าเรียงใหม่สุดขึ้นก่อนจริง
    purgeAt: new Date(Date.now() + (14 - i) * day),
    deletedBy: ME,
    deletedByName: 'ผู้ทดสอบถังขยะ',
  })),
)

const get = async (path) => {
  const r = await fetch(`${API}${path}`, { headers: HD })
  return { status: r.status, body: await r.json().catch(() => null) }
}

console.log('\n[0] เก็บกวาด — ต้องไม่มี tombstone ค้างจากรอบก่อน')
await tombs.deleteMany({ deletedBy: { $regex: '^tpp-' } })
check('ล้างของค้างจากรอบก่อนแล้ว', (await tombs.countDocuments({ deletedBy: { $regex: '^tpp-' } })) === 0)
await tombs.insertMany(
  ids.map((id, i) => ({
    _id: id,
    templateKey: id,
    name: `แม่แบบทดสอบ ${i + 1}`,
    category: 'ทดสอบ',
    tags: [],
    versionId: id,
    deletedAt: new Date(Date.now() - i * 3_600_000),
    purgeAt: new Date(Date.now() + (14 - i) * day),
    deletedBy: ME,
    deletedByName: 'ผู้ทดสอบถังขยะ',
  })),
)

console.log('\n[1] API ต้องแบ่งหน้า ไม่ใช่คืนทั้งหมด')
const all = await get('/api/templates/trash')
check('คืน total มาด้วย', all.body?.total === TOTAL, `total=${all.body?.total}`)
// ค่าเริ่มต้นคือ 20 ต่อหน้า → ต้องไม่เกินนั้น (ไม่ใช่คืนทั้งหมดเมื่อมีน้อยกว่า)
check(
  'ค่าเริ่มต้นไม่เกิน 20 รายการต่อหน้า',
  (all.body?.items ?? []).length === Math.min(TOTAL, 20),
  `ได้ ${(all.body?.items ?? []).length} รายการจาก ${TOTAL}`,
)
const p1 = await get(`/api/templates/trash?limit=${PAGE_SIZE}&skip=0`)
const p2 = await get(`/api/templates/trash?limit=${PAGE_SIZE}&skip=${PAGE_SIZE}`)
check('หน้า 1 ได้ครบหนึ่งหน้า', (p1.body?.items ?? []).length === PAGE_SIZE, `${(p1.body?.items ?? []).length} รายการ`)
check('หน้า 2 ได้ที่เหลือ', (p2.body?.items ?? []).length === TOTAL - PAGE_SIZE, `${(p2.body?.items ?? []).length} รายการ`)
check(
  'หน้าสองไม่ซ้ำกับหน้าแรก',
  !(p1.body?.items ?? []).some((a) => (p2.body?.items ?? []).some((b) => b.templateKey === a.templateKey)),
)
check(
  'เรียงใหม่สุดขึ้นก่อน',
  (p1.body?.items ?? [])[0]?.name === 'แม่แบบทดสอบ 1',
  (p1.body?.items ?? [])[0]?.name ?? '',
)
check('total เท่ากันทุกหน้า (นับแยก ไม่ใช่ items.length)', p2.body?.total === TOTAL, `total=${p2.body?.total}`)

// ── UI ────────────────────────────────────────────────────────────────
const profile = mkdtempSync(join(tmpdir(), 'cdp-tpp-'))
const chrome = spawn(
  CHROME,
  ['--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run', '--window-size=1280,950',
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
const waitFor = async (e, ms = 30000) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    try { if (await evaluate(e)) return true } catch {}
    await sleep(400)
  }
  return false
}
const shot = async (n) => {
  const { data } = await send('Page.captureScreenshot', { format: 'png' })
  const { writeFileSync, mkdirSync } = await import('node:fs')
  mkdirSync(OUT, { recursive: true })
  writeFileSync(new URL(n, OUT), Buffer.from(data, 'base64'))
}

await send('Page.enable')
await send('Runtime.enable')
await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 950, deviceScaleFactor: 1, mobile: false })
await send('Network.setCacheDisabled', { cacheDisabled: true })
await send('Network.setCookie', { name: 'docgen_session', value: ME, url: WEB })
await send('Page.navigate', { url: `${WEB}/studio?_=${STAMP}` })

console.log('\n[2] หน้าเว็บต้องแสดงหนึ่งหน้า ไม่ใช่ทั้งหมด')
check('การ์ดถังขยะปรากฏ', !!(await waitFor(`!!document.querySelector('[data-testid="trash-panel"]')`, 40000)))
const first = await evaluate(`(() => {
  const box = document.querySelector('[data-testid="trash-panel"]')
  const rows = box.querySelectorAll('[data-testid^="trash-restore-"]')
  return {
    rows: rows.length,
    // คอมโพเนนต์ห้ามมี backtick ตรงนี้ — อยู่ใน template literal แล้วจะตัดสตริงทิ้ง
    // Pager ไม่ได้ใส่ testid ที่ราก (มีแต่ -range / -prev / -next / -page-N)
    // ต้องเช็คปุ่มหน้าถัดไป ไม่ใช่ตัวครอบ
    pager: !!document.querySelector('[data-testid="trash-pager-next"]'),
    head: box.querySelector('h2').innerText.trim(),
    range: document.querySelector('[data-testid="trash-pager-range"]')?.innerText.trim() ?? '',
    firstName: rows[0]?.closest('div[style]')?.innerText.split('\\n')[0] ?? '',
  }
})()`)
check('หน้าแรกมีไม่เกินหนึ่งหน้า', first?.rows === PAGE_SIZE, `${first?.rows} แถว`)
check('มีแถบแบ่งหน้า', first?.pager === true)
check('หัวข้อบอกจำนวนรวม ไม่ใช่จำนวนที่เห็น', new RegExp(String(TOTAL)).test(first?.head ?? ''), first?.head ?? '')
check('บอกช่วงที่แสดง', /แสดง\s*1\s*–\s*10/.test(first?.range ?? ''), first?.range ?? '')
check('หน้าแรกขึ้นรายการที่ลบล่าสุดก่อน', /ทดสอบ 1$/.test(first?.firstName ?? ''), first?.firstName ?? '')
await shot('1-page1.png')

console.log('\n[3] กดหน้าถัดไป')
await evaluate(`document.querySelector('[data-testid="trash-pager-next"]').click()`)
check('หน้า 2 แสดงรายการที่เหลือ', !!(await waitFor(`document.querySelectorAll('[data-testid^="trash-restore-"]').length === ${TOTAL - PAGE_SIZE}`, 15000)))
const second = await evaluate(`(() => ({
  rows: document.querySelectorAll('[data-testid^="trash-restore-"]').length,
  range: document.querySelector('[data-testid="trash-pager-range"]')?.innerText.trim() ?? '',
  names: [...document.querySelectorAll('[data-testid^="trash-restore-"]')].map((b) => b.closest('div[style]').innerText.split('\\n')[0]),
}))()`)
check('หน้า 2 มี 2 รายการ', second?.rows === 2, `${second?.rows} แถว`)
check('ช่วงของหน้า 2 ถูกต้อง', /แสดง\s*11\s*–\s*12/.test(second?.range ?? ''), second?.range ?? '')
check(
  'หน้า 2 ไม่ซ้ำหน้า 1',
  !(second?.names ?? []).some((n) => n === first?.firstName),
  (second?.names ?? []).join(' | '),
)
await shot('2-page2.png')

console.log('\n[4] หน้าเดียวต้องไม่โชว์แถบปุ่มที่กดอะไรไม่ได้')
await evaluate(`document.querySelector('[data-testid="trash-pager-prev"]').click()`)
check('กลับหน้า 1 ได้', !!(await waitFor(`document.querySelectorAll('[data-testid^="trash-restore-"]').length === ${PAGE_SIZE}`, 15000)))
// ลบ 2 รายการแรกออกจากฐานข้อมูลตรง ๆ เพื่อทดสอบว่า "เหลือหน้าเดียว" แล้วซ่อนปุ่ม
await tombs.deleteMany({ _id: { $in: ids.slice(0, 2) } })
await send('Page.reload')
check('การ์ดกลับมาแล้ว', !!(await waitFor(`!!document.querySelector('[data-testid="trash-panel"]')`, 30000)))
await sleep(1500)
const one = await evaluate(`(() => {
  const box = document.querySelector('[data-testid="trash-panel"]')
  return {
    rows: box.querySelectorAll('[data-testid^="trash-restore-"]').length,
    pager: !!document.querySelector('[data-testid="trash-pager-next"]'),
  }
})()`)
check('เหลือหน้าเดียว', one?.rows === 10, `${one?.rows} แถว`)
check('ไม่โชว์แถบแบ่งหน้าตอนเหลือหน้าเดียว', one?.pager === false, `pager=${one?.pager}`)

console.log('\n[5] อยู่หน้าสุดท้ายแล้วกู้คืนหมด → ต้องถูกดึงกลับ ไม่ค้างหน้าว่าง')
// เพิ่มกลับ 1 รายการ = 11 รายการ = 2 หน้า (หน้าสุดท้ายมี 1 รายการ)
await tombs.insertOne({
  _id: ids[0],
  templateKey: ids[0],
  name: 'แม่แบบทดสอบ 1',
  category: 'ทดสอบ',
  tags: [],
  versionId: ids[0],
  deletedAt: new Date(),
  purgeAt: new Date(Date.now() + 14 * day),
  deletedBy: ME,
  deletedByName: 'ผู้ทดสอบถังขยะ',
})
await send('Page.reload')
check('การ์ดกลับมาแล้ว (2 หน้า)', !!(await waitFor(`!!document.querySelector('[data-testid="trash-pager-next"]')`, 30000)))
await evaluate(`document.querySelector('[data-testid="trash-pager-next"]').click()`)
check('อยู่หน้า 2 (มี 1 รายการ)', !!(await waitFor(`document.querySelectorAll('[data-testid^="trash-restore-"]').length === 1`, 15000)))

/**
 * ⚠️ ต้องกดปุ่ม "กู้คืน" บนหน้าจอ ไม่ใช่ยิง API ตรง ๆ
 *   เพราะ guard ที่เราเพิ่ม (ดึงกลับไปหน้าสุดท้าย) ทำงานตอน `load()` ของคอมโพเนนต์
 *   ถ้า reload หน้าเว็บ state จะถูกรีเซ็ตเป็นหน้า 1 เสมอ → ทดสอบผ่านโดยไม่ได้ทดสอบอะไร
 */
/**
 * ตำแหน่งกลางปุ่ม "กู้คืน" บนหน้าจอ — ลองซ้ำจนกว่าจะเจอ
 *
 * ⚠️ ต้องหาพิกัดใน**ขั้นเดียวเดียว** กับการ scroll
 *   ถ้าแยกเป็นสอง evaluate React อาจ re-render ระหว่างทาง
 *   แล้ว element ที่เก็บไว้หลุดจาก DOM → พิกัดเป็นของตัวเก่า
 *   คลิกผิดที่แล้วเทสต์ผ่านทั้งที่ไม่ได้กดปุ่มจริง
 */
const restoreBtnPoint = async () => {
  for (let i = 0; i < 30; i++) {
    const p = await evaluate(`(() => {
      const b = document.querySelector('[data-testid^="trash-restore-"]')
      if (!b) return null
      b.scrollIntoView({ block: 'center' })
      const r = b.getBoundingClientRect()
      return { x: r.x + r.width / 2, y: r.y + r.height / 2, inView: r.top >= 0 && r.bottom <= innerHeight }
    })()`)
    if (p?.inView) return p
    await sleep(300)
  }
  return null
}
const box = await restoreBtnPoint()
check('เจอปุ่มกู้คืนบนหน้าสุดท้ายและมันอยู่ในจอ', !!box, JSON.stringify(box))
if (box) {
  for (const type of ['mousePressed', 'mouseReleased']) {
    await send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 })
  }
}
check(
  'กดกู้คืนรายการสุดท้ายบนหน้าสุดท้ายแล้วถูกดึงกลับหน้า 1',
  !!(await waitFor(`document.querySelectorAll('[data-testid^="trash-restore-"]').length === ${PAGE_SIZE} && !document.querySelector('[data-testid="trash-pager-next"]')`, 20000)),
)
const back = await evaluate(`(() => {
  const box = document.querySelector('[data-testid="trash-panel"]')
  return {
    rows: box.querySelectorAll('[data-testid^="trash-restore-"]').length,
    pager: !!document.querySelector('[data-testid="trash-pager-next"]'),
  }
})()`)
check('ไม่ค้างหน้าว่าง (เหลือ 10 แถว หน้าเดียว)', back?.rows === 10 && back?.pager === false, `${back?.rows} แถว · pager=${back?.pager}`)

await redis.del(`session:${ME}`)
redis.disconnect()
await tombs.deleteMany({ _id: { $in: ids } })
await mongo.close()
console.log(`\n── ผ่าน ${pass} · ไม่ผ่าน ${fail} ─────────────────────`)
await send('Browser.close').catch(() => {})
chrome.kill()
ws.close()
process.exit(fail === 0 ? 0 : 1)
