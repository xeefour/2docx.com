'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  api,
  ApiError,
  canDeleteTemplate,
  waitForRender,
  type AccessView,
  type PreviewImage,
} from './lib/api'
import { loadPdf } from './lib/pdf'

/**
 * ── ตัวอย่างแม่แบบเป็นรูป ─────────────────────────────────────────
 *
 * เก็บได้หลายรูป สองทาง:
 *   · ระบบสร้างให้ (`auto`)   — เรนเดอร์แม่แบบเป็น PDF ด้วยข้อมูลว่าง แล้ววาดหน้าแรก
 *   · เจ้าของอัปโหลดเอง (`upload`)
 *
 * ⚠️ **รูปอัตโนมัติทำที่ฝั่งเบราว์เซอร์**
 *   เซิร์ฟเวอร์มีแค่ `pdf-lib` ซึ่งแก้ PDF ได้แต่ไม่แปลงเป็นภาพ
 *   (ต้องใช้ pdfium/poppler ที่ติดตั้งบนเครื่องนี้ไม่ได้)
 *   เบราว์เซอร์มี pdf.js ที่วาดหน้าเป็น canvas ได้อยู่แล้ว
 *   → ขั้นตอน: เรนเดอร์เป็น PDF (pipeline เดียวกับปุ่มเรนเดอร์) → วาดหน้า 1 → อัปโหลด
 *
 * ⚠️ **ลบเอกสารชั่วคราวทิ้งทุกครั้ง**
 *   การเรนเดอร์สร้าง record ในประวัติของผู้ใช้จริง
 *   ถ้าไม่ลบ ผู้ใช้จะเจอ "ตัวอย่างแม่แบบ" โผล่มาเป็นรายการในประวัติหลังจากกดสร้างตัวอย่าง
 *   ซึ่งเป็นข้อมูลปลอมที่ผู้ใช้ไม่ได้สั่ง
 */

/** สเกลตอนวาดหน้าเป็นรูป — A4 (595pt) × 1.2 ≈ 714px กว้าง */
const PNG_SCALE = 1.2

type Busy = null | 'load' | 'gen' | 'upload' | string

