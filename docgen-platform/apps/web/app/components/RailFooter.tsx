'use client'

import type { ReactNode } from 'react'

/**
 * ส่วนล่างของ sidebar — ชื่อผู้ใช้ · ลิงก์เสริม · ออกจากระบบ
 *
 * ⚠️ `flex: '1 1 0'` + ellipsis จำเป็น ไม่ใช่ของแต่ง
 *   พื้นที่ใต้แบรนด์กว้างแค่ ~216px ถ้าใส่แค่ `min-width: 0` ชื่อจะ**ถูกตัดก่อนย่อ**
 *   เพราะ flex เลือก "ตัดบรรทัด" ก่อน "บีบให้เล็กลง" (เจอตอนวัด: ชื่อลงบรรทัดที่สอง
 *   แล้วลิงก์ถูกมองว่าซ้อนทับกัน) → ต้องให้ฐานเป็นศูนย์ ถึงจะอยู่บรรทัดเดียวแล้วค่อยย่อ
 */
export default function RailFooter({
  userName,
  links,
}: {
  userName?: string
  /** ลิงก์ที่อยากให้อยู่ก่อนปุ่มออกจากระบบ */
  links?: ReactNode
}) {
  return (
    <div className="rail__foot">
      {userName ? (
        <span
          className="muted"
          style={{
            fontSize: 13,
            flex: '1 1 0',
            minWidth: 0,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
          title={userName}
        >
          {userName}
        </span>
      ) : null}
      {links}
      {/* ⚠️ auth route ไม่ได้อยู่ใต้ /api — ใช้ /auth/logout */}
      <a href="/auth/logout" className="muted" style={{ fontSize: 14, flex: 'none' }}>
        ออกจากระบบ
      </a>
    </div>
  )
}
