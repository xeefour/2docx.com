'use client'

/**
 * คลิกภาพย่อบนหน้ารายการ → เปิดดูรูปเต็ม เลื่อนไปข้างหน้า/ถอยหลังได้
 * และถ้าตกลงก็มีปุ่มไปต่อที่หน้าฟอร์ม
 *
 * ผู้ใช้สั่ง:
 *   *"คลิกที่รูปก็ได้ บางทีผู้ใช้ต้องการคลิกที่นี้"*
 *   *"ให้ popup รูปขึ้นมาแสดง เพื่อให้ผู้ใช้ตัดสินใจว่าจะเลือกแบบนี้หรือไม่
 *     ถ้ามีหลายรู้ก็เลื่อนไปข้างหน้า ถอยหลังได้ ถ้าผู้ใช้ตกลง ก็มีปุ่มไปที่ form ต่อ"*
 *
 * ── ทำไมต้องโหลดรายการรูปใหม่ ───────────────────────────────────────
 *   หน้ารายการโหลดรูปย่อผ่าน `api.thumbs()` ซึ่งคืน**รูปเดียวต่อแม่แบบ**
 *   (กัน N+1) → ถ้าใช้ค่านั้น จะเลื่อนไปรูปที่ 2 ไม่ได้เลย
 *   ตอนเปิด popup จึงต้องเรียก `api.listPreviews()` เพื่อได้รูปครบทุกใบ
 *
 * ⚠️ ใช้ route ของ API ไม่ใช่ `PreviewImage.url` (presigned)
 *    RustFS ไม่ตอบ OPTIONS → ไม่มี CORS และ presigned ชี้ endpoint ภายในผ่าน tailnet
 *    (เหตุผลเดียวกับที่ TemplatePreviews ใช้ — ดู api.previewFileUrl)
 *
 * ⚠️ ปุ่ม "ไปที่ฟอร์ม" ใช้ `location.assign` เต็มหน้า ไม่ใช่ router.push
 *    เพราะแม่แบบอาจ**ไม่มี**ฟอร์มที่ตั้งไว้ แล้วหน้าแก้ไขจะเด้งไปแท็บ
 *    "ตั้งค่าฟอร์ม" เอง ซึ่งถูกกว่าให้ผู้ใช้ค้นหาเอง
 */
import { useCallback, useEffect, useState } from 'react'
import { api, type PreviewImage } from './lib/api'

type Props = {
  templateKey: string
  templateName: string
  onClose: () => void
}

export default function ThumbLightbox({ templateKey, templateName, onClose }: Props) {
  const [items, setItems] = useState<PreviewImage[] | null>(null)
  const [i, setI] = useState(0)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let alive = true
    setItems(null)
    setFailed(false)
    api
      .listPreviews(templateKey)
      .then((r) => {
        if (alive) setItems(r.items)
      })
      .catch(() => {
        if (alive) setFailed(true)
      })
    return () => {
      alive = false
    }
  }, [templateKey])

  const count = items?.length ?? 0
  const step = useCallback(
    (d: number) => setI((cur) => (count ? (cur + d + count) % count : 0)),
    [count],
  )

  /**
   * คีย์บอร์ด — ผู้ใช้คาดหวังว่าการดูรูปคือการ "เลื่อนดู" ไม่ใช่กดอ่านทีละหน้า
   * Esc ปิด · ← → เลื่อนรูป
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
      else if (e.key === 'ArrowRight') step(1)
      else if (e.key === 'ArrowLeft') step(-1)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, step])

  const cur = items && count > 0 ? items[Math.min(i, count - 1)] : null

  /**
   * คลิกพื้นหลังปิด
   *
   * ⚠️ ต้องผูกทั้งราก**และ**พื้นที่วางรูปด้วย
   *   รูปเอกสารกว้างเกือบเต็มจอ พื้นที่รอบรูปจึงเป็น `.lightbox__stage`
   *   ถ้าผูกแค่ราก ผู้ใช้จะคลิกที่ว่างแล้วไม่มีอะไรเกิดขึ้น
   *   แล้วเข้าใจว่าปุ่มปิดเสีย
   */
  const closeIfBackdrop = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) onClose()
  }

  return (
    <div
      className="lightbox"
      data-testid="thumb-lightbox"
      role="dialog"
      aria-modal="true"
      aria-label={`ตัวอย่างเอกสารของ ${templateName}`}
      onClick={closeIfBackdrop}
    >
      <div className="lightbox__bar">
        <div className="lightbox__title">
          <b>{templateName}</b>
          {count > 1 && (
            <span className="lightbox__count" data-testid="lightbox-count">
              {Math.min(i, count - 1) + 1} / {count}
            </span>
          )}
        </div>
        <button type="button" className="ghost" onClick={onClose} data-testid="lightbox-close">
          ✕ ปิด
        </button>
      </div>

      <div className="lightbox__stage" onClick={closeIfBackdrop}>
        {count > 1 && (
          <button
            type="button"
            className="lightbox__nav lightbox__nav--prev"
            onClick={() => step(-1)}
            aria-label="รูปก่อนหน้า"
            data-testid="lightbox-prev"
          >
            ‹
          </button>
        )}

        {cur ? (
          <img
            className="lightbox__img"
            src={api.previewFileUrl(templateKey, cur.id)}
            alt={`ตัวอย่างเอกสาร ${templateName}`}
            data-testid="lightbox-img"
            onError={() => setFailed(true)}
          />
        ) : (
          <div className="lightbox__msg" data-testid="lightbox-msg">
            {failed
              ? 'โหลดรูปไม่สำเร็จ — ลองกด Escape เพื่อปิด'
              : 'กำลังโหลดรูป…'}
          </div>
        )}

        {count > 1 && (
          <button
            type="button"
            className="lightbox__nav lightbox__nav--next"
            onClick={() => step(1)}
            aria-label="รูปถัดไป"
            data-testid="lightbox-next"
          >
            ›
          </button>
        )}
      </div>

      <div className="lightbox__foot">
        <span className="muted" style={{ fontSize: 13 }}>
          {count > 1 ? 'ใช้ ‹ › หรือปุ่มลูกศรซ้าย/ขวาเพื่อเลื่อน' : 'กดพื้นที่ว่างหรือ Escape เพื่อปิด'}
        </span>
        {/**
         * ปุ่มที่ผู้ใช้สั่ง: *"ถ้าผู้ใช้ตกลง ก็มีปุ่มไปที่ form ต่อ"*
         * ใช้ ?tabs=form เพื่อเปิดแท็บซ้ายตรง ๆ ไม่ต้องให้ผู้ใช้หาเอง
         */}
        <a
          className="primary"
          href={`/studio/${encodeURIComponent(templateKey)}?tabs=form`}
          data-testid="lightbox-to-form"
        >
          ไปที่ฟอร์ม →
        </a>
      </div>
    </div>
  )
}
