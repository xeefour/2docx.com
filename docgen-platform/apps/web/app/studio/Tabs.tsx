'use client'

import type { ReactNode } from 'react'

/** แถบแท็บ — ใช้ร่วมกันทั้งหน้ารายการแม่แบบและหน้าแก้ไขแม่แบบ */
export type TabDef = { id: string; label: string; count?: number; tone?: 'default' | 'accent' }

export default function Tabs({
  tabs,
  active,
  onChange,
  trailing,
  rail,
  extra,
}: {
  tabs: TabDef[]
  active: string
  onChange: (id: string) => void
  /**
   * ⚠️ ปุ่มที่ปลายขวาสุดของแถบ (เช่น ปุ่มดาวบุ๊กมาร์ก)
   *
   * อยู่นอก `role="tablist"` เพราะมันไม่ใช่แท็บ (กดแล้วไม่ได้เปลี่ยนแท็บ)
   *   แต่ต้องอยู่ในโครง flex เดียวกับแท็บ ไม่งั้นขอบล่างของแถบจะสั้นลง
   *   และปุ่มจะตกไปบรรทัดใหม่
   */
  trailing?: ReactNode
  /**
   * โหมดแนวตั้ง สำหรับแถบนำทางใน sidebar
   *
   * ⚠️ เปลี่ยนแค่คลาส ไม่เปลี่ยนชื่อ `tabs__tab` เพราะเทสต์หลายชุดเลือกแท็บด้วย
   *   ชื่อนี้ (test-list-tabs-url, test-list-mobile, test-editor-panes)
   *   ถ้าเปลี่ยนชื่อ เทสต์จะตกทั้งที่หน้าเว็บถูก
   */
  rail?: boolean
  /**
   * เมนูที่ต่อท้ายรายการเดียวกัน ใช้เมื่อเมนูไปหน้าอื่นต้องอยู่**รายการเดียว**กับแท็บ
   *
   * ── ทำไมต้องอยู่ใน `.tabs__list` แทนที่จะเป็นกลุ่มใหม่ ──────────────────
   *   ผู้ใช้สั่ง: *"ปรับ sidebar ให้เหมือนหน้าอื่น เหมือนกับหน้านี้ /account /teams เป็นต้น"*
   *   วัดแล้วเห็นว่า sidebar ของ /studio มี 2 กลุ่มคั่นเส้น ส่วน /account กับ /teams มีกลุ่มเดียว
   *   ถ้าวางเป็นกลุ่มที่สอง (แม้ไม่มีเส้นคั่น) `.rail` จะเว้น `gap: 10px` ระหว่างสองกล่อง
   *   → ยังดูเป็นสองกลุ่มอยู่ดี ต้องรวมเป็น `.tabs__list` เดียวจึงจะได้ gap 2px เหมือนแท็บ
   *
   * ⚠️ อยู่ใน `role="tablist"` ด้วย — เป็นข้อถกเถียงเชิง semantics
   *   แต่เปลี่ยนมาใช้ `role="none"` แล้วเทสต์ที่ไล่ `.tabs__tab` จะนับไม่ครบ
   *   และปุ่มลิงก์ที่อยู่นอก tablist จะเสียการเลื่อนด้วยลูกศรของ screen reader
   *   เลยยอมให้มีและใช้ `aria-current` บอกหน้าปัจจุบันแทน
   */
  extra?: ReactNode
}) {
  return (
    <div className={`tabs${rail ? ' tabs--rail' : ''}`}>
      <div className="tabs__list" role="tablist">
        {tabs.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={active === t.id}
            className={`tabs__tab${active === t.id ? ' tabs__tab--on' : ''}`}
            onClick={() => onChange(t.id)}
          >
            {t.label}
            {t.count !== undefined && t.count > 0 && <span className="tabs__count">{t.count}</span>}
          </button>
        ))}
        {extra}
      </div>
      {trailing}
    </div>
  )
}
