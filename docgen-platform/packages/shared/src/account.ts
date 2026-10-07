import { z } from 'zod/v4'

/**
 * หน้าบัญชีผู้ใช้ (`/account`) — การ์ดโปรไฟล์ + สรุปสิ่งที่ผู้ใช้ทำในระบบ + ค่าตั้งค่า
 *
 * ⚠️ ข้อมูลประจำตัว (ชื่อ อีเมล รูป) **ไม่ได้**เก็บที่นี่
 *   ตัวตนมาจาก Casdoor ผ่าน session → ถ้าจะแก้ชื่อต้องแก้ที่ Casdoor
 *   docgen เก็บแค่ค่าตั้งค่าที่ Casdoor ไม่รู้จัก (ดู `UserSettings`)
 *   เหตุผลเดียวกับที่ session เก็บใน Valkey แทนที่จะ verify JWT ทุกครั้ง
 *   → ผู้ใช้ถูกลบ/เปลี่ยนชื่อที่ Casdoor แล้วฝั่งเราเห็นผลทันทีโดยไม่ต้องรอ cache หมดอายุ
 */

// ── ค่าตั้งค่าผู้ใช้ ─────────────────────────────────────────────

/**
 * ค่าตั้งค่าที่ผู้ใช้ปิดได้
 *
 * ⚠️ เพิ่มฟิลด์ใหม่ตรงนี้ = **ต้องไปเพิ่มเงื่อนไขใน `notifications.ts` ด้วย**
 *   ไม่งั้นจะเป็นค่าที่บันทึกได้แต่ไม่มีที่ไหนอ่านมัน (ค่าตั้งค่าหลอกที่ผู้ใช้กดแล้วไม่เกิดอะไร)
 *
 *   ตั้งใจ**ไม่**ให้ปิด `access` / `system` ได้ เพราะสองประเภทนี้เป็นเรื่องที่ผู้ใช้
 *   ต้องรู้เพื่อไม่เข้าใจผิว่าทำไมถึงโดน 403 — ดูเหตุผลที่ `service.ts` ตอนถูกถอนสิทธิ์
 */
export const UserSettings = z.object({
  /** มีคนแชร์แม่แบบให้ → เข้ากล่องจดหมายไหม */
  notifyOnShare: z.boolean(),
  /** งานเอกสารของผู้ใช้เสร็จ/ล้มเหลว → เข้ากล่องจดหมายไหม */
  notifyOnDocument: z.boolean(),
})
export type UserSettings = z.infer<typeof UserSettings>

/** ค่าเริ่มต้น — ใช้ตอนอ่าน (ยังไม่เคยบันทึก) และตอนฟอร์มส่งค่ามาไม่ครบ */
export const DEFAULT_USER_SETTINGS: UserSettings = {
  notifyOnShare: true,
  notifyOnDocument: true,
}

/** ขอแก้ค่าตั้งค่า — ทุกฟิลด์ไม่บังคับ เพื่อให้แก้ทีเดียวได้ */
export const UpdateSettingsBody = UserSettings.partial()
export type UpdateSettingsBody = z.infer<typeof UpdateSettingsBody>

/** คำตอบของ `GET`/`PUT /api/account/settings` */
export const UserSettingsView = z.object({
  settings: UserSettings,
  /** null = ยังไม่เคยบันทึก (กำลังใช้ค่าเริ่มต้นอยู่) */
  updatedAt: z.date().nullable(),
})
export type UserSettingsView = z.infer<typeof UserSettingsView>

/**
 * คำตอบของ `PUT`/`DELETE /api/account/avatar`
 *
 * บอกแค่ "มีรูปที่อัปโหลดเองหรือยัง" — ไม่คืน key ของไฟล์
 * เพราะ key มี hash ของ `sub` ปนอยู่ ไม่มีเหตุผลที่ client ต้องรู้
 */
export const AvatarView = z.object({
  hasCustomAvatar: z.boolean(),
})
export type AvatarView = z.infer<typeof AvatarView>

// ── สรุปบัญชี ───────────────────────────────────────────────────

/** โปรไฟล์ผู้ใช้ — สะท้อน session ปัจจุบันเสมอ ไม่ใช่ค่าที่บันทึกไว้ในระบบเรา */
export const AccountProfile = z.object({
  /** subject id จาก Casdoor (เปลี่ยนไม่ได้) */
  sub: z.string(),
  name: z.string(),
  email: z.string(),
  /** รูปจาก Casdoor (ถ้าไม่มีจะเป็นค่าว่าง ให้หน้าเว็บวาดตัวอักษรแทน) */
  avatar: z.string(),
  /**
   * ผู้ใช้อัปโหลดรูปเองที่ระบบเราเก็บไว้หรือยัง
   *
   * ถ้าเป็น `true` ให้โหลดรูปจาก `GET /api/account/avatar` แทน `avatar` ข้างบน
   * (ข้างบนยังเป็นรูปเดิมจาก Casdoor — ไม่ได้ถูกแก้ เพราะเราแก้ชื่อที่นั่นไม่ได้)
   */
  hasCustomAvatar: z.boolean(),
  /** organization / affiliation ถ้ามี */
  affiliation: z.string().nullable(),
})
export type AccountProfile = z.infer<typeof AccountProfile>

/**
 * ตัวเลขสรุปสิ่งที่ผู้ใช้ทำในระบบ
 *
 * นับตรง ๆ จาก collection ของแต่ละฟีเจอร์ ไม่มีที่เก็บสรุปไว้ล่วงหน้า
 * (เอกสารกับประวัติโตตามการใช้งานจริง ถ้าเก็บตัวเลขสรุปต้องนับใหม่ทุกครั้งที่มีอะไรเปลี่ยน)
 */
export const AccountStats = z.object({
  /** แม่แบบที่กดบุ๊กมาร์กไว้ */
  bookmarks: z.number().int(),
  /** ห้องแชทกับ AI */
  chats: z.number().int(),
  /** จำนวนเอกสารที่สั่งสร้าง (ทุกสถานะ) */
  documents: z.number().int(),
  /** แม่แบบที่ตัวเองเป็นเจ้าของ */
  ownedTemplates: z.number().int(),
  /** จดหมายที่ยังไม่ได้อ่าน */
  unreadNotifications: z.number().int(),
})
export type AccountStats = z.infer<typeof AccountStats>

/** คำตอบของ `GET /api/account` — คำขอเดียวได้ทั้งหน้า ไม่ต้องยิง 4 รอบ */
export const AccountSummary = z.object({
  profile: AccountProfile,
  stats: AccountStats,
  settings: UserSettings,
  /** ตอนบันทึกค่าตั้งค่าล่าสุด — null = ยังไม่เคยแตะ */
  settingsUpdatedAt: z.date().nullable(),
  /**
   * คนนี้เป็นผู้ดูแลที่ได้รับรายงานปัญหาไหม (อยู่ใน `REPORT_TO_SUBS`)
   *
   * ⚠️ ให้**เซิร์ฟเวอร์**เป็นผู้ตอบ ไม่ใช่ให้หน้าเว็บเดา
   *   ถ้าให้หน้าเว็บเช็คเอง แล้ววันหนึ่งรายชื่อผู้รับเปลี่ยน
   *   ปุ่ม "รายงานปัญหา" จะโผล่/หายผิดจนกว่าจะ hard reload
   *   และถ้ามีคนอ่านค่านี้จาก API ตรง ๆ ก็ได้สิทธิ์ดูรายงานทันที
   */
  canReceiveReports: z.boolean(),
})
export type AccountSummary = z.infer<typeof AccountSummary>
