import { createHash } from 'node:crypto'
import type { App } from '../../types.js'
import { AppError, DEFAULT_USER_SETTINGS, now, reportReceivers } from '@docgen/shared'
import type {
  AccountProfile,
  AccountStats,
  AccountSummary,
  UpdateSettingsBody,
  UserSettings,
} from '@docgen/shared'
import type { SessionUser } from '../auth/oidc.js'
import { sniffImage } from '../templates/previews.js'

/**
 * ── หน้าบัญชีผู้ใช้ (`/api/account`) ───────────────────────────────────
 *
 * ผู้ใช้สั่ง:
 *   *"ทำ /account ให้หน่อย"*
 *
 * ── หลักการที่ต้องรักษาไว้ ───────────────────────────────────────
 *
 * 1. **ไม่เก็บข้อมูลประจำตัวซ้ำสองที่**
 *   ชื่อ/อีเมล/รูป มาจาก session (Casdoor) เสมอ อ่านสดทุกครั้ง
 *   ถ้าเก็บลง Mongo ด้วย ข้อมูลจะเพี้ยนทันทีที่ผู้ใช้เปลี่ยนชื่อที่ Casdoor
 *   → ที่นี่เก็บแค่ค่าตั้งค่าที่ Casdoor ไม่รู้จัก (จริง ๆ คือเรื่องการแจ้งเตือน)
 *
 * 2. **นับสถิติจากของจริงเสมอ ห้ามเก็บตัวเลขสรุป**
 *   ตัวเลขพวกนี้โตตามการใช้งาน (เอกสาร/ประวัติ) ถ้าเก็บไว้ล่วงหน้า
 *   ต้องนับใหม่ทุกครั้งที่มีอะไรเปลี่ยน แล้วจะเพี้ยนเงียบ ๆ ตอนหน้าจอนิ่ง
 *
 * 3. **ทุก count ต้องมีเงื่อนไขผู้ใช้เสมอ**
 *   collection เหล่านี้เก็บของผู้ใช้ทุกคนรวมกัน (ยกเว้นที่บอกไว้ใน comment)
 */

/** โครง request ที่ service layer ใช้ */
type Req = { user?: SessionUser | null }

// ── collection ที่ใช้ ───────────────────────────────────────────
const SETTINGS = 'user_settings'
const BOOKMARKS = 'bookmarks'
const CHATS = 'chat_sessions'
const DOCUMENTS = 'documents'
const ACCESS = 'template_access'
const NOTIFICATIONS = 'notifications'

/** เอกสารที่บันทึกค่าตั้งค่าไว้ — `_id` = sub ของผู้ใช้ (หนึ่งคนมีแถวเดียว) */
interface SettingsDoc extends UserSettings {
  _id: string
  /**
   * storage key ของรูปโปรไฟล์ที่ผู้ใช้อัปโหลดเอง
   *
   * เก็บเป็น key เต็ม (ไม่ใช่แค่ส่วนขยาย) เพราะถ้าผู้ใช้อัปโหลด png แล้วเปลี่ยนเป็น jpeg
   * ต้องรู้ว่าไฟล์เดิมอยู่ที่ไหนถึงจะลบทิ้งได้ (ไม่งั้นจะมีไฟล์กำพร้าทุกครั้งที่เปลี่ยนรูป)
   */
  avatar?: string | null
  updatedAt: Date
}

/**
 * ผู้เรียกปัจจุบัน
 *
 * ทำซ้ำจาก `studio/notifications.ts` ตามเหตุผลเดียวกัน
 * (ไฟล์นั้น import `who` มาจาก `service.ts` — ถ้า import กลับ = circular)
 */
function who(req: Req): SessionUser {
  const u = req.user
  if (!u?.sub) throw new AppError('AUTH_REQUIRED', 'ยังไม่ได้เข้าสู่ระบบ', 401)
  return u
}

// ── ค่าตั้งค่า ───────────────────────────────────────────────────

/**
 * ค่าตั้งค่าของผู้ใช้ + ว่าเคยบันทึกเมื่อไหร่
 *
 * ⚠️ คืนค่าเริ่มต้นเสมอถ้ายังไม่เคยบันทึก — หน้าเว็บจะได้ไม่ต้องมี branch `undefined`
 */
