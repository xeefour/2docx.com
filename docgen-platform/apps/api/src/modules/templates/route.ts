import { z } from 'zod/v4'
import {
  ListTemplatesResponse,
  UpdateTemplateBody,
  UploadTemplateResponse,
  ErrorResponse,
} from '@docgen/shared'
import type { App } from '../../types.js'
import * as carbone from './carbone.js'
import * as previews from './previews.js'
import { readTemplateTags } from './tags.js'
import { assertCanEdit, assertCanReplace, assertCanView, claimOwner, who } from '../studio/service.js'
import {
  listTombstoneKeys,
  listTombstones,
  purgeTemplate,
  restoreTemplate,
  getTombstone,
  startTrashSweeper,
  toTombstoneView,
  trashTemplate,
} from './trash.js'

/**
 * Schema ของรายการถังขยะ — ประกาศแยกจาก `trash.ts`
 * เพราะ `trash.ts` ไม่ควรผูกกับ Zod (เป็นโมดูล logic ใช้กับ sweeper ที่ไม่มี request)
 */
const TombstoneSchema = z.object({
  templateKey: z.string(),
  name: z.string(),
  category: z.string(),
  tags: z.array(z.string()),
  versionId: z.string(),
  deletedAt: z.string(),
  purgeAt: z.string(),
  daysLeft: z.number(),
  deletedBy: z.string(),
  deletedByName: z.string().nullable(),
  canRestore: z.boolean(),
})

/** ขนาดไฟล์แม่แบบสูงสุด — Carbone/LibreOffice จะพังถ้าใหญ่เกินนี้ */
const MAX_SIZE = 20 * 1024 * 1024

/**
 * ⚠️ รับเฉพาะ .docx — เพราะ**ขั้นตอนถัดไปทำไม่ได้** ไม่ใช่เพราะอยากจำกัด
 *   การส่งออก PDF เริ่มจากขอให้ Carbone แปลงแม่แบบเป็น .docx เสมอ
 *   ดู `apps/worker/src/docserver.ts` ขั้นที่ 1:
 *     `renderToBuffer(templateId, { data, convertTo: 'docx' })`
 *   แม่แบบนามสกุลอื่นจึงตายที่ขั้นนั้น (เคยเจอจริง: เรนเดอร์ .xlsx เป็น PDF ไม่ผ่าน)
 *
 *   ถ้าปล่อยให้อัปโหลด .xlsx ได้ ผู้ใช้จะเห็น "อัปโหลดสำเร็จ"
 *   แล้วพังตอนกดส่งออกเอกสาร ซึ่งแก้ยากกว่าบอกตรง ๆ ตอนอัปโหลด
 *
 *   ตอนทำให้รองรับครบจริง ค่อยขยายรายการนี้พร้อมกับ `ACCEPT` ใน Studio.tsx
 */
const ALLOWED_EXT = ['.docx']

const EXT_TO_CT: Record<string, string> = {
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
}

