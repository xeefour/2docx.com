'use client'

import type { ReactNode } from 'react'
import Link from 'next/link'
import RailFooter from './RailFooter'
import ThemeToggle from './ThemeToggle'

/**
 * โครง sidebar ชุดเดียวของทั้งแอป — ทุกหน้าใช้ตัวนี้ ไม่มีหน้าไหนวาดเอง
 *
 * ── ทำไมต้องรวมเป็นตัวเดียว ────────────────────────────────────────────────
 *   เคยมี sidebar 4 ชุดที่**หน้าตาไม่เหมือนกัน** เพราะแต่ละหน้าวาดเอง:
 *     · `/studio` กับ `/account` → ลิ้นชักมือถือ + ผ้าคลุมมืด + ปุ่มปิด ครบ
 *     · `/teams` กับ `/teams/[id]` → `<aside className="rail">` เปล่า ๆ ไม่มี state
 *       → จอเล็ก CSS ซ่อน sidebar ไว้ (`transform` ออกจอ) แต่**ไม่มีปุ่มไหนเปิดได้**
 *       ผู้ใช้เลยเดินหน้านั้นแล้วกลับไปหน้าอื่นไม่ได้ นี่คือบั๊กจริง ไม่ใช่เรื่องรสนิยม
 *   ทุกจุดที่แตกแยก = แก้หน้าตาแล้วอีกหน้าไม่ตาม
 *   ตอนนี้โครงอยู่ที่นี่ที่เดียว หน้าอื่นส่งแค่เนื้อหาเข้ามา
 *
 * ── หน้าตาที่ต้องเหมือนกันทุกหน้า ──────────────────────────────────────────
 *   กล่องแบรนด์ (เครื่องหมาย 2 · ชื่อ 2docx · คำอธิบาย) → ช่องกดหลักของหน้านั้น
 *   → ป้ายหัวของเมนู → รายการเมนู → เส้นคั่น → ส่วนล่าง (ชื่อผู้ใช้ · ออกจากระบบ)
 *   → ปุ่มปิด (CSS ซ่อนให้เองตอนจอกว้าง)
 */
export default function AppRail({
  /** คำอธิบายใต้ชื่อแอป เช่น "Studio · 45 แม่แบบ" หรือ "บัญชีของฉัน" */
  subtitle,
  /** ช่องกดหลักของหน้านั้น เช่น ปุ่มอัปโหลดแม่แบบ หรือ รูปโปรไฟล์ + เปลี่ยนรูป */
  action,
  /** ป้ายหัวของรายการเมนู เช่น "รายการ" · "บัญชี" · "เมนู" */
  navLabel,
  /** รายการเมนู (ปุ่มแท็บหรือลิงก์ก็ได้) */
  nav,
  /** `data-testid` ของ `<nav>` — เกณฑ์เดิมนับแท็บในรายการเมนูของ Studio */
  navTestId,
  /** ชื่อผู้ใช้ที่แสดงในส่วนล่าง */
  userName,
  /** ลิงก์เพิ่มเติมในส่วนล่าง (ก่อนปุ่มออกจากระบบ) */
  footerLinks,
  open,
  onClose,
  /** `data-testid` ของ `<aside>` — ต่างกันต่อหน้าเพื่อให้เกณฑ์ระบุได้ว่าหน้าไหน */
  testId,
}: {
  subtitle: string
  action?: ReactNode
  navLabel: string
  nav: ReactNode
  navTestId?: string
  userName?: string
  footerLinks?: ReactNode
  /** เปิดลิ้นชักอยู่หรือไม่ — ใช้กับจอเล็ก */
  open: boolean
  onClose: () => void
  testId?: string
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
      <aside className={`rail${open ? ' is-open' : ''}`} data-testid={testId}>
        <div className="rail__top">
          <div className="rail__brand">
            {/*
             * โลโก้ = ลิงก์กลับหน้าแรก (ผู้ใช้สั่ง)
             *
             * ⚠️ ต้องแยกเป็น `<Link>` ตัวเดียว ไม่ใช่ทำทั้ง `.rail__brand` เป็นลิงก์
             *   เพราะ `ThemeToggle` อยู่ในกล่องเดียวกัน → จะได้ปุ่มกดซ้อนในลิงก์
             *   ซึ่งทั้งไม่ถูก HTML และกดสลับโหมดแล้วหน้าก็กระโดดไป `/` ด้วย
             *
             * ⚠️ `onClick={onClose}` — บนจอเล็กลิ้นชักเป็นชั้นทับ ถ้าไม่ปิด
             *   ผู้ใช้จะเห็นเมนูค้างอยู่ทับเนื้อหาหน้าแรก เหมือนกดปุ่มไม่มีผล
             */}
            <Link href="/" className="rail__home" data-testid="rail-home" onClick={onClose}>
              <span className="rail__mark" aria-hidden="true">
                2
              </span>
              <span className="rail__names">
                <b>2docx</b>
                <small>{subtitle}</small>
              </span>
            </Link>
            {/*
             * ปุ่มสลับโหมดอยู่ใน sidebar เพราะเป็นที่เดียวที่**ทุกหน้ามี**
             * ถ้าไปไว้ใน pagebar ของแต่ละหน้า หน้าที่ลืมใส่จะไม่มีปุ่มสลับเลย
             * (เกิดแบบเดียวกับที่ปุ่มเปิดเมนูหายไปจาก /teams เมื่อก่อน)
             */}
            <ThemeToggle />
          </div>
          {action}
        </div>

        <p className="rail__label">{navLabel}</p>
        <nav className="rail__nav" data-testid={navTestId}>
          {nav}
        </nav>

        <div className="rail__gap" />
        <RailFooter userName={userName} links={footerLinks} />

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
