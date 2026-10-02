/**
 * ตัวช่วยเลือกแม่แบบสำหรับเทสต์ — ให้ผลลัพธ์คงที่เสมอ
 *
 *   import { pickTemplate } from './lib/pick-template.mjs'
 *
 * ── ทำไมต้องมี ────────────────────────────────────────────────
 *   เทสต์หลายตัวเขียนว่า `items[0]` เพราะสะดวก แต่**ลำดับรายการเปลี่ยนได้**
 *
 *   เคยเจอ: `test-template-file` ลบแม่แบบชั่วคราวทิ้ง แต่ Carbone ลบแบบ soft-delete
 *   → รายการยังโชว์อยู่ และแม่แบบกำพร้าสะสมจนกลายเป็น `items[0]`
 *   → เทสต์อื่นไปหยิบได้แม่แบบของเทสต์ ตัวเลขช่องกรอกจึงไม่ตรงที่คาดไว้
 *   (เคยตกทั้ง test-field-ai · test-preview-layout · test-download-pages)
 *
 *   เลยต้องเลือกแม่แบบ**ตามชื่อ** ไม่ใช่ตามลำดับ
 */

/** ชื่อแม่แบบมาตรฐานของชุดเทสต์ เรียงตามความเหมาะสมของแต่ละงาน */
export const TEST_TEMPLATES = {
  /** หลายหน้า — ใช้ทดสอบ ZIP · ตัด PDF · ไม้บรรทัด */
  multipage: 'ทดสอบหัวกระดาษ',
  /** หนังสือ 1 หน้า — ใช้ทดสอบเลย์เอาต์ที่วัดความสูงกล่องพรีวิว */
  onepage: 'มีเลขที่หนังสือ',
  /** มีเลขที่หนังสือ — ใช้ทดสอบการเติมข้อมูลลงเอกสาร */
  numbered: 'มีเลขที่หนังสือ',
  /** ใช้กรณีที่ไม่สนใจว่าเป็นแม่แบบไหน */
  any: null,
}

/**
 * เลือกแม่แบบตามชื่อ (เลือกได้หลายคำ — ใช้คำแรกที่เจอ)
 *
 * @param headers header สำหรับเรียก API
 * @param names คำที่ต้องการในชื่อแม่แบบ (คนละอันด้วย OR)
 * @returns แม่แบบที่เลือก พร้อม `id`/`versionId`/`name`
 * @throws ถ้าไม่มีแม่แบบที่ตรงกับคำที่ระบุเลย
 */
export async function pickTemplate(headers, names = [TEST_TEMPLATES.multipage]) {
  const API = process.env.API_URL ?? 'http://127.0.0.1:4001'
  const items = (await (await fetch(`${API}/api/templates`, { headers })).json()).items ?? []
  if (items.length === 0) throw new Error('ไม่มีแม่แบบในระบบเลย')

  for (const name of names) {
    const hit = items.find((t) => (t.name ?? '').includes(name))
    if (hit) return hit
  }
  throw new Error(
    `ไม่พบแม่แบบที่มีชื่อ ${JSON.stringify(names)} (มี ${items.length} รายการ)`,
  )
}

/** คีย์ของแม่แบบตามแบบเดียวกับหน้าเว็บ — `t.id ?? t.versionId` */
export const keyOf = (tpl) => String(tpl?.id ?? tpl?.versionId ?? '')
