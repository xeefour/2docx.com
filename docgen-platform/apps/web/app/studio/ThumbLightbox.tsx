'use client'

/**
 * คลิกภาพย่อบนหน้ารายการ → เปิดดูรูปเต็ม ซูมได้ เลื่อนไปข้างหน้า/ถอยหลังได้
 * และถ้าตกลงก็มีปุ่มไปต่อที่หน้าฟอร์ม
 *
 * ผู้ใช้สั่ง:
 *   *"คลิกที่รูปก็ได้ บางทีผู้ใช้ต้องการคลิกที่นี้"*
 *   *"ให้ popup รูปขึ้นมาแสดง เพื่อให้ผู้ใช้ตัดสินใจว่าจะเลือกแบบนี้หรือไม่
 *     ถ้ามีหลายรู้ก็เลื่อนไปข้างหน้า ถอยหลังได้ ถ้าผู้ใช้ตกลง ก็มีปุ่มไปที่ form ต่อ"*
 *   *"เพิ่มปุ่ม zoom in out หน้าถัดไปถ้ามีหลายรูป ปรับข้อความ ไปที่ฟอร์ม
 *     แก้ไขใหม่ (แก้ไขหน้าตา เพิ่ม icon) ให้อยู่ใกล้กับปุ่มปิด"*
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
 *
 * ── ทำไมปุ่มทั้งหมดอยู่แถบบน ─────────────────────────────────────
 *   เดิมปุ่ม ‹ › ซ้อนอยู่**บนตัวรูป** ซึ่งพังเงียบ ๆ สองเรื่อง:
 *     · รูปเอกสารกว้างเกือบเต็มจอ ปุ่มจะถูกดันจนแตะไม่ถึง
 *     · ผู้ใช้ที่ซูมดูตัวเล็ก ๆ ในเอกสาร ปุ่มบังเนื้อหาที่กำลังอ่าน
 *   ย้ายขึ้นแถบบนข้างปุ่มปิดตามที่ผู้ใช้สั่ง → ไม่บังรูป และกดง่ายขึ้น
 *
 * ── ทำไมซูมแล้วยัง "พอดีจอ" ได้ ───────────────────────────────────
 *   ใช้ `maxWidth/maxHeight` เป็น**เปอร์เซ็นต์ของพื้นที่วางรูป** ไม่ใช้ transform
 *   เพราะ `transform: scale()` ไม่ทำให้เกิด scrollbar → ซูมแล้วส่วนที่เกิน
 *   จะถูกตัดทิ้งไปเงียบ ๆ ใช้ไม่ได้จริง
 *   ค่าเริ่มต้น = 100% คือพอดีจอตามเดิม (เทสต์เดิมวัดไว้ว่ารูปต้องไม่ล้นพื้นที่)
 */
import { useCallback, useEffect, useState } from 'react'
import { api, type PreviewImage } from './lib/api'

type Props = {
  templateKey: string
  templateName: string
  onClose: () => void
}

/**
 * ระดับซูม — ค่าเริ่มต้นข้าง ๆ คือ "พอดีจอ" (100%)
 * ต่ำกว่า 100% ได้เพราะบางครั้งผู้ใช้อยากเห็นทั้งฉบับพร้อมกัน
 */
const ZOOMS = [0.5, 0.75, 1, 1.5, 2, 3] as const
const ZOOM_FIT = 2

const clampZoom = (n: number) => Math.min(ZOOMS.length - 1, Math.max(0, n))

