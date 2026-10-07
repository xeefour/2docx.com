'use client'

/**
 * แก้ไข JSON พร้อมตัวช่วยแท็ก `{d.*}`
 *
 * ── ทำไมไม่ใช้ CodeMirror ────────────────────────────────────
 * ตัวช่วยที่ต้องมีมีแค่ 2 อย่าง: ดูว่าแม่แบบนี้ต้องใช้ field อะไร และเติมชื่อให้
 * ทั้งคู่ทำได้ด้วย textarea + รายการตัวเลือก ขนาดจริงหลักฐานว่า
 * ลาก dependency หนัก ๆ (หลายร้อย KB) มาได้เปล่า ๆ
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import type { TemplateTag } from './api'

type Props = {
  value: string
  onChange: (next: string) => void
  tags: TemplateTag[]
  disabled?: boolean
}

export function JsonEditor({ value, onChange, tags, disabled }: Props) {
  const ref = useRef<HTMLTextAreaElement>(null)
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const [prefix, setPrefix] = useState('')

  /** คีย์ที่ผู้ใช้พิมพ์อยู่ตอนนี้ (นับย้อนจาก caret จนเจอตัวคั่น) */
  const currentWord = useMemo(() => {
    const el = ref.current
    if (!el) return ''
    const upto = value.slice(0, el.selectionStart)
    // จบที่เครื่องหมาย JSON ใด ๆ
    const m = /[^\s"':,{}[\]]*$/.exec(upto)
    return m?.[0] ?? ''
  }, [value])

  const matches = useMemo(() => {
    if (!currentWord) return []
    const q = currentWord.toLowerCase()
    return tags.filter((t) => t.path.toLowerCase().includes(q)).slice(0, 40)
  }, [currentWord, tags])

  // เปิดรายการตัวเลือกเมื่อมีทั้งคำที่พิมพ์และแท็กที่ตรงกัน
  useEffect(() => {
    if (currentWord.length >= 1 && matches.length > 0) {
      setOpen(true)
      setPrefix(currentWord)
      setActive(0)
    } else {
      setOpen(false)
    }
  }, [currentWord, matches])

  /** แทรก field ที่เลือก ณ ตำแหน่ง caret ปัจจุบัน */
  function apply(path: string) {
    const el = ref.current
    if (!el) return

    const start = el.selectionStart - prefix.length
    const quoteBefore = value[start - 1] === '"'
    const quoted = quoteBefore ? path : `"${path}"`

    const next = value.slice(0, start) + quoted + value.slice(el.selectionStart)
    onChange(next)

    // ย้าย caret ไปหลังข้อความที่เพิ่งแทรก
    requestAnimationFrame(() => {
      const caret = start + quoted.length
      el.focus()
      el.setSelectionRange(caret, caret)
    })
    setOpen(false)
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (!open || matches.length === 0) return

    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActive((a) => (a + 1) % matches.length)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActive((a) => (a - 1 + matches.length) % matches.length)
    } else if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
      // Enter ต้องขึ้นบรรทัดใหม่ได้ — ใช้ Tab เป็นหลัก Enter ใช้เมื่อเลือกจากคลิก
      e.preventDefault()
      const pick = matches[active]
      if (pick) apply(pick.path)
    } else if (e.key === 'Escape') {
      setOpen(false)
    }
  }

  const jsonValid = useMemo(() => {
    try {
      JSON.parse(value)
      return true
    } catch {
      return false
    }
  }, [value])

  return (
    <div style={{ position: 'relative', display: 'flex', flexDirection: 'column', height: '100%' }}>
      <textarea
        ref={ref}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        disabled={disabled}
        spellCheck={false}
        placeholder='{ "ชื่อ": "…" }'
        style={{
          flex: 1,
          minHeight: 260,
          fontFamily: "ui-monospace, 'Cascadia Code', Consolas, monospace",
          fontSize: 13,
          lineHeight: 1.7,
          resize: 'none',
          border: 'none',
          borderRadius: 0,
          padding: 14,
          tabSize: 2,
        }}
      />

      {/* รายการตัวเลือก */}
      {open && matches.length > 0 && (
        <div
          style={{
            position: 'absolute',
            left: 14,
            right: 14,
            bottom: 14,
            maxHeight: 210,
            overflow: 'auto',
            background: 'var(--surface)',
            border: '1px solid var(--brand-border)',
            borderRadius: 8,
            boxShadow: 'var(--shadow-md)',
            zIndex: 20,
          }}
        >
          <div
            style={{
              padding: '7px 12px',
              fontSize: 11,
              color: 'var(--ink-3)',
              borderBottom: '1px solid var(--line)',
              position: 'sticky',
              top: 0,
              background: 'var(--surface)',
            }}
          >
            {matches.length} แท็กที่ตรงกับ “{prefix}” · Tab เพื่อเลือก
          </div>
          {matches.map((t, i) => (
            <button
              key={t.path}
              type="button"
              onMouseDown={(e) => {
                e.preventDefault()
                apply(t.path)
              }}
              onMouseEnter={() => setActive(i)}
              style={{
                display: 'flex',
                width: '100%',
                textAlign: 'left',
                background: i === active ? 'var(--brand-soft)' : 'transparent',
                border: 'none',
                borderRadius: 0,
                padding: '7px 12px',
                gap: 8,
                alignItems: 'center',
              }}
            >
              <code className="mono" style={{ color: 'var(--brand-dark)', flex: 1 }}>
                {t.path}
              </code>
              {t.count > 1 && <span className="muted" style={{ fontSize: 11 }}>ใช้ {t.count} ครั้ง</span>}
            </button>
          ))}
        </div>
      )}

      {/* สถานะความถูกต้องของ JSON */}
      <div
        style={{
          display: 'flex',
          gap: 8,
          alignItems: 'center',
          padding: '7px 12px',
          borderTop: '1px solid var(--line)',
          fontSize: 12,
          background: 'var(--bg)',
        }}
      >
        <span className={`pill ${jsonValid ? 'ok' : 'err'}`}>
          {jsonValid ? 'JSON ถูกต้อง' : 'JSON ผิดรูปแบบ'}
        </span>
        <span className="muted">
          แท็กในแม่แบบนี้ {tags.length} ตัว
        </span>
      </div>
    </div>
  )
}
