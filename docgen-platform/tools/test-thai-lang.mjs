/**
 * เทสต์เฉพาะกิต `setDocxThaiLanguage` — ไม่ต้องผ่าน docserver
 *
 *   node --env-file=.env --import tsx tools/test-thai-lang.mjs
 *
 * ทดสอบกรณีที่ไฟล์จริงจะเจอบ่อย ๆ และกรณีที่จะทำให้ Word บอกว่าไฟล์เสีย
 * (แท็กผิดตำแหน่ง, rPr ซ้อน, แตะ w:eastAsia) — ซึ่งการทดสอบผ่าน API
 * ตรวจไม่ได้ละเอียดขนาดนี้
 */
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import { setDocxThaiLanguage } from '../packages/shared/src/docx-lang.ts'

let pass = 0
let fail = 0

function check(name, ok, detail = '') {
  if (ok) {
    pass++
    console.log(`  ✓ ${name}`)
  } else {
    fail++
    console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`)
  }
}

/** สร้าง docx จำลองจาก map ของ ชื่อไฟล์ → เนื้อหา XML */
const makeDocx = (parts) => Buffer.from(zipSync(Object.fromEntries(parts.map((p) => [p[0], strToU8(p[1])]))))
const readDocx = (buf) => Object.fromEntries(Object.entries(unzipSync(new Uint8Array(buf))).map(([k, v]) => [k, strFromU8(v)]))

const DOC = 'word/document.xml'
const xml = (body) => `<?xml version="1.0"?><w:document xmlns:w="x"><w:body>${body}</w:body></w:document>`

console.log('\n── รูปแบบ run และตำแหน่ง w:lang ──')

{
  // ไม่มี rPr เลย → ต้องสร้างใหม่เป็นลูกแรก
  const src = xml('<w:r><w:t>ทดสอบ</w:t></w:r>')
  const { buf, result } = setDocxThaiLanguage(makeDocx([[DOC, src]]))
  const out = readDocx(buf)[DOC]
  check('ไม่มี rPr → สร้าง rPr ใหม่เป็นลูกแรก', out.includes('<w:r><w:rPr><w:lang w:val="th-TH"/></w:rPr><w:t>'))
  check('ไม่มี rPr → นับเป็น 1 run', result.runs === 1, JSON.stringify(result))
}

{
  // มี rPr + w14:ligatures ต้องแทรก w:lang ไว้ "ก่อน" ไม่ใช่ท้ายสุด
  const src = xml(
    '<w:r><w:rPr><w:rFonts w:ascii="TH SarabunIT๙"/><w:sz w:val="32"/><w14:ligatures w14:val="none"/></w:rPr><w:t>ที่ พล 0</w:t></w:r>',
  )
  const { buf } = setDocxThaiLanguage(makeDocx([[DOC, src]]))
  const out = readDocx(buf)[DOC]
  check(
    'w:lang ต้องมาก่อน w14:ligatures (ลำดับตาม schema)',
    out.includes('<w:sz w:val="32"/><w:lang w:val="th-TH"/><w14:ligatures'),
    out.slice(out.indexOf('<w:r>'), out.indexOf('</w:r>')),
  )
}

{
  // rPr ที่มี attribute ต้องไม่ถูกลบทิ้ง
  const src = xml('<w:r><w:rPr w:rsidRPr="000561BE"><w:b/></w:rPr><w:t>หนังสือรับรอง</w:t></w:r>')
  const { buf } = setDocxThaiLanguage(makeDocx([[DOC, src]]))
  const out = readDocx(buf)[DOC]
  check('rPr ที่มี attribute → คง attribute ไว้', out.includes('<w:rPr w:rsidRPr="000561BE"><w:b/><w:lang w:val="th-TH"/></w:rPr>'), out)
}

{
  // rPr แบบว่าง → ต้องขยาย ไม่ใช่สร้างซ้อนสองชั้น
  const src = xml('<w:r><w:rPr/><w:t>ชั้น</w:t></w:r>')
  const { buf } = setDocxThaiLanguage(makeDocx([[DOC, src]]))
  const out = readDocx(buf)[DOC]
  check('rPr แบบว่าง → ขยายเป็น rPr เดียว', out.includes('<w:rPr><w:lang w:val="th-TH"/></w:rPr>') && !out.includes('<w:rPr/><'), out)
}

{
  // มี w:lang เดิม → แก้เฉพาะ w:val ห้ามทิ้ง eastAsia/bidi (กันฟอนต์เปลี่ยน)
  const src = xml('<w:r><w:rPr><w:lang w:val="en-US" w:eastAsia="th-TH" w:bidi="ar-SA"/></w:rPr><w:t>นายอำเภอ</w:t></w:r>')
  const { buf } = setDocxThaiLanguage(makeDocx([[DOC, src]]))
  const out = readDocx(buf)[DOC]
  check(
    'w:lang เดิม → เปลี่ยนเฉพาะ w:val เก็บ eastAsia/bidi ไว้',
    out.includes('<w:lang w:val="th-TH" w:eastAsia="th-TH" w:bidi="ar-SA"/>'),
    out,
  )
  check('ไม่มี w:eastAsia ถูกเพิ่มหรือลบที่ไหนเลย', !/<w:lang w:val="th-TH"\/>/.test(out), out)
}

{
  // ตั้งไทยไว้แล้ว → ไม่ต้องแก้ซ้ำ
  const src = xml('<w:r><w:rPr><w:lang w:val="th-TH"/></w:rPr><w:t>ชะบวง</w:t></w:r>')
  const { result } = setDocxThaiLanguage(makeDocx([[DOC, src]]))
  check('ตั้งภาษาไทยไว้แล้ว → ไม่แก้ซ้ำ', result.alreadyThai === 1 && result.runs === 0 && result.changed === false, JSON.stringify(result))
}

console.log('\n── ภาษาของข้อความ ──')

{
  const src = xml('<w:r><w:t>Ref. 1234/2569</w:t></w:r>')
  const { buf, result } = setDocxThaiLanguage(makeDocx([[DOC, src]]))
  check('ข้อความอังกฤษล้วน → ไม่แตะ', readDocx(buf)[DOC] === src && result.changed === false, JSON.stringify(result))
}

{
  // อังกฤษมากกว่าไทย → ปล่อยไว้ ไม่ให้สลับว่าอันไหนโดนตรวจสะกด
  const src = xml('<w:r><w:t>ติดต่อ Email: test@example.com เพื่อทราบ</w:t></w:r>')
  const { buf, result } = setDocxThaiLanguage(makeDocx([[DOC, src]]))
  check('ข้อความผสมที่อังกฤษมากกว่า → ข้าม', result.skippedMixed === 1 && result.runs === 0, JSON.stringify(result))
  check('ข้อความผสม → คงเดิมทุกตัวอักษร', readDocx(buf)[DOC] === src)
}

{
  // ไทยมากกว่า → ตั้ง
  const src = xml('<w:r><w:t>เรียนท่านผู้ให้ความหมาย</w:t></w:r>')
  const { result } = setDocxThaiLanguage(makeDocx([[DOC, src]]))
  check('ข้อความไทยล้วน → ตั้งภาษา', result.runs === 1, JSON.stringify(result))
}

{
  // run ที่มีหลาย w:t (Word แยกตามรูปแบบอักษร) → ต้องนับรวม
  const src = xml('<w:r><w:t>ทดสอบ</w:t><w:t>ระบบ</w:t><w:t>ABC</w:t></w:r>')
  const { buf, result } = setDocxThaiLanguage(makeDocx([[DOC, src]]))
  check('run ที่มีหลาย w:t → นับข้อความรวมกัน', result.runs === 1, JSON.stringify(result))
  check('run ที่มีหลาย w:t → ได้ th-TH', readDocx(buf)[DOC].includes('<w:lang w:val="th-TH"/>'))
}

console.log('\n── ส่วนอื่นของเอกสาร ──')

{
  const parts = [
    [DOC, xml('<w:r><w:t>เนื้อความ</w:t></w:r>')],
    ['word/header1.xml', '<?xml version="1.0"?><w:hdr xmlns:w="x"><w:r><w:t>หัวกระดาษ</w:t></w:r></w:hdr>'],
    ['word/footer2.xml', '<?xml version="1.0"?><w:ftr xmlns:w="x"><w:r><w:t>หน้า 1</w:t></w:r></w:ftr>'],
    ['word/footnotes.xml', '<?xml version="1.0"?><w:ftr xmlns:w="x"><w:r><w:t>เชิงอรรถ</w:t></w:r></w:ftr>'],
    ['word/styles.xml', '<?xml version="1.0"?><w:styles xmlns:w="x"><w:lang w:val="en-US"/></w:styles>'],
  ]
  const { buf, result } = setDocxThaiLanguage(makeDocx(parts))
  const out = readDocx(buf)
  check('หัวกระดาษ/ท้ายกระดาษ/เชิงอรรถ → ตั้งภาษาครบ', ['word/header1.xml', 'word/footer2.xml', 'word/footnotes.xml'].every((n) => out[n].includes('th-TH')))
  check('เนื้อหาหลัก → ตั้งภาษา', out[DOC].includes('th-TH'))
  check('styles.xml → ไม่ถูกแตะ (docDefaults ยังเป็น en-US)', out['word/styles.xml'] === parts[4][1], out['word/styles.xml'])
  check('รวม 4 ส่วน', result.runs === 4, JSON.stringify(result))
}

{
  // ไฟล์ที่ไม่ใช่ docx (เช่น PDF ที่หลุดมา) → คืนเดิม ไม่ throw
  const notZip = Buffer.from('%PDF-1.7\nไม่ใช่ zip แน่นอน')
  const { buf, result } = setDocxThaiLanguage(notZip)
  check('ไฟล์ที่ไม่ใช่ zip → คืนไฟล์เดิม ไม่ throw', buf.equals(notZip) && result.changed === false, JSON.stringify(result))
}

{
  // zip ที่ไม่มี word/document.xml → คืนเดิม
  const odd = makeDocx([['hello.txt', 'hi']])
  const { buf, result } = setDocxThaiLanguage(odd)
  check('zip ที่ไม่มี document.xml → คืนไฟล์เดิม', buf.equals(odd) && result.changed === false)
}

{
  // เอกสารว่าง → ไม่ crash
  const empty = makeDocx([[DOC, '<?xml version="1.0"?><w:document xmlns:w="x"><w:body/></w:document>']])
  const { result } = setDocxThaiLanguage(empty)
  check('เอกสารไม่มี run เลย → ไม่ crash', result.runs === 0 && result.changed === false)
}

{
  // run ที่ไม่มี w:t (เช่น w:tab, w:br) → ข้าม ไม่ต้องแตะ
  const src = xml('<w:r><w:rPr><w:b/></w:rPr><w:tab/></w:r>')
  const { buf, result } = setDocxThaiLanguage(makeDocx([[DOC, src]]))
  check('run ที่ไม่มีข้อความ → ไม่แตะ', readDocx(buf)[DOC] === src && result.runs === 0)
}

console.log(`\n── ผ่าน ${pass} · ไม่ผ่าน ${fail} ─────────────────────\n`)
process.exit(fail ? 1 : 0)
