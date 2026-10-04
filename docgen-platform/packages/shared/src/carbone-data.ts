/**
 * ทำให้ค่าจากฟอร์มของผู้ใช้เข้ากับที่ Carbone 5 อ่านออกได้จริง
 *
 * ── ปัญหาที่แก้ ────────────────────────────────────────────────
 * ช่อง "checkbox" ในฟอร์มเก็บค่าเป็น boolean เสมอ (`false` = ไม่ได้ติ๊ก)
 * แต่ Carbone 5 พิมพ์ boolean `false` ออกมาเป็น **คำว่า "false"** ตรง ๆ
 *
 * ผลจากการวัดจริงกับ docserver 5.15.2 (tools/probe-carbone-hide.mjs):
 *   ค่า `true`        → ifEQ(true):show(…) แสดงข้อความ      ✓
 *   ค่า `''`          → ซ่อนสะอาด                          ✓
 *   ไม่มีฟิลด์นี้      → ซ่อนสะอาด                          ✓
 *   ค่า `false`       → **พิมพ์คำว่า "false" ลงไปในเอกสาร** ✗
 *
 * แปลว่าผู้ใช้ที่เขียนแม่แบบตามคู่มือ (ใช้ `ifEQ(true):show()` เพื่อซ่อนข้อความ
 * ตอนไม่ได้ติ๊ก) จะเจอคำว่า "false" โผล่มาในเอกสารเป๊ะทุกครั้งที่ไม่ได้ติ๊กกล่อง
 * ซึ่งเป็นบั๊กที่ผู้ใช้มองเห็นทันทีและไม่มีทางแก้เองได้
 *
 * ── ทำไมแก้ที่ฝั่ง worker ไม่ใช่ตอนบันทึกค่า ──────────────────
 * ค่า `false` ในฐานข้อมูล **ถูกต้องอยู่แล้ว** — มันคือความหมายของ "ไม่ได้ติ๊ก"
 * และต้องคงไว้ ไม่เช่นนั้นผู้ใช้จะเปิดฟอร์มเดิมมาแล้วกล่องที่เคยไม่ได้ติ๊ก
 * กลายเป็นถูกติ๊กเงียบ ๆ (ดู `FormFields.tsx` — `checked={value === true}`)
 * การเปลี่ยนเป็น `''` จึงทำที่ขอบ "ส่งออก" เหมือนกับ `normalizeThaiAlignment`
 * และ `setDocxThaiLanguage` ที่อยู่ข้าง ๆ กัน
 *
 * ── ขอบเขต ─────────────────────────────────────────────────────
 * · แปลงเฉพาะ `false` → `''` เท่านั้น
 * · **`true` คงไว้เป็น `true`** เพราะแม่แบบต้องใช้มันตรวจกับ `ifEQ(true)`
 *   ถ้าแปลงเป็น `''` ด้วย ผู้ใช้จะซ่อนข้อความทั้งที่ติ๊กกล่องแล้ว
 * · ไม่แตะ `null` / `0` / `''` — ทดสอบกับ docserver แล้วว่าซ่อนสะอาดทั้งหมด
 * · ไม่แก้ต้นฉบับที่ส่งเข้ามา (คืนค่าใหม่เสมอ) เพราะ worker ใช้ `data`
 *   ตัวเดิมต่อ (บันทึกลง Mongo / ใช้ทำพรีวิวต่อ)
 */

export type CarboneDataResult = {
  changed: boolean
  /** จำนวนจุดที่ถูกแปลงจาก `false` เป็น `''` */
  converted: number
  /** พาธของจุดที่แปลง (เก็บไว้ยาง ๆ เพื่อไม่ให้ log บวม) */
  paths: string[]
}

/** กันการเดินวนไม่รู้จบตอนข้อมูลมีวงอ้างถึงตัวเอง */
const MAX_DEPTH = 20
const MAX_PATHS = 20

function walk(
  value: unknown,
  path: string,
  seen: WeakSet<object>,
  depth: number,
  result: CarboneDataResult,
): unknown {
  if (value === false) {
    result.converted++
    if (result.paths.length < MAX_PATHS) result.paths.push(path)
    // Carbone ซ่อนค่าว่างสะอาด (ไม่เหลือช่องว่าง ไม่เหลือเส้นใต้)
    return ''
  }

  if (depth >= MAX_DEPTH) return value

  if (Array.isArray(value)) {
    if (seen.has(value)) return value
    seen.add(value)
    return value.map((item, i) => walk(item, path ? `${path}[${i}]` : `[${i}]`, seen, depth + 1, result))
  }

  // ไม่แตะ Date / Buffer / คลาสอื่นที่ JSON ไม่ได้ทำงาน — ปล่อยให้ผ่านไป
  if (value !== null && typeof value === 'object') {
    const proto = Object.getPrototypeOf(value)
    if (proto !== Object.prototype && proto !== null) return value
    if (seen.has(value)) return value
    seen.add(value)

    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = walk(v, path ? `${path}.${k}` : k, seen, depth + 1, result)
    }
    return out
  }

  return value
}

/**
 * ปรับค่าของฟอร์มให้ Carbone 5 อ่านออกได้ถูกต้อง
 *
 * เรียก **ก่อนส่ง `data` ให้ Carboneเท่านั้น** อย่าเรียกตอนบันทึกลง Mongo
 * (ดูหัวไฟล์ — ทำไม)
 */
export function normalizeCarboneData(
  input: Record<string, unknown>,
): { data: Record<string, unknown>; result: CarboneDataResult } {
  const result: CarboneDataResult = { changed: false, converted: 0, paths: [] }

  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return { data: input, result }
  }

  const data = walk(input, '', new WeakSet<object>(), 0, result) as Record<string, unknown>
  result.changed = result.converted > 0

  return { data, result }
}
