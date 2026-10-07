import { z } from 'zod/v4'

/**
 * ระบบทีม — กลุ่มผู้ใช้ที่ใช้แม่แบบชุดเดียวกัน
 *
 * ── ทำไมทีมอยู่ในระบบเรา ไม่ใช่ฝั่ง Casdoor ──────────────────────
 *   Casdoor มี Organization อยู่แล้ว แต่มีข้อจำกัดที่ใช้กับที่นี่ไม่ได้:
 *     · ผู้ใช้ 1 คน อยู่ได้ 1 องค์กรเท่านั้น → คนที่ทำงานข้ามหน่วยงานใช้ไม่ได้
 *     · สิทธิ์ระดับทีม (ใครแก้แม่แบบได้) ต้องเขียนเองอยู่ดี เพราะ Casdoor ไม่รู้จักแม่แบบ
 *     · ต้องผูกชีวิตกับ Casdoor → ถ้าย้าย IdP ทั้งระบบทีมพังตาม
 *   ตัดสินใจเก็บทีมไว้ฝั่งเรา และผูกกับผู้ใช้ด้วย `sub` ที่เป็นของ Casdoor อยู่แล้ว
 *   → ย้าย IdP ได้โดยแค่เปลี่ยนที่ชั้น auth ที่เดียว
 */

/**
 * สิทธิ์ในทีม เรียงจากต่ำไปสูง
 *
 * ⚠️ ลำดับนี้คือ**ข้อตกลง** ไม่ใช่แค่ชื่อ — โค้ดที่ตรวจสิทธิ์ใช้ลำดับนี้
 *   เพิ่ม role ใหม่ตรงนี้ที่เดียว อย่าเพิ่มที่จุดอื่น
 */
export const TeamRole = z.enum(['viewer', 'editor', 'admin', 'owner'])
export type TeamRole = z.infer<typeof TeamRole>

/** แปลง role เป็นตัวเลขเพื่อเทียบ — ยิ่งสูงยิ่งมีสิทธิ์มาก */
const RANK: Record<TeamRole, number> = { viewer: 0, editor: 1, admin: 2, owner: 3 }

/** role นี้มีสิทธิ์อย่างน้อยเท่าไร */
export function roleAtLeast(role: TeamRole | null | undefined, min: TeamRole): boolean {
  if (!role) return false
  return RANK[role] >= RANK[min]
}

/**
 * อีเมลที่ใช้เชิญ — ทำให้ผู้ใช้ไม่ต้องไปหา `sub` มาจากที่ไหน
 *
 * ⚠️ ต้อง normalize (ตัดช่องว่าง + พิมพ์เล็ก) ก่อนเทียบทุกครั้ง
 *   `A@B.co` กับ `a@b.co` คนละสตริงแต่คนเดียวกัน → เชิญซ้ำแล้วได้สองแถว
 */
export const EmailInput = z.string().trim().toLowerCase().email().max(200)
export type EmailInput = z.infer<typeof EmailInput>

/** ทำอีเมลให้เทียบกันได้ — ใช้ทั้งตอนเชิญและตอนผูกสมาชิกเข้าทีม */
export function normalizeEmail(raw: string | null | undefined): string {
  return (raw ?? '').trim().toLowerCase()
}

/**
 * สมาชิกหนึ่งคนของทีมหนึ่งทีม
 *
 * ⚠️ `sub` เป็น `null` ได้ = **คนที่ยังไม่เคยเข้าระบบ** (เชิญด้วยอีเมล)
 *   ระบบเราไม่มีที่เก็บรายชื่อผู้ใช้ (ไม่มี `users` collection · `sharedWith` เก็บแค่ `sub`)
 *   → เชิญด้วยอีเมลได้ แต่ยังรู้ `sub` ไม่ได้จนกว่าเขาจะเข้าสู่ระบบครั้งแรก
 *   แถวแบบนี้เรียกว่า "รอผูก" (`pending`) แล้ว `claimPendingInvites()` จะผูกให้ตอนล็อกอิน
 *
 * `email` เก็บ**เฉพาะตอนรอผูก** — พอผูกสำเร็จแล้วลบทิ้ง
 *   (หลักการเดียวกับ `/account`: ข้อมูลประจำตัวอ่านสดจาก session อยู่แล้ว เก็บซ้ำจะเพี้ยนทันที
 *   ที่ผู้ใช้เปลี่ยนอีเมลที่ Casdoor)
 */
