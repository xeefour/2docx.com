/**
 * ตั้งภาษาของข้อความไทยในไฟล์ .docx ให้ถูกต้อง
 *
 * ── ปัญหาที่แก้ ────────────────────────────────────────────────
 * เอกสารราชการไทยที่ระบบสร้าง เปิดใน Word/LibreOffice แล้วข้อความไทย
 * ขึ้นเส้นหยักสีแดง (spell-check ตีความว่าสะกดผิด)
 *
 * สาเหตุไม่ใช่ตัวสะกด แต่เป็น **ภาษาของ run**:
 *   ตรวจไฟล์จริงที่ระบบสร้าง → `word/styles.xml` ตั้งค่าเริ่มต้นไว้ที่
 *   `<w:lang w:val="en-US" w:eastAsia="en-US" w:bidi="ar-SA"/>`
 *   และ **ไม่มี run ไหน override เลย** → ทุก run สืบทอด `en-US`
 *   Word/LibreOffice จึงเอาพจนานุกรมอังกฤษมาตรวจข้อความไทย → ขึ้นตัวแดงทั้งบรรทัด
 *
 * ── วิธีแก้ ─────────────────────────────────────────────────────
 * ใส่ `<w:lang w:val="th-TH"/>` ใน `w:rPr` ของ **run ที่เป็นภาษาไทยเป็นหลัก**
 *
 * ── ทำไมไม่แก้ที่ค่าเริ่มต้นของทั้งเอกสาร ─────────────────────────
 * ถ้าแก้ `docDefaults` เป็น th-TH ตรง ๆ ข้อความ**อังกฤษ** ในเอกสารเดียวกัน
 * (เช่น "Ref. No. 1234/2569", อีเมล) จะกลายเป็นตัวที่โดนตรวจสะกดแทน
 * การกำหนดทีละ run ตามภาษาของข้อความจริง จึงไม่กระทบส่วนอื่นของเอกสาร
 *
 * ── ขอบเขต ─────────────────────────────────────────────────────
 * · แก้เฉพาะค่า `w:val` — **ไม่แตะ `w:eastAsia`**
 *   เพราะ `w:eastAsia` เป็นตัวกำหนดว่าเครื่องมือจะเลือกฟอนต์ตระกูลให้
 *   ถ้าแตะแล้วอาจเปลี่ยนหน้าตาเอกสารทั้งฉบับ
 * · เรียกตอนส่งออก **.docx เท่านั้น** — PDF ไม่มีเส้นตรวจสะกด
 * · ถ้าไฟล์ไม่ใช่ zip หรือแก้ไม่ได้ จะคืนไฟล์เดิม ไม่ throw
 *   เพราะการตั้งภาษาไม่สำคัญพอที่จะให้งานเรนเดอร์ล้มทั้งฉบับ
 *
 * (คนละเรื่องกับ `normalizeThaiAlignment` ซึ่งแก้การจัดย่อหน้าเฉพาะตอนส่งออก PDF
 *  ดูไฟล์นั้นเพื่อเปรียบเทียบว่าทำไมต้องแยกทาง)
 */

import { unzipSync, zipSync, strFromU8, strToU8 } from 'fflate'

/** ส่วนของ docx ที่มีข้อความให้โปรแกรมตรวจสะกด */
const PARTS = [
  /^word\/document\.xml$/,
  /^word\/header\d*\.xml$/,
  /^word\/footer\d*\.xml$/,
  /^word\/footnotes\.xml$/,
  /^word\/endnotes\.xml$/,
]

/** เอกสารภาษาไทยใช้รหัสนี้ (Word/LibreOffice เขียนแบบนี้เอง) */
const TH = 'th-TH'

