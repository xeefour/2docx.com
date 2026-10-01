/**
 * เขียนทับ metadata ของไฟล์ที่เรนเดอร์ออกมา
 *
 * ── ทำไมต้องทำ ────────────────────────────────────────────────
 * ปล่อยไว้ตามเดิม เอกสารทุกฉบับที่ส่งออกจะติดป้ายชื่อเครื่องมือ:
 *   PDF  → /Producer = "LibreOffice 26.2.4.2"   /Creator = "Writer"
 *   DOCX → Application = "Microsoft Office Word"
 *
 * และที่หนักกว่านั้น — `dc:creator` ใน .docx ต้นแบบถูกส่งต่อมาทุกฉบับ
 * ในของเราเจอชื่อจริงของคนที่ทำแม่แบบปนอยู่ในทุกไฟล์ที่ส่งออกไป
 * นี่คือข้อมูลส่วนบุคคลที่ไม่ควรหลุด
 *
 * ── หลักการ ────────────────────────────────────────────────────
 * · ล้มเหลววิธีไหน **ต้องไม่ทำให้งานพัง** — คืนไฟล์เดิม + log warn
 *   เพราะ metadata เป็นเรื่องความสวยงาม ไม่ควรทำให้เอกสารหาย
 * · เขียนทับเฉพาะช่อง "ใครเป็นคนทำ" ไม่แตะชื่อเรื่อง/คำอธิบายของเอกสาร
 * · รูปภาพไม่แตะ — ไม่มี metadata ให้แก้
 */
import { PDFDocument, type SaveOptions } from 'pdf-lib'
import { unzipSync, zipSync, strToU8, strFromU8, type Zippable } from 'fflate'
import { env } from '@docgen/shared'

/** รูปแบบที่เป็น zip — แก้ XML ข้างในได้ */
const ZIP_FORMATS = new Set(['docx', 'xlsx', 'pptx', 'odt'])

const MIME_ODT = 'application/vnd.oasis.opendocument.text'

const log = (msg: string, meta: Record<string, unknown> = {}) =>
  console.warn(JSON.stringify({ level: 'warn', msg, ...meta }))

/** escape ค่าให้ปลอดภัยก่อนแทรกลง XML — ชื่อแบรนด์อาจมี & ได้ */
function xmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

// ── PDF ────────────────────────────────────────────────────────
async function patchPdf(buf: Buffer): Promise<Buffer> {
  /**
   * ⚠️ `updateMetadata: false` ต้องใส่ที่ **save()** ไม่ใช่แค่ load()
   *
   * ถ้าไม่ใส่ pdf-lib จะเขียนทับ /Producer ด้วยชื่อของตัวเองคืน
   * → ได้ "pdf-lib (https://github.com/Hopding/pdf-lib)" ซึ่งแย่กว่าการไม่ patch เสียอีก
   */
  const pdf = await PDFDocument.load(buf, { updateMetadata: false })

  const brand = env.OUTPUT_BRAND
  pdf.setProducer(brand)
  pdf.setCreator(brand)
  pdf.setAuthor(brand)

  return Buffer.from(
    await pdf.save({
      useObjectStreams: false,
      // ⚠️ pdf-lib ยังไม่ได้ประกาศ `updateMetadata` ใน SaveOptions (types ไม่ครบ)
      //    แต่รันจริงได้ผล — ทดสอบแล้วว่าถ้าไม่ใส่ /Producer จะถูกเขียนทับด้วยชื่อ pdf-lib
      updateMetadata: false,
    } as SaveOptions),
  )
}

// ── zip-based (docx / xlsx / pptx / odt) ───────────────────────
/**
 * แทนเนื้อหาใน element ที่ระบุ
 *
 * regex ใส่ prefix namespace ไว้เป็น optional เพื่อให้จับได้ทั้ง
 * `<dc:creator>` และ `<creator>` โดยไม่ต้องลิสต์ทีละ namespace
 */
