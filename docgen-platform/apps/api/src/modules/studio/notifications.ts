import type { App } from '../../types.js'
import { AppError, newId, now } from '@docgen/shared'
import type { InboxList, Notification, NotificationKind, UserSettings } from '@docgen/shared'
import { isNotifyEnabled } from '../account/service.js'

/**
 * ── กล่องจดหมาย (inbox) ───────────────────────────────────────────
 *
 * ผู้ใช้สั่ง:
 *   *"เพิ่มกล่องจดหมาย inbox แบ่งประเภทของจดหมายด้วย
 *     จากระบบที่เตือนต่าง ๆ เวลามีอะไรที่เกี่ยวข้องให้แจ้งเตือนเข้าไปในกล่องนี้
 *     จากเพื่อนที่ส่งมาให้ เช่น แชร์แม่แบบให้"*
 *
 * ── หลักการที่ต้องรักษาไว้ ───────────────────────────────────────
 *
 * 1. **จดหมายล้มเหลว ห้ามทำให้งานจริงล้มเหลว**
 *    `notify()` กลืน error ทิ้งเสมอ — ถ้าแชร์แม่แบบสำเร็จแต่เขียนจดหมายไม่ได้
 *    ผู้ใช้ต้องยังได้แชร์ต่อ (สำคัญกว่าการได้รับแจ้งเตือน)
 *
 * 2. **อ่านกล่องของคนอื่นไม่ได้**
 *    ทุก query ต้องมี `user` เสมอ แม้แต่ตอนทำเครื่องหมายว่าอ่าน/ลบ
 *    (`updateOne`/`deleteOne` ที่ไม่มีเงื่อนไข user = ช่องโหว่อ่านกล่องคนอื่น)
 *
 * 3. **เก็บไว้ไม่นานเกินจำเป็น**
 *    จดหมายค้างในกล่องไม่มีประโยชน์หลังผ่านไปสักพัก
 *    เหตุการณ์สำคัญที่ต้องย้อนดูจริงอยู่ที่ประวัติการทำงานของแม่แบบอยู่แล้ว
 */

/** โครง request ที่ service layer ใช้ — ทำซ้ำที่นี่เหมือน previews.ts / trash.ts */
type Req = { user?: { sub: string; name?: string } | null }

/**
 * ผู้เรียกปัจจุบัน
 *
 * ⚠️ ทำซ้ำจาก `service.ts` **เจตนา** ไม่ใช่เผลอ
 *   `service.ts` จะ import มาจากไฟล์นี้เพื่อยิงจดหมาย
 *   ถ้าไฟล์นี้ import `who` กลับไป = circular import
 *   (ESM รอดได้เพราะเป็น function declaration แต่เปราะเกินไป
 *    และจะพังทันทีถ้าวันหนึ่งมีใครเอา side effect มาไว้ระดับ module)
 */
function who(req: Req): { sub: string; name: string | null } {
  const u = req.user
  if (!u?.sub) throw new AppError('AUTH_REQUIRED', 'ยังไม่ได้เข้าสู่ระบบ', 401)
  return { sub: u.sub, name: u.name ?? null }
}

const NOTIFICATIONS = 'notifications'

/**
 * ประเภทที่ผู้ใช้ปิดได้จากหน้า `/account` — map ประเภทจดหมาย → ฟิลด์ที่ตั้งค่า
 *
 * ⚠️ `access` / `system` **ไม่อยู่ในตารางนี้** และตั้งใจให้ปิดไม่ได้
 *   · `access`  = สิทธิ์เปลี่ยน/ถูกถอน → ผู้ใช้ต้องรู้ ไม่งั้นเปิดแม่แบบแล้วเจอ 403
 *     โดยไม่มีคำอธิบาย (ดูเหตุผลที่ `service.ts` ตอนถอนสิทธิ์)
 *   · `system`  = เปิด/ปิดสาธารณเอง → สถานะของสิ่งที่ผู้ใช้เพิ่งกด ต้องเห็นทันที
 */
const MUTEABLE: Partial<Record<NotificationKind, keyof UserSettings>> = {
  share: 'notifyOnShare',
  document: 'notifyOnDocument',
}

/**
 * เก็บจดหมายไว้นานสุดกี่วัน
 *
 * 90 วัน = ยาวพอที่คนที่เพิ่งเริ่มใช้ย้อนดูย้อนหลังได้
 * แต่ไม่โตไม่จำกัด เพราะ collection นี้เก็บของผู้ใช้ทุกคนรวมกัน
 */
const RETENTION_DAYS = 90

