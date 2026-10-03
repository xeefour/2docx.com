'use client'

/**
 * ปุ่มดาวน์โหลดแบบไอคอน — คลิกแล้วค่อยเลือกรูปแบบ
 *
 * ── ทำไมเปลี่ยนจาก dropdown เป็นเมนูไอคอน ───────────────────────
 *   เดิมเป็น `<select>` กว้าง ~290px กินพื้นที่แถบเครื่องมือของพรีวิว
 *   และบีบจนหัวการ์ดสูงเปล่า ๆ
 *   ใหม่: ไอคอนวงกลมตัวเดียวในแถบซูม · รูปแบบโผล่หลังคลิก
 *
 * ── กติกาใหม่: 3 ตัวเลือก (ผู้ใช้สั่ง) ──────────────────────────
 *   · **PDF** / **Word** — ส่งออก**ทั้งเล่ม**ทันที ไม่มีการเลือกหน้า
 *     Word จัดหน้าใหม่เองตอนเปิดอยู่แล้ว ตัดหน้าไปก็ไม่มีผล
 *   · **รูปภาพ** — คลิกแล้วค่อยเปิดกล่อง "หน้าที่ต้องการ" **ใต้ปุ่มนี้**
 *     แล้วดาวน์โหลดตามจำนวนหน้าที่เลือก:
 *       · 1 หน้า → ไฟล์ `.png` ไฟล์เดียว
 *       · มากกว่า 1 หน้า → ไฟล์ `.zip` (รูปแยกกันข้างใน)
 *     ตัวเลือก "ZIP" เป็นตัวเลือกแยง จึงถูกตัดออกตามกติกาข้างบน
 *     (เดิมมี 4 ตัวเลือก: PDF · Word · รูปภาพ · ZIP)
 *
 * ── ทำไมกล่อง "หน้าที่ต้องการ" ถึงซ่อนไว้จนกว่าจะคลิกรูปภาพ ──────
 *   เดิมกล่องนี้อยู่บนสุดตลอด แล้ว**ซ่อน/โชว์ตามรูปแบบที่เมาส์ชี้** (`peek`)
 *   ตอนชี้ Word → กล่องหาย → เมนูสูงลดลง ~121px → ปุ่มที่เมาส์ชี้ขยับขึ้นมาทับ
 *   → เมาส์หลุดจากปุ่มเดิม → กลับไปชี้ปุ่มเดิม → กล่องกลับมา → **กระพริบไม่สิ้นสุด**
 *   (ผู้ใช้รายงานเรื่องนี้ เคยแก้ครั้งแรกด้วยการคงกล่องไว้ + `disabled`)
 *   ตอนนี้ผู้ใช้สั่งให้กลับมาซ่อน แต่**ซ่อนด้วยการคลิก ไม่ใช่ hover**
 *   เพราะ hover แล้วขยับ = วงจรเดิมกลับมา ส่วนคลิกแล้วขยับต่ำที่ต่างกัน:
 *   เมนูที่เปิดค้างไว้จะไม่มีอะไรขยับเลยตอนเลื่อนเมาส์ผ่านปุ่ม
 *   และกล่องที่โผล่อยู่**ใต้**ปุ่มรูปภาพ จึงไม่ดันปุ่มที่เมาส์ชี้อยู่
 *
 * ── ทำไม PDF/DOCX ต้องเรนเดอร์ใหม่ทุกครั้ง ──────────────────────
 *   ตัวอย่างบนจอคือ PDF ฉบับเดียว แต่ DOCX ไม่เคยถูกสร้างมา
 *   การเรนเดอร์ใหม่ทำให้ไฟล์ที่ได้ตรงกับแม่แบบ + JSON ณ ตอนนั้นเสมอ
 *   (ถ้าแก้ JSON แล้วกดดาวน์โหลด จะได้ไฟล์ใหม่ทันที ไม่ใช่ของเก่า)
 *
 * ── ทำไมรูปไม่ต้องเรนเดอร์ใหม่ ────────────────────────────────
 *   หน้าเอกสารถูกวาดอยู่ใน canvas อยู่แล้ว → ตัดออกมาเป็น PNG ได้เลย
 *
 * ── เขียนช่วงหน้าได้ (`1-3, 5, 8-`) ────────────────────────────
 *   เหมาะกับเอกสารหลายสิบหน้า ชิปรายหน้าใช้ไม่ได้จริงเมื่อมี 100 หน้า
 *   ZIP เก็บด้วย fflate แบบ `level: 0` เพราะ PNG บีบมาแล้ว บีบซ้ำไม่มีผล
 */

