/**
 * `/api/reports` — ส่งและอ่านรายงานปัญหา
 *
 * ⚠️ ไม่ต้องลงทะเบียนใน `PUBLIC` ที่ `app.ts` — ต้องมี session เสมอ
 *   (hook จะตอบ 401 ให้ก่อนถึง handler อยู่แล้ว)
 *
 * ⚠️ `POST /reports` ใช้ `multipart/form-data` จึง**ไม่ใส่ `body:` schema**
 *   ถ้าใส่ schema ของ JSON Fastify จะพยายาม parse multipart เป็น JSON แล้วพังตอน runtime
 *   การตรวจ field ทำใน service แทน (ดู `createReport`) เพราะต้องอ่านไฟล์ควบคู่กัน
 */
import { z } from 'zod/v4'
import {
  CreateReportView,
  ErrorResponse,
  IssueReport,
  IssueReportList,
  ReportProblemBody,
  UpdateReportBody,
  ValidationError,
} from '@docgen/shared'
import type { App } from '../../types.js'
import { who } from '../studio/service.js'
import {
  checkShot,
  createReport,
  deleteReport,
  getReportShot,
  listReports,
  setReportStatus,
} from './service.js'

const tags = ['reports']

/**
 * ⚠️ ทุก `response:` ต้องเป็น **Zod schema** ไม่ใช่ JSON Schema ดิบ
 *   เพราะใช้ `@fastify/type-provider-zod` (ดูคอมเมนต์ใน `CreateReportView`)
 *   เคยเขียน JSON Schema ดิบตรงนี้ → API ตอบ 500 **หลัง**บันทึกรายงานและส่งกระดิ่งเสร็จ
 */