export type SetLanguageResult = {
  /** เปลี่ยนจริงหรือไมอ */
  changed: boolean
  /** จำนวน run ที่ตั้งภาษาใหม่ */
  runs: number
  /** จำนวน run ที่มีตัวไทยแต่ข้อความเป็นอังกฤษมากกว่า (ไม่แตะ) */
  skippedMixed: number
  /** จำนวน run ที่มีภาษาไทยอยู่แล้ว */
  alreadyThai: number
}

const EMPTY: SetLanguageResult = { changed: false, runs: 0, skippedMixed: 0, alreadyThai: 0 }

/** นับอักษรไทย (ช่วง U+0E00–U+0E7F ครอบทั้งภาษาไทย) */
const THAI = /[\u0E00-\u0E7F]/
/** นับอักษรละตินที่ใช้ตรวจสะกด */
const LATIN = /[A-Za-z]/

/** ข้อความทั้งหมดใน run (รวมหลาย `w:t` ซึ่ง Word แยกตามรูปแบบตัวอักษร) */
function textOf(runBody: string): string {
  let out = ''
  for (const m of runBody.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)) {
    out += m[1] ?? ''
  }
  return out
}

const count = (s: string, re: RegExp): number => (s.match(new RegExp(re, 'g')) ?? []).length

/**
 * ตาม schema CT_RPr (ECMA-376 §17.3.2.28) `w:lang` อยู่ท้าย ๆ ของ rPr
 * คือหลัง `w:em` แต่ **ก่อน** ตัวเหล่านี้
 *
 * ⚠️ จุดที่พลาดง่ายที่สุดคือ `w14:ligatures` — แม่แบบราชการเกือบทุกฉบับมี
 *   (Word ใส่ไว้เพื่อกัน ligature) และมันเป็น element ของ namespace อื่น
 *   ซึ่ง Word คาดว่าอยู่ "ท้ายสุด" ถ้าเราแทรก `w:lang` ทีหลังมัน
 *   Word จะมองว่าลำดับผิดและขึ้น "มีเนื้อหาที่อ่านไม่ได้" ตอนเปิดไฟล์
 *   (LibreOffice ใจดีกว่า เปิดได้เฉย ๆ ทำให้พลาดได้ง่าย)
 */
const AFTER_LANG = new Set(['w:eastAsianLayout', 'w:specVanish', 'w:oMath', 'w:rPrChange'])

/** ตำแหน่งที่จะแทรก `w:lang` ใน rPr — คืนดัชนะใน inner XML (แทรกก่อนค่านี้) */
function insertOffset(inner: string): number {
  let at = inner.length
  for (const m of inner.matchAll(/<([A-Za-z0-9]+:[A-Za-z0-9]+|[A-Za-z0-9]+)[\s/>]/g)) {
    const tag = m[1] ?? ''
    // namespace อื่น (w14:, w15:, w16*, mc:) ไม่ใช่ส่วนหนึ่งของ CT_RPr → ต้องอยู่ท้าย
    if (!tag.startsWith('w:') || AFTER_LANG.has(tag)) {
      at = m.index
      break
    }
  }
  return at
}

/** เขียน `w:lang` ให้เป็นภาษาไทย โดยคง attribute อื่น (w:eastAsia, w:bidi) ไว้ */
function setVal(tag: string): string {
  if (/\sw:val\s*=/.test(tag)) {
    return tag.replace(/\sw:val\s*=\s*"[^"]*"/, ` w:val="${TH}"`)
  }
  return tag.replace(/^<w:lang/, `<w:lang w:val="${TH}"`)
}