export const TeamMember = z.object({
  /** null = รอผูกกับผู้ใช้ (ยังไม่เคยเข้าระบบ) */
  sub: z.string().nullable(),
  name: z.string().nullable(),
  email: z.string().nullable(),
  role: TeamRole,
  /** เข้าร่วมเมื่อไหร่ (ถ้ายังรอผูก = เวลาที่ถูกเชิญ) */
  at: z.date(),
  /** ใครเป็นคนเชิญ */
  by: z.string().nullable(),
  /** true = ยังไม่ได้ผูกกับผู้ใช้จริง */
  pending: z.boolean(),
})
export type TeamMember = z.infer<typeof TeamMember>

/** ตัวระบุสมาชิกใน URL — `sub` ของผู้ใช้จริง หรืออีเมลของคนที่ยังรอผูก */
export const MemberRef = z.string().min(1).max(200)
export type MemberRef = z.infer<typeof MemberRef>

/** ทีม — ตัว doc ใน Mongo */
export const Team = z.object({
  _id: z.string(),
  name: z.string(),
  /** ผู้สร้าง = owner คนแรกเสมอ (เก็บแยกจากสมาชิกเผื่อกรณี owner ออกจากทีม) */
  createdBy: z.string(),
  createdAt: z.date(),
  updatedAt: z.date(),
})
export type Team = z.infer<typeof Team>

/** สิทธิ์ของผู้เรียกต่อทีมนั้น — null = ไม่ได้อยู่ในทีม */
export const TeamAccess = z.object({
  team: z.string(),
  name: z.string(),
  role: TeamRole.nullable(),
  memberCount: z.number().int(),
  /** จำนวนแม่แบบของทีม */
  templateCount: z.number().int(),
  createdAt: z.date(),
})
export type TeamAccess = z.infer<typeof TeamAccess>

/** รายละเอียดทีม + รายชื่อสมาชิก */
export const TeamDetail = z.object({
  team: z.string(),
  name: z.string(),
  createdAt: z.date(),
  members: z.array(TeamMember),
  /** สิทธิ์ของผู้เรียก — null = ไม่ได้อยู่ในทีม (คนนอกทีมที่เห็นได้ก็เจอ null) */
  myRole: TeamRole.nullable(),
  templateCount: z.number().int(),
  /** อีเมลของผู้เรียก — ใช้บอกคนอื่นให้เชิญตัวเอง */
  meEmail: z.string().nullable(),
})
export type TeamDetail = z.infer<typeof TeamDetail>

export const CreateTeamBody = z.object({
  name: z.string().min(1).max(120),
  /** เชิญสมาชิกครั้งแรกเลยตอนสร้าง — ใส่**อีเมล** (ยังไม่รู้ `sub` ของคนที่ยังไม่เคยเข้าระบบ) */
  members: z
    .array(
      z.object({
        email: EmailInput,
        role: TeamRole.exclude(['owner']).default('viewer'),
      }),
    )
    .max(200)
    .default([]),
})
export type CreateTeamBody = z.infer<typeof CreateTeamBody>

export const UpdateTeamBody = z.object({
  name: z.string().min(1).max(120).optional(),
})
export type UpdateTeamBody = z.infer<typeof UpdateTeamBody>

export const AddMemberBody = z.object({
  email: EmailInput,
  role: TeamRole.exclude(['owner']).default('viewer'),
})
export type AddMemberBody = z.infer<typeof AddMemberBody>

export const UpdateMemberBody = z.object({
  role: TeamRole,
})
export type UpdateMemberBody = z.infer<typeof UpdateMemberBody>

/** ย้ายแม่แบบเข้าทีม — `team: null` = ถอนกลับเป็นของคน */
export const SetTemplateTeamBody = z.object({
  templateKey: z.string().min(1).max(200),
  team: z.string().max(120).nullable(),
})
export type SetTemplateTeamBody = z.infer<typeof SetTemplateTeamBody>
