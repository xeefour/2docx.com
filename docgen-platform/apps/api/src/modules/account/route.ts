/**
 * `/api/account` — ข้อมูลที่หน้า `/account` ใช้ทั้งหมด
 *
 * ⚠️ ไม่ต้องลงทะเบียนใน `PUBLIC` ที่ `app.ts` — ต้องมี session เสมอ
 *   (hook จะตอบ 401 ให้ก่อนถึง handler อยู่แล้ว)
 */
import { z } from 'zod/v4'
import {
  AccountSummary,
  AvatarView,
  ErrorResponse,
  UpdateSettingsBody,
  UserSettingsView,
} from '@docgen/shared'
import type { App } from '../../types.js'
import { getAccount, getSettings, saveSettings, setAvatar, getAvatar, removeAvatar } from './service.js'

const tags = ['account']

export async function accountRoutes(app: App) {
  /**
   * ข้อมูลทั้งหมดของหน้า `/account` ในคำขอเดียว
   *
   * โปรไฟล์ + สถิติ 5 ตัว + ค่าตั้งค่า
   * ถ้าแยกเป็นหลาย endpoint หน้าเว็บต้องยิง 4–5 รอบแล้วเอามาประกอบกันเอง
   */
  app.get(
    '/account',
    {
      schema: {
        tags,
        summary: 'ข้อมูลบัญชีผู้ใช้ปัจจุบัน (โปรไฟล์ + สถิติ + ค่าตั้งค่า)',
        description: [
          'ข้อมูลประจำตัวมาจาก Casdoor ผ่าน session — แก้ที่ Casdoor เท่านั้น',
          'docgen ไม่เก็บชื่อ/อีเมลซ้ำสองที่',
          '',
          'สถิตินับสดจาก collection ของแต่ละฟีเจอร์ ไม่มีตัวเลขสรุปที่ค้าง',
        ].join('\n'),
        response: { 200: AccountSummary, 401: ErrorResponse },
      },
    },
    async (req) => getAccount(app, req),
  )

  /** อ่านค่าตั้งค่าอย่างเดียว — ไว้ให้ฝั่งอื่นที่แค่ต้องการค่าเริ่มต้น ไม่ต้องนับสถิติให้เปลือง */
  app.get(
    '/account/settings',
    {
      schema: {
        tags,
        summary: 'ค่าตั้งค่าของผู้ใช้',
        response: { 200: UserSettingsView, 401: ErrorResponse },
      },
    },
    async (req) => {
      const u = req.user
      return getSettings(app, u?.sub ?? '')
    },
  )

  /**
   * แก้ค่าตั้งค่า — merge ทับของเดิม ส่งมาเฉพาะที่อยากเปลี่ยนก็ได้
   *
   * ใช้ `PUT` ไม่ใช่ `PATCH` เพราะผลคือทั้งชุด (partial อยู่ที่ body แล้ว)
   * แต่เรียง merge ให้อยู่ใน service เพราะถ้าเรียกจากที่อื่นต้องได้ผลเหมือนกัน
   */
  app.put(
    '/account/settings',
    {
      schema: {
        tags,
        summary: 'แก้ค่าตั้งค่าของผู้ใช้',
        body: UpdateSettingsBody,
        // 422 ไม่ใช่ 400 — error handler กลางแปลง Zod error เป็น 422 ที่ `app.ts:96`
        response: { 200: UserSettingsView, 422: ErrorResponse, 401: ErrorResponse },
      },
    },
    async (req, reply) => {
      const u = req.user
      if (!u?.sub) {
        return reply.code(401).send({ code: 'AUTH_REQUIRED', message: 'ยังไม่ได้เข้าสู่ระบบ' })
      }
      return saveSettings(app, u.sub, req.body)
    },
  )

  // ── รูปโปรไฟล์ ─────────────────────────────────────────────

  /**
   * อัปโหลดรูปโปรไฟล์
   *
   * รูปที่อัปโหลดที่นี่เป็น**ของเฉพาะระบบเรา** ไม่ได้แก้รูปที่ Casdoor
   * (เราแก้ชื่อ/อีเมลที่นั่นไม่ได้ ก็แก้รูปไม่ได้เช่นกัน — ตั้งใจให้เป็นเรื่องคนละฝั่ง)
   */
  app.put(
    '/account/avatar',
    {
      schema: {
        tags,
        summary: 'อัปโหลดรูปโปรไฟล์',
        description: [
          'รับเฉพาะ `multipart/form-data` ฟิลด์ชื่อ `avatar`',
          '',
          '⚠️ ตรวจชนิดจาก**ไบต์จริง** (magic bytes) ไม่เชื่อ `Content-Type` ที่ client ส่งมา',
          '   เพราะไฟล์นี้จะถูกส่งกลับมาแสดงบนโดเมนเรา (ถ้าเชื่อ mimetype จะเป็น stored XSS)',
          '· สูงสุด 2 MB',
          '· รองรับ PNG, JPEG, WebP',
        ].join('\n'),
        response: { 200: AvatarView, 400: ErrorResponse, 401: ErrorResponse },
      },
    },
    async (req, reply) => {
      const u = req.user
      if (!u?.sub) {
        return reply.code(401).send({ code: 'AUTH_REQUIRED', message: 'ยังไม่ได้เข้าสู่ระบบ' })
      }

      const file = await req.file()
      if (!file) {
        return reply.code(400).send({ code: 'NO_FILE', message: 'ไม่พบไฟล์รูป' })
      }
      // field ชื่อไม่ถูกต้อง = ผู้เรียกส่งผิดรูปแบบ ไม่ใช่ปัญหาความปลอดภัย
      if (file.fieldname !== 'avatar') {
        return reply.code(400).send({ code: 'BAD_FIELD', message: 'ต้องส่งไฟล์ในฟิลด์ชื่อ avatar' })
      }

      const { key } = await setAvatar(app, u.sub, await file.toBuffer())
      return { hasCustomAvatar: true }
    },
  )

  /**
   * ดึงรูปโปรไฟล์
   *
   * ⚠️ ไม่ใส่ `response` schema — Zod serializer จะพยายาม parse Buffer เป็น JSON
   *    route ที่ตอบไฟล์ต้องปล่อยให้ Fastify ส่ง Buffer ผ่านตรง ๆ
   *    (ทำแบบเดียวกับ `GET /api/templates/:id/previews/:pid/file`)
   *
   * คืน 404 เมื่อยังไม่มีรูป เพื่อให้หน้าเว็บ fallback ไปใช้รูปจาก Casdoor
   */
  app.get(
    '/account/avatar',
    {
      schema: {
        tags,
        summary: 'รูปโปรไฟล์ที่อัปโหลดเอง',
      },
    },
    async (req, reply) => {
      const u = req.user
      if (!u?.sub) {
        return reply.code(401).send({ code: 'AUTH_REQUIRED', message: 'ยังไม่ได้เข้าสู่ระบบ' })
      }

      const found = await getAvatar(app, u.sub)
      if (!found) {
        return reply.code(404).send({ code: 'NO_AVATAR', message: 'ยังไม่มีรูปโปรไฟล์' })
      }

      return reply
        .header('content-type', found.contentType)
        .header('content-length', String(found.body.length))
        /**
         * `no-store` ไม่ใช่ `private, max-age=…`
         *   รูปโปรไฟล์เปลี่ยนได้ตลอด และ URL เดิมต้องชี้ของใหม่ทันที
         *   ถ้า cache ไว้ ผู้ใช้จะเห็นรูปเก่าหลังเปลี่ยน (เจอจริงตอนทดสอบ)
         *   → เสีย cache แล้วบังคับให้เบราว์เซอร์โหลดใหม่
         */
        .header('cache-control', 'no-store')
        .send(found.body)
    },
  )

  /** ลบรูปที่อัปโหลดเอง — กลับไปใช้รูปจาก Casdoor */
  app.delete(
    '/account/avatar',
    {
      schema: {
        tags,
        summary: 'ลบรูปโปรไฟล์ที่อัปโหลดเอง',
        response: { 200: AvatarView, 401: ErrorResponse },
      },
    },
    async (req, reply) => {
      const u = req.user
      if (!u?.sub) {
        return reply.code(401).send({ code: 'AUTH_REQUIRED', message: 'ยังไม่ได้เข้าสู่ระบบ' })
      }
      return { hasCustomAvatar: !(await removeAvatar(app, u.sub)) }
    },
  )
}
