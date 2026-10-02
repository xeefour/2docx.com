import { z } from 'zod/v4'
import {
  ListTemplatesResponse,
  UpdateTemplateBody,
  UploadTemplateResponse,
  ErrorResponse,
} from '@docgen/shared'
import type { App } from '../../types.js'
import * as carbone from './carbone.js'
import { readTemplateTags } from './tags.js'
import { assertCanEdit, assertCanView, who } from '../studio/service.js'

/** ขนาดไฟล์แม่แบบสูงสุด — Carbone/LibreOffice จะพังถ้าใหญ่เกินนี้ */
const MAX_SIZE = 20 * 1024 * 1024

const ALLOWED_EXT = ['.docx', '.xlsx', '.pptx', '.odt', '.ods', '.odp', '.doc', '.odf']

const EXT_TO_CT: Record<string, string> = {
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.odt': 'application/vnd.oasis.opendocument.text',
  '.ods': 'application/vnd.oasis.opendocument.spreadsheet',
  '.odp': 'application/vnd.oasis.opendocument.presentation',
  '.doc': 'application/msword',
  '.odf': 'application/vnd.oasis.opendocument.formula',
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
      return { items, hasMore }
    },
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

      await assertCanEdit(app, req.params.id, user.sub)

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
      await carbone.updateTemplate(req.params.id, req.body)
      app.log.info({ templateId: req.params.id, patch: Object.keys(req.body) }, 'แก้แม่แบบแล้ว')
      return reply.code(204).send(null)
    },
  )

  // DELETE /api/templates/:id
  app.delete(
    '/templates/:id',
    {
      schema: {
        tags,
        summary: 'ลบแม่แบบ (soft delete — ไฟล์ถูกลบจริงหลัง retention delay)',
        params: z.object({ id: z.string().min(1) }),
        response: { 204: z.null(), 500: ErrorResponse },
      },
    },
    async (req, reply) => {
      await carbone.deleteTemplate(req.params.id)
      app.log.info({ templateId: req.params.id }, 'สั่งลบแม่แบบแล้ว')
      return reply.code(204).send(null)
    },
  )
}
