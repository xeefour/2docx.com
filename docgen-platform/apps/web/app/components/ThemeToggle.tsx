'use client'

import { useEffect, useState } from 'react'

/**
 * ปุ่มสลับโหมดสว่าง/มืด — อยู่ใน sidebar ทุกหน้า (ผ่าน `AppRail`)
 *
 * ── กติกาการทำงาน ───────────────────────────────────────────────────────────
 *   1. **ยังไม่เคยกด** → ทำตามระบบของผู้ใช้ (`prefers-color-scheme`) เหมือนเดิม
 *   2. **กดแล้ว** → ใช้ค่าที่เลือกเสมอ แล้วจำไว้ใน `localStorage` ข้ามการเปิดหน้าใหม่
 *   3. ค่าถูกเขียนเป็น `data-theme` บน `<html>` ก่อนหน้าเว็บวาดครั้งแรก
 *      (สคริปต์เล็กใน `layout.tsx`) → ไม่มีการกะพริบสีขาวแวบเมื่อโหลด
 *
 * ── ทำไมต้องเขียน `data-theme` และไม่ใช้แค่คลาส ────────────────────────────
 *   CSS ต้องแยกสามกรณี: ตามระบบ · สั่งสว่าง · สั่งมืด
 *   กติกา `:root:not([data-theme='light'])` ใน media query จะ**ข้าม**เมื่อผู้ใช้สั่งสว่าง
 *   เพราะฉะนั้นผู้ใช้ที่อยู่ในระบบมืดจึงกดสลับออกมาได้จริง
 *
 * ⚠️ ต้องตั้ง `color-scheme` ด้วย ไม่งั้นฟอร์มของเบราว์เซอร์ (กล่องค้นหา แถบเลื่อน
 *   ปุ่ม dropdown) จะยังเป็นโทนสว่างทั้งที่หน้าเป็นมืด — เห็นขอบต่างกันชัด
 */
const KEY = 'docgen-theme'

type Mode = 'light' | 'dark'

export default function ThemeToggle() {
  const [mode, setMode] = useState<Mode | null>(null)

  /*
   * อ่านค่าที่ตั้งไว้จาก DOM ไม่ใช่จาก localStorage อีกที
   * เพราะสคริปต์ใน `layout.tsx` เป็นคนเขียน `data-theme` ไว้ก่อนหน้านี้
   * อ่านสองที่แล้วอาจได้ค่าคนละเรื่องถ้ามีอะไรมาเขียนทับระหว่างทาง
   */
  useEffect(() => {
    const el = document.documentElement
    const saved = el.dataset.theme === 'dark' ? 'dark' : el.dataset.theme === 'light' ? 'light' : null
    setMode(saved ?? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'))
  }, [])

  /*
   * ฟังการเปลี่ยนของระบบด้วย เพื่อให้ปุ่มแสดงค่าถูกต้องตอนผู้ใช้ยังไม่เคยกด
   * แต่ถ้าผู้ใช้กดเองแล้ว ระบบเปลี่ยนต้องไม่ทับค่าที่เลือก
   */
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = () => {
      if (document.documentElement.dataset.theme) return
      setMode(mq.matches ? 'dark' : 'light')
    }
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])

  const toggle = () => {
    const next: Mode = mode === 'dark' ? 'light' : 'dark'
    setMode(next)
    document.documentElement.dataset.theme = next
    /*
     * ⚠️ ต้องตั้ง `color-scheme` ด้วย
     *   ไม่งั้นช่องค้นหา แถบเลื่อน และลูกศรของ dropdown ที่เบราว์เซอร์วาดเอง
     *   จะยังเป็นโทนสว่างทั้งที่หน้าเป็นมืด → เห็นขอบต่างกันชัดตรงกลางจอ
     */
    document.documentElement.style.colorScheme = next
    try {
      window.localStorage.setItem(KEY, next)
    } catch {
      /*
       * โหมดส่วนตัว (incognito บางแบบ / เบราว์เซอร์ปิด storage) บันทึกไม่ได้
       * ปล่อยให้เป็นแบบครั้งเดียวก็ได้ ดีกว่าทำให้ปุ่มกดไม่ได้ทั้งหมด
       */
    }
  }

  // ก่อน mount ยังไม่รู้ค่า → วาดเป็นโครงที่มีขนาดเท่ากันเพื่อไม่ให้แถวกระตุก
  const isDark = mode === 'dark'
  const label = mode === null ? 'กำลังโหลด' : isDark ? 'โหมดมืด' : 'โหมดสว่าง'

  return (
    <button
      type="button"
      className="rail__theme"
      onClick={toggle}
      aria-label={`สลับเป็น${isDark ? 'โหมดสว่าง' : 'โหมดมืด'} (ตอนนี้${label})`}
      title={`สลับเป็น${isDark ? 'โหมดสว่าง' : 'โหมดมืด'}`}
      data-testid="theme-toggle"
      data-mode={mode ?? 'auto'}
      disabled={mode === null}
    >
      {/* ใช้สัญลักษณ์ที่ผู้ใช้คุ้น ไม่ใช้ภาพเข้ม/สว่างที่คนตาบอดอ่านไม่ออก */}
      <span aria-hidden="true">{isDark ? '☀' : '☾'}</span>
    </button>
  )
}