export default function TemplatePreviews({
  templateKey,
  versionId,
  name,
  view,
  notify,
}: {
  templateKey: string
  versionId: string
  name: string
  view: AccessView | undefined
  notify: (s: string) => void
}) {
  const [items, setItems] = useState<PreviewImage[]>([])
  const [busy, setBusy] = useState<Busy>('load')
  const [err, setErr] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  // กันสถานะของแม่แบบก่อนหน้าทับของตัวใหม่ตอนสลับแท็บเร็ว ๆ
  const seq = useRef(0)

  /**
   * เจ้าของแม่แบบเท่านั้นที่เพิ่ม/ลบรูปได้ — ใช้กติกาเดียวกับปุ่มลบและแก้ไฟล์แม่แบบ
   */
  const isOwner = canDeleteTemplate(view)

  const load = useCallback(async () => {
    const mine = ++seq.current
    setBusy('load')
    try {
      const { items: list } = await api.listPreviews(templateKey)
      if (mine !== seq.current) return
      setItems(list)
      // ⚠️ ห้าม `setErr(null)` ตรงนี้
      //   `generate()` ทำ `setErr(ข้อความ)` แล้วเรียก `load()` ต่อ
      //   ถ้า load() ล้าง error ทิ้ง ผู้ใช้จะเห็นแค่ปุ่มกลับมานิ่ง ๆ
      //   โดยไม่รู้ว่าอัปโหลดไม่สำเร็จ — เจอแล้วตอนสร้างตัวอย่างอัตโนมัติ
      //   (error ถูกกลืนทิ้งในพริบตา)
    } catch (e) {
      if (mine !== seq.current) return
      setErr(e instanceof ApiError ? e.message : String(e))
    } finally {
      if (mine === seq.current) setBusy(null)
    }
  }, [templateKey])

  useEffect(() => {
    void load()
    return () => {
      // เพิ่มเลขรอบเพื่อให้คำขอที่ค้างอยู่ถูกทิ้ง ไม่เขียน state ทับแม่แบบใหม่
      seq.current++
    }
  }, [load])

  /**
   * สร้างรูปตัวอย่างอัตโนมัติจาก**หน้าแรก**ของแม่แบบ
   *
   * ⚠️ เรนเดอร์ด้วย `data: {}` = ฟอร์มว่าง ไม่มีข้อมูลผู้ใช้หลุดลงไป
   *   ต้องแน่ใจว่า `data` ที่ผู้ใช้เคยกรอกในฟอร์ม**ไม่ถูกส่งไป** ไม่งั้นรูปตัวอย่าง
   *   จะมีข้อมูลส่วนตัวของคนกดสร้างตัวอย่างไปติดรูปที่ทุกคนเห็น
   */
  async function generate() {
    setBusy('gen')
    setErr(null)
    let docId = ''
    try {
      const started = await api.createDocument({
        templateId: versionId,
        data: {},
        outputFormat: 'pdf',
        label: `ตัวอย่างแม่แบบ: ${name}`,
      })
      docId = started._id
      await waitForRender(docId)

      const res = await fetch(api.fileUrl(docId), { credentials: 'same-origin' })
      if (!res.ok) throw new ApiError(res.status, 'NO_PDF', 'เรนเดอร์สำเร็จแต่ดึงไฟล์ PDF ไม่ได้')

      const pdf = await loadPdf(await res.arrayBuffer())
      let png: Blob
      try {
        png = await pdf.toPng(1, PNG_SCALE)
      } finally {
        // ⚠️ ต้อง destroy ทุกครั้ง ไม่งั้น worker ของ pdf.js ค้างในหน่วยความจำ
        await pdf.destroy().catch(() => {})
      }

      await api.addPreview(templateKey, png, 'ตัวอย่าง.png', 'auto')
      notify('สร้างรูปตัวอย่างจากหน้าแรกแล้ว')
      await load()
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : String(e))
      await load()
    } finally {
      /**
       * ลบเอกสารชั่วคราวเสมอ ไม่ว่าจะสำเร็จหรือพัง
       * ไม่งั้นจะมีเอกสาร "ตัวอย่างแม่แบบ" ค้างในประวัติของผู้ใช้
       * `.catch(() => {})` เพราะการลบเอกสารคือของแถม ไม่ควรทับข้อผิดพลาดจริง
       */
      if (docId) await api.deleteDocument(docId).catch(() => {})
      setBusy(null)
    }
  }

  async function upload(file: File) {
    setBusy('upload')
    setErr(null)
    try {
      await api.addPreview(templateKey, file, file.name, 'upload')
      notify('เพิ่มรูปตัวอย่างแล้ว')
      await load()
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  async function remove(id: string) {
    setBusy(id)
    setErr(null)
    try {
      await api.deletePreview(templateKey, id)
      notify('ลบรูปตัวอย่างแล้ว')
      await load()
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  return (
    <div style={{ display: 'grid', gap: 10 }}>
      {isOwner && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button
            className="ghost"
            data-testid="preview-generate"
            disabled={busy !== null}
            onClick={() => void generate()}
          >
            {busy === 'gen' ? 'กำลังสร้าง…' : '🖼 สร้างตัวอย่างอัตโนมัติ'}
          </button>
          <button
            className="ghost"
            data-testid="preview-upload"
            disabled={busy !== null}
            onClick={() => fileRef.current?.click()}
          >
            {busy === 'upload' ? 'กำลังเพิ่ม…' : '⬆ เพิ่มรูปเอง'}
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            data-testid="preview-file"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0]
              // ⚠️ ต้องเคลียร์ค่าไว้ ไม่งั้นเลือกไฟล์เดิมซ้ำจะไม่เกิด onChange
              e.target.value = ''
              if (f) void upload(f)
            }}
          />
        </div>
      )}

      {err && (
        <div className="pill err" role="alert">
          {err}
        </div>
      )}

      {busy === 'load' && <div className="muted">กำลังโหลดรูปตัวอย่าง…</div>}

      {!busy?.toString().startsWith('load') && items.length === 0 && (
        <div className="muted" data-testid="preview-empty">
          {isOwner
            ? 'ยังไม่มีรูปตัวอย่าง — กด “สร้างตัวอย่างอัตโนมัติ” เพื่อเอาหน้าแรกของแม่แบบมาเป็นรูป'
            : 'แม่แบบนี้ยังไม่มีรูปตัวอย่าง'}
        </div>
      )}

      {items.length > 0 && (
        <div className="previews" data-testid="preview-grid">
          {items.map((p) => (
            <figure key={p.id} className="previews__item">
              <img
                src={api.previewFileUrl(templateKey, p.id)}
                alt={`ตัวอย่างแม่แบบ ${name}`}
                loading="lazy"
              />
              <figcaption>
                <span className="previews__tag">
                  {p.kind === 'auto' ? 'สร้างอัตโนมัติ' : p.byName || 'อัปโหลดเอง'}
                </span>
                {isOwner && (
                  <button
                    className="ghost danger"
                    data-testid="preview-delete"
                    disabled={busy !== null}
                    onClick={() => void remove(p.id)}
                  >
                    {busy === p.id ? 'กำลังลบ…' : 'ลบ'}
                  </button>
                )}
              </figcaption>
            </figure>
          ))}
        </div>
      )}
    </div>
  )
}
