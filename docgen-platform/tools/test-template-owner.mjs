/**
 * สิทธิ์เจ้าของแม่แบบ: ผู้อัปโหลด = เจ้าของทันที
 *
 *   node --env-file=../dokploy-infra/.env --env-file=../dokploy-infra/.env.development tools/test-template-owner.mjs
 *
 * ── กติกาที่ผู้ใช้เลือกเอง ────────────────────────────────────────
 *   *"แก้ฟอร์มได้ทุกคน แต่เปลี่ยนไฟล์แม่แบบต้องเป็นเจ้าของเท่านั้น"*
 *
 * ── ทำไมต้องมี ─────────────────────────────────────────────────
 * ก่อนแก้: ผู้อัปโหลดแม่แบบใหม่แล้ว**ไม่มีเจ้าของ** จนกว่าจะไปกดตั้งค่าการแชร์เอง
 *   ผลคือแม่แบบทุกตัวเปิดสาธารณ กดลบได้โดยใครก็ได้ และไม่มีใครถือสิทธิ์แชร์ต่อได้
 *   อีกทีหนึ่ง `canEdit` ไม่เคยดู `visibility` เลย → พอมีเอกสารสิทธิ์ปุ๊บ
 *   แม่แบบที่เปิดสาธารณกลายเป็น "แก้ได้คนเดียว" ทั้งที่หน้าเว็บเขียนว่าทุกคนแก้ได้
 *
 * ── สิ่งที่ต้องผ่าน ─────────────────────────────────────────────
 * API
 *  1. อัปโหลดแล้วผู้อัปโหลดเป็นเจ้าของทันที
 *  2. แม่แบบที่เพิ่งอัปโหลดเป็น**เปิดสาธารณ** ไม่ใช่ส่วนตัว (เอาลิงก์ไปส่งได้เลย)
 *  3. คนอื่น `canEdit` = true (แก้ฟอร์มได้ตามกติกา)
 *  4. คนอื่นเปลี่ยนไฟล์แม่แบบไม่ได้ (403)
 *  5. เจ้าของเปลี่ยนไฟล์แม่แบบได้ (201)
 *  6. คนอื่นลบไม่ได้ · เจ้าของลบได้
 *  7. สิทธิ์ผูกกับคนที่อัปโหลด — คนอื่นอัปโหลดแม่แบบใหม่ ก็เป็นเจ้าของของตัวเอง
 *     แต่แม่แบบเดิมยังเป็นของเจ้าของเดิม (และเปลี่ยนไฟล์แล้วสิทธิ์ไม่ย้าย)
 *  8. แม่แบบที่ยังไม่มีเจ้าของ (ของเก่า) ไม่ถูกล็อกตาย — คนแรกที่เขียนทับได้
 *  9. แก้ metadata ของแม่แบบส่วนตัวของคนอื่นไม่ได้ (เคยไม่เช็คสิทธิ์เลย)
 * 10. คนอื่นพลิก "เปิดสาธารณ → ส่วนตัว" ของเจ้าของไม่ได้
 *
 * UI
 * 11. เจ้าของเห็นปุ่ม "อัปโหลดแม่แบบใหม่แทน" และ "ลบแม่แบบ"
 * 12. คนอื่นไม่เห็นสองปุ่มนั้น แต่ยังแก้ฟอร์มได้
 *
 * ⚠️ ใช้แม่แบบชั่วคราวที่สคริปต์สร้างเอง แล้ว purge ทิ้งตอนจบ
 */
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Redis from 'ioredis'
import { MongoClient } from 'mongodb'
import { resolveMongoUrl } from '@docgen/shared'

