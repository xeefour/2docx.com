import type { FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod/v4'
import { env, reportReceivers } from '@docgen/shared'
import type { App } from '../../types.js'
import { authorizeUrl, discovery, pkceChallenge, randomToken } from './oidc.js'
import { claimPendingInvites } from '../teams/service.js'
import { claimPendingShares } from '../people/invite.js'
import { touchPerson } from '../people/directory.js'
import { loginWithCode } from './verify.js'

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
       * ผูกสมาชิกที่ถูกเชิญด้วยอีเมลไว้ ให้กลายเป็นสมาชิกจริง
       *
       * ตอนเชิญเรารู้แค่อีเมล เพราะระบบไม่มีที่เก็บรายชื่อผู้ใช้
       * → คนที่ยังไม่เคยเข้าระบบจะถูกเก็บเป็นแถว "รอผูก" แล้วผูกตรงนี้
       *
       * ⚠️ ห่อ try/catch เพราะล็อกอินสำเร็จแล้ว ต้องไม่ให้เรื่องนี้ทำให้เข้าไม่ได้
       *   (Mongo ล่ม = ยังไม่ได้เข้าทีม แต่อย่างน้อยยังเข้าระบบได้)
       */
      try {
        await claimPendingInvites(app, user)
      } catch (err) {
        app.log.warn({ err, sub: user.sub }, 'ผูกสมาชิกที่รอเข้าระบบไม่สำเร็จ — ข้ามไปก่อน')
      }

      /**
       * จดลงสมุดที่อยู่ผู้ใช้ + ผูกคำเชิญแม่แบบ
       *
       * ⚠️ เขียนใหม่ทุกครั้งที่ล็อกอิน ไม่ใช่ครั้งแรก
       *   ผู้ใช้เปลี่ยนอีเมลที่ Casdoor ได้ ถ้าเก็บครั้งเดียวแล้วไม่แตะ
       *   รายชื่อจะชี้ไปยังที่เก่า → พิมพ์หาแล้วเจอคนที่เปลี่ยนไปแล้ว
       *   และถ้าเชิญด้วยอีเมล ไปเชิญคนผิด
       *
       * ⚠️ ห่อ try/catch เหมือนข้างบน — ล็อกอินสำเร็จแล้วต้องเข้าระบบได้เสมอ
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

  /** ทำลาย session ปัจจุบัน — ใช้ร่วมกันทั้ง GET และ POST */
  async function destroySession(req: FastifyRequest, reply: FastifyReply) {
    const sid = req.cookies[env.SESSION_COOKIE_NAME]
    await app.sessions.destroy(sid)
    reply.clearCookie(env.SESSION_COOKIE_NAME, { path: '/' })
  }

  // POST /auth/logout — สำหรับ client ที่ยิงด้วย fetch
  app.post(
    '/auth/logout',
    { schema: { tags, summary: 'ออกจากระบบ' } },
    async (req, reply) => {
      await destroySession(req, reply)
      return reply.code(204).send(null)
    },
  )

  /**
   * GET /auth/logout — ให้ปุ่ม "ออกจากระบบ" ที่เป็น <a href> ใช้ได้
   *
   * ⚠️ ทำไมต้องมี GET ทั้งที่ logout เป็นการเปลี่ยน state
   *   ปุ่มในเว็บเป็นลิงก์ธรรมดา 5 จุด (studio · account 2 จุด · teams · team detail)
   *   ลิงก์ยิง GET เสมอ แต่ route เดิมมีแค่ POST → กดแล้วได้ 404
   *   ทางแก้คือเพิ่ม GET ที่นี่จุดเดียว แทนการไปแก้ onClick ทั้ง 5 จุด
   *   ซึ่งเสี่ยงตกหล่นจุดใดจุดหนึ่งตอนเพิ่มหน้าใหม่ในอนาคต
   *
   * ⚠️ GET ที่เปลี่ยน state เปิดให้ CSRF ได้ (เช่น <img src="/auth/logout">)
   *   ผลกระทบจำกัดอยู่ที่ "ผู้ใช้ถูกบังคับออกจากระบบ" ซึ่งไม่ทำให้ข้อมูลรั่ว
   *   แลกกับปุ่มที่ใช้งานได้จริงทุกหน้า → ยอมรับได้
   *   ถ้าวันไหนอยากปิดช่องนี้ ต้องเปลี่ยนปุ่มในเว็บเป็น <form method="post"> ให้ครบทุกจุด
   */
  app.get(
    '/auth/logout',
    { schema: { tags, summary: 'ออกจากระบบ (จากลิงก์ในหน้าเว็บ)' } },
    async (req, reply) => {
      await destroySession(req, reply)
      // ต้อง redirect เสมอ ไม่งั้นผู้ใช้จะเจอหน้าว่างเปล่า ๆ หลังกดปุ่ม
      return reply.redirect('/', 302)
    },
  )

  // GET /auth/me — **ไม่มี prefix /api**
  //
  // ⚠️ `authRoutes` ลงทะเบียนโดยไม่มี prefix เพราะ `redirect_uri` ที่ลงทะเบียนไว้กับ Casdoor
  //   ต้องตรงเป๊ะ → ย้ายทั้งปลั๊กไปใต้ `/api` ไม่ได้ เพราะจะทำให้ callback path เปลี่ยน
  //
  //   ผลคือหน้าเว็บเรียกใช้ไม่ได้ผ่านตัวช่วย `call()` ที่เติม `/api` ให้เสมอ
  //   → ด้านล่างมี `GET /api/session` เป็นทางเดียวกันสำหรับหน้าเว็บ
  app.get(
    '/auth/me',
    {
      schema: {
        tags,
        summary: 'ข้อมูลผู้ใช้ปัจจุบัน',
        description: [
          'เบา พอจะให้ทุกหน้ายิงเรียกเมื่อ mount',
          '',
          '⚠️ path นี้**ไม่มี prefix /api** เพราะ Casdoor ต้องตรงกับ `redirect_uri`',
          '   หน้าเว็บที่อยู่ใต้ `/api` ให้เรียก `GET /api/session` แทน (ค่าเหมือนกัน)',
        ].join('\n'),
      },
    },
    meHandler(app),
  )
}