function replaceTagText(xml: string, tag: string, value: string): string {
  const re = new RegExp(`(<(?:[\\w-]+:)?${tag}\\b[^>]*>)([\\s\\S]*?)(</(?:[\\w-]+:)?${tag}>)`, 'gi')
  return xml.replace(re, (_full, open: string, _old: string, close: string) => `${open}${value}${close}`)
}

interface TagSpec {
  file: string
  tags: string[]
}

/** ช่องที่เขียนทับในแต่ละเฟอร์แมตตาม */
const ZIP_TAGS: { ooxml: TagSpec[]; odf: TagSpec[] } = {
  // OOXML แยกผู้สร้าง (core) กับโปรแกรมที่ใช้ (app)
  ooxml: [
    { file: 'docProps/core.xml', tags: ['creator', 'lastModifiedBy', 'publisher'] },
    { file: 'docProps/app.xml', tags: ['Application', 'Company', 'Manager'] },
  ],
  // ODF เก็บทุกอย่างไว้ในไฟล์เดียว
  odf: [
    { file: 'meta.xml', tags: ['creator', 'initial-creator', 'publisher', 'generator'] },
  ],
}

function patchZip(buf: Buffer, format: string): Buffer {
  const files = unzipSync(new Uint8Array(buf))
  // format ถูกกรองมาแล้วว่าเป็น zip เสมอ — เลือกชุด tag ตามเฟอร์แมต
  const spec = format === 'odt' ? ZIP_TAGS.odf : ZIP_TAGS.ooxml

  let changed = 0
  for (const { file, tags } of spec) {
    const raw = files[file]
    if (!raw) continue // ไฟล์นี้ไม่มีในเอกสารนี้ — ข้าม ไม่ใช่ error

    const before = strFromU8(raw)
    let after = before
    for (const tag of tags) after = replaceTagText(after, tag, xmlEscape(env.OUTPUT_BRAND))

    if (after !== before) {
      files[file] = strToU8(after)
      changed++
    }
  }

  if (changed === 0) log('ไม่พบช่อง metadata ให้เขียนทับ', { format })

  // ⚠️ ODF บังคับว่า entry `mimetype` ต้องเป็นตัวแรกและห้ามบีบอัด
  //   ถ้าบีบอัดตามทั่วไป LibreOffice จะเปิดไฟล์ไม่ได้
  if (format === 'odt') {
    const input: Zippable = {
      // level: 0 = ไม่บีบอัด (ODF บังคับแบบนี้)
      mimetype: [strToU8(MIME_ODT), { level: 0 }],
    }
    for (const [name, data] of Object.entries(files)) {
      if (name !== 'mimetype') input[name] = data
    }
    return Buffer.from(zipSync(input, { level: 6 }))
  }

  return Buffer.from(zipSync(files, { level: 6 }))
}

/**
 * เขียนทับ metadata ของไฟล์ที่เรนเดอร์เสร็จแล้ว
 *
 * @param buf    ไฟล์ต้นฉบับจาก docserver
 * @param format รูปแบบเป้าหมาย (pdf / docx / odt / xlsx / pptx)
 * @returns ไฟล์ใหม่ — ถ้าแก้ไม่ได้จะคืนไฟล์เดิม
 */
export async function applyBranding(buf: Buffer, format: string): Promise<Buffer> {
  const brand = env.OUTPUT_BRAND.trim()
  if (!brand) return buf

  try {
    if (format === 'pdf') return await patchPdf(buf)
    if (ZIP_FORMATS.has(format)) return patchZip(buf, format)
    return buf // รูปภาพ/อื่น ๆ — ไม่มี metadata ให้แก้
  } catch (err) {
    // ⚠️ คืนไฟล์เดิมเสมอ — metadata เป็นเรื่องความสวยงาม ไม่ควรทำให้เอกสารหาย
    log('เขียนทับ metadata ไม่สำเร็จ — ใช้ไฟล์เดิม', { format, brand, error: String(err) })
    return buf
  }
}
