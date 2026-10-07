/**
 * ถังขยะแม่แบบ: ลบ → รอ 14 วัน → กู้คืน
 *
 *   node --env-file=../dokploy-infra/.env --env-file=../dokploy-infra/.env.development tools/test-trash.mjs
 *
 * ── ทำไมต้องมี ─────────────────────────────────────────────────
 * ผู้ใช้สั่ง: *"เพิ่ม การลบแม่แบบ ถ้าผู้ใช้ลบไปแล้ว ให้รอก่อน 14 วัน ค่อยลบ
 *   แจ้งเตือนผู้ใช้ว่าจะลบแม่แบบนี้ ใครจะใช้ให้ clone ไปแทน
 *   ทำให้ restore ภายหลังได้"*
 *
 * ── สิ่งที่ต้องผ่าน ─────────────────────────────────────────────
 * API
 *  1. ลบแล้ว**หายจากรายการทันที** (เคยเป็นบั๊ก — กดลบแล้วยังโชว์ในรายการ)
 *  2. กรองออกแม้ผู้ใช้ค้นหาชื่อที่ตรงกัน
 *  3. tombstone มี `daysLeft` ≈ 14
 *  4. กู้คืนแล้วกลับมาในรายการ และ tombstone หาย
 *  5. คนอื่นลบไม่ได้ (403)
 *  6. ตัวกวาดลบจริงเมื่อครบกำหนด (ทดสอบด้วย tombstone ที่ `purgeAt` อยู่ในอดีต)
 *  7. purge เก็บสิทธิ์และฟอร์มไปด้วย (ไม่ใช่แค่ตัวไฟล์)
 *
 * UI
 *  8. หน้ารายการมีการ์ด "ถังขยะ" พร้อมปุ่มกู้คืน
 *  9. หน้าแม่แบบที่ถูกลบมีป้ายเตือน + ปุ่ม clone (คนอื่นเห็นด้วย)
 * 10. กู้คืนจากการ์ดถังขยะแล้วแม่แบบกลับมาในรายการ
 *
 * ⚠️ ใช้**แม่แบบชั่วคราว**ที่สคริปต์สร้างเอง แล้ว purge ทิ้งตอนจบ
 *    (ถ้าใช้แม่แบบจริง ผู้ใช้จะเห็นแม่แบบหายไปเงียบ ๆ)
 */
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Redis } from 'ioredis'
import { resolveMongoUrl } from '@docgen/shared'
import { MongoClient } from 'mongodb'

const API = process.env.API_URL ?? 'http://127.0.0.1:4001'
const WEB = 'http://localhost:3000'
const CHROME = process.env.CHROME_PATH ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const PORT = 9380
const STAMP = Date.now()
const TMP_PREFIX = 'ทดสอบถังขยะ-'
const OUT = new URL('../tests/nav-status/output-trash/', import.meta.url)
mkdirSync(OUT, { recursive: true })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
/** 14 วันตามที่ผู้ใช้สั่ง */
const RETENTION_DAYS = 14

