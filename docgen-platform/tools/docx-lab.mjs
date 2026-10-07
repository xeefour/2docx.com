/**
 * docx-lab — เครื่องมือสร้าง/ยิง/อ่านไฟล์ .docx สำหรับพิสูจน์ตัวอย่างในคู่มือ
 * =====================================================================
 *
 * ทำไมต้องมีไฟล์นี้
 * --------------
 * คู่มือที่ /docs เขียนตัวอย่างไว้เป็นจำนวนมาก ถ้าเขียนจากเอกสารของ Carbone
 * อย่างเดียว มีโอกาสสูงที่ตัวอย่างจะผิด (เช่น ชื่อ formatter ที่เลิกใช้แล้ว
 * หรือไวยากรณ์ argument ที่ไม่ตรงกับเวอร์ชันที่ระบบใช้จริง)
 * เครื่องมือนี้จึงทำงาน 3 ขั้น:
 *
 *   1. สร้างไฟล์ .docx ขึ้นใหม่จากโครงสร้างที่เขียนไว้ในสคริปต์ (ไม่ต้องมี Word)
 *   2. ส่งเข้า docserver ตัวจริงที่รันอยู่ ให้เติมข้อมูลจริง
 *   3. อ่านข้อความจาก .docx ที่ได้กลับมา เทียบกับค่าที่คาดไว้
 *
 * ถ้าตัวอย่างใด ๆ ในคู่มือผิดจริง สคริปต์นี้จะตก ไม่ใช่แค่ "ดูเหมือนจะถูก"
 *
 * ใช้งาน
 * ------
 *   node tools/docx-lab.mjs              รันเครื่องมือครบทุกส่วน (doctor)
 *   DOCSERVER=http://127.0.0.1:4000 node tools/docx-lab.mjs
 */

import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate'

// ─────────────────────────────────────────────────────────────
// การตั้งค่า
// ─────────────────────────────────────────────────────────────

export const DOCSERVER = process.env.DOCSERVER ?? 'http://127.0.0.1:4000'
export const DOCSERVER_KEY = process.env.DOCSERVER_KEY ?? 'carbon-ce'

/** ฟอนต์ไทยที่ทุกเครื่องที่เรนเดอร์ต้องมี — ใช้ตัวนี้ในตัวสร้างไฟล์ */
const FONT = process.env.LAB_FONT ?? 'TH Sarabun New'
/** ขนาดฟอนต์ (ครึ่งพอยต์: 32 = 16 pt) */
const SZ = '32'

/** เวลาหน่วงระหว่างคำขอเรนเดอร์ (มิลลิวินาที) — กัน docserver ล้ม */
const RENDER_GAP_MS = Number(process.env.LAB_GAP_MS ?? 350)

// ─────────────────────────────────────────────────────────────
// สร้างไฟล์ .docx
// ─────────────────────────────────────────────────────────────
//
// ทำเองทั้งหมดเพราะต้องการให้โครงสร้างตาราง/หัวกระดาษ/ท้ายกระดาษอยู่ในมือ
// ไม่ต้องพึ่ง python-docx ที่ต้องติดตั้งแยก

const esc = (s) =>
  String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')

/** เรียงเป็นหนึ่งบรรทัด รันต่อกันคือย่อหน้าเดียว */
const run = (text) =>
  `<w:r><w:rPr><w:rFonts w:ascii="${FONT}" w:hAnsi="${FONT}" w:cs="${FONT}" w:eastAsia="${FONT}"/><w:sz w:val="${SZ}"/><w:szCs w:val="${SZ}"/></w:rPr>` +
  `<w:t xml:space="preserve">${esc(text)}</w:t></w:r>`

const para = (text = '') => `<w:p><w:pPr><w:spacing w:after="80"/></w:pPr>${run(text)}</w:p>`

const cell = (text) =>
  `<w:tc><w:tcPr><w:tcW w:w="3000" w:type="dxa"/></w:tcPr>${para(text)}</w:tc>`

const row = (cells) => `<w:tr>${cells.map(cell).join('')}</w:tr>`

const BORDER =
  '<w:tblBorders>' +
  ['top', 'left', 'bottom', 'right', 'insideH', 'insideV']
    .map((s) => `<w:${s} w:val="single" w:sz="6" w:space="0" w:color="000000"/>`)
    .join('') +
  '</w:tblBorders>'