/** ใส่หรือแก้ `w:lang` ใน rPr ของ run (คืน null ถ้าไม่ควรแก้) */
function patchRun(runBody: string): { body: string; action: 'set' | 'already' | 'skip' } | null {
  const text = textOf(runBody)
  if (!text) return null

  const thai = count(text, THAI)
  if (thai === 0) return null

  const latin = count(text, LATIN)

  // ข้อความผสมที่เป็นอังกฤษมากกว่า → ปล่อยไว้ ไม่ให้สลับว่าอันไหนโดนตรวจสะกด
  if (latin > thai) return { body: runBody, action: 'skip' }

  // 1) มี w:lang อยู่แล้ว → แก้เฉพาะค่า w:val ที่ตำแหน่งเดิม (ไม่ย้าย กันสับสน)
  const existing = runBody.match(/<w:lang\b[^>]*\/>/)
  if (existing) {
    if (existing[0].includes(`w:val="${TH}"`)) return { body: runBody, action: 'already' }
    return { body: runBody.replace(existing[0], setVal(existing[0])), action: 'set' }
  }

  const langTag = `<w:lang w:val="${TH}"/>`

  // 2) มี rPr → แทรกตรงตำแหน่งที่ schema กำหนด
  const rpr = runBody.match(/(<w:rPr(?:\s[^>]*)?>)([\s\S]*?)(<\/w:rPr>)/)
  if (rpr?.[2] !== undefined) {
    const [full = '', open = '', inner0 = '', close = ''] = rpr
    const at = insertOffset(inner0)
    const inner = inner0.slice(0, at) + langTag + inner0.slice(at)
    return { body: runBody.replace(full, `${open}${inner}${close}`), action: 'set' }
  }

  // 3) rPr แบบว่าง `<w:rPr/>` → ต้องขยายก่อน ไม่งั้นจะได้สอง rPr ซ้อนกัน
  if (/<w:rPr(?:\s[^>]*)?\/>/.test(runBody)) {
    return { body: runBody.replace(/<w:rPr(\s[^>]*)?\/>/, `<w:rPr$1>${langTag}</w:rPr>`), action: 'set' }
  }

  // 4) ไม่มี rPr → สร้างใหม่เป็นลูกแรกของ run (ตาม schema rPr ต้องมาก่อนเนื้อหา)
  return { body: runBody.replace(/^/, `<w:rPr>${langTag}</w:rPr>`), action: 'set' }
}

/** แก้ภาษาของ run ทั้งหมดใน XML หนึ่งชิ้น */
function patchXml(xml: string, tally: SetLanguageResult): { xml: string; changed: boolean } {
  let changed = false

  const out = xml.replace(
    /(<w:r(?:\s[^>]*)?>)([\s\S]*?)(<\/w:r>)/g,
    (_full, open: string, body: string, close: string) => {
      const patched = patchRun(body)
      if (!patched) return `${open}${body}${close}`

      if (patched.action === 'skip') {
        tally.skippedMixed++
        return `${open}${body}${close}`
      }
      if (patched.action === 'already') {
        tally.alreadyThai++
        return `${open}${body}${close}`
      }

      tally.runs++
      changed = true
      return `${open}${patched.body}${close}`
    },
  )

  return { xml: out, changed }
}

/**
 * ตั้งภาษาไทยให้ run ที่เป็นภาษาไทยในไฟล์ .docx
 *
 * @param buf ไฟล์ .docx (zip)
 * @returns ไฟล์ใหม่ (ถ้าเปลี่ยน) พร้อมสรุปว่าแก้ไปเท่าไร
 */
export function setDocxThaiLanguage(buf: Buffer): { buf: Buffer; result: SetLanguageResult } {
  const tally: SetLanguageResult = { ...EMPTY }

  let files: Record<string, Uint8Array>
  try {
    files = unzipSync(new Uint8Array(buf))
  } catch {
    return { buf, result: tally }
  }

  let changedAny = false

  for (const [name, data] of Object.entries(files)) {
    if (!PARTS.some((re) => re.test(name))) continue

    const { xml, changed } = patchXml(strFromU8(data), tally)
    if (changed) {
      files[name] = strToU8(xml)
      changedAny = true
    }
  }

  return {
    buf: changedAny ? Buffer.from(zipSync(files)) : buf,
    result: { ...tally, changed: changedAny },
  }
}