export async function templateRoutes(app: App) {
  const tags = ['templates']

  // GET /api/templates — รายการแม่แบบ
  app.get(
    '/templates',
    {
      schema: {
        tags,
        summary: 'รายการแม่แบบทั้งหมด',
        querystring: z.object({
          category: z.string().max(200).optional(),
          search: z.string().max(200).optional(),
          versionId: z.string().min(1).optional(),
          templateId: z.string().min(1).optional(),
        }),
        response: { 200: ListTemplatesResponse, 500: ErrorResponse },
      },
    },
    async (req) => {
      const { items, hasMore } = await carbone.listTemplates(req.query)
      /**
       * ตัดแม่แบบที่อยู่ในถังขยะออกจากรายการ
       *
       * ⚠️ ต้องกรองที่นี่ ไม่ใช่ที่ Carbone
       *    เพราะเรายัง**ไม่ได้ลบไฟล์จริง** ตอนผู้ใช้กดลบ (รอ 14 วัน)
       *    ถ้าไม่กรอง ผู้ใช้จะกดลบแล้วเห็นแม่แบบยังอยู่ในรายการ
       *    เหมือนปุ่มไม่ทำงาน (ซึ่งเคยเป็นอาการจริงมาก่อนแก้)
       *
       * ⚠️ `hasMore` ต้องคำนวณใหม่ ไม่งั้นหน้าเว็บจะโชว์ปุ่ม "โหลดเพิ่ม"
       *    ทั้งที่กรองออกไปแล้ว แล้วคลิกแล้วไม่มีอะไรเพิ่ม
       */
      const hidden = await listTombstoneKeys(app)
      const kept = items.filter((t) => !hidden.has(String(t.id ?? t.versionId)))
      return { items: kept, hasMore: hasMore && kept.length === items.length }
    },
  )

  // GET /api/templates/trash — แม่แบบที่ผู้เรียกเป็นคนลบ รอกู้คืน
  //
  // ⚠️ ประกาศก่อน route /:id ไม่งั้น Fastify จะจับ "trash" ไปเป็น :id
  app.get(
    '/templates/trash',
    {
      schema: {
        tags,
        summary: 'แม่แบบที่อยู่ในถังขยะ (คนเดียวกับที่กดลบ)',
        response: {
          200: z.object({ items: z.array(TombstoneSchema) }),
          500: ErrorResponse,
        },
      },
    },
    async (req) => ({ items: await listTombstones(app, req) }),
  )

  // GET /api/templates/:id/tags — แท็ก {d.*} ที่ใช้จริงในไฟล์แม่แบบ
  // ต้องประกาศก่อน route /:id ไม่งั้น Fastify จะจับ "tags" ไปเป็น :id
  app.get(
    '/templates/:id/tags',
    {
      schema: {
        tags,
        summary: 'แท็ก {d.*} ทั้งหมดที่แม่แบบนี้ใช้',
        description: [
          'ใช้เป็นตัวเติมให้ผู้ใช้รู้ว่าแม่แบบต้องการค่าอะไรบ้าง',
          'และให้สร้าง JSON ตัวอย่างอัตโนมัติ (`sample`)',
          '',
          'เซิร์ฟเวอร์แกะ `.docx` (ซึ่งคือ zip) ให้ ไม่ต้องดาวน์โหลดไฟล์มาแกะที่เบราว์เซอร์',
        ].join('\n'),
        params: z.object({ id: z.string().min(1) }),
        response: {
          200: z.object({
            items: z.array(
              z.object({
                path: z.string(),
                root: z.string(),
                count: z.number(),
              }),
            ),
            sample: z.record(z.string(), z.unknown()),
          }),
          404: ErrorResponse,
          500: ErrorResponse,
        },
      },
    },
    async (req) => readTemplateTags(req.params.id),
  )

  // GET /api/templates/categories
  app.get(
    '/templates/categories',
    {
      schema: {
        tags,
        summary: 'หมวดหมู่ทั้งหมด',
        response: { 200: z.object({ items: z.array(z.string()) }), 500: ErrorResponse },
      },
    },
    async () => ({ items: await carbone.listCategories() }),
  )

  // GET /api/templates/tags
  app.get(
    '/templates/tags',
    {
      schema: {
        tags,
        summary: 'แท็กทั้งหมด',
        response: { 200: z.object({ items: z.array(z.string()) }), 500: ErrorResponse },
      },
    },
    async () => ({ items: await carbone.listTags() }),
  )

  // GET /api/templates/:id — ดาวน์โหลดไฟล์แม่แบบ
  //
  // ⚠️ ตั้งใจไม่ใส่ `response` schema ที่นี่
  //    เพราะ serializer ของ Zod จะพยายาม parse Buffer เป็น JSON
  //    route ที่ตอบไฟล์ต้องปล่อยให้ Fastify ส่ง Buffer ผ่านตรง ๆ
  //
  // ⚠️ ต้องตรวจสิทธิ์ก่อนดาวน์โหลด
  //    เคยไม่ตรวจ → ใครล็อกอินก็กด URL แล้วดาวน์โหลดแม่แบบส่วนตัวของคนอื่นได้
  //    (หน้าเว็บไม่โชว์ปุ่มก็ไม่ช่วยอะไร เพราะเดา URL ได้)
  app.get(
    '/templates/:id',
    {
      schema: {
        tags,
        summary: 'ดาวน์โหลดไฟล์แม่แบบต้นฉบับ',
        description: '⚠️ แม่แบบส่วนตัวที่ไม่ได้แชร์ให้ผู้เรียก → 403',
        params: z.object({ id: z.string().min(1).max(200) }),
      },
    },
    async (req, reply) => {
      await assertCanView(app, req.params.id, who(req).sub)

      const { body, filename, contentType } = await carbone.downloadTemplate(req.params.id)

      // filename* (RFC 5987) รองรับชื่อไทย/ชื่อที่มีอักขระพิเศษ
      const encoded = encodeURIComponent(filename)
      return reply
        .header('content-type', contentType)
        .header(
          'content-disposition',
          `attachment; filename="${encoded}"; filename*=UTF-8''${encoded}`,
        )
        .header('content-length', String(body.length))
        .send(body)
    },
  )

  // POST /api/templates — อัปโหลดแม่แบบใหม่
  // ── ตัวอย่างแม่แบบเป็นรูป ─────────────────────────────────────────
  const PreviewSchema = z.object({
    id: z.string(),
    url: z.string(),
    contentType: z.string(),
    kind: z.enum(['auto', 'upload']),
    by: z.string(),
    byName: z.string().nullable(),
    createdAt: z.string(),
  })

  // GET /api/templates/:id/previews
  app.get(
    '/templates/:id/previews',
    {
      schema: {
        tags,
        summary: 'รูปตัวอย่างของแม่แบบ',
        description: [
          'คนที่ดูแม่แบบได้ดูตัวอย่าง (ไม่ต้องเป็นเจ้าของ)',
          'แต่**เพิ่ม/ลบ** ได้เฉพาะเจ้าของเท่านั้น',
          '',
          '`url` เป็น presigned URL (อายุ 1 ชั่วโมง)',
          'หน้าเว็บควรโหลดผ่าน `/previews/:pid/file` แทน เพราะ RustFS ไม่มี CORS',
        ].join('\n'),
        params: z.object({ id: z.string().min(1).max(200) }),
        response: {
          200: z.object({ items: z.array(PreviewSchema) }),
          403: ErrorResponse,
          500: ErrorResponse,
        },
      },
    },
    async (req) => ({ items: await previews.listPreviews(app, req.params.id, req) }),
  )

  // POST /api/templates/:id/previews
  app.post(
    '/templates/:id/previews',
    {
      schema: {
        tags,
        summary: 'เพิ่มรูปตัวอย่างของแม่แบบ',
        description: [
          '⚠️ เจ้าของเท่านั้น (หรือแม่แบบที่ยังไม่มีเจ้าของ = คนแรกที่กดคุม)',
          '',
          'ชนิดไฟล์ตรวจจาก**ไบต์จริง** ไม่เชื่อ Content-Type ที่ client ส่งมา',
        ].join('\n'),
        consumes: ['multipart/form-data'],
        params: z.object({ id: z.string().min(1).max(200) }),
        response: {
          201: PreviewSchema,
          400: ErrorResponse,
          403: ErrorResponse,
          409: ErrorResponse,
          500: ErrorResponse,
        },
      },
    },
    async (req, reply) => {
      if (!req.isMultipart()) {
        return reply.code(400).send({
          code: 'EXPECTED_MULTIPART',
          message: 'ต้องส่งไฟล์แบบ multipart/form-data',
        })
      }

      const file = await req.file()
      if (!file) {
        return reply.code(400).send({ code: 'NO_FILE', message: 'ไม่พบไฟล์รูป' })
      }

      // field อื่นมาในส่วน form ไม่ใช่ไฟล์ — อ่านค่าก่อน consume ทิ้ง
      const parts = file.fields as Record<string, { value?: unknown }>
      const kind = parts.kind?.value === 'auto' ? 'auto' : 'upload'

      const view = await previews.addPreview(
        app,
        req.params.id,
        await file.toBuffer(),
        kind,
        req,
      )
      return reply.code(201).send(view)
    },
  )

  // GET /api/templates/:id/previews/:pid/file
  //
  // ⚠️ ไม่ใส่ `response` schema — Zod serializer จะพยายาม parse Buffer เป็น JSON
  //    route ที่ตอบไฟล์ต้องปล่อยให้ Fastify ส่ง Buffer ผ่านตรง ๆ
  app.get(
    '/templates/:id/previews/:pid/file',
    {
      schema: {
        tags,
        summary: 'ไฟล์รูปตัวอย่าง',
        params: z.object({
          id: z.string().min(1).max(200),
          pid: z.string().min(1).max(120),
        }),
      },
    },
    async (req, reply) => {
      const { body, contentType } = await previews.getPreviewFile(
        app,
        req.params.id,
        req.params.pid,
        req,
      )
      return reply
        .header('content-type', contentType)
        .header('content-length', String(body.length))
        // รูปคงที่อยู่จนกว่าจะถูกลบ → cache ได้
        .header('cache-control', 'private, max-age=3600')
        .send(body)
    },
  )

  // DELETE /api/templates/:id/previews/:pid
  app.delete(
    '/templates/:id/previews/:pid',
    {
      schema: {
        tags,
        summary: 'ลบรูปตัวอย่าง',
        params: z.object({
          id: z.string().min(1).max(200),
          pid: z.string().min(1).max(120),
        }),
        response: {
          204: z.null(),
          403: ErrorResponse,
          404: ErrorResponse,
          500: ErrorResponse,
        },
      },
    },
    async (req, reply) => {
      await previews.deletePreview(app, req.params.id, req.params.pid, req)
      return reply.code(204).send(null)
    },
  )

  // GET /api/templates/thumbs — ภาพย่อของหลายแม่แบบในคำขอเดียว
  //
  // ⚠️ ต้องประกาศ**ก่อน** `/templates/:id`
  //    ไม่งั้น Fastify จะจับ "thumbs" ไปเป็นค่า `id` แล้วตอบ 404
  app.get(
    '/templates/thumbs',
    {
      schema: {
        tags,
        summary: 'ภาพย่อของหลายแม่แบบ',
        description: [
          'หน้ารายการมีหลายแถว → ถ้ายิงทีละแถวจะเป็น N+1',
          '',
          'คืนค่า null สำหรับแม่แบบที่ยังไม่มีรูปตัวอย่าง',
          'และสำหรับแม่แบบที่ผู้เรียก**ดูไม่ได้** (ไม่ใช่แค่ไม่มีรูป)',
        ].join('\n'),
        querystring: z.object({
          keys: z.string().min(1).max(8000),
        }),
        response: {
          200: z.object({
            items: z.record(
              z.string(),
              z.object({ id: z.string(), url: z.string() }).nullable(),
            ),
          }),
          500: ErrorResponse,
        },
      },
    },
    async (req) => {
      // กรองค่าว่างและซ้ำออกก่อน — ป้องกัน query ยาวเปล่ว ๆ
      const keys = [...new Set(req.query.keys.split(',').map((k) => k.trim()).filter(Boolean))]
      return { items: await previews.listThumbs(app, keys, req) }
    },
  )

  app.post(
    '/templates',
    {
      schema: {
        tags,
        summary: 'อัปโหลดแม่แบบใหม่',
        consumes: ['multipart/form-data'],
        response: { 201: UploadTemplateResponse, 400: ErrorResponse, 500: ErrorResponse },
      },
    },
    async (req, reply) => {
      if (!req.isMultipart()) {
        return reply.code(400).send({
          code: 'EXPECTED_MULTIPART',
          message: 'ต้องส่งไฟล์แบบ multipart/form-data',
        })
      }

      const file = await req.file()
      if (!file) {
        return reply.code(400).send({ code: 'NO_FILE', message: 'ไม่พบไฟล์แม่แบบ' })
      }

      const buffer = await file.toBuffer()

      if (buffer.length === 0) {
        return reply.code(400).send({ code: 'EMPTY_FILE', message: 'ไฟล์ว่างเปล่า' })
      }
      if (buffer.length > MAX_SIZE) {
        return reply.code(400).send({
          code: 'FILE_TOO_LARGE',
          message: `ไฟล์ใหญ่เกิน ${Math.round(MAX_SIZE / 1024 / 1024)} MB`,
        })
      }

      // ตรวจนามสกุล — ด้วยนามไฟล์ที่ประกาศมา ไม่ใช่ content-type
      // เพราะ browser ส่ง contentType ผิดกันเยอะ (เช่น docx บางครั้งเป็น octet-stream)
      const ext = file.filename.match(/\.[a-z0-9]+$/i)?.[0]?.toLowerCase() ?? ''
      if (!ALLOWED_EXT.includes(ext)) {
        return reply.code(400).send({
          code: 'UNSUPPORTED_FILE',
          message: `รองรับเฉพาะ ${ALLOWED_EXT.join(', ')}`,
        })
      }

      // field อื่น ๆ มาในส่วนของ form ไม่ใช่ไฟล์ — ต้อง consume ทิ้ง
      const parts = file.fields as Record<string, { value?: unknown }>
      const str = (k: string) => {
        const v = parts[k]?.value
        return typeof v === 'string' && v.trim() ? v.trim() : undefined
      }

      let tags: string[] | undefined
      const rawTags = str('tags')
      if (rawTags) {
        try {
          const parsed: unknown = JSON.parse(rawTags)
          if (Array.isArray(parsed)) {
            tags = parsed.filter((t): t is string => typeof t === 'string')
          }
        } catch {
          return reply.code(400).send({ code: 'BAD_TAGS', message: 'tags ต้องเป็น JSON array' })
        }
      }

      // default versioning = true
      // ถ้า false จะได้แค่ SHA-256 ที่จัดการ metadata ไม่ได้ (ดูหมายเหตุใน carbone.ts)
      const versioning = str('versioning') !== 'false'

      // ⚠️ อย่าแก้ w:jc ตรงนี้
      //    `thaiDistribute` เป็นค่าที่ Word ใช้ "กระจายทั้งบรรทัด" และต้องคงไว้
      //    เพราะ Carbone คงค่า w:jc เดิมทุกประการในไฟล์ที่ส่งออก
      //    ถ้าแก้เป็น `both` ตอนอัปโหลด เอกสาร .docx ที่ส่งมอบจะกลายเป็น
      //    "ชิดขอบทั้งสองด้าน" แทน "กระจาย" → เสียการจัดวางแบบไทยของ Word
      //
      //    การแก้เป็น `both` ทำที่ worker ตอนส่งออก **PDF** เท่านั้น
      //    ดู normalizeThaiAlignment ใน @docgen/shared และ tests/README-DockerHub.md
      const result = await carbone.uploadTemplate({
        filename: file.filename,
        contentType: EXT_TO_CT[ext] ?? file.mimetype,
        body: buffer,
        versioning,
        id: str('id'),
        name: str('name'),
        comment: str('comment'),
        category: str('category'),
        tags,
        sampleJson: str('data'),
      })

      /**
       * ผู้อัปโหลด = เจ้าของแม่แบบนั้นทันที (ผู้ใช้สั่ง)
       *
       * ⚠️ ทำ**หลัง**อัปโหลดสำเร็จเท่านั้น และล้มเหลวก็ปล่อยไป ไม่ให้ไฟล์ที่อัปโหลดแล้วหาย
       *    เพราะตั้งเจ้าของไม่ได้ — แม่แบบยังใช้งานได้ปกติ แค่ยังไม่มีเจ้าของเหมือนเดิม
       *
       * ⚠️ `templateKey` ต้องเป็น `id` ก่อน ไม่ใช่ `versionId`
       *    คีย์ที่หน้าเว็บใช้เปิดแม่แบบคือ `t.id ?? t.versionId` (ดู GET /templates)
       */
      const templateKey = String(result.id ?? result.versionId)
      try {
        await claimOwner(app, templateKey, req)
      } catch (err) {
        app.log.warn({ err, templateKey }, 'ตั้งเจ้าของแม่แบบไม่สำเร็จ — แม่แบบยังอัปโหลดได้ปกติ')
      }

      app.log.info(
        { versionId: result.versionId, id: result.id, name: str('name') },
        'อัปโหลดแม่แบบแล้ว',
      )

      return reply.code(201).send(result)
    },
  )

  /**
   * POST /api/templates/:id/replace — อัปโหลดไฟล์ใหม่**แทนแม่แบบเดิม**
   *
   * ไม่ใช่สร้างแม่แบบใหม่ แต่ส่ง `id` = templateId เดิมไปให้ Carbone
   * → ได้เป็น **เวอร์ชันใหม่ของแม่แบบเดิม** (ประวัติไม่หาย สิทธิ์ไม่หาย)
   *
   * ⚠️ เข้มกว่าแก้ metadata — การเขียนทับกระทบคนที่ใช้แม่แบบนี้ทุกคน
   *    จึงต้องมีสิทธิ์แก้ ไม่ใช่แค่ล็อกอิน
   */
  app.post(
    '/templates/:id/replace',
    {
      schema: {
        tags,
        summary: 'อัปโหลดไฟล์ใหม่แทนแม่แบบ (เป็นเวอร์ชันถัดไป)',
        consumes: ['multipart/form-data'],
        params: z.object({ id: z.string().min(1).max(200) }),
        body: z.unknown().optional(),
        response: { 201: UploadTemplateResponse, 400: ErrorResponse, 403: ErrorResponse, 500: ErrorResponse },
      },
    },
    async (req, reply) => {
      const user = who(req)

      /**
       * ⚠️ Carbone ต่อเวอร์ชันต่อยอดได้เฉพาะแม่แบบที่มี **id เป็นเลข 64-bit**
       *    แม่แบบที่ `id` เป็น hash จะได้ 400 จาก docserver (502 ถ้าปล่อยให้หลุด)
       *    ข้อความของ Carbone ยาวและเป็นภาษาอังกฤษ อ่านยาก → บอกให้ชัดตรงนี้
       */
      if (!/^\d+$/.test(req.params.id)) {
        return reply.code(400).send({
          code: 'NOT_VERSIONABLE',
          message:
            'แม่แบบนี้เกิดจากการอัปโหลดแบบไม่เปิด versioning จึงไม่มี id ที่ใช้ต่อเวอร์ชันได้ — ' +
            'ให้ดาวน์โหลดไฟล์เดิมออกมา แล้วอัปโหลดเป็นแม่แบบใหม่แทน',
        })
      }

      await assertCanReplace(app, req.params.id, user.sub)

      if (!req.isMultipart()) {
        return reply.code(400).send({
          code: 'EXPECTED_MULTIPART',
          message: 'ต้องส่งไฟล์แบบ multipart/form-data',
        })
      }

      const file = await req.file()
      if (!file) {
        return reply.code(400).send({ code: 'NO_FILE', message: 'ไม่พบไฟล์แม่แบบ' })
      }

      const buffer = await file.toBuffer()
      if (buffer.length === 0) {
        return reply.code(400).send({ code: 'EMPTY_FILE', message: 'ไฟล์ว่างเปล่า' })
      }
      if (buffer.length > MAX_SIZE) {
        return reply.code(400).send({
          code: 'FILE_TOO_LARGE',
          message: `ไฟล์ใหญ่เกิน ${Math.round(MAX_SIZE / 1024 / 1024)} MB`,
        })
      }

      // ตรวจนามสกุลจากชื่อไฟล์ ไม่ใช่ content-type — browser ส่งผิดกันเยอะ
      const ext = file.filename.match(/\.[a-z0-9]+$/i)?.[0]?.toLowerCase() ?? ''
      if (!ALLOWED_EXT.includes(ext)) {
        return reply.code(400).send({
          code: 'UNSUPPORTED_FILE',
          message: `รองรับเฉพาะ ${ALLOWED_EXT.join(', ')}`,
        })
      }

      // field อื่น ๆ มาในส่วนของ form ไม่ใช่ไฟล์ — ต้อง consume ทิ้ง
      const parts = file.fields as Record<string, { value?: unknown }>
      const str = (k: string) => {
        const v = parts[k]?.value
        return typeof v === 'string' && v.trim() ? v.trim() : undefined
      }

      let tags: string[] | undefined
      const rawTags = str('tags')
      if (rawTags) {
        try {
          const parsed: unknown = JSON.parse(rawTags)
          if (Array.isArray(parsed)) tags = parsed.filter((t): t is string => typeof t === 'string')
        } catch {
          return reply.code(400).send({ code: 'BAD_TAGS', message: 'tags ต้องเป็น JSON array' })
        }
      }

      /**
       * ⚠️ ส่ง `id` = templateKey เดิม เพื่อให้ Carbone เพิ่ม**เวอร์ชัน**
       *    ถ้าไม่ส่ง จะกลายเป็นแม่แบบคนละตัวทันที (สิทธิ์/ประวัติเดิมหายทั้งหมด)
       *
       * ⚠️ ส่ง name/category/tags ของเดิมไปด้วย
       *    เวอร์ชันใหม่จะได้ metadata เดิม ไม่ต้องกลับมากรอกใหม่
       *
       * ⚠️ อย่าแก้ w:jc ตรงนี้ — ดูหมายเหตุเดียวกับที่ POST /templates
       */
      const result = await carbone.uploadTemplate({
        filename: file.filename,
        contentType: EXT_TO_CT[ext] ?? file.mimetype,
        body: buffer,
        versioning: true,
        id: req.params.id,
        /**
         * ⚠️ `deployedAt` **ต้องส่ง** ไม่งั้น Carbone ตอบ 400 (code w124)
         *    เพราะเวอร์ชันเดิมถูกสร้างแบบไม่มีค่านี้ (เป็น 0) และ Carbone
         *    บังคับว่าค่าใหม่ต้อง "ต่างจาก" ค่าของเวอร์ชันที่ปล่อยอยู่
         *
         * ⚠️ ค่าต้อง **≥ 42000000000** ตามคำแนะนำของ Carbone
         *    ("Tip: Use value ≥ 42000000000 to deploy now")
         *    ถ้าใช้ unix วินาทีธรรมดา เวอร์ชันใหม่จะถูก "ตั้งเวลาไว้"
         *    และรายการแม่แบบยังชี้ไปที่เวอร์ชันเก่าอยู่ (เคยเจอ)
         */
        deployedAt: 42000000000,
        name: str('name'),
        comment: str('comment'),
        category: str('category'),
        tags,
        sampleJson: str('data'),
      })

      app.log.info(
        { templateId: req.params.id, versionId: result.versionId, by: user.sub },
        'อัปโหลดแม่แบบเป็นเวอร์ชันใหม่แล้ว',
      )
      return reply.code(201).send(result)
    },
  )

  // PATCH /api/templates/:id — แก้ metadata
  app.patch(
    '/templates/:id',
    {
      schema: {
        tags,
        summary: 'แก้ metadata ของแม่แบบ',
        params: z.object({ id: z.string().min(1) }),
        body: UpdateTemplateBody,
        response: { 204: z.null(), 422: ErrorResponse, 500: ErrorResponse },
      },
    },
    async (req, reply) => {
      /**
       * ⚠️ เคยไม่เช็คสิทธิ์เลย → ใครก็แก้ชื่อ/หมวด/แท็กของแม่แบบส่วนตัวของคนอื่นได้
       *   metadata เป็นเรื่องของคนใช้ร่วมกัน → ใช้สิทธิ์เดียวกับแก้ฟอร์ม
       *   (เข้มกว่านั้นคือเปลี่ยนไฟล์แม่แบบ ซึ่งใช้ assertCanReplace)
       */
      await assertCanEdit(app, req.params.id, who(req).sub)
      await carbone.updateTemplate(req.params.id, req.body)
      app.log.info({ templateId: req.params.id, patch: Object.keys(req.body) }, 'แก้แม่แบบแล้ว')
      return reply.code(204).send(null)
    },
  )

  // GET /api/templates/:id/trash — แม่แบบตัวนี้อยู่ในถังขยะไหม
  //
  // ⚠️ ไม่เช็คสิทธิ์ เพราะ**ทุกคนที่เปิดแม่แบบนี้ได้ต้องเห็นป้ายเตือน**
  //   ผู้ใช้สั่ง: *"แจ้งเตือนผู้ใช้ว่าจะลบแม่แบบนี้ ใครจะใช้ให้ clone ไปแทน"*
  //   ถ้าเช็คสิทธิ์ คนที่ได้รับการแชร์จะเปิดเจอเอกสารเหมือนปกติ
  //   แล้วค่อยหายไปเงียบ ๆ ตอนครบ 14 วัน ซึ่งแย่กว่าการเตือนตั้งแต่แรก
  //   ข้อมูลที่คืนก็จำกัดอยู่แค่ชื่อ/วันที่ ไม่มีเนื้อหาแม่แบบ
  app.get(
    '/templates/:id/trash',
    {
      schema: {
        tags,
        summary: 'สถานะถังขยะของแม่แบบหนึ่งตัว (ใช้โชว์ป้ายเตือนผู้ที่เปิดแม่แบบ)',
        params: z.object({ id: z.string().min(1) }),
        response: { 200: z.object({ item: TombstoneSchema.nullable() }) },
      },
    },
    async (req) => {
      const t = await getTombstone(app, req.params.id)
      return { item: t ? toTombstoneView(t, who(req).sub) : null }
    },
  )

  // DELETE /api/templates/:id — เข้าถังขยะ (รอ 14 วัน ค่อยลบจริง)
  app.delete(
    '/templates/:id',
    {
      schema: {
        tags,
        summary: 'ลบแม่แบบ (เข้าถังขยะ — ไฟล์ถูกลบจริงหลัง 14 วัน กู้คืนได้ก่อนหน้านั้น)',
        params: z.object({ id: z.string().min(1) }),
        response: { 200: TombstoneSchema, 403: ErrorResponse, 500: ErrorResponse },
      },
    },
    async (req) => trashTemplate(app, req.params.id, req),
  )

  // POST /api/templates/:id/restore — เอาออกจากถังขยะ
  app.post(
    '/templates/:id/restore',
    {
      schema: {
        tags,
        summary: 'กู้คืนแม่แบบจากถังขยะ (ไฟล์ยังอยู่ครบ จึงใช้ได้ทันที)',
        params: z.object({ id: z.string().min(1) }),
        response: { 204: z.null(), 403: ErrorResponse, 404: ErrorResponse, 500: ErrorResponse },
      },
    },
    async (req, reply) => {
      await restoreTemplate(app, req.params.id, req)
      return reply.code(204).send(null)
    },
  )

  /**
   * DELETE /api/templates/:id/purge — ลบถาวรทันที
   *
   * ⚠️ **ข้ามช่วง 14 วัน กู้คืนไม่ได้แล้ว** มีไว้ให้
   *   · ตัวกวาดถังขยะเรียกใช้ในกรณีที่อยากลัดขั้นตอน
   *   · สคริปต์ทดสอบที่สร้างแม่แบบแล้วต้องการล้างทั้งหมดทันที
   *   (ถ้าใช้ route ปกติ แม่แบบจะค้างในถังขยะ 14 วัน และรบกวนเทสต์อื่น)
   *   · ผู้ใช้ที่ลบผิดแล้วอยากลบเด็ดขาด
   */
  app.delete(
    '/templates/:id/purge',
    {
      schema: {
        tags,
        summary: 'ลบแม่แบบถาวรทันที (ข้ามช่วงรอ 14 วัน — กู้คืนไม่ได้)',
        params: z.object({ id: z.string().min(1) }),
        response: { 204: z.null(), 500: ErrorResponse },
      },
    },
    async (req, reply) => {
      await purgeTemplate(app, req.params.id)
      return reply.code(204).send(null)
    },
  )

  // เริ่มตัวกวาดถังขยะ — ลบแม่แบบที่ครบ 14 วันอัตโนมัติ
  startTrashSweeper(app)
}
