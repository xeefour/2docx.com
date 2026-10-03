'use client'

/**
 * ป้ายเตือน "แม่แบบนี้อยู่ในถังขยะ" + ปุ่มกู้คืน / ปุ่ม clone
 *
 * ผู้ใช้สั่ง:
 *   *"เพิ่ม การลบแม่แบบ ถ้าผู้ใช้ลบไปแล้ว ให้รอก่อน 14 วัน ค่อยลบ
 *     แจ้งเตือนผู้ใช้ว่าจะลบแม่แบบนี้ ใครจะใช้ให้ clone ไปแทน"*
 *
 * ── ทำไมต้องโชว์กับทุกคน ไม่ใช่แค่คนที่กดลบ ────────────────────────
 * คนที่เปิดแม่แบบนี้อยู่ตอนถูกย้ายเข้าถังขยะ จะเห็นหน้าเหมือนเดิมทุกอย่าง
 * แล้ววันหนึ่งเปิดแล้วใช้ไม่ได้โดยไม่มีคำอธิบาย — นั่นแย่กว่าการเตือนตั้งแต่แรก
 * ปุ่ม clone จึงเป็นทางรอดที่เดียวที่พอสมเหตุสมผล (ไฟล์ยังอยู่ครบ 14 วัน)
 */
import { useState } from 'react'
import { api, ApiError, type Tombstone } from './lib/api'

/** วันที่อ่านง่ายสำหรับคนไทย — ไม่ใช้ `toLocaleDateString` เพราะผลขึ้นกับ locale ของเครื่อง */
function thaiDate(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return new Intl.DateTimeFormat('th-TH', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'Asia/Bangkok',
  }).format(d)
}

export default function TrashBanner({
  trash,
  templateName,
  onRestored,
  notify,
}: {
  trash: Tombstone
  templateName: string
  /** แม่แบบกลับมาแล้ว → หน้าแรกต้องโหลดใหม่ */
  onRestored: () => void
  notify: (msg: string) => void
}) {
  const [busy, setBusy] = useState(false)
  const [gone, setGone] = useState(false)

  async function run(label: string, fn: () => Promise<void>) {
    setBusy(true)
    try {
      await fn()
      notify(label)
    } catch (e) {
      notify(e instanceof ApiError ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  /**
   * วันที่ครบกำหนด — คำนวณจาก `purgeAt` ที่ server ส่งมา
   * ⚠️ ห้ามคำนวณจาก `Date.now()` ฝั่งเบราว์เซอร์ เพราะเวลาเครื่องผู้ใช้
   *    อาจไม่ตรงกับ server แล้วจำนวนวันจะเพี้ยน
   */
  const daysLeft = trash.daysLeft
  const mine = trash.canRestore

  return (
    <div
      data-testid="trash-banner"
      style={{
        display: 'grid',
        gap: 10,
        padding: 14,
        marginBottom: 16,
        borderRadius: 'var(--radius)',
        border: '1px solid #f0dcae',
        background: 'var(--warn-bg)',
        color: 'var(--warn)',
      }}
    >
      <div style={{ fontWeight: 600, fontSize: 14 }}>
        🗑️ แม่แบบนี้ถูกย้ายเข้าถังขยะแล้ว
        {trash.deletedByName ? ` โดย ${trash.deletedByName}` : ''}
      </div>

      <div style={{ fontSize: 13, lineHeight: 1.6 }}>
        {gone ? (
          <>
            ไฟล์ต้นฉบับถูกลบถาวรแล้ว — <b>กู้คืนไม่ได้</b>
            แต่ยังตั้งค่าการแชร์และช่องฟอร์มที่เคยทำไว้ดูได้
          </>
        ) : (
          <>
            ไฟล์จะถูกลบถาวรในอีก <b>{daysLeft} วัน</b> (วันที่ {thaiDate(trash.purgeAt)})
            ระหว่างนี้ยังเปิดทำงานต่อได้ตามปกติ
          </>
        )}
      </div>

      {!gone && (
        <div style={{ fontSize: 13, lineHeight: 1.6, color: 'var(--ink-2)' }}>
          ใครที่ใช้แม่แบบนี้อยู่ ให้กด <b>สำเนาเก็บไว้ใช้เอง</b> ก่อน
          เพราะพอครบกำหนดแล้วลิงก์นี้จะเปิดไม่ได้อีก
        </div>
      )}

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {mine && !gone && (
          <button
            disabled={busy}
            data-testid="trash-restore"
            onClick={() =>
              void run('กู้คืนแม่แบบแล้ว', async () => {
                await api.restoreTemplate(trash.templateKey)
                onRestored()
              })
            }
          >
            กู้คืนแม่แบบ
          </button>
        )}
        {!gone && (
          <button
            className="ghost"
            disabled={busy}
            data-testid="trash-clone"
            onClick={() =>
              void run('สำเนาแม่แบบให้แล้ว', async () => {
                await api.cloneTemplate(trash.templateKey, {
                  name: `${templateName} (สำเนา)`,
                  category: trash.category,
                  tags: trash.tags,
                })
              })
            }
          >
            สำเนาเก็บไว้ใช้เอง
          </button>
        )}
      </div>
    </div>
  )
}
