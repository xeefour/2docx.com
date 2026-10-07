import { z } from 'zod/v4'

/**
 * Schema กลาง — ใช้ร่วมกันทั้ง API, worker และ web
 * เปลี่ยนที่เดียว ทุกฝั่งเห็นถูกอัตโนมัติ
 */

// ── สถานะงานเอกสาร ───────────────────────────────────────────
// วงจร: queued → rendering → done | failed
export const DocumentStatus = z.enum(['queued', 'rendering', 'done', 'failed'])
export type DocumentStatus = z.infer<typeof DocumentStatus>

// ── ตัวระบุ ─────────────────────────────────────────────────
export const DocumentId = z.string().min(1)
export const TemplateId = z.string().min(1)

// ── payload สำหรับส่งเข้าคิว ────────────────────────────────
// เก็บเป็น record อิสระ ๆ เพราะ Carbone ต้องการ data ที่ merge เข้าแม่แบบ
export const RenderData = z.record(z.string(), z.unknown())

export const RenderJob = z.object({
  documentId: DocumentId,
  templateId: TemplateId,
  data: RenderData.default({}),
  /** รูปแบบที่ต้องการ — Carbone แปลงเอง */
  outputFormat: z.enum(['pdf', 'docx', 'odt', 'xlsx', 'pptx']).default('pdf'),
  /** ป้ายกำกับงาน สำหรับ log */
  label: z.string().max(200).optional(),
})
export type RenderJob = z.infer<typeof RenderJob>

// ── ข้อมูลที่เก็บลง MongoDB ─────────────────────────────────
// ไม่เก็บไฟล์ — เก็บแค่ key ใน S3
export const DocumentRecord = z.object({
  _id: DocumentId,
  templateId: TemplateId,
  status: DocumentStatus,
  /** key ใน RustFS เช่น "2026/09/abc123/report.pdf" — ไม่ใช่ URL เต็ม */
  storageKey: z.string().nullable(),
  outputFormat: z.string(),
  label: z.string().nullable(),
  error: z.string().nullable(),
  /**
   * ค่าที่ผู้ใช้กรอกตอนสั่งเรนเดอร์ — เก็บไว้เพื่อพากลับมาแก้ต่อได้
   *
   * ⚠️ เอกสารเก่าที่ยังไม่มี field นี้ = null → ใช้ `{}` แทน (แก้ไขต่อไม่ได้ แต่ไม่พัง)
   *
   * ⚠️ เก็บค่าไว้เฉพาะเจ้าของเท่านั้น — `listDocuments`/`getDocument` กรองด้วย
   *    `createdBy` อยู่แล้ว ถ้าวันหนึ่งมีที่ไหนคืน record ทั้งก้อนโดยไม่กรอง
   *    ค่าที่กรอก (ชื่อ เลขบัตร ที่อยู่) ของคนอื่นจะรั่วไปด้วย
   */
  data: RenderData.default({}),
  /**
   * subject ของผู้สร้าง (จาก Casdoor)
   * เอกสารเก่าที่ยังไม่มี field นี้ = null → ใครก็มองไม่เห็น
   * (ดู migrate.ts ถ้าต้องการย้ายข้อมูลเดิม)
   */
  createdBy: z.string().nullable().default(null),
  /**
   * ชื่อที่แสดงของผู้สร้าง (จาก Casdoor)
   *
   * เก็บซ้ำกับ createdBy เพื่อให้หน้า "ประวัติการสร้างเอกสาร" แสดงชื่อคนได้เลย
   * เอกสารเก่าที่ยังไม่มี = null → แสดง sub แทน
   */
  createdByName: z.string().nullable().default(null),
  createdAt: z.date(),
  updatedAt: z.date(),
})
export type DocumentRecord = z.infer<typeof DocumentRecord>

