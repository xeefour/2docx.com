'use client'

/**
 * กล่อง "รายงานปัญหา" — ผู้ใช้เจอปัญหาในระบบ แล้วรายงานมาให้ผู้ดูแลทราบ
 *
 * ── ทำไมต้องมีที่นี่ (แทนที่จะ "คัดลอกข้อมูลไปส่งทางแชท") ──────────────
 *   ช่องทางเดิมทำให้เราได้ข้อมูลไม่ครบเสมอ เพราะผู้ใช้ต้องสลับไปแอปอื่น หาแชท
 *   วาง แล้วกดส่งเอง — ในเวลาที่หน้าเว็บเพิ่งพัง (ซึ่งคือช่วงเวลาที่คิดไม่ออกว่าจะพิมพ์อะไร)
 *   ผลคือรายงานมักมีแค่ URL ไม่มีหน้าจอ ไม่มี error แล้วหายไปก่อนเข้ามาถึงเรา
 *
 *   กล่องนี้รวมสิ่งที่ระบบรู้อยู่แล้วมาให้ตั้งแต่ต้น:
 *   · หน้าที่เกิดปัญหา  (จาก URL ปัจจุบัน)
 *   · ข้อผิดพลาดล่าสุด + ขนาดจอ + เบราว์เซอร์ (ส่งไปให้อัตโนมัติ)
 *   · ภาพหน้าจอ (วาง Ctrl+V หรือลากไฟล์เข้ามา)
 *
 * ── ทำไมให้ผู้ใช้แนบภาพเอง ไม่ใช่ให้ระบบถ่าย ────────────────────
 *   ระบบถ่ายหน้าเว็บเองได้ แต่ได้แค่สิ่งที่**เว็บ**แสดง
 *   ซึ่งมักไม่ใช่สิ่งที่เขาเห็น — เช่น extension ทับ, แถบเบราว์เซอร์, ไดอะล็อกของ OS
 *   และต้องเพิ่ม Chromium เข้าอิมเเจจอีกราว 500 MB
 *   ภาพจากคลิปบอร์ดคือสิ่งที่เขาเห็นจริงในตอนนั้น และไม่ต้องเพิ่มอะไรในระบบ
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { ApiError, api } from '../studio/lib/api'

/** ต้องตรงกับ `MAX_SHOT` ใน `apps/api/.../reports/service.ts` — ขาดถึงที่ API จะตอบ 400 อยู่ดี */
const MAX_SHOT = 8 * 1024 * 1024

type Shot = { file: File; preview: string }

