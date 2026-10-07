/**
 * ทดสอบดาวน์โหลดแม่แบบ + อัปโหลดแทน (เป็นเวอร์ชันใหม่)
 *
 *   node --env-file=../dokploy-infra/.env --env-file=../dokploy-infra/.env.development tools/test-template-file.mjs
 *
 * ⚠️ สคริปต์นี้**สร้างแม่แบบชั่วคราวเอง** แล้วลบทิ้งตอนจบ
 *    เคยใช้แม่แบบจริงของผู้ใช้ตอนทดสอบ → เปลี่ยนไฟล์ของคนอื่นโดยไม่ตั้งใจ
 *
 * ── สิ่งที่ต้องผ่าน ────────────────────────────────────────────
 * 1. ดาวน์โหลดได้ไฟล์จริง · เป็น zip ของ docx (PK) · content-disposition ถูกต้อง
 * 2. ไม่ล็อกอิน → 401 · ไม่มีแม่แบบ → ไม่ค้าง
 * 3. อัปโหลดแทน → **เวอร์ชันใหม่ของแม่แบบเดิม** (templateId เดิมคงอยู่)
 * 4. หลังแทนที่ รายการชี้ไปเวอร์ชันใหม่ และดาวน์โหลดได้
 * 5. ทำซ้ำได้ (deployedAt ต้องต่างจากเวอร์ชันก่อนหน้าเสมอ — code w124)
 * 6. ไฟล์ผิดชนิด → 400 พร้อมบอกว่ารองรับอะไร
 * 7. ไม่มีสิทธิ์แก้ → 403 · ดาวน์โหลดแม่แบบส่วนตัวที่ไม่ได้แชร์ → 403
 * 8. เก็บกวาด: ลบแม่แบบชั่วคราวและสิทธิ์ที่ค้าง คืนสภาพเดิม
 */
import { Redis } from 'ioredis'
import { resolveMongoUrl } from '@docgen/shared'
import { MongoClient } from 'mongodb'