import { useEffect, useRef, useState } from 'react'
import { api, waitForRender, ApiError } from './lib/api'
import { allPages, describeSelection, pageSuffix, parsePageRange } from './lib/pages'
import { blobToBytes, makeZip } from './lib/zip'

type Format = 'pdf' | 'docx' | 'png'

interface Spec {
  /** ชื่อย่อบนเครื่องหมายชนิดไฟล์ */
  badge: string
  /** ชื่อที่ผู้ใช้เห็น */
  name: string
  /**
   * คำอธิบายสั้น ๆ ใต้ชื่อ — **เว้นว่างได้** แล้วจะไม่แสดง `<small>` เลย
   *
   * ⚠️ PDF / Word ตั้งเป็นค่าว่าง เพราะผู้ใช้สั่งว่าไม่ต้องแสดงข้อความนี้
   *    เหลือเฉพาะรูปภาพที่ต้องบอกว่า "เลือกหน้าที่ต้องการ" เพราะเป็นตัวเดียวที่ต้องเลือกหน้า
   *    (ก่อนหน้านี้เขียนว่า "ฉบับส่งมอบ ทั้งเล่ม" / "แก้ต่อได้ ทั้งเล่ม" แล้วผู้ใช้สั่งตัดออก)
   */
  hint: string
  /** สีเครื่องหมาย (ตรงกับสีจริงของโปรแกรมนั้น) */
  color: string
}

const SPEC: Record<Format, Spec> = {
  pdf: { badge: 'PDF', name: 'PDF', hint: '', color: '#d64545' },
  docx: { badge: 'DOC', name: 'Word', hint: '', color: '#2b579a' },
  png: { badge: 'PNG', name: 'รูปภาพ', hint: 'เลือกหน้าที่ต้องการ', color: '#2e8b57' },
}

