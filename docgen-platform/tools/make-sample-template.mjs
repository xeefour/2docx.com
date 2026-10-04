/**
 * สร้างไฟล์แม่แบบตัวอย่าง .docx ไว้ให้ผู้ใช้ดาวน์โหลดไปแก้แล้วอัปโหลดกลับ
 *   node tools/make-sample-template.mjs
 *
 * ── ทำไมต้อง "สร้าง" ไม่ใช่หาไฟล์เดิม ─────────────────────────────
 * · ไฟล์ .docx ที่มีอยู่ในโปรเจกต์คือ fixture ของเทสต์ ไม่ใช่ตัวอย่างสำหรับผู้ใช้
 * · ไฟล์ที่สร้างเองควบคุมได้ว่าแท็กอยู่ใน **run เดียว** — ซึ่งสำคัญมาก
 *   เพราะ Word แบ่งข้อความเป็นหลาย `<w:t>` และตัวดึงแท็กของระบบ
 *   ต่อข้อความทุกก้อนแล้วค่อย regex (ดู apps/api/.../tags.ts)
 *   ถ้าแท็กถูกแบ่งข้าม run ระบบจะมองไม่เห็นแท็กนั้นเลย
 *
 * ── ⚠️ ขีดสีแดงใต้ข้อความ (ผู้ใช้เจอ) ──────────────────────────────
 * นั่นคือ Word ตรวจสะกด/ไวยากรณ์ภาษาไทย ไม่ใช่ไฟล์เสีย
 *   แก้ด้วย `<w:noProof/>` ใน rPr ของ**ทุก run** → สั่งไม่ให้ตรวจ
 *   ใส่ `w:lang w:val="th-TH"` ด้วยอีกชั้น เพื่อไม่ให้ Word เดาว่าเป็นภาษาอังกฤษ
 *   (ถ้าใส่แค่ noProof แต่ไม่บอกภาษา ผู้ใช้ที่เปิดตัวตรวจภาษาอื่นอาจเห็นขีดกลับมา)
 *
 * ── ผู้ใช้สั่ง ────────────────────────────────────────────────────
 * *"เอาตัวอย่างทุกประเภทใส่ลงไป เพื่อให้ผู้ใช้เอาไปตัดสินเอง"*
 *   → ไฟล์เดิมมีแค่ช่องข้อความธรรมดา ผู้ใช้จึงไม่รู้ว่าระบบรองรับอะไรบ้าง
 *   ให้มาครบทั้ง 5 แบบ พร้อมคำอธิบายสั้น ๆ และบอกชัดว่าลบทิ้งได้
 */
import { writeFileSync, mkdirSync } from 'node:fs'
import { zipSync, strToU8 } from 'fflate'

const OUT = 'D:/2docx.com/docgen-platform/apps/web/public/sample-template.docx'
mkdirSync('D:/2docx.com/docgen-platform/apps/web/public', { recursive: true })

const FONT = 'TH Sarabun New'
/** สีแท็ก — ต้องเด่นพอผู้ใช้หาเจอด้วยตา แต่ไม่ฉูดจนกลายเป็นเนื้อหาหลัก */
const TAG = '1F4E79'
const MUTED = '6B7280'

/**
 * ⚠️ `<w:noProof/>` ต้องอยู่ใน rPr ของ run — ไม่งั้นขีดสีแดงกลับมา
 *   และ `w:lang` ต้องมี `w:eastAsia` ด้วย ไม่งั้น Word จะใช้ค่าของภาษาหลัก
 */
const rPr = (opt) => {
  const { bold = false, color, size = 32 } = opt
  return (
    '<w:rPr>' +
    (bold ? '<w:b/>' : '') +
    `<w:rFonts w:ascii="${FONT}" w:hAnsi="${FONT}" w:eastAsia="${FONT}" w:cs="${FONT}"/>` +
    '<w:noProof/>' +
    `<w:lang w:val="th-TH" w:eastAsia="th-TH" w:bidi="th-TH"/>` +
    (color ? `<w:color w:val="${color}"/>` : '') +
    `<w:sz w:val="${size}"/><w:szCs w:val="${size}"/>` +
    '</w:rPr>'
  )
}

/** ข้อความ 1 บรรทัด = 1 run — ห้ามแบ่งแท็กออกหลายก้อน */
const p = (text, opt = {}) => {
  const { align = 'left', spaceAfter = 120, spaceBefore = 0, indent = 0, border = '' } = opt
  return (
    '<w:p><w:pPr>' +
    (border ? `<w:pBdr><w:left w:val="single" w:sz="18" w:space="8" w:color="${border}"/></w:pBdr>` : '') +
    (align !== 'left' ? `<w:jc w:val="${align}"/>` : '') +
    (indent ? `<w:ind w:left="${indent}"/>` : '') +
    `<w:spacing w:before="${spaceBefore}" w:after="${spaceAfter}" w:line="276" w:lineRule="auto"/>` +
    rPr(opt) +
    '</w:pPr>' +
    `<w:r>${rPr(opt)}<w:t xml:space="preserve">${esc(text)}</w:t></w:r></w:p>`
  )
}

