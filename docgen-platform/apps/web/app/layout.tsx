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

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="th">
      {/* AppStatus ครอบทุกหน้า — แถบโหลดตอนเปลี่ยนหน้า + ช่องคัดลอก URL */}
      <body>
        <AppStatus>{children}</AppStatus>
      </body>
    </html>
  )
}
