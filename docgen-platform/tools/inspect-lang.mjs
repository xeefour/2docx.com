/**
 * ตรวจว่าภาษาของข้อความในไฟล์ .docx ที่ระบบสร้างถูกตั้งไว้ยังไง
 *
 *   node --env-file=../dokploy-infra/.env --env-file=../dokploy-infra/.env.development tools/inspect-lang.mjs
 *
 * ข้อความไทยที่ขีดเส้นแดงใน Word/LibreOffice แปลว่า run นั้นถูกตั้ง `w:lang`
 * เป็นภาษาอื่น (ปกติ en-US) → โปรแกรมเลยเอาไปตรวจสะกดแบบอังกฤษ
 */
import { Redis } from 'ioredis'
import { strFromU8, unzipSync } from 'fflate'

const API = 'http://127.0.0.1:4001'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const redis = new Redis(process.env.VALKEY_URL)
const sid = `lang-${Date.now()}`
await redis.set(`session:${sid}`, JSON.stringify({ sub: sid, name: 'ตรวจภาษา', email: 'l@t.local', avatar: '' }), 'EX', 900)
const H = { cookie: `docgen_session=${sid}`, 'content-type': 'application/json' }

const t = await (await fetch(`${API}/api/templates`, { headers: H })).json()
const tpl = t.items.find((x) => x.name.includes('หนังสือราชการ')) ?? t.items[0]
console.log(`แม่แบบ: ${tpl.name}`)

const created = await (
  await fetch(`${API}/api/documents`, {
    method: 'POST',
    headers: H,
    body: JSON.stringify({
      templateId: tpl.versionId,
      data: { เรื่อง: 'ขออนุญาตติดต่อประกาศ', ถึง: 'นายอำเภอเมืองชะบวง' },
      outputFormat: 'docx',
      label: 'lang-check',
    }),
  })
).json()

process.stdout.write('รอเรนเดอร์')
let doc
for (let i = 0; i < 60; i++) {
  await sleep(1000)
  doc = await (await fetch(`${API}/api/documents/${created._id}`, { headers: H })).json()
  if (doc.status === 'done' || doc.status === 'failed') break
  if (i % 5 === 0) process.stdout.write('.')
}
console.log(`\nสถานะ: ${doc.status}`)

if (doc.status === 'done') {
  const res = await fetch(`${API}/api/documents/${created._id}/file`, { headers: { cookie: `docgen_session=${sid}` } })
  const buf = new Uint8Array(await res.arrayBuffer())
  const files = unzipSync(buf)

  for (const name of ['word/document.xml', 'word/styles.xml']) {
    const raw = strFromU8(files[name])
    const langs = [...raw.matchAll(/<w:lang[^>]*\/>/g)].map((m) => m[0])
    const counts = new Map()
    for (const l of langs) counts.set(l, (counts.get(l) ?? 0) + 1)
    console.log(`\n── ${name}: ${langs.length} จุดที่ตั้งภาษา`)
    for (const [k, v] of counts) console.log(`   ${v}×  ${k}`)
    if (langs.length === 0) console.log('   (ไม่มี w:lang เลย → โปรแกรมใช้ค่าเริ่มต้นของเครื่อง)')

    // นับ run ที่มีข้อความไทย แล้วดูว่ามีการตั้ง noProof หรือไม่
    const thaiRuns = (raw.match(/<w:t[^>]*>[^<]*[฀-๿][^<]*<\/w:t>/g) ?? []).length
    const noProof = (raw.match(/<w:noProof\/>/g) ?? []).length
    console.log(`   run ที่มีตัวไทย: ${thaiRuns} · ตั้ง noProof: ${noProof}`)
  }
}

await fetch(`${API}/api/documents/${created._id}`, { method: 'DELETE', headers: { cookie: `docgen_session=${sid}` } })
await redis.del(`session:${sid}`)
redis.disconnect()
