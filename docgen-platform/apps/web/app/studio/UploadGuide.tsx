'use client'

/**
 * คลิก "อัปโหลดแม่แบบ" → อธิบายว่าแม่แบบต้องทำอย่างไร + ให้ดาวน์โหลดไฟล์ตัวอย่าง
 *
 * ผู้ใช้สั่ง:
 *   *"ถ้าคลิกที่นี้จะมี popup ขึ้นมา แจ้งให้ผู้ใช้ทราบว่าระบบสามารถอัพโหลดได้เฉพาะ
 *     file นามสกุล .docx เท่านั้น เขียนตัวอย่างตัวแปร แม่แบบว่าต้องทำอย่างไร
 *     มีตัวอย่างให้ผู้ใช้ download ไปแก้ไข เพื่อให้อัพโหลดมา"*
 *
 * ── ทำไมต้องบอกว่า ".docx เท่านั้น" ─────────────────────────────────
 *   ไม่ใช่เพราะฝั่ง API ปิดนามสกุลอื่น แต่เพราะ **ขั้นตอนเรนเดอร์เอกสารทำไม่ได้**
 *   ดู `apps/worker/src/docserver.ts` ขั้นที่ 1 ของการส่งออก PDF:
 *     `renderToBuffer(templateId, { data, convertTo: 'docx' })`
 *   คือขอให้ Carbone แปลงแม่แบบเป็น .docx **เสมอ** ไม่ว่าแม่แบบต้นฉบับ
 *   จะเป็นนามสกุลอะไร แม่แบบ .xlsx/.pptx จึงตายที่ขั้นนี้
 *   (เคยเจอจริง: เรนเดอร์ .xlsx เป็น PDF ไม่ผ่าน)
 *   การบอกผู้ใช้ตรง ๆ ดีกว่าปล่อยให้อัปโหลดแล้วไปพังตอนส่งออกเอกสาร
 *
 * ── ทำไมต้องมีไฟล์ตัวอย่างให้ดาวน์โหลด ─────────────────────────────
 *   การสั่ง "พิมพ์ {d.ชื่อ}" ใน Word เป็นเรื่องที่คนไม่เคยทำมาก่อนพลาดง่ายมาก
 *   การมีไฟล์ให้เปิดดู แก้ แล้วอัปโหลดกลับ คือทางลัดที่สั้นที่สุด
 *   ไฟล์ตัวอย่างสร้างโดย `tools/make-sample-template.mjs`
 *   (สร้างเอง ไม่ใช้ไฟล์ fixture ของเทสต์ และคุมให้แท็กอยู่ใน run เดียว
 *    เพราะตัวอ่านแท็กต่อข้อความทุกก้อนก่อน regex — แท็กถ้าถูกแบ่งจะหาย)
 */
import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'

type Props = {
  onClose: () => void
  /** ปุ่ม "เลือกไฟล์ .docx" — ปิดป็อปอัปแล้วเปิด file picker ต่อ */
  onPick: () => void
}

/** ไฟล์ตัวอย่างอยู่ใน `apps/web/public/` → Next เสิร์ฟที่รากให้เอง */
const SAMPLE_URL = '/sample-template.docx'

/**
 * ⚠️ ทุกแถวต้องทดสอบกับ docserver จริงแล้วว่าเรนเดอร์ได้
 *   ถ้าเดา syntax เพิ่ม ผู้ใช้จะได้เอกสารที่มี `{...}` หลงเป็นข้อความธรรมดา
 *   แล้วเทียบกับระบบพัง — แย่กว่าไม่บอกอะไรเลย
 *
 * ⚠️ ต้องตรงกับ `tools/make-sample-template.mjs` (EXAMPLES) เสมอ
 *   ไฟล์ตัวอย่างกับตารางนี้คือเรื่องเดียวกันสองมุมมอง
 *
 * ── ที่ตัดออกเพราะทดสอบแล้วใช้ไม่ได้จริง ──────────────────────────
 * · `{#รหัสเอกสาร = d.เลขที่}` — Carbone 5 ไม่มี alias (เป็นของ docxtemplater)
 *   ทดสอบ: วางไว้แล้วอ้างด้วย `{รหัส}` → ได้ข้อความ `{รหัส}` ดิบ ๆ
 * · `{d.รายการ[i]...}` — ต้องเป็น `[i+1]` เสมอ
 *   ทดสอบ: ใช้ `[i]` แล้ว Carbone ตอบ "has no corresponding [i+1]"
 * · `{d.รายการ[i+1].ชื่อ}` — ซ้อน object ใน array แล้วค่าออกมาว่าง
 *   ทดสอบ: array ของ string ได้ · array ของ object ได้ค่าว่างทั้งภาษาไทยและอังกฤษ
 */
const SYNTAX: { code: string; field: string; meaning: string }[] = [
  { code: '{d.ผู้รับ}', field: 'ผู้รับ', meaning: 'ช่องข้อความที่ต้องกรอกเอง' },
  {
    code: "{d.วันที่:formatD('D MMMM YYYY')}",
    field: 'วันที่',
    meaning: 'เติมวันที่ปัจจุบันในรูปแบบที่กำหนด · ปีที่ได้เป็น ค.ศ. ถ้าต้องการ พ.ศ. ให้เพิ่ม 543 เอง',
  },
  {
    code: '{d.ชั่วเรื่อง:ifEQ(true):show(ด้วยความปรารถนาดี)}',
    field: 'ชั่วเรื่อง',
    meaning: 'โชว์เฉพาะข้อความในวงเล็บ show() เมื่อผู้ใช้ติ๊กช่องนั้น · ข้อความนอกวงเล็บโชว์เสมอ',
  },
  {
    code: '{d.รายการ[i]} แล้วบรรทัดถัดไปใช้ {d.รายการ[i+1]}',
    field: 'รายการ',
    meaning: 'บรรทัด [i] เปิดบล็อก ย่อหน้าถัดไปจะถูกทำซ้ำเท่าจำนวนรายการในฟอร์ม',
  },
]

