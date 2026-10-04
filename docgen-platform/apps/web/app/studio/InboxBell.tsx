'use client'

/**
 * ── กระดิ่งจดหมายในหัวหน้า ─────────────────────────────────────────
 *
 * ผู้ใช้สั่ง: *"กระดิ่ง 🔔 ในหัวหน้า"* (ตอนแรกเลือกได้แค่แท็บ + กระดิ่ง)
 *
 * ── หลักการ ────────────────────────────────────────────────────────
 *
 * 1. **จำนวนที่ยังไม่อ่านมาจากพ่อเสมอ** (`unread` prop)
 *    ไม่ยิง API เองทิ้งเปล่า ๆ เพราะแท็บ "จดหมาย" ก็ต้องใช้ตัวเลขเดียวกัน
 *    ถ้าสองที่นับเองเมื่อไร ป้ายบนกระดิ่งกับป้ายบนแท็บก็จะไม่ตรงกัน
 *
 * 2. **รายการ 5 ฉบับล่าสุดโหลดตอนเปิดเท่านั้น**
 *    ผู้ใช้ส่วนใหญ่ไม่กดกระดิ่งเลย → ถ้าโหลดตอน mount ทุกครั้ง
 *    เราจะจ่ายคำขอที่ไม่มีใครดูผลลัพธ์ทุกหน้าเว็บ
 *
 * 3. **popover ต้อง `position: fixed`**
 *    หัวหน้าหน้า Studio อยู่ในโครง flex ที่โกง/ยืดได้ ถ้าใช้ absolute
 *    กล่องจะถูกปัดตามหัวหน้าและบางครั้งโดนกล่องอื่นทับ
 *    จึงวัดตำแหน่งจริงจากปุ่มแล้ววางแบบ fixed (ดู CSS ท้ายไฟล์)
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { ApiError, api } from './lib/api'
import { KIND_ICON, KIND_LABEL, timeAgo } from './InboxPanel'
import type { Notification } from '@docgen/shared'

/** จดหมายในกล่องเล็ก — 5 ฉบับพอให้เห็นว่ามีอะไรใหม่ โดยไม่กินหน้าจอ */
const POP_ITEMS = 5

