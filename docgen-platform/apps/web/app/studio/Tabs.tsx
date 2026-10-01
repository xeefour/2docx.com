'use client'

/** แถบแท็บ — ใช้ร่วมกันทั้งหน้ารายการแม่แบบและหน้าแก้ไขแม่แบบ */
export type TabDef = { id: string; label: string; count?: number; tone?: 'default' | 'accent' }

export default function Tabs({
  tabs,
  active,
  onChange,
}: {
  tabs: TabDef[]
  active: string
  onChange: (id: string) => void
}) {
  return (
    <div className="tabs" role="tablist">
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
  )
}
