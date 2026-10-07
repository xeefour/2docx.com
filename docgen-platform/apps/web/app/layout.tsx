import type { Metadata } from 'next'
import AppStatus from './components/AppStatus'
import './globals.css'

export const metadata: Metadata = {
  title: '2docx.com — ระบบสร้างเอกสารราชการ',
  description:
    'สร้างเอกสารราชการอัตโนมัติจากแม่แบบสำเร็จรูป ส่งออกเป็น PDF, Word หรือ Excel ได้ในไม่กี่วินาที',
  // โดเมนจริงคือ 2docx.com — ใช้ให้ถูกต้องตั้งแต่ต้น
  metadataBase: new URL('https://2docx.com'),
  openGraph: {
    title: '2docx.com — ระบบสร้างเอกสารราชการ',
    description: 'สร้างเอกสารราชการอัตโนมัติจากแม่แบบสำเร็จรูป',
    url: 'https://2docx.com',
    siteName: '2docx.com',
    locale: 'th_TH',
    type: 'website',
  },
  robots: { index: true, follow: true },
}

/**
 * สคริปต์เล็กที่รัน**ก่อนหน้าเว็บวาดครั้งแรก** เพื่อใส่โหมดที่ผู้ใช้เคยเลือกไว้
 *
 * ── ทำไมต้องเป็นสคริปต์ในหน้าเว็บ ไม่ใช่ทำใน React ────────────────────────────
 *   ถ้ารอ `useEffect` ใน component หน้าเว็บจะวาดด้วยโหมดสว่างก่อน แล้วค่อยเปลี่ยนเป็นมืด
 *   ผู้ใช้ที่เลือกโหมดมืดจะเห็น**กะพริบสีขาว**ทุกครั้งที่เปิดหน้า
 *   แก้ด้วย React ไม่ได้ เพราะ `useEffect` จะรันหลังจากวาดเสร็จไปแล้วเสมอ
 *
 *   เขียนเป็นสคริปต์สั้น ๆ ใน `<head>` คือวิธีมาตรฐาน (เหมือนกับที่ next-themes ทำ)
 *
 * ⚠️ ต้องอ่านค่าเดียวกับ `ThemeToggle` (`docgen-theme`) ไม่งั้นสองฝั่งจะไม่ตรงกัน
 */
const THEME_BOOT = `(function(){try{var t=localStorage.getItem('docgen-theme');if(t==='dark'||t==='light'){var e=document.documentElement;e.dataset.theme=t;e.style.colorScheme=t;}}catch(e){}})();`

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    /*
     * ⚠️ `suppressHydrationWarning` จำเป็น
     *   เบราว์เซอร์เขียน `data-theme` ลง `<html>` ก่อนที่ React จะ hydrate
     *   ถ้าไม่ปิดการเตือนนี้ React จะเห็น HTML ไม่ตรงกับที่มันสร้าง แล้วเตือนว่าไม่ตรงกัน
     *   (เตือนนี้ไม่กระทบการแสดงผล แต่ทำให้ตรวจหาบั๊กยากขึ้น)
     */
    <html lang="th" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT }} />
      </head>
      {/* AppStatus ครอบทุกหน้า — แถบโหลดตอนเปลี่ยนหน้า + ช่องคัดลอก URL */}
      <body>
        <AppStatus>{children}</AppStatus>
      </body>
    </html>
  )
}
