'use client'

import type { ReactNode } from 'react'

/** แถบแท็บ — ใช้ร่วมกันทั้งหน้ารายการแม่แบบและหน้าแก้ไขแม่แบบ */
export type TabDef = { id: string; label: string; count?: number; tone?: 'default' | 'accent' }

export default function Tabs({
  tabs,
  active,
  onChange,
  trailing,
}: {
  tabs: TabDef[]
  active: string
  onChange: (id: string) => void
  /**
   * ปุ่มที่ปลายขวาสุดของแถบ (เช่น ปุ่มดาวบุ๊กมาร์ก)
   *
   * ⚠️ อยู่นอก `role="tablist"` เพราะมันไม่ใช่แท็บ (กดแล้วไม่ได้เปลี่ยนแท็บ)
   *   แต่ต้องอยู่ในโครง flex เดียวกับแท็บ ไม่งั้นขอบล่างของแถบจะสั้นลง
   *   และปุ่มจะตกไปบรรทัดใหม่
   */
  trailing?: ReactNode
}) {
  return (
    <div className="tabs">
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
      </div>
      {trailing}
    </div>
  )
}