/** ข้อความหนึ่งฉบับที่จะส่งเข้ากล่อง */
export interface NotifyInput {
  /** sub ของ**ผู้รับ** (ไม่ใช่คนที่ทำให้เกิด) */
  user: string
  kind: NotificationKind
  title: string
  body: string
  /** พาธในเว็บที่เกี่ยวข้อง เช่น `/studio/1521…` — เก็บสั้น ๆ ไม่ใช่ URL เต็ม */
  link?: string | null
  templateName?: string | null
}

/**
 * ส่งจดหมายหนึ่งฉบับ
 *
 * ⚠️ **กลืน error เสมอ** ดูหลักการข้อ 1 ด้านบน
 *   คืน `true` เมื่อเขียนสำเร็จ, `false` เมื่อไม่สำเร็จ (เพื่อให้ผู้เรียก log ได้ถ้าอยาก)
 */
export async function notify(app: App, input: NotifyInput): Promise<boolean> {
  /**
   * ผู้ใช้ปิดการแจ้งเตือนประเภทนี้ไว้ไหม
   *
   * ⚠️ อ่านค่าตั้งค่าไม่สำเร็จ = **ส่งต่อ** ไม่ใช่ข้าม
   *   การแจ้งเตือนเป็นเรื่องเสริม ถ้ามันล้มทิ้งผู้ใช้ควรได้รับ (หลักการข้อ 1)
   *   ถ้ากลัวส่งผิว่า "ปิดอยู่" ให้ดูค่าตั้งค่อยเป็นเจ้าของความเงียบ
   */
  const pref = MUTEABLE[input.kind]
  if (pref) {
    try {
      if (!(await isNotifyEnabled(app, input.user, pref))) {
        app.log.info({ user: input.user, kind: input.kind }, 'ผู้ใช้ปิดการแจ้งเตือนประเภทนี้ไว้ — ไม่ส่ง')
        return true
      }
    } catch (err) {
      app.log.warn({ err, user: input.user }, 'อ่านค่าตั้งค่าไม่สำเร็จ — ส่งจดหมายต่อ')
    }
  }

  const doc: Notification = {
    _id: newId('ntf'),
    user: input.user,
    kind: input.kind,
    title: input.title.slice(0, 200),
    body: input.body.slice(0, 500),
    link: input.link ?? null,
    templateName: input.templateName?.slice(0, 200) ?? null,
    read: false,
    at: now(),
  }
  try {
    await app.mongo.collection<Notification>(NOTIFICATIONS).insertOne(doc as never)
    await pruneOld(app, input.user)
    return true
  } catch (err) {
    app.log.warn({ err, user: input.user, kind: input.kind }, 'เขียนจดหมายลงกล่องไม่สำเร็จ (งานหลักไม่ถูกกระทบ)')
    return false
  }
}

/**
 * ส่งจดหมายชุดเดียวกันให้หลายคน (เช่น เจ้าของเปิดแม่แบบสาธารณ → แจ้งคนที่ถูกแชร์ทุกคน)
 *
 * ⚠️ ตัดคนที่ `user` เป็น null/ว่างทิ้ง ไม่ใช่ error
 *   เพราะแม่แบบที่เพิ่งอัปโหลดยังไม่มีใครถูกแชร์ (`sharedWith: []`) ซึ่งเป็นเรื่องปกติ
 */
export async function notifyMany(app: App, subs: readonly (string | null | undefined)[], input: Omit<NotifyInput, 'user'>): Promise<number> {
  const targets = [...new Set(subs.filter((s): s is string => typeof s === 'string' && s.length > 0))]
  const results = await Promise.all(targets.map((s) => notify(app, { ...input, user: s })))
  return results.filter(Boolean).length
}

/** ตัดจดหมายเก่าของคนนั้นทิ้ง — ทำทุกครั้งที่ส่งใหม่ (มี index `user_at` จึงถูก) */
async function pruneOld(app: App, user: string): Promise<void> {
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 86_400_000)
  try {
    await app.mongo
      .collection<Notification>(NOTIFICATIONS)
      .deleteMany({ user, at: { $lt: cutoff } } as never)
  } catch (err) {
    app.log.warn({ err, user }, 'ตัดจดหมายเก่าทิ้งไม่สำเร็จ (ปล่อยไปได้ จะเก็บรอบหน้า)')
  }
}

/** แปลง doc ใน Mongo เป็นรูปแบบที่ส่งออกไป (`_id` เป็น string อยู่แล้ว) */
function toView(d: Notification): Notification {
  return {
    _id: String(d._id),
    user: String(d.user),
    kind: d.kind,
    title: d.title,
    body: d.body,
    link: d.link ?? null,
    templateName: d.templateName ?? null,
    read: Boolean(d.read),
    at: d.at instanceof Date ? d.at : new Date(d.at),
  }
}