export async function getSettings(
  app: App,
  sub: string,
): Promise<{ settings: UserSettings; updatedAt: Date | null }> {
  const raw = await loadDoc(app, sub)

  if (!raw) return { settings: { ...DEFAULT_USER_SETTINGS }, updatedAt: null }

  return {
    /**
     * ⚠️ ต้องเลือก field ทีละชื่อ ห้าม spread `raw` ทั้งก้อน
     *   แถวนี้มี `_id` · `updatedAt` · `avatar` ปนอยู่ ซึ่งไม่ใช่ส่วนของ `UserSettings`
     *   ถ้า spread แล้ว ฟิลด์เหล่านั้นจะหลุดไปอยู่ใน JSON ที่ส่งให้หน้าเว็บด้วย
     */
    settings: toSettings(raw),
    updatedAt: raw.updatedAt instanceof Date ? raw.updatedAt : new Date(raw.updatedAt),
  }
}

/** อ่านแถวเต็มจาก Mongo — คืน null ถ้าผู้ใช้ยังไม่เคยบันทึกอะไรเลย */
async function loadDoc(app: App, sub: string): Promise<SettingsDoc | null> {
  return (await app.mongo
    .collection<SettingsDoc>(SETTINGS)
    .findOne({ _id: sub } as never)) as unknown as SettingsDoc | null
}

/** ตัดเฉพาะส่วนที่เป็นค่าตั้งค่า — ครอบคลุม `avatar` ที่อยู่ในแถวเดียวกันออกไป */
function toSettings(d: SettingsDoc): UserSettings {
  return {
    notifyOnShare: d.notifyOnShare ?? DEFAULT_USER_SETTINGS.notifyOnShare,
    notifyOnDocument: d.notifyOnDocument ?? DEFAULT_USER_SETTINGS.notifyOnDocument,
  }
}

/** บันทึกค่าตั้งค่า — merge ทับของเดิม ไม่ใช่ replace ทั้งแถว */
export async function saveSettings(
  app: App,
  sub: string,
  patch: UpdateSettingsBody,
): Promise<{ settings: UserSettings; updatedAt: Date }> {
  const current = await getSettings(app, sub)
  const settings: UserSettings = { ...current.settings, ...patch }
  const updatedAt = now()

  await app.mongo.collection<SettingsDoc>(SETTINGS).updateOne(
    { _id: sub } as never,
    { $set: { ...settings, updatedAt } } as never,
    { upsert: true },
  )

  return { settings, updatedAt }
}

/**
 * ใช้ตอนจะส่งจดหมาย — ผู้ใช้ปิดการแจ้งเตือนฟิลด์นี้ไว้หรือยัง
 *
 * ⚠️ อ่านจาก Valkey ไม่ได้ (session เก็บแค่ข้อมูลตัวตนจาก Casdoor)
 *   ค่าตั้งค่าอยู่ใน Mongo เท่านั้น → ถ้าอยากให้ session เห็นต้องย้ายไปเก็บที่ Valkey
 *   ตอนนี้ยังไม่ต้องการ เพราะการแจ้งเตือนเกิดหลังจาก session ถูกสร้างเสมอ
 */
export async function isNotifyEnabled(
  app: App,
  sub: string,
  pref: keyof UserSettings,
): Promise<boolean> {
  const { settings } = await getSettings(app, sub)
  return settings[pref]
}

// ── รูปโปรไฟล์ ─────────────────────────────────────────────────

/** รูปโปรไฟล์สูงสุด 2 MB — เกินนี้แปลว่าอัปโหลดรูปใหญ่ผิด (เช่น ภาพต้นฉบับ) */
export const MAX_AVATAR_BYTES = 2 * 1024 * 1024

/** content type → นามสกุลไฟล์ (กุญแจมาจากของจริงที่ sniffImage คืน ไม่ใช่ที่ client ส่งมา) */
const AVATAR_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
}

