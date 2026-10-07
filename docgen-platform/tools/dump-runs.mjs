/**
 * โยนโครงสร้าง run ในเอกสารที่ระบบสร้างจริง เพื่อดูว่า rPr เขียนแบบไหน
 *
 *   node --env-file=../dokploy-infra/.env --env-file=../dokploy-infra/.env.development tools/dump-runs.mjs [templateId]
 *
 * ใช้ตอนแก้ `packages/shared/src/docx-lang.ts` — ต้องรู้ว่าแม่แบบจริง
 * เขียน `<w:rPr>` แบบไหน (มี attribute ไหม, มีลูกอะไรบ้าง, `w:lang` อยู่ตรงไหน)
 * ถ้าเดาเองแล้วใส่ผิดตำแหน่ง Word/LibreOffice จะปฏิเสธไฟล์ทั้งฉบับ
 */
import { Redis } from 'ioredis'
import { strFromU8, unzipSync } from 'fflate'

const API = 'http://127.0.0.1:4001'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const redis = new Redis(process.env.VALKEY_URL)
const sid = `dump-${Date.now()}`
await redis.set(
  `session:${sid}`,
  JSON.stringify({ sub: sid, name: 'ตรวจ run', email: 'd@t.local', avatar: '' }),
  'EX',
  900,
)
const H = { cookie: `docgen_session=${sid}`, 'content-type': 'application/json' }

const t = await (await fetch(`${API}/api/templates`, { headers: H })).json()
const tpl = t.items.find((x) => x.versionId === process.argv[2]) ?? t.items[0]
console.log(`แม่แบบ: ${tpl.name}`)

const created = await (
  await fetch(`${API}/api/documents`, {
    method: 'POST',
    headers: H,
    body: JSON.stringify({
      templateId: tpl.versionId,
      data: { 'ชื่อ-นามสกุล': 'ขออนุญาตติดต่อประกาศ', 'ชั้น': 'นายอำเภอเมืองชะบวง' },
      outputFormat: 'docx',
      label: 'dump-runs',
    }),
  })
).json()

let doc
for (let i = 0; i < 60; i++) {
  await sleep(1000)
  doc = await (await fetch(`${API}/api/documents/${created._id}`, { headers: H })).json()
  if (doc.status === 'done' || doc.status === 'failed') break
  process.stdout.write('.')
}
console.log(`\nสถานะ: ${doc.status}`)

if (doc.status === 'done') {
  const res = await fetch(`${API}/api/documents/${created._id}/file`, { headers: { cookie: `docgen_session=${sid}` } })
  const files = unzipSync(new Uint8Array(await res.arrayBuffer()))
  const raw = strFromU8(files['word/document.xml'])

  const runs = [...raw.matchAll(/<w:r(?:\s[^>]*)?>[\s\S]*?<\/w:r>/g)].map((m) => m[0])
  console.log(`\nพบ run ทั้งหมด ${runs.length} ชิ้น — แสดง 12 ชิ้นแรกที่มีข้อความ\n`)

  let shown = 0
  for (const run of runs) {
    if (!/<w:t[ >]/.test(run)) continue
    console.log(`── run #${++shown} ──────────────────────────`)
    console.log(run.replace(/></g, '>\n<'))
    if (shown >= 12) break
  }

  // สรุป: rPr ทุกชนิดที่เจอในเอกสาร (ตรวจว่ามี attribute หรือไม่)
  const rprTags = [...raw.matchAll(/<w:rPr[^>]*>/g)].map((m) => m[0])
  const tally = new Map()
  for (const tag of rprTags) tally.set(tag, (tally.get(tag) ?? 0) + 1)
  console.log(`\n── รูปแบบ <w:rPr> ที่เจอ ─────────────────────`)
  for (const [tag, n] of tally) console.log(`   ${n}×  ${tag}`)

  // ลูกของ rPr ทั้งหมด ตามลำดับที่ปรากฏ — ใช้เทียบกับ schema ของ OOXML
  const children = new Set()
  for (const m of raw.matchAll(/<w:rPr[^>]*>([\s\S]*?)<\/w:rPr>/g)) {
    for (const c of m[1].matchAll(/<w:([A-Za-z]+)[\s/>]/g)) children.add(c[1])
  }
  console.log(`\n── ลูกของ rPr ทั้งหมดที่เจอ ──────────────────`)
  console.log(`   ${[...children].sort().join(', ')}`)
}

await fetch(`${API}/api/documents/${created._id}`, { method: 'DELETE', headers: { cookie: `docgen_session=${sid}` } })
await redis.del(`session:${sid}`)
redis.disconnect()