// ── request / response สำหรับ API ─────────────────────────────
export const CreateDocumentBody = z.object({
  templateId: TemplateId,
  data: RenderData,
  outputFormat: z.enum(['pdf', 'docx', 'odt', 'xlsx', 'pptx']).default('pdf'),
  label: z.string().max(200).optional(),
})
export type CreateDocumentBody = z.infer<typeof CreateDocumentBody>

export const GetDocumentQuery = z.object({
  /** ให้ API คืน presigned URL ให้พร้อมเลย (default true) */
  withUrl: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
})

export const ListDocumentsQuery = z.object({
  status: DocumentStatus.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  skip: z.coerce.number().int().min(0).default(0),
  /**
   * ขอ presigned URL ด้วยทุกรายการที่เสร็จแล้ว (default false)
   *
   * ค่า default เป็น false เพราะการออก URL คือการคำนวณ RSA signature
   * ซึ่ง CPU-bound — ถ้าเปิดทันที หน้าเว็บที่โหลดรายการ 20 แถวจะยิง S3 20 รอบ
   * และถ้าครบ limit 100 ก็ 100 รอบ
   *
   * เปิดเมื่อต้องการแก้ปัญหา N+1 (หน้ารายการต้องยิงรายตัวเพื่อขอลิงก์อีกที)
   * ข้อควรระวัง: URL หมดอายุ 1 ชั่วโมง — ถ้าเปิดค้างไว้นานกว่านั้นต้อง reload
   */
  withUrl: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
})

export const DocumentResponse = DocumentRecord.extend({
  /** มีเฉพาะตอนขอ withUrl=true — presigned หมดอายุใน 1 ชั่วโมง */
  downloadUrl: z.string().nullable().optional(),
})

export const ErrorResponse = z.object({
  code: z.string(),
  message: z.string(),
  details: z.unknown().optional(),
})

// ── แม่แบบ (อยู่ใน docserver) ──────────────────────────────────
//
// ⚠️ Carbone มี 2 ระบบ id คนละชนิด ต้องแยกให้ชัด
//    versionId  = id ของเวอร์ชันนั้น (ของเดิมคือ SHA-256 ของไฟล์ แต่เวลา
//                เปิด versioning Carbone จะสร้างค่าใหม่ทุกครั้ง ไม่ใช่ content hash
//                จึงห้ามเอาไปเทียบกับ sha256 ของไฟล์เอง)
//    templateId = id 64-bit คงที่ของ "แม่แบบ" (มีต่อเมื่อเปิด versioning)
//
//    แม่แบบที่อัปโหลดโดยไม่เปิด versioning จะไม่ถูกลง DB
//    → GET /templates ไม่เห็น, PATCH ได้ 404, DELETE ได้ 404
//    → เรนเดอร์ได้อย่างเดียว จัดการ metadata ไม่ได้

/** timestamp ของ Carbone เป็น unix seconds (ตัวเลข) ไม่ใช่ ISO string */
const CarboneTime = z.union([z.number(), z.string()]).nullable().optional()

export const TemplateSummary = z.object({
  /** 64-bit template id — มีเมื่อเปิด versioning */
  id: z.string().nullable().optional(),
  versionId: z.string(),
  name: z.string().nullable().optional(),
  comment: z.string().nullable().optional(),
  category: z.string().nullable().optional(),
  tags: z.array(z.string()).default([]),
  /** Carbone ใช้ชื่อ field ว่า "type" ไม่ใช่ "extension" (แต่ตอนอัปโหลดตอบเป็น templateExtension) */
  type: z.string().nullable().optional(),
  size: z.number().nullable().optional(),
  createdAt: CarboneTime,
  deployedAt: CarboneTime,
  expireAt: CarboneTime,
  /** 0 = อัปโหลดผ่าน API, 1 = อัปโหลดผ่าน Studio */
  origin: z.number().nullable().optional(),
})
export type TemplateSummary = z.infer<typeof TemplateSummary>