export default function InboxBell({
  unread,
  onOpenInbox,
}: {
  /** จำนวนที่ยังไม่อ่าน — ให้พ่อ (Studio) เป็นคนโหลดและส่งลงมา */
  unread: number
  /** พาไปแท็บจดหมาย (ปุ่ม "ดูทั้งหมด") */
  onOpenInbox: () => void
}) {
  const [open, setOpen] = useState(false)
  const [items, setItems] = useState<Notification[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const wrap = useRef<HTMLDivElement>(null)
  const btn = useRef<HTMLButtonElement>(null)
  /**
   * ตำแหน่งของ popover แบบ fixed
   *
   * ⚠️ เก็บเป็น state ไม่ใช่คำนวณใน render
   *   เพราะต้องวัดหลัง browser วาดปุ่มเสร็จ (ตอน mount ครั้งแรกยังไม่มี layout)
   */
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)

  const place = useCallback(() => {
    const r = btn.current?.getBoundingClientRect()
    if (!r) return
    // ชิดขวาให้ตรงกับปุ่ม และกันไม่ให้ล้นขอบจอตอนจอแคบ
    const w = Math.min(340, window.innerWidth - 24)
    const left = Math.max(12, Math.min(r.right - w, window.innerWidth - w - 12))
    /*
     * ⚠️ ต้องพลิกเปิด**ขึ้นเหนือ**ปุ่มเมื่อข้างล่างไม่พอที่
     *   ตอนกระดิ่งอยู่กลางหน้า ข้างล่างมีที่เสมอ แต่พอย้ายไปอยู่ท้าย sidebar
     *   กล่องจะล้นออกจอล่างทันที (เคยตกไป 1 ข้อ: ล้นล่าง 275px ที่จอ 1600x1000)
     *
     * เติมด้านล่าง (สูงสุดเท่าที่พอ) เพราะสิ่งที่ผู้ใช้ต้องเห็นคือรายการใหม่
     * ไม่ใช่ปุ่มกระดิ่งที่กดอยู่
     */
    const h = POP_ITEMS * 58 + 104
    const roomBelow = window.innerHeight - r.bottom - 8
    const roomAbove = r.top - 8
    const top =
      roomBelow >= h
        ? r.bottom + 8
        : roomAbove >= h
          ? r.top - 8 - h
          : Math.max(12, Math.min(r.bottom + 8, window.innerHeight - h - 12))
    setPos({ top, left })
  }, [])

  const toggle = useCallback(() => {
    setOpen((v) => {
      if (!v) place()
      return !v
    })
  }, [place])

  // โหลด 5 ฉบับล่าสุดตอนเปิดเท่านั้น (ดูหลักการข้อ 2)
  useEffect(() => {
    if (!open) return
    let alive = true
    setLoading(true)
    setError(null)
    void api
      .listNotifications({ limit: POP_ITEMS })
      .then((r) => {
        if (!alive) return
        setItems(r.items)
        setLoading(false)
      })
      .catch((e) => {
        if (!alive) return
        setError(e instanceof ApiError ? e.message : String(e))
        setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [open])

  // ปิดเมื่อคลิกนอกกล่อง หรือกด Escape
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false)
        // คืนโฟกัสให้ปุ่มกระดิ่ง ไม่งั้นผู้ใช้ที่พิมพ์ด้วยคีย์บอร์ดจะหลุดไปที่ body
        btn.current?.focus()
      }
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  // จอบ/หมุนจอแล้วตำแหน่งปุ่มเปลี่ยน → วัดใหม่ (ไม่งั้นกล่องจะลอยไปคนละที่)
  useEffect(() => {
    if (!open) return
    const onResize = () => place()
    window.addEventListener('resize', onResize)
    window.addEventListener('scroll', onResize, true)
    return () => {
      window.removeEventListener('resize', onResize)
      window.removeEventListener('scroll', onResize, true)
    }
  }, [open, place])

  return (
    <div className="inbox-bell" ref={wrap}>
      <button
        ref={btn}
        type="button"
        className="inbox-bell__btn"
        data-testid="inbox-bell"
        onClick={toggle}
        aria-label={
          unread > 0 ? `กล่องจดหมาย มี ${unread} ฉบับที่ยังไม่อ่าน` : 'กล่องจดหมาย (ไม่มีฉบับที่ยังไม่อ่าน)'
        }
        aria-expanded={open}
        title="กล่องจดหมาย"
      >
        <span aria-hidden="true">🔔</span>
        {/* ซ่อนป้ายเมื่อไม่มีอะไรค้าง — ป้ายเลข 0 ทำให้ผู้ใช้คิดว่ายังมีอะไรใหม่ */}
        {unread > 0 && (
          <span className="inbox-bell__count" data-testid="inbox-bell-count">
            {unread > 99 ? '99+' : unread}
          </span>
        )}
      </button>

      {open && (
        <div
          className="inbox-bell__pop"
          data-testid="inbox-bell-pop"
          role="dialog"
          aria-label="จดหมายล่าสุด"
          style={pos ? { top: pos.top, left: pos.left } : undefined}
        >
          <div className="inbox-bell__head">
            <strong>จดหมายล่าสุด</strong>
            {unread > 0 && <span className="pill">ยังไม่อ่าน {unread}</span>}
          </div>

          {loading ? (
            <div className="muted inbox-bell__state">กำลังโหลด…</div>
          ) : error ? (
            <div className="inbox-bell__state">
              <div className="ntf-err">{error}</div>
              <button type="button" className="ghost" onClick={toggle}>
                ลองใหม่
              </button>
            </div>
          ) : items.length === 0 ? (
            <div className="muted inbox-bell__state">ยังไม่มีจดหมาย</div>
          ) : (
            <ul className="inbox-bell__list">
              {items.map((n) => (
                <li key={n._id} className={`inbox-bell__row${n.read ? '' : ' is-unread'}`}>
                  <span aria-hidden="true">{KIND_ICON[n.kind]}</span>
                  <span className="inbox-bell__txt">
                    <span className="inbox-bell__t">{n.title}</span>
                    <span className="muted inbox-bell__m">
                      {KIND_LABEL[n.kind]} · {timeAgo(n.at)}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          )}

          <div className="inbox-bell__foot">
            <button
              type="button"
              className="ghost"
              onClick={() => {
                setOpen(false)
                onOpenInbox()
              }}
            >
              ดูทั้งหมด
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