/** ลำดับที่แสดง: PDF · Word · รูปภาพ */
const ORDER: Format[] = ['pdf', 'docx', 'png']

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
  /**
   * กล่อง "หน้าที่ต้องการ" เปิดหรือยัง
   *
   * ⚠️ เปิดด้วย**การคลิกปุ่มรูปภาพ**เท่านั้น ห้ามผูกกับ hover
   *    เคยผูกกับ hover แล้วเกิดวงจรกระพริบไม่สิ้นสุด
   *    (ดูคอมเมนต์หัวไฟล์เรื่องซ่อนกล่อง "หน้าที่ต้องการ")
   */
  const [imgOpen, setImgOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)

  const stem = label.replace(/[\\/:*?"<>|]+/g, '_').slice(0, 80) || 'เอกสาร'
  const parsed = parsePageRange(range, pageCount)
  const pages = parsed.ok ? parsed.pages : []
  /** จำนวนหน้าที่จะได้จริง — ว่าง = ทุกหน้า */
  const wantCount = pages.length > 0 ? pages.length : pageCount

  /**
   * ── ปิดเมนู = เริ่มใหม่ทุกครั้ง ──
   *
   * ⚠️ ผู้ใช้สั่ง: *"ถ้า popup นี้ปิดให้ซ่อนส่วนนี้เหมือนเริ่มใหม่
   *    ครั้งแรกจะไม่แสดงหน้าที่ต้องการ"*
   *
   *   ก่อนหน้านี้ `imgOpen` กับ `range` ค้างข้ามการเปิด/ปิดเมนู
   *   → เปิดครั้งที่สองก็เห็นกล่องทันทีทั้งที่ยังไม่ได้กดรูปภาพ
   *   และที่อันตายกว่า: ถ้าเลือก `1-2` ไว้แล้วปิด ครั้งต่อไกดดาวน์โหลด
   *   จะได้แค่ 2 หน้า**โดยที่ผู้ใช้ไม่ได้เลือกอะไรในรอบนั้น**
   *
   *   ใช้ effect แทนการแก้ทีละจุด เพราะเมนูปิดได้ 4 ทาง
   *   (คลิกข้างนอก · กด Esc · กด PDF/Word · กดปุ่มยืนยันรูป)
   *   ถ้าไปแก้ทีละจุดจะตกทางในทันที
   */
  useEffect(() => {
    if (open) return
    setImgOpen(false)
    setRange('')
  }, [open])

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

  /** เรนเดอร์ใหม่ → ดึงไฟล์กลับมาเป็น bytes */
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

  /** PDF / Word — ส่งออกทั้งเล่ม ไม่ตัดหน้า */
  async function downloadPdfOrDocx(format: 'pdf' | 'docx') {
    setBusy(true)
    setError(null)
    setStatus('กำลังเรนเดอร์ใหม่…')
    try {
      const blob = await renderFresh(format)
      const name = `${stem}.${format}`
      saveBlob(blob, name)
      setStatus(`ได้ ${name} (ทั้งเล่ม) แล้ว`)
    } catch (e) {
      setError(e instanceof ApiError ? e.message : e instanceof Error ? e.message : String(e))
      setStatus(null)
    } finally {
      setBusy(false)
    }
  }

  /**
   * รูปภาพ — 1 หน้าได้ `.png` ไฟล์เดียว · มากกว่า 1 หน้าได้ `.zip`
   *
   * ⚠️ เลือกรูปแบบไฟล์เองตามจำนวนหน้า ไม่ต้องมีตัวเลือก ZIP แยก
   *    (ผู้ใช้สั่ง: "ถ้ามีมากกว่า 1 รูป ให้ส่งออกมาเป็น zip ถ้าเลือกรูปเดียวส่งออกมาเป็น file รูป")
   */
  async function downloadImages(force?: number[]) {
    /**
     * `force` = หน้าที่สั่งให้ใช้โดยไม่ผ่านช่องพิมพ์
     *   ใช้ตอนเอกสารหน้าเดียว → ไม่ต้องเปิดกล่องให้ผู้ใช้เลือกอะไร
     *   และต้องข้ามการเช็ค `parsed` เพราะผู้ใช้ยังไม่ได้พิมพ์อะไร
     */
    if (!force && !parsed.ok) {
      setError(parsed.reason)
      return
    }
    setBusy(true)
    setError(null)
    setStatus('กำลังสร้างรูป…')
    try {
      const pdf = await loadPdfForPng()
      // ถ้าผู้ใช้ยังไม่พิมพ์ช่วงหน้า → เอาทุกหน้าของ PDF ที่โหลดมา
      // (ใช้ allPages เพราะ pdf.count เป็นตัวเลข ไม่ใช่ array)
      const want = force?.length ? force : pages.length > 0 ? pages : allPages(pdf.count)

      if (want.length === 1) {
        setStatus('กำลังสร้างรูป…')
        const name = `${stem}-หน้า${want[0]}.png`
        saveBlob(await pdf.toPng(want[0], 2), name)
        setStatus(`ได้ ${name} แล้ว`)
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
    if (format === 'png') {
      setError(null)
      /**
       * เอกสารหน้าเดียว → กดปุ่มรูปภาพแล้วได้ไฟล์ PNG เลย
       *
       * ผู้ใช้สั่ง: *"ถ้าคลิกปุ่ม รูปภาพ ถ้ามีแค่รูปเดียว download ส่งออกมาเป็นรูปเลย"*
       * เดิมต้องกดรูปภาพ แล้วกดยืนยันอีกครั้ง ทั้งที่หน้าเดียวไม่มีอะไรให้เลือก
       * บังคับหน้า 1 เสมอ เพราะ PDF ที่โหลดมาอาจมีหน้ามากกว่าที่พรีวิวบอก
       *   (ถ้าปล่อย "ทุกหน้า" แล้วหลายหน้าจริง จะได้ ZIP ซึ่งขัดกับที่ผู้ใช้สั่ง)
       */
      if (pageCount === 1) {
        setOpen(false)
        void downloadImages([1])
        return
      }
      // หลายหน้า = ยังต้องเลือกหน้า → เปิดกล่อง (คลิกครั้งแรกยังไม่ดาวน์โหลด)
      setImgOpen(true)
      return
    }
    setOpen(false)
    void downloadPdfOrDocx(format)
  }

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

          <div className="dl__grid">
            {ORDER.map((f) => (
              <button
                key={f}
                className={`dl__opt${f === 'png' ? ' dl__opt--wide' : ''}`}
                data-open={f === 'png' && imgOpen}
                role="menuitem"
                aria-expanded={f === 'png' ? imgOpen : undefined}
                disabled={busy}
                onClick={() => pick(f)}
              >
                <span className="dl__badge" style={{ background: SPEC[f].color }}>
                  {SPEC[f].badge}
                </span>
                <span>
                  {SPEC[f].name}
                  {SPEC[f].hint && <small>{SPEC[f].hint}</small>}
                </span>
              </button>
            ))}

            {/**
             * กล่อง "หน้าที่ต้องการ" — โผล่**ใต้ปุ่มรูปภาพ** และโผล่**เมื่อคลิก**เท่านั้น
             * ไม่ผูกกับ hover เด็ดขาด (เคยวนจนกระพริบไม่สิ้นสุด)
             */}
            {imgOpen && (
              <div className="dl__imgpanel">
                <div className="dl__range">
                  <div className="dl__rangehead">
                    <span>หน้าที่ต้องการ</span>
                    <span className="dl__count">
                      {pageCount > 0 ? describeSelection(pages, pageCount) : 'ยังไม่มีหน้า'}
                    </span>
                  </div>
                  <input
                    className="dl__rangeinput"
                    value={range}
                    onChange={(e) => setRange(e.target.value)}
                    placeholder={`ทั้งหมด เช่น 1-3, 5`}
                    aria-label="ช่วงหน้าที่ต้องการ"
                    disabled={busy}
                  />
                  <div className="dl__quick">
                    <button className="ghost" onClick={() => setRange('')} disabled={busy}>
                      ทุกหน้า
                    </button>
                    <button className="ghost" onClick={() => setRange('1')} disabled={busy}>
                      หน้าแรก
                    </button>
                    <button className="ghost" onClick={() => setRange(`1-${pageCount}`)} disabled={busy}>
                      1–{pageCount}
                    </button>
                    {pageCount > 1 && (
                      <button
                        className="ghost"
                        onClick={() => setRange(`2-${pageCount}`)}
                        disabled={busy}
                        title="ตัดหน้าแรก (หน้าปก) ออก"
                      >
                        ไม่เอาปก
                      </button>
                    )}
                  </div>
                  <p className={`dl__hint${!parsed.ok ? ' dl__hint--err' : ''}`}>
                    {pageCount === 0
                      ? 'ยังไม่มีตัวอย่างบนจอ — ดาวน์โหลดได้ทั้งฉบับเท่านั้น'
                      : parsed.ok
                        ? wantCount > 1
                          ? `จะได้ ${wantCount} หน้า · รวมเป็นไฟล์ ZIP`
                          : 'จะได้ 1 หน้า · ไฟล์รูปเดียว'
                        : parsed.reason}
                  </p>
                </div>
                <button
                  className="dl__go"
                  onClick={() => {
                    setOpen(false)
                    void downloadImages()
                  }}
                  disabled={busy || !parsed.ok || pageCount === 0}
                >
                  {wantCount > 1 ? `ดาวน์โหลด ${wantCount} รูปเป็น ZIP` : 'ดาวน์โหลดรูปภาพ (PNG)'}
                </button>
              </div>
            )}
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
