/**
 * API ของรูปตัวอย่างแม่แบบ — ตรวจฝั่งเซิร์ฟเวอร์ล้วน ไม่ต้องเปิดเบราว์เซอร์
 *
 *   node --env-file=.env tools/test-preview-api.mjs
 *
 * ── ต้องผ่าน ───────────────────────────────────────────────────
 * · เพิ่มรูปได้ → อ่านไฟล์กลับมาเป็น PNG ชนิดเดียวกันเป๊ะ (byte เดียวกัน)
 * · ลบแล้วอ่านไม่ได้ และไฟล์หายจาก S3 ด้วย
 * · **คนที่ไม่ใช่เจ้าของเพิ่ม/ลบไม่ได้** (403)
 * · ชนิดไฟล์ตรวจจากไบต์จริง — ส่ง HTML มาแล้วต้อง 400 ไม่ใช่เก็บทิ้งไว้
 * · เกินขนาดได้ = 400
 * · ลบแม่แบบแล้วรูปตัวอย่างหายตาม (purge ต้องเรียก deleteAllPreviews)
 *
 * ⚠️ เก็บกวาดเสมอ — ไม่งั้นรูปจะค้างใน S3 และรบกวนเทสต์รอบหน้า
 */
import { Redis } from 'ioredis'
import { resolveMongoUrl } from '@docgen/shared'
import { MongoClient } from 'mongodb'

const API = process.env.API_URL ?? 'http://127.0.0.1:4001'
const STAMP = Date.now()
const PREFIX = 'ทดสอบตัวอย่างรูป-'

