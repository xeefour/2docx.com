'use client'

/**
 * ปุ่มดาวน์โหลดแบบไอคอน — คลิกแล้วค่อยเลือกรูปแบบและหน้าที่ต้องการ
 *
 * ── ทำไมเปลี่ยนจาก dropdown เป็นเมนูไอคอน ───────────────────────
 *   เดิมเป็น `<select>` กว้าง ~290px กินพื้นที่แถบเครื่องมือของพรีวิว
 *   และบีบจนหัวการ์ดสูงเปล่า ๆ
 *   ใหม่: ไอคอนวงกลมตัวเดียวในแถบซูม · รูปแบบโผล่หลังคลิก
 *
 * ── ทำไม PDF/DOCX ต้องเรนเดอร์ใหม่ทุกครั้ง ──────────────────────
 *   ตัวอย่างบนจอคือ PDF ฉบับเดียว แต่ DOCX ไม่เคยถูกสร้างมา
 *   การเรนเดอร์ใหม่ทำให้ไฟล์ที่ได้ตรงกับแม่แบบ + JSON ณ ตอนนั้นเสมอ
 *   (ถ้าแก้ JSON แล้วกดดาวน์โหลด จะได้ไฟล์ใหม่ทันที ไม่ใช่ของเก่า)
 *
 * ── ทำไมรูปไม่ต้องเรนเดอร์ใหม่ ────────────────────────────────
 *   หน้าเอกสารถูกวาดอยู่ใน canvas อยู่แล้ว → ตัดออกมาเป็น PNG ได้เลย
 *
 * ── เลือกหน้า + รวม ZIP ───────────────────────────────────────
 *   · เขียนช่วงหน้าได้ (`1-3, 5, 8-`) — เหมาะกับเอกสารหลายสิบหน้า
 *     ชิปรายหน้าใช้ไม่ได้จริงเมื่อมี 100 หน้า
 *   · PDF ตัดหน้าให้ด้้วย pdf-lib ฝั่งเบราว์เซอร์ (ไม่ยิง API ใหม่)
 *   · ZIP เก็บด้วย fflate แบบ `level: 0` เพราะ PNG บีบมาแล้ว บีบซ้ำไม่มีผล
 *   · **Word ตัดหน้าไม่ได้** — Word จัดหน้าใหม่เองตอนเปิด
 *     จึงซ่อนตัวเลือกหน้าตอนเลือก Word แทนที่จะให้ผู้ใช้เลือกแล้วไม่มีผล
 */

import { useEffect, useRef, useState } from 'react'
import { api, waitForRender, ApiError } from './lib/api'
import { allPages, describeSelection, pageSuffix, parsePageRange } from './lib/pages'
import { pickPdfPages } from './lib/pdf-pages'
import { blobToBytes, makeZip } from './lib/zip'

type Format = 'pdf' | 'docx' | 'png' | 'zip'

interface Spec {
  /** ชื่อย่อบนเครื่องหมายชนิดไฟล์ */
  badge: string
  /** ชื่อที่ผู้ใช้เห็น */
  name: string
  /** คำอธิบายสั้น ๆ ใต้ชื่อ */
  hint: string
  /** สีเครื่องหมาย (ตรงกับสีจริงของโปรแกรมนั้น) */
  color: string
  /** เลือกหน้าได้ไหม — Word ตัดหน้าไม่ได้ */
  pageable: boolean
}

const SPEC: Record<Format, Spec> = {
  pdf: { badge: 'PDF', name: 'PDF', hint: 'ฉบับส่งมอบ', color: '#d64545', pageable: true },
  docx: { badge: 'DOC', name: 'Word', hint: 'แก้ต่อได้', color: '#2b579a', pageable: false },
  png: { badge: 'PNG', name: 'รูปภาพ', hint: 'แยกไฟล์ทีละหน้า', color: '#2e8b57', pageable: true },
  zip: { badge: 'ZIP', name: 'ZIP รวมทุกหน้า', hint: 'รูปภาพไฟล์เดียว', color: '#8a6d1f', pageable: true },
}

