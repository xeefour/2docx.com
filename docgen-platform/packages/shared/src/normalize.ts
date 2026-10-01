/**
 * ทำให้แม่แบบภาษาไทยกระจายย่อหน้าได้จริงตอนแปลงเป็น PDF
 *
 * ── ปัญหาที่แก้ ────────────────────────────────────────────────
 * Word มีค่า `w:jc val="thaiDistribute"` สำหรับ "กระจายทั้งบรรทัด"
 * แต่ **LibreOffice (ซึ่ง Carbone ใช้แปลงเป็น PDF) ไม่รองรับค่านี้**
 *
 * ผลจากการวัดจริง (tests/part-09-thai-distribute):
 *   ไม่ตั้ง          → กระจาย 2/3 บรรทัด · เหลือขวา 7.1 จุด
 *   thaiDistribute   → กระจาย 2/3 บรรทัด · เหลือขวา 7.1 จุด  ← เหมือนไม่ตั้ง
 *   both             → กระจาย 3/3 บรรทัด · เหลือขวา -0.2 จุด  ← สมบูรณ์
 *
 * ── สำคัญ: เรียกตอนส่งออก PDF เท่านั้น ห้ามเรียกตอนอัปโหลดแม่แบบ ──
 * Carbone **คงค่า `w:jc` เดิมทุกประการ** ในไฟล์ที่ส่งออก
 * ถ้าแก้แม่แบบเป็น `both` ตั้งแต่ตอนอัปโหลด เอกสาร `.docx` ที่ส่งมอบ
 * จะกลายเป็น "ชิดขอบทั้งสองด้าน" แทน "กระจาย" — เสียการจัดวางแบบไทยของ Word
 * (ดู tests/README-DockerHub.md หัวข้อ "สำคัญ — อย่าแก้แม่แบบเป็น both")
 *
 * ── ขอบเขต ─────────────────────────────────────────────────────
 * · แก้เฉพาะค่าที่ **LibreOffice ไม่รู้จัก** ให้เป็น `both` (ดูรายการ UNSUPPORTED ด้านล่าง)
 * · **ไม่ใช้ `left` เป็นค่าแทน** — `left` คือผลลัพธ์เดียวกับ "ไม่ได้ตั้งอะไร"
 *   คือปล่อยให้ย่อหน้ายาวลงไปชิดซ้าย ซึ่งไม่ใช่เอกสารราชการที่ถูกต้อง
 * · **ไม่แตะ** `left` `center` `right` — หัวเรื่อง/ป้ายกำกับต้องชิดซ้ายหรือกึ่งกลาง
 * · ไม่แตะ `distribute` → ตั้งเป็น `both` เพราะ `distribute` ยืดบรรทัดสุดท้ายด้วย
 *   ซึ่งผิดหลักการพิมพ์เอกสารราชการ (บรรทัดสุดท้ายของย่อหน้าต้องชิดซ้าย)
 * · ไม่แตะย่อหน้าที่ไม่ได้ตั้งค่าไว้ (ใช้ค่า default ตามสไตล์ของเอกสาร)
 *   เดาให้จะทำให้หัวเรื่องและช่องลงนามถูกยืดผิด
 */

import { unzipSync, zipSync, strFromU8, strToU8 } from 'fflate'

/** ค่า w:jc ที่ LibreOffice ไม่รู้จัก → ค่าที่ใช้แทนได้จริง */
const UNSUPPORTED: Record<string, string> = {
  thaiDistribute: 'both',
  distribute: 'both',
  justifyLow: 'both',
  highKashida: 'both',
  mediumKashida: 'both',
  lowKashida: 'both',
  thaiDistributeVertical: 'both',
}

/** ส่วนของ docx ที่มีการจัดวางย่อหน้า */
const PARTS = [
  /^word\/document\.xml$/,
  /^word\/header\d*\.xml$/,
  /^word\/footer\d*\.xml$/,
  /^word\/footnotes\.xml$/,
  /^word\/endnotes\.xml$/,
]

export type NormalizeResult = {
  /** เปลี่ยนจริงหรือไม่ */
  changed: boolean
  /** แผนที่ ค่าเดิม → ค่าใหม่ พร้อมจำนวนที่แก้ */
  replaced: Record<string, number>
  /** จำนวนย่อหน้าที่แตะทั้งหมด */
  scanned: number
}

/** แปลงค่า w:jc ใน XML หนึ่งชิ้น */
function patchXml(xml: string, tally: Record<string, number>): { xml: string; count: number } {
  let count = 0

  const out = xml.replace(
    /<w:jc\s+w:val="([^"]+)"/g,
    (full, val: string) => {
      const to = UNSUPPORTED[val]
      if (!to) return full
      count++
      tally[`${val}→${to}`] = (tally[`${val}→${to}`] ?? 0) + 1
      return `<w:jc w:val="${to}"`
    },
  )

  return { xml: out, count }
}

/**
 * แก้การจัดย่อหน้าให้ LibreOffice เข้าใจ
 *
 * ⚠️ ถ้าไฟล์ไม่ใช่ zip (doc/docf) จะคืนไฟล์เดิม ไม่ throw
 *    เพราะผู้ใช้อาจอัปโหลดไฟล์ที่แก้ไม่ได้ — ให้ผ่านไปดีกว่าล้มทั้งคำขอ
 */
export function normalizeThaiAlignment(buf: Buffer): { buf: Buffer; result: NormalizeResult } {
  const empty: NormalizeResult = { changed: false, replaced: {}, scanned: 0 }

  let files: Record<string, Uint8Array>
  try {
    files = unzipSync(new Uint8Array(buf))
  } catch {
    return { buf, result: empty }
  }

  const tally: Record<string, number> = {}
  let changedAny = false
  let scanned = 0

  for (const [name, data] of Object.entries(files)) {
    if (!PARTS.some((re) => re.test(name))) continue

    const before = strFromU8(data)
    const { xml, count } = patchXml(before, tally)
    scanned += (before.match(/<w:jc\s+w:val="/g) ?? []).length

    if (count > 0) {
      files[name] = strToU8(xml)
      changedAny = true
    }
  }

  return {
    buf: changedAny ? Buffer.from(zipSync(files)) : buf,
    result: { changed: changedAny, replaced: tally, scanned },
  }
}