/** ขีดกลางหน้า (แยกหน้า) */
const pageBreak = () => '<w:p><w:r>' + rPr({}) + '<w:br w:type="page"/></w:r></w:p>'

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/**
 * ⚠️ ข้อจำกัดสำคัญที่เจอจากการทดสอบจริง ────────────────────────
 * ไฟล์นี้เป็น**แม่แบบ** ไม่ใช่คู่มือ — ทุก `{...}` ที่อยู่ในไฟล์จะถูกเรนเดอร์
 *   รอบแรกเขียนหน้า "ตัวอย่างไวยากรณ์" ไว้ในไฟล์เดียวกัน
 *   ผลคือแท็กในหน้าคำอธิบายถูก**เรียกใช้จริง** เอกสารจึงซ้ำและเพี้ยน
 *   (วัดแล้ว: ตัวอย่าง `{d.รายการ[i]}` ในหน้าคำอธิบายเปิดบล็อกทำซ้ำ
 *    กินทั้งหนังสือจนได้หนังสือ 2 ฉบับในไฟล์เดียว)
 *
 *   วิธีแก้: เอกสารหนึ่งฉบับทำ**อย่างใดอย่างหนึ่ง**ไม่ได้ทั้งสองอย่าง
 *   → ไฟล์นี้เป็นแม่แบบล้วน ใช้ทุกไวยากรณ์ให้ครบในตัวหนังสือจริง
 *     แล้วบอกผู้ใช้ว่าจะเห็นตารางไวยากรณ์ครบในปุ่ม "อัปโหลด" บนหน้าเว็บ
 *   → คำอธิบายไวยากรณ์อยู่ที่ `UploadGuide.tsx` (SYNTAX) ต้องตรงกับไฟล์นี้เสมอ
 */

/**
 * ตัวอย่างไวยากรณ์ที่ Carbone 5 รับได้**จริง** (ทดสอบกับ docserver แล้ว)
 *
 * ⚠️ ต้องตรงกับ `SYNTAX` ใน `UploadGuide.tsx`
 *
 * ⚠️ สิ่งที่**ไม่ได้**อยู่ในรายการนี้ เพราะทดสอบแล้วใช้ไม่ได้จริง
 *   ถ้าใส่ไว้ผู้ใช้จะได้เอกสารที่มี `{ชื่อย่อ}` เป็นข้อความธรรมดาหรือช่องว่าง
 *   · `{#ชื่อย่อ = d.ช่อง}` — Carbone 5 ไม่มี alias (เป็นของ docxtemplater)
 *   · `{d.รายการ[i]}` — ต้องเป็น `[i+1]` เสมอ ใช้ `[i]` แล้วไม่ทำซ้ำให้
 *   · `{d.รายการ[i+1].ชื่อ}` — ซ้อน object ใน array แล้วค่าออกมาว่าง
 *     (ใช้ได้แค่ array ของข้อความธรรมดา)
 */
const EXAMPLES = [
  {
    code: '{d.ผู้รับ}',
    title: 'ช่องข้อความ',
    detail: 'ระบบเปิดช่องให้กรอกเองในหน้า "ช่องฟอร์ม" ค่าที่กรอกจะไปแทนที่ตรงนี้ทุกครั้งที่เรนเดอร์',
  },
  {
    code: "{d.วันที่:formatD('D MMMM YYYY')}",
    title: 'วันที่วันเรนเดอร์',
    detail:
      "เติมวันที่ปัจจุบันให้เอง เช่น 'D MMMM YYYY' · ปีที่ได้เป็น ค.ศ. ถ้าต้องการ พ.ศ. ให้เพิ่ม 543 เอง",
  },
  {
    code: '{d.ชั่วเรื่อง:ifEQ(true):show(...)}',
    title: 'แสดงเฉพาะเมื่อติ๊ก',
    detail: 'ข้อความที่อยู่ในวงเล็บ show() จะโชว์เมื่อผู้ใช้ติ๊กช่องนั้น · ข้อความนอกวงเล็บจะโชว์เสมอ',
  },
  {
    code: '{d.รายการ[i]} + {d.รายการ[i+1]}',
    title: 'ทำซ้ำตามจำนวนรายการ',
    detail: 'บรรทัด `{d.รายการ[i]}` เปิดบล็อก ย่อหน้าถัดไปจะถูกทำซ้ำเท่าจำนวนรายการในฟอร์ม',
  },
]

