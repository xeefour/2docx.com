/**
 * `/teams` — server component โหลดรายชื่อทีมฝั่ง server แล้วส่งให้ client
 *
 * ⚠️ ใช้ `no-store` เพราะรายชื่อทีมผูกกับ session — ถ้า cache ไว้
 *   ผู้ใช้ที่เพิ่งถูกถอนจะยังเห็นทีมเก่าทั้งที่สิทธิ์หายแล้ว
 */
import { headers } from 'next/headers'
import type { TeamAccess } from '@docgen/shared'
import TeamsPage from './TeamsPage'

/** server เรียก API ของตัวเอง — ไม่ผ่าน rewrite ของ Next ต้องยิงตรง */
const API = process.env.API_ORIGIN ?? 'http://127.0.0.1:4001'

export default async function Teams() {
  const h = await headers()
  const cookie = h.get('cookie') ?? ''

  let teams: TeamAccess[] = []
  let meName = ''
  let meSub = ''
  let meEmail = ''

  try {
    const res = await fetch(`${API}/api/teams`, { headers: { cookie }, cache: 'no-store' })
    if (res.ok) {
      const body = await res.json()
      teams = body?.items ?? []
    }
  } catch {
    // API ล่ม → แสดงรายการว่าง หน้าเว็บยังใช้งานต่อได้ (จะเห็นแค่เมนู)
    teams = []
  }

  // ชื่อผู้ใช้มาจาก session cookie — อ่านจาก API แทนที่จะ decode เอง
  try {
    const res = await fetch(`${API}/api/account`, { headers: { cookie }, cache: 'no-store' })
    if (res.ok) {
      const b = await res.json()
      meName = b?.profile?.name ?? ''
      meSub = b?.profile?.sub ?? ''
      // เชิญด้วยอีเมล → ผู้ใช้ต้องเห็นอีเมลตัวเองเพื่อก๊อปไปให้คนอื่น
      meEmail = b?.profile?.email ?? ''
    }
  } catch {
    /* ไม่มีข้อมูลก็ปล่อยว่าง */
  }

  return <TeamsPage teams={teams} meName={meName} meSub={meSub} meEmail={meEmail} />
}
