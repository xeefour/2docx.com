/**
 * `/teams/[id]` — จัดการสมาชิกทีม
 *
 * server component โหลดข้อมูลทีม แล้วส่งให้ client จัดการต่อ
 * (การเพิ่ม/ถอนสมาชิกต้องโหลดใหม่ทุกครั้ง จึงทำฝั่ง client)
 */
import { headers } from 'next/headers'
import { notFound } from 'next/navigation'
// ⚠️ alias ชื่อ type — ชื่อ TeamDetail ถูกใช้เป็นชื่อ page function แล้ว
import type { TeamDetail as TeamDetailData } from '@docgen/shared'
import TeamDetailClient from './TeamDetailClient'

const API = process.env.API_ORIGIN ?? 'http://127.0.0.1:4001'

/** สิทธิ์ที่จัดการสมาชิกได้ = admin ขึ้นไป */
const canManage = (r: string | null) => r === 'admin' || r === 'owner'

export default async function TeamDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const cookie = (await headers()).get('cookie') ?? ''

  let data: TeamDetailData | null = null
  let meSub = ''
  let meName = ''
  try {
    const res = await fetch(`${API}/api/teams/${encodeURIComponent(id)}`, {
      headers: { cookie },
      cache: 'no-store',
    })
    if (res.status === 404) notFound()
    if (res.ok) data = await res.json()
  } catch {
    data = null
  }

  if (!data) notFound()

  // หา sub ของผู้เรียกจากรายชื่อสมาชิก: เรียก /api/account เพื่อไม่ต้องเดา
  try {
    const res = await fetch(`${API}/api/account`, { headers: { cookie }, cache: 'no-store' })
    if (res.ok) {
      const p = (await res.json())?.profile
      meSub = p?.sub ?? ''
      // ⚠️ ชื่อผู้ใช้ต้องมาเหมือนกันทุกหน้า — เดิมหน้านี้ไม่มีชื่อใน sidebar
      //   ทำให้ส่วนล่างของเมนูโหว่เว้าว่าง ต่างจาก /studio · /account · /teams
      meName = p?.name ?? ''
    }
  } catch {
    /* ปล่อยว่าง */
  }

  return (
    <TeamDetailClient
      initial={data}
      meSub={meSub}
      meName={meName}
      canManage={canManage(data.myRole)}
    />
  )
}
