import { newId, now } from '@docgen/shared'
import type { Db } from 'mongodb'

/**
 * ── เขียนจดหมายเข้ากล่องผู้ใช้ จากฝั่ง worker ──────────────────────────
 *
 * ผู้ใช้สั่ง: *"จากระบบที่เตือนต่าง ๆ เวลามีอะไรที่เกี่ยวข้องให้แจ้งเตือนเข้าไปในกล่องนี้"*
 *   งานเอกสารที่เรนเดอร์เสร็จ/ล้มเหลวเป็นหนึ่งในนั้น
 *   เพราะตอนนี้ผู้ใช้ต้อง**เฝ้าหน้าเว็บ**ถึงจะรู้ว่างานเสร็จ
 *
 * ⚠️ ทำซ้ำฝั่ง API (`apps/api/src/modules/studio/notifications.ts`) เพราะสองโปรเจกต์นี้
 *   import กันได้แค่ผ่าน `@docgen/shared` — worker ห้าม import จาก apps/api
 *   รูปแบบ doc จึงต้องตรงกับ Zod schema `Notification` ใน shared เสมอ
 *   (ถ้าเปลี่ยนฝั่งใดฝั่งหนึ่ง อีกฝั่งจะเขียน doc ไม่ผ่าน response schema ของ Fastify)
 */
export async function notifyUser(
  db: Db,
  input: {
    /**
     * null/undefined = เอกสารเก่าที่ไม่มี createdBy หรือเอกสารถูกลบไปแล้ว
     * → ไม่มีใครจะได้รับ ไม่ต้องเขียน (undefined ไม่ต้องแยกจาก null ที่นี่)
     */
    user: string | null | undefined
    kind: 'share' | 'access' | 'document' | 'system'
    title: string
    body: string
    link?: string | null
    templateName?: string | null
  },
  log?: (msg: string, meta?: Record<string, unknown>) => void,
): Promise<boolean> {
  if (!input.user) return false
  try {
    // ไม่มี generic type ให้ใส่ (worker ไม่ได้ import schema ของ notifications)
    // → collection() จะเดาเป็น Document ซึ่งมี _id เป็น ObjectId แล้ว insertOne จะ error
    //   ใส่ generic กว้าง ๆ แล้ว cast ตอน insert แทน (รูปแบบเดียวกับฝั่ง API)
    await db.collection<Record<string, unknown>>('notifications').insertOne({
      _id: newId('ntf'),
      user: input.user,
      kind: input.kind,
      title: input.title.slice(0, 200),
      body: input.body.slice(0, 500),
      link: input.link ?? null,
      templateName: input.templateName?.slice(0, 200) ?? null,
      read: false,
      at: now(),
    } as never)
    return true
  } catch (err) {
    /**
     * ⚠️ กลืน error เสมอ
     *   จดหมายล้มเหลวห้ามทำให้งานเรนเดอร์ที่**สำเร็จแล้ว**กลายเป็นล้มเหลว
     *   (ผู้ใช้ควรได้ไฟล์ ไม่ใช่มาเจอ error เพราะระบบแจ้งเตือนพัง)
     */
    log?.('เขียนจดหมายลงกล่องไม่สำเร็จ (งานเอกสารไม่ถูกกระทบ)', { error: String(err) })
    return false
  }
}