export default function UploadGuide({ onClose, onPick }: Props) {
  /**
   * ⚠️ ต้องย้ายไป `document.body` ด้วย portal
   *
   *   ปุ่มนี้อยู่ใน sidebar และ sidebar บนจอเล็กใช้ `transform: translateX(...)`
   *   เพื่อเปิด-ปิดลิ้นชัก (ดู `.rail` ใน globals.css)
   *   แต่ **`transform` ทำให้ element นั้นกลายเป็น containing block
   *   ของลูกที่ใช้ `position: fixed`**
   *   ผลคือ `position: fixed; inset: 0` ของป็อปอัปจะวัดจากกรอบ sidebar (244px)
   *   ไม่ใช่จอทั้งจอ → บนมือถือป็อปอับถูกบีบจนแทบไม่เห็น
   *   เจอตอนเทสต์จอ 390px: กดแล้วป็อปอัปไม่ขึ้นเลย
   *
   *   portal ย้าย DOM ออกไป body จึงหลุดจากกรอบนั้นทันที
   *   (เหมือนกรณี lightbox ที่ต้องคอย z-index ชนะแถบ URL ให้สูง)
   */
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])

  /**
   * Escape ปิด — คนที่เปิดป็อปอัปขึ้นมาแล้วอยากออก ต้องไม่ต้องหาปุ่ม
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  if (!mounted) return null

  return createPortal(
    <div
      className="uguide"
      data-testid="upload-guide"
      role="dialog"
      aria-modal="true"
      aria-labelledby="uguide-title"
      onClick={(e) => {
        // คลิกพื้นหลังปิด · คลิกข้างในกล่องไม่ปิด
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="uguide__box">
        <div className="uguide__head">
          <b id="uguide-title">อัปโหลดแม่แบบ</b>
          <button type="button" className="ghost" onClick={onClose} data-testid="uguide-close">
            ✕ ปิด
          </button>
        </div>

        <div className="uguide__body">
          {/*
           * ข้อเท็จจริงเรื่องนามสกุล — เขียนเป็นกล่องเตือนเพราะเป็นเงื่อนไข
           * ที่ผู้ใช้จะพลาดถ้าไม่บอกตั้งแต่ก่อนกดอัปโหลด
           */}
          <div className="uguide__note" data-testid="uguide-format">
            <b>ระบบรองรับเฉพาะไฟล์ .docx เท่านั้น</b>
            <p>
              ขั้นตอนส่งออกเอกสารจะแปลงแม่แบบเป็น Word (.docx) ก่อนเสมอ
              ไฟล์นามสกุลอื่นจึงผ่านขั้นตอนนี้ไม่ได้ และจะพังตอนกดส่งออก
              แทนที่จะพังตอนอัปโหลด
            </p>
          </div>

          <h3>ทำแม่แบบอย่างไร</h3>
          <ol className="uguide__steps">
            <li>เปิด Word แล้วพิมพ์หนังสือตามที่ต้องการ ใช้จังหวะ ฟอนต์ และขนาดหน้ากระดาษเดิม</li>
            <li>
              ตรงที่ต้องให้คนกรอก พิมพ์ <code>{'{d.}'}</code> ตามด้วยชื่อช่อง เช่น{' '}
              <code>{'{d.ผู้รับ}'}</code>
            </li>
            <li>
              บันทึกเป็น <b>.docx</b> แล้วอัปโหลด — ระบบจะอ่านช่องทั้งหมดในไฟล์มา
              สร้างเป็นฟอร์มให้เอง ไม่ต้องมานั่งตั้งค่าทีหลัง
            </li>
          </ol>

          <h3>เขียนช่องได้แบบนี้</h3>
          <div className="uguide__tablewrap">
            <table className="uguide__table">
              <thead>
                <tr>
                  <th>พิมพ์ใน Word</th>
                  <th>ได้ช่องชื่อ</th>
                  <th>ทำอะไร</th>
                </tr>
              </thead>
              <tbody>
                {SYNTAX.map((s) => (
                  <tr key={s.code}>
                    <td>
                      <code>{s.code}</code>
                    </td>
                    <td className="uguide__field">{s.field}</td>
                    <td className="muted">{s.meaning}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <p className="muted uguide__tip">
            ถ้าไม่ต้องการช่องไหน ก็แค่ลบ <code>{'{d.}'}</code> ทิ้งแล้วเขียนเป็นข้อความธรรมดาแทน
          </p>
        </div>

        <div className="uguide__foot">
          <a
            className="ghost uguide__dl"
            href={SAMPLE_URL}
            download="แม่แบบตัวอย่าง.docx"
            data-testid="uguide-download"
          >
            ↓ ดาวน์โหลดไฟล์ตัวอย่าง
          </a>
          <span className="muted uguide__hint">แก้ไฟล์ตัวอย่างใน Word แล้วอัปโหลดกลับได้เลย</span>
          <button type="button" className="primary" onClick={onPick} data-testid="uguide-pick">
            เลือกไฟล์ .docx
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
