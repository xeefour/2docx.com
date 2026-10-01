'use client'

/**
 * พรีวิวเอกสารเป็น "รูป" ไม่ใช่ PDF viewer ของเบราว์เซอร์
 *
 * ทำไมไม่ใช้ <iframe src="…pdf">
 *   · เบราว์เซอร์แสดงคำอธิบายแทรกด้านบน และควบคุมได้แค่ซูมของตัวเอง
 *   · ดาวน์โหลดเป็น PNG ทีละหน้าไม่ได้
 *   → ใช้ pdf.js วาดแต่ละหน้าลง <canvas> แล้วจัดการซูมเอง
 *
 * เลย์เอาต์: หน้าที่เลือกแสดงเป็นรูปใหญ่กลางจอ · หน้าที่เหลือเรียงกันเป็นแถวด้านล่าง
 * คลิกรูปไหนก็ย้ายไปดูหน้านั้น
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { loadPdf, type LoadedPdf } from './lib/pdf'
import { UNITS, type RulerUnit } from './lib/ruler'
import Ruler from './Ruler'

const ZOOMS = [0.5, 0.75, 1, 1.5, 2, 3]

/** คีย์เก็บค่าที่เลือกไว้ — ผู้ใช้เปิดเอกสารเดิมบ่อย ไม่ควรตั้งใหม่ทุกครั้ง */
const RULER_KEY = 'docgen.preview.ruler'
const RULER_UNIT_KEY = 'docgen.preview.rulerUnit'

/** อ่านค่าจาก localStorage แบบไม่พัง — SSR/privacy mode อาจอ่านไม่ได้ */
function readStored(key: string, fallback: string): string {
  if (typeof window === 'undefined') return fallback
  try {
    return window.localStorage.getItem(key) ?? fallback
  } catch {
    return fallback
  }
}