/**
 * key ใน S3 ของรูปโปรไฟล์
 *
 * ⚠️ ต้อง **hash** `sub` ก่อน ไม่ใช่ใช้ตรง ๆ
 *   `sub` มาจาก Casdoor ซึ่งเราคุมรูปแบบไม่ได้ อาจมี `/`, `..` หรืออักขระแปลก
 *   ถ้าเอามาต่อเป็น path ตรง ๆ จะเขียนทับไฟล์คนอื่นหรือหลุดออกนอก prefix ได้
 */
function avatarKey(sub: string, ext: string): string {
  return `avatars/${createHash('sha256').update(sub).digest('hex')}.${ext}`
}

/** อ่านไบต์จริง → content type — ใช้ตัวเดียวกับรูปตัวอย่างแม่แบบ (กัน stored XSS) */
function inspectAvatar(body: Buffer): { contentType: string; ext: string } {
  if (body.byteLength === 0) {
    throw new AppError('VALIDATION', 'ไฟล์รูปว่างเปล่า', 400)
  }
  if (body.byteLength > MAX_AVATAR_BYTES) {
    throw new AppError(
      'VALIDATION',
      `ไฟล์รูปใหญ่เกินไป (สูงสุด ${Math.round(MAX_AVATAR_BYTES / 1024 / 1024)} MB)`,
      400,
    )
  }

  const contentType = sniffImage(body)
  const ext = contentType ? AVATAR_EXT[contentType] : undefined
  if (!contentType || !ext) {
    throw new AppError('VALIDATION', 'รองรับเฉพาะไฟล์ PNG, JPEG และ WebP', 400)
  }
  return { contentType, ext }
}

/**
 * อัปโหลดรูปโปรไฟล์ของผู้ใช้
 *
 * คืน storage key ใหม่ และลบไฟล์เดิมทิ้งถ้าส่วนขยายต่างกัน
 * (ถ้าส่วนขยายเดิม การเขียนทับที่ key เดิมไปเลย ไม่ต้องลบ)
 */
export async function setAvatar(app: App, sub: string, body: Buffer): Promise<{ key: string }> {
  const { contentType, ext } = inspectAvatar(body)
  const key = avatarKey(sub, ext)
  const previous = (await loadDoc(app, sub))?.avatar ?? null

  await app.s3.put(key, body, contentType)

  /**
   * ลบไฟล์เดิมก่อนบันทึก key ใหม่
   *
   * ⚠️ ถ้าบันทึก key ใหม่ก่อนแล้วค่อยลบ → ถ้าพังตรงนี้จะเหลือไฟล์กำพร้า
   *   ที่ไม่มีใครอ้างถึงแล้วลบไม่ได้อีก (ไม่มี index ไห้ช่วยหา)
   *   ทิศทางนี้พังแค่ตอนลบไฟล์เดิม → key ใหม่ยังไม่ถูกบันทึก
   *   ผู้ใช้กดใหม่อีกครั้งก็แก้ได้ ไม่ค้าง
   */
  if (previous && previous !== key) {
    await app.s3.del(previous).catch((err: unknown) => {
      app.log.warn({ err: String(err), previous }, 'ลบรูปโปรไฟล์เดิมไม่สำเร็จ (ไฟล์กำพร้า)')
    })
  }

  await app.mongo
    .collection<SettingsDoc>(SETTINGS)
    .updateOne({ _id: sub } as never, { $set: { avatar: key, updatedAt: now() } } as never, {
      upsert: true,
    })

  app.log.info({ sub, key }, 'อัปเดตรูปโปรไฟล์แล้ว')
  return { key }
}

/** อ่านรูปโปรไฟล์ — คืน null ถ้ายังไม่มี (หน้าเว็บจะได้ fallback ไปใช้รูปจาก Casdoor) */
export async function getAvatar(
  app: App,
  sub: string,
): Promise<{ body: Buffer; contentType: string } | null> {
  const key = (await loadDoc(app, sub))?.avatar
  if (!key) return null

  try {
    return { body: await app.s3.get(key), contentType: contentTypeOf(key) }
  } catch (err) {
    // key มีแต่ไฟล์หาย (เช่นถูกล้าง bucket) → ล้าง key ทิ้งให้กลับไปใช้รูป Casdoor
    app.log.warn({ err, sub, key }, 'อ่านรูปโปรไฟล์ไม่สำเร็จ — ล้างการอ้างอิงทิ้ง')
    await app.mongo
      .collection<SettingsDoc>(SETTINGS)
      .updateOne({ _id: sub, avatar: key } as never, { $set: { avatar: null } } as never)
    return null
  }
}

