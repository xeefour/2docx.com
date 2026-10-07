'use client'

/**
 * แท็บ "AI ช่วยกรอกข้อมูล" — สัมภาษณ์ผู้ใช้ทีละช่อง แล้วเอาคำตอบมาเติมฟอร์ม
 *
 * ── ทำไมต้องต่างจากแผงแชทเดิม ────────────────────────────────────────
 *   แชทเดิม: ผู้ใช้เล่าเองทีเดียว → AI เดาที่เหลือ (เร็ว แต่ถ้าผู้ใช้เล่าไม่ครบ
 *              ผลคือ AI แต่งค่าที่ไม่มีจริงไปใส่ในเอกสารราชการ)
 *   สัมภาษณ์:  **AI เป็นคนถาม** ทีละช่องที่ยังว่าง → ผู้ใช้ตอบเฉพาะที่รู้จริง
 *              → AI เรียบเรียงคำตอบให้ตรงกับชนิดชอง (input property)
 *              ข้อมูลจึงตรวจสอบได้ก่อนออกเอกสาร
 *
 * ── กติกาที่ยึด ────────────────────────────────────────────────────────
 *   · ถามเฉพาะช่องที่**ยังไม่มีค่า** — ช่องที่ผู้ใช้กรอกเองไม่ถามซ้ำ
 *   · ค่าที่ผู้ใช้พิมพ์เอง **ไม่ถูกทับ** (merge ฝั่ง API ทำให้อยู่แล้ว)
 *   · ก่อนเติมจริงต้องเห็นตัวอย่างค่าที่จะถูกเติม แล้วกดยืนยันเอง
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  api,
  ApiError,
  type InterviewQuestion,
  type LlmStatus,
} from './lib/api'
import { getPath } from './lib/fields'

/** ป้ายช่องใช้แสดงผล — โครงสร้างเดียวกับ FieldDef แต่เก็บแค่ที่จำเป็น */
type FieldLite = { key: string; label?: string; type?: string; options?: { value: string }[] }

