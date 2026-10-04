/**
 * ตัวช่วยสำหรับเทสต์ที่ต้องดูรายการแม่แบบ**ทุกหน้า**
 *
 *   import { eachPage, totalOf } from './lib/list-pages.mjs'
 *
 * ── ทำไมต้องมี ─────────────────────────────────────────────────────
 * หน้ารายการ `/studio` แบ่งหน้า 12 รายการต่อหน้า
 *   (เดิมโหลดมาทั้งหมด 43 รายการ = เลื่อน 6 จอ ผู้ใช้ชี้ว่าไม่มี pagination)
 *
 *   เทสต์ที่เขียนตอนยังไม่มีการแบ่งหน้า จะพึ่งสมมติฐานว่า
 *   *"ทุกแถวอยู่ใน DOM พร้อมกัน"* — พอแบ่งหน้าแล้วจะหาไม่เจอ
 *
 *   เคยพังจริง 2 ชุด ทั้งที่ระบบไม่ได้พัง:
 *   · `test-chip-filter`  — แถว 12 แถวแรกไม่มีชิปหมวดเลย → `querySelector` ได้ null
 *   · `test-row-peek`     — แม่แบบที่มีรูปย่ออยู่หน้าที่ 3 → นับได้ 0 แถว
 *
 *   การแก้ที่ถูกคือให้เทสต์**เดินทุกหน้า** ไม่ใช่ลดขอบเขตของเกณฑ์
 */

export const PAGER_NEXT = '[data-testid="list-pager-next"]'
export const PAGER_RANGE = '[data-testid="list-pager-range"]'

/**
 * ยอดรวมทั้งหมดของรายการหลังกรอง
 *
 * ⚠️ ต้องใช้ยอดรวม ไม่ใช่จำนวนแถวที่เห็น
 *   เพราะหลังกรองแล้วผลลัพธ์อาจยังพอดีหนึ่งหน้า
 *   → `แถวที่เห็น` เท่าเดิม แต่จริง ๆ ลดลงจาก 43 เหลือ 9
 *   ถ้าเทสต์เทียบจำนวนแถวที่เห็น จะตกทั้งที่ตัวกรองทำงานถูก
 *
 * @param {{n: number, range: string}} snap snapshot จาก `SNAP` ในแต่ละเทสต์
 * @returns จำนวนรายการทั้งหมด (ถ้าอ่านไม่ได้คืนจำนวนแถวที่เห็น)
 */
export function totalOf(snap) {
  const m = /ทั้งหมด\s+([\d,]+)/.exec(snap?.range ?? '')
  return m ? Number(m[1].replace(/,/g, '')) : (snap?.n ?? 0)
}

/**
 * เดินทุกหน้าของรายการ แล้วเรียก `visit` ทีละหน้า
 *
 * ⚠️ ไม่เดินเกิน `maxPages` เด็ดขาด
 *   ถ้าปุ่ม "หน้าถัดไป" พัง (ค้างกดไม่ได้) จะวนไม่จบ
 *   แล้วเทสต์จะค้างจนเวลาหมด โดยไม่บอกว่าพังตรงไหน
 *
 * @param {object} o
 * @param {(expr: string) => Promise<any>} o.evaluate  ตัวช่วย evaluate ของเทสต์
 * @param {string} o.snapExpr  สตริง JS ที่คืน snapshot ของหน้านั้น
 * @param {(snap: any, index: number) => void|Promise<void>} o.visit
 * @param {(expr: string, ms?: number) => Promise<boolean>} [o.waitFor]
 * @param {number} [o.maxPages]
 * @returns snapshot ของทุกหน้า
 */
export async function eachPage({ evaluate, snapExpr, visit, waitFor, maxPages = 20 }) {
  const pages = []
  for (let i = 0; i < maxPages; i++) {
    const snap = await evaluate(snapExpr)
    pages.push(snap)
    if (visit) await visit(snap, i)

    const canNext = await evaluate(`(() => {
      const b = document.querySelector('${PAGER_NEXT}')
      return !!b && !b.disabled
    })()`)
    if (!canNext) break

    await evaluate(`document.querySelector('${PAGER_NEXT}').click()`)
    if (waitFor) {
      // รอจนกว่าหน้าเปลี่ยนจริง ไม่ใช่แค่รอเวลา
      const before = JSON.stringify(snap)
      const end = Date.now() + 10000
      let moved = false
      while (Date.now() < end) {
        const now = await evaluate(snapExpr)
        if (JSON.stringify(now) !== before) { moved = true; break }
      }
      if (!moved) break
    }
  }
  return pages
}
