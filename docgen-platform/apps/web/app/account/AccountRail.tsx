'use client'

import type { ReactNode } from 'react'
import Tabs, { type TabDef } from '../studio/Tabs'
import AppRail from '../components/AppRail'

/**
 * แถบนำทางฝั่งซ้ายของหน้าบัญชี — ใช้หน้าตาเดียวกับ sidebar ของ Studio
 *
 * ── ทำไมไม่แตะ CSS เลย ────────────────────────────────────────────────
 *   ตัวคลาสทั้งหมด (`.shell` · `.rail` · `.tabs--rail`) ถูกเขียนไว้ให้ Studio แล้ว
 *   และจัดการจอเล็ก (ลิ้นชัก + ผ้าคลุมมืด + ปุ่มปิด) ครบแล้ว
 *   การเขียน CSS ซ้ำชุดเดียวกันอีกชุด = ต้องแก้สองที่ทุกครั้งที่ปรับหน้าตา
 *   *   และไฟล์นั้นยังมีงานค้างจากงานอื่นอยู่ → งานสองเรื่องจะปนกันในไฟล์เดียว
 *   จึงยืมคลาสเดิมทั้งหมด แล้วผ่อนความต่างด้วยเนื้อหาที่ส่งเข้ามาเท่านั้น
 *
 * ── ข้อต่างจาก sidebar ของ Studio (เหลือแค่เนื้อหา ไม่เหลือโครง) ────────────
 *   · รายการในเมนูเป็น**ส่วนของหน้าเดียวกัน** ไม่ใช่คนละแท็บ
 *     จึงกดแล้วเลื่อนไปยังส่วนนั้น ไม่เปลี่ยนหน้า
 *   · ตัวนับจากสถิติของผู้ใช้ เพื่อให้เห็นตัวเลขตอนเลือกดูส่วนนั้น
 */
export default function AccountRail({
  tabs,
  active,
  onTab,
  action,
  extra,
  onNavigate,
  userName,
  open,
  onClose,
}: {
  tabs: TabDef[]
  active: string
  onTab: (id: string) => void
  /** รูปโปรไฟล์ + ปุ่มเปลี่ยนรูป (ต้องใช้ state ของหน้า) */
  action: ReactNode
  /**
   * เมนูข้ามหน้าที่ต่อท้ายรายการแท็บของหน้า
   *
   * ⚠️ ต้องอยู่ตรงนี้ (ในรายการเมนู) ไม่ใช่ในส่วนล่างของ sidebar
   *   ผู้ใช้สั่ง 2026-10-07: *"อื่น ๆ ทำให้เหมือนกับ /studio"*
   *   เดิมหน้านี้วาง "กลับไป Studio · ทีมของฉัน" ไว้ใต้เส้นคั่น
   *   ซึ่งต่างตำแหน่งจาก /studio ที่วางในรายการเดียวกับแท็บ
   *   และทำให้ส่วนล่างแน่นจนชื่อผู้ใช้ถูกย่อเหลือ "Teerasak..."
   */
  extra?: ReactNode
  /** ปิดลิ้นชักหลังกดเมนูข้ามหน้า (จอเล็ก) */
  onNavigate?: () => void
  /** ชื่อผู้ใช้ที่แสดงในส่วนล่าง */
  userName?: string
  open: boolean
  onClose: () => void
}) {
  return (
    <AppRail
      subtitle="บัญชีของฉัน"
      action={action}
      navLabel="บัญชี"
      // ⚠️ `extra` ต้องเข้าไปใน `Tabs` เพื่อให้เมนูข้ามหน้าอยู่ใน `.tabs__list` เดียวกับแท็บ
      //   ถ้าส่งเป็น `nav` แยก จะได้สองกลุ่มที่มี gap ตรงกลาง (เหมือนที่เคยเป็นบั๊ก)
      nav={<Tabs tabs={tabs} active={active} onChange={onTab} rail extra={extra} />}
      userName={userName}
      open={open}
      onClose={onClose}
      testId="account-rail"
    />
  )
}