/**
 * เปิดกล่องจดหมาย
 *
 * คืนทั้งรายการ (ตามตัวกรอง) + จำนวนที่ยังไม่อ่าน + จำนวนที่ยังไม่อ่านแยกตามประเภท
 * เพื่อให้หน้าเว็บทำป้ายบนกระดิ่งและบนตัวกรองได้ใน**คำขอเดียว**
 */
export async function listInbox(
  app: App,
  req: Req,
  query: { kind?: NotificationKind; onlyUnread?: boolean; limit?: number },
): Promise<InboxList> {
  const user = who(req)
  const col = app.mongo.collection<Notification>(NOTIFICATIONS)

  /**
   * ⚠️ `onlyUnread` ต้องอยู่ใน**เงื่อนไข query** ไม่ใช่กรองทีหลัง
   *   ถ้ากรองหลัง `limit` แล้ว จะได้รายการไม่ครบ limit
   *   (เช่น limit=30 มีที่ยังไม่อ่าน 5 ฉบับ แต่ 30 ฉบับล่าสุดเป็นที่อ่านแล้ว
   *    → คืน 0 ฉบับ ทั้งที่ยังมีของให้ดู) และ `total` ก็จะไม่ตรงกับที่เห็น
   */
  const base = {
    user: user.sub,
    ...(query.kind ? { kind: query.kind } : {}),
    ...(query.onlyUnread ? { read: false } : {}),
  } as never

  const items = await col.find(base).sort({ at: -1 } as never).limit(query.limit ?? 30).toArray()
  const total = await col.countDocuments(base)
  // unread ต้องนับจาก**ทั้งกล่อง** ไม่งั้นกรองประเภทแล้วป้ายกระดิ่งจะเพี้ยน
  const unread = await col.countDocuments({ user: user.sub, read: false } as never)

  /**
   * นับที่ยังไม่อ่านแยกประเภท
   *
   * ทำเป็น loop countDocuments ทีละประเภทแทน `$group` ใน aggregation
   *   เพราะมีแค่ 4 ประเภท และทุกอันกิน index `user_unread_at` เท่ากัน
   *   อ่านง่ายกว่า และถ้าวันหนึ่งเพิ่มประเภท ก็แค่เพิ่มบรรทัดใน KINDS
   */
  const unreadByKind: Record<string, number> = {}
  for (const k of ['share', 'access', 'document', 'system'] as const) {
    unreadByKind[k] = await col.countDocuments({ user: user.sub, read: false, kind: k } as never)
  }

  return {
    items: items.map(toView),
    total,
    unread,
    unreadByKind,
  }
}

/** ทำเครื่องหมายว่าอ่านแล้ว — 1 ฉบับ */
export async function markRead(app: App, req: Req, id: string): Promise<void> {
  const user = who(req)
  const r = await app.mongo
    .collection<Notification>(NOTIFICATIONS)
    .updateOne({ _id: id, user: user.sub } as never, { $set: { read: true } } as never)
  // ผู้ใช้เรียก id ที่ไม่มี หรือเป็นของคนอื่น → ตอบเหมือนกันทั้งคู่
  // ไม่งั้นจะเป็นวิธีเดา id ของคนอื่นทีละอัน
  if (r.matchedCount === 0) throw new AppError('NOT_FOUND', 'ไม่เจอจดหมายฉบับนี้', 404)
}

/** ทำเครื่องหมายว่าอ่านแล้วทั้งหมด (หรือเฉพาะประเภทที่ระบุ) */
export async function markAllRead(app: App, req: Req, kind?: NotificationKind): Promise<number> {
  const user = who(req)
  const r = await app.mongo
    .collection<Notification>(NOTIFICATIONS)
    .updateMany(
      { user: user.sub, read: false, ...(kind ? { kind } : {}) } as never,
      { $set: { read: true } } as never,
    )
  return r.modifiedCount
}

/** ลบจดหมาย 1 ฉบับ */
export async function deleteNotification(app: App, req: Req, id: string): Promise<void> {
  const user = who(req)
  const r = await app.mongo
    .collection<Notification>(NOTIFICATIONS)
    .deleteOne({ _id: id, user: user.sub } as never)
  if (r.deletedCount === 0) throw new AppError('NOT_FOUND', 'ไม่เจอจดหมายฉบับนี้', 404)
}

/** ล้างกล่อง (ทั้งหมด หรือเฉพาะประเภท) — คืนจำนวนที่ลบ */
export async function clearInbox(app: App, req: Req, kind?: NotificationKind): Promise<number> {
  const user = who(req)
  const r = await app.mongo
    .collection<Notification>(NOTIFICATIONS)
    .deleteMany({ user: user.sub, ...(kind ? { kind } : {}) } as never)
  return r.deletedCount
}