/** content type จากส่วนขยาย — ปลอดภัยเพราะ key เขียนโดยเราเองจาก allowlist ข้างบน */
function contentTypeOf(key: string): string {
  if (key.endsWith('.png')) return 'image/png'
  if (key.endsWith('.jpg')) return 'image/jpeg'
  return 'image/webp'
}

/** ลบรูปโปรไฟล์ — กลับไปใช้รูปจาก Casdoor */
export async function removeAvatar(app: App, sub: string): Promise<boolean> {
  const doc = await loadDoc(app, sub)
  if (!doc?.avatar) return false

  await app.s3.del(doc.avatar).catch((err: unknown) => {
    app.log.warn({ err: String(err), key: doc.avatar }, 'ลบไฟล์รูปโปรไฟล์ไม่สำเร็จ')
  })
  await app.mongo
    .collection<SettingsDoc>(SETTINGS)
    .updateOne({ _id: sub } as never, { $set: { avatar: null, updatedAt: now() } } as never)

  app.log.info({ sub }, 'ลบรูปโปรไฟล์แล้ว')
  return true
}

// ── สรุปบัญชี ───────────────────────────────────────────────────

/** แปลง session เป็นโปรไฟล์ที่ส่งออกไป */
function toProfile(u: SessionUser, doc: SettingsDoc | null): AccountProfile {
  return {
    sub: u.sub,
    name: u.name,
    email: u.email,
    avatar: u.avatar,
    // key ที่มีค่า = อัปโหลดเอง · ไม่มี = ใช้รูปจาก Casdoor
    hasCustomAvatar: Boolean(doc?.avatar),
    affiliation: u.affiliation ?? null,
  }
}

/**
 * นับสิ่งที่ผู้ใช้ทำในระบบ
 *
 * ยิง 5 count พร้อมกัน — ทุกตัวกิน index ที่มีอยู่แล้ว
 * (`user_*` ของ bookmarks/chats/notifications, `owner_created` ของ documents, `owner` ของ access)
 */
async function countStats(app: App, sub: string): Promise<AccountStats> {
  const [bookmarks, chats, documents, ownedTemplates, unread] = await Promise.all([
    app.mongo.collection(BOOKMARKS).countDocuments({ user: sub } as never),
    app.mongo.collection(CHATS).countDocuments({ user: sub } as never),
    // documents ใช้ `createdBy` ไม่ใช่ `user` — ชื่อฟิลด์ต่างกันเพราะเก็บก่อนมีระบบผู้ใช้
    app.mongo.collection(DOCUMENTS).countDocuments({ createdBy: sub } as never),
    app.mongo.collection(ACCESS).countDocuments({ owner: sub } as never),
    app.mongo.collection(NOTIFICATIONS).countDocuments({ user: sub, read: false } as never),
  ])

  return { bookmarks, chats, documents, ownedTemplates, unreadNotifications: unread }
}

/** ข้อมูลทั้งหมดที่หน้า `/account` ต้องใช้ — คำขอเดียวจบ */
export async function getAccount(app: App, req: Req): Promise<AccountSummary> {
  const u = who(req)
  const [doc, stats] = await Promise.all([loadDoc(app, u.sub), countStats(app, u.sub)])

  return {
    profile: toProfile(u, doc),
    stats,
    // ยังไม่เคยบันทึก = ค่าเริ่มต้น + updatedAt null
    settings: doc ? toSettings(doc) : { ...DEFAULT_USER_SETTINGS },
    settingsUpdatedAt: doc
      ? doc.updatedAt instanceof Date
        ? doc.updatedAt
        : new Date(doc.updatedAt)
      : null,
    // คนนี้ดูแลรายงานปัญหาไหม — หน้าเว็บใช้ค่านี้ตัดสินว่าจะโผล่ปุ่ม "รายงานปัญหา" และเมนูหน้า /reports
    canReceiveReports: reportReceivers().includes(u.sub),
  }
}