export default function AiInterview({
  templateKey,
  templateName,
  fields,
  data,
  onData,
  notify,
}: {
  templateKey: string
  templateName: string
  fields: FieldLite[]
  data: Record<string, unknown>
  /** AI เติมค่ากลับมา → merge เข้ากับข้อมูลเดิมทางฟอร์ม */
  onData: (next: Record<string, unknown>, changed: string[]) => void
  notify: (msg: string) => void
}) {
  const [mode, setMode] = useState<'one' | 'batch'>('one')
  const [batchSize, setBatchSize] = useState(4)
  const [status, setStatus] = useState<LlmStatus | null>(null)

  const [questions, setQuestions] = useState<InterviewQuestion[]>([])
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const [asked, setAsked] = useState<string[]>([])
  const [remaining, setRemaining] = useState<string[]>([])
  const [note, setNote] = useState('')

  const [asking, setAsking] = useState(false)
  const [composing, setComposing] = useState(false)
  /** ค่าที่จะเติม — ยังไม่ลงฟอร์มจริง รอผู้ใช้กดยืนยัน */
  const [preview, setPreview] = useState<{ data: Record<string, unknown>; changed: string[]; skipped: string[] } | null>(null)

  const labelOf = useCallback(
    (key: string) => fields.find((f) => f.key === key)?.label || key,
    [fields],
  )

  useEffect(() => {
    void api
      .llmStatus()
      .then(setStatus)
      .catch(() => setStatus(null))
  }, [])

  // เปลี่ยนแม่แบบ = คำถามของแม่แบบเดิมใช้ไม่ได้
  useEffect(() => {
    setQuestions([])
    setAnswers({})
    setAsked([])
    setRemaining([])
    setNote('')
    setPreview(null)
  }, [templateKey])

  /** ช่องที่ยังว่าง — คำนวณเองเพื่อแสดงผลทันทีโดยไม่ต้องรอ API
   *
   * ⚠️ ต้องใช้ `getPath` ไม่ใช่ `data[f.key]` — key ของช่องมักมีจุดคั่น (เช่น
   *   `ผู้สมัคร.ชื่อ`) และ `mergeAiData` เขียนค่าแบบ dot path ลง object ซ้อน
   *   การอ่านแบบแบนจะได้ undefined **เสมอ** → ช่องที่ผู้ใช้กรอกแล้ว
   *   จะถูกนับเป็น "ยังว่าง" แล้วถูกถามซ้ำไปเรื่อย ๆ
   */
  const emptyKeys = useMemo(() => {
    return fields
      .filter((f) => {
        const v = getPath(data, f.key)
        return v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0)
      })
      .map((f) => f.key)
  }, [fields, data])

  const askedSet = useMemo(() => new Set(asked), [asked])
  const answeredKeys = useMemo(() => Object.keys(answers).filter((k) => answers[k]?.trim()), [answers])
  const doneCount = emptyKeys.filter((k) => askedSet.has(k)).length

  const ask = useCallback(async () => {
    setAsking(true)
    setPreview(null)
    try {
      const r = await api.interviewPlan({
        templateKey,
        templateName,
        mode,
        batchSize,
        data,
        asked,
        answers,
      })
      setQuestions(r.questions)
      setRemaining(r.remaining.length ? r.remaining : emptyKeys)
      setNote(r.reply)
      setAsked((prev) => [...new Set([...prev, ...r.questions.map((q) => q.key)])])
      if (r.questions.length === 0) {
        notify('ไม่มีช่องที่ต้องถามเพิ่มแล้ว — กดวิเคราะห์คำตอบได้เลย')
      }
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : String(e)
      setNote(`ถามไม่สำเร็จ: ${msg}`)
      notify(`ถาม AI ไม่สำเร็จ: ${msg}`)
    } finally {
      setAsking(false)
    }
  }, [templateKey, templateName, mode, batchSize, data, asked, answers, emptyKeys, notify])

  const compose = useCallback(async () => {
    const clean = Object.fromEntries(
      Object.entries(answers).filter(([, v]) => typeof v === 'string' && v.trim() !== ''),
    )
    if (Object.keys(clean).length === 0) {
      notify('ยังไม่ได้ตอบคำถามเลย')
      return
    }
    setComposing(true)
    try {
      const r = await api.interviewCompose({
        templateKey,
        templateName,
        answers: clean,
        data,
      })
      if (r.changed.length === 0) {
        notify('AI เรียบเรียงแล้ว แต่ไม่ได้ค่าที่เติมได้เพิ่ม — ดูรายละเอียดที่รายการข้าม')
      }
      setPreview({ data: r.data, changed: r.changed, skipped: r.skipped })
      setNote(r.reply)
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : String(e)
      setNote(`เรียบเรียงไม่สำเร็จ: ${msg}`)
      notify(`เรียบเรียงคำตอบไม่สำเร็จ: ${msg}`)
    } finally {
      setComposing(false)
    }
  }, [answers, templateKey, templateName, data, notify])

  const applyPreview = useCallback(() => {
    if (!preview || preview.changed.length === 0) return
    onData(preview.data, preview.changed)
    notify(`เติมข้อมูล ${preview.changed.length} ช่อง: ${preview.changed.map(labelOf).join(', ')}`)
    setPreview(null)
    setAnswers({})
    setAsked([])
    setQuestions([])
    setNote('')
  }, [preview, onData, notify, labelOf])

  return (
    <div className="iv">
      {/* ── ค่าตั้ง ── */}
      <div className="iv__bar">
        <label className="iv__field">
          วิธีถาม
          <select value={mode} onChange={(e) => setMode(e.target.value as 'one' | 'batch')}>
            <option value="one">ทีละข้อ</option>
            <option value="batch">ถามทีละชุด</option>
          </select>
        </label>

        {mode === 'batch' && (
          <label className="iv__field">
            ชุดละ
            <select value={batchSize} onChange={(e) => setBatchSize(Number(e.target.value))}>
              {[3, 4, 5, 6, 8].map((n) => (
                <option key={n} value={n}>
                  {n} ข้อ
                </option>
              ))}
            </select>
          </label>
        )}

        {/*
          * ⚠️ ถอนตัวเลือก "โมเดล" ออกแล้ว (ผู้ใช้สั่ง 2026-10-06: *"ไม่ต้องมีตัวเลือกให้ผู้ใช้เห็น อันนี้ minimax อย่างเดียว"*)
          *   ผู้ใช้ไม่ได้มาสลับผู้ให้บริการ AI — เป็นการตัดสินใจของระบบ
          *   การโชว์ให้เลือกทำให้คนทั่วไปกดสุ่มจนเสียงันตาย (และเปิดโอกาสเลือกโมเดลที่ไม่มี key)
          *   ฝั่ง API ตกไปใช้ค่าใน `.env` เองตอนไม่ส่ง `provider` มา
          *   → ไม่ส่งค่านี้เลย ให้เซิร์ฟเวอร์เป็นคนเลือก
          */}

        <button className="ghost" onClick={() => void ask()} disabled={asking || emptyKeys.length === 0}>
          {asking ? 'กำลังถาม…' : questions.length ? 'ถามต่อ' : 'เริ่มถาม'}
        </button>
      </div>

      {status?.reason && (
        <p className="muted iv__note">
          {status.reason}
        </p>
      )}
      {status?.configured && status.provider === 'mock' && (
        <p className="muted iv__note">โหมดทดสอบ — ยังไม่ได้ต่อ AI จริง</p>
      )}

      {/* ── ความคืบหน้า ── */}
      <div className="iv__progress">
        <div className="iv__barfill" style={{ width: emptyKeys.length ? `${(doneCount / emptyKeys.length) * 100}%` : '100%' }} />
        <span className="iv__progresstext">
          ว่าง {emptyKeys.length} ช่อง · ถามแล้ว {doneCount} · ตอบแล้ว {answeredKeys.length}
        </span>
      </div>

      {note && <p className="iv__reply">{note}</p>}

      {/* ── คำถาม ── */}
      {questions.length > 0 && (
        <div className="iv__qs">
          {questions.map((q) => (
            <div key={q.key} className="iv__q">
              <div className="iv__qlabel">
                {labelOf(q.key)}
                <span className="iv__qkey">{q.key}</span>
              </div>
              <div className="iv__qtext">{q.question}</div>
              {q.help && <div className="iv__qhelp">{q.help}</div>}

              {q.options && q.options.length > 0 ? (
                <div className="iv__opts">
                  {q.options.map((o) => (
                    <button
                      key={o}
                      className={`ghost${answers[q.key] === o ? ' iv__opt--on' : ''}`}
                      onClick={() => setAnswers((a) => ({ ...a, [q.key]: a[q.key] === o ? '' : o }))}
                    >
                      {o}
                    </button>
                  ))}
                </div>
              ) : (
                <input
                  value={answers[q.key] ?? ''}
                  placeholder="พิมพ์คำตอบของคุณ"
                  onChange={(e) => setAnswers((a) => ({ ...a, [q.key]: e.target.value }))}
                />
              )}
            </div>
          ))}
        </div>
      )}

      {/* ── ผลลัพธ์ก่อนยืนยัน ── */}
      {preview && (
        <div className="iv__preview">
          <h3>AI จะเติมให้ {preview.changed.length} ช่อง</h3>
          <table className="iv__table">
            <tbody>
              {preview.changed.map((k) => (
                <tr key={k}>
                  <td className="iv__tk">{labelOf(k)}</td>
                  {/* getPath ไม่ใช่ preview.data[k] — data คือ object ที่ซ้อนตาม dot path
                      อ่านแบบแบนจะได้ '' แล้วผู้ใช้เห็นตารางว่างทั้งที่มีค่าจริง */}
                  <td className="iv__tv">{String(getPath(preview.data, k) ?? '')}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {preview.skipped.length > 0 && (
            <p className="muted iv__note">
              ข้าม {preview.skipped.length} ช่อง (ตอบไม่ครบ หรือแปลงเป็นค่าของช่องนั้นไม่ได้):{' '}
              {preview.skipped.map(labelOf).join(', ')}
            </p>
          )}
          <div className="iv__actions">
            <button onClick={applyPreview} disabled={preview.changed.length === 0}>
              ใส่ลงฟอร์ม
            </button>
            <button className="ghost" onClick={() => setPreview(null)}>
              ยกเลิก
            </button>
          </div>
        </div>
      )}

      {/* ── ปุ่มสรุป ── */}
      <div className="iv__foot">
        <button onClick={() => void compose()} disabled={composing || answeredKeys.length === 0}>
          {composing ? 'กำลังวิเคราะห์…' : 'วิเคราะห์และเติมข้อมูล'}
        </button>
        <span className="muted">
          {answeredKeys.length > 0
            ? `ตอบแล้ว ${answeredKeys.length} คำถาม`
            : 'ตอบคำถามก่อน แล้วกดวิเคราะห์'}
        </span>
      </div>
    </div>
  )
}