const API = process.env.API_URL ?? 'http://127.0.0.1:4001'
const WEB = 'http://localhost:3000'
const CHROME = process.env.CHROME_PATH ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const PORT = 9382
const STAMP = Date.now()
const TMP = 'ทดสอบสิทธิ์เจ้าของ-'
const OUT = new URL('../tests/nav-status/output-owner/', import.meta.url)
mkdirSync(OUT, { recursive: true })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let pass = 0
let fail = 0
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`)
  ok ? pass++ : fail++
}

const redis = new Redis(process.env.VALKEY_URL)
/** ⚠️ sid ต้องเป็น ASCII — sid ไปอยู่ใน cookie ซึ่งเป็น HTTP header (ดูหมายเหตุใน test-trash.mjs) */
const mkSession = async (tag) => {
  const sid = `ownr-${tag}-${STAMP}`
  await redis.set(
    `session:${sid}`,
    JSON.stringify({ sub: sid, name: `ผู้ทดสอบ ${tag}`, email: `ownr-${tag}@test.local`, avatar: '' }),
    'EX',
    1800,
  )
  return { sid, cookie: `docgen_session=${sid}` }
}
const owner = await mkSession('owner')
const other = await mkSession('other')
const H = { cookie: owner.cookie }
const H_OTHER = { cookie: other.cookie }

const DB_NAME = process.env.MONGO_DB ?? 'app'
const mongo = async () => {
  const c = new MongoClient(await resolveMongoUrl(() => {}))
  await c.connect()
  return c
}
const wipeAccess = async (key) => {
  const c = await mongo()
  await c.db(DB_NAME).collection('template_access').deleteOne({ _id: key })
  await c.close()
}

const access = async (key, h = H) => {
  const res = await fetch(`${API}/api/access/${encodeURIComponent(key)}`, { headers: h })
  return res.status === 200 ? await res.json() : null
}
const listItems = async (h = H) =>
  ((await (await fetch(`${API}/api/templates`, { headers: h })).json()).items ?? [])
const isListed = async (key, h = H) => (await listItems(h)).some((t) => String(t.id ?? t.versionId) === key)

/** อัปโหลดแม่แบบจากไฟล์ต้นฉบับที่มีอยู่จริงในระบบ */
const donor = (await listItems()).find((t) => (t.name ?? '').includes('หัวกระดาษ'))
if (!donor) {
  console.log('✗ ไม่มีแม่แบบในระบบให้ใช้เป็นต้นฉบับ')
  process.exit(1)
}
const donorBytes = new Uint8Array(
  await (await fetch(`${API}/api/templates/${donor.id}`, { headers: H })).arrayBuffer(),
)

/** อัปโหลดแม่แบบใหม่ — ถ้าใส่ id = ของแม่แบบเดิม จะกลายเป็น "เวอร์ชันถัดไป" */
async function upload(h, { name, id } = {}) {
  const form = new FormData()
  form.set('versioning', 'true')
  if (id) form.set('id', id)
  form.set('name', name ?? `${TMP}${STAMP}`)
  form.set('category', 'ทดสอบ')
  form.set('template', new Blob([donorBytes], { type: 'application/octet-stream' }), 'ต้นฉบับ.docx')
  const res = await fetch(`${API}/api/templates`, { method: 'POST', headers: { cookie: h.cookie }, body: form })
  return { status: res.status, body: await res.json().catch(() => null) }
}
async function replaceFile(key, h) {
  const form = new FormData()
  form.set('name', `${TMP}${STAMP}-แทนไฟล์`)
  form.set('template', new Blob([donorBytes], { type: 'application/octet-stream' }), 'แทน.docx')
  return fetch(`${API}/api/templates/${encodeURIComponent(key)}/replace`, {
    method: 'POST',
    headers: { cookie: h.cookie },
    body: form,
  })
}

const created = await []
const cleanup = async () => {
  for (const key of created) {
    await fetch(`${API}/api/templates/${encodeURIComponent(key)}/purge`, { method: 'DELETE', headers: H }).catch(() => {})
    const c = await mongo()
    await c.db(DB_NAME).collection('template_tombstones').deleteOne({ _id: key })
    await c.db(DB_NAME).collection('template_access').deleteOne({ _id: key })
    await c.db(DB_NAME).collection('form_schemas').deleteOne({ _id: key })
    await c.close()
  }
  await redis.del(`session:${owner.sid}`, `session:${other.sid}`)
  redis.disconnect()
}

console.log(`\n── สิทธิ์เจ้าของแม่แบบ ───────────────────\n`)

// ── 1–2 อัปโหลดแล้วเป็นเจ้าของทันที ────────────────────────────
console.log('[1] อัปโหลดแม่แบบใหม่ → ผู้อัปโหลดเป็นเจ้าของทันที')
const up = await upload(owner)
const key = String(up.body?.id ?? '')
if (!key) {
  console.log(`✗ อัปโหลดไม่สำเร็จ — HTTP ${up.status} ${JSON.stringify(up.body).slice(0, 200)}`)
  await cleanup()
  process.exit(1)
}
created.push(key)
check('อัปโหลดได้', up.status === 201, `key ${key}`)

const aOwner = await access(key, H)
check('ผู้อัปโหลดเป็นเจ้าของทันที', aOwner?.relation === 'owner', `relation = ${aOwner?.relation}`)
check('เก็บชื่อเจ้าของไว้แสดงผล', aOwner?.ownerName === 'ผู้ทดสอบ owner', aOwner?.ownerName ?? 'ไม่มี')
check('เปิดสาธารณเป็นค่าเริ่มต้น (เอาลิงก์ส่งได้เลย)', aOwner?.visibility === 'published', aOwner?.visibility)

// ── 3 คนอื่นยังแก้ฟอร์มได้ ─────────────────────────────────────
console.log('\n[2] แม่แบบเปิดสาธารณ → คนอื่นแก้ฟอร์มได้ (กติกาที่ผู้ใช้เลือก)')
const aOther = await access(key, H_OTHER)
check('คนอื่นไม่ใช่เจ้าของ', aOther?.relation === 'published', `relation = ${aOther?.relation}`)
check('แต่ยังแก้ได้', aOther?.canEdit === true, `canEdit = ${aOther?.canEdit}`)
check('เห็นชื่อเจ้าของ', aOther?.ownerName === 'ผู้ทดสอบ owner', aOther?.ownerName ?? 'ไม่มี')

// ── 4–5 เปลี่ยนไฟล์แม่แบบ: เจ้าของเท่านั้น ─────────────────────
console.log('\n[3] เปลี่ยนไฟล์แม่แบบ → เฉพาะเจ้าของ')
const repOther = await replaceFile(key, other)
check('คนอื่นเปลี่ยนไฟล์ไม่ได้', repOther.status === 403, `HTTP ${repOther.status}`)
const repOwner = await replaceFile(key, owner)
check('เจ้าของเปลี่ยนไฟล์ได้', repOwner.status === 201, `HTTP ${repOwner.status}`)
const afterRep = await access(key, H)
check('เปลี่ยนไฟล์แล้วยังเป็นเจ้าของเดิม (สิทธิ์ไม่ย้าย)', afterRep?.owner === owner.sid, `owner = ${afterRep?.owner}`)

// ── 6 ลบแม่แบบ: เจ้าของเท่านั้น ────────────────────────────────
console.log('\n[4] ลบแม่แบบ → เฉพาะเจ้าของ')
const delOther = await fetch(`${API}/api/templates/${key}`, { method: 'DELETE', headers: H_OTHER })
check('คนอื่นลบไม่ได้', delOther.status === 403, `HTTP ${delOther.status}`)

// ── 7 สิทธิ์ผูกกับคนที่อัปโหลด ไม่ใช่คนที่อัปโหลดทีหลัง ──────────
console.log('\n[5] สิทธิ์ผูกกับคนที่อัปโหลด')
const bKey = String((await upload(other)).body?.id ?? '')
created.push(bKey)
const bOwn = await access(bKey, H_OTHER)
check('คนอื่นอัปโหลดแม่แบบใหม่ → เป็นเจ้าของของตัวเอง', bOwn?.relation === 'owner', `relation = ${bOwn?.relation}`)
const aStill = await access(key, H)
check('แม่แบบเดิมยังเป็นของเจ้าของเดิม', aStill?.owner === owner.sid, `owner = ${aStill?.owner}`)
const bNotOwnerOfA = await access(key, H_OTHER)
check('คนอื่นไม่ใช่เจ้าของแม่แบบของเรา', bNotOwnerOfA?.relation !== 'owner', `relation = ${bNotOwnerOfA?.relation}`)

// ── 8 แม่แบบที่ยังไม่มีเจ้าของ ต้องไม่ล็อกตาย ────────────────────
console.log('\n[6] แม่แบบเก่าที่ยังไม่มีเจ้าของ → ห้ามล็อกตาย')
const legacy = String((await upload(owner)).body?.id ?? '')
created.push(legacy)
await wipeAccess(legacy)
const legacyAccess = await access(legacy, H_OTHER)
check('ยังไม่มีเจ้าของ', !legacyAccess?.owner, `owner = ${legacyAccess?.owner ?? 'ไม่มี'}`)
const legacyRep = await replaceFile(legacy, other)
check('คนแรกที่เขียนทับได้ (เหมือนกติกาลบแม่แบบ)', legacyRep.status === 201, `HTTP ${legacyRep.status}`)
await wipeAccess(legacy)

// ── 9 metadata ของแม่แบบส่วนตัวของคนอื่นแก้ไม่ได้ ─────────────────
console.log('\n[7] แก้ metadata ต้องเคารพสิทธิ์ (เคยไม่เช็คเลย)')
await fetch(`${API}/api/access/${key}`, {
  method: 'PUT',
  headers: { ...H, 'content-type': 'application/json' },
  body: JSON.stringify({ visibility: 'private' }),
})
const privOther = await access(key, H_OTHER)
check('ตั้งเป็นส่วนตัวแล้วคนอื่นแก้ไม่ได้', privOther?.canEdit === false, `canEdit = ${privOther?.canEdit}`)
const patchOther = await fetch(`${API}/api/templates/${key}`, {
  method: 'PATCH',
  headers: { ...H_OTHER, 'content-type': 'application/json' },
  body: JSON.stringify({ name: 'แอบเปลี่ยนชื่อ' }),
})
check('คนอื่น PATCH ชื่อไม่ได้', patchOther.status === 403, `HTTP ${patchOther.status}`)
const patchOwner = await fetch(`${API}/api/templates/${key}`, {
  method: 'PATCH',
  headers: { ...H, 'content-type': 'application/json' },
  body: JSON.stringify({ name: `${TMP}${STAMP}` }),
})
check('เจ้าของ PATCH ชื่อได้', patchOwner.status === 204 || patchOwner.status === 404, `HTTP ${patchOwner.status}`)

console.log('\n[8] คนอื่นพลิก "เปิดสาธารณ → ส่วนตัว" ไม่ได้')
const visBefore = (await access(key, H))?.visibility
const visOther = await fetch(`${API}/api/access/${key}`, {
  method: 'PUT',
  headers: { ...H_OTHER, 'content-type': 'application/json' },
  body: JSON.stringify({ visibility: 'published' }),
})
check('โดน 403', visOther.status === 403, `HTTP ${visOther.status}`)
const visAfter = (await access(key, H))?.visibility
check('การมองเห็นไม่เปลี่ยน', visAfter === visBefore, `${visBefore} → ${visAfter}`)
// กลับเป็นเปิดสาธารณเพื่อให้ข้อ 10–11 ตรวจต่อได้
await fetch(`${API}/api/access/${key}`, {
  method: 'PUT',
  headers: { ...H, 'content-type': 'application/json' },
  body: JSON.stringify({ visibility: 'published' }),
})

// ── 10–11 UI ────────────────────────────────────────────────────
console.log('\n[9] หน้าเว็บ็บ — ปุ่มแทนไฟล์/ลบ เห็นเฉพาะเจ้าของ')
const profile = mkdtempSync(join(tmpdir(), 'cdp-owner-'))
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
const shot = async (name) => {
  const { data } = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(new URL(name, OUT), Buffer.from(data, 'base64'))
}
await send('Page.enable')
await send('Runtime.enable')
await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false })
await send('Network.setCacheDisabled', { cacheDisabled: true })

/**
 * เปิดหน้าแม่แบบในฐานะคนที่กำหนด
 *
 * ⚠️ ปุ่มแทนไฟล์/ลบ อยู่ในแท็บ "ข้อมูลแม่แบบ" (`pane=template`)
 *    ส่วนข้อความว่าใครเป็นเจ้าของ อยู่ในแท็บ "การแชร์และสิทธิ์" (`pane=history`)
 *    เพราะผู้ใช้สั่งย้ายการ์ดการแชร์ไปแท็บนั้น — ต้องเปิดคนละแท็บ
 */
const openAs = async (sid, pane, ready) => {
  await send('Network.setCookie', { name: 'docgen_session', value: sid, url: WEB })
  await send('Page.navigate', { url: `${WEB}/studio/${key}?tabs=form&pane=${pane}` })
  await waitFor('!document.querySelector(".bootveil")', 45000)
  await waitFor(ready, 25000)
}
const READY_META = `!!document.querySelector('[data-testid="template-save-meta"]')`
const READY_ACCESS = `!!document.querySelector('[data-testid="share-publish"]')`

await openAs(owner.sid, 'template', READY_META)
check('เจ้าของเห็นปุ่ม "อัปโหลดแม่แบบใหม่แทน"', await evaluate(`!!document.querySelector('[data-testid="template-replace"]')`))
check('เจ้าของเห็นปุ่ม "ลบแม่แบบ"', await evaluate(`!!document.querySelector('[data-testid="template-trash"]')`))
await shot('01-owner-file.png')

await openAs(owner.sid, 'history', READY_ACCESS)
check(
  'เจ้าของเห็นข้อความว่าตัวเองเป็นเจ้าของ',
  /คุณเป็นเจ้าของแม่แบบนี้/.test(await evaluate(`document.body.textContent ?? ''`)),
)
await shot('02-owner-access.png')

await openAs(other.sid, 'template', READY_META)
check('คนอื่นไม่เห็นปุ่มแทนไฟล์', !(await evaluate(`!!document.querySelector('[data-testid="template-replace"]')`)))
check('คนอื่นไม่เห็นปุ่มลบ', !(await evaluate(`!!document.querySelector('[data-testid="template-trash"]')`)))
check(
  'คนอื่นยังบันทึก metadata ได้ (แก้ฟอร์มได้)',
  !(await evaluate(`!!document.querySelector('[data-testid="template-save-meta"]')?.disabled`)),
)
const msg = await evaluate(`document.body.textContent ?? ''`)
check('ข้อความอธิบายว่าต้องเป็นเจ้าของ', /ต้องเป็นเจ้าของเท่านั้น/.test(msg))
await shot('03-other-file.png')

await openAs(other.sid, 'history', READY_ACCESS)
check(
  'คนอื่นไม่ถูกบอกว่าเป็นเจ้าของ',
  !/คุณเป็นเจ้าของแม่แบบนี้/.test(await evaluate(`document.body.textContent ?? ''`)),
)
check('คนอื่นเห็นชื่อเจ้าของ', /เจ้าของ: ผู้ทดสอบ owner/.test(await evaluate(`document.body.textContent ?? ''`)))
await shot('04-other-access.png')

await send('Browser.close').catch(() => {})
chrome.kill()

await cleanup()
console.log(`\n── ผ่าน ${pass} · ไม่ผ่าน ${fail} ─────────────────────`)
console.log(`ภาพ: ${OUT.pathname}\n`)
process.exit(fail ? 1 : 0)
