'use client'

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'

/** แถบแท็บ — ใช้ร่วมกันทั้งหน้ารายการแม่แบบและหน้าแก้ไขแม่แบบ */
export type TabDef = { id: string; label: string; count?: number; tone?: 'default' | 'accent' }

/** ขอบที่ยังมีแท็บซ่อนอยู่นอกจอ — ใช้ไล่สีบอกว่า "เลื่อนได้" */
type Edges = '' | 'left' | 'right' | 'both'

export default function Tabs({
  tabs,
  active,
  onChange,
  trailing,
  rail,
  extra,
  compact,
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
   *   ถ้าวางเป็นกลุ่มที่สอง (แม้ไม่มีเส้นคั่น) `.rail` จะเว้น `gap: 10px` ระหว่างสองกลุ่ม
   *   → ยังดูเป็นสองกลุ่มอยู่ดี ต้องรวมเป็น `.tabs__list` เดียวจึงจะได้ gap 2px เหมือนแท็บ
   *
   * ⚠️ อยู่ใน `role="tablist"` ด้วย — เป็นข้อถกเถียงเชิง semantics
   *   แต่เปลี่ยนมาใช้ `role="none"` แล้วเทสต์ที่ไล่ `.tabs__tab` จะนับไม่ครบ
   *   และปุ่มลิงก์ที่อยู่นอก tablist จะเสียการเลื่อนด้วยลูกศรของ screen reader
   *   เลยยอมให้มีและใช้ `aria-current` บอกหน้าปัจจุบันแทน
   */
  extra?: ReactNode
  /**
   * แท็บสั้น ๆ ให้**แบ่งพื้นที่เต็มแถบ**ตอนจอเล็ก (≤720px) แทนที่จะเกาะชิดซ้ายเป็นก้อนเล็ก
   *
   * แถบซ้ายของหน้าแก้ไข (`ฟอร์ม` · `JSON` · `ประวัติ` + ดาว) ใช้ค่านี้
   *   ส่วนแถบขวา (`ตัวอย่างเอกสาร` · `ข้อมูลแม่แบบ` · `ช่องฟอร์ม` · `การแชร์และสิทธิ์`)
   *   ไม่ใช้ เพราะป้ายยาวเกินกว่าจะแบ่งพื้นที่แล้วยังพอดีจอ
   *   (ถ้าใส่ ข้อความจะถูกบีบจนตัดเป็น … — ดู `globals.css` หัวข้อแท็บบนมือถือ)
   */
  compact?: boolean
}) {
  const barRef = useRef<HTMLDivElement | null>(null)
  const [edges, setEdges] = useState<Edges>('')

  /**
   * อัปเดตว่ามีแท็บซ่อนอยู่ข้างไหน
   *
   * ⚠️ ต้องคำนวณจาก `scrollLeft` จริง ไม่ใช่แค่ดูว่าล้นหรือไม่
   *   เพราะผู้ใช้ปัดจนสุดขวาแล้ว ไล่สีขวาต้องหาย (ไม่มีอะไรซ่อนแล้ว)
   *   ไล่สีค้างไว้ = บอกว่ามีอะไรซ่อนตอนที่ไม่มี = หลอกผู้ใช้
   */
  const syncEdges = useCallback(() => {
    const bar = barRef.current
    if (!bar) return
    // เผื่อ 1px กันเศษทศนิยมจากการ scale ของเบราว์เซอร์
    if (bar.scrollWidth - bar.clientWidth <= 1) {
      setEdges('')
      return
    }
    const atStart = bar.scrollLeft <= 1
    const atEnd = bar.scrollLeft + bar.clientWidth >= bar.scrollWidth - 1
    setEdges(atStart ? 'right' : atEnd ? 'left' : 'both')
  }, [])

  /** ป้ายทั้งหมดติดกันเป็นสตริงเดียว — ใช้แทน `tabs` ใน deps เพราะ `tabs` เป็นอาร์เรย์ใหม่ทุกเรนเดอร์ */
  const labels = tabs.map((t) => t.label).join('|')

  useEffect(() => {
    const bar = barRef.current
    if (!bar) return

    /*
     * ⚠️ เลื่อนแท็บที่เลือกอยู่ให้เห็นเต็ม — หัวใจของการยอมให้เลื่อนแนวนอน
     *   ตอนจอเล็วป้าย 4 อันยาวรวมกันเกินจอ ("การแชร์และสิทธิ์" อยู่ท้ายสุด จอจะแสดงแค่ 2-3 อันแรก)
     *   ถ้าไม่เลื่อนให้ แท็บที่เปิดอยู่จะหายไปทั้งที่ URL/เนื้อหาบอกว่าเปิดอยู่
     *   ผู้ใช้แก้เกณฑ์นี้เคยเจอกับ `.inbox__filters` (ปุ่มถูกซ่อนโดยไม่มีใครรู้)
     *
     * ใช้ `getBoundingClientRect` ของทั้งสองฝั่ง ไม่ใช้ `offsetLeft`
     *   เพราะ `offsetLeft` วัดจาก `offsetParent` ซึ่งอาจไม่ใช่ตัวแถบ (ไม่มี `position` ตั้งไว้)
     */
    if (bar.scrollWidth - bar.clientWidth > 1) {
      const on = bar.querySelector<HTMLElement>('.tabs__tab[aria-selected="true"]')
      if (on) {
        const barBox = bar.getBoundingClientRect()
        const onBox = on.getBoundingClientRect()
        if (onBox.left < barBox.left) bar.scrollLeft += onBox.left - barBox.left
        else if (onBox.right > barBox.right) bar.scrollLeft += onBox.right - barBox.right
      }
    }
    syncEdges()
  }, [active, labels, syncEdges])

  /** จอถูอยู่ (หมุนมือถือ · ย่อ/ขยายหน้าต่าง) → ต้องคำนวณขอบใหม่ทุกครั้ง */
  useEffect(() => {
    const bar = barRef.current
    if (!bar || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(syncEdges)
    ro.observe(bar)
    return () => ro.disconnect()
  }, [syncEdges])

  /** ปัดนิ้ว/ล้อเมอร์ซ์เอง → ขอบไล่สีต้องตามตำแหน่งจริง */
  useEffect(() => {
    const bar = barRef.current
    if (!bar) return
    bar.addEventListener('scroll', syncEdges, { passive: true })
    return () => bar.removeEventListener('scroll', syncEdges)
  }, [syncEdges])

  const fade = edges ? ` tabs--fade-${edges}` : ''

  return (
    <div ref={barRef} className={`tabs${rail ? ' tabs--rail' : ''}${compact ? ' tabs--compact' : ''}${fade}`}>
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