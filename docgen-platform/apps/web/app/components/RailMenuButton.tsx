'use client'

/**
 * ปุ่มเปิดลิ้นชักในหัวหน้าเว็บ — ใช้ตัวเดียวกันทุกหน้า
 *
 * ── ทำไมต้องเป็นตัวเดียว ────────────────────────────────────────────────────
 *   ปุ่มนี้คือทางเข้าเดียวของ sidebar บนจอเล็ก (จอกว้าง CSS ซ่อนให้เอง)
 *   เคยมีเฉพาะ `/studio` กับ `/account` → หน้า `/teams` กับ `/teams/[id]` ไม่มี
 *   ผู้ใช้เลยเปิดเมนูบนหน้านั้นไม่ได้เลย
 *   ถ้าปล่อยให้แต่ละหน้าพิมพ์เอง ก็จะเกิดหน้าเพิ่มที่ลืมปุ่มอีก
 *
 * ⚠️ `data-testid` ต้องเป็น `rail-open` เหมือนเดิม — เกณฑ์เดิมคลิกปุ่มนี้
 */
export default function RailMenuButton({ onOpen }: { onOpen: () => void }) {
  return (
    <button className="pagebar__menu" onClick={onOpen} data-testid="rail-open">
      เมนู
    </button>
  )
}
