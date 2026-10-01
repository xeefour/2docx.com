/**
 * แสดงรายละเอียดระดับย่อหน้า: จัดย่อหน้า + จำนวน `<w:br/>` + ความยาวข้อความ
 *
 * ใช้หาคำตอบว่า ทำไมบางแม่แบบเปลี่ยน `w:jc` แล้วผลลัพธ์ไม่เปลี่ยน
 * คำตอบที่เป็นไปได้: ย่อหน้านั้นมีขึ้นบรรทัดแบบตายตัว (`<w:br/>`)
 * → ทุกบรรทัดเป็น "บรรทัดสุดท้าย" ตามหลักการพิมพ์ จึงไม่ถูกยืดไม่ว่าจะตั้งอะไร
 *
 *   node --env-file=.env tools/inspect-paragraphs.mjs "<ชื่อแม่แบบที่มี>"
 */
import { unzipSync, strFromU8 } from 'fflate'

const H = { Authorization: `Bearer ${process.env.DOCSERVER_API_KEY}`, 'carbone-version': '5' }
const arg = process.argv[2] ?? 'สำเนา 3'
const HASH = /^[0-9a-f]{64}$/.test(arg)

const list = HASH
  ? []
  : (await (await fetch(`${process.env.DOCSERVER_URL}/templates`, { headers: H })).json()).data ?? []
const t = HASH ? { name: `ไฟล์ดิบ ${arg.slice(0, 12)}…`, versionId: arg } : list.find((x) => x.id && x.name?.includes(arg))
if (!t) {
  console.error(`ไม่เจอ "${arg}"`)
  process.exit(1)
}

const dl = await fetch(`${process.env.DOCSERVER_URL}/template/${t.versionId}`, { headers: H })
const buf = Buffer.from(await dl.arrayBuffer())
const xml = strFromU8(unzipSync(new Uint8Array(buf))['word/document.xml'])

console.log(`แม่แบบ: ${t.name}`)
console.log(`versionId: ${t.versionId}\n`)

const paras = xml.match(/<w:p\b[\s\S]*?<\/w:p>|<w:p\b[^>]*\/>/g) ?? []
console.log(`พบ ${paras.length} ย่อหน้า\n`)

const rows = []
for (const p of paras) {
  const jc = p.match(/<w:jc\s+w:val="([^"]+)"/)?.[1] ?? '(ไม่ตั้ง)'
  const br = (p.match(/<w:br\b/g) ?? []).length
  const text = [...p.matchAll(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g)].map((m) => m[1]).join('')
  const clean = text.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  if (!clean.trim()) continue
  rows.push({ jc, br, len: clean.length, text: clean.trim().slice(0, 40) })
}

console.log(`   ${'#'.padStart(3)}  ${'w:jc'.padEnd(16)} ${'<w:br/>'.padStart(7)} ${'ยาว'.padStart(5)}  ข้อความ`)
console.log('─'.repeat(88))
rows.forEach((r, i) => {
  const mark = r.br > 0 ? ' ⚠ มีขึ้นบรรทัดตายตัว' : ''
  console.log(
    `${String(i + 1).padStart(3)}  ${r.jc.padEnd(16)} ${String(r.br).padStart(7)} ${String(r.len).padStart(5)}  ${r.text}${mark}`,
  )
})
