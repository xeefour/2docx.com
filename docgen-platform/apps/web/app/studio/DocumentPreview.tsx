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

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { loadPdf, type LoadedPdf } from './lib/pdf'
import { UNITS, type RulerUnit } from './lib/ruler'
import Ruler from './Ruler'

const ZOOMS = [0.5, 0.75, 1, 1.5, 2, 3]

/** ความหนาไม้บรรทัด (px) — ต้องตรงกับ `gridTemplate` ของ `.docstage` ใน globals.css */
const RULER_THICK = 18
/** ระยะขอบของ `.docpage` (px) — ต้องตรงกับ `padding: 16px` */
const PAGE_PAD = 16

/**
 * ความกว้างรูปย่อ (px)
 *
 * ⚠️ เดิมแถบรูปย่อ**แย่งความสูงจากรูปเอกสาร** เพราะอยู่ในกล่องเดียวกัน
 *    ที่สูงได้แค่พื้นที่ว่างของจอ (วัดได้ 588px จากจอ 1000px) จึงย่อมาที่ 76px
 *    แต่ตอนนี้กล่องรูปเอกสารสูงเต็มจอ (`.docpage` = 100vh) และแถบรูปย่อถูก
 *    ดันไปอยู่**ใต้ขอบจอ** โดยธรรมชาติ → มันไม่กินพื้นที่รูปเอกสารอีกแล้ว
 *
 *    ที่เหลือเหตุผลของขนาดนี้คือ **ระยะที่ต้องเลื่อน** เพราะผู้ใช้ต้องเลื่อนลงมา
 *    ถึงจะเห็นแถบนี้ แถบที่สูง 200px แปลว่าเลื่อนยาวกว่าโดยไม่ได้ประโยชน์อะไรเพิ่ม
 */
const THUMB_W = 76

/** ความละเอียดตอนพิมพ์ — A4 (595pt) × 2 ≈ 1190px ≈ 144 dpi พอกับกระดาษจริง */
const PRINT_SCALE = 2

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

/**
 * ไอคอนแว่นขยายสำหรับปุ่มซูมออก/ซูมเข้า
 *
 * ⚠️ เดิมใช้ตัวอักษร `−` / `+` แล้วผู้ใช้สั่งให้เปลี่ยนเป็นแว่นขยาย
 *   · ดูจากภาพไม่ออกว่าเป็นปุ่มซูม (เหมือนปุ่มลบ/บวกทั่วไป)
 *   · ตัวอักษรสูงตาม line-height ของฟอนต์ ทำให้ปุ่มซูมสูงกว่าปุ่มอื่นในแถบ
 *     (วัดจริงก่อนแก้: ซูม 42px · ปุ่มข้อความ 29px · ดาวน์โหลด 36px)
 *   ความสูงให้เท่ากันตอนนี้จัดที่ `.doctools button` ใน `globals.css`
 *
 * ⚠️ เทสต์เคยหาปุ่มนี้ด้วย `textContent === '+'`
 *   พอเป็น SVG แล้ว `textContent` จะว่างเปล่า → หาไม่เจอทันที
 *   ต้องใช้ `aria-label` แทน (ซึ่งถูกต้องกว่าอยู่แล้ว เพราะเป็นปุ่มไอคอนไม่มีคำให้อ่าน)
 */
