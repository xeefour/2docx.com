import { z } from 'zod/v4'
import type { App } from '../../types.js'
import {
  ErrorResponse,
  InviteBody,
  InviteResponse,
  PeopleQuery,
  PeopleSearchResponse,
  PendingShareList,
} from '@docgen/shared'
import type { SessionUser } from '../auth/oidc.js'
import { searchPeople, PEOPLE_MIN_QUERY } from './directory.js'
import { cancelPendingShare, inviteByEmail, listPendingShares } from './invite.js'
import { mailReady, logMailStatus } from './mail.js'

/**
 * ── เส้นทางสมุดที่อยู่ผู้ใช้ + การเชิญด้วยอีเมล ─────────────────────
 *
 * ⚠️ เส้นทาง `/access/...` อยู่ในโมดูลนี้ ไม่ใช่ `modules/studio/route.ts`
 *   เพราะเป็นฟีเจอร์คนละเรื่องกับการแก้สิทธิ์ตามปกติ
 *   Fastify ไม่สนว่า path ถูกประกาศในไฟล์ไหน ขอแค่ไม่ชนกัน
 *   ข้อดีคือแก้ที่นี่ได้โดยไม่ต้องไปยุ่งกับโค้ดชุดอื่น
 */

export async function peopleRoutes(app: App) {
  const tags = ['people']

  /**
   * บอกตอนบูตว่าส่งอีเมลได้หรือไม่
   *
   * ⚠️ ทำตอน register route เพราะจุดนี้คือช่วงที่ plugin พร้อมหมดแล้ว
   *   (route ถูก register หลัง mongo/valkey/nats/s3 ตามลำดับใน app.ts)
   *   ถ้าไม่บอกตอนบูต จะไม่มีใครรู้ว่าตั้ง SMTP ผิดจนกว่าจะเชิญคนจริง
   */
  logMailStatus(app)

  /**
   * ค้นผู้ใช้ที่เคยเข้าระบบ เพื่อเติมในช่อง "อนุญาตให้ใครใช้ได้"
   *
   * ⚠️ ค้นได้ตั้งแต่ 3 ตัวอักษร (`PEOPLE_MIN_QUERY`)
   *   ถ้าให้ค้นตัวเดียว จะได้รายชื่อทั้งระบบกลับไปทั้งก้อน
   *   ซึ่งทั้งช้าและไม่มีประโยชน์กับผู้ใช้
   */
  app.get(
    '/people',
    {
      schema: {
        tags,
        summary: 'ค้นผู้ใช้ที่เคยเข้าระบบ (สำหรับเติมช่องแชร์)',
        querystring: z.object({ q: PeopleQuery }),
        response: { 200: PeopleSearchResponse, 401: ErrorResponse },
      },
    },
    async (req) => {
      const user = req.user as SessionUser
      const q = (req.query as { q: string }).q.trim()
      if (q.length < PEOPLE_MIN_QUERY) {
        return { items: [], mailReady: mailReady() }
      }
      return { items: await searchPeople(app, user, q), mailReady: mailReady() }
    },
  )

  /** คำเชิญที่ยังรอผู้รับเข้าระบบ — เจ้าของดูเพื่อยกเลิกได้ */
  app.get(
    '/access/:key/invites',
    {
      schema: {
        tags,
        summary: 'คำเชิญที่ยังไม่ได้เข้าระบบ',
        params: z.object({ key: z.string().min(1).max(200) }),
        response: { 200: PendingShareList, 401: ErrorResponse },
      },
    },
    async (req) => ({
      items: await listPendingShares(app, (req.params as { key: string }).key),
    }),
  )

  /**
   * เชิญด้วยอีเมล — ทางเดียวที่แชร์ให้คนที่ยังไม่เคยเข้าระบบได้
   *
   * ⚠️ ตอบ 200 แม้ส่งเมลไม่สำเร็จ เพราะ**สิทธิ์ถูกบันทึกไว้แล้ว**
   *   คนที่ถูกเชิญจะได้สิทธิ์ตอนเข้าสู่ระบบครั้งแรกอยู่ดี
   *   ถ้าตอบ 500 ผู้ใช้จะกดเชิญซ้ำจนได้สิทธิ์ซ้ำโดยไม่รู้ตัว
   *   → ส่ง `emailed: false` + เหตุผลกลับไปให้หน้าเว็บพูดตรง ๆ
   */
  app.post(
    '/access/:key/invite',
    {
      schema: {
        tags,
        summary: 'เชิญเข้าใช้แม่แบบด้วยอีเมล (สำหรับคนที่ยังไม่เคยเข้าระบบ)',
        description: [
          'ระบบรู้จักผู้ใช้จาก `sub` ของ Casdoor เท่านั้น',
          'คนที่ยังไม่เคยเข้าระบบจึงยังไม่มี `sub` → ต้องเชิญด้วยอีเมล',
          '',
          'สิทธิ์จะถูกผูกให้อัตโนมัติตอนเขาเข้าสู่ระบบครั้งแรกด้วยอีเมลนั้น',
        ].join('\n'),
        params: z.object({ key: z.string().min(1).max(200) }),
        body: InviteBody,
        response: { 200: InviteResponse, 401: ErrorResponse, 403: ErrorResponse, 500: ErrorResponse },
      },
    },
    async (req) => {
      const p = req.params as { key: string }
      const b = req.body as { email: string; role: 'viewer' | 'editor' }
      return inviteByEmail(app, { templateKey: p.key, email: b.email, role: b.role }, req)
    },
  )

  /** ยกเลิกคำเชิญที่ยังไม่ผูก */
  app.delete(
    '/access/:key/invite/:email',
    {
      schema: {
        tags,
        summary: 'ยกเลิกคำเชิญที่ยังไม่ได้เข้าระบบ',
        params: z.object({
          key: z.string().min(1).max(200),
          email: z.string().min(1).max(200),
        }),
        response: { 200: z.object({ cancelled: z.boolean() }), 401: ErrorResponse, 403: ErrorResponse },
      },
    },
    async (req) => {
      const p = req.params as { key: string; email: string }
      return {
        cancelled: await cancelPendingShare(app, { templateKey: p.key, email: p.email }, req),
      }
    },
  )
}
