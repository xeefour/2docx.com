import type { FastifyInstance } from 'fastify'
import fp from 'fastify-plugin'
import { env } from '@docgen/shared'
import { randomToken } from './oidc.js'
import type { SessionUser } from './oidc.js'

declare module 'fastify' {
  interface FastifyInstance {
    sessions: {
      create(user: SessionUser): Promise<string>
      get(sid: string | undefined): Promise<SessionUser | null>
      destroy(sid: string | undefined): Promise<void>
    }
  }
  interface FastifyRequest {
    /** ผู้ใช้ที่ล็อกอินแล้ว — null ถ้ายังไม่ล็อกอิน */
    user: SessionUser | null
  }
}

const KEY = 'session:'

/**
 * เก็บ session ไว้ใน Valkey
 *
 * ทำไมไม่เก็บ JWT เอง: โดย default verify ทุก request = ยิง JWKS
 * และถ้า user ถูกลบ/ระงับจาก Casdoor token ที่ออกไปแล้วยังใช้ได้อยู่
 * session server-side จึง revoke ได้ทันที (logout = ลบ key ทิ้ง)
 */
export const sessionPlugin = fp(async (app) => {
  const redis = app.cache

  app.decorateRequest('user', null)

  app.decorate('sessions', {
    async create(user) {
      const sid = randomToken(32)
      await redis.set(KEY + sid, JSON.stringify(user), 'EX', env.SESSION_TTL)
      return sid
    },

    // รับ undefined ได้เพราะ cookie อาจไม่มีอยู่เลยตอนที่ยังไม่ล็อกอิน
    async get(sid: string | undefined) {
      if (!sid) return null
      const raw = await redis.get(KEY + sid)
      if (!raw) return null
      try {
        return JSON.parse(raw) as SessionUser
      } catch {
        // ข้อมูลเสีย = ถือว่า session ใช้ไม่ได้
        return null
      }
    },

    async destroy(sid: string | undefined) {
      if (sid) await redis.del(KEY + sid)
    },
  })

  app.log.info({ ttl: env.SESSION_TTL }, 'พร้อมรับ session')
})
