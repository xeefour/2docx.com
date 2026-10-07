'use client'

import { useEffect, useRef, useState } from 'react'

/** ตัวเลือกทีม — ใช้แค่ id กับชื่อ ส่วนอื่นไม่ต้องดึงมาให้เปลือง */
export type BookmarkTeam = {
  team: string
  name: string
}

/**
 * ปุ่มบุ๊กมาร์ก — ตัวเดียวที่ใช้ได้ทั้งในตารางรายการและในหน้าแก้ไขแม่แบบ
 *
 * ── ทำไมต้องเป็นชิ้นเดียว ────────────────────────────────────────────────────
 *   เคยมีดาวสองปุ่มที่วาดเองคนละที่ (`.tabs__star` ในหน้าแก้ไข · `.tplrow__i-star`
 *   ในตาราง) ทุกจุดที่แตกแยก = แก้แล้วอีกที่ไม่ตาม และฟีเจอร์ที่เพิ่มทีหลัง
 *   จะไปโผล่ที่ปุ่มเดียวจนผู้ใช้เจอแล้วสงสัยว่าอีกปุ่มทำไมไม่มี
 *
 * ── ทำไมถึงมี dropdown เมื่อ "มีทีม" เท่านั้น ──────────────────────────────────
 *   ผู้ใช้สั่ง: *"กรณีมี team จะมี dropdown ให้เลือกว่าจะ bookmark ที่ไหน
 *   ลง team ไหน หรือส่วนตัว"*
 *
 *   ⚠️ **ไม่ใช่** "ย้ายแม่แบบเข้าทีม" — สองเรื่องนี้คนละเรื่องกัน
 *     · บุ๊กมาร์ก = ที่ผู้ใช้เก็บไว้ของตัวเอง (มีที่เก็บเป็น "โฟลเดอร์")
 *     · แม่แบบเข้าทีม = ให้คนอื่นในทีมใช้ร่วมกัน (ทำที่แท็บ "การแชร์และสิทธิ์")
 *   ถ้าสับสนสองเรื่องนี้ ผู้ใช้จะเผลอ**แชร์แม่แบบตัวเองออกไปทั้งทีม**
 *     แค่เพราะกดดาว โดยไม่มี error ใด ๆ
 *
 * ── ไม่มีทีม = ปุ่มเดิมที่กดสลับได้ทันที ──────────────────────────────────────
 *   ถ้าเปลี่ยนเป็นบังคับให้เลือกทีมแม้ไม่มีทีม จะทำให้ผู้ใช้ที่ไม่มีทีมเลย
 *   ต้องกดสองครั้งเพื่อทำเรื่องที่กดครั้งเดียวได้ โดยไม่ได้อะไรเพิ่ม
 */
/** ความกว้างเมนู — ต้องตรงกับ `.bmk__pop { width }` ใน CSS */
const POP_W = 240
const EDGE = 8