export async function reportRoutes(app: App) {
  /**
   * ส่งรายงานปัญหา — ผู้ใช้ที่ล็อกอินทุกคนส่งได้
   *
   * รับเป็น multipart เพราะต้องแนบภาพหน้าจอพร้อมกัน
   * (ส่ง JSON แล้วค่อยอัปโหลดรูปทีหลัง = สองคำขอที่ต้องเก็บให้เข้าคู่กัน
   *  ถ้าคำขอที่สองล้ม จะเหลือรายงานที่บอกว่าเจอปัญหาอะไรแต่ไม่มีหน้าจอให้ดู)
   */
  app.post(
    '/reports',
    {
      schema: {
        tags,
        summary: 'ส่งรายงานปัญหาพร้อมภาพหน้าจอ',
        description: [
          'รับเฉพาะ `multipart/form-data`',
          '',
          'ฟิลด์ข้อความ (ไม่บังคับ): `summary` `details` `pageUrl` `diagnostics`',
          'ฟิลด์ไฟล์ (ไม่บังคับ): `shot` — PNG / JPEG / WebP สูงสุด 8 MB',
          '',
          '⚠️ ตรวจชนิดภาพจาก**ไบต์จริง** (magic bytes) ไม่เชื่อ `Content-Type` ที่ client ส่งมา',
          '   เพราะภาพนี้จะถูกส่งกลับมาแสดงบนโดเมนเรา',
          '',
          'ส่งได้ทุกคนที่ล็อกอิน ไม่ต้องอยู่ใน `REPORT_TO_SUBS`',
        ].join('\n'),
        response: {
          200: CreateReportView,
          400: ErrorResponse,
          401: ErrorResponse,
          422: ErrorResponse,
        },
      },
    },
    async (req) => {
      const who_ = who(req)

      const fields: Record<string, string> = {}
      let shot: { buffer: Buffer; contentType: string } | null = null

      /**
       * ⚠️ ต้องไล่ `parts()` ให้**ครบ loop** แม้เจอไฟล์แล้ว
       *   เพราะ `@fastify/multipart` จะไม่ปล่อย part ถัดไปมาให้จนกว่าจะเรียกไฟล์ปัจจุบันให้ครบ
       *   ถ้า `break` ทันทีที่เจอรูป ฟิลด์ที่อยู่**หลัง**รูปจะหายไปเงียบ ๆ
       *   (และไฟล์ไม่ถูก drain ทิ้ง → คำขอถัดไปของ connection เพี้ยน)
       */
      for await (const part of req.parts()) {
        if (part.type === 'file') {
          if (part.fieldname !== 'shot') {
            // ไฟล์ฟิลด์อื่นไม่ใช่ที่ต้องการ — ทิ้งให้ครบ ไม่งั้น stream จะค้าง
            await part.toBuffer()
            continue
          }
          const buffer = await part.toBuffer()
          if (buffer.byteLength > 0) {
            shot = { buffer, ...checkShot(buffer) }
          }
        } else {
          fields[part.fieldname] = String(part.value)
        }
      }

      /**
       * ตรวจฟิลด์เองแทน Zod schema เพราะ body เป็น multipart
       *   ใช้ตัวตรวจเดียวกับหน้าเว็บ (`ReportProblemBody`) → ข้อความ error เหมือนกันทั้งสองฝั่ง
       *
       * ⚠️ ต้องใช้ `safeParse` + โยน `ValidationError` ไม่ใช่ `parse()`
       *   `parse()` โยน `ZodError` ซึ่งมี `.issues` แต่ไม่มี `.validation`
       *   → error handler กลาง (app.ts) จับไม่ได้ → ตอบ **500** แทน 422
       *   (เจอจริงรอบแรกที่รัน probe: สรุปสั้นเกินควรได้ 422 แต่ได้ 500)
       */
      const parsedBody = ReportProblemBody.safeParse({
        summary: fields.summary ?? '',
        details: fields.details ?? '',
        pageUrl: fields.pageUrl ?? '',
        diagnostics: fields.diagnostics ?? '',
      })
      if (!parsedBody.success) {
        throw new ValidationError('ข้อมูลรายงานไม่ครบหรือยาวเกินไป', parsedBody.error.issues)
      }

      const out = await createReport(
        app,
        { user: { sub: who_.sub, name: who_.name ?? undefined } },
        parsedBody.data,
        shot,
      )
      return out
    },
  )

  /** เปิดรายงานทั้งหมด — ผู้ดูแลเท่านั้น (ไม่ใช่ผู้ส่ง) */
  app.get(
    '/reports',
    {
      schema: {
        tags,
        summary: 'รายงานปัญหาทั้งหมด (เฉพาะผู้ดูแล)',
        response: { 200: IssueReportList, 404: ErrorResponse, 401: ErrorResponse },
      },
    },
    async (req) => listReports(app, req),
  )

  app.patch(
    '/reports/:id',
    {
      schema: {
        tags,
        summary: 'เปลี่ยนสถานะรายงาน (เฉพาะผู้ดูแล)',
        body: UpdateReportBody,
        response: { 200: IssueReport, 404: ErrorResponse, 401: ErrorResponse, 422: ErrorResponse },
      },
    },
    async (req) => {
      const { id } = req.params as { id: string }
      return setReportStatus(app, req, id, req.body)
    },
  )

  /** ลบรายงาน + ภาพที่แนบมา — ผู้ดูแลเท่านั้น (กันรายงานขยะสะสม) */
  app.delete(
    '/reports/:id',
    {
      schema: {
        tags,
        summary: 'ลบรายงานปัญหา (เฉพาะผู้ดูแล)',
        response: {
          200: z.object({ deleted: z.boolean() }),
          404: ErrorResponse,
          401: ErrorResponse,
        },
      },
    },
    async (req) => {
      const { id } = req.params as { id: string }
      return { deleted: await deleteReport(app, req, id) }
    },
  )

  /**
   * ภาพหน้าจอที่แนบมา
   *
   * ⚠️ ไม่ใส่ `response` schema — Zod serializer จะพยายาม parse Buffer เป็น JSON
   *   route ที่ตอบไฟล์ต้องปล่อยให้ Fastify ส่ง Buffer ผ่านตรง ๆ
   *   (ทำแบบเดียวกับ `GET /api/account/avatar`)
   */
  app.get(
    '/reports/:id/shot',
    {
      schema: {
        tags,
        summary: 'ภาพหน้าจอที่แนบมากับรายงาน (เฉพาะผู้ดูแล)',
      },
    },
    async (req, reply) => {
      const { id } = req.params as { id: string }
      const found = await getReportShot(app, req, id)
      if (!found) {
        return reply.code(404).send({ code: 'NO_SHOT', message: 'รายงานนี้ไม่มีภาพแนบมา' })
      }
      return reply
        .header('content-type', found.contentType)
        .header('content-length', String(found.body.length))
        // รายงานแก้สถานะได้ แต่ภาพของรายงานไม่เปลี่ยน → cache ได้
        .header('cache-control', 'private, max-age=300')
        .send(found.body)
    },
  )
}