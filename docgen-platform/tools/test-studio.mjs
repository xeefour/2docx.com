/**
 * ทดสอบ E2E ทุก flow ที่ 2docx Studio เรียกใช้
 *
 * ทุกคำขอผ่าน `http://127.0.0.1:3000` เสมอ เพื่อพิสูจน์ว่า rewrite ของ Next.js
 * ทำให้เบราว์เซอร์คุย origin เดียวได้จริง (ไม่ต้องตั้ง CORS)
 */
import { Redis } from 'ioredis'
import { PDFDocument } from 'pdf-lib'

const WEB = 'http://127.0.0.1:3000'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const redis = new Redis(process.env.VALKEY_URL)
const sid = `studio-e2e-${Date.now()}`
await redis.set(`session:${sid}`, JSON.stringify({ sub: 'studio-e2e' }), 'EX', 300)

/** cookie อย่างเดียว — ห้ามใส่ content-type เวลาไม่มี body (Fastify ตอบ 500) */
const H = { cookie: `docgen_session=${sid}` }
const HJ = { ...H, 'content-type': 'application/json' }

let pass = 0
let fail = 0
const check = (ok, label, extra = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${extra ? ` — ${extra}` : ''}`)
  ok ? pass++ : fail++
}

console.log('\n=== 1. rewrite: path ที่ Studio ใช้ ===')
for (const [p, expect] of [
  ['/auth/login', 302],
  ['/docs', 200],
  ['/api/health', 200],
]) {
  const r = await fetch(`${WEB}${p}`, { redirect: 'manual' })
  check(r.status === expect, `${p} → ${r.status}`, `คาดหวัง ${expect}`)
}

console.log('\n=== 2. ไม่มี cookie ต้องได้ 401 ===')
{
  const r = await fetch(`${WEB}/api/templates`)
  check(r.status === 401, `GET /api/templates → ${r.status}`)
}

console.log('\n=== 3. รายการแม่แบบ ===')
let tpl
{
  const r = await fetch(`${WEB}/api/templates`, { headers: H })
  const j = await r.json()
  tpl = j.items.find((t) => t.name.includes('เลขที่')) ?? j.items[0]
  check(r.status === 200 && j.items.length > 0, `ได้ ${j.items.length} แม่แบบ`)
}

console.log('\n=== 4. แท็ก {d.*} + JSON ตัวอย่าง ===')
{
  const r = await fetch(`${WEB}/api/templates/${tpl.versionId}/tags`, { headers: H })
  const j = await r.json()
  const okSample = Object.keys(j.sample).length > 0
  check(r.status === 200 && j.items.length > 0, `${j.items.length} แท็ก`)
  check(okSample, `JSON ตัวอย่างมี ${Object.keys(j.sample).length} คีย์`)
}

console.log('\n=== 5. เรนเดอร์ + ดาวน์โหลด + แบรนด์ ===')
const tagsRes = await (await fetch(`${WEB}/api/templates/${tpl.versionId}/tags`, { headers: H })).json()
let docId
{
  const r = await fetch(`${WEB}/api/documents`, {
    method: 'POST',
    headers: HJ,
    body: JSON.stringify({
      templateId: tpl.versionId,
      data: { ...tagsRes.sample, เรื่อง: 'ทดสอบจาก Studio', เนื้อหา: 'เนื้อหาทดสอบ' },
      outputFormat: 'pdf',
      label: 'studio e2e',
    }),
  })
  const j = await r.json()
  docId = j._id ?? j.documentId
  check(r.status === 201 && Boolean(docId), `สร้างงาน ${docId}`)
}
{
  let doc
  for (let i = 0; i < 40; i++) {
    await sleep(900)
    doc = await (await fetch(`${WEB}/api/documents/${docId}`, { headers: H })).json()
    if (['done', 'failed'].includes(doc.status)) break
  }
  check(doc.status === 'done', `สถานะ ${doc.status}`, doc.error ?? '')

  if (doc.status === 'done') {
    const buf = Buffer.from(await (await fetch(doc.downloadUrl)).arrayBuffer())
    check(buf.subarray(0, 5).toString('latin1') === '%PDF-', `PDF ${buf.length.toLocaleString()} bytes`)

    // ⚠️ อ่าน metadata ต้องใส่ updateMetadata:false ไม่งั้น pdf-lib จะเขียนทับตอนโหลด
    const pdf = await PDFDocument.load(buf, { updateMetadata: false })
    const brand = process.env.OUTPUT_BRAND
    check(pdf.getProducer() === brand, `/Producer = ${JSON.stringify(pdf.getProducer())}`)
    check(pdf.getAuthor() === brand, `/Author = ${JSON.stringify(pdf.getAuthor())}`)
  }
}

console.log('\n=== 6. PATCH metadata (มี body) ===')
{
  const r = await fetch(`${WEB}/api/templates/${tpl.versionId}`, {
    method: 'PATCH',
    headers: HJ,
    body: JSON.stringify({ comment: 'ทดสอบจาก studio-e2e' }),
  })
  check(r.status === 204, `PATCH → ${r.status}`)
}

console.log('\n=== 7. DELETE เอกสาร (ไม่มี body — ต้องไม่ส่ง content-type) ===')
{
  // ⚠️ ถ้าส่ง content-type แต่ไม่มี body → Fastisan ตอบ 500
  //    "Body cannot be empty when content-type is set to 'application/json'"
  const r = await fetch(`${WEB}/api/documents/${docId}`, { method: 'DELETE', headers: H })
  check(r.status === 204, `DELETE → ${r.status}`)

  const after = await fetch(`${WEB}/api/documents/${docId}`, { headers: H })
  check(after.status === 404, `เช็คซ้ำ → ${after.status}`)
}

console.log(`\n${'─'.repeat(50)}\nผ่าน ${pass} · ไม่ผ่าน ${fail}\n`)
await redis.del(`session:${sid}`)
redis.disconnect()
process.exit(fail > 0 ? 1 : 0)