export default function ReportIssue({
  pageUrl,
  diagnostics,
  onClose,
}: {
  /** หน้าที่เกิดปัญหา — ส่งจากแถบ URL ที่กดมา ไม่ใช่อ่านค่าใหม่ในกล่องนี้ (จะได้หน้าที่เพิ่งดู) */
  pageUrl: string
  /** ข้อความวินิจฉัยจากแถบ URL — ไม่ถามผู้ใช้ซ้ำ */
  diagnostics: string
  onClose: () => void
}) {
  const [summary, setSummary] = useState('')
  const [details, setDetails] = useState('')
  const [shot, setShot] = useState<Shot | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)
  const [over, setOver] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  /** รับไฟล์ที่ผู้ใช้ยังไม่ได้กดอะไรเลย — กันการวางภาพทับช่องพิมพ์คำอธิบาย */
  const takeShot = useCallback((files: FileList | null | undefined) => {
    const f = Array.from(files ?? []).find((x) => x.type.startsWith('image/'))
    if (!f) return
    if (f.size > MAX_SHOT) {
      setError(`ภาพใหญ่ ${(f.size / 1024 / 1024).toFixed(1)} MB (สูงสุด 8 MB) — ลองแนบเฉพาะส่วนที่มีปัญหา`)
      return
    }
    setError(null)
    // ปลด URL เก่าทิ้งก่อน ไม่งั้นทุกครั้งที่วางรูปใหม่จะรั่วไว้ในหน่วยความจำจนปิดหน้า
    setShot((prev) => {
      if (prev) URL.revokeObjectURL(prev.preview)
      return { file: f, preview: URL.createObjectURL(f) }
    })
  }, [])

  /* วางภาพด้วย Ctrl+V — ทางลัดที่ผู้ใช้คุ้นที่สุด คือถอดภาพจากเครื่องมือแคปหน้าจอมาวางเลย */
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const items = e.clipboardData?.items
      if (!items) return
      for (const it of Array.from(items)) {
        if (it.kind === 'file' && it.type.startsWith('image/')) {
          const f = it.getAsFile()
          if (f) {
            e.preventDefault()
            takeShot([f] as unknown as FileList)
            return
          }
        }
      }
    }
    window.addEventListener('paste', onPaste)
    return () => window.removeEventListener('paste', onPaste)
  }, [takeShot])

  /* ปิดด้วย Esc และคลิกพื้นหลัง — คาดหวังของกล่องในระบบนี้ */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    const onDown = (e: PointerEvent) => {
      if (!(e.target as HTMLElement | null)?.closest?.('[data-report-issue]')) onClose()
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('pointerdown', onDown, true)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('pointerdown', onDown, true)
    }
  }, [onClose])

  useEffect(() => () => { if (shot) URL.revokeObjectURL(shot.preview) }, [shot])

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (summary.trim().length < 3) {
      setError('พิมพ์สั้น ๆ ว่าเจอปัญหาอะไร (อย่างน้อย 3 ตัวอักษร)')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const r = await api.reportProblem({
        summary: summary.trim(),
        details: details.trim(),
        pageUrl,
        diagnostics,
        shot: shot?.file ?? null,
      })
      setDone(
        r.delivered > 0
          ? 'ส่งแล้ว เข้ากล่องจดหมายของผู้ดูแลแล้ว ขอบคุณครับ'
          : 'บันทึกไว้แล้ว แต่ตอนนี้ยังไม่ได้ตั้งผู้รับ — จะตั้งค่าให้ทันที',
      )
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'ส่งไม่สำเร็จ ลองอีกครั้งหรือคัดลอกข้อมูลแก้ปัญหาแนบไปแทน')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="report-issue__scrim">
      <form className="report-issue" data-report-issue data-testid="report-issue" onSubmit={submit}>
        <h2 className="report-issue__title">รายงานปัญหาให้ผู้ดูแล</h2>
        <p className="report-issue__hint">
          ระบบจะแนบหน้าที่คุณอยู่ ({pageUrl}) และข้อผิดพลาดล่าสุดให้เอง ไม่ต้องพิมพ์ซ้ำ
        </p>

        <label className="report-issue__label">
          เจอปัญหาอะไร
          <input
            data-testid="report-issue-summary"
            value={summary}
            onChange={(e) => setSummary(e.target.value)}
            placeholder="เช่น กดบันทึกแล้วปุ่มหายไป"
            maxLength={200}
            autoFocus
          />
        </label>

        <label className="report-issue__label">
          รายละเอียดเพิ่มเติม (ไม่บังคับ)
          <textarea
            data-testid="report-issue-details"
            value={details}
            onChange={(e) => setDetails(e.target.value)}
            placeholder="ทำอะไรแล้วเกิดปัญหา / เห็นอะไรเป็นพิเศษ"
            rows={3}
            maxLength={4000}
          />
        </label>

        {/* พื้นที่รับภาพ — วาง (paste) หรือลากไฟล์มาวางที่นี่ได้ */}
        <div
          className="report-issue__drop"
          data-over={over ? 'true' : 'false'}
          data-testid="report-issue-drop"
          onDragOver={(e) => {
            e.preventDefault()
            setOver(true)
          }}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => {
            e.preventDefault()
            setOver(false)
            takeShot(e.dataTransfer.files)
          }}
          onClick={() => fileRef.current?.click()}
        >
          {shot ? (
            <>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img className="report-issue__shot" src={shot.preview} alt="ภาพที่แนบ" />
              <button
                type="button"
                className="ghost"
                data-testid="report-issue-shot-remove"
                onClick={(e) => {
                  e.stopPropagation()
                  URL.revokeObjectURL(shot.preview)
                  setShot(null)
                }}
              >
                เอาภาพออก
              </button>
            </>
          ) : (
            <span className="report-issue__drophint">
              กด <kbd>Ctrl</kbd>+<kbd>V</kbd> เพื่อวางภาพจากเครื่องมือแคปหน้าจอ
              <br />
              หรือลากไฟล์รูปมาวางที่นี่ / คลิกเพื่อเลือกไฟล์ (สูงสุด 8 MB)
            </span>
          )}
          <input
            ref={fileRef}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            hidden
            onChange={(e) => takeShot(e.target.files)}
          />
        </div>

        {error && <p className="report-issue__err" data-testid="report-issue-error">{error}</p>}
        {done && <p className="report-issue__ok" data-testid="report-issue-done">{done}</p>}

        <div className="report-issue__actions">
          {done ? (
            <button type="button" className="primary" onClick={onClose} data-testid="report-issue-close">
              ปิด
            </button>
          ) : (
            <>
              <button type="submit" className="primary" disabled={busy} data-testid="report-issue-send">
                {busy ? 'กำลังส่ง…' : 'ส่งรายงาน'}
              </button>
              <button type="button" className="ghost" onClick={onClose} disabled={busy}>
                ยกเลิก
              </button>
            </>
          )}
        </div>
      </form>
    </div>
  )
}