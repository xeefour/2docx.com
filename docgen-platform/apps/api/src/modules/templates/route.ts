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
  app.get(
    '/templates/:id',
    {
      schema: {
        tags,
        summary: 'ดาวน์โหลดไฟล์แม่แบบ',
        params: z.object({ id: z.string().min(1) }),
      },
    },
    async (req, reply) => {
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
