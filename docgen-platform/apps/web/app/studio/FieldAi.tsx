'use client'

/**
 * ผู้ช่วย AI ประจำช่องกรอก — ไอคอนอยู่ขวาสุดของช่อง
 *
 * หน้าที่ 3 อย่างตามที่ผู้ใช้ขอ
 *   1. **ร่างให้**   — บอกคร่าว ๆ แล้วให้ AI เขียนข้อความให้ทั้งช่อง
 *   2. **แก้ไข**    — ช่องมีของอยู่แล้ว ให้ AI ช่วยปรับให้สุภาพ/อ่านง่ายขึ้น
 *   3. **ให้คำแนะนำ** — ถามเรื่องรูปแบบ กฎหมาย หรือสำนวน แล้วอ่านคำแนะนำ
 *
 * ── กติกาที่ตั้งใจทำ ────────────────────────────────────────────
 *   · **AI ไม่เขียนทับช่องเอง** — ทุกครั้งต้องผู้ใช้กด "ใส่ในช่องนี้" เอง
 *     ข้อความที่คนพิมพ์เองยากจะแก้ทิ้งไม่ได้ ถ้าให้ AI เขียนทับเงียบ ๆ
 *   · คุยกันได้หลายรอบ (ประวัติอยู่ใน state ของ component)
 *     API จะรับประวัติมาได้ในอนาคต แต่ตอนนี้ส่งทีละข้อความพอ
 *   · ปิดเองเมื่อคลิกที่อื่นหรือกด Esc เหมือนเมนูอื่นของระบบ
 *   · ช่องตัวเลขต้องผ่านการแปลงค่าก่อน ไม่งั้น AI ตอบ "ประมาณ 5,000 บาท"
 *     แล้ว `Number()` ได้ NaN แล้วช่องพังทันที
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { api, ApiError, type LlmStatus } from './lib/api'
import type { FieldDef } from './lib/api'

type Provider = 'minimax' | 'openai' | 'mock'

const PROVIDERS: Array<{ id: Provider; label: string }> = [
  { id: 'minimax', label: 'MiniMax' },
  { id: 'openai', label: 'OpenAI' },
  { id: 'mock', label: 'ทดสอบ' },
]

/** ปุ่มลัดที่ผู้ใช้กดบ่อย — ส่งตรง ๆ ไม่ต้องพิมพ์เอง */
const QUICK: Array<{ id: string; label: string; ask: string }> = [
  { id: 'draft', label: 'ร่างให้', ask: 'ช่วยร่างข้อความสำหรับช่องนี้ให้หน่อย' },
  { id: 'polish', label: 'แก้ให้สุภาพ', ask: 'ช่วยแก้ข้อความในช่องนี้ให้เป็นภาษาราชการที่สุภาพ' },
  { id: 'short', label: 'สั้นลง', ask: 'ช่วยย่อข้อความในช่องนี้ให้สั้นลง แต่ยังครบใจความ' },
  { id: 'advise', label: 'ขอคำแนะนำ', ask: 'ช่องนี้ควรเขียนอย่างไรให้ถูกต้องตามรูปแบบหนังสือราชการ' },
]

type Turn = { id: string; role: 'user' | 'ai'; text: string; proposal?: string }

/** แปลงข้อความจาก AI ให้เข้ากับชนิดของช่อง — คืน null ถ้าใส่ไม่ได้จริง */
function coerce(raw: unknown, type: string): { ok: true; value: unknown } | { ok: false; why: string } {
  const text = typeof raw === 'string' ? raw : raw == null ? '' : String(raw)

  if (type === 'number' || type === 'integer') {
    // ตัดทิ้งทุกอย่างที่ไม่ใช่ตัวเลข แล้วลองอ่านเป็นเลขไทย/อาหรับด้วย
    const digits = text.replace(/[^\d.,-]/g, '')
    const normalized = digits.replace(/,/g, '').replace(/,(?=\d{3}\b)/g, ',')
    const n = Number(normalized)
    if (!normalized || Number.isNaN(n)) {
      return { ok: false, why: 'AI ตอบมาไม่ใช่ตัวเลข — แก้เองหรือบอก AI ให้ตอบเป็นตัวเลขล้วน' }
    }
    return { ok: true, value: type === 'integer' ? Math.round(n) : n }
  }

  if (type === 'date') {
    // ช่องวันที่ใช้ <input type="date"> ต้องได้ yyyy-mm-dd
    const m = text.match(/(\d{4})-(\d{2})-(\d{2})/)
    if (m) return { ok: true, value: m[0] }
    return { ok: false, why: 'ช่องนี้เป็นช่องวันที่ — ให้ AI ตอบเป็น วัน/เดือน/ปี พ.ศ. แล้วพิมพ์เอง' }
  }

  return { ok: true, value: text }
}