export default function ThumbLightbox({ templateKey, templateName, onClose }: Props) {
  const [items, setItems] = useState<PreviewImage[] | null>(null)
  const [i, setI] = useState(0)
  const [failed, setFailed] = useState(false)
  const [zi, setZi] = useState(ZOOM_FIT)

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
  const zoom = ZOOMS[zi]

  /**
   * คีย์บอร์ด — ผู้ใช้คาดหวังว่าการดูรูปคือการ "เลื่อนดู" ไม่ใช่กดอ่านทีละหน้า
   * Esc ปิด · ← → เลื่อนรูป · + − ซูม · 0 กลับพอดีจอ
   *
   * ⚠️ เครื่องหมาย + ต้องใช้ `e.key` ตรง ๆ เพราะ Shift+`=` ให้ `+` บน US layout
   *    แต่คีย์กดบางคีย์บอร์ดให้ `+` เฉย ๆ โดยไม่ต้องกด Shift
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
      else if (e.key === 'ArrowRight') step(1)
      else if (e.key === 'ArrowLeft') step(-1)
      else if (e.key === '+' || e.key === '=') setZi((z) => clampZoom(z + 1))
      else if (e.key === '-' || e.key === '_') setZi((z) => clampZoom(z - 1))
      else if (e.key === '0') setZi(ZOOM_FIT)
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

        {/* ปุ่มทั้งหมดกองเป็นชุดเดียว ชิดกับปุ่มปิด ตามที่ผู้ใช้สั่ง */}
        <div className="lightbox__tools" onClick={(e) => e.stopPropagation()}>
          <div className="lightbox__zoom" role="group" aria-label="ขยาย/ย่อรูป">
            <button
              type="button"
              onClick={() => setZi((z) => clampZoom(z - 1))}
              disabled={zi === 0}
              aria-label="ย่อรูป"
              data-testid="lightbox-zoom-out"
            >
              <span aria-hidden="true">−</span>
            </button>
            <button
              type="button"
              className="lightbox__zoomval"
              onClick={() => setZi(ZOOM_FIT)}
              title="กลับพอดีจอ (0)"
              aria-label={`ระดับซูม ${Math.round(zoom * 100)}% กดเพื่อกลับพอดีจอ`}
              data-testid="lightbox-zoom-level"
            >
              {Math.round(zoom * 100)}%
            </button>
            <button
              type="button"
              onClick={() => setZi((z) => clampZoom(z + 1))}
              disabled={zi === ZOOMS.length - 1}
              aria-label="ขยายรูป"
              data-testid="lightbox-zoom-in"
            >
              <span aria-hidden="true">+</span>
            </button>
          </div>

          {/* เลื่อนรูป — โผล่เมื่อมีมากกว่า 1 ใบ ตามที่ผู้ใช้สั่ง */}
          {count > 1 && (
            <div className="lightbox__pager" role="group" aria-label="เลื่อนรูป">
              <button
                type="button"
                onClick={() => step(-1)}
                aria-label="รูปก่อนหน้า"
                data-testid="lightbox-prev"
              >
                <span aria-hidden="true">‹</span>
              </button>
              <button
                type="button"
                onClick={() => step(1)}
                aria-label="รูปถัดไป"
                data-testid="lightbox-next"
              >
                <span aria-hidden="true">›</span>
              </button>
            </div>
          )}

          {/**
           * ปุ่มที่ผู้ใช้สั่ง: *"ถ้าผู้ใช้ตกลง ก็มีปุ่มไปที่ form ต่อ"*
           * ข้อความเดิม "ไปที่ฟอร์ม →" บอกได้แค่ว่าจะไปที่ไหน แต่ไม่บอกว่าทำอะไร
           * → เปลี่ยนเป็นกริยา + ไอคอน ผู้ใช้อ่านแล้วรู้ว่าจะได้อะไร
           * ใช้ ?tabs=form เพื่อเปิดแท็บซ้ายตรง ๆ ไม่ต้องให้ผู้ใช้หาเอง
           */}
          <a
            className="primary lightbox__toform"
            href={`/studio/${encodeURIComponent(templateKey)}?tabs=form`}
            data-testid="lightbox-to-form"
          >
            <span className="lightbox__toform-ic" aria-hidden="true">
              ✎
            </span>
            <span className="lightbox__toform-tx">แก้ไขฟอร์ม</span>
          </a>

          <button type="button" className="ghost" onClick={onClose} data-testid="lightbox-close">
            <span aria-hidden="true">✕</span>
            <span className="lightbox__close-tx">ปิด</span>
          </button>
        </div>
      </div>

      <div className="lightbox__stage" onClick={closeIfBackdrop}>
        {cur ? (
          <img
            className="lightbox__img"
            src={api.previewFileUrl(templateKey, cur.id)}
            alt={`ตัวอย่างเอกสาร ${templateName}`}
            data-testid="lightbox-img"
            data-zoom={zoom}
            style={{ maxWidth: `${zoom * 100}%`, maxHeight: `${zoom * 100}%` }}
            onError={() => setFailed(true)}
          />
        ) : (
          <div className="lightbox__msg" data-testid="lightbox-msg">
            {failed ? 'โหลดรูปไม่สำเร็จ — ลองกด Escape เพื่อปิด' : 'กำลังโหลดรูป…'}
          </div>
        )}
      </div>

      <div className="lightbox__foot">
        <span className="muted" style={{ fontSize: 13 }}>
          {count > 1
            ? 'ใช้ ‹ › หรือปุ่มลูกศรซ้าย/ขวาเพื่อเลื่อน · + − เพื่อซูม · 0 เพื่อกลับพอดีจอ'
            : 'กดพื้นที่ว่างหรือ Escape เพื่อปิด · + − เพื่อซูม · 0 เพื่อกลับพอดีจอ'}
        </span>
      </div>
    </div>
  )
}
