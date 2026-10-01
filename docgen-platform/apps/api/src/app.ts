import Fastify, { type FastifyInstance } from 'fastify'
import {
  validatorCompiler,
  serializerCompiler,
  ZodTypeProvider,
  jsonSchemaTransform,
} from '@fastify/type-provider-zod'
import cors from '@fastify/cors'
import cookie from '@fastify/cookie'
import multipart from '@fastify/multipart'
import helmet from '@fastify/helmet'
import rateLimit from '@fastify/rate-limit'
import swagger from '@fastify/swagger'
import swaggerUi from '@fastify/swagger-ui'

import { env, corsOrigins, AppError } from '@docgen/shared'
import { mongoPlugin } from './plugins/mongo.js'
import { valkeyPlugin } from './plugins/valkey.js'
import { natsPlugin } from './plugins/nats.js'
import { s3Plugin } from './plugins/s3.js'
import { documentRoutes } from './modules/documents/route.js'
import { templateRoutes } from './modules/templates/route.js'
import { studioRoutes } from './modules/studio/route.js'
import { healthRoutes } from './modules/health/route.js'
import { authRoutes } from './modules/auth/route.js'
import { sessionPlugin } from './modules/auth/session.js'

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: env.LOG_LEVEL },
    // ปิดไว้เฉย ๆ ไม่งั้นอ่าน request body ไม่ได้ตอนอยู่หลัง proxy
    trustProxy: true,
  }).withTypeProvider<ZodTypeProvider>()

  // ⚠️ สองบรรทัดนี้คือหัวใจ — ไม่ตั้ง Zod จะไม่ validate อะไรเลย
  // Fastify default เป็น Ajv + JSON Schema
  app.setValidatorCompiler(validatorCompiler)
  app.setSerializerCompiler(serializerCompiler)

  // cookie ต้องอ่านได้ก่อน hook ที่จะเอาไปหา session
  // ลำดับสำคัญ: multipart ต้องมาก่อน route ที่จะอ่านไฟล์
  await app.register(cookie)
  await app.register(multipart, {
    limits: { fileSize: 20 * 1024 * 1024, files: 1 },
  })

  await app.register(helmet, { contentSecurityPolicy: false })
  // credentials: true = ให้ browser ส่ง cookie ข้าม origin (หน้าเว็บ → API)
  await app.register(cors, { origin: corsOrigins, credentials: true })
  /**
   * จำกัดจำนวน request ต่อ IP
   *
   * ⚠️ ค่าเดิม 100/นาที น้อยเกินไปสำหรับ Studio — เปิดหน้าเดียวยิงราว 6 request
   *   ผู้ใช้ที่รีเฟรชสัก 5 ครั้งก็โดน 429 ทั้งที่ไม่ได้ทำอะไรผิด
   *   ตอนนี้อ่านจาก env (RATE_LIMIT_MAX / RATE_LIMIT_WINDOW_MS) ตั้งเป็น 0 เพื่อปิด
   *
   * `/api/health` อยู่ใน allowList — เป็น endpoint ที่ระบบตรวจสุขภาพภายนอกเรียกซ้ำ
   *   ถ้านับรวม การมี monitor วิ่งอยู่สักตัวก็กินโควตาของผู้ใช้จนได้ 429
   */
  if (env.RATE_LIMIT_MAX > 0) {
    await app.register(rateLimit, {
      max: env.RATE_LIMIT_MAX,
      timeWindow: env.RATE_LIMIT_WINDOW_MS,
      // ⚠️ ใน @fastify/rate-limit v11 `allowList` อยู่ระดับบนสุด ไม่ใช่ใน `config`
      //   และรับเป็นฟังก์ชัน (req, key) ได้
      allowList: (req) => req.url.startsWith('/api/health') || req.url === '/health',
      addHeaders: { 'x-ratelimit-limit': true, 'x-ratelimit-remaining': true, 'retry-after': true },
    })
  } else {
    app.log.warn('ปิด rate limit (RATE_LIMIT_MAX = 0) — เหมาะกับเครื่องใน tailnet ส่วนตัวเท่านั้น')
  }
  await app.register(swagger, {
    openapi: {
      info: { title: 'Docgen API', version: '0.1.0' },
    },
    // แปลง zod → JSON Schema ให้เอกสาร OpenAPI ใช้
    transform: jsonSchemaTransform,
  })

  // ── error handler ────────────────────────────────────────────
  app.setErrorHandler((err: unknown, req, reply) => {
    if (err instanceof AppError) {
      return reply.code(err.statusCode).send({
        code: err.code,
        message: err.message,
        details: err.details,
      })
    }

    // Zod validation error — แปลงเป็น 422 ที่อ่านรู้เรื่อง
    const e = err as { validation?: unknown; statusCode?: number; message?: string }

    if (e.validation) {
      req.log.info({ err: e.message }, 'validation ไม่ผ่าน')
      return reply.code(422).send({
        code: 'VALIDATION_FAILED',
        message: 'ข้อมูลที่ส่งมาไม่ถูกต้อง',
        details: e.validation,
      })
    }

    if (e.statusCode === 429) {
      return reply.code(429).send({
        code: 'RATE_LIMITED',
        message: 'ยิงบ่อยเกินไป ลองอีกครั้งในอีกสักครู่',
      })
    }

    // ⚠️ อย่าส่ง e.message ของ 500 ออกไปข้างนอก
    // อาจมีข้อมูลการเชื่อมต่อ (connection string, path) ผสมอยู่
    req.log.error({ err }, 'เกิดข้อผิดพลาดที่ไม่คาดคิด')
    return reply.code(500).send({
      code: 'INTERNAL_ERROR',
      message: 'เกิดข้อผิดพลาดภายในระบบ',
    })
  })

  // ── plugins ที่ต้องต่อก่อน route ───────────────────────────
  // ลำดับสำคัญ: sessionPlugin ต้องมาหลัง valkeyPlugin เพราะเก็บ session ลง Valkey
  await app.register(mongoPlugin)
  await app.register(valkeyPlugin)
  await app.register(natsPlugin)
  await app.register(s3Plugin)
  await app.register(sessionPlugin)

  // ── routes ─────────────────────────────────────────────────
  /**
   * liveness ของ process เอง — ไม่แตะ service อื่นเลย
   * ไว้ให้ Docker healthcheck กับ load balancer เรียก (ต้องเร็วและไม่มี dependency)
   * ดูสถานะ service ทั้งหมดที่ `/api/health` แทน
   */
  app.get('/health', { schema: { hide: true } }, async () => ({
    status: 'ok',
    uptime: Math.round(process.uptime()),
  }))

  // spec เป็น JSON — เอาไป generate client หรือยิงด้วย Postman ได้
  app.get('/openapi.json', { schema: { hide: true } }, async () => app.swagger())

  // UI สำหรับลองยิง API ด้วยมือ
  await app.register(swaggerUi, {
    routePrefix: '/docs',
    uiConfig: { docExpansion: 'list', deepLinking: true },
    staticCSP: true,
  })

  await app.register(
    async (api) => {
      await api.register(documentRoutes)
      await api.register(templateRoutes)
      await api.register(studioRoutes)
      await api.register(healthRoutes)
    },
    { prefix: '/api' },
  )

  // ── auth ───────────────────────────────────────────────────
  // ไม่ใส่ prefix เพราะ redirect_uri ที่ลงทะเบียนใน Casdoor
  // ต้องตรงกับ CASDOOR_REDIRECT_URI เป๊ะ
  await app.register(authRoutes)

  // ── บังคับล็อกอิน ────────────────────────────────────────────
  // เป็น allowlist แบบตรงไปตรงมา ไม่ใช่ blacklist
  // เพิ่ม route ใหม่แล้วลืมเพิ่มในนี้ = เข้าได้โดยไม่ต้องล็อกอิน
  //
  // ⚠️ /api/health อยู่ในนี้โดยเจตนา — load balancer กับ Docker healthcheck
  //    เรียกโดยไม่มี session ถ้าบังคับ login ระบบจะถูกทำให้ unhealthy
  //    ข้อมูลที่เปิดเผยมีแค่ชื่อ service + up/down + latency ไม่มี credential
  const PUBLIC = new Set([
    '/health',
    '/api/health',
    '/openapi.json',
    '/auth/login',
    '/auth/callback',
    '/auth/logout',
  ])

  app.addHook('onRequest', async (req, reply) => {
    const path = req.url.split('?')[0] ?? req.url
    if (PUBLIC.has(path)) return
    if (path.startsWith('/docs')) return // swagger UI โหลด static หลายไฟล์

    const sid = req.cookies[env.SESSION_COOKIE_NAME]
    const user = await app.sessions.get(sid)
    req.user = user

    if (!user) {
      return reply.code(401).send({
        code: 'UNAUTHENTICATED',
        message: 'ยังไม่ได้เข้าสู่ระบบ',
        loginUrl: `${env.CASDOOR_ISSUER.replace(/\/$/, '')}`,
      })
    }
  })

  return app
}
