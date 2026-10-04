'use client'

import { useEffect, useId, useRef, useState } from 'react'
import type { PendingShare, PersonSuggestion } from '@docgen/shared'
import { api, ApiError, templateKeyOf, type AccessView, type Template } from './lib/api'

/**
 * ── ช่อง "อนุญาตให้ใครใช้ได้" เวอร์ชันพิมพ์อีเมล ────────────────────
 *
 * ผู้ใช้สั่ง: *"พิมพ์ซัก 3 ตัวอักษร แล้วจะมีเมล์ที่ผู้ใช้ login เข้าใช้งาน
 * ในระบบนี้แสดงขึ้นมา เอาข้อมูลจากประวัติที่เคยแชร์"*
 *
 * เดิมช่องนี้รับแต่ `sub` ของ Casdoor — เป็น id ยาว ๆ อย่าง `1a2b3c4d-…`
 * ที่ผู้ใช้หามาไม่ได้ เพราะไม่รู้ว่าของใคร ต้องไปเปิดหน้า Casdoor มาก็อยู่ดี
 *
 * ⚠️ ยังรับ `sub` ได้เหมือนเดิม
 *   คนที่เคยก๊อปปีสตริง sub มาวางไว้ก่อนหน้านี้ ต้องยังใช้ได้
 *   เลยแยกสามทางตอนกด "เพิ่ม": เลือกจากรายชื่อ / พิมพ์อีเมล / วาง sub
 */

/** พิมพ์ถึงกี่ตัวอักษรแล้วค่อยค้น — ตรงกับที่ API บังคับ (`PEOPLE_MIN_QUERY`) */
const MIN_QUERY = 3
/** หน่วงก่อนยิงค้น — พิมพ์เร็ว ๆ ไม่ต้องยิงทุกตัวอักษร */
const DEBOUNCE_MS = 180