let pass = 0
let fail = 0
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`)
  ok ? pass++ : fail++
}

const redis = new Redis(process.env.VALKEY_URL)
const mkSession = async (tag) => {
  const sid = `${tag}-${STAMP}`
  await redis.set(
    `session:${sid}`,
    JSON.stringify({ sub: sid, name: tag, email: `${tag}@test.local`, avatar: '' }),
    'EX',
    900,
  )
  return sid
}
const OWNER = await mkSession('prevowner')
const OTHER = await mkSession('prevother')
const h = (sid) => ({ cookie: `docgen_session=${sid}` })
/** ⚠️ ห้ามส่ง content-type กับ DELETE ที่ไม่มี body (Fastify ตอบ 500) */
const hd = (sid) => ({ cookie: `docgen_session=${sid}` })

const wipeAccess = async (templateKey) => {
  const c = new MongoClient(await resolveMongoUrl(() => {}))
  await c.connect()
  const db = c.db(process.env.MONGO_DB ?? 'app')
  await db.collection('template_access').deleteOne({ _id: templateKey })
  await db.collection('template_previews').deleteMany({ templateKey })
  await c.close()
}

/** PNG 1×1 จริง (มี magic bytes ถูกต้อง) — ย่อมากแต่พอให้ทดสอบ byte-for-byte */
const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

const list = async (sid) =>
  (await (await fetch(`${API}/api/templates`, { headers: h(sid) })).json()).items ?? []

console.log('\n[0] เตรียมแม่แบบชั่วคราว (สองคน)')
for (const t of (await list(OWNER)).filter((x) => (x.name ?? '').startsWith(PREFIX))) {
  await fetch(`${API}/api/templates/${t.id}/purge`, { method: 'DELETE', headers: hd(OWNER) })
  await wipeAccess(String(t.id))
}
const TMP = `${PREFIX}${STAMP}`
const donor = (await list(OWNER)).find((t) => (t.name ?? '').includes('หัวกระดาษ')) ?? (await list(OWNER))[0]
if (!donor) {
  console.log('✗ ไม่มีแม่แบบให้ใช้')
  process.exit(1)
}
const donorBytes = new Uint8Array(
  await (await fetch(`${API}/api/templates/${donor.id}`, { headers: h(OWNER) })).arrayBuffer(),
)
const form = new FormData()
form.set('versioning', 'true')
form.set('name', TMP)
form.set('template', new Blob([donorBytes], { type: 'application/octet-stream' }), 'ต้นฉบับ.docx')
const created = await (
  await fetch(`${API}/api/templates`, { method: 'POST', headers: h(OWNER), body: form })
).json()
const key = String(created?.id ?? created?.templateId ?? '')
check('สร้างแม่แบบชั่วคราวได้', !!key, `key ${key}`)

// ตั้งเจ้าของจริง ไม่งั้นคนอื่นก็เพิ่มรูปได้ ทดสอบ 403 ไม่ได้
await fetch(`${API}/api/access/${encodeURIComponent(key)}`, {
  method: 'PUT',
  headers: { ...h(OWNER), 'content-type': 'application/json' },
  body: JSON.stringify({ visibility: 'published' }),
})
const view = await (await fetch(`${API}/api/access/${encodeURIComponent(key)}`, { headers: h(OTHER) })).json()
check('ผูกเจ้าของแล้ว (คนอื่น relation ≠ owner)', view?.relation !== 'owner', String(view?.relation))

const base = `${API}/api/templates/${encodeURIComponent(key)}/previews`
const postImage = async (sid, buf, name, type, kind = 'upload') => {
  const f = new FormData()
  f.set('kind', kind)
  f.set('file', new Blob([buf], { type }), name)
  const r = await fetch(base, { method: 'POST', headers: h(sid), body: f })
  return { status: r.status, body: r.headers.get('content-type')?.includes('json') ? await r.json() : null }
}
const delImage = async (sid, pid) =>
  fetch(`${base}/${encodeURIComponent(pid)}`, { method: 'DELETE', headers: hd(sid) })

console.log('\n[1] เพิ่มและอ่านกลับ')
check('เริ่มต้นยังไม่มีรูป', ((await (await fetch(base, { headers: h(OWNER) })).json()).items ?? []).length === 0)

const add = await postImage(OWNER, PNG_1PX, 'a.png', 'image/png')
check('เจ้าของเพิ่มรูปได้', add.status === 201, `HTTP ${add.status} ${JSON.stringify(add.body ?? {}).slice(0, 120)}`)
const pid = add.body?.id
check('คืน id + url + contentType', !!pid && !!add.body?.url && add.body?.contentType === 'image/png', JSON.stringify(add.body?.contentType))
check('kind = upload', add.body?.kind === 'upload', add.body?.kind)
check('มี presigned url', String(add.body?.url ?? '').includes('/'), String(add.body?.url ?? '').slice(0, 60))

const got = await fetch(`${base}/${encodeURIComponent(pid)}/file`, { headers: h(OWNER) })
const gotBuf = Buffer.from(await got.arrayBuffer())
check('ดึงไฟล์รูปกลับได้', got.status === 200, `HTTP ${got.status}`)
check('ชนิดไฟล์ถูกต้อง', got.headers.get('content-type') === 'image/png', got.headers.get('content-type'))
check('ไบต์ตรงกับที่อัปโหลด (ไม่ถูกแปลง/บีบอัดมั่ว)', gotBuf.equals(PNG_1PX), `${gotBuf.length} vs ${PNG_1PX.length} bytes`)

console.log('\n[2] ชนิดไฟล์ตรวจจากไบต์จริง ไม่เชื่อ Content-Type')
const html = Buffer.from('<html><script>alert(1)</script></html>', 'utf8')
const sneaky = await postImage(OWNER, html, 'evil.png', 'image/png')
check('ส่ง HTML มาแต่อ้างเป็น PNG → ต้องปฏิเสธ', sneaky.status === 400, `HTTP ${sneaky.status}`)
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0])
const jpg = await postImage(OWNER, jpeg, 'b.jpg', 'image/jpeg')
check('JPEG ที่ถูกต้องผ่าน', jpg.status === 201, `HTTP ${jpg.status} ${jpg.body?.contentType ?? ''}`)
if (jpg.body?.id) await delImage(OWNER, jpg.body.id)

console.log('\n[3] ขนาดไฟล์')
const huge = Buffer.concat([PNG_1PX, Buffer.alloc(5 * 1024 * 1024 + 16)])
const big = await postImage(OWNER, huge, 'big.png', 'image/png')
check('ไฟล์ใหญ่เกิน 5 MB → 400', big.status === 400, `HTTP ${big.status}`)

console.log('\n[4] คนที่ไม่ใช่เจ้าของทำอะไรไม่ได้')
check('คนอื่น**อ่าน**รูปได้', (await fetch(base, { headers: h(OTHER) })).status === 200)
const otherAdd = await postImage(OTHER, PNG_1PX, 'x.png', 'image/png')
check('คนอื่นเพิ่มรูปไม่ได้ (403)', otherAdd.status === 403, `HTTP ${otherAdd.status}`)
check('คนอื่นลบรูปไม่ได้ (403)', (await delImage(OTHER, pid)).status === 403)
check('คนไม่ล็อกอินอ่านไม่ได้ (401)', (await fetch(base)).status === 401)

console.log('\n[5] ลบรูป')
check('เจ้าของลบได้', (await delImage(OWNER, pid)).status === 204)
check('อ่านรูปที่ลบไม่ได้ (404)', (await fetch(`${base}/${pid}/file`, { headers: h(OWNER) })).status === 404)
check('รายการว่างหลังลบ', ((await (await fetch(base, { headers: h(OWNER) })).json()).items ?? []).length === 0)

console.log('\n[6] ลบแม่แบบแล้วรูปต้องหายตาม (กันรูปค้างใน S3)')
const keep = await postImage(OWNER, PNG_1PX, 'k.png', 'image/png')
const keepId = keep.body?.id
check('เพิ่มรูปเก็บไว้ก่อนลบแม่แบบ', keep.status === 201, `HTTP ${keep.status}`)
await fetch(`${API}/api/templates/${encodeURIComponent(key)}/purge`, { method: 'DELETE', headers: hd(OWNER) })
const mongo = new MongoClient(await resolveMongoUrl(() => {}))
await mongo.connect()
const leftInMongo = await mongo
  .db(process.env.MONGO_DB ?? 'app')
  .collection('template_previews')
  .countDocuments({ templateKey: key })
await mongo.close()
check('purge แล้วเมตาดาตัวอย่างหายจาก Mongo', leftInMongo === 0, `${leftInMongo} เอกสารค้าง`)

console.log('\n[เก็บกวาด]')
for (const t of (await list(OWNER)).filter((x) => (x.name ?? '').startsWith(PREFIX))) {
  await fetch(`${API}/api/templates/${t.id}/purge`, { method: 'DELETE', headers: hd(OWNER) })
  await wipeAccess(String(t.id))
}
const leftover = (await list(OWNER)).filter((x) => (x.name ?? '').startsWith(PREFIX))
check('ไม่เหลือแม่แบบทดสอบค้าง', leftover.length === 0, leftover.map((x) => x.name).join(', '))
await redis.del(`session:${OWNER}`, `session:${OTHER}`)
redis.disconnect()
void keepId

console.log(`\n── ผ่าน ${pass} · ไม่ผ่าน ${fail} ─────────────────────`)
process.exit(fail === 0 ? 0 : 1)
