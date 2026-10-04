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
 */
import { writeFileSync, mkdirSync } from 'node:fs'
import { zipSync, strToU8 } from 'fflate'

const OUT = 'D:/2docx.com/docgen-platform/apps/web/public/sample-template.docx'
mkdirSync('D:/2docx.com/docgen-platform/apps/web/public', { recursive: true })

/** ข้อความ 1 บรรทัด = 1 run — ห้ามแบ่งแท็กออกหลายก้อน */
const p = (text, opt = {}) => {
  const { bold = false, size = 32, align = 'left', spaceAfter = 120, indent = 0 } = opt
  return (
    '<w:p><w:pPr>' +
    (align !== 'left' ? `<w:jc w:val="${align}"/>` : '') +
    (indent ? `<w:ind w:firstLine="${indent}"/>` : '') +
    `<w:spacing w:after="${spaceAfter}"/>` +
    '<w:rPr><w:rFonts w:ascii="TH Sarabun New" w:hAnsi="TH Sarabun New"/><w:sz w:val="' + size + '"/></w:rPr>' +
    '</w:pPr>' +
    '<w:r><w:rPr>' +
    (bold ? '<w:b/>' : '') +
    '<w:rFonts w:ascii="TH Sarabun New" w:hAnsi="TH Sarabun New"/><w:sz w:val="' + size + '"/>' +
    '</w:rPr>' +
    `<w:t xml:space="preserve">${esc(text)}</w:t></w:r></w:p>`
  )
}

const esc = (s) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

const BODY = [
  // ── หัวเรื่องเอกสาร ────────────────────────────────────────────
  p('แม่แบบตัวอย่าง — นำไปแก้แล้วอัปโหลดกลับได้เลย', { bold: true, size: 36, align: 'center', spaceAfter: 60 }),
  p('ทุกข้อความที่อยู่ในเครื่องหมาย { } คือ "ช่องที่ระบบจะเติมให้" เมื่อมีคนกรอกแบบฟอร์ม', { size: 26, align: 'center', spaceAfter: 60 }),
  p('ถ้าไม่ต้องการช่องไหน ก็แค่ลบ { } ทิ้ง แล้วเขียนเป็นข้อความธรรมดาแทน', { size: 26, align: 'center', spaceAfter: 360 }),

  // ── หัวหนังสือ ──────────────────────────────────────────────────
  p('ที่ ..........................................................', { spaceAfter: 0 }),
  p('{d.เลขที่}', { align: 'right', spaceAfter: 240 }),

  // ── เรื่อง / เรียน ──────────────────────────────────────────────
  p('เรื่อง\t{d.เรื่อง}', { spaceAfter: 60 }),
  p('เรียน\t{d.ผู้รับ}', { spaceAfter: 240 }),

  // ── เนื้อหา ────────────────────────────────────────────────────
  p('{d.เนื้อหา}', { indent: 567, spaceAfter: 240 }),
  p('ด้วยความเคารพ', { indent: 567, spaceAfter: 240 }),

  // ── สิ่งที่แนบ ──────────────────────────────────────────────────
  p('สิ่งที่แนบมาด้วย', { indent: 567, spaceAfter: 120 }),
  p('1.\t{d.สิ่งที่แนบ_1}', { indent: 567, spaceAfter: 60 }),
  p('2.\t{d.สิ่งที่แนบ_2}', { indent: 567, spaceAfter: 360 }),

  // ── ลงนาม ───────────────────────────────────────────────────────
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
console.log('เขียน', OUT, zip.length, 'ไบต์')