export default function DocumentPreview({
  fileUrl,
  label,
  onPdf,
  toolbarExtra,
}: {
  fileUrl: string
  label: string
  /**
   * ส่ง document ที่โหลดแล้วให้พ่อเก็บไว้
   * ปุ่ม "ดาวน์โหลดเป็นรูป" ใช้ตัวนี้ตัด PNG ได้เลย ไม่ต้องโหลด PDF ซ้ำ
   */
  onPdf?: (pdf: LoadedPdf | null) => void
  /** เนื้อหาที่จะต่อท้ายแถบซูม — ปุ่มดาวน์โหลดอยู่ตรงนี้ */
  toolbarExtra?: ReactNode
}) {
  const [pdf, setPdf] = useState<LoadedPdf | null>(null)
  const [page, setPage] = useState(1)
  const [zoom, setZoom] = useState(1)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  // ── ไม้บรรทัด ──
  const [ruler, setRuler] = useState(() => readStored(RULER_KEY, '0') === '1')
  const [unit, setUnit] = useState<RulerUnit>(() =>
    readStored(RULER_UNIT_KEY, 'cm') === 'in' ? 'in' : 'cm',
  )
  /** ขนาดหน้ากระดาษเป็น pt — มาจาก PDF ไม่เดาเอง */
  const [pagePt, setPagePt] = useState<{ widthPt: number; heightPt: number } | null>(null)
  /** ขนาดจริงบนจอของ canvas (px) — ไม้บรรทัดต้องกว้างเท่านี้เป๊ะ */
  const [stage, setStage] = useState({ w: 0, h: 0 })

  const mainRef = useRef<HTMLCanvasElement>(null)
  const stripRef = useRef<HTMLDivElement>(null)
  const pageRef = useRef<HTMLDivElement>(null)

  // ── โหลดไฟล์ใหม่ทุกครั้งที่ URL เปลี่ยน ──
  useEffect(() => {
    let alive = true
    let current: LoadedPdf | null = null

    setLoading(true)
    setError(null)
    setPage(1)

    void (async () => {
      try {
        const res = await fetch(fileUrl, { credentials: 'same-origin' })
        if (!res.ok) throw new Error(`โหลดไฟล์ไม่สำเร็จ (${res.status})`)
        const buf = await res.arrayBuffer()
        if (!alive) return

        current = await loadPdf(buf)

        /**
         * ⚠️ ดึงขนาดหน้าให้เสร็จ **ก่อน** `setPdf` เสมอ
         *
         *   ถ้า `await` คาบระหว่าง `setPdf` กับ `setLoading(false)`
         *   React จะแทรกรอบเรนเดอร์ตรงนั้น โดยที่ `loading` ยังเป็น true
         *   → component คืนหน้า "กำลังเปิดเอกสาร…" ซึ่งไม่มี `.docpage`
         *   → effect ที่เรียก drawMain รันตอนนั้น เจอ pageRef.current = null แล้ว return
         *   → พอ setLoading(false) ทำให้หน้าเต็มขึ้นมา drawMain ก็ไม่ถูกเรียกซ้ำ
         *      (useCallback ไม่เปลี่ยนตัวตนเพราะ pdf/page/zoom เท่าเดิม)
         *   ผลคือ canvas ค้างเป็น 300×150 ค่าเริ่มต้นของ <canvas> ไม่เคยวาด
         */
        const size = await current.pageSize(1)
        if (!alive) {
          void current.destroy()
          return
        }

        setPdf(current)
        onPdf?.(current)
        setPagePt(size)
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : String(e))
      } finally {
        if (alive) setLoading(false)
      }
    })()

    return () => {
      alive = false
      // ⚠️ ต้อง destroy ไม่งั้น pdf.js จะถือ worker ค้างไว้
      void current?.destroy()
    }
    // onPdf เป็น callback ของพ่อ — ใส่ใน dep แล้วจะวนตลอด
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileUrl])

  // ── วาดหน้าหลัก ──
  const drawMain = useCallback(async () => {
    if (!pdf || !mainRef.current) return
    const canvas = mainRef.current
    /**
     * ⚠️ ต้องวัดจาก `.docpage` (ภายนอก grid) ไม่ใช่จากพ่อของ canvas
     *    ถ้าวัดจากพ่อ canvas เราจะได้วงจร: กล่องกว้างตาม canvas → canvas กว้างตามกล่อง
     *    แล้วค่าจะไม่มีวันนิ่ง (สังเกตได้จากหน้าเว็บกระพริบเวลาซูม)
     */
    const host = pageRef.current
    if (!host) return
    // เว้นที่ให้ไม้บรรทัดแนวตั้ง + ระยะขอบ ไม่งั้นหน้าจอแคบแล้วกระดาษล้นแนวนอน
    const aside = ruler ? 18 + 10 : 0
    const avail = host.clientWidth - 32 - aside
    canvas.style.width = `${Math.max(160, Math.round(avail * zoom))}px`
    try {
      await pdf.render(page, canvas)
      /**
       * อัปเดตขนาด stage หลังวาดเสร็จ เพราะต้องรู้ความสูงจริงของ canvas
       * (canvas คงสัดส่วนจาก width/height attribute ที่ pdf.js ตั้งไว้)
       * — ไม้บรรทัดยึดค่านี้ ถ้าใช้ค่าคาดเดา ขอบจะไม่ตรงกระดาษ
       */
      setStage({ w: canvas.clientWidth, h: canvas.clientHeight })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [pdf, page, zoom, ruler])

  useEffect(() => {
    void drawMain()
  }, [drawMain])

  /**
   * ── ขนาดจริงของกระดาษบนจอ ──
   *
   * ⚠️ `setStage` หลัง `pdf.render` เสร็จเพียงอย่างเดียว **ไม่พอ**
   *   ตอนเปิดไม้บรรทัดที่บันทึกไว้หลังรีเฟรช เลย์เอาต์ยังไม่ทันนิ่ง
   *   วัดแล้วได้ 0 → `Ruler` คืน null → ไม้บรรทัดไม่โผล่จนกว่าจะซูมหรือสลับหน่วย
   *   `ResizeObserver` รายงานขนาดจริงทุกครั้งที่มันเปลี่ยน (รวมครั้งแรกที่ observe)
   *   จึงเป็นผู้บอกความจริงเสมอ ไม่ต้องเดาจังหวะ
   */
  useEffect(() => {
    const canvas = mainRef.current
    if (!canvas || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => {
      const w = canvas.clientWidth
      const h = canvas.clientHeight
      // คืน state เดิมถ้าค่าเท่าเดิม ไม่งั้นจะวนเรนเดอร์ไม่จบ
      setStage((s) => (s.w === w && s.h === h ? s : { w, h }))
    })
    ro.observe(canvas)
    return () => ro.disconnect()
  }, [pdf])

  // ── วาดรูปย่อในแถบด้านล่าง ──
  useEffect(() => {
    if (!pdf) return
    const host = stripRef.current
    if (!host) return

    let alive = true
    const nodes: HTMLCanvasElement[] = []

    void (async () => {
      // วาดทีละหน้าแบบต่อเนื่อง เพื่อไม่ให้ worker ของ pdf.js ค้าง
      for (let n = 1; n <= pdf.count; n++) {
        if (!alive) return
        const canvas = document.createElement('canvas')
        canvas.style.width = '104px'
        nodes.push(canvas)
        host.appendChild(canvas)
        try {
          await pdf.render(n, canvas)
        } catch {
          /* หน้าไหนวาดไม่ได้ก็ข้าม ไม่ทำให้ทั้งแถบพัง */
        }
      }
    })()

    return () => {
      alive = false
      for (const c of nodes) c.remove()
    }
  }, [pdf])

  const step = (dir: -1 | 1) =>
    setZoom((z) => {
      const i = ZOOMS.indexOf(z)
      const next = ZOOMS[Math.min(ZOOMS.length - 1, Math.max(0, i + dir))]
      return i === -1 ? 1 : next
    })

  const toggleRuler = () =>
    setRuler((v) => {
      const next = !v
      try {
        window.localStorage.setItem(RULER_KEY, next ? '1' : '0')
      } catch {
        /* โหมดส่วนตัว — ใช้แค่รอบนี้ก็พอ */
      }
      return next
    })

  const toggleUnit = () =>
    setUnit((u) => {
      const next: RulerUnit = u === 'cm' ? 'in' : 'cm'
      try {
        window.localStorage.setItem(RULER_UNIT_KEY, next)
      } catch {
        /* เหมือนข้างบน */
      }
      return next
    })

  if (loading) {
    return (
      <div className="muted" style={{ padding: '64px 24px', textAlign: 'center' }}>
        กำลังเปิดเอกสาร…
      </div>
    )
  }

  if (error) {
    return (
      <div className="pill err" style={{ padding: '12px 16px', margin: 16 }}>
        เปิดเอกสารไม่สำเร็จ: {error}
      </div>
    )
  }

  if (!pdf) {
    return (
      <div className="muted" style={{ padding: '64px 24px', textAlign: 'center', fontSize: 14 }}>
        กด “เรนเดอร์ตัวอย่าง” เพื่อดูผลลัพธ์
      </div>
    )
  }

  return (
    <div>
      {/* ── แถบควบคุม ──
          ⚠️ ต้องมี class `doctools` — เทสต์ใช้วัดความสูงแถบนี้
             ถ้าไม่มี มันจะวัดทั้งการ์ดพรีวิวแทน (ซึ่งสูงเป็นร้อย) แล้วผ่านทุกครั้ง
             โดยไม่ได้ตรวจอะไรจริง */}
      <div
        className="doctools"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '10px 16px',
          borderBottom: '1px solid var(--line)',
          flexWrap: 'wrap',
        }}
      >
        <span className="muted" style={{ fontSize: 13 }}>
          หน้า {page} / {pdf.count}
        </span>
        <div style={{ flex: 1 }} />

        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <button className="ghost" onClick={() => step(-1)} disabled={zoom <= ZOOMS[0]}>
            −
          </button>
          <span className="muted mono" style={{ fontSize: 12, minWidth: 42, textAlign: 'center' }}>
            {Math.round(zoom * 100)}%
          </span>
          <button
            className="ghost"
            onClick={() => step(1)}
            disabled={zoom >= ZOOMS[ZOOMS.length - 1]}
          >
            +
          </button>
          {zoom !== 1 && (
            <button className="ghost" onClick={() => setZoom(1)} style={{ fontSize: 12 }}>
              รีเซ็ต
            </button>
          )}

          {/*
           * ── ไม้บรรทัด (สลับหน่ายได้ เหมือน Word) ──
           * ปุ่มหน่วยกดซ้ำเพื่อสลับ ซม. ↔ นิ้ว
           * หน่วยเป็นนิ้วแต่แสดงเป็น " โดยตรง ไม่ต้องแปลงค่าในปุ่ม
           */}
          <button
            className="ghost rulbtn"
            onClick={toggleRuler}
            aria-pressed={ruler}
            title={ruler ? 'ซ่อนไม้บรรทัด' : 'แสดงไม้บรรทัด'}
            data-testid="ruler-toggle"
          >
            <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">
              <rect x="2" y="7" width="20" height="10" rx="2" fill="none" stroke="currentColor" strokeWidth="1.6" />
              <path
                d="M7 7v4M11 7v6M15 7v4M19 7v6"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
              />
            </svg>
            <span className="rulbtn__t">ไม้บรรทัด</span>
          </button>
          <button
            className="ghost rulbtn"
            onClick={toggleUnit}
            title="สลับหน่วย เซนติเมตร ↔ นิ้ว"
            data-testid="ruler-unit"
          >
            {UNITS.find((u) => u.id === unit)?.label}
          </button>

          {/*
           * ปุ่มดาวน์โหลดอยู่ตรงนี้ รวมกับแถบซูม
           * เดิมอยู่ในหัวการ์ดพร้อม dropdown — เบียดกันจนหัวการ์ดสูงเปล่า
           */}
          {toolbarExtra}
        </div>
      </div>

      {/* ── รูปหน้าที่เลือก ── */}
      <div
        onWheel={(e) => {
          // Ctrl/⌘ + ลูกกลิ้ง = ซูม (แบบเดียวกับโปรแกรมอ่านเอกสารทั่วไป)
          if (!e.ctrlKey && !e.metaKey) return
          e.preventDefault()
          step(e.deltaY < 0 ? 1 : -1)
        }}
        className="docpage"
        ref={pageRef}
      >
        {/*
         * stage = กรอบที่กว้างเท่ากับ canvas เป๊ะ
         * ไม้บรรทัดอยู่ใน grid นี้ จึงยึดขอบกระดาษได้โดยไม่ต้องคำนวณ offset
         * ตำแหน่งแต่ละชิ้นกำหนดด้วย grid-area ใน globals.css
         */}
        <div
          className="docstage"
          style={{
            gridTemplateColumns: ruler ? '18px auto' : '0 auto',
            gridTemplateRows: ruler ? '18px auto' : '0 auto',
          }}
        >
          {ruler && <div className="docstage__corner" />}
          {ruler && pagePt && (
            <Ruler
              pageW={pagePt.widthPt}
              pageH={pagePt.heightPt}
              unit={unit}
              width={stage.w}
              height={stage.h}
            />
          )}
          <div className="docstage__page" style={{ lineHeight: 0 }}>
            <canvas
              ref={mainRef}
              style={{ background: '#fff', boxShadow: '0 1px 8px rgba(0,0,0,.12)', borderRadius: 2 }}
            />
          </div>
        </div>
      </div>

      {/* ── หน้าที่เหลือ เรียงกันด้านท้าย ── */}
      {pdf.count > 1 && (
        <div style={{ borderTop: '1px solid var(--line)', padding: '12px 16px' }}>
          <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>
            ทั้งหมด {pdf.count} หน้า — คลิกเพื่อดู
          </div>
          <div
            className="docstrip"
            ref={stripRef}
            onClick={(e) => {
              // หา index ของ canvas ที่ถูกคลิก แล้วเลื่อนไปหน้านั้น
              const target = (e.target as HTMLElement).parentElement
              if (!target || !stripRef.current) return
              const i = Array.from(stripRef.current.children).indexOf(target)
              if (i >= 0) setPage(i + 1)
            }}
            style={{ display: 'flex', gap: 10, overflowX: 'auto', paddingBottom: 4 }}
          />
          <style>{`
            .docstrip canvas {
              flex: 0 0 auto;
              border: 2px solid var(--line);
              border-radius: 2px;
              background: #fff;
              cursor: pointer;
              transition: border-color .12s;
            }
            .docstrip canvas:hover { border-color: var(--brand); }
          `}</style>
        </div>
      )}

      <p className="muted" style={{ margin: 0, padding: '0 16px 14px', fontSize: 12 }}>
        {label} · กด Ctrl + ลูกกลิ้งเพื่อซูม
      </p>
    </div>
  )
}