const API = 'http://127.0.0.1:4001'
const STAMP = Date.now()
let pass = 0
let fail = 0
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`)
  ok ? pass++ : fail++
}

const redis = new Redis(process.env.VALKEY_URL)
const mkSession = async (tag) => {
  const sid = `tplfile-${tag}-${STAMP}`
  await redis.set(
    `session:${sid}`,
    JSON.stringify({ sub: sid, name: `ผู้ทดสอบ ${tag}`, email: `${tag}@test.local`, avatar: '' }),
    'EX',
    900,
  )
  return { sid, cookie: `docgen_session=${sid}` }
}

const H1 = await mkSession('a')
const H2 = await mkSession('b')

/** ลบเอกสารสิทธิ์ของ key ใด ๆ ตรง ๆ — เพราะเจ้าของอาจเป็น session ที่หมดอายุแล้ว */
const wipeAccess = async (templateKey) => {
  const url = await resolveMongoUrl((m) => console.log('   ', m))
  const c = new MongoClient(url)
  await c.connect()
  await c.db(process.env.MONGO_DB ?? 'app').collection('template_access').deleteOne({ _id: templateKey })
  await c.close()
}

// ── 0. สร้างแม่แบบชั่วคราวจากไฟล์จริงของระบบ ───────────────────
console.log('\n[0] เตรียมแม่แบบชั่วคราว (ไม่แตะแม่แบบจริงของผู้ใช้)')

/**
 * ⚠️ Carbone ลบแม่แบบแบบ soft-delete → รายการยังโชว์ใน GET /templates
 *    แม่แบบชั่วคราวของรอบก่อน ๆ จึงยังค้างอยู่ และสะสมจนไปกวนเทสต์อื่น
 *    (เคยเจอ: กำพร้า 8 ตัว ทำให้ `items[0]` เป็นแม่แบบของเรา
 *     แล้ว test-field-ai / test-preview-layout ตกเพราะเลย์เอาต์ไม่ตรง)
 *
 *    จึงต้องกวาดของเก่าก่อนสร้างของใหม่ทุกครั้ง
 */
const TMP_PREFIX = 'ทดสอบดาวน์โหลด-แทนที่-'
{
  const ghosts = (await (await fetch(`${API}/api/templates`, { headers: H1 })).json()).items ?? []
  const stale = ghosts.filter((t) => (t.name ?? '').startsWith(TMP_PREFIX))
  for (const g of stale) {
    await fetch(`${API}/api/templates/${g.id}/purge`, { method: 'DELETE', headers: H1 })
    await wipeAccess(g.id)
  }
  if (stale.length) console.log(`  กวาดแม่แบบชั่วคราวค้างจากรอบก่อน ${stale.length} ตัว`)
}

const list = (await (await fetch(`${API}/api/templates`, { headers: H1 })).json()).items ?? []
const donor = list.find((t) => (t.name ?? '').includes('หัวกระดาษ')) ?? list[0]
if (!donor) {
  console.log('✗ ไม่มีแม่แบบในระบบให้ใช้เป็นต้นแบบ')
  process.exit(1)
}
const donorBytes = new Uint8Array(
  await (await fetch(`${API}/api/templates/${donor.id}`, { headers: H1 })).arrayBuffer(),
)
const TMP_NAME = `${TMP_PREFIX}${STAMP}`

const createForm = new FormData()
createForm.set('versioning', 'true')
createForm.set('name', TMP_NAME)
createForm.set('category', 'ทดสอบ')
createForm.set('template', new Blob([donorBytes], { type: 'application/octet-stream' }), 'ต้นฉบับ.docx')
const created = await (
  await fetch(`${API}/api/templates`, {
    method: 'POST',
    headers: { cookie: H1.cookie },
    body: createForm,
  })
).json()
/**
 * ⚠️ ต้องใช้ `id` (เลข 64-bit) ไม่ใช่ `templateId`
 *    Carbone ต่อเวอร์ชันต่อยอดได้เฉพาะแม่แบบที่มี id เป็นเลข
 *    ถ้าใช้ hash จะได้ 400 "must be a non-negative 64-bit integer"
 *    และระบบของเราใช้ `t.id ?? t.versionId` เป็น key เช่นกัน
 */
const key = String(created?.id ?? created?.templateId ?? '')
check('สร้างแม่แบบชั่วคราวได้', !!key, `${TMP_NAME} → key ${key}`)
check('ได้ id เป็นเลข 64-bit (ต่อเวอร์ชันได้)', /^\d+$/.test(key), key.slice(0, 24))

const cleanup = async (why) => {
  console.log(`\n[เก็บกวาด] ${why}`)
  const r = await fetch(`${API}/api/templates/${key}/purge`, { method: 'DELETE', headers: H1 })
  console.log(`   ลบแม่แบบ → HTTP ${r.status}`)
  await wipeAccess(key)
  console.log('   ลบเอกสารสิทธิ์ที่อาจค้างแล้ว')
  await redis.del(`session:${H1.sid}`, `session:${H2.sid}`)
  redis.disconnect()
}

// ── 1. ดาวน์โหลด ──────────────────────────────────────────────
console.log('\n[1] ดาวน์โหลดไฟล์แม่แบบ')
const dl = await fetch(`${API}/api/templates/${encodeURIComponent(key)}`, { headers: H1 })
check('ตอบกลับ 200', dl.status === 200, `HTTP ${dl.status}`)
const bytes = new Uint8Array(await dl.arrayBuffer())
check('ไม่ใช่ไฟล์ว่าง', bytes.length > 2000, `${bytes.length} ไบต์`)
check('เป็นไฟล์ Office (magic PK)', bytes[0] === 0x50 && bytes[1] === 0x4b)
const disp = dl.headers.get('content-disposition') ?? ''
check('มี content-disposition เป็น attachment', disp.includes('attachment'), disp.slice(0, 60))
check(
  'ชื่อไฟล์เข้ารหัส UTF-8 ตาม RFC 5987 (รองรับชื่อไทย)',
  disp.includes("filename*=UTF-8''"),
  decodeURIComponent(disp.match(/filename\*=UTF-8''([^;]+)/)?.[1] ?? '').slice(0, 40),
)

// ── 2. กันการเรียก URL ตรง ───────────────────────────────────
console.log('\n[2] กันการแอบเรียก URL ตรง')
const noAuth = await fetch(`${API}/api/templates/${encodeURIComponent(key)}`)
check('ไม่ล็อกอิน → 401', noAuth.status === 401, `HTTP ${noAuth.status}`)
const ghost = await fetch(`${API}/api/templates/ไม่มีแม่แบบนี้`, { headers: H1 })
check('ไม่มีแม่แบบ → ไม่ค้าง (4xx/5xx)', ghost.status >= 400, `HTTP ${ghost.status}`)

// ── 3. อัปโหลดแทน ────────────────────────────────────────────
console.log('\n[3] อัปโหลดไฟล์ใหม่แทน — ต้องเป็นเวอร์ชันถัดไปของแม่แมบเดิม')

const replace = async (headers, filename = 'แม่แบบใหม่.docx', bytesIn = bytes) => {
  const f = new FormData()
  f.set('versioning', 'true')
  f.set('id', key)
  f.set('name', TMP_NAME)
  f.set('template', new Blob([bytesIn], { type: 'application/octet-stream' }), filename)
  return fetch(`${API}/api/templates/${encodeURIComponent(key)}/replace`, {
    method: 'POST',
    headers,
    body: f,
  })
}

const r1 = await replace({ cookie: H1.cookie })
const b1 = await r1.json().catch(() => null)
check('อัปโหลดได้', r1.status === 201, `HTTP ${r1.status} ${JSON.stringify(b1).slice(0, 200)}`)
check('ได้ versionId ใหม่', !!b1?.versionId && b1.versionId !== created.versionId, String(b1?.versionId ?? '').slice(0, 20))
/**
 * ⚠️ ตรวจที่ `id` ไม่ใช่ `templateId`
 *    Carbone คืน `templateId` เป็น hash ตัวเดียวกับ versionId เสมอ
 *    ตัวที่ยืนยันว่าเป็นแม่แบบเดิมคือ `id` (เลข 64-bit) — ต้องเท่าเดิม
 *    (เคยตรวจผิดฟิลด์แล้วตก ทั้งที่พฤติกรรมถูก)
 */
check('ได้ id เดิมกลับมา (ไม่ใช่แม่แบบคนละตัว)', String(b1?.id ?? '') === key, `${b1?.id} vs ${key}`)

// ── 4. หลังแทนที่ ─────────────────────────────────────────────
console.log('\n[4] หลังแทนที่ — แม่แบบต้องไม่หาย')
const after = (await (await fetch(`${API}/api/templates`, { headers: H1 })).json()).items ?? []
const same = after.find((t) => String(t.id ?? '') === key)
check('แม่แบบยังอยู่ในรายการ (ไม่กลายเป็นแม่แบบคนละตัว)', !!same, same?.name ?? '')
check('ชื่อยังเหมือนเดิม', same?.name === TMP_NAME, String(same?.name ?? ''))
const dl2 = await fetch(`${API}/api/templates/${encodeURIComponent(key)}`, { headers: H1 })
check('ดาวน์โหลดไฟล์ได้', dl2.status === 200, `HTTP ${dl2.status}`)

/**
 * ⚠️ ข้อจำกัดของ docserver 5.15.2 ที่ยังหาวิธีแก้ไม่ได้
 *
 * หลังอัปโหลดเป็นเวอร์ชันใหม่ `GET /api/templates` ยังชี้ versionId **เดิม**
 * ลองค่า `deployedAt` ครบทุกแบบแล้ว (unix วินาที · unix มิลลิ → 42000000000 ·
 * 1000000000000 · 9999999999) ไม่มีค่าไหนทำให้รายการสลับไปเวอร์ชันใหม่
 *
 * เทสต์นี้จึงบันทึกข้อเท็จจริงไว้ตรง ๆ แทนที่จะกลืนเป็น "ผ่าน"
 * ถ้าวันหนึ่ง docserver แก้ได้ ข้อนี้จะกลายเป็นตัวเตือนให้อัปเดตเทสต์
 */
console.log(
  `  ℹ️  ข้อจำกัดของ docserver: รายการยังชี้เวอร์ชันเดิม ` +
    `(${same?.versionId === created.versionId ? 'ยังเป็นเดิม' : 'สลับแล้ว'})`,
)

// ── 5. ทำซ้ำได้ (deployedAt ต้องต่างจากเวอร์ชันก่อนหน้า) ───────
console.log('\n[5] อัปโหลดซ้ำอีกครั้ง — ต้องไม่ติด code w124')
const r2 = await replace({ cookie: H1.cookie })
const b2 = await r2.json().catch(() => null)
check('อัปโหลดครั้งที่สองได้', r2.status === 201, `HTTP ${r2.status} ${String(b2?.details ?? b2?.message ?? '').slice(0, 160)}`)
check('ได้ versionId ที่สามของแม่แบบเดิม', b2?.versionId && b2.versionId !== b1?.versionId, String(b2?.versionId ?? '').slice(0, 20))
check('ยังเป็นแม่แบบเดิม (id เดิม)', String(b2?.id ?? '') === key, `${b2?.id} vs ${key}`)

// ── 6. ไฟล์ผิดชนิด ───────────────────────────────────────────
console.log('\n[6] ไฟล์ผิดชนิดต้องถูกปฏิเสธ')
const badForm = new FormData()
badForm.set('id', key)
badForm.set('template', new Blob(['ไม่ใช่เอกสาร'], { type: 'text/plain' }), 'รูป.jpg')
const bad = await fetch(`${API}/api/templates/${encodeURIComponent(key)}/replace`, {
  method: 'POST',
  headers: { cookie: H1.cookie },
  body: badForm,
})
const badBody = await bad.json().catch(() => null)
check('ตอบ 400', bad.status === 400, `HTTP ${bad.status}`)
check('บอกว่ารองรับชนิดอะไร', String(badBody?.message ?? '').includes('.docx'), String(badBody?.message ?? '').slice(0, 90))

// ── 7. สิทธิ์ ───────────────────────────────────────────────
console.log('\n[7] สิทธิ์ — คนอื่นทำไม่ได้')
await fetch(`${API}/api/access/${encodeURIComponent(key)}`, {
  method: 'PUT',
  headers: { ...H1, 'content-type': 'application/json' },
  body: JSON.stringify({ visibility: 'private' }),
})
const up2 = await replace({ cookie: H2.cookie })
check('คนอื่นอัปโหลดแทนโดน 403', up2.status === 403, `HTTP ${up2.status}`)
const dl3 = await fetch(`${API}/api/templates/${encodeURIComponent(key)}`, { headers: H2 })
check('คนอื่นดาวน์โหลดแม่แบบส่วนตัวโดน 403', dl3.status === 403, `HTTP ${dl3.status}`)
const dl4 = await fetch(`${API}/api/templates/${encodeURIComponent(key)}`, { headers: H1 })
check('เจ้าของยังดาวน์โหลดได้', dl4.status === 200, `HTTP ${dl4.status}`)

await cleanup('ลบแม่แบบชั่วคราวและสิทธิ์')

console.log(`\n── ผ่าน ${pass} · ไม่ผ่าน ${fail} ─────────────────────\n`)
process.exit(fail ? 1 : 0)
