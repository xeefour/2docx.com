'use client'

import type { ReactNode } from 'react'
import Tabs, { type TabDef } from './Tabs'

/**
 * แถบนำทางฝั่งซ้าย (sidebar) ของหน้ารายการแม่แบบ
 *
 * ── ทำไมเป็น sidebar ไม่ใช่ navbar ───────────────────────────────────
 *   หน้านี้ก่อนหน้านี้ซ้อนกัน 3 แถวก่อนเนื้อหาจะเริ่ม (หัวเรื่อง · แถบแท็บ · แถวตัวกรอง)
 *   และแท็บ 5 อันกินความกว้างจอทั้งแถว จอ 390px เลยเหยียดเป็น 3 แถว
 *   ถ้าใส่ navbar ก็แค่ย้ายปัญหาเดิมไปอยู่บนหัว ไม่ได้แก้อะไร
 *   แต่ sidebar ได้สองอย่างพร้อมกัน:
 *     1. ใช้พื้นที่ว่างข้างเนื้อหา (หน้าจอ 1440px เหลือข้างราว 130px ทิ้งเปล่า)
 *     2. จอเล็กกลายเป็นลิ้นชักที่พับได้ แท็บไม่ต้องเหยียดหลายแถว
 *
 * ── หลักการวาง ──────────────────────────────────────────────────────
 *   · ปุ่มหลักของแอปคือ "อัปโหลดแม่แบบ" จึงอยู่บนสุดเต็มความกว้าง ไม่ใช่ปุ่มเล็กมุมขวาบน
 *   · ตัวนับแต่ละแท็บอยู่ขวาสุด เพื่อให้สแกนตัวเลขได้เรียงกัน
 *   · ส่วนล่าง (กระดิ่ง · ออกจากระบบ) ผูกด้วยเส้นบน แยกเป็นสองโซนชัด ๆ
 */
export default function StudioRail({
  tabs,
  active,
  onTab,
  total,
  action,
  footer,
  open,
  onClose,
}: {
  tabs: TabDef[]
  active: string
  onTab: (id: string) => void
  /** จำนวนแม่แบบทั้งหมด ใช้เขียนใต้ชื่อแอป */
  total: number
  /** ปุ่มอัปโหลดแม่แบบ (ส่งเข้ามาเป็น node เพราะต้องใช้ state ของ `Studio`) */
  action: ReactNode
  /** กระดิ่งจดหมาย + ออกจากระบบ */
  footer: ReactNode
  /** เปิดลิ้นชักอยู่หรือไม่ — ใช้กับจอเล็ก */
  open: boolean
  onClose: () => void
}) {
  return (
    <>
      {/*
       * ผ้าคลุมมืด — จอเล็กเท่านั้น (CSS ซ่อนให้เองบนจอใหญ่)
       * ⚠️ กดต้องปิดลิ้นชักด้วย ไม่ใช่แค่หายเอง ไม่งั้นผู้ใช้ที่เปิดลิ้นชัก
       *   แล้วแตะพื้นที่เนื้อหาจะไม่มีทางปิด
       */}
      <div
        className={`rail__scrim${open ? ' is-on' : ''}`}
        onClick={onClose}
        aria-hidden={!open}
      />
      <aside className={`rail${open ? ' is-open' : ''}`} data-testid="studio-rail">
        <div className="rail__top">
          <div className="rail__brand">
            <span className="rail__mark" aria-hidden="true">
              2
            </span>
            <span className="rail__names">
              <b>2docx</b>
              <small>Studio · {total} แม่แบบ</small>
            </span>
          </div>
          {action}
        </div>

        <p className="rail__label">รายการ</p>
        <nav className="rail__nav">
          <Tabs tabs={tabs} active={active} onChange={onTab} rail />
        </nav>

        <div className="rail__gap" />
        <div className="rail__foot">{footer}</div>

        {/*
         * ปุ่มปิดมีเฉพาะจอเล็ก (CSS ซ่อนให้เองบนจอใหญ่)
         * เพราะบนจอใหญ่ sidebar อยู่ตลอด ปุ่มปิดจะทำให้ผู้ใช้สับสนว่าซ่อนยังไง
         */}
        <button className="rail__close" onClick={onClose} aria-label="ปิดเมนู">
          ปิด
        </button>
      </aside>
    </>
  )
}
