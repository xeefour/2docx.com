/**
 * สร้างไฟล์ตัวอย่างสองฉบับ ให้เปิดเทียบใน Word ว่าเส้นตรวจสะกดหายไปไหม
 *
 *   node --env-file=../dokploy-infra/.env --env-file=../dokploy-infra/.env.development tools/make-spell-demo.mjs
 *
 *   before.docx = ตัวที่ถอด `w:lang` ที่ระบบใส่ออก (จำลองสถานะเดิม)
 *   after.docx  = ไฟล์จริงที่ระบบส่งออกตอนนี้
 *
 * ข้อความในไฟล์ตัวอย่างใช้คำจากเอกสารที่เจอปัญหาจริง
 */
import { Redis } from 'ioredis'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'

const API = 'http://127.0.0.1:4001'
const OUT = join(import.meta.dirname, '..', 'tests', 'spell-check')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * เลือกแม่แบบที่ยากที่สุด: ตัวนี้มี `w14:ligatures` ในทุก run
 * ทำให้เห็นชัดว่า w:lang ถูกยัดไว้ตรงตามลำดับ schema หรือไม่
 */
const PREFER = 'ส่งสำเนาให้อัยการ'

const redis = new Redis(process.env.VALKEY_URL)
const sid = `spell-${Date.now()}`
await redis.set(
  `session:${sid}`,
  JSON.stringify({ sub: sid, name: 'ทดสอบเส้นตรวจสะกด', email: 's@t.local', avatar: '' }),
  'EX',
  3600,
)
const H = { cookie: `docgen_session=${sid}`, 'content-type': 'application/json' }

/** ดึง JSON พร้อมบอกเหตุผลถ้าไม่ได้ — ตอน dev API รีสตาร์ทบ่อย */
async function getJSON(url) {
  const res = await fetch(url, { headers: H })
  const body = await res.text()
  if (!res.ok) throw new Error(`${url} ตอบ ${res.status}: ${body.slice(0, 200)}`)
  try {
    return JSON.parse(body)
  } catch {
    throw new Error(`${url} ได้ข้อความที่ไม่ใช่ JSON: ${body.slice(0, 200)}`)
  }
}

const list = await getJSON(`${API}/api/templates`)
if (!Array.isArray(list?.items)) throw new Error(`ไม่พบรายการแม่แบบ — ได้ ${JSON.stringify(list).slice(0, 200)}`)
const tpl = list.items.find((t) => t.name.includes(PREFER)) ?? list.items[0]
console.log(`แม่แบบ: ${tpl.name}`)

const created = await (
  await fetch(`${API}/api/documents`, {
    method: 'POST',
    headers: H,
    body: JSON.stringify({
      templateId: tpl.versionId,
      data: {
        'ชื่อ-นามสกุล': 'ขออนุญาตติดต่อประกาศ',
        'ชั้น': 'นายอำเภอเมืองชะบวง',
        'ตำแหน่ง': 'ปลัดอำเภอ',
        'หมายเลขที่หนังสือ': 'สท 1234/2569',
      },
      outputFormat: 'docx',
      label: 'spell-demo',
    }),
  })
).json()

process.stdout.write('รอเรนเดอร์')
let doc
for (let i = 0; i < 60; i++) {
  await sleep(700)
  doc = await getJSON(`${API}/api/documents/${created._id}`)
  if (doc.status === 'done' || doc.status === 'failed') break
  process.stdout.write('.')
}
console.log(`\nสถานะ: ${doc.status}`)
if (doc.status !== 'done') process.exit(1)

const res = await fetch(`${API}/api/documents/${created._id}/file`, { headers: { cookie: `docgen_session=${sid}` } })
const after = Buffer.from(await res.arrayBuffer())

// ── ถอด w:lang ที่ระบบใส่ เพื่อจำลองไฟล์ก่อนแก้ ─────────────────
const files = unzipSync(new Uint8Array(after))
let stripped = 0
for (const [name, data] of Object.entries(files)) {
  if (!/^word\/(document|header\d*|footer\d*|footnotes|endnotes)\.xml$/.test(name)) continue
  const before = strFromU8(data)
  const after2 = before.replace(/<w:lang w:val="th-TH"\/>/g, () => {
    stripped++
    return ''
  })
  if (after2 !== before) files[name] = strToU8(after2)
}
const before = Buffer.from(zipSync(files, { level: 6 }))

mkdirSync(OUT, { recursive: true })
writeFileSync(join(OUT, 'before.docx'), before)
writeFileSync(join(OUT, 'after.docx'), after)

const langCount = (strFromU8(unzipSync(new Uint8Array(after))['word/document.xml']).match(/<w:lang[^>]*\/>/g) ?? []).length
console.log(`\n── สรุป ──────────────────────────────`)
console.log(`   ถอด w:lang ออกได้        : ${stripped} จุด`)
console.log(`   after.docx มี w:lang      : ${langCount} จุดใน document.xml`)
console.log(`   before.docx               : ${(before.length / 1024).toFixed(1)} KB`)
console.log(`   after.docx                : ${(after.length / 1024).toFixed(1)} KB`)
console.log(`\n   เปิด ${OUT} ใน Word เพื่อเทียบ`)

await fetch(`${API}/api/documents/${created._id}`, { method: 'DELETE', headers: { cookie: `docgen_session=${sid}` } })
await redis.del(`session:${sid}`)
redis.disconnect()