export default function FieldAi({
  field,
  value,
  templateKey,
  templateName,
  onApply,
  notify,
}: {
  field: FieldDef
  value: unknown
  templateKey: string
  templateName: string
  /** เขียนค่ากลับเข้าช่อง — ผู้ใช้กดยืนยันเองเท่านั้น */
  onApply: (v: unknown) => void
  notify: (msg: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [turns, setTurns] = useState<Turn[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  /**
   * ⚠️ ค่าเริ่มต้น**ต้องเป็น `mock`** ไม่ใช่ `minimax`
   *
   * ค่าจริงมาจาก `llmStatus()` ซึ่งยิงเมื่อเปิด popover เท่านั้น
   * ถ้าเริ่มที่ `minimax` แล้วผู้ใช้กดส่งก่อน status จะกลับมา
   * → ยิง provider ที่ไม่มี key → 503 `LLM_NOT_CONFIGURED`
   *
   * mock ไม่ต้องใช้ key จึงเป็นค่าเริ่มต้นที่ปลอดภัยที่สุด
   * (แย่กว่าเดิมแค่ตอนผู้ใช้ยังไม่ได้ตั้ง key — ซึ่งได้คำตอบทดสอบแทนที่จะพัง)
   */
  const [provider, setProvider] = useState<Provider>('mock')
  const [status, setStatus] = useState<LlmStatus | null>(null)
  const logRef = useRef<HTMLDivElement>(null)
  const boxRef = useRef<HTMLDivElement>(null)
  const current = String(value ?? '')

  // เปิดครั้งแรกค่อยถามสถานะ — ไม่ยิงตอนยังไม่ได้กด ประหยัด request
  useEffect(() => {
    if (!open || status) return
    void api
      .llmStatus()
      .then((s) => {
        setStatus(s)
        // ค่าเริ่มต้นต้องเป็นตัวที่เซิร์ฟเวอร์ใช้จริง ไม่งั้นผู้ใช้จะเจอ 401 ทันที
        setProvider(s.configured ? (s.provider as Provider) : 'mock')
      })
      .catch(() => setStatus(null))
  }, [open, status])

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight })
  }, [turns])

  const send = useCallback(
    async (text: string) => {
      const ask = text.trim()
      if (!ask || busy) return
      setBusy(true)
      setInput('')
      setTurns((t) => [...t, { id: `u-${Date.now()}`, role: 'user', text: ask }])

      try {
        const r = await api.chat({
          templateKey,
          message: ask,
          data: {},
          templateName,
          provider,
          field: {
            key: field.key,
            label: field.label || field.key,
            type: field.type,
            value: current.slice(0, 8000),
          },
        })
        const raw = r.data[field.key]
        setTurns((t) => [
          ...t,
          {
            id: `a-${Date.now()}`,
            role: 'ai',
            text: r.reply,
            // เก็บข้อเสนอไว้ฝั่ง client เท่านั้น — ยังไม่เขียนลงช่องจนกว่าจะกดยืนยัน
            proposal: typeof raw === 'string' ? raw : undefined,
          },
        ])
      } catch (e) {
        setTurns((t) => [
          ...t,
          { id: `e-${Date.now()}`, role: 'ai', text: `เรียก AI ไม่สำเร็จ: ${e instanceof ApiError ? e.message : String(e)}` },
        ])
      } finally {
        setBusy(false)
      }
    },
    [busy, current, field.key, field.label, field.type, provider, templateKey, templateName],
  )

  const apply = (text: string) => {
    const r = coerce(text, field.type)
    if (!r.ok) {
      notify(r.why)
      return
    }
    onApply(r.value)
    setOpen(false)
  }

  const label = field.label?.trim() || field.key

  return (
    <div className="fieldai" ref={boxRef}>
      <button
        type="button"
        className="fieldai__btn"
        aria-label={`ให้ AI ช่วยช่อง ${label}`}
        aria-expanded={open}
        title="ให้ AI ช่วยร่าง / แก้ไข / ให้คำแนะนำในช่องนี้"
        onClick={() => setOpen((o) => !o)}
      >
        <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
          <path
            fill="currentColor"
            d="M12 2.5l1.6 4.5 4.5 1.6-4.5 1.6L12 14.7l-1.6-4.5L5.9 8.6l4.5-1.6L12 2.5zM18.5 13l.9 2.4 2.4.9-2.4.9-.9 2.4-.9-2.4-2.4-.9 2.4-.9.9-2.4zM6.5 14l.7 1.9 1.9.7-1.9.7-.7 1.9-.7-1.9-1.9-.7 1.9-.7.7-1.9z"
          />
        </svg>
      </button>

      {open && (
        <div className="fieldai__pop" role="dialog" aria-label={`ผู้ช่วย AI สำหรับช่อง ${label}`}>
          <div className="fieldai__head">
            <strong>AI ช่วยช่อง “{label}”</strong>
            <button className="ghost fieldai__x" onClick={() => setOpen(false)} aria-label="ปิด">
              ×
            </button>
          </div>

          <div className="fieldai__tools">
            {QUICK.map((q) => (
              <button key={q.id} className="pill" disabled={busy} onClick={() => void send(q.ask)}>
                {q.label}
              </button>
            ))}
          </div>

          <select
            className="fieldai__prov"
            value={provider}
            onChange={(e) => setProvider(e.target.value as Provider)}
            title="เลือกผู้ให้บริการ AI"
          >
            {PROVIDERS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
          {status && !status.configured && <span className="pill warn">ยังไม่ได้ตั้ง key</span>}

          <div className="fieldai__log" ref={logRef}>
            {turns.length === 0 && (
              <p className="muted" style={{ margin: 0, fontSize: 12.5 }}>
                กดปุ่มด้านบนเพื่อให้ AI ช่วย หรือพิมพ์สิ่งที่ต้องการเอง
              </p>
            )}
            {turns.map((t) => (
              <div key={t.id} className={`fieldai__msg fieldai__msg--${t.role}`}>
                {t.text}
                {t.proposal !== undefined && (
                  <button className="fieldai__apply" onClick={() => apply(t.proposal as string)}>
                    ใส่ในช่องนี้
                  </button>
                )}
              </div>
            ))}
            {busy && <div className="fieldai__msg fieldai__msg--pending">กำลังคิด…</div>}
          </div>

          <div className="fieldai__composer">
            <textarea
              rows={2}
              value={input}
              placeholder="เช่น เขียนให้สุภาพแต่ไม่ยาวเกินไป"
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  void send(input)
                }
              }}
            />
            <button onClick={() => void send(input)} disabled={busy || !input.trim()}>
              ส่ง
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