/** หน้าตาเหมือนอีเมลพอใช้ — คนพิมพ์ผิดบางที่ก็ยังจับได้ แต่ไม่ปฏิเสธตรง ๆ */
const EMAILISH = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export default function PeoplePicker({
  template,
  onAccess,
  notify,
  busy,
}: {
  template: Template
  onAccess: (a: AccessView) => void
  notify: (msg: string) => void
  busy: boolean
}) {
  const templateKey = templateKeyOf(template)
  const listId = useId()

  const [q, setQ] = useState('')
  const [role, setRole] = useState<'viewer' | 'editor'>('viewer')
  const [items, setItems] = useState<PersonSuggestion[]>([])
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  /** เลือกจากรายชื่อมาแล้ว = รู้ `sub` แน่นอน (พิมพ์เองอาจไม่รู้) */
  const [picked, setPicked] = useState<PersonSuggestion | null>(null)
  const [pending, setPending] = useState<PendingShare[]>([])
  const [mailReady, setMailReady] = useState<boolean | null>(null)
  const [loading, setLoading] = useState(false)

  const boxRef = useRef<HTMLDivElement>(null)
  const seq = useRef(0)

  const loadPending = () => {
    void api
      .pendingShares(templateKey)
      .then((r) => setPending(r.items ?? []))
      .catch(() => setPending([]))
  }

  useEffect(loadPending, [templateKey])

  // คลิกที่อื่นนอกกล่อง = ปิดรายชื่อ (ไม่ล้างข้อความที่พิมพ์ไว้)
  useEffect(() => {
    const onDocDown = (e: MouseEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDocDown)
    return () => document.removeEventListener('mousedown', onDocDown)
  }, [])

  /**
   * ค้นรายชื่อ — ผันตัวเลขของคำขอเก่าทิ้ง
   *
   * ⚠️ ถ้าไม่ทำแบบนี้ ผู้ใช้พิมพ์เร็ว ๆ แล้วผลของคำค้นเก่าจะทับของใหม่
   *   คนพิมพ์ "som" แล้วเห็นรายชื่อของ "s" = กดผิดคน
   */
  useEffect(() => {
    const query = q.trim()
    /**
     * ⚠️ ล้าง `picked` เฉพาะเมื่อข้อความที่พิมพ์**ไม่ตรงกับคนที่เพิ่งเลือก**
     *   ถ้าล้างทุกครั้งที่ `q` เปลี่ยน การเลือกจากรายชื่อจะถูกล้างทิเลย
     *   เพราะ `choose()` เซ็ต `q` = อีเมล → effect นี้ทำงานตามทันที
     *   ผลคือผู้ใช้เลือกคนในระบบแล้ว ระบบยังคิดว่า "ไม่รู้จัก" → เสนอให้เชิญด้วยอีเมล
     */
    setPicked((cur) => (cur && cur.email.toLowerCase() === query.toLowerCase() ? cur : null))
    if (query.length < MIN_QUERY) {
      setItems([])
      setOpen(false)
      return
    }
    const my = ++seq.current
    const timer = setTimeout(() => {
      setLoading(true)
      void api
        .searchPeople(query)
        .then((r) => {
          if (my !== seq.current) return
          setItems(r.items ?? [])
          setMailReady(r.mailReady)
          setOpen(true)
          setActive(0)
        })
        .catch(() => {
          if (my !== seq.current) return
          setItems([])
        })
        .finally(() => {
          if (my === seq.current) setLoading(false)
        })
    }, DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [q])

  function choose(p: PersonSuggestion) {
    setQ(p.email)
    setPicked(p)
    setOpen(false)
    setItems([])
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Escape') {
      setOpen(false)
      return
    }
    if (!open || items.length === 0) {
      if (e.key === 'ArrowDown') setOpen(true)
      return
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActive((i) => (i + 1) % items.length)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActive((i) => (i - 1 + items.length) % items.length)
    } else if (e.key === 'Enter') {
      // ปล่อยให้ Enter ทำงานตามปกติตอนไม่มีรายชื่อให้เลือก (ปุ่ม "เพิ่ม" อยู่ในฟอร์ม)
      if (active >= 0 && active < items.length) {
        e.preventDefault()
        choose(items[active]!)
      }
    }
  }

  async function submit() {
    const value = q.trim()
    if (!value) return

    // 1. เลือกจากรายชื่อมา → รู้ sub แน่นอน ใช้ทางเดิม
    if (picked) {
      onAccess(await api.share(templateKey, picked.sub, role, picked.name ?? undefined))
      notify(`เพิ่ม ${picked.name ?? picked.email} แล้ว`)
    } else if (EMAILISH.test(value)) {
      // 2. อีเมลที่ไม่มีในระบบ → เชิญ แล้วรอเขาเข้าสู่ระบบครั้งแรก
      const r = await api.inviteByEmail(templateKey, value, role)
      notify(
        r.emailed
          ? `ส่งคำเชิญไปที่ ${value} แล้ว — สิทธิ์จะเข้าตอนเขาเข้าสู่ระบบครั้งแรก`
          : `บันทึกคำเชิญ ${value} ไว้แล้ว แต่ยังส่งอีเมลไม่ได้ (${r.reason}) — สิทธิ์จะเข้าตอนเขาเข้าสู่ระบบครั้งแรก`,
      )
      loadPending()
    } else {
      // 3. วาง sub ของ Casdoor มา (ทางเดิมของระบบ) — ยังใช้ได้
      onAccess(await api.share(templateKey, value, role))
      notify('เพิ่มสิทธิ์แล้ว')
    }

    setQ('')
    setPicked(null)
    setItems([])
    setOpen(false)
  }

  const trimmed = q.trim()
  /** ปุ่ม "เพิ่ม" จะเชิญด้วยอีเมล (แทนการแชร์ทันที) ก็ต่อเมื่อพิมพ์เป็นอีเมลจริง */
  const isInvite = !picked && EMAILISH.test(trimmed)

  return (
    <div ref={boxRef} className="ppick">
      <div className="ppick__row">
        <div className="ppick__field">
          <label htmlFor={`${listId}-q`}>อีเมลผู้ใช้ (จาก Casdoor)</label>
          <input
            id={`${listId}-q`}
            data-testid="share-email-input"
            value={q}
            disabled={busy}
            placeholder="พิมพ์อีเมล 3 ตัวอักษรขึ้นไป เช่น somchai@"
            autoComplete="off"
            role="combobox"
            aria-expanded={open}
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={open && active >= 0 ? `${listId}-opt-${active}` : undefined}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={onKeyDown}
            onFocus={() => {
              if (items.length) setOpen(true)
            }}
          />
          {open && items.length > 0 && (
            <ul className="ppick__list" id={listId} role="listbox" data-testid="ppick-list">
              {items.map((p, i) => (
                <li
                  key={p.sub}
                  id={`${listId}-opt-${i}`}
                  role="option"
                  aria-selected={i === active}
                  className={'ppick__opt' + (i === active ? ' is-on' : '')}
                  data-testid="ppick-option"
                  // ใช้ onMouseDown ไม่ใช่ onClick — onClick จะไม่ทำงาน
                  // เพราะ mousedown ไป blur input แล้วปิดรายชื่อทิ้งก่อน
                  onMouseDown={(e) => {
                    e.preventDefault()
                    choose(p)
                  }}
                >
                  <span className="ppick__name">{p.name ?? p.email}</span>
                  <span className="ppick__mail">{p.email}</span>
                  {p.shared && <span className="ppick__tag">เคยแชร์ด้วยกัน</span>}
                </li>
              ))}
            </ul>
          )}
          {open && items.length === 0 && !loading && (
            <div className="ppick__empty" data-testid="ppick-empty">
              ไม่พบคนที่เคยเข้าใช้ระบบนี้ — กด “เชิญด้วยอีเมล” ได้เลย
            </div>
          )}
        </div>

        <div>
          <label htmlFor={`${listId}-role`}>สิทธิ์</label>
          <select
            id={`${listId}-role`}
            value={role}
            disabled={busy}
            onChange={(e) => setRole(e.target.value as 'viewer' | 'editor')}
          >
            <option value="viewer">ดูอย่างเดียว</option>
            <option value="editor">แก้ไขได้</option>
          </select>
        </div>

        <button
          type="button"
          disabled={busy || !trimmed}
          data-testid={isInvite ? 'share-invite' : 'share-add'}
          onClick={() =>
            void submit().catch((e) => notify(e instanceof ApiError ? e.message : String(e)))
          }
        >
          {isInvite ? 'เชิญด้วยอีเมล' : 'เพิ่ม'}
        </button>
      </div>

      {mailReady === false && (
        <p className="ppick__warn" data-testid="ppick-mail-warn">
          ⚠️ ยังไม่ได้ตั้งเซิร์ฟเวอร์อีเมล — ระบบรับคำเชิญไว้ให้แล้ว
          แต่จะไม่มีอีเมลไปแจ้ง สิทธิ์ยังได้ปกติตอนผู้ถูกเชิญเข้าสู่ระบบครั้งแรก
        </p>
      )}

      {pending.length > 0 && (
        <div className="ppick__pending" data-testid="ppick-pending">
          <div className="ppick__pending-h">รอเข้าระบบ ({pending.length})</div>
          {pending.map((p) => (
            <div className="ppick__pending-row" key={p.email}>
              <span className="ppick__mail">{p.email}</span>
              <span className="muted" style={{ fontSize: 12 }}>
                {p.role === 'editor' ? 'แก้ไขได้' : 'ดูอย่างเดียว'}
              </span>
              <button
                type="button"
                className="ghost danger"
                style={{ padding: '2px 8px', fontSize: 12 }}
                data-testid="ppick-cancel"
                onClick={() =>
                  void api
                    .cancelInvite(templateKey, p.email)
                    .then(() => {
                      notify(`ยกเลิกคำเชิญ ${p.email} แล้ว`)
                      loadPending()
                    })
                    .catch((e) => notify(e instanceof ApiError ? e.message : String(e)))
                }
              >
                ยกเลิก
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
