import { z } from 'zod/v4'
import {
  CreateDocumentBody,
  GetDocumentQuery,
  ListDocumentsQuery,
  DocumentResponse,
  ErrorResponse,
} from '@docgen/shared'
import type { App } from '../../types.js'
import {
  createDocument,
  getDocument,
  listDocuments,
  deleteDocument,
  withDownloadUrl,
  getDocumentFile,
} from './service.js'

export async function documentRoutes(app: App) {
  const tags = ['documents']

  // POST /api/documents — รับงานใหม่ (ไม่รอเรนเดอร์)
  app.post(
    '/documents',
    {
      schema: {
        tags,
        summary: 'สร้างเอกสาร (เข้าคิว ไม่รอผล)',
        body: CreateDocumentBody,
        response: {
          201: DocumentResponse,
          422: ErrorResponse,
        },
      },
    },
    async (req, reply) => {
      const record = await createDocument(app, req.body, req)
      return reply.code(201).send(record)
    },
  )

  // GET /api/documents — รายการ
  app.get(
    '/documents',
    {
      schema: {
        tags,
        summary: 'ดูรายการเอกสาร',
        description: [
          'ค่า default ไม่ออก presigned URL (`withUrl=false`)',
          'เพราะการออก URL คือการคำนวณ RSA signature ซึ่ง CPU-bound',
          'ถ้าเปิดทุกแถวจะยิง S3 เท่าจำนวนรายการ',
          '',
          'ใส่ `?withUrl=true` ตอนต้องการแก้ปัญหา N+1 เช่นหน้าเว็บที่ต้องคลิกดาวน์โหลดได้ทันที',
          '⚠️ URL หมดอายุ 1 ชั่วโมง',
        ].join('\n'),
        querystring: ListDocumentsQuery,
        response: {
          200: z.object({
            items: z.array(DocumentResponse),
            total: z.number(),
          }),
        },
      },
    },
    async (req) => {
      const { items, total } = await listDocuments(app, req.query, req)
      // withDownloadUrl ข้ามรายการที่ยังไม่เสร็จเองอยู่แล้ว (ไม่มี storageKey)
      // → ต้องคืน Promise.all เพราะแต่ละอันยิง S3
      const enriched = await Promise.all(items.map((r) => withDownloadUrl(app, r, req.query.withUrl)))
      return { items: enriched, total }
    },
  )

  // GET /api/documents/:id — รายละเอียด + ลิงก์ดาวน์โหลด
  app.get(
    '/documents/:id',
    {
      schema: {
        tags,
        summary: 'ดูเอกสารเดียว',
        params: z.object({ id: z.string().min(1) }),
        querystring: GetDocumentQuery,
        response: {
          200: DocumentResponse,
          404: ErrorResponse,
        },
      },
    },
    async (req) => {
      const record = await getDocument(app, req.params.id, req)
      return withDownloadUrl(app, record, req.query.withUrl)
    },
  )

  // GET /api/documents/:id/file — ดึงไฟล์ผลลัพธ์มาทั้งก้อน
  //
  // ⚠️ ต้องประกาศก่อน route `/documents/:id` ไม่งั้น Fastify จะจับ "file"
  //    ไปเป็น :id แล้วคืน JSON แทนไฟล์
  //
  // ⚠️ ไม่ใส่ `response` schema — serializer ของ Zod จะพยายาม parse Buffer
  //    เป็น JSON ให้ route ที่ตอบไฟล์ต้องปล่อยให้ Fastify ส่ง Buffer ตรง ๆ
  app.get(
    '/documents/:id/file',
    {
      schema: {
        tags,
        summary: 'ดึงไฟล์ผลลัพธ์ (สำหรับพรีวิว/ดาวน์โหลดจากเบราว์เซอร์)',
        description: [
          'มีไว้เพราะ presigned URL ชี้ไปที่ endpoint ภายนอก และ RustFS ไม่มี CORS',
          'เบราว์เซอร์จึงอ่านไฟล์ข้ามโดเมนไม่ได้ (pdf.js ต้องดึงมาทั้งก้อน)',
          '',
          'ต้องล็อกอิน และดูได้เฉพาะเอกสารที่ตัวเองสร้าง',
        ].join('\n'),
        params: z.object({ id: z.string().min(1) }),
      },
    },
    async (req, reply) => {
      const { body, contentType, filename } = await getDocumentFile(app, req.params.id, req)

      // filename* (RFC 5987) รองรับชื่อไทย/อักขระพิเศษ
      const encoded = encodeURIComponent(filename)
      return reply
        .header('content-type', contentType)
        .header('content-length', String(body.length))
        .header(
          'content-disposition',
          `attachment; filename="${encoded}"; filename*=UTF-8''${encoded}`,
        )
        .send(body)
    },
  )

  // DELETE /api/documents/:id
  app.delete(
    '/documents/:id',
    {
      schema: {
        tags,
        summary: 'ลบเอกสาร',
        params: z.object({ id: z.string().min(1) }),
        response: { 204: z.null(), 404: ErrorResponse },
      },
    },
    async (req, reply) => {
      await deleteDocument(app, req.params.id, req)
      return reply.code(204).send(null)
    },
  )
}
