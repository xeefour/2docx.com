import { z } from 'zod/v4'

/**
 * ── สมุดที่อยู่ผู้ใช้ + การเชิญด้วยอีเมล ─────────────────────────────
 *
 * ทำไมต้องมี ─────────────────────────────────────────────────────
 *
 * ก่อนหน้านี้ระบบ**ไม่มีที่เก็บอีเมลของผู้ใช้รายอื่นเลย**
 *   · session เก็บอีเมลแค่ตอนที่คนนั้นล็อกอิน (ใน Valkey ของเขาคนเดียว)
 *   · `template_access.sharedWith` เก็บแค่ `sub` กับ `name`
 *   → ช่อง "อนุญาตให้ใครใช้ได้" จึงบังคับให้ผู้ใช้ไปหา subject ของ Casdoor
 *     มาพิมพ์เอง ซึ่งเป็น id ยาว ๆ ที่มองไม่ออกว่าเป็นใคร
 *
 * ที่นี่จะเก็บอีเมลไว้**ตอนเข้าสู่ระบบทุกครั้ง** เพื่อให้พิมพ์ไปค้นหาได้
 *   เก็บใหม่ทุกครั้งที่ล็อกอิน (ไม่ใช่ครั้งแรก) เพราะผู้ใช้เปลี่ยนอีเมลที่ Casdoor
 *   ได้ ถ้าเก็บครั้งเดียวรายชื่อจะเพี้ยนเงียบ ๆ แล้วส่งคำเชิญผิดคน
 */

/** อีเมลที่รับได้ — เก็บเป็นตัวพิมพ์เล็กเสมอ (ดู `normalizeEmail`) */
export const PeopleEmail = z.string().trim().toLowerCase().email().max(200)
export type PeopleEmail = z.infer<typeof PeopleEmail>

/** ข้อความค้นหา — สั้นกว่านี้ไม่มีประโยชน์และแพงเกินไป (ดู `PEOPLE_MIN_QUERY`) */
export const PeopleQuery = z.string().trim().min(1).max(200)
export type PeopleQuery = z.infer<typeof PeopleQuery>

/**
 * คนหนึ่งคนที่ระบบแนะนำให้เลือก
 *
 * ⚠️ `shared` = เคยแชร์แม่แบบด้วยกันมาก่อน (ใช้ยกขึ้นมาก่อนในผลลัพธ์)
 *   ผู้ใช้พิมพ์ "สม" แล้วเจอชื่อคนที่เคยทำงานด้วยกันควรมาก่อนคนแปลกหน้า
 */
export const PersonSuggestion = z.object({
  /** subject ของ Casdoor — ใช้เป็นตัวระบุตอนแชร์ */
  sub: z.string(),
  name: z.string().nullable(),
  email: z.string(),
  /** เคยได้สิทธิ์/เคยแชร์แม่แบบด้วยกันมาก่อน */
  shared: z.boolean(),
  /** ครั้งล่าสุดที่เห็นเขาเข้าระบบ */
  lastSeenAt: z.string().nullable(),
})
export type PersonSuggestion = z.infer<typeof PersonSuggestion>

export const PeopleSearchResponse = z.object({
  items: z.array(PersonSuggestion),
  /**
   * ยังตั้ง SMTP ไม่ครบ → ระบบรับคำเชิญไว้แล้ว แต่ส่งอีเมลไม่ได้
   * ต้องบอกผู้ใช้ตรง ๆ ไม่ใช่เงียบ ๆ แล้วแก้ตัว
   */
  mailReady: z.boolean(),
})
export type PeopleSearchResponse = z.infer<typeof PeopleSearchResponse>

/** เชิญคนที่ยังไม่เคยเข้าระบบ — ทำได้แค่ด้วยอีเมล เพราะยังไม่มี `sub` */
export const InviteBody = z.object({
  email: PeopleEmail,
  role: z.enum(['viewer', 'editor']).default('viewer'),
})
export type InviteBody = z.infer<typeof InviteBody>

export const InviteResponse = z.object({
  /** ระบบรับคำเชิญไว้แล้ว (รอผูกตอนเขาเข้าระบบครั้งแรก) */
  pending: z.literal(true),
  /** ส่งอีเมลสำเร็จหรือไม่ */
  emailed: z.boolean(),
  /** ถ้า emailed=false บอกเหตุผลเป็นภาษาไทยให้ผู้ใช้เข้าใจ */
  reason: z.string().nullable(),
})
export type InviteResponse = z.infer<typeof InviteResponse>

/**
 * คำเชิญที่ยังค้างอยู่ — ผู้รับยังไม่เคยเข้าระบบ จึงยังไม่มีสิทธิ์จริง
 *
 * ⚠️ แยกจาก `sharedWith` เพราะทุกแถวใน `sharedWith` คือ "มีสิทธิ์แล้ว" เสมอ
 *   ถ้ายัดคำเชิญค้างเข้าไป ทุกจุดที่นับ/แสดง/แจ้งเตือนสิทธิ์จะเพี้ยน
 */
export const PendingShare = z.object({
  email: z.string(),
  role: z.enum(['viewer', 'editor']),
  at: z.date(),
})
export type PendingShare = z.infer<typeof PendingShare>

export const PendingShareList = z.object({
  items: z.array(PendingShare),
})
export type PendingShareList = z.infer<typeof PendingShareList>