/**
 * ตัวจัดการ `/auth/me` และ `/api/session` — **ตัวเดียวกัน**
 *
 * ⚠️ ต้องอ่าน session เอง ไม่ใช่ใช้ `req.user`
 *   `authRoutes` ลงทะเบียน**ก่อน** `addHook('onRequest')` ที่เป็นตัวเติม `req.user`
 *   (hook อยู่ในไฟล์ app.ts) → ทุก route ในไฟล์นี้จะได้ `req.user = undefined`
 *   เจอเพราะปุ่ม "รายงานปัญหา" ถามสิทธิ์จากที่นี่แล้วได้ 401 ทุกคน
 *
 *   ข้อสังเกต: ถ้าเมื่อไหร่ route ในปลั๊กนี้เริ่มได้ `req.user` จริง
 *   แปลว่า hook ถูกย้ายมาก่อนบล็อกนี้แล้ว → โค้ดนี้ซ้ำซ้อนแต่ยังถูก
 */
function meHandler(app: App) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const sid = req.cookies[env.SESSION_COOKIE_NAME]
    const user = sid ? await app.sessions.get(sid) : null
    if (!user) {
      return reply.code(401).send({ code: 'UNAUTHENTICATED', message: 'ยังไม่ได้เข้าสู่ระบบ' })
    }
    return {
      user,
      /** ผู้รับรายงานปัญหาไหม (อยู่ใน `REPORT_TO_SUBS`) — ให้หน้าเว็บตัดสินว่าจะโผล่ปุ่มตรงไหน */
      canReceiveReports: reportReceivers().includes(user.sub),
    }
  }
}

/** `/api/session` — ทางเดียวกันข้างบน แต่อยู่ใต้ `/api` ให้หน้าเว็บเรียกผ่าน `call()` ได้ */
export async function sessionRoutes(app: App) {
  app.get(
    '/session',
    {
      schema: {
        tags: ['auth'],
        summary: 'ข้อมูลผู้ใช้ปัจจุบัน (สำหรับหน้าเว็บ)',
        description: [
          'ค่าเดียวกับ `GET /auth/me` — ตัวนี้อยู่ใต้ `/api` จึงเรียกจากหน้าเว็บได้',
          '',
          'หน้าเว็บยิงตอน mount ครั้งเดียว แล้วใช้ค่าตัดสินทุกที่',
          '(`canReceiveReports` = คนนี้ได้รับรายงานปัญหาไหม)',
        ].join('\n'),
      },
    },
    meHandler(app),
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