export const ListTemplatesQuery = z.object({
  /** กรองตามหมวด (คืนค่าเป็น string จาก Carbone) */
  category: z.string().max(200).optional(),
  /** ค้นหาชื่อแม่แบบ */
  search: z.string().max(200).optional(),
  /** กรองตาม versionId แบบ exact */
  versionId: z.string().min(1).optional(),
  /** กรองตาม templateId แบบ exact */
  templateId: z.string().min(1).optional(),
})

export const ListTemplatesResponse = z.object({
  items: z.array(TemplateSummary),
  /** Carbone บอกว่ายังมีข้อมูลไม่หมดไหม — ใช้ต่อ page */
  hasMore: z.boolean(),
})

/** metadata ที่แก้ได้ — ตรงกับ PATCH /template/{id} ของ Carbone */
export const UpdateTemplateBody = z
  .object({
    name: z.string().max(200).optional(),
    comment: z.string().max(1000).optional(),
    category: z.string().max(200).optional(),
    tags: z.array(z.string().max(30)).max(8).optional(),
    /** deploy เวอร์ชันนี้ทันที */
    deployedAt: z.string().datetime().optional(),
    /** หมดอายุเมื่อไหร่ — ใช้ลบแบบ soft */
    expireAt: z.string().datetime().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, {
    message: 'ต้องส่งอย่างน้อยหนึ่ง field มาแก้',
  })
export type UpdateTemplateBody = z.infer<typeof UpdateTemplateBody>

/** ผลลัพธ์จากอัปโหลดแม่แบบใหม่ — timestamp เป็น unix seconds */
export const UploadTemplateResponse = z.object({
  id: z.string().nullable().optional(),
  versionId: z.string(),
  templateId: z.string().nullable().optional(),
  templateExtension: z.string().nullable().optional(),
  type: z.string().nullable().optional(),
  size: z.number().nullable().optional(),
  createdAt: z.union([z.number(), z.string()]).nullable().optional(),
})

// ── health ────────────────────────────────────────────────────
/**
 * สถานะของ service หนึ่งตัว
 *
 * `detail` เป็นข้อความอิสระต่อ service (เช่น "primary = mongo-3", "memory 3.2 MB")
 * เป็น string ไม่ใช่ object เพราะแต่ละ service รายงานคนละอย่าง
 * และไม่ควรบังคับให้ทุกตัวมี field เดียวกัน — คนอ่านสำคัญกว่าความเป็น schema
 */
export const HealthCheck = z.object({
  /** id สั้น ๆ ใช้เป็น key ใน log/metric — เช่น "mongodb", "rustfs" */
  id: z.string(),
  /** ชื่อที่คนอ่านเข้าใจ — แสดงใน /apis */
  label: z.string(),
  /** container ใน docker compose ถ้ามี — ใช้เทียบกับ `docker ps` ได้ */
  container: z.string().nullable(),
  /** ตัว API เอง ถือว่า up เสมอถ้าตอบได้ */
  status: z.enum(['up', 'degraded', 'down']),
  /** เวลาที่ใช้ตอน probe — null = timeout (ไม่ใช่ตอบเร็ว) */
  latencyMs: z.number().nullable(),
  detail: z.string(),
})

export const HealthReport = z.object({
  /** ok = ทุกตัว up · degraded = มีบางตัวเสียแต่ API ยังใช้ได้บางส่วน */
  status: z.enum(['ok', 'degraded', 'down']),
  /** API รันมานานเท่าไร (วินาที) */
  uptimeSec: z.number(),
  /** เวลาที่ใช้ probe รวมทุกตัว */
  tookMs: z.number(),
  /** ตัว API เอง */
  api: HealthCheck,
  /** เช็คทุก service ที่แอปพึ่ง */
  checks: z.array(HealthCheck),
  /** นับสรุป — เอาไปทำ badge ในหน้าเว็บได้เลย */
  summary: z.object({
    up: z.number(),
    degraded: z.number(),
    down: z.number(),
  }),
})
export type HealthReport = z.infer<typeof HealthReport>
export type HealthCheck = z.infer<typeof HealthCheck>
