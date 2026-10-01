/**
 * ทดสอบเฉพาะจุด: `w:jc` ควบคุมการจัดย่อหน้าในแม่แบบจริงได้จริงไหม
 *
 * ข้อสังเกตที่ทำให้ต้องวัดซ้ำ: PDF ก่อน/หลังแก้ต่างกันทุกไบต์ แต่ตำแหน่งคำใน
 * measure_align.py เหมือนกันเป๊ะทุกบรรทัด → อาจแปลว่า w:jc ไม่มีผลกับแม่แบบนี้เลย
 *
 * วิธี: เอาไฟล์แม่แบบเดียวกัน ทำ 3 เวอร์ชัน แล้วเรนเดอร์เทียบกัน
 *   1. ต้นฉบับ              — thaiDistribute (สิ่งที่ผู้ใช้ตั้งใน Word)
 *   2. แก้แล้ว              — both
 *   3. ไม่ตั้ง (ชิดซ้าย)   — ตัด <w:jc> ออกทั้งหมด
 *
 * ถ้า 1 = 2 = 3 → w:jc ไม่มีผล ต้องหาสาเหตุที่อื่น (เช่น ย่อหน้านั้นมี <w:br/> ตายตัว)
 * ถ้า 3 ต่างจาก 1 และ 2 แต่ 1 = 2 → LibreOffice รองรับ thaiDistribute ที่นี่
 *
 *   node --env-file=.env tools/test-jc-effect.mjs
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { unzipSync, zipSync, strFromU8, strToU8 } from 'fflate'

const API = process.env.DOCSERVER_URL
const H = { Authorization: `Bearer ${process.env.DOCSERVER_API_KEY}`, 'carbone-version': '5' }
const HJSON = { ...H, 'Content-Type': 'application/json' }
const OUT = 'D:/2docx.com/tests/part-09-thai-distribute/output-jc'

const DATA = {
  เรื่อง: 'ขออนุญาตไปราชการและรายงานผลการดำเนินการตามคำสั่งของอำเภอเนินมะปราง',
  เรียน: 'พนักงานอัยการจังหวัดนครราชสีมา',
  ชื่อ: 'นายสมชาย ใจดี',
  ที่อยู่: '123 หมู่ 4 ตำบลบ้านโคก อำเภอเนินมะปราง จังหวัดนครราชสีมา',
  เนื้อหา:
    'ด้วยข้าพเจ้า นายสมชาย ใจดี ตำแหน่งนายอำเภอเนินมะปราง จังหวัดนครราชสีมา ' +
    'เห็นว่าควรดำเนินการเรื่องนี้เพื่อให้เป็นไปตามระเบียบและคำสั่งที่เกี่ยวข้อง จึงเรียนมาเพื่อพิจารณาดังต่อไปนี้',
  สิ่งที่แนบ: 'สำเนาหนังสือรายงานผลการดำเนินการจำนวน 1 ฉบับ',
  ที่: 'ชม.0511.01/1234',
  เลขที่หนังสือ: '1234',
  อำเภอ: 'เนินมะปราง',
  ชื่อเจ้าหน้าที่: 'นายสมชาย ใจดี',
  ตำแหน่ง: 'นายอำเภอ',
}

/** ดึงไฟล์แม่แบบที่ deploy อยู่ตามชื่อ (นำหน้า 8 ตัวของ versionId) */
async function fetchTemplate(match) {
  const list = (await (await fetch(`${API}/templates`, { headers: H })).json()).data ?? []
  const t = list.find((x) => x.id && x.name?.includes(match))
  if (!t) throw new Error(`ไม่เจอแม่แบบ "${match}"`)
  const dl = await fetch(`${API}/template/${t.versionId}`, { headers: H })
  return { name: t.name, docx: Buffer.from(await dl.arrayBuffer()) }
}

async function renderRaw(docx) {
  // ⚠️ แก้เนื้อหาไฟล์ → hash ใหม่ → Carbone จะสร้างไฟล์ใหม่จริง (ต่างจากกรณีไฟล์เดิม)
  //    เรียงเวลาใหม่ไปได้เลย แต่ลบไฟล์เหล่านี้ทิ้ง เพราะเป็นของทดลอง
  const form = new FormData()
  form.set('versioning', 'false')
  form.set(
    'template',
    new Blob([new Uint8Array(docx)], {
      type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    }),
    'jc-test.docx',
  )
  const up = await fetch(`${API}/template`, { method: 'POST', headers: H, body: form })
  const uj = await up.json()
  if (!uj.success) throw new Error(JSON.stringify(uj).slice(0, 200))
  const id = uj.data.templateId ?? uj.data.versionId ?? uj.data.id

  const r = await fetch(`${API}/render/${id}`, {
    method: 'POST',
    headers: HJSON,
    body: JSON.stringify({ data: DATA, convertTo: 'pdf' }),
  })
  const rj = await r.json()
  if (!rj.success) throw new Error(JSON.stringify(rj).slice(0, 200))
  const dl = await fetch(`${API}/render/${rj.data.renderId}`, { headers: H })
  return { pdf: Buffer.from(await dl.arrayBuffer()), tempId: id }
}

/** เปลี่ยน w:jc ทุกตัวในไฟล์ (mode: 'both' | 'left' | 'none') */
function setJc(docx, mode) {
  const files = unzipSync(new Uint8Array(docx))
  const xml = strFromU8(files['word/document.xml'])
  const out =
    mode === 'none'
      ? xml.replace(/<w:jc\s+w:val="[^"]+"\s*\/>/g, '')
      : xml.replace(/<w:jc\s+w:val="[^"]+"/g, `<w:jc w:val="${mode}"`)
  files['word/document.xml'] = strToU8(out)
  return Buffer.from(zipSync(files))
}

mkdirSync(OUT, { recursive: true })

const { name, docx } = await fetchTemplate('สำเนา 1')
console.log(`แม่แบบ: ${name}\n`)

const VARIANTS = [
  ['thaiDistribute', setJc(docx, 'thaiDistribute')],
  ['both', setJc(docx, 'both')],
  ['left', setJc(docx, 'left')],
]

const made = []
for (const [mode, buf] of VARIANTS) {
  const { pdf, tempId } = await renderRaw(buf)
  const file = `${OUT}/jc-${mode}.pdf`
  writeFileSync(file, pdf)
  made.push([mode, file])
  console.log(`  ${mode.padEnd(16)} ${pdf.length.toLocaleString().padStart(9)} bytes → ${file}`)

  // ลบไฟล์ทดลองทิ้ง — ไฟล์นี้ถูกสร้างขึ้นใหม่จากการแก้เนื้อหา จึงปลอดภัย
  await fetch(`${API}/template/${tempId}`, { method: 'DELETE', headers: H }).catch(() => {})
}

writeFileSync(`${OUT}/manifest.json`, `${JSON.stringify(made)}\n`, 'utf8')
console.log(`\nรันวัด:  python measure_align.py "${OUT}/jc-both.pdf" "both"`)
