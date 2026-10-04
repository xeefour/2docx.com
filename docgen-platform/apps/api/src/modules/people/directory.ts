import type { App } from '../../types.js'
import type { PersonSuggestion } from '@docgen/shared'
import type { SessionUser } from '../auth/oidc.js'

/**
 * ── สมุดที่อยู่ผู้ใช้ ───────────────────────────────────────────────
 *
 * เก็บ `sub → ชื่อ + อีเมล` ของคนที่เคยเข้าระบบ เพื่อให้ช่อง "แชร์" ค้นหาได้
 *
 * ⚠️ ทำไมต้อง**เขียนทุกครั้งที่ล็อกอิน** ไม่ใช่ครั้งแรกเท่านั้น
 *   ผู้ใช้เปลี่ยนอีเมลที่ Casdoor ได้ ถ้าเก็บครั้งแรกแล้วไม่แตะอีก
 *   รายชื่อจะชี้ไปยังที่เก่า → พิมพ์หาแล้วเจอคนที่เปลี่ยนไปแล้ว
 *   และถ้าเชิญด้วยอีเมล ไปเชิญคนผิด
 *
 * ⚠️ อีเมลของคนอื่นถือเป็นข้อมูลส่วนตัว
 *   ระบบนี้เป็นระบบภายในองค์กร และผู้ใช้ถามมาแบบนี้ตั้งแต่ต้น
 *   ("พิมพ์ 3 ตัวอักษรแล้วขึ้นอีเมลของคนที่เคย login") → ทำตามนั้น
 *   แต่ต้องเปิดเผยเฉพาะตอนผู้ใช้พิมพ์จริง ๆ ไม่ใช่ดึงทั้งรายชื่อมาโชว์ทีเดียว
 *   และค้นจาก session เสมอ (ไม่มีใครเห็นได้ถ้าไม่ล็อกอิน)
 */

const PEOPLE = 'people'
const ACCESS = 'template_access'

/** เอกสารคนหนึ่งคน */
interface PersonDoc {
  _id: string
  name: string | null
  email: string
  lastSeenAt: Date
}

const people = (app: App) => app.mongo.collection<PersonDoc>(PEOPLE)

/**
 * พิมพ์ยังไม่ถึง 3 ตัวอักษร → ไม่ค้น
 *
 * เหตุผล: คำค้นสั้น ๆ คืนผลได้เกือบทั้งรายชื่อ ซึ่งไม่มีประโยชน์ต่อผู้ใช้
 * และยิง regex ทั่ว collection ทุกครั้งที่พิมพ์ = แพงเกินจำเป็น
 */
export const PEOPLE_MIN_QUERY = 3

/** จำนวนผลลัพธ์สูงสุดที่ส่งให้หน้าเว็บ — มากกว่านี้ผู้ใช้เลื่อนอ่านไม่ทัน */
const MAX_ITEMS = 8

/** ดึง regex ตัวอักษรพิเศษออก — ผู้ใช้พิมพ์ `.` หรือ `*` มาห้ามทำให้ pattern พัง */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * สร้าง index ครั้งเดียวตอนใช้จริง
 *
 * ⚠️ ทำไมไม่ไปสร้างใน `plugins/mongo.ts` ตอนบูต
 *   `people` เป็น collection ที่มีแต่โมดูลนี้ใช้
 *   แตกเป็นสองที่แล้วต้องแก้ไฟล์ร่วมกับโค้ดอื่นที่ไม่เกี่ยว
 *   และ index ที่ผิดนิยามต้องลบทิ้งแล้วสร้างใหม่ทุกครั้งอยู่แล้ว
 *   (ดู `dropIndex` ใน mongo.ts) — งานนี้ไม่ควรไปยุ่งกับมัน
 */
let indexed: Promise<unknown> | null = null
function ensureIndex(app: App): Promise<unknown> {
  indexed ??= app.mongo.collection(PEOPLE).createIndex({ email: 1 }, { name: 'email' })
  return indexed
}

/**
 * จดผู้ใช้ลงสมุดที่อยู่ — เรียกทุกครั้งที่เข้าสู่ระบบ
 *
 * ⚠️ ถ้าอีเมลว่าง (Casdoor บางเคสไม่ส่ง scope email) ให้ข้าม ไม่เขียนทับของเดิม
 *   เพราะ `people` ใช้ค้นหาด้วยอีเมล ถ้าเขียนทับเป็นค่าว่าง
 *   คนที่เคยมีอีเมลจะหายไปจากรายชื่อทั้งที่ยังใช้งานได้
 */
