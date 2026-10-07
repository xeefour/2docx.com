/**
 * เรนเดอร์แม่แบบที่นำเข้ามา ผ่านสายงานจริงทั้งหมด
 *   API → NATS → worker → docserver → RustFS → presigned URL
 *
 * ใช้ยืนยันว่าแม่แบบใน /api/templates ไม่ได้แค่ "ขึ้นชื่อ" แต่เอนเดอร์ได้จริง
 *
 *   node --env-file=../dokploy-infra/.env --env-file=../dokploy-infra/.env.development tools/render-check.mjs
 */
import { Redis } from 'ioredis'

const API = process.env.PUBLIC_API_URL ?? 'http://127.0.0.1:4001'
const COOKIE = 'docgen_session'

const redis = new Redis(process.env.VALKEY_URL)
const sid = `render-check-${Date.now()}`
await redis.set(`session:${sid}`, JSON.stringify({ sub: 'render-check', name: 'render-check' }), 'EX', 600)
const headers = { cookie: `${COOKIE}=${sid}` }
const json = (h = {}) => ({ ...headers, 'content-type': 'application/json', ...h })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** แม่แบบที่จะเรนเดอร์ + ข้อมูลตัวอย่างที่ตรงกับแท็กในไฟล์จริง */
const CASES = [
  {
    match: 'มีเลขที่หนังสือ',
    data: {
      ที่: 'ที่ ชม.0511.01/1234',
      เลขที่หนังสือ: '1234',
      เรื่อง: 'ขออนุญาตไปราชการ',
      อำเภอ: 'เนินมะปราง',
      ชื่อเจ้าหน้าที่: 'สมชาย ใจดี',
      ตำแหน่ง: 'นายอำเภอ',
      เนื้อหา: 'ด้วยข้าพเจ้า นายสมชาย ใจดี ตำแหน่งนายอำเภอเนินมะปราง เห็นว่าควรดำเนินการ',
    },
  },
  {
    match: 'อัยการ',
    data: {
      เรื่อง: 'ส่งสำเนาคำร้องให้พนักงานอัยการ',
      เรียน: 'พนักงานอัยการจังหวัดนครราชสีมา',
      ชื่อ: 'ผู้ร้อง',
      ที่อยู่: '123 หมู่ 4 ต.บ้านโคก อ.เมือง จ.นครราชสีมา',
      เนื้อหา: 'ตามคำร้องเมื่อวันที่ 1 กันยายน 2569',
    },
  },
]

const list = await (await fetch(`${API}/api/templates`, { headers })).json()
const templates = list.items
console.log(`พบแม่แบบ ${templates.length} รายการ\n`)

let pass = 0
let fail = 0

for (const c of CASES) {
  const tpl = templates.find((t) => t.name.includes(c.match))
  if (!tpl) {
    console.log(`⏭  ข้าม "${c.match}" — ไม่เจอในรายการ`)
    continue
  }

  const tag = `[${tpl.category}] ${tpl.name}`
  console.log(`▶ ${tag}`)
  console.log(`  versionId = ${tpl.versionId}`)

  const up = await fetch(`${API}/api/documents`, {
    method: 'POST',
    headers: json(),
    body: JSON.stringify({
      templateId: tpl.versionId,
      data: c.data,
      outputFormat: 'pdf',
      label: `render-check: ${tpl.name}`,
    }),
  })
  const created = await up.json()
  if (!up.ok) {
    console.log(`  ❌ สร้างงานไม่สำเร็จ ${up.status} ${JSON.stringify(created).slice(0, 200)}\n`)
    fail++
    continue
  }
  const id = created.documentId ?? created.id ?? created._id
  console.log(`  สร้างงาน ${id} → ${created.status}`)

  // รอจนเสร็จ
  let doc = null
  for (let i = 0; i < 40; i++) {
    await sleep(1000)
    const r = await fetch(`${API}/api/documents/${id}`, { headers })
    doc = await r.json()
    const doc2 = doc.document ?? doc
    if (['done', 'failed'].includes(doc2.status)) break
  }

  const final = doc.document ?? doc
  if (final.status !== 'done') {
    console.log(`  ❌ สถานะสุดท้าย = ${final.status} ${final.error ?? ''}\n`)
    fail++
    await fetch(`${API}/api/documents/${id}`, { method: 'DELETE', headers })
    continue
  }

  // ดาวน์โหลดจริงจาก presigned URL
  const dl = await fetch(final.downloadUrl)
  if (!dl.ok) {
    console.log(`  ❌ ดาวน์โหลดไม่สำเร็จ ${dl.status}\n`)
    fail++
    await fetch(`${API}/api/documents/${id}`, { method: 'DELETE', headers })
    continue
  }
  const buf = Buffer.from(await dl.arrayBuffer())
  const magic = buf.subarray(0, 5).toString('latin1')
  const okPdf = magic === '%PDF-'
  console.log(`  ✅ ${buf.length.toLocaleString()} bytes · magic "${magic}" ${okPdf ? '✓ PDF ถูกต้อง' : '✗ ไม่ใช่ PDF'}`)
  console.log(`     key = ${final.storageKey}`)
  pass += okPdf ? 1 : 0
  if (!okPdf) fail++

  // เก็บกวาด
  const del = await fetch(`${API}/api/documents/${id}`, { method: 'DELETE', headers })
  console.log(`     ลบงานแล้ว: ${del.status}\n`)
}

console.log(`สรุป: ผ่าน ${pass} · ไม่ผ่าน ${fail}`)
await redis.del(`session:${sid}`)
redis.disconnect()
process.exit(fail > 0 ? 1 : 0)
