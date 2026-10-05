/**
 * `/studio` — server component ดึงชื่อผู้ใช้แล้วส่งให้ client
 *
 * ⚠️ ทำไมถึงต้องเป็น server component
 *   ชื่อผู้ใช้อยู่ใน footer ของ sidebar ซึ่งเป็นส่วนที่ผู้ใช้เห็นทันที
 *   ถ้าดึงฝั่ง client (useEffect + fetch) จะเห็น footer ว่างตอนแรก
 *   แล้วกระพริบขึ้นมาทีหลัง — เห็นเป็นของพังกว่าเป็นการโหลด
 *   แบบเดียวกับที่ `/teams` ทำไว้ (ดู `app/teams/page.tsx`)
 */
import { headers } from 'next/headers'
import Studio from './Studio'

// ไม่มี metadata เพราะเป็นเครื่องมือภายใน — ไม่ต้องการให้ index
export const metadata = {
  title: 'Studio · 2docx.com',
  robots: { index: false, follow: false },
}

/** server เรียก API ของตัวเอง — ไม่ผ่าน rewrite ของ Next ต้องยิงตรง */
const API = process.env.API_ORIGIN ?? 'http://127.0.0.1:4001'

export default async function Page() {
  const h = await headers()
  const cookie = h.get('cookie') ?? ''

  // ชื่อผู้ใช้มาจาก session cookie — อ่านจาก API แทนที่จะ decode เอง
  // ⚠️ ล้มเหลวได้โดยไม่ทำให้หน้าล้ม (ชื่อเป็นของเสริม ไม่ใช่เนื้อหาหลัก)
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

  return <Studio meName={meName} />
}