/** ตาราง — ทุกแถวมีจำนวนช่องเท่ากัน */
const table = (rows) => {
  const n = rows[0].length
  const grid = Array.from({ length: n }, () => '<w:gridCol w:w="3000"/>').join('')
  return (
    `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/>${BORDER}</w:tblPr>` +
    `<w:tblGrid>${grid}</w:tblGrid>` +
    rows.map(row).join('') +
    '</w:tbl>' +
    // Word บังคับว่าตารางต้องมีย่อหน้าต่อท้าย ไม่งั้นไฟล์เปิดไม่ได้
    '<w:p><w:pPr><w:spacing w:after="0"/></w:pPr></w:p>'
  )
}

const SECTPR =
  '<w:sectPr>' +
  '<w:headerReference w:type="default" r:id="rIdHdr1"/>' +
  '<w:footerReference w:type="default" r:id="rIdFtr1"/>' +
  '<w:pgSz w:w="11906" w:h="16838"/>' +
  '<w:pgMar w:top="1701" w:right="1418" w:bottom="1418" w:left="1701" w:header="709" w:footer="709" w:gutter="0"/>' +
  '</w:sectPr>'

const documentXml = (body, extra = '') =>
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ' +
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
  `<w:body>${body}${extra}${SECTPR}</w:body></w:document>`

const hdrFtrXml = (tag, body) =>
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  `<w:${tag} xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ` +
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
  `${body}</w:${tag}>`

const CONTENT_TYPES =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
  '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
  '<Default Extension="xml" ContentType="application/xml"/>' +
  '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
  '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>' +
  '<Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/>' +
  '<Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/>' +
  '</Types>'

const ROOT_RELS =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
  '</Relationships>'

const DOC_RELS =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
  '<Relationship Id="rIdHdr1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/>' +
  '<Relationship Id="rIdFtr1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/>' +
  '</Relationships>'

const STYLES =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
  '<w:docDefaults><w:rPrDefault><w:rPr>' +
  `<w:rFonts w:ascii="${FONT}" w:hAnsi="${FONT}" w:cs="${FONT}" w:eastAsia="${FONT}"/>` +
  `<w:sz w:val="${SZ}"/><w:szCs w:val="${SZ}"/>` +
  '</w:rPr></w:rPrDefault>' +
  '<w:pPrDefault><w:pPr><w:spacing w:after="80" w:line="240" w:lineRule="auto"/></w:pPr></w:pPrDefault>' +
  '</w:docDefaults>' +
  '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>' +
  '</w:styles>'

/**
 * ประกอบไฟล์ .docx เป็น buffer
 *
 * @param {object} o
 * @param {string[]} o.blocks  ย่อหน้าทั่วไป (แทนด้วยตารางด้านล่าง)
 * @param {string[]} [o.tables]  ตาราง แต่ละอันคือ array ของแถว แต่ละแถวคือ array ของช่อง
 * @param {string}   [o.header]  ข้อความในส่วนหัวเอกสาร
 * @param {string}   [o.footer]  ข้อความในส่วนท้ายเอกสาร
 * @returns {Buffer}
 */
export function buildDocx({ blocks = [], tables = [], header = '', footer = '' }) {
  const body = blocks.map(para).join('') + tables.map(table).join('')
  const files = {
    '[Content_Types].xml': strToU8(CONTENT_TYPES),
    '_rels/.rels': strToU8(ROOT_RELS),
    'word/_rels/document.xml.rels': strToU8(DOC_RELS),
    'word/styles.xml': strToU8(STYLES),
    'word/document.xml': strToU8(documentXml(body)),
    'word/header1.xml': strToU8(hdrFtrXml('hdr', para(header))),
    'word/footer1.xml': strToU8(hdrFtrXml('ftr', para(footer))),
  }
  return Buffer.from(zipSync(files, { level: 6 }))
}

// ─────────────────────────────────────────────────────────────
// อ่านข้อความกลับจาก .docx
// ─────────────────────────────────────────────────────────────

/**
 * แปลง entity ใน XML ให้เป็นตัวอักษรจริง
 *
 * ⚠️ ถอดแค่ชั้นเดียว อย่าวนจนกว่าจะหาย
 *   เมื่อผู้ใช้ใส่เครื่องหมายคำพูดคู่ใน tag Carbone จะ escape ซ้ำสองชั้น
 *   ในไฟล์ .docx จะเป็น &amp;quot; และ Word จะแสดงผลเป็นตัวอักษร &quot; ให้ผู้ใช้เห็น
 *   ตัวอ่านของเราต้องแสดงผลตรงกับสิ่งที่ผู้ใช้เห็นจริงเสมอ
 *   ถ้าวนถอดซ้ำ ข้อความที่ผิดจะกลายเป็นข้อความที่ถูก แล้วเกณฑ์จะผ่านทั้งที่เอกสารเพี้ยน
 */
const decodeEntities = (s) =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, '&')

