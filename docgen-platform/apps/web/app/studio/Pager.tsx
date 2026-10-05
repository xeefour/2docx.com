'use client'

/**
 * แถบแบ่งหน้า
 *
 * ── ทำไมต้องมี ─────────────────────────────────────────────────
 * ผู้ใช้สั่ง: *"ข้อมูลเยอะมาก แก้ไขให้มี pageination"* (ตอนเห็นรายชื่อ 100 คน
 * ที่สร้างเอกสารจากแม่แบบเดียวกัน 317 ฉบับ — เลื่อนยาวจนหาไม่เจอว่าใครอยู่ล่างสุด)
 *
 * ── เลขหน้าไม่ควรโตไม่จำกัด ───────────────────────────────────
 * 317 ฉบับ = 16 หน้า ถ้าโชว์ปุ่มทั้ง 16 ปุ่มเรียงกันจะยาวกว่าจอเล็ก (579px)
 * จึงโชว์แค่หน้าปัจจุบัน ±1 แล้วใส่ `…` คั่นปลายทั้งสองข้าง
 */
import type { ReactNode } from 'react'

/** หน้าที่จะโชว์ — คืน `null` แทน `…` เพื่อให้เรียง JSX ง่าย */
function slots(page: number, pageCount: number): Array<number | null> {
  if (pageCount <= 7) return Array.from({ length: pageCount }, (_, i) => i + 1)

  const out: Array<number | null> = [1]
  const from = Math.max(2, page - 1)
  const to = Math.min(pageCount - 1, page + 1)

  if (from > 2) out.push(null)
  for (let p = from; p <= to; p++) out.push(p)
  if (to < pageCount - 1) out.push(null)

  out.push(pageCount)
  return out
}

const btn: React.CSSProperties = {
  minWidth: 30,
  padding: '4px 8px',
  fontSize: 12,
  borderRadius: 6,
  border: '1px solid var(--line)',
  background: '#fff',
  /**
   * ⚠️ ต้องกำหนด `color` เองด้วย
   *   กฎ `button { color: #fff }` ของ globals.css (บรรทัด 48) ตั้งสีตัวอักษรไว้ให้ทุกปุ่ม
   *   ถ้า override แค่พื้นหลังเป็นขาว → ตัวเลขจะเป็น**ขาวบนขาว** มองไม่เห็น
   */
  color: 'var(--ink)',
  cursor: 'pointer',
}

export default function Pager({
  page,
  pageCount,
  onChange,
  testId,
  summary,
  children,
}: {
  /** หน้าปัจจุบัน เริ่มที่ 1 */
  page: number
  pageCount: number
  onChange: (page: number) => void
  /** ใช้สร้าง `data-testid` — เทสต์ต้องกดปุ่มจริง ไม่ใช่เรียก state เปลี่ยนตรง ๆ */
  testId: string
  /** ข้อความบอกยอดรวม เช่น "ทั้งหมด 317 ฉบับ" */
  summary?: ReactNode
  /** ข้อความซ้ายของแถบปุ่ม เช่น "แสดง 1–20 จาก 317" */
  children?: ReactNode
}) {
  const total = Math.max(1, pageCount)
  const cur = Math.min(Math.max(1, page), total)

  return (
    /**
     * จัดเป็น 2 แถวเสมอ ไม่ใช่ 1 แถว
     *
     * ⚠️ การ์ดด้านขวาของหน้าแก้แม่แบบแคบแค่ ~270px เมื่อจัดปุ่มทั้งหมดไว้บรรทัดเดียว
     *   ปุ่มหน้าก่อน/ถัดไปจะถูกดัดไปตกบรรทัดใหม่และกลายเป็นกล่องกว้างเปล่า ๆ
     *   แยกข้อความออกมาเป็นบรรทัดบน แล้วให้ปุ่มชิดกลางในบรรทัดล่าง
     *   → จอกว้างก็ดี จอแคบก็ยังอ่านออก
     */
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        alignItems: 'center',
        padding: '10px 12px',
        borderTop: '1px solid var(--line)',
        fontSize: 12,
      }}
    >
      {children || summary ? (
        <div className="muted" style={{ textAlign: 'center' }} data-testid={`${testId}-range`}>
          {children}
          {children && summary ? ' · ' : ''}
          {summary}
        </div>
      ) : null}

      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', justifyContent: 'center' }}>
        <button
          type="button"
          style={{ ...btn, opacity: cur <= 1 ? 0.35 : 1 }}
          disabled={cur <= 1}
          data-testid={`${testId}-prev`}
          onClick={() => onChange(cur - 1)}
          aria-label="หน้าก่อนหน้า"
        >
          ‹
        </button>

        {slots(cur, total).map((p, i) =>
          p === null ? (
            <span key={`gap-${i}`} className="muted" style={{ padding: '0 2px' }}>
              …
            </span>
          ) : (
            <button
              key={p}
              type="button"
              style={{
                ...btn,
                /**
                 * ⚠️ ต้องเขียน `border` เต็ม ไม่ใช่ `borderColor`
                 *   `btn` ตั้ง `border` (shorthand) ไว้แล้ว ถ้าตรงนี้ใช้ `borderColor`
                 *   (longhand) เมื่อกดเปลี่ยนหน้า ปุ่มเดิมจะ**ถูกถอด** `borderColor`
                 *   ขณะที่ `border` ยังอยู่ → React เตือนว่า
                 *   *"Removing a style property during rerender (borderColor)
                 *     when a conflicting property is set (border) can lead to
                 *     styling bugs"* แล้วพูดกันผิดเรื่อง
                 *   เขียน `border` เต็มทั้งสองสถานะ = ไม่มี longhand ต้องถอดเลย
                 *   (หน้าตาผลลัพธ์เหมือนเดิมทุกประการ)
                 */
                ...(p === cur
                  ? { background: 'var(--brand)', color: '#fff', border: '1px solid var(--brand)' }
                  : {}),
              }}
              data-testid={`${testId}-page-${p}`}
              onClick={() => onChange(p)}
              aria-current={p === cur ? 'page' : undefined}
            >
              {p}
            </button>
          ),
        )}

        <button
          type="button"
          style={{ ...btn, opacity: cur >= total ? 0.35 : 1 }}
          disabled={cur >= total}
          data-testid={`${testId}-next`}
          onClick={() => onChange(cur + 1)}
          aria-label="หน้าถัดไป"
        >
          ›
        </button>
      </div>
    </div>
  )
}
