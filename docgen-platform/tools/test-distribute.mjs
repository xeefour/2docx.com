/**
 * ทดสอบว่า LibreOffice (ใน docserver) เคารพ `w:jc = thaiDistribute` หรือไม่
 *
 * วิธี: สร้างเอกสารไทด้อย ๆ ชิ้นเดียวกัน ต่างกันแค่การจัดย่อหน้า
 *        เรนเดอร์เป็น PDF ทั้งคู่ แล้วเทียบ content stream
 *        ถ้า stream เหมือนกัน → LibreOffice ไม่รู้จักค่านี้ (ตั้งไว้ก็เปล่า)
 *        ถ้าต่างกัน → LibreOffice รู้จักและลงมือทำจริง
 *
 * ค่า w:jc ที่เกี่ยวข้อง (ECMA-376):
 *   both            = Justify (ธรรมดา)
 *   distribute      = Distribute
 *   thaiDistribute  = กระจายแบบไทย ← ที่ Word ใช้เมื่อเลือก "กระจาย"
 */
import { zipSync, strToU8 } from 'fflate'
import zlib from 'node:zlib'

const H = {
  Authorization: `Bearer ${process.env.DOCSERVER_API_KEY}`,
  'carbone-version': '5',
  'Content-Type': 'application/json',
}

const THAI = `ด้วยข้าพเจ้า นายสมชาย ใจดี ตำแหน่งนายอำเภอเนินมะปราง จังหวัดนครราชสีมา เห็นว่าควรดำเนินการเรื่องนี้เพื่อให้เป็นไปตามระเบียบและคำสั่งที่เกี่ยวข้อง จึงเรียนมาเพื่อพิจารณาดังต่อไปนี้`

/** สร้าง .docx ขั้นต่ำที่มีย่อหน้าภาษาไทยยาว ๆ พร้อมการจัดย่อหน้าที่กำหนด */
function buildDocx(alignment) {
  const para = (text, jc) => {
    const pPr = jc ? `<w:pPr><w:jc w:val="${jc}"/></w:pPr>` : ''
    return `<w:p>${pPr}<w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`
  }

  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body>
${para('ทดสอบการจัดย่อหน้าแบบไทย', 'center')}
${para(THAI, alignment)}
<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134"/></w:sectPr>
</w:body></w:document>`

  const files = {
    '[Content_Types].xml': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`),
    '_rels/.rels': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`),
    'word/document.xml': strToU8(document),
  }

  return Buffer.from(zipSync(files))
}

async function renderPdf(docxBuf) {
  // อัปโหลดแบบไม่เปิด versioning (ขั้นเดียว ไม่ทิ้งข้อมูลรบกวม)
  const form = new FormData()
  form.set('versioning', 'false')
  form.set(
    'template',
    new Blob([new Uint8Array(docxBuf)], {
      type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    }),
    'align-test.docx',
  )

  const up = await fetch(`${process.env.DOCSERVER_URL}/template`, { method: 'POST', headers: H, body: form })
  const upJson = await up.json()
  if (!upJson.success) throw new Error(`อัปโหลดไม่สำเร็จ: ${JSON.stringify(upJson).slice(0, 200)}`)
  const id = upJson.data.versionId ?? upJson.data.id

  const r1 = await fetch(`${process.env.DOCSERVER_URL}/render/${id}`, {
    method: 'POST',
    headers: { ...H, 'Content-Type': 'application/json' },
    body: JSON.stringify({ data: {}, convertTo: 'pdf' }),
  })
  const j1 = await r1.json()
  const dl = await fetch(`${process.env.DOCSERVER_URL}/render/${j1.data.renderId}`, { headers: H })
  const pdf = Buffer.from(await dl.arrayBuffer())

  // ล้างไฟล์ทดสอบทิ้ง — Carbone ลบไฟล์จริงแบบ synchronous
  await fetch(`${process.env.DOCSERVER_URL}/template/${id}`, { method: 'DELETE', headers: H }).catch(() => {})
  return pdf
}

/** ดึง content stream ของ PDF (inflate แล้ว) เพื่อเทียบว่าการวางตัวอักษรต่างกันไหม */
function textOps(pdf) {
  const parts = []
  let idx = 0
  while (true) {
    const s = pdf.indexOf('stream', idx)
    if (s === -1) break
    if (s >= 3 && pdf.subarray(s - 3, s).toString('latin1') === 'end') {
      idx = s + 6
      continue
    }
    let start = s + 6
    if (pdf[start] === 0x0d) start++
    if (pdf[start] === 0x0a) start++
    const e = pdf.indexOf('endstream', start)
    if (e === -1) break
    idx = e + 9
    try {
      const text = zlib.inflateSync(pdf.subarray(start, e)).toString('latin1')
      // เก็บเฉพาะ operator ที่วางตำแหน่งตัวอักษร (Td/TD/Tm/TJ) — สะท้อนผลของการจัดย่อหน้า
      const ops = text.match(/[\d.]+ [\d.]+ (?:Td|TD)|[\d. -]+ Tm|\[[^\]]*\]\s*TJ/g)
      if (ops) parts.push(...ops)
    } catch {
      /* ไม่บีบอัด — ข้าม */
    }
  }
  return parts
}

console.log('สร้างเอกสารทดสอบ 3 แบบ แล้วเรนเดอร์เป็น PDF\n')

const variants = [
  ['left (ค่า default ของไทยปัจจุบัน)', null],
  ['both (Justify ธรรมดา)', 'both'],
  ['thaiDistribute (กระจายแบบไทย)', 'thaiDistribute'],
  ['distribute (Distribute ทั่วไป)', 'distribute'],
]

const results = []
for (const [label, jc] of variants) {
  try {
    const pdf = await renderPdf(buildDocx(jc))
    const ops = textOps(pdf)
    results.push({ label, jc, bytes: pdf.length, ops })
    console.log(`  ${label.padEnd(36)} PDF ${pdf.length.toLocaleString()} bytes · ${ops.length} จุดวางตัวอักษร`)
  } catch (e) {
    console.log(`  ${label.padEnd(36)} ERROR: ${e.message}`)
  }
}

console.log('\nเทียบกับ left:')
const base = results[0]
for (const r of results.slice(1)) {
  const same = base.ops.length === r.ops.length && base.ops.every((v, i) => v === r.ops[i])
  console.log(`  ${r.label.padEnd(36)} ${same ? '✗ เหมือน left เป๊ะ → LibreOffice ไม่รู้จักค่านี้' : '✓ ต่างจาก left → LibreOffice ลงมือทำ'}`)
}