/** ลำดับที่แสดง: PDF · Word · รูปภาพ · ZIP */
const ORDER: Format[] = ['pdf', 'docx', 'png', 'zip']

/** ไอคอนลูกศรลงหน้ากระดาษ (ตรงกับปุ่มดาวน์โหลดของเบราว์เซอร์) */
const DownloadIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M12 3v12" />
    <path d="m7 10 5 5 5-5" />
    <path d="M4 20h16" />
  </svg>
)

/** ชื่อไฟล์ที่กดดาวน์โหลดจากฝั่งเบราว์เซอร์ */
function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  // รอให้เบราว์เซอร์เริ่มดาวน์โหลดก่อนคืนหน่วยความจำ
  setTimeout(() => URL.revokeObjectURL(url), 4000)
}

export default function DownloadMenu({
  templateId,
  data,
  label,
  pageCount,
  loadPdfForPng,
  disabled,
}: {
  templateId: string
  data: () => Record<string, unknown>
  label: string
  /** จำนวนหน้าของตัวอย่างบนจอ — ใช้เป็นขอบเขตตอนเลือกหน้า */
  pageCount: number
  /** คืนฟังก์ชันแปลงหน้าที่ n เป็น PNG (มาจาก pdf.js ที่พรีวิย์โหลดไว้แล้ว) */
  loadPdfForPng: () => Promise<{ count: number; toPng: (n: number, scale?: number) => Promise<Blob> }>
  disabled?: boolean
}) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  /** ข้อความช่วงหน้า — ว่าง = ทุกหน้า */
  const [range, setRange] = useState('')
  /** รูปแบบที่ผู้ใช้ชี้ไว้ (ค่าเริ่มต้นแค่เอาไว้สลับสี ไม่กดอะไรทันที) */
  const [peek, setPeek] = useState<Format>('pdf')
  const wrapRef = useRef<HTMLDivElement>(null)

  const stem = label.replace(/[\\/:*?"<>|]+/g, '_').slice(0, 80) || 'เอกสาร'
  const parsed = parsePageRange(range, pageCount)
  const pages = parsed.ok ? parsed.pages : []

  /* ── ปิดเมนูเมื่อคลิกที่อื่น / กด Esc ─────────────────────────── */
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false)
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

  /** เรนเดอร์ใหม่ → ดึงไฟล์กลับมาเป็น bytes (ถ้าต้องตัดหน้า) */
  async function renderFresh(format: 'pdf' | 'docx') {
    const { _id } = await api.createDocument({ templateId, data: data(), outputFormat: format, label })
    const doc = await waitForRender(_id, (s) => setStatus(`สถานะ: ${s}`))
    if (doc.status === 'failed') throw new Error(doc.error ?? 'เรนเดอร์ไม่สำเร็จ')

    setStatus('กำลังดาวน์โหลด…')
    // ดึงผ่าน API ของเรา ไม่ใช่ presigned URL
    // เพราะ URL ชี้ทาง tailnet + RustFS ไม่มี CORS → เบราว์เซอร์โหลดไม่ได้
    const res = await fetch(`/api/documents/${_id}/file`, { credentials: 'same-origin' })
    if (!res.ok) throw new Error(`ดาวน์โหลดไม่สำเร็จ (${res.status})`)
    const blob = await res.blob()

    // เก็บกวาด — เป็นงานชั่วคราวจากการกดดาวน์โหลด ไม่ต้องเก็บไว้
    await api.deleteDocument(_id).catch(() => undefined)
    return blob
  }

  async function downloadPdfOrDocx(format: 'pdf' | 'docx') {
    setBusy(true)
    setError(null)
    setStatus('กำลังเรนเดอร์ใหม่…')
    try {
      const blob = await renderFresh(format)
      let out = blob
      let name = `${stem}.${format}`

      // ตัดหน้าได้เฉพาะ PDF — Word จัดหน้าใหม่เองตอนเปิด ตัดไปก็ไม่มีผล
      if (format === 'pdf' && pages.length > 0 && pages.length < pageCount) {
        setStatus('กำลังตัดหน้า…')
        const cut = await pickPdfPages(await blobToBytes(blob), pages)
        out = new Blob([cut.slice().buffer as ArrayBuffer], { type: 'application/pdf' })
        name = `${stem}${pageSuffix(pages, pageCount)}.pdf`
      }

      saveBlob(out, name)
      setStatus(`ได้ ${name} แล้ว`)
    } catch (e) {
      setError(e instanceof ApiError ? e.message : e instanceof Error ? e.message : String(e))
      setStatus(null)
    } finally {
      setBusy(false)
    }
  }

  async function downloadImages(asZip: boolean) {
    setBusy(true)
    setError(null)
    setStatus('กำลังสร้างรูป…')
    try {
      const pdf = await loadPdfForPng()
      // ถ้าผู้ใช้ยังไม่พิมพ์ช่วงหน้า → เอาทุกหน้าของ PDF ที่โหลดมา
      // (ใช้ allPages เพราะ pdf.count เป็นตัวเลข ไม่ใช่ array)
      const want = pages.length > 0 ? pages : allPages(pdf.count)

      if (!asZip) {
        for (const n of want) {
          setStatus(`กำลังสร้างรูป… ${want.indexOf(n) + 1}/${want.length}`)
          const blob = await pdf.toPng(n, 2)
          saveBlob(blob, `${stem}-หน้า${n}.png`)
          // เว้นสักครู่กันเบราว์เซอร์ไม่ค้างจากการดาวน์โหลดรัว ๆ
          await new Promise((r) => setTimeout(r, 350))
        }
        setStatus(`ได้ ${want.length} ไฟล์ PNG แล้ว`)
        return
      }

      const entries = []
      for (const n of want) {
        setStatus(`กำลังสร้างรูป… ${want.indexOf(n) + 1}/${want.length}`)
        entries.push({ name: `${stem}-หน้า${n}.png`, data: await blobToBytes(await pdf.toPng(n, 2)) })
      }
      setStatus('กำลังบีบอัดเป็น ZIP…')
      const z = makeZip(entries, `${stem}${pageSuffix(want, pdf.count)}.zip`)
      saveBlob(z.blob, z.filename)
      setStatus(`ได้ ${z.filename} (${entries.length} หน้า)`)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setStatus(null)
    } finally {
      setBusy(false)
    }
  }

  const pick = (format: Format) => {
    if (!parsed.ok) {
      setError(parsed.reason)
      return
    }
    setError(null)
    setOpen(false)
    if (format === 'png') void downloadImages(false)
    else if (format === 'zip') void downloadImages(true)
    else void downloadPdfOrDocx(format)
  }

  const showRange = SPEC[peek].pageable && pageCount > 0

  return (
    <div className="dl" ref={wrapRef}>
      <button
        className="ghost dl__btn"
        data-open={open}
        disabled={busy || disabled}
        onClick={() => setOpen((v) => !v)}
        title="ดาวน์โหลด"
        aria-label="ดาวน์โหลด"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <DownloadIcon />
      </button>

      {open && (
        <div className="dl__pop" role="menu">
          <div className="dl__title">
            <DownloadIcon />
            ดาวน์โหลด
          </div>

          {/* ── เลือกหน้า ── */}
          <div className="dl__range">
            <div className="dl__rangehead">
              <span>หน้าที่ต้องการ</span>
              <span className="dl__count">{pageCount > 0 ? describeSelection(pages, pageCount) : 'ยังไม่มีหน้า'}</span>
            </div>
            {/**
             * ⚠️ **กล่องนี้ต้องอยู่ตลอดเวลา ห้ามซ่อนเมื่อรูปแบบที่เลือกไม่รองรับการตัดหน้า**
             *
             *   เคยพั้งมาแล้ว (ผู้ใช้รายงาน): เมื่อเมาส์ไปโดนไอคอน Word/รูปภาพ/ZIP
             *   `peek` เปลี่ยน → `showRange` กลายเป็น false → กล่องนี้**หายไป**
             *   เมนูสูงลดลง ~121px → ปุ่มรูปแบบที่อยู่ข้างล่าง**ขยับขึ้นมาทับเมาส์**
             *   → เมาส์หลุดจากปุ่มเดิม → peek เปลี่ยนกลับ → กล่องกลับมา → ปุ่มขยับลง
             *   เกิดวนไปมาไม่สิ้นสุด (กระพริบ) และกดช่อง "หน้าที่ต้องการ" ไม่ได้เลย
             *
             *   วิธีแก้: คงโครงสร้างไว้เสมอ แต่**ปิดใช้งาน**ช่องกับปุ่มตอนที่ใช้ไม่ได้
             *   แล้วบอกเหตุผลในบรรทัดใต้ช่อง — ผู้ใช้ยังเห็นช่องอยู่ ยังอ่านข้อความได้
             *   และความสูงเมนูคงที่ไม่ขยับ
             */}
            <input
              className="dl__rangeinput"
              value={range}
              onChange={(e) => setRange(e.target.value)}
              placeholder={`ทั้งหมด เช่น 1-3, 5`}
              aria-label="ช่วงหน้าที่ต้องการ"
              disabled={busy || !showRange}
            />
            <div className="dl__quick">
              <button className="ghost" onClick={() => setRange('')} disabled={busy || !showRange}>
                ทุกหน้า
              </button>
              <button className="ghost" onClick={() => setRange('1')} disabled={busy || !showRange}>
                หน้าแรก
              </button>
              <button className="ghost" onClick={() => setRange(`1-${pageCount}`)} disabled={busy || !showRange}>
                1–{pageCount}
              </button>
              {pageCount > 1 && (
                <button
                  className="ghost"
                  onClick={() => setRange(`2-${pageCount}`)}
                  disabled={busy || !showRange}
                  title="ตัดหน้าแรก (หน้าปก) ออก"
                >
                  ไม่เอาปก
                </button>
              )}
            </div>
            <p className={`dl__hint${showRange && !parsed.ok ? ' dl__hint--err' : ''}`}>
              {!showRange
                ? SPEC[peek].pageable
                  ? 'ยังไม่มีตัวอย่างบนจอ — ดาวน์โหลดได้ทั้งฉบับเท่านั้น'
                  : `${SPEC[peek].name} ไม่ใช้การเลือกหน้า — จัดหน้าใหม่ตอนเปิด`
                : parsed.ok
                  ? `จะได้ ${pages.length} หน้า`
                  : parsed.reason}
            </p>
          </div>

          <div className="dl__grid">
            {ORDER.map((f) => (
              <button
                key={f}
                className="dl__opt"
                data-peek={peek === f}
                role="menuitem"
                disabled={busy}
                onMouseEnter={() => setPeek(f)}
                onFocus={() => setPeek(f)}
                onClick={() => pick(f)}
              >
                <span className="dl__badge" style={{ background: SPEC[f].color }}>
                  {SPEC[f].badge}
                </span>
                <span>
                  {SPEC[f].name}
                  <small>
                    {SPEC[f].pageable && pageCount > 0 && pages.length < pageCount
                      ? `${pages.length} หน้าที่เลือก`
                      : SPEC[f].hint}
                  </small>
                </span>
              </button>
            ))}
          </div>

          {(status || error) && (
            <div className="dl__status" style={error ? { color: 'var(--danger, #c0392b)' } : undefined}>
              {error ?? status}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
