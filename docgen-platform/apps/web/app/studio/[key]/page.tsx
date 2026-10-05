import { headers } from 'next/headers'
import Studio from '../Studio'

/**
 * เปิดแม่แบบตัวเดียวจาก URL — /studio/<key>
 *
 * ไฟล์นี้มีแค่เพื่อให้**รีเฟรชแล้วยังอยู่หน้าเดิม** และคัดลอก URL ให้คนอื่นเปิดได้
 * ตัวแสดงผลทั้งหมดยังอยู่ที่ `Studio.tsx` เหมือนกัน
 *
 * ⚠️ Next 15 ส่ง `params` มาเป็น Promise → ต้อง await
 *
 * ⚠️ ชื่อผู้ใช้ใน footer ต้องดึงเหมือน `app/studio/page.tsx`
 *   ถ้าลืม route นี้จะเป็นหน้าที่ sidebar ไม่มีชื่อผู้ใช้
 *   แล้วจะเห็นเฉพาะตอนเปิด `/studio` เปล่า — ช่วงที่ผู้ใช้ใช้งานจริงกี่สิบเปอร์เซ็นต์
 */
export const metadata = {
  title: 'Studio · 2docx.com',
  robots: { index: false, follow: false },
}

/** server เรียก API ของตัวเอง — ไม่ผ่าน rewrite ของ Next ต้องยิงตรง */
const API = process.env.API_ORIGIN ?? 'http://127.0.0.1:4001'

export default async function Page({ params }: { params: Promise<{ key: string }> }) {
  const { key } = await params
  const h = await headers()
  const cookie = h.get('cookie') ?? ''

  let meName = ''
  try {
    const res = await fetch(`${API}/api/account`, { headers: { cookie }, cache: 'no-store' })
    if (res.ok) {
      const b = await res.json()
      meName = b?.profile?.name ?? ''
    }
  } catch {
    /* ไม่มีข้อมูลก็ปล่อยว่าง */
  }

  return <Studio initialKey={decodeURIComponent(key)} meName={meName} />
}
