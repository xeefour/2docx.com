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
 *   · เลือก provider ได้ต่อครั้ง โดยไม่ต้องแตะ .env
 *     (ค่าจริงของระบบยังคุมด้วย LLM_PROVIDER ในฝั่ง server)
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  api,
  ApiError,
  type ChatMessage,
  type ChatSessionMeta,
  type LlmStatus,
} from './lib/api'

const PROVIDERS: Array<{ id: 'minimax' | 'openai' | 'mock'; label: string; hint: string }> = [
  { id: 'minimax', label: 'MiniMax', hint: 'โมเดลภาษาไทยของ MiniMax (ค่าเริ่มต้นของระบบ)' },
  { id: 'openai', label: 'OpenAI ที่เข้ากันได้', hint: 'ยิงไปยัง base URL แบบ OpenAI-compatible ที่ตั้งไว้' },
  { id: 'mock', label: 'ทดสอบ (mock)', hint: 'ไม่เรียก AI จริง — ใช้ทดสอบ flow ตอนยังไม่ได้ตั้ง key' },
]

export default function AiChat({
  templateKey,
  templateName,
  data,
  onData,
  notify,
}: {
  templateKey: string
  templateName: string
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
  const [provider, setProvider] = useState<'minimax' | 'openai' | 'mock'>('minimax')
  const [status, setStatus] = useState<LlmStatus | null>(null)
  const logRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    void api
      .llmStatus()
      .then((s) => {
        setStatus(s)
        /**
         * ⚠️ provider ที่เลือกในหน้าเว็บจะทับค่าใน .env ของเซิร์ฟเวอร์
         *    ถ้า default เป็น MiniMax เสมอ ผู้ใช้ที่ยังไม่ได้ตั้ง key
         *    จะเจอ error 401 ทันทีที่เปิดแท็บ — ต้องเริ่มจากค่าที่เซิร์ฟเวอร์ใช้จริง
         */
        setProvider(s.configured ? (s.provider as typeof provider) : 'mock')
      })
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
        provider,
      })
      setSessionId(r.sessionId)
      setMessages((m) => [
        ...m,
        {
          id: `${r.sessionId}-${m.length}`,
          role: 'assistant',
          content: r.reply,
          data: r.data,
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
    <div style={{ display: 'grid', gap: 10, height: '100%', minHeight: 0 }}>
      {/* ── ค่าตั้ง + ประวัติแชท ── */}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <select
          value={provider}
          onChange={(e) => setProvider(e.target.value as typeof provider)}
          style={{ width: 'auto', fontSize: 13 }}
          title={
            status && !status.configured
              ? `เซิร์ฟเวอร์ยังไม่ได้ตั้ง key — ใช้ได้แค่โหมดทดสอบ`
              : 'เลือกผู้ให้บริการ AI สำหรับคำขอนี้'
          }
        >
          {PROVIDERS.map((p) => (
            <option key={p.id} value={p.id} title={p.hint}>
              {p.label}
            </option>
          ))}
        </select>
        <button className="ghost" onClick={newChat} style={{ fontSize: 12.5, padding: '6px 10px' }}>
          แชทใหม่
        </button>
        <div style={{ flex: 1 }} />
        {status && !status.configured && <span className="pill warn">ยังไม่ได้ตั้ง key</span>}
        {status?.configured && status.provider === 'mock' && (
          <span className="pill warn">โหมด mock — ไม่ได้ต่อ AI จริง</span>
        )}
        {provider !== 'mock' && status && !status.configured && (
          <span className="pill err" title="เลือก provider ที่ยังไม่ได้ตั้ง key">
            {provider} ใช้ไม่ได้ตอนนี้
          </span>
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
              {m.data && Object.keys(m.data).length > 0 && (
                <div className="chat__keys">เติมข้อมูล: {Object.keys(m.data).join(' · ')}</div>
              )}
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