function ZoomIcon({ minus = false }: { minus?: boolean }) {
  return (
    <svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true">
      <circle cx="10.5" cy="10.5" r="6.2" fill="none" stroke="currentColor" strokeWidth="1.7" />
      <path d="M15.3 15.3 20.5 20.5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
      <path d="M7.6 10.5h5.8" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
      {!minus && <path d="M10.5 7.6v5.8" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />}
    </svg>
  )
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
  /**
   * ขนาดพื้นที่ว่างของกล่องพรีวิว — ใช้คำนวณ "พอดีทั้งหน้า"
   *
   * ⚠️ ต้องวัดด้วย ResizeObserver ไม่ใช่ครั้งเดียวตอน mount
   *    เพราะกล่องยืด/หดตามหน้าต่าง แท็บ และแถบรูปย่อด้านล่าง
   *    ครั้งเดียวตอน mount จะได้ค่าเก่า → กระดาษไม่พอดีกล่อง
   */
  const [box, setBox] = useState({ w: 0, h: 0 })

  /**
   * ── วิธีจัดขนาดกระดาษบนจอ (ผู้ใช้เลือกเองได้) ──
   *
   * · `width` — **เต็มความกว้างที่มี** (ค่าเริ่มต้น) อ่านตัวอักษรได้จริง
   *   ถ้ากระดาษสูงเกินกล่องก็เลื่อนลงได้ ตามที่ Word/Docs ทำ
   * · `page` — **พอดีทั้งหน้า** เห็นครบไม่ต้องเลื่อน แต่กระดาษจะเล็กลง
   *   ตอนนี้กล่องสูงเต็มจอ (100vh) กระดาษ A4 แนวตั้งจึงมัก**สูงไม่ถึงขอบกล่อง**
   *   → สองโหมดจะเหมือนกันจนกว่าจะซูมเข้า หรือใช้เอกสารที่ยาวกว่าจอ
   *   (แบบฟอร์มต่อเนื่อง/กระดาษยาว) ซึ่งเป็นจังหวะที่โหมดนี้ช่วยจริง
   *
   * ⚠️ ต้องให้ผู้ใช้สลับเองได้ ไม่ใช่กำหนดฝ่ายเดียว
   *    คนหนึ่งอยากอ่านตัวอักษร อีกคนอยากเห็นภาพรวมทั้งหน้า
   *    และความเหมาะกันขึ้นกับขนาดจอ ซึ่งผู้ใช้เท่านั้นที่รู้ว่าจะทำอะไรกับเอกสารต่อ
   */
  const [fit, setFit] = useState<'width' | 'page'>('width')

  /** กระดาษที่เตรียมไว้พิมพ์ — ต้องอยู่**นอก**ต้นไม้ของแอปถึงจะซ่อนทั้งแอปได้ตอนพิมพ์ */
  const printRef = useRef<HTMLDivElement>(null)
  const [printing, setPrinting] = useState(false)
  /** portal ต้องรอฝั่งเบราว์เซอร์ ไม่งั้น server render จะพังเพราะไม่มี document.body */
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])

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
  /**
   * สเกลที่กระดาษจะถูกวาด — คำนวณจากพื้นที่ว่างจริง ไม่เดา
   *
   * ⚠️ ต้องหักทั้งไม้บรรทัด**แนวตั้งและแนวนอน**
   *    `.docstage` เป็นกริด `18px auto / 18px auto` → ไม้บรรทัดแนวนอนกินความสูงไป 18px
   *    ถ้าหักแต่แนวตั้ง (เดิม) กระดาษจะสูงเกินกล่องไป 18px ตอนเปิดไม้บรรทัด
   *    → scrollbar แนวตั้งโผล่มาทั้งที่บอกว่า "พอดีหน้า" (เจอจริงตอนทดสอบ)
   */
  const fitScale = useMemo(() => {
    if (!pagePt || !box.w || !box.h) return null
    const availW = box.w - PAGE_PAD * 2 - (ruler ? RULER_THICK + 10 : 0)
    const availH = box.h - PAGE_PAD * 2 - (ruler ? RULER_THICK : 0)
    if (availW <= 0) return null
    if (fit === 'width') return availW / pagePt.widthPt
    if (availH <= 0) return null
    return Math.min(availW / pagePt.widthPt, availH / pagePt.heightPt)
  }, [pagePt, box.w, box.h, ruler, fit])

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
    const aside = ruler ? RULER_THICK + 10 : 0
    /**
     * ⚠️ ค่านี้คือ**ความกว้าง CSS ของกระดาษบนจอ**
     *    `pdf.render()` จะอ่าน `canvas.clientWidth` แล้วแปลงเป็นสเกลของ pdf.js เอง
     *    ถ้าไม่ใส่ `zoom` ค่านี้ไว้ ผู้ใช้จะเลื่อนดูกระดาษไม่ได้เลย
     *
     * ⚠️ ห้ามมีเพดานความกว้างต่ำ (เช่นเดิมที่ใช้ 160px)
     *    กล่องแคบมากคำนวณได้กระดาษแค่ ~115px แต่เพดานดันให้สูงเกินกล่อง
     *    → scrollbar กลับมา และกล่องตรึงที่กระดาษเล็กจากวงจรป้อนกลับ
     */
    const widthPx = fitScale
      ? pagePt
        ? Math.max(24, Math.round(pagePt.widthPt * fitScale * zoom))
        : 24
      : Math.max(160, Math.round((host.clientWidth - PAGE_PAD * 2 - aside) * zoom))
    canvas.style.width = `${widthPx}px`
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
  }, [pdf, page, zoom, ruler, fitScale, pagePt])

  /** สลับวิธีจัดขนาด แล้วรีเซ็ตซูม — ไม่งั้นซูมค้างจากโหมดเดิมแล้วได้กระดาษที่ล้นทั้งที่เพิ่งกดสลับ */
  const toggleFit = () => {
    setZoom(1)
    setFit((f) => (f === 'width' ? 'page' : 'width'))
  }

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

  /**
   * ── ติดตามขนาดกล่องพรีวิว เพื่อให้กระดาษพอดีเสมอ ──
   *
   * ⚠️ แยกจาก observer ของ canvas เพราะสองคนนี้คนละเรื่อง
   *    · canvas → ขนาด**กระดาษ** (ไม้บรรทัดใช้)
   *    · กล่อง  → ขนาด**พื้นที่ว่าง** (คำนวณสเกลพอดีหน้า)
   *    ถ้ามันวนกันจะเรนเดอร์ไม่จบ เพราะการวาดทำให้ขนาดกล่องเปลี่ยน
   */
  useEffect(() => {
    const host = pageRef.current
    if (!host || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => {
      const w = host.clientWidth
      const h = host.clientHeight
      setBox((b) => (b.w === w && b.h === h ? b : { w, h }))
    })
    ro.observe(host)
    return () => ro.disconnect()
  }, [pdf])

  // ── วาดรูปย่อในแถบด้านล่าง ──
  useEffect(() => {
    if (!pdf) return
    const host = stripRef.current
    if (!host) return

    let alive = true
    const nodes: HTMLButtonElement[] = []

    void (async () => {
      // วาดทีละหน้าแบบต่อเนื่อง เพื่อไม่ให้ worker ของ pdf.js ค้าง
      for (let n = 1; n <= pdf.count; n++) {
        if (!alive) return
        /**
         * ⚠️ ต้องห่อ canvas ด้วย `<button>` ไม่ใช่ผนวก canvas เข้า `.docstrip` ตรง ๆ
         *    โค้ดเดิมหาหน้าจาก `e.target.parentElement` ซึ่งพอ canvas เป็นลูกตรง
         *    ของแถบ ตัวนั้นก็คือ `.docstrip` เอง → หา index ได้ `-1` → คลิกแล้วไม่เกิดอะไร
         *    (ผู้ใช้เจอ: คลิกรูปย่อแล้วรูปใหญ่ไม่เปลี่ยน)
         *    ใช้ `<button>` เพราะได้คีย์บอร์ดและ Enter ฟรี ๆ ด้วย
         */
        const btn = document.createElement('button')
        btn.type = 'button'
        btn.className = 'docthumb'
        btn.dataset.page = String(n)
        btn.title = `ดูหน้าที่ ${n}`
        btn.setAttribute('aria-label', `ดูหน้าที่ ${n}`)
        const canvas = document.createElement('canvas')
        canvas.style.width = `${THUMB_W}px`
        btn.appendChild(canvas)
        nodes.push(btn)
        host.appendChild(btn)
        try {
          await pdf.render(n, canvas)
        } catch {
          /* หน้าไหนวาดไม่ได้ก็ข้าม ไม่ทำให้ทั้งแถบพัง */
        }
      }
    })()

    return () => {
      alive = false
      for (const b of nodes) b.remove()
    }
  }, [pdf])

  /**
   * ทำเครื่องหมายหน้าที่กำลังดูบนรูปย่อ
   *
   * ⚠️ แถบรูปย่อถูกสร้างด้วย DOM ตรง ๆ ไม่ได้ผ่าน React
   *    การเปลี่ยนหน้าจึงไม่ทำให้ React วาดใหม่ → ต้องมาอัปเดตเองใน effect นี้
   *    ไม่งั้นผู้ใช้จะกดหน้า 2 แล้วไม่รู้ว่าตอนนี้กำลังดูหน้าไหน
   */
  useEffect(() => {
    const host = stripRef.current
    if (!host) return
    for (const b of Array.from(host.children)) {
      const on = Number(b.getAttribute('data-page')) === page
      b.classList.toggle('is-active', on)
      if (on) b.setAttribute('aria-current', 'true')
      else b.removeAttribute('aria-current')
    }
  }, [pdf, page])

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

  /**
   * ── พิมพ์เอกสารทุกหน้าเป็นรูป ──
   *
   * ⚠️ ต้องเรนเดอร์ใหม่ที่ความละเอียดสำหรับพิมพ์ **ห้ามแอบเอา canvas ที่วาดไว้บนจอ**
   *    canvas บนจอถูกย่อให้พอดีคอลัมน์ (~630px) → พิมพ์แล้วจะเป็นเส้นหยัก
   *    `toPng(n, 2)` ให้ A4 ≈ 1190px กว้าง ≈ 144 dpi พอกับกระดาษจริง
   *
   * ⚠️ ต้องรอ `img.decode()` ทุกหน้าให้เสร็จก่อน `window.print()`
   *    ไม่งั้นเบราว์เซอร์จะพิมพ์ออกมาหน้าว่าง ๆ (เคยเจออาการนี้กับการโหลดรูปช้า)
   */
  const printDoc = useCallback(async () => {
    const host = printRef.current
    if (!pdf || !host || printing) return

    setPrinting(true)
    host.replaceChildren()
    const urls: string[] = []
    let done = false
    const cleanup = () => {
      if (done) return
      done = true
      for (const u of urls) URL.revokeObjectURL(u)
      host.replaceChildren()
    }
    // บางเบราว์เซอร์ `print()` ไม่บล็อก → ต้องรอสัญญาณนี้แทน
    window.addEventListener('afterprint', cleanup, { once: true })

    try {
      for (let n = 1; n <= pdf.count; n++) {
        const blob = await pdf.toPng(n, PRINT_SCALE)
        const url = URL.createObjectURL(blob)
        urls.push(url)
        const img = new Image()
        img.src = url
        img.alt = `หน้า ${n}`
        await img.decode()
        host.appendChild(img)
      }
      window.print()
    } catch (e) {
      cleanup()
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      // `print()` บล็อกใน Chrome/Edge → ถึงตรงนี้คือพิมพ์เสร็จแล้ว
      // เบราว์เซอร์ที่ไม่บล็อกจะปล่อยผ่าน `afterprint` แทน
      if (window.matchMedia('print').matches !== true) cleanup()
      setPrinting(false)
    }
  }, [pdf, printing])

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
          <button
            className="ghost zoombtn"
            onClick={() => step(-1)}
            disabled={zoom <= ZOOMS[0]}
            title="ย่อลง"
            aria-label="ซูมออก"
          >
            <ZoomIcon minus />
          </button>
          <span className="muted mono" style={{ fontSize: 12, minWidth: 52, textAlign: 'center' }}>
            {/**
             * ⚠️ ต้องโชว์**เปอร์เซ็นต์จริงเทียบขนาดกระดาษจริง** ไม่ใช่ตัวคูณของโหมดพอดีหน้า
             *    โหมดพอดีหน้าบนจอเตี้ยได้แค่ ~50% แต่โหมดเต็มความกว้างได้ 130%
             *    ผู้ใช้ที่จะตัดสินใจว่าจะพิมพ์หรือไม่ ต้องเห็นตัวเลขจริงของสิ่งที่กำลังดู
             */}
            {fitScale ? `${Math.round(fitScale * zoom * 100)}%` : '—'}
          </span>
          <button
            className="ghost zoombtn"
            onClick={() => step(1)}
            disabled={zoom >= ZOOMS[ZOOMS.length - 1]}
            title="ขยายเข้า"
            aria-label="ซูมเข้า"
          >
            <ZoomIcon />
          </button>
          {/**
           * ⚠️ ปุ่มนี้คือทางออกหลัก ไม่ใช่ของแถบ ๆ
           *   ผู้ใช้ที่ซูมเข้าไปอ่านแล้วอยากกลับมาที่ขนาดมาตรฐาน
           *   หรือสลับดูว่าเอกสารหน้าตามั้น ต้องได้ในคลิกเดียว
           *
           *   ป้ายบอก**สิ่งที่จะเกิดเมื่อกด** ไม่ใช่สถานะปัจจุบัน
           *   เพราะสองคำนี้ยาวและคล้ายกัน ถ้าโชว์สถานะจะเข้าใจผิดว่ากดแล้วได้โหมดนั้น
           */}
          <button
            className="ghost rulbtn"
            onClick={toggleFit}
            style={{ fontSize: 12 }}
            title={
              fit === 'width'
                ? 'ตอนนี้เต็มความกว้าง — กดเพื่อย่อให้เห็นทั้งหน้าพอดีกล่อง'
                : 'ตอนนี้พอดีทั้งหน้า — กดเพื่อขยายเต็มความกว้าง'
            }
            data-testid="zoom-fit"
            data-mode={fit}
          >
            {fit === 'width' ? 'พอดีหน้า' : 'เต็มความกว้าง'}
          </button>

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
           * ── พิมพ์รูปเอกสาร ──
           * วางติดกับปุ่มดาวน์โหลด เพราะเป็นคู่กัน (เอาออกจากเครื่อง)
           */}
          <button
            className="ghost rulbtn"
            onClick={() => void printDoc()}
            disabled={printing}
            title={printing ? 'กำลังเตรียมรูป…' : 'พิมพ์เอกสารทุกหน้า'}
            data-testid="print-doc"
          >
            <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">
              <path
                d="M7 9V3h10v6M7 18H5a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              <rect x="7" y="14" width="10" height="7" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.6" />
            </svg>
            <span className="rulbtn__t">{printing ? 'กำลังพิมพ์…' : 'พิมพ์'}</span>
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
        <div className="docstrip__wrap">
          <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>
            ทั้งหมด {pdf.count} หน้า — คลิกรูปย่อเพื่อดูหน้านั้น
          </div>
          <div
            className="docstrip"
            ref={stripRef}
            onClick={(e) => {
              /**
               * ⚠️ ต้องใช้ `closest('[data-page]')` ไม่ใช่ `parentElement`
               *    คลิกอาจโดนตัว `<button>` หรือ `<canvas>` ข้างใน หรือแม้แต่ช่องว่างในปุ่ม
               *    ถ้านับด้วย `parentElement` จะพลาดทุกกรณีที่คลิกไม่ตรงตัว canvas
               */
              const btn = (e.target as HTMLElement).closest('[data-page]')
              const n = Number(btn?.getAttribute('data-page'))
              if (n >= 1 && pdf.count) setPage(Math.min(n, pdf.count))
            }}
            style={{ display: 'flex', gap: 8, overflowX: 'auto', paddingBottom: 2 }}
          />
          <style>{`
            .docstrip__wrap {
              border-top: 1px solid var(--line);
              padding: 8px 16px 10px;
              flex: 0 0 auto;
            }
            .docthumb {
              flex: 0 0 auto;
              display: block;
              padding: 2px;
              border: 2px solid var(--line);
              border-radius: 4px;
              background: #fff;
              cursor: pointer;
              line-height: 0;
              transition: border-color .12s, box-shadow .12s;
            }
            .docthumb:hover { border-color: var(--brand); }
            .docthumb.is-active {
              border-color: var(--brand);
              box-shadow: 0 0 0 2px color-mix(in srgb, var(--brand) 25%, transparent);
            }
            .docthumb canvas {
              display: block;
              border: 0;
              border-radius: 1px;
              background: #fff;
            }
          `}</style>
        </div>
      )}

      <p className="muted" style={{ margin: 0, padding: '0 16px 14px', fontSize: 12 }}>
        {label} · กด Ctrl + ลูกกลิ้งเพื่อซูม
      </p>

      {/*
       * ── กระดาษสำหรับพิมพ์ ──
       *
       * ⚠️ ต้องอยู่เป็น**ลูกโดยตรงของ `<body>`** ไม่ใช่ซ้อนอยู่ในการ์ด
       *    เพราะ CSS ตอนพิมพ์ซ่อนด้วย `body > *:not(.printsheet)`
       *    ถ้ามันอยู่ใต้ต้นไม้ของแอป จะถูกซ่อนไปด้วยและได้กระดาษว่าง
       *    → ใช้ portal ไปตรง `document.body`
       */}
      {mounted &&
        createPortal(<div className="printsheet" ref={printRef} aria-hidden="true" />, document.body)}
    </div>
  )
}