export default function BookmarkButton({
  bookmarked,
  team,
  teams,
  busy,
  onPick,
  onRemove,
  className,
  testId,
  templateKey,
  labelOn,
  labelOff,
}: {
  /** เก็บไว้แล้วหรือยัง */
  bookmarked: boolean
  /** ทีมที่เก็บอยู่ — null = ส่วนตัว */
  team: string | null
  teams: BookmarkTeam[]
  busy?: boolean
  /** เลือกที่เก็บ — null = ส่วนตัว */
  onPick: (team: string | null) => void
  /** เอาออกทั้งหมด */
  onRemove: () => void
  className: string
  testId: string
  /**
   * key ของแม่แบบที่ปุ่มนี้ผูกกับ
   *
   * ⚠️ ต้องมี เพราะตารางมีหลายแถว และกุณแต่ละแถวมีปุ่มดาวเหมือนกัน
   *   ถ้าเกณฑ์เลือกด้วย testid อย่างเดียว จะได้**แถวแรก**เสมอ
   *   แล้วไปตรวจบุ๊กมาร์กของแม่แบบอื่น → เกณฑ์ตกผิดเหตุทั้งที่โค้ดถูก
   */
  templateKey: string
  labelOn: string
  labelOff: string
}) {
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLSpanElement>(null)
  /** พิกัดจอของเมนู — คำนวณจากตำแหน่งจริงของปุ่ม ไม่เดา */
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)

  const openMenu = () => {
    place()
    setOpen(true)
  }

  /**
   * คำนวณตำแหน่งเมนูจากตำแหน่งจริงของปุ่ม
   *
   * ⚠️ ต้อง**ย้ายตาม**การเลื่อน ไม่ใช่ปิดเมนูทิ้ง
   *   เพราะ scroll event ถูกจัดคิวแบบ async — ถ้าผู้ใช้เพิ่งเลื่อนแล้วกดตาม
   *   เมนูจะเปิดแล้วถูกปิดทันทีในเฟรมถัดไป (เกิดจริงรอบนี้ในเกณฑ์ที่กดผ่าน CDP
   *   เพราะ `scrollIntoView` แล้วคลิกในคิวเดียวกัน → เมนูเปิดแล้วปิดเอง)
   */
  const place = () => {
    const btn = wrapRef.current?.getBoundingClientRect()
    if (!btn) return
    const w = Math.min(POP_W, window.innerWidth - EDGE * 2)
    const left = Math.max(EDGE, Math.min(btn.right - w, window.innerWidth - w - EDGE))
    const h = 44 + teams.length * 36
    const spaceBelow = window.innerHeight - btn.bottom
    const top = spaceBelow < h + EDGE && btn.top > h + EDGE ? btn.top - h - 8 : btn.bottom + 8
    setPos({ left, top })
  }

  /*
   * ⚠️ ปิดเมนูเมื่อคลิกที่อื่น / กด Esc
   *   เมนูที่ค้างไว้จะบังปุ่มอื่นในแถบแท็บ และผู้ใช้จะไม่มีทางรู้ว่ามีอะไรทับ
   */
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    /*
     * ⚠️ ต้อง**ตามตำแหน่ง** ไม่ใช่ปิดทิ้ง (เคยเป็นบั๊กจริงรอบนี้)
     *
     *   เมนูเป็น `position: fixed` → พิกัดที่คำนวณไว้เป็นพิกัด**จอ** ไม่ใช่พิกัดในเอกสาร
     *   ถ้าปิดทิ้งเมื่อเลื่อน ผู้ใช้ที่เปิดเมนูแล้วลากแถบเลื่อนจะกลับไปกดปุ่มดาวอีกครั้ง
     *   และเจอเมนูที่เดิมเปิดอยู่ (เพราะกดปุ่ม = toggle กลับไปปิด) — งงโดยไม่มี error
     *
     *   ⚠️ และถ้าใช้ `setOpen(false)` จะพังหนักกว่านั้น: `scroll` ถูกจัดคิวแบบ async
     *   ผู้ใช้ที่เพิ่งเลื่อนแล้วกดตาม → เมนูเปิด แล้ว event ที่ค้างอยู่ยิงมาปิดในเฟรมถัดไป
     *   กลายเป็น "กดปุ่มแล้วไม่มีอะไรเกิดขึ้น" (เจอจริงตอนเกณฑ์กดผ่าน CDP)
     */
    const reposition = () => place()
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    window.addEventListener('scroll', reposition, true)
    window.addEventListener('resize', reposition)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('scroll', reposition, true)
      window.removeEventListener('resize', reposition)
    }
  }, [open])

  const hasTeams = teams.length > 0
  const label = bookmarked ? labelOn : labelOff

  const pick = (v: string | null) => {
    setOpen(false)
    onPick(v)
  }

  return (
    <span className="bmk" ref={wrapRef}>
      <button
        className={className}
        data-testid={testId}
        data-template-key={templateKey}
        aria-pressed={bookmarked}
        aria-label={label}
        title={label}
        disabled={busy}
        data-open={open || undefined}
        onClick={() => {
          if (!hasTeams) {
            // ไม่มีทีม = ไม่มีที่ให้เลือก กดคือสลับตามเดิม (ครั้งเดียวจบ)
            if (bookmarked) onRemove()
            else onPick(null)
            return
          }
          if (open) setOpen(false)
          else openMenu()
        }}
        aria-haspopup={hasTeams ? 'menu' : undefined}
        aria-expanded={hasTeams ? open : undefined}
      >
        {bookmarked ? '★' : '☆'}
      </button>

      {open && hasTeams && pos && (
        <div
          className="bmk__pop"
          role="menu"
          aria-label="เก็บบุ๊กมาร์กไว้ที่ไหน"
          style={{ left: pos.left, top: pos.top }}
        >
          <p className="bmk__title">เก็บบุ๊กมาร์กไว้ที่ไหน</p>

          <button
            type="button"
            role="menuitemradio"
            aria-checked={bookmarked && !team}
            className="bmk__opt"
            data-testid={`bookmark-scope-personal`}
            onClick={() => pick(null)}
          >
            <span className="bmk__name">ส่วนตัวของฉัน</span>
            {bookmarked && !team && <span className="bmk__tick" aria-hidden="true">✓</span>}
          </button>

          {teams.map((t) => (
            <button
              key={t.team}
              type="button"
              role="menuitemradio"
              aria-checked={bookmarked && team === t.team}
              className="bmk__opt"
              data-testid={`bookmark-scope-${t.team}`}
              onClick={() => pick(t.team)}
            >
              <span className="bmk__name">{t.name}</span>
              {bookmarked && team === t.team && <span className="bmk__tick" aria-hidden="true">✓</span>}
            </button>
          ))}

          {bookmarked && (
            <>
              <div className="bmk__sep" role="separator" />
              <button
                type="button"
                role="menuitem"
                className="bmk__opt bmk__opt--danger"
                data-testid="bookmark-remove"
                onClick={() => {
                  setOpen(false)
                  onRemove()
                }}
              >
                <span className="bmk__name">เอาออกจากบุ๊กมาร์ก</span>
              </button>
            </>
          )}
        </div>
      )}
    </span>
  )
}