let pass = 0
let fail = 0
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`)
  ok ? pass++ : fail++
}

const redis = new Redis(process.env.VALKEY_URL)
/**
 * ⚠️ sid ต้องเป็น ASCII เท่านั้น
 *    sid ไปอยู่ใน cookie ซึ่งเป็น HTTP header → ถ้ามีอักษรไทย
 *    undici จะโยน *"Cannot convert argument to a ByteString"* ตอน fetch
 *    (เคยเจจริงตอนตั้งชื่อ session ว่า "trash-เจ้าของ")
 *    ชื่อที่แสดงผลต่อผู้ใช้เก็บแยกใน `name` ซึ่งไม่ได้ไปใน header
 */
const mkSession = async (tag) => {
  const sid = `trash-${tag}-${STAMP}`
  await redis.set(
    `session:${sid}`,
    JSON.stringify({ sub: sid, name: `ผู้ทดสอบ ${tag}`, email: `trash-${tag}@test.local`, avatar: '' }),
    'EX',
    1800,
  )
  return { sid, cookie: `docgen_session=${sid}` }
}
const owner = await mkSession('owner')
const other = await mkSession('other')
const H = { cookie: owner.cookie }
const H_OTHER = { cookie: other.cookie }

const mongo = async () => {
  const c = new MongoClient(await resolveMongoUrl(() => {}))
  await c.connect()
  return c
}
const wipeAccess = async (key) => {
  const c = await mongo()
  await c.db(process.env.MONGO_DB ?? 'app').collection('template_access').deleteOne({ _id: key })
  await c.close()
}
const listKeys = async (h = H) => {
  const j = await (await fetch(`${API}/api/templates`, { headers: h })).json()
  return (j.items ?? []).map((t) => String(t.id ?? t.versionId))
}
const isListed = async (key, h = H) => (await listKeys(h)).includes(key)

// ── 0. เตรียมแม่แบบชั่วคราว ─────────────────────────────────────
console.log('\n[0] เตรียมแม่แบบชั่วคราว')
for (const k of await listKeys()) {
  if (k) {
    const t = (await (await fetch(`${API}/api/templates`, { headers: H })).json()).items.find(
      (x) => String(x.id ?? x.versionId) === k,
    )
    if ((t?.name ?? '').startsWith(TMP_PREFIX)) {
      await fetch(`${API}/api/templates/${k}/purge`, { method: 'DELETE', headers: H })
      await wipeAccess(k)
    }
  }
}
const donor = (await (await fetch(`${API}/api/templates`, { headers: H })).json()).items.find((t) =>
  (t.name ?? '').includes('หัวกระดาษ'),
)
if (!donor) {
  console.log('✗ ไม่มีแม่แบบในระบบให้ใช้เป็นต้นฉบับ')
  process.exit(1)
}
const bytes = new Uint8Array(
  await (await fetch(`${API}/api/templates/${donor.id}`, { headers: H })).arrayBuffer(),
)
const form = new FormData()
form.set('versioning', 'true')
form.set('name', `${TMP_PREFIX}${STAMP}`)
form.set('category', 'ทดสอบ')
form.set('template', new Blob([bytes], { type: 'application/octet-stream' }), 'ต้นฉบับ.docx')
const created = await (
  await fetch(`${API}/api/templates`, { method: 'POST', headers: { cookie: owner.cookie }, body: form })
).json()
const key = String(created?.id ?? created?.templateId ?? '')
check('สร้างแม่แบบชั่วคราวได้', !!key, `key ${key}`)

const cleanup = async (why) => {
  console.log(`\n[เก็บกวาด] ${why}`)
  await fetch(`${API}/api/templates/${key}/purge`, { method: 'DELETE', headers: H }).catch(() => {})
  const c = await mongo()
  await c
    .db(process.env.MONGO_DB ?? 'app')
    .collection('template_tombstones')
    .deleteOne({ _id: key })
  await c
    .db(process.env.MONGO_DB ?? 'app')
    .collection('template_access')
    .deleteOne({ _id: key })
  await c.close()
  const still = await isListed(key)
  check('ไม่มีแม่แบบชั่วคราวค้าง', !still, still ? 'ยังอยู่ในรายการ!' : '')
  await redis.del(`session:${owner.sid}`, `session:${other.sid}`)
  redis.disconnect()
}

// ── 1. ลบ → หายจากรายการ ────────────────────────────────────────
console.log('\n[1] ลบแม่แบบ → ต้องหายจากรายการทันที')
check('ก่อนลบ มีในรายการ', await isListed(key))
// ให้คนนี้เป็นเจ้าของก่อน ไม่งั้นถ้าแม่แบบยังไม่มีเจ้าของ
//   กติกา "คนแรกที่กดลบ = เจ้าของ" จะทำให้คนอื่นลบไม่ได้ในข้อ 5
await fetch(`${API}/api/access/${key}`, {
  method: 'PUT',
  headers: { ...H, 'content-type': 'application/json' },
  body: JSON.stringify({ visibility: 'published' }),
})

const del = await fetch(`${API}/api/templates/${key}`, { method: 'DELETE', headers: H })
const tomb = await del.json()
check('ลบได้', del.status === 200, `HTTP ${del.status}`)
check('คืนข้อมูลถังขยะ', tomb?.templateKey === key, tomb?.name ?? '')
check(
  `ระบุว่ารอ ${RETENTION_DAYS} วัน`,
  tomb?.daysLeft === RETENTION_DAYS,
  `daysLeft = ${tomb?.daysLeft}`,
)
check('บอกวันที่จะลบถาวรได้', !!tomb?.purgeAt && !Number.isNaN(Date.parse(tomb.purgeAt)), tomb?.purgeAt ?? '')
check('หายจากรายการทันทีที่กดลบ', !(await isListed(key)))
check('คนอื่นก็มองไม่เห็นในรายการ', !(await isListed(key, H_OTHER)))

// ── 2. กรองแม้ตอนค้นหา ───────────────────────────────────────────
console.log('\n[2] การค้นหาต้องไม่เจอแม่แบบที่อยู่ถังขยะ')
const search = await (
  await fetch(`${API}/api/templates?search=${encodeURIComponent(TMP_PREFIX)}`, { headers: H })
).json()
const foundInSearch = (search.items ?? []).some((t) => String(t.id ?? t.versionId) === key)
check('ค้นหาชื่อแล้วไม่เจอ', !foundInSearch, `เจอ ${(search.items ?? []).length} ราย`)

// ── 3. ป้ายเตือนสำหรับคนที่ใช้อยู่ ────────────────────────────────
console.log('\n[3] คนที่ไม่ใช่คนกดลบ ต้องอ่าน tombstone ได้ (เพื่อโชว์ป้ายเตือน)')
const tOther = await fetch(`${API}/api/templates/${key}/trash`, { headers: H_OTHER })
const tBody = await tOther.json()
check('คนอื่นอ่าน tombstone ได้ (ไม่เช็คสิทธิ์)', tOther.status === 200, `HTTP ${tOther.status}`)
check('คนอื่นกู้คืนไม่ได้ (canRestore = false)', tBody?.item?.canRestore === false)
check('เจ้าของกู้คืนได้ (canRestore = true)', (await (await fetch(`${API}/api/templates/${key}/trash`, { headers: H })).json())?.item?.canRestore === true)

// ── 4. คนอื่นลบไม่ได้ ───────────────────────────────────────────
console.log('\n[4] คนอื่นลบแม่แบบของคนอื่นไม่ได้')
{
  const k2 = await (async () => {
    const f2 = new FormData()
    f2.set('versioning', 'true')
    f2.set('name', `${TMP_PREFIX}2-${STAMP}`)
    f2.set('template', new Blob([bytes], { type: 'application/octet-stream' }), 'ต้นฉบับ.docx')
    const c2 = await (
      await fetch(`${API}/api/templates`, { method: 'POST', headers: { cookie: owner.cookie }, body: f2 })
    ).json()
    return String(c2?.id ?? c2?.templateId ?? '')
  })()
  await fetch(`${API}/api/access/${k2}`, {
    method: 'PUT',
    headers: { ...H, 'content-type': 'application/json' },
    body: JSON.stringify({ visibility: 'published' }),
  })
  const r = await fetch(`${API}/api/templates/${k2}`, { method: 'DELETE', headers: H_OTHER })
  check('คนอื่นลบไม่ได้ → 403', r.status === 403, `HTTP ${r.status}`)
  await fetch(`${API}/api/templates/${k2}/purge`, { method: 'DELETE', headers: H })
  await wipeAccess(k2)
}

// ── 5. กู้คืน ───────────────────────────────────────────────────
console.log('\n[5] กู้คืนแม่แบบ')
const restored = await fetch(`${API}/api/templates/${key}/restore`, { method: 'POST', headers: H })
check('กู้คืนได้', restored.status === 204, `HTTP ${restored.status}`)
check('กลับมาในรายการ', await isListed(key))
const trashAfter = await (await fetch(`${API}/api/templates/trash`, { headers: H })).json()
check('ไม่มีในถังขยะอีก', !(trashAfter.items ?? []).some((t) => t.templateKey === key))

// ── 6. ตัวกวาด: ครบ 14 วันแล้วลบจริง ──────────────────────────────
console.log('\n[6] ตัวกวาด — ครบกำหนดแล้วต้องลบไฟล์จริง')
await fetch(`${API}/api/templates/${key}`, { method: 'DELETE', headers: H })
{
  /**
   * ⚠️ ทดสอบตัวกวาดโดย**ย้อนเวลา** แทนที่จะรอ 14 วันจริง
   *   เขียน `purgeAt` ให้อยู่ในอดีต แล้วเรียก `sweepTombstones` จากโค้ดที่ compile แล้ว
   *   เพราะตัวกวาดใน `app` ทำงานทุก 15 นาที — รอจริงไม่ได้
   */
  const c = await mongo()
  await c
    .db(process.env.MONGO_DB ?? 'app')
    .collection('template_tombstones')
    .updateOne({ _id: key }, { $set: { purgeAt: new Date(Date.now() - 1000) } })
  // ใส่สิทธิ์+ฟอร์มปลอม เพื่อพิสูจน์ว่าตัวกวาดเก็บข้อมูลเหล่านี้ไปด้วย
  // ⚠️ ต้องใช้ upsert ไม่ใช่ insertOne
  //    `template_access` มีเอกสารอยู่แล้วจากข้อ 1 (เราเรียก setVisibility)
  //    insertOne จะได้ E11000 duplicate key แล้วทดสอบล้มก่อนจะได้พิสูจน์อะไร
  await c
    .db(process.env.MONGO_DB ?? 'app')
    .collection('template_access')
    .updateOne({ _id: key }, { $set: { visibility: 'published' } }, { upsert: true })
  await c
    .db(process.env.MONGO_DB ?? 'app')
    .collection('form_schemas')
    .updateOne({ _id: key }, { $set: { fields: [] } }, { upsert: true })
  await c.close()

  const { sweepTombstones } = await import('../apps/api/dist/modules/templates/trash.js')
  // เรียกผ่าน app stub — ตัวกวาดใช้แค่ `app.mongo` กับ `app.log`
  const app = {
    mongo: (await mongo()).db(process.env.MONGO_DB ?? 'app'),
    log: { info: () => {}, warn: () => {}, error: (o) => console.log('   (log)', o?.templateKey ?? '') },
  }
  const purged = await sweepTombstones(app)
  /**
   * ⚠️ ตัวกวาดลบ**ทุกตัวที่ครบกำหนด** ไม่ใช่แค่ตัวของเรา
   *   ถ้ามีของค้างจากรอบที่ตกไว้ มันจะถูกลบไปด้วย
   *   ดังนั้นต้องเช็ค `>= 1` แล้วพิสูจน์ด้วยข้อถัดไปว่าแม่แบบของเราหายจริง
   *   (เคยเขียนเป็น `=== 1` แล้วตกเพราะของค้างจากรอบก่อน)
   */
  check('ตัวกวาดทำงานได้', purged >= 1, `ลบ ${purged} ราย (อาจรวมของค้างจากรอบก่อนด้วย)`)
  check('หายจากรายการจริงแล้ว (ไฟล์ถูกลบที่ Carbone)', !(await isListed(key)))
  const c2 = await mongo()
  const db2 = c2.db(process.env.MONGO_DB ?? 'app')
  check('tombstone ถูกเก็บแล้ว', (await db2.collection('template_tombstones').countDocuments({ _id: key })) === 0)
  check('สิทธิ์ถูกเก็บด้วย (ไม่ใช่แค่ไฟล์)', (await db2.collection('template_access').countDocuments({ _id: key })) === 0)
  check('ฟอร์มถูกเก็บด้วย', (await db2.collection('form_schemas').countDocuments({ _id: key })) === 0)
  await c2.close()
}

// ── 7. UI ────────────────────────────────────────────────────────
console.log('\n[7] หน้าเว็บ — การ์ดถังขยะและป้ายเตือน')
const profile = mkdtempSync(join(tmpdir(), 'cdp-trash-'))
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
const waitFor = async (expr, ms = 20000) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    try {
      if (await evaluate(expr)) return true
    } catch {}
    await sleep(250)
  }
  return false
}
const shot = async (name) => {
  const { data } = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(new URL(name, OUT), Buffer.from(data, 'base64'))
}

await send('Page.enable')
await send('Runtime.enable')
await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false })
await send('Network.setCacheDisabled', { cacheDisabled: true })

// ลบอีกครั้งเพื่อทดสอบ UI
/**
 * ⚠️ ต้องสร้างแม่แบบ**ใหม่** ไม่ใช่ใช้ตัวเดิม
 *   ข้อ [6] เรียกตัวกวาดจริงแล้ว → ไฟล์ถูกลบที่ Carbone และ tombstone หาย
 *   ถ้าเอาตัวเดิมมาลบซ้ำจะไม่มีอะไรให้ลบ → ป้ายเตือนไม่มีทางโชว์
 *   (เคยตกตรงนี้ — เขียนเทสต์ผิดลำดับ แล้วไปตีความว่าเป็นบั๊กของ UI)
 */
const uiForm = new FormData()
uiForm.set('versioning', 'true')
uiForm.set('name', `${TMP_PREFIX}ui-${STAMP}`)
uiForm.set('category', 'ทดสอบ')
uiForm.set('template', new Blob([bytes], { type: 'application/octet-stream' }), 'ต้นฉบับ.docx')
const uiCreated = await (
  await fetch(`${API}/api/templates`, { method: 'POST', headers: { cookie: owner.cookie }, body: uiForm })
).json()
const uiKey = String(uiCreated?.id ?? uiCreated?.templateId ?? '')
check('สร้างแม่แบบสำหรับทดสอบ UI ได้', !!uiKey, `key ${uiKey}`)
await fetch(`${API}/api/access/${uiKey}`, {
  method: 'PUT',
  headers: { ...H, 'content-type': 'application/json' },
  body: JSON.stringify({ visibility: 'published' }),
})
const uiDel = await fetch(`${API}/api/templates/${uiKey}`, { method: 'DELETE', headers: H })
check('ลบเพื่อทดสอบ UI ได้', uiDel.status === 200, `HTTP ${uiDel.status}`)

await send('Network.setCookie', { name: 'docgen_session', value: owner.sid, url: WEB })
await send('Page.navigate', { url: `${WEB}/studio` })
await waitFor('!document.querySelector(".bootveil")', 45000)
await sleep(1200)
const panel = await waitFor("!!document.querySelector('[data-testid=\"trash-panel\"]')", 20000)
check('หน้ารายการมีการ์ดถังขยะ', panel)
check('การ์ดแสดงจำนวนวันคงเหลือ', /เหลืออีก\s*\d+\s*วัน/.test(await evaluate(`document.querySelector('[data-testid="trash-panel"]')?.textContent ?? ''`)))
await shot('01-trash-panel.png')

/**
 * ⚠️ ต้องสลับ cookie เป็นคนอื่นก่อนเปิดหน้าแม่แบบ
 *    เพราะปุ่ม clone อยู่ฝั่งคนอื่น — ถ้าเป็นเจ้าของจะเห็นปุ่มกู้คืนแทน
 *    และเทสต์นี้จะผ่านทั้งที่คนใช้จริงไม่มีทางกู้คืน
 */
await send('Network.setCookie', { name: 'docgen_session', value: other.sid, url: WEB })
await send('Page.navigate', { url: `${WEB}/studio/${uiKey}?tabs=form&pane=template` })
await waitFor('!document.querySelector(".bootveil")', 45000)
const banner = await waitFor("!!document.querySelector('[data-testid=\"trash-banner\"]')", 25000)
check('คนอื่นเห็นป้ายเตือนถังขยะ', banner)
check('ป้ายเตือนบอกจำนวนวันที่เหลือ', /\d+\s*วัน/.test(await evaluate(`document.querySelector('[data-testid="trash-banner"]')?.textContent ?? ''`)))
check(
  'คนอื่นเห็นปุ่ม clone (ไม่ใช่ปุ่มกู้คืน)',
  (await evaluate("!!document.querySelector('[data-testid=\"trash-clone\"]')")) &&
    !(await evaluate("!!document.querySelector('[data-testid=\"trash-restore\"]')")),
)
await shot('02-banner-other.png')

// กลับเป็นเจ้าของ → ต้องเห็นปุ่มกู้คืน และกู้คืนจากป้ายเตือน
await send('Network.setCookie', { name: 'docgen_session', value: owner.sid, url: WEB })
await send('Page.navigate', { url: `${WEB}/studio/${uiKey}?tabs=form&pane=template` })
await waitFor('!document.querySelector(".bootveil")', 45000)
await waitFor("!!document.querySelector('[data-testid=\"trash-restore\"]')", 25000)
check('เจ้าของเห็นปุ่มกู้คืน', await evaluate("!!document.querySelector('[data-testid=\"trash-restore\"]')"))
const clicked = await evaluate(`(() => {
  const b = document.querySelector('[data-testid="trash-restore"]')
  if (!b) return { ok: false }
  b.scrollIntoView({ block: 'center' })
  const r = b.getBoundingClientRect()
  const x = r.x + r.width / 2, y = r.y + r.height / 2
  const hit = document.elementFromPoint(x, y)
  return { ok: !!hit && (b.contains(hit) || hit === b), x, y }
})()`)
check('กดปุ่มกู้คืนได้ (ไม่มีอะไรบัง)', !!clicked?.ok)
if (clicked?.ok) {
  for (const type of ['mousePressed', 'mouseReleased'])
    await send('Input.dispatchMouseEvent', { type, x: clicked.x, y: clicked.y, button: 'left', clickCount: 1 })
  await sleep(2000)
}
check('กู้คืนแล้วป้ายเตือนหาย', !(await evaluate("!!document.querySelector('[data-testid=\"trash-banner\"]')")))
check('กลับมาในรายการ', await isListed(uiKey))
await shot('03-restored.png')

await send('Browser.close').catch(() => {})
chrome.kill()
await fetch(`${API}/api/templates/${uiKey}/purge`, { method: 'DELETE', headers: H }).catch(() => {})
  await cleanup('purge แม่แบบชั่วคราว')
console.log(`\n── ผ่าน ${pass} · ไม่ผ่าน ${fail} ─────────────────────`)
console.log(`ภาพ: ${OUT.pathname}\n`)
process.exit(fail ? 1 : 0)