const SMALL = { size: 26 }
const BODY = [
  // ── หัวเรื่อง + วิธีใช้สั้น ๆ ─────────────────────────────────
  p('แม่แบบตัวอย่าง — นำไปแก้แล้วอัปโหลดกลับได้เลย', { bold: true, size: 36, align: 'center', spaceAfter: 60 }),
  p('ทุกอย่างที่อยู่ในเครื่องหมาย { } คือ "ช่องที่ระบบจะเติมให้" เมื่อมีคนกรอกแบบฟอร์ม', { align: 'center', spaceAfter: 40 }),
  p('หนังสือด้านล่างใช้ไวยากรณ์ครบทุกแบบที่ระบบรองรับ — ลบส่วนที่ไม่ต้องการทิ้งได้เลย', {
    align: 'center',
    spaceAfter: 40,
  }),
  p('ดูตารางไวยากรณ์พร้อมคำอธิบายได้ในปุ่ม "อัปโหลด" บนหน้านี้', { ...SMALL, color: MUTED, align: 'center', spaceAfter: 320 }),

  // ── หนังสือ: ใช้ไวยากรณ์ครบทุกแบบในตัวมันเอง ──────────────────
  p('ที่ ..........................................................', { spaceAfter: 0 }),
  p('{d.เลขที่}', { align: 'right', spaceAfter: 240 }),

  p("{d.วันที่:formatD('D MMMM YYYY')}", { align: 'right', spaceAfter: 240 }),

  p('เรื่อง\t{d.เรื่อง}', { spaceAfter: 60 }),
  p('เรียน\t{d.ผู้รับ}', { spaceAfter: 240 }),

  p('{d.เนื้อหา}', { indent: 567, spaceAfter: 240 }),

  /**
   * ⚠️ ข้อความที่จะ "หายไป" ต้องอยู่**ใน** show()
   *   ถ้าวางไว้นอกวงเล็บ มันจะอยู่ตลอดไม่ว่าผู้ใช้จะติ๊กหรือไม่
   *   (ทดสอบกับ docserver แล้ว — เคยเขียนผิด เพราะคิดว่า show() คือเงื่อนไขของทั้งบรรทัด)
   */
  p('{d.ชั่วเรื่อง:ifEQ(true):show(ด้วยความปรารถนาดีของหน่วยงาน)}', { indent: 567, spaceAfter: 240 }),

  /**
   * ⚠️ `{d.รายการ[i]}` เปิดบล็อกทำซ้ำ — **ย่อหน้าถัดไปเท่านั้น** ที่ถูกทำซ้ำ
   *   ต่างจากที่เข้าใจตอนแรกว่ามันกินทั้งเอกสาร
   *   (วัดกับ docserver แล้ว: ข้อความหลังบล็อกไม่ถูกทำซ้ำ)
   *   → ย่อหน้าหลังต้องมี `[i+1]` อยู่ด้วย ไม่งั้น Carbone จะไม่ทำซ้ำให้เลย
   *
   * ⚠️ อย่าใส่ข้อความนำหน้า เช่น "1." หรือ "·" เพราะ Carbone**แทนทั้งย่อหน้า**
   *   ด้วยค่าของ `[i+1]` — ที่ทดสอบข้อความนำหน้า "·  " หายไปในผลลัพธ์
   */
  p('รายการที่แนบมาด้วย', { spaceAfter: 0 }),
  p('{d.รายการ[i]}', { spaceAfter: 0 }),
  p('{d.รายการ[i+1]}', { spaceAfter: 240 }),

  p('ด้วยความเคารพ', { indent: 567, spaceAfter: 240 }),

  p('(ลงชื่อ)', { align: 'center', spaceAfter: 0 }),
  p('{d.ชื่อผู้ลงนาม}', { align: 'center', spaceAfter: 0 }),
  p('{d.ตำแหน่ง}', { align: 'center', spaceAfter: 0 }),
].join('')

const DOCUMENT =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
  '<w:body>' +
  BODY +
  // A4 + ขอบกระดาษมาตรฐานของหนังสือราชการไทย
  '<w:sectPr>' +
  '<w:pgSz w:w="11906" w:h="16838"/>' +
  '<w:pgMar w:top="1418" w:right="1418" w:bottom="1418" w:left="1701" ' +
  'w:header="708" w:footer="708" w:gutter="0"/>' +
  '</w:sectPr>' +
  '</w:body></w:document>'

const CONTENT_TYPES =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
  '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
  '<Default Extension="xml" ContentType="application/xml"/>' +
  '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
  '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' +
  '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>' +
  '</Types>'

const RELS =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
  '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>' +
  '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>' +
  '</Relationships>'

const CORE =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" ' +
  'xmlns:dc="http://purl.org/dc/elements/1.1/">' +
  '<dc:title>แม่แบบตัวอย่าง</dc:title>' +
  '</cp:coreProperties>'

const APP =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"/>'

const zip = zipSync(
  {
    '[Content_Types].xml': strToU8(CONTENT_TYPES),
    '_rels/.rels': strToU8(RELS),
    'word/document.xml': strToU8(DOCUMENT),
    'docProps/core.xml': strToU8(CORE),
    'docProps/app.xml': strToU8(APP),
  },
  { level: 6 },
)

writeFileSync(OUT, Buffer.from(zip))
console.log('เขียน', OUT, zip.length, 'ไบต์ ·', EXAMPLES.length, 'แบบ · noProof ครบทุก run')
