import type { FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod/v4'
import { env } from '@docgen/shared'
import type { App } from '../../types.js'
import { authorizeUrl, discovery, pkceChallenge, randomToken } from './oidc.js'
import { loginWithCode } from './verify.js'
import { claimPendingShares } from '../people/invite.js'
import { touchPerson } from '../people/directory.js'

/** cookie ชั่วคราวระหว่าง redirect ไป Casdoor แล้วกลับมา */
const STATE_COOKIE = 'oauth_state'
const VERIFIER_COOKIE = 'oauth_verifier'
const STATE_TTL = 600 // 10 นาที

/**
 * cookie ต้องเป็น Lax ไม่ใช่ Strict
 *
 * callback มาจากการ redirect ข้าม origin (Casdoor → API)
 * ถ้าเป็น Strict browser จะไม่ส่ง cookie ตอนกลับมา → ตรวจ state ไม่ผ่าน
 * แลกกับการเป็น Lax คือยังกัน CSRF ได้ เพราะเราเช็ค state อยู่แล้ว
 *
 * ⚠️ Lax ใช้ได้ตราบใดที่หน้าเว็บกับ API อยู่ same site
 *    (localhost:3000 → localhost:4001 หรือ ทั้งคู่บนโดเมนเดียวกัน)
 *    ถ้าข้าม site จริง ๆ (เช่น 127.0.0.1 ↔ localhost) ต้องเป็น
 *    SameSite=None + Secure ซึ่งบังคับใช้ https → ที่ localhost ไม่ได้
 */
const base = {
  httpOnly: true,
  sameSite: 'lax' as const,
  secure: env.SESSION_COOKIE_SECURE,
  path: '/',
}

export async function authRoutes(app: App) {
  const tags = ['auth']

  // GET /auth/login — เริ่ม flow ไปที่ Casdoor
  app.get(
    '/auth/login',
    {
      schema: {
        tags,
        summary: 'เริ่มล็อกอินผ่าน Casdoor',
        querystring: z.object({
          /** กลับไปที่นี่หลังล็อกอิน (ต้องอยู่ในรายการที่อนุญาต) */
          returnTo: z.string().optional(),
        }),
      },
    },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const d = await discovery(env.CASDOOR_ISSUER)

      const state = randomToken(24)
      const verifier = randomToken(48)

      reply.setCookie(STATE_COOKIE, state, { ...base, maxAge: STATE_TTL })
      reply.setCookie(VERIFIER_COOKIE, verifier, { ...base, maxAge: STATE_TTL })

      // เก็บปลายทางไว้ใน state เพื่อไม่ต้องรับ param ที่ client ควบคุมได้
      // format: <state>.<base64url(returnTo)>
      const returnTo = (req.query as { returnTo?: string }).returnTo
      const full = returnTo
        ? `${state}.${Buffer.from(returnTo).toString('base64url')}`
        : state

      reply.redirect(
        authorizeUrl({
          authorizationEndpoint: d.authorization_endpoint,
          clientId: env.CASDOOR_CLIENT_ID,
          redirectUri: env.CASDOOR_REDIRECT_URI,
          scopes: env.CASDOOR_SCOPES,
          state: full,
          codeChallenge: pkceChallenge(verifier),
        }),
        302,
      )
    },
  )

  // GET /auth/callback — Casdoorส่ง code กลับมา
  app.get(
    '/auth/callback',
    {
      schema: {
        tags,
        summary: 'Casdoor ส่ง code กลับมา',
        querystring: z.object({
          code: z.string().optional(),
          state: z.string().optional(),
          error: z.string().optional(),
          error_description: z.string().optional(),
        }),
      },
    },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const q = req.query as {
        code?: string
        state?: string
        error?: string
        error_description?: string
      }

      if (q.error) {
        app.log.warn({ err: q.error, desc: q.error_description }, 'Casdoor ปฏิเสธ')
        return reply.redirect(`${env.AUTH_SUCCESS_REDIRECT}?auth_error=${encodeURIComponent(q.error)}`, 302)
      }

      const expected = req.cookies[STATE_COOKIE]
      const verifier = req.cookies[VERIFIER_COOKIE]

      if (!expected || !verifier) {
        // บอกให้ชัดว่าขาดอะไร ไม่ใช่แค่บอกว่า "ผิด"
        // สาเหตุที่เจอบ่อยที่สุด: เริ่ม flow ที่ host อื่น (เช่น 127.0.0.1)
        // แล้ว Casdoor ส่งกลับมาที่ localhost → cookie คนละโดเมน ไม่ถูกส่ง
        const missing = [!expected && STATE_COOKIE, !verifier && VERIFIER_COOKIE]
          .filter(Boolean)
          .join(', ')

        app.log.warn(
          { missing, gotState: Boolean(q.state), gotCode: Boolean(q.code), host: req.headers.host },
          'callback ไม่มี cookie ของ flow — เริ่มใหม่ที่ /auth/login',
        )

        // พากลับไปเริ่มใหม่แทนที่จะทิ้งหน้า JSON ตาย
        return reply.redirect('/auth/login', 302)
      }

      if (!q.code || !q.state) {
        return reply.code(400).send({
          code: 'INVALID_CALLBACK',
          message: 'Casdoor ส่งข้อมูลกลับมาไม่ครบ',
        })
      }

      // state อาจมี .<base64url(returnTo)> ต่อท้าย
      const [stateToken, returnToRaw] = q.state.split('.')
      if (stateToken !== expected) {
        app.log.warn('state ไม่ตรง — ปฏิเสธ')
        return reply.code(400).send({
          code: 'INVALID_STATE',
          message: 'สถานะการเข้าสู่ระบบไม่ถูกต้อง (อาจเปิดหลายแท็บพร้อมกัน)',
        })
      }

      const user = await loginWithCode(q.code, verifier)

      // ใช้แล้วทิ้ง — กัน replay
      reply.clearCookie(STATE_COOKIE, { path: '/' })
      reply.clearCookie(VERIFIER_COOKIE, { path: '/' })

      const sid = await app.sessions.create(user)
      reply.setCookie(env.SESSION_COOKIE_NAME, sid, {
        ...base,
        maxAge: env.SESSION_TTL,
      })

      /**
       * จดลงสมุดที่อยู่ผู้ใช้ + ผูกคำเชิญแม่แบบ
       *
       * ⚠️ เขียนใหม่ทุกครั้งที่ล็อกอิน ไม่ใช่ครั้งแรก
       *   ผู้ใช้เปลี่ยนอีเมลที่ Casdoor ได้ ถ้าเก็บครั้งเดียวแล้วไม่แตะ
       *   รายชื่อจะชี้ไปยังที่เก่า → พิมพ์หาแล้วเจอคนที่เปลี่ยนไปแล้ว
       *   และถ้าเชิญด้วยอีเมล ไปเชิญคนผิด
       *
       * ⚠️ ห่อ try/catch เพราะล็อกอินสำเร็จแล้วต้องเข้าระบบได้เสมอ
       *   (Mongo ล่ม = ยังไม่มีในสมุดที่อยู่ แต่อย่างน้อยยังเข้าระบบได้)
       */
      try {
        await touchPerson(app, user)
        await claimPendingShares(app, user)
      } catch (err) {
        app.log.warn({ err, sub: user.sub }, 'บันทึกสมุดที่อยู่/ผูกคำเชิญไม่สำเร็จ — ข้ามไปก่อน')
      }
      app.log.info({ sub: user.sub, name: user.name }, 'ล็อกอินสำเร็จ')

      const dest = returnToRaw
        ? Buffer.from(returnToRaw, 'base64url').toString('utf8')
        : env.AUTH_SUCCESS_REDIRECT

      // กัน open redirect: ต้องเป็นปลายทางที่เรารู้จัก
      if (!isAllowedRedirect(dest)) {
        return reply.redirect(env.AUTH_SUCCESS_REDIRECT, 302)
      }

      return reply.redirect(dest, 302)
    },
  )

  // POST /auth/logout
  app.post(
    '/auth/logout',
    { schema: { tags, summary: 'ออกจากระบบ' } },
    async (req, reply) => {
      const sid = req.cookies[env.SESSION_COOKIE_NAME]
      await app.sessions.destroy(sid)
      reply.clearCookie(env.SESSION_COOKIE_NAME, { path: '/' })
      return reply.code(204).send(null)
    },
  )

  // GET /auth/me
  app.get(
    '/auth/me',
    { schema: { tags, summary: 'ข้อมูลผู้ใช้ปัจจุบัน' } },
    async (req, reply) => {
      if (!req.user) {
        return reply.code(401).send({ code: 'UNAUTHENTICATED', message: 'ยังไม่ได้เข้าสู่ระบบ' })
      }
      return { user: req.user }
    },
  )
}

/**
 * กัน open redirect
 * ยอมให้เฉพาะ URL ที่ลงทะเบียนไว้ (AUTH_SUCCESS_REDIRECT)
 * ถ้าไม่ตรงให้ fallback ไปที่นั้นแทน
 */
function isAllowedRedirect(dest: string): boolean {
  try {
    return new URL(dest).origin === new URL(env.AUTH_SUCCESS_REDIRECT).origin
  } catch {
    return false
  }
}
