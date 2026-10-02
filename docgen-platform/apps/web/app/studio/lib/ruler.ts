/**
 * คำนวณจุดขีดของไม้บรรทัด (ruler)
 *
 * แยกเป็นฟังก์ชันบริสุทธิ์ เพื่อทดสอบได้โดยไม่ต้องเปิดเบราว์เซอร์
 * จุดขีดผิดที่ไม่ได้ทดสอบ = ตัวเลขบนไม้บรรทัดผิดทำให้ผู้ใช้วัดผิด
 */

/** PDF ใช้หน่วย pt (point) — 72 pt = 1 นิ้ว */
export const PT_PER_IN = 72
export const CM_PER_IN = 2.54

export type RulerUnit = 'cm' | 'in'

/**
 * ป้ายที่ผู้ใช้เห็นในเมนู
 *
 * ⚠️ เขียนเต็มว่า "เซ็นติเมตร" ไม่ใช่ "ซม." (ผู้ใช้สั่งแก้)
 *   "ซม." เป็นตัวย่อที่ต้องเดา แล้วดูเหมือนตัวเลขหรือหน่วยอื่นในเมนู
 *   ใช้แค่ที่นี่ที่เดียว — ไม้บรรทัดบนกระดาษยังแสดงตัวเลขดิบ ๆ เหมือนเดิม
 */
export const UNITS: Array<{ id: RulerUnit; label: string }> = [
  { id: 'cm', label: 'เซ็นติเมตร' },
  { id: 'in', label: 'นิ้ว' },
]

/** ขนาดหน้ากระดาษจริงในหน่วยที่เลือก */
export function pageUnits(
  widthPt: number,
  heightPt: number,
  unit: RulerUnit,
): { w: number; h: number } {
  const per = unit === 'cm' ? PT_PER_IN / CM_PER_IN : PT_PER_IN // pt ต่อหน่วย
  return { w: widthPt / per, h: heightPt / per }
}

/**
 * เลือกระยะหลักของจุดขีด
 *
 * เงื่อนไข: ตัวเลขต้องไม่ซ้อนกัน
 *   ไม้บรรทัดกว้าง 200px ถ้าขีดทุก 1 ซม. (≈28px) ตัวเลขจะเบียดกันอ่านไม่ออก
 *   จึงต้องเลือกขั้นให้มีพื้นที่ระหว่างตัวเลขอย่างน้อย `MIN_LABEL_GAP` px
 */
export const MIN_LABEL_GAP = 44

export function pickStep(totalUnits: number, px: number): { major: number; minor: number } {
  const fit = Math.max(2, Math.floor(px / MIN_LABEL_GAP))
  const candidates = [0.1, 0.25, 0.5, 1, 2, 5, 10, 20, 50, 100]
  const major = candidates.find((c) => totalUnits / c <= fit) ?? 100
  // ขีดย่อยคือขั้นหลักหาร 5 (0.5 → 0.1, 5 → 1) — ตรงกับที่ Word ทำ
  return { major, minor: major / 5 }
}

export type Ticks = { major: number[]; minor: number[] }

/** รายการค่าที่ต้องขีด ตัดเลขซ้ำจากการปัดทศนิยม */
export function ticks(totalUnits: number, px: number): Ticks {
  const { major, minor } = pickStep(totalUnits, px)
  const majorOut: number[] = []
  const minorOut: number[] = []
  // + 0.5 กันเลข 0.30000000000000004 และล้มที่ขอบสุดท้าย
  for (let v = 0; v <= totalUnits + minor * 0.5; v += minor) {
    const r = Math.round(v * 1000) / 1000
    if (Math.abs(r / major - Math.round(r / major)) < 1e-6) majorOut.push(r)
    else if (r < totalUnits) minorOut.push(r)
  }
  return { major: majorOut, minor: minorOut }
}

/** ข้อความบนจุดขีด — นิ้วใช้ทศนิยม 1 ตำแหน่ง ซม. ไม่ต้องทศนิยม */
export function formatTick(v: number, unit: RulerUnit): string {
  if (v === 0) return '0'
  return unit === 'in' ? String(Math.round(v * 10) / 10) : String(Math.round(v * 100) / 100)
}
