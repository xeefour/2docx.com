/**
 * แปลงข้อความช่วงหน้าที่ผู้ใช้พิมพ์ → รายการเลขหน้าจริง
 *
 * รูปแบบที่รับ (คนไทยพิมพ์ติด ๆ กันจริง)
 *   `1-3, 5, 8-`   → หน้า 1,2,3,5,8,9,10… ไปจนหน้าสุดท้าย
 *   `ทั้งหมด` / ค่าว่าง → ทุกหน้า
 *   `2,2,1`        → เรียงให้ ไม่มีซ้ำ
 *
 * ── ทำไมต้องเขียนเอง ไม่ใช้ `String.split` ธรรมดา ────────────────────
 *   ผู้ใช้พิมพ์ผิดบ่อย (`1-`, `-3`, `abc`, `0`, `999`) และการสะดุดคือเสียหายกว่าการเดา
 *   → คืน error เป็นข้อความไทยให้ UI แสดง ไม่ใช่ throw ลอย ๆ ไปที่ console
 */

export type RangeResult =
  | { ok: true; pages: number[]; spec: string }
  | { ok: false; reason: string }

/** ไม่มีอะไรพิมพ์ = ทุกหน้า */
export const ALL_PAGES = ''

/** เช็คว่าเป็นตัวเลขล้วน (ไม่รับทศนิยม ไม่รับเลขไทย ๐-๙) */
const isInt = (s: string) => /^\d+$/.test(s)

/**
 * @param spec ข้อความที่ผู้ใช้พิมพ์ เช่น `1-3, 5`
 * @param total จำนวนหน้าทั้งหมดของเอกสาร
 */
export function parsePageRange(spec: string, total: number): RangeResult {
  const text = spec.trim()
  if (!text) {
    return { ok: true, pages: allPages(total), spec }
  }
  if (total <= 0) {
    return { ok: false, reason: 'เอกสารนี้ยังไม่มีหน้าให้เลือก' }
  }

  const picked = new Set<number>()
  for (const chunk of text.split(',')) {
    const part = chunk.trim()
    if (!part) continue // `1,,3` — ข้ามว่างเปล่าไป ไม่ต้องถือว่าผิด

    const dash = part.indexOf('-')
    if (dash === -1) {
      if (!isInt(part)) return bad(part, 'ต้องเป็นตัวเลข')
      const n = Number(part)
      if (n < 1) return bad(part, 'หน้าเริ่มที่ 1')
      if (n > total) return bad(part, `เอกสารมีแค่ ${total} หน้า`)
      picked.add(n)
      continue
    }

    const a = part.slice(0, dash).trim()
    const b = part.slice(dash + 1).trim()

    // `8-` = จากหน้า 8 ไปจนสุด · `-3` = ตั้งแต่แรกถึงหน้า 3
    const from = a === '' ? 1 : isInt(a) ? Number(a) : NaN
    const to = b === '' ? total : isInt(b) ? Number(b) : NaN

    if (Number.isNaN(from)) return bad(a || '-', 'ตัวเลขก่อนเครื่องหมาย – ไม่ถูกต้อง')
    if (Number.isNaN(to)) return bad(b || '-', 'ตัวเลขหลังเครื่องหมาย – ไม่ถูกต้อง')
    if (from < 1) return bad(a, 'หน้าเริ่มที่ 1')
    // ⚠️ ต้องเช็ค `to` ด้วย ไม่งั้น `-0` จะตกไปโดนข้อความ "ช่วงกลับด้าน"
    //    ซึ่งทำให้ผู้ใช้แก้ผิดทาง (คิดว่าเป็นปัญหาเรียงลำดับ)
    if (to < 1) return bad(b, 'หน้าเริ่มที่ 1')
    if (to > total) return bad(b, `เอกสารมีแค่ ${total} หน้า`)
    if (from > to) return bad(part, 'ช่วงกลับด้าน (เช่น 5-1)')

    for (let n = from; n <= to; n++) picked.add(n)
  }

  if (picked.size === 0) return { ok: false, reason: 'ยังไม่ได้เลือกหน้าใด' }
  return { ok: true, pages: [...picked].sort((x, y) => x - y), spec }
}

const bad = (part: string, why: string): RangeResult => ({
  ok: false,
  reason: `“${part}” ${why}`,
})

export function allPages(total: number): number[] {
  return Array.from({ length: Math.max(0, total) }, (_, i) => i + 1)
}

/** ข้อความอธิบายว่าเลือกไว้กี่หน้า เช่น "3 จาก 8 หน้า" */
export function describeSelection(pages: number[], total: number): string {
  if (pages.length === 0) return 'ยังไม่ได้เลือกหน้า'
  if (pages.length === total) return `ทั้งหมด ${total} หน้า`
  return `${pages.length} จาก ${total} หน้า`
}

/** ชื่อไฟล์ที่สื่อว่าเป็นช่วงหน้า เช่น `เอกสาร-หน้า 1-3.pdf` · ทั้งหมดก็ใช้ชื่อเดิม */
export function pageSuffix(pages: number[], total: number): string {
  if (pages.length === total) return ''
  if (pages.length === 1) return `-หน้า${pages[0]}`
  return `-หน้า${pages[0]}-${pages[pages.length - 1]}`
}