/**
 * ดึงข้อความทั้งหมดจาก .docx คืนเป็นบรรทัดต่อย่อหน้า
 *
 * @param {Buffer} buf
 * @param {string[]} [parts]  ส่วนที่ต้องการอ่าน ค่าเริ่มต้นคือเนื้อหาหลัก
 * @returns {string[]}
 */
export function extractLines(buf, parts = ['word/document.xml']) {
  const files = unzipSync(new Uint8Array(buf))
  const out = []
  for (const part of parts) {
    const xml = strFromU8(files[part])
    if (!xml) continue
    // แยกเป็นย่อหน้าก่อน แล้วค่อยดูดข้อความในย่อหน้านั้น
    for (const p of xml.split('</w:p>')) {
      const text = [...p.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)]
        .map((m) => decodeEntities(m[1]))
        .join('')
      if (text.trim()) out.push(text)
    }
  }
  return out
}

// ─────────────────────────────────────────────────────────────
// ยิงเข้า docserver จริง
// ─────────────────────────────────────────────────────────────

function headers() {
  return { Authorization: `Bearer ${DOCSERVER_KEY}`, 'carbone-version': '5' }
}

/**
 * ส่ง .docx เข้า docserver ให้เติมข้อมูล แล้วคืนไฟล์ที่ได้กลับมา
 *
 * ใช้ POST /render/template?download=true ซึ่งคืนไฟล์ที่แปลงเสร็จในคำตอบเดียว
 * ไม่ต้องอัปโหลดแม่แบบเข้าฐานข้อมูล และไม่ต้องดึงไฟล์สองรอบ
 *
 * ⚠️ ต้องหน่วงระหว่างคำขอ
 *   docserver ตัวนี้ตั้ง instanceMaxFiles ไว้ 200 ไฟล์
 *   ถ้ายิงรัว ๆ โดยไม่หน่วง มันจะตัวเองและทำให้ทุกเคสที่เหลือพังพร้อมกัน
 *   (อาการคือ fetch failed ทั้งชุด ไม่ใช่ผลที่ผิดจริง)
 *
 * @param {Buffer} docx
 * @param {object} data
 * @param {string} [convertTo]  'docx' | 'pdf'
 * @param {object} [extra]      ตัวเลือกอื่น เช่น lang, timezone
 * @returns {Promise<Buffer>}
 */
export async function render(docx, data, convertTo = 'docx', extra = {}) {
  const body = JSON.stringify({ template: docx.toString('base64'), data, convertTo, ...extra })
  const wait = (ms) => new Promise((r) => setTimeout(r, ms))
  await wait(RENDER_GAP_MS)

  let lastErr
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(`${DOCSERVER}/render/template?download=true`, {
        method: 'POST',
        headers: { ...headers(), 'Content-Type': 'application/json' },
        body,
        signal: AbortSignal.timeout(120_000),
      })
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        // docserver ตอบเป็น JSON ที่มีข้อความ error อยู่ข้างใน
        // ดึงมาแตกเป็นข้อความล้วน ๆ จะได้เทียบกับรูปแบบได้ง่ายกว่า
        // (เดิมเหลือ escape \" ทำให้ regex ที่เขียนไว้ไม่ตรง)
        let msg = text
        try {
          const parsed = JSON.parse(text)
          if (parsed?.error) msg = String(parsed.error)
        } catch {
          /* ไม่ใช่ JSON ก็ใช้ข้อความดิบ */
        }
        throw new Error(`docserver ตอบ ${res.status}: ${msg.slice(0, 300)}`)
      }
      return Buffer.from(await res.arrayBuffer())
    } catch (err) {
      // ลองใหม่เฉพาะเมื่อต่อไม่ได้ ไม่ใช่เมื่อ docserver ตอบว่าผิด
      if (!/fetch failed|ECONNREFUSED|ECONNRESET|socket hang up|timeout/i.test(err.message)) throw err
      lastErr = err
      await wait(3000 * attempt)
    }
  }
  throw lastErr
}

/**
 * รันเทสต์หนึ่งเคส: สร้างไฟล์ → เรนเดอร์ → ดึงข้อความ → เทียบ
 *
 * @param {object} c
 * @param {string}   c.name
 * @param {object}   c.template   { blocks, tables, header, footer }
 * @param {object}   c.data
 * @param {string[]} c.expect     ข้อความที่ต้องมี
 * @param {string[]} [c.reject]    ข้อความที่ต้องไม่มี
 * @param {string[]} [c.parts]     ส่วนที่อ่าน
 * @returns {Promise<{ok:boolean, detail:string, lines:string[]}>}
 */