export async function touchPerson(app: App, user: SessionUser): Promise<void> {
  if (!user.sub || !user.email) return
  await ensureIndex(app)
  const at = new Date()
  await people(app).updateOne(
    { _id: user.sub } as never,
    {
      $set: { name: user.name || null, email: user.email.trim().toLowerCase(), lastSeenAt: at },
    } as never,
    { upsert: true },
  )
}

/**
 * คนที่เคยเกี่ยวข้องกับฉัน — ใช้ยกขึ้นมาก่อนในผลลัพธ์
 *
 * รวม 2 ทาง:
 *   1. คนที่ฉันเปิดสิทธิ์ให้ (ฉันเป็นเจ้าของแม่แบบ)
 *   2. เจ้าของแม่แบบที่เปิดสิทธิ์ให้ฉัน
 * ทางที่ 2 สำคัญมาก — คนที่เคยส่งแม่แบบให้ฉันคือคนที่ฉันอยากแชร์กลับ
 *
 * ⚠️ ใช้ index ที่มีอยู่แล้ว (`owner` และ `shared_with`) ไม่ต้องสแกนทั้ง collection
 */
async function relatedSubs(app: App, sub: string): Promise<Set<string>> {
  const out = new Set<string>()
  const col = app.mongo.collection(ACCESS)

  const mine = await col.find({ owner: sub } as never).project({ sharedWith: 1 }).toArray()
  for (const d of mine) {
    for (const s of (d as { sharedWith?: { sub?: string }[] }).sharedWith ?? []) {
      if (s?.sub) out.add(s.sub)
    }
  }

  const withMe = await col.find({ 'sharedWith.sub': sub } as never).project({ owner: 1 }).toArray()
  for (const d of withMe) {
    const o = (d as { owner?: string }).owner
    if (o) out.add(o)
  }

  out.delete(sub)
  return out
}

/**
 * ค้นผู้ใช้จากสมุดที่อยู่
 *
 * เรียงลำดับ (สำคัญกว่าตัวค้นหา):
 *   1. คนที่เคยเกี่ยวข้องกับฉัน
 *   2. อีเมล/ชื่อที่**ขึ้นต้น**ด้วยที่พิมพ์ (พิมพ์ "som" แล้วต้องเจอ somchai@ ก่อนคนอื่น)
 *   3. คนที่เพิ่งเข้าระบบ
 */
export async function searchPeople(
  app: App,
  me: SessionUser,
  q: string,
): Promise<PersonSuggestion[]> {
  const query = q.trim().toLowerCase()
  if (query.length < PEOPLE_MIN_QUERY) return []
  await ensureIndex(app)

  const related = await relatedSubs(app, me.sub)
  const rx = new RegExp(escapeRegex(query), 'i')
  // ดึงมากกว่าที่จะส่งไว้หนึ่งรอบ เผื่อการเรียงลำดับทำให้บางคนหลุดท้าย
  const rows = await people(app)
    .find({ $or: [{ email: rx }, { name: rx }] } as never)
    .limit(MAX_ITEMS * 4)
    .toArray()

  const scored = rows
    .map((r) => {
      const d = r as unknown as PersonDoc
      const email = d.email ?? ''
      const name = d.name ?? ''
      const startsEmail = email.startsWith(query)
      const startsName = name.toLowerCase().startsWith(query)
      return { d, startsEmail, startsName, shared: related.has(String(d._id)) }
    })
    .sort((a, b) => {
      if (a.shared !== b.shared) return a.shared ? -1 : 1
      const aStart = a.startsEmail || a.startsName ? 0 : 1
      const bStart = b.startsEmail || b.startsName ? 0 : 1
      if (aStart !== bStart) return aStart - bStart
      return b.d.lastSeenAt.getTime() - a.d.lastSeenAt.getTime()
    })
    .slice(0, MAX_ITEMS)

  return scored.map(({ d, shared }) => ({
    sub: String(d._id),
    name: d.name ?? null,
    email: d.email ?? '',
    shared,
    lastSeenAt: d.lastSeenAt instanceof Date ? d.lastSeenAt.toISOString() : null,
  }))
}
