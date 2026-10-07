'use client'

/**
 * แผง AI ช่วยกรอกข้อมูล
 *
 * ผู้ใช้เล่าความต้องการด้วยภาษาธรรมดา (เช่น "ออกหนังสือรับรองให้นายสมชาย
 * เรื่องขออนุญาตเปลี่ยนประจำรถ") → AI เติมข้อมูลทุกช่องให้
 *
 * ข้อที่ตั้งใจทำ:
 *   · ประวัติแชทเก็บเป็น "ข้อความ" จริง (ฝั่ง server) กลับมาคุยต่อได้
 *   · ค่าที่ผู้ใช้กรอกเองจะไม่ถูก AI ทับ (merge ที่ฝั่ง API)
 *   · **ไม่มีตัวเลือกผู้ให้บริการ** (ผู้ใช้สั่ง 2026-10-06: ใช้ MiniMax อย่างเดียว)
 *     ค่าที่ใช้จริงมาจาก `LLM_PROVIDER` ในฝั่ง server — หน้าเว็บไม่ส่งค่านี้ไปเลย
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  api,
  ApiError,
  type ChatMessage,
  type ChatSessionMeta,
  type FieldDef,
  type LlmStatus,
} from './lib/api'
import { fieldLabel, getPath, middleTruncate } from './lib/fields'

export default function AiChat({
  templateKey,
  templateName,
  fields,
  data,
  onData,
  notify,
}: {
  templateKey: string
  templateName: string
  /** ช่องของแม่แบบนี้ — ใช้แสดง**ป้าย**แทน key ดิบ (key มีจุดคั่น อ่านไม่ออก) */
  fields: FieldDef[]
  /** ข้อมูลที่กรอกไว้แล้ว — ส่งให้ AI รู้ว่าขาดอะไร */
  data: Record<string, unknown>
  /** AI เติมข้อมูลกลับมา → ผู้ใช้เอาไปใช้ต่อในฟอร์ม */
  onData: (next: Record<string, unknown>, changed: string[]) => void
  notify: (msg: string) => void
}) {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [sessionId, setSessionId] = useState<string | undefined>()
  const [sessions, setSessions] = useState<ChatSessionMeta[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<LlmStatus | null>(null)
  const logRef = useRef<HTMLDivElement>(null)

  /** key → ป้าย สร้างครั้งเดียวต่อแม่แบบ เพราะค้นทีละข้อคือ O(n²) ตอนมีหลายช่อง */
  const labelOf = useCallback(
    (key: string) => fieldLabel(fields.find((f) => f.key === key) ?? { key } as FieldDef),
    [fields],
  )

  useEffect(() => {
    void api
      .llmStatus()
      .then(setStatus)
      .catch(() => setStatus(null))
  }, [])

  const loadSessions = useCallback(async () => {
    try {
      const r = await api.chatSessions(templateKey)
      setSessions(r.items)
    } catch {
      /* ไม่มี session ก็ไม่เป็นไร */
    }
  }, [templateKey])

  useEffect(() => {
    void loadSessions()
    setMessages([])
    setSessionId(undefined)
  }, [templateKey, loadSessions])

  useEffect(() => {
    // เลื่อนลงล่างทุกครั้งที่มีข้อความใหม่ ไม่งั้นข้อความล่าสุดจะอยู่นอกจอ
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight })
  }, [messages])

  async function send(text: string) {
    const trimmed = text.trim()
    if (!trimmed || busy) return
    setBusy(true)
    setInput('')

    // แสดงข้อความผู้ใช้ทันที ไม่ต้องรอเครือข่าย
    const mine: ChatMessage = {
      id: `local-${Date.now()}`,
      role: 'user',
      content: trimmed,
      data: null,
      at: new Date().toISOString(),
    }
    setMessages((m) => [...m, mine])

    try {
      const r = await api.chat({
        templateKey,
        message: trimmed,
        data,
        sessionId,
        templateName,
      })
      setSessionId(r.sessionId)
      setMessages((m) => [
        ...m,
        {
          id: `${r.sessionId}-${m.length}`,
          role: 'assistant',
          content: r.reply,
          data: r.data,
          /*
           * เก็บไว้เฉพาะรอบนี้เพราะฝั่ง server ไม่ได้เก็บ
           *   ข้อความที่โหลดกลับจากประวัติจึงไม่มีรายการนี้ (ถูกกว่าการโชว์ผิดว่า AI เติมทั้งชุด)
           */
          changed: r.changed,
          at: new Date().toISOString(),
        },
      ])
      onData(r.data, r.changed)
      void loadSessions()
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : String(e)
      // error ใส่ใน messages แล้วข้างบน — ถ้าเก็บใน state แยกจะแสดงซ้ำสองที่
      setMessages((m) => [
        ...m,
        {
          id: `err-${Date.now()}`,
          role: 'assistant',
          content: `เรียก AI ไม่สำเร็จ: ${msg}`,
          data: null,
          at: new Date().toISOString(),
        },
      ])
    } finally {
      setBusy(false)
    }
  }

  async function openSession(id: string) {
    try {
      const s = await api.chatSession(id)
      setMessages(s.messages)
      setSessionId(s._id)
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e))
    }
  }

  async function newChat() {
    setMessages([])
    setSessionId(undefined)
  }

  async function removeSession(id: string) {
    try {
      await api.deleteChatSession(id)
      if (sessionId === id) await newChat()
      void loadSessions()
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    /*
     * ⚠️ ต้องเป็น **flex column** ไม่ใช่ grid (วัดจริง 2026-10-07)
     *
     *   เดิมเป็น `display: grid; height: 100%` ทำให้ทุกแถว (auto) ถูก**ยืดให้เต็มความสูง**
     *   เพราะ grid ที่ความสูงแน่นอนและ `align-content` ค่าเริ่มต้น จะกระจายที่เหลือให้แถว auto
     *
     *   ผลจริงที่จอ 452×539 (วัดได้ ไม่ได้เดา):
     *     แถวหัว  34px → **88px**
     *     แถวแท็บประวัติแชท 24px → **80px**  (แท็บ "สวัสดี ×" บวมเป็นก้อนเกือบสี่เหลี่ยม)
     *     แถวแชท ได้เหลือแค่ 374px
     *   ที่ `.chat` มี `flex: 1` อยู่แล้ว แต่ **flex ไม่มีผลใน grid** จึงไม่มีอะไรดูดพื้นที่ส่วนเกิน
     *
     *   แก้เป็น flex column → `flex: 1` ของ `.chat` ทำงานตามที่ตั้งใจไว้
     *   แถวบน ๆ คงความสูงตามเนื้อหา และผลคือ**พื้นที่แชทได้มากขึ้น**ไม่ใช่น้อยลง
     */
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, height: '100%', minHeight: 0 }}>
      {/* ── ค่าตั้ง + ประวัติแชท ── */}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        {/*
          * ⚠️ ถอนตัวเลือกผู้ให้บริการออกแล้ว (ผู้ใช้สั่ง 2026-10-06: *"ไม่ต้องมีตัวเลือกให้ผู้ใช้เห็น อันนี้ minimax อย่างเดียว"*)
          *   แท็บ AI มีสองโหมด (สัมภาษณ์/แชท) ถ้าถอดแค่โหมดเดียว อีกโหมดยังมีตัวเลือกให้เห็น
          *   ผู้ใช้จะเห็นสองแบบในหน้าเดียวกัน และคนที่เผลอกดสุ่มจะเสียงันตาย
          *   ฝั่ง API ตกไปใช้ค่าใน `.env` เองตอนไม่ส่ง `provider` มา
          */}
        <button className="ghost" onClick={newChat} style={{ fontSize: 12.5, padding: '6px 10px' }}>
          แชทใหม่
        </button>
        <div style={{ flex: 1 }} />
        {status && !status.configured && <span className="pill warn">ยังไม่ได้ตั้ง key</span>}
        {status?.configured && status.provider === 'mock' && (
          <span className="pill warn">โหมด mock — ไม่ได้ต่อ AI จริง</span>
        )}
      </div>

      {status?.reason && (
        <p className="muted" style={{ margin: 0, fontSize: 12 }}>
          {status.reason}
        </p>
      )}

      {sessions.length > 0 && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {sessions.slice(0, 6).map((s) => (
            <span key={s._id} className="pill" style={{ display: 'inline-flex', gap: 4 }}>
              <button
                className="ghost"
                style={{ border: 'none', background: 'none', padding: 0, fontSize: 12 }}
                onClick={() => void openSession(s._id)}
                title={s.title}
              >
                {s.title.slice(0, 24)}
              </button>
              <button
                className="ghost"
                style={{ border: 'none', background: 'none', padding: 0, color: 'var(--err)' }}
                onClick={() => void removeSession(s._id)}
                title="ลบแชทนี้"
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}

      {/* ── ข้อความ ── */}
      <div className="chat" style={{ flex: 1 }}>
        <div className="chat__log" ref={logRef}>
          {messages.length === 0 && (
            <p className="muted" style={{ fontSize: 13, margin: 0 }}>
              เล่าได้เลยว่าต้องการเอกสารแบบไหน เช่น
              <br />
              “ออกหนังสือรับรองให้นายสมชาย แซ่ม ชมพู เรื่องขออนุญาตเปลี่ยนประจำรถ”
              <br />
              AI จะเติมข้อมูลให้เฉพาะช่องที่คุณยังไม่ได้กรอกเอง
            </p>
          )}

          {messages.map((m) => (
            <div
              key={m.id}
              className={`chat__msg ${
                m.role === 'user'
                  ? 'chat__msg--user'
                  : m.content.startsWith('เรียก AI ไม่สำเร็จ')
                    ? 'chat__msg--err'
                    : 'chat__msg--ai'
              }`}
            >
              {m.content}
              {/*
                ผลลัพธ์ของรอบนี้: AI เติมช่องอะไรบ้าง และเอาไปไว้ที่ไหนแล้ว
                ⚠️ ต้องบอกทุกครั้ง รวมเวลา**ไม่ได้เติมเลย**
                  เพราะการเงียบดูเหมือนระบบค้าง แต่จริง ๆ คือ AI ตอบได้แต่ไม่มีช่องที่ตรง

                ⚠️ กรองค่าว่างออกอีกชั้น แม้ฝั่ง server แก้แล้ว
                  เพราะถ้าวันหนึ่งมีทางอื่นที่ยังส่งค่าว่างมา
                  การขึ้นว่า "เติมแล้ว" ทั้งที่ช่องยังว่าง ทำลายความเชื่อผู้ใช้ทันที
              */}
              {m.changed && (() => {
                const rows = m.changed
                  .map((k) => ({ key: k, value: String(getPath(m.data ?? {}, k) ?? '').trim() }))
                  .filter((r) => r.value !== '')
                if (rows.length === 0) {
                  return (
                    <div className="chat__filled chat__filled--none">
                      <div className="chat__filled__head">
                        รอบนี้ยังไม่ได้เติมช่องไหน — ลองบอกรายละเอียดเฉพาะช่องที่ต้องการเพิ่ม
                      </div>
                    </div>
                  )
                }
                return (
                  <div className="chat__filled">
                    <div className="chat__filled__head">
                      เติม {rows.length} ช่องแล้ว · ใส่ในช่องของแม่แบบให้แล้ว
                    </div>
                    <ul className="chat__filled__list">
                      {rows.slice(0, 6).map((r) => (
                        <li key={r.key}>
                          <span className="chat__filled__k">{labelOf(r.key)}</span>
                          <span className="chat__filled__v">{middleTruncate(r.value)}</span>
                        </li>
                      ))}
                      {rows.length > 6 && <li className="muted">อีก {rows.length - 6} ช่อง</li>}
                    </ul>
                  </div>
                )
              })()}
            </div>
          ))}

          {/*
            ฟองนี้ใช้ class ต่างจากคำตอบจริงโดยตั้งใจ
            เพราะการรอ "คำตอบเสร็จ" ต้องดูเฉพาะข้อความที่โมเดลตอบจริง
            ถ้าใช้ class เดียวกัน จะเผลอไปอ่านคำว่า "กำลังคิด…" เป็นคำตอบ
          */}
          {busy && <div className="chat__msg chat__msg--pending">กำลังคิด…</div>}
        </div>

        <div className="chat__composer">
          <textarea
            value={input}
            placeholder="เช่น ออกหนังสือรับรองให้นายสมชาย เรื่องขออนุญาตเปลี่ยนประจำรถ"
            disabled={busy}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              // Enter ส่ง · Shift+Enter ขึ้นบรรทัดใหม่
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                void send(input)
              }
            }}
          />
          <button onClick={() => void send(input)} disabled={busy || !input.trim()}>
            {busy ? 'กำลังทำงาน…' : 'ส่ง'}
          </button>
        </div>
      </div>
    </div>
  )
}