export async function checkCase(c) {
  let buf
  try {
    buf = await render(buildDocx(c.template), c.data, c.convertTo ?? 'docx', c.options ?? {})
  } catch (err) {
    return { ok: false, detail: `เรนเดอร์ไม่สำเร็จ: ${err.message}`, lines: [] }
  }
  let lines
  try {
    lines = extractLines(buf, c.parts)
  } catch (err) {
    return { ok: false, detail: `อ่านไฟล์ไม่ได้: ${err.message}`, lines: [] }
  }
  const all = lines.join('\n')
  const missing = (c.expect ?? []).filter((e) => !all.includes(e))
  const present = (c.reject ?? []).filter((e) => all.includes(e))
  if (missing.length || present.length) {
    const why = [
      missing.length ? `ไม่พบ: ${missing.map((m) => JSON.stringify(m)).join(', ')}` : '',
      present.length ? `เจอสิ่งที่ไม่ควรมี: ${present.map((m) => JSON.stringify(m)).join(', ')}` : '',
    ]
      .filter(Boolean)
      .join(' | ')
    return { ok: false, detail: why, lines }
  }
  return { ok: true, detail: '', lines }
}

// ─────────────────────────────────────────────────────────────
// โหมด doctor — ตรวจว่าตัวเครื่องมีอะไรครบไหม
// ─────────────────────────────────────────────────────────────

async function doctor() {
  const rows = []
  const say = (name, ok, detail) => rows.push({ name, ok, detail })

  // 1. ต่อ docserver ได้ไหม
  let version = 'ไม่ทราบ'
  try {
    const r = await fetch(`${DOCSERVER}/`, { headers: headers(), signal: AbortSignal.timeout(15_000) })
    version = (await r.json()).version
    say('ต่อ docserver ได้', true, `${DOCSERVER} → v${version}`)
  } catch (err) {
    say('ต่อ docserver ได้', false, String(err.message))
  }

  // 2. สร้าง .docx เองได้ไหม แล้วเปิดกลับได้ไหม
  try {
    const buf = buildDocx({ blocks: ['สวัสดี'], header: 'หัว', footer: 'ท้าย' })
    const lines = extractLines(buf, ['word/document.xml', 'word/header1.xml', 'word/footer1.xml'])
    const ok = lines.includes('สวัสดี') && lines.includes('หัว') && lines.includes('ท้าย')
    say('สร้าง/อ่าน .docx เองได้', ok, `อ่านได้ ${lines.length} บรรทัด`)
  } catch (err) {
    say('สร้าง/อ่าน .docx เองได้', false, String(err.message))
  }

  // 3. รอบเต็ม: สร้าง → เรนเดอร์ → อ่านกลับ
  try {
    const r = await checkCase({
      name: 'รอบเต็ม',
      template: { blocks: ['ผู้ใช้: {d.name}'], header: '{d.org}' },
      data: { name: 'ทดสอบ', org: 'หน่วยงานทดสอบ' },
      expect: ['ผู้ใช้: ทดสอบ'],
      parts: ['word/document.xml', 'word/header1.xml'],
    })
    say('สร้าง → เรนเดอร์ → อ่านกลับ', r.ok, r.ok ? `ได้: ${r.lines.join(' / ')}` : r.detail)
  } catch (err) {
    say('สร้าง → เรนเดอร์ → อ่านกลับ', false, String(err.message))
  }

  // 4. อ่านส่วนหัว/ท้ายเอกสารได้ไหม (คนละเรื่องกับเนื้อหาหลัก)
  try {
    const r = await checkCase({
      name: 'หัว/ท้าย',
      template: { blocks: ['เนื้อหา'], header: 'หัว {d.a}', footer: 'ท้าย {d.b}' },
      data: { a: 'A', b: 'B' },
      expect: ['หัว A', 'ท้าย B', 'เนื้อหา'],
      parts: ['word/document.xml', 'word/header1.xml', 'word/footer1.xml'],
    })
    say('อ่านหัว/ท้ายเอกสารได้', r.ok, r.ok ? r.lines.join(' / ') : r.detail)
  } catch (err) {
    say('อ่านหัว/ท้ายเอกสารได้', false, String(err.message))
  }

  let pass = 0
  for (const r of rows) {
    console.log(`${r.ok ? 'ผ่าน' : 'ตก  '}  ${r.name}${r.detail ? ' — ' + r.detail : ''}`)
    if (r.ok) pass++
  }
  console.log(`\n${pass}/${rows.length} ผ่าน`)
  process.exit(pass === rows.length ? 0 : 1)
}

// ─────────────────────────────────────────────────────────────

const isMain = process.argv[1]?.replace(/\\/g, '/').endsWith('docx-lab.mjs')
if (isMain) await doctor()