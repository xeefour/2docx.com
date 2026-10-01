/**
 * ทดสอบ /api/templates ทั้งหมด
 * สร้าง session ตรงใน Valkey เพื่อข้ามขั้นตอน login ในเบราว์เซอร์
 * รัน: node --env-file=.env tools/test-templates.mjs
 */
import { Redis } from 'ioredis'

const API = 'http://localhost:4001'
const COOKIE = 'docgen_session'

const redis = new Redis(process.env.VALKEY_URL)
const sid = 'test-' + Date.now().toString(36)
await redis.set(
  `session:${sid}`,
  JSON.stringify({ sub: 'test-user', name: 'ทดสอบ', email: 't@t.co', avatar: '' }),
  'EX',
  600,
)

const headers = { cookie: `${COOKIE}=${sid}` }
const ok = (s) => console.log(`\n══ ${s} ══`)
const show = (r) => `${r.status} ${(r.headers.get('content-type') ?? '').slice(0, 40)}`

try {
  ok('GET /api/templates')
  let r = await fetch(`${API}/api/templates`, { headers })
  console.log(' ', show(r), (await r.text()).slice(0, 200))

  ok('GET /api/templates/categories')
  r = await fetch(`${API}/api/templates/categories`, { headers })
  console.log(' ', show(r), (await r.text()).slice(0, 200))

  ok('GET /api/templates/tags')
  r = await fetch(`${API}/api/templates/tags`, { headers })
  console.log(' ', show(r), (await r.text()).slice(0, 200))

  const legacy = '1423f677d6a92a5e4430115828bf321e47ef7d50c9404ee499e91a7ac644d1e6'

  ok(`GET /api/templates/${legacy.slice(0, 12)}… (ดาวน์โหลดไฟล์เดิม)`)
  r = await fetch(`${API}/api/templates/${legacy}`, { headers })
  const buf = Buffer.from(await r.arrayBuffer())
  console.log(' ', show(r), `${buf.length} bytes`)
  console.log('  content-disposition:', r.headers.get('content-disposition'))
  console.log('  magic:', buf.subarray(0, 2).toString('ascii'), '(PK = docx)')

  ok('POST /api/templates — อัปโหลดไฟล์เดิมกลับเข้า DB')
  const form = new FormData()
  form.set('template', new Blob([buf], { type: 'application/octet-stream' }), 'รับเรื่อง.docx')
  form.set('versioning', 'true')
  form.set('name', 'ใบรับเรื่อง (นำเข้าจากระบบเดิม)')
  form.set('category', 'รับเรื่อง')
  form.set('tags', JSON.stringify(['ราชการ', 'นำเข้า']))
  form.set('comment', 'อัปโหลดซ้ำเพื่อให้จัดการ metadata ได้')

  r = await fetch(`${API}/api/templates`, { method: 'POST', headers, body: form })
  const up = await r.json()
  console.log(' ', show(r), JSON.stringify(up))

  ok('GET /api/templates — ต้องเห็นแม่แบบที่เพิ่งอัปโหลด')
  r = await fetch(`${API}/api/templates`, { headers })
  const list = await r.json()
  console.log(' ', show(r), `items = ${list.items?.length}, hasMore = ${list.hasMore}`)
  for (const t of list.items ?? []) {
    console.log(`   - id=${t.id} versionId=${t.versionId?.slice(0, 12)}… name="${t.name}" cat=${t.category} tags=${JSON.stringify(t.tags)}`)
  }

  const newId = up.id
  if (newId) {
    ok(`PATCH /api/templates/${newId}`)
    r = await fetch(`${API}/api/templates/${newId}`, {
      method: 'PATCH',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'เปลี่ยนชื่อแล้ว', tags: ['ทดสอบ'] }),
    })
    console.log(' ', show(r))

    ok(`DELETE /api/templates/${newId}`)
    r = await fetch(`${API}/api/templates/${newId}`, { method: 'DELETE', headers })
    console.log(' ', show(r), '(soft delete — ไฟล์ถูกลบจริงหลัง retention delay)')
  }

  ok('PATCH ด้วย body ว่าง → ต้อง 422')
  r = await fetch(`${API}/api/templates/whatever`, {
    method: 'PATCH',
    headers: { ...headers, 'content-type': 'application/json' },
    body: '{}',
  })
  console.log(' ', show(r), (await r.text()).slice(0, 150))

  ok('POST ไม่ใช่ multipart → ต้อง 400')
  r = await fetch(`${API}/api/templates`, { method: 'POST', headers })
  console.log(' ', show(r), (await r.text()).slice(0, 120))
} finally {
  await redis.del(`session:${sid}`)
  await redis.quit()
}
