/**
 * โหลด pdf.js ฝั่งเบราว์เซอร์ — เอาไว้ที่เดียวเพื่อไม่ต้องตั้ง worker ซ้ำ
 *
 * ทำไมต้องใช้ pdf.js แทนการฝัง PDF ด้วย <iframe>:
 *   · ผู้ใช้ต้องการ "ตัวอย่างเอกสารเป็นรูป" ไม่ใช่ PDF viewer ของเบราว์เซอร์
 *   · ต้องซูมได้ และต้องดาวน์โหลดเป็น PNG ทีละหน้าได้
 *     ซึ่งทำได้เฉพาะตอนเรามี canvas ของแต่ละหน้าอยู่แล้ว
 *
 * ⚠️ โหลดแบบ dynamic เพราะ pdf.js มี `window`/`DOMMatrix` ในตัว
 *    ถ้า import ตรง ๆ ตอน build ฝั่ง server จะพัง
 */
import type { PDFDocumentProxy } from 'pdfjs-dist'

/** โหลด worker เพียงครั้งเดียว — โมดูลตัวนี้ถูกเรียกจาก component หลายตัว */
let pdfjsPromise: Promise<typeof import('pdfjs-dist')> | null = null

function getPdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = import('pdfjs-dist').then((pdfjs) => {
      /**
       * Next.js + webpack 5 แปลง `new URL(..., import.meta.url)`
       * ให้เป็น URL ของไฟล์ที่ bundle มาพร้อมกันเอง
       * ต้องเป็น .mjs เพราะ pdf.js v6 เป็น ESM ล้วน
       */
      pdfjs.GlobalWorkerOptions.workerSrc = new URL(
        'pdfjs-dist/build/pdf.worker.min.mjs',
        import.meta.url,
      ).toString()
      return pdfjs
    })
  }
  return pdfjsPromise
}

export type LoadedPdf = {
  /** จำนวนหน้า */
  count: number
  /** ขนาดหน้ากระดาษเป็น pt (PDF unit) — ไม้บรรทัดใช้ค่านี้คำนวณระยะ */
  pageSize: (n: number) => Promise<{ widthPt: number; heightPt: number }>
  /** วาดหน้าที่ n (1-based) ลง canvas ที่ให้มา พร้อมกำหนดขนาดให้เอง */
  render: (n: number, canvas: HTMLCanvasElement) => Promise<void>
  /** คืน canvas ขนาดจริง (px ตาม dpr) โดยไม่ผูกกับ DOM — ใช้ตอนดาวน์โหลด PNG */
  toPng: (n: number, scale?: number) => Promise<Blob>
  /** ปิดเอกสาร — ต้องเรียกเมื่อเปลี่ยนไฟล์ มิฉะนั้น worker จะค้าง */
  destroy: () => Promise<void>
}

export async function loadPdf(data: ArrayBuffer): Promise<LoadedPdf> {
  const pdfjs = await getPdfjs()

  /**
   * ⚠️ ต้องเก็บ `loadingTask` ไม่ใช่แค่ `doc`
   *    ใน pdf.js v6 `PDFDocumentProxy` ไม่มี `destroy()` แล้ว
   *    มีแต่บน loading task ซึ่งเป็นตัวที่ปิด worker จริง
   *    (ถ้าไม่ destroy worker จะค้างในหน่วยความจำทุกครั้งที่เปิดเอกสารใหม่)
   */
  const loadingTask = pdfjs.getDocument({ data: new Uint8Array(data) })
  const doc: PDFDocumentProxy = await loadingTask.promise

  /** cache viewport ต่อ (หน้า, scale) — getPage เป็นงาน async ที่ไม่ควรเรียกซ้ำ */
  const viewports = new Map<
    string,
    ReturnType<Awaited<ReturnType<PDFDocumentProxy['getPage']>>['getViewport']>
  >()

  const viewportFor = async (n: number, scale: number) => {
    const key = `${n}@${scale}`
    const hit = viewports.get(key)
    if (hit) return hit
    const page = await doc.getPage(n)
    const vp = page.getViewport({ scale })
    viewports.set(key, vp)
    return vp
  }

  /**
   * pdf.js โยน error ทันทีถ้า render ทับกันบน canvas เดียวกัน
   * ("Cannot use the same canvas during multiple render() operations")
   * ซึ่งเกิดจริงตอนผู้ใช้กดซูมรัว ๆ หรือเลื่อนหน้าในแถบรูปย่อ
   * → ต้องจัดคิวต่อ canvas ไม่ใช่ยิงพร้อมกัน
   */
  const queues = new WeakMap<HTMLCanvasElement, Promise<unknown>>()

  const draw = async (n: number, canvas: HTMLCanvasElement, scale: number) => {
    const viewport = await viewportFor(n, scale)
    const page = await doc.getPage(n)
    const prev = queues.get(canvas) ?? Promise.resolve()
    const next = prev
      .catch(() => undefined) // คิวก่อนหน้าล้มเหลวไม่ควรทำให้คิวนี้ตายด้วย
      .then(() =>
        page.render({ canvas, canvasContext: canvas.getContext('2d')!, viewport }).promise,
      )
    queues.set(canvas, next)
    return next
  }

  return {
    count: doc.numPages,

    /**
     * ขนาดหน้าเป็น pt — ต้องใช้ scale 1 เสมอ
     * ถ้าใช้ scale อื่นค่าจะถูกคูณตามไปด้วย แล้วไม้บรรทัดจะเพี้ยนตามซูม
     */
    async pageSize(n) {
      const vp = await viewportFor(n, 1)
      return { widthPt: vp.width, heightPt: vp.height }
    },

    async render(n, canvas) {
      const cssW = canvas.clientWidth
      const dpr = window.devicePixelRatio || 1

      // scale 1 = ขนาดจริงของหน้า (pt) ใช้เป็นฐานคำนวณ
      const base = await viewportFor(n, 1)
      const scale = base.width > 0 ? (cssW / base.width) * dpr : dpr

      canvas.width = Math.floor(base.width * scale)
      canvas.height = Math.floor(base.height * scale)
      await draw(n, canvas, base.width > 0 ? scale : dpr)
    },

    async toPng(n, scale = 2) {
      const base = await viewportFor(n, 1)
      const canvas = document.createElement('canvas')
      canvas.width = Math.floor(base.width * scale)
      canvas.height = Math.floor(base.height * scale)

      await draw(n, canvas, scale)

      return new Promise((resolve, reject) => {
        canvas.toBlob(
          (b) => (b ? resolve(b) : reject(new Error('สร้าง PNG ไม่สำเร็จ'))),
          'image/png',
        )
      })
    },

    destroy: () => loadingTask.destroy(),
  }
}
