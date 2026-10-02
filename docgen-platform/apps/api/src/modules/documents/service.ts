import {
  env,
  now,
  newId,
  AppError,
  NotFoundError,
  DocumentRecord,
  type CreateDocumentBody,
  type RenderJob,
} from '@docgen/shared'
import type { App } from '../../types.js'

const COLLECTION = 'documents'

const docs = (app: App) => app.mongo.collection<DocumentRecord>(COLLECTION)

/**
 * ผู้ใช้ที่ล็อกอินแล้ว — hook ใน app.ts บังคับไว้แล้วว่าต้องมี
 * ใส่แบบนี้เพื่อให้ TypeScript บังคับด้วยว่าจุดที่เรียกต้องมี user
 */
function currentUser(req: { user?: { sub: string; name?: string } | null }): string {
  const sub = req.user?.sub
  if (!sub) throw new AppError('AUTH_REQUIRED', 'ยังไม่ได้เข้าสู่ระบบ', 401)
  return sub
}

/** ชื่อที่แสดงของผู้ใช้ — เก็บคู่กับ sub เพื่อให้หน้าประวัติแสดงชื่อได้เลย */
function currentUserName(req: { user?: { sub: string; name?: string } | null }): string | null {
  return req.user?.name ?? null
}

/** เอกสารเก่าที่ยังไม่มี createdBy = ไม่มีใครเป็นเจ้าของ → มองไม่เห็น */
const ownedByMe = (sub: string) => ({ createdBy: sub }) as never

/** แปลงเอกสารใน Mongo เป็น object ที่ validate ผ่านแล้ว */
function toRecord(raw: unknown): DocumentRecord {
  const r = raw as Record<string, unknown>
  return DocumentRecord.parse({ ...r, _id: String(r._id) })
}

export async function createDocument(
  app: App,
  body: CreateDocumentBody,
  req: { user?: { sub: string; name?: string } | null },
): Promise<DocumentRecord> {
  const id = newId('doc')
  const timestamp = now()
  const owner = currentUser(req)

  const record: DocumentRecord = {
    _id: id,
    templateId: body.templateId,
    status: 'queued',
    storageKey: null,
    outputFormat: body.outputFormat,
    label: body.label ?? null,
    error: null,
    /**
     * เก็บค่าที่กรอกไว้ด้วย เพื่อให้ "คลิกแก้ไข" ในแท็บประวัติกู้ค่าเดิมมาได้
     * (เอกสารเก่าที่ไม่มี field นี้ → `toRecord` แปลงเป็น `{}` ให้เอง)
     */
    data: body.data,
    createdBy: owner,
    createdByName: currentUserName(req),
    createdAt: timestamp,
    updatedAt: timestamp,
  }

  const job: RenderJob = {
    documentId: id,
    templateId: body.templateId,
    data: body.data,
    outputFormat: body.outputFormat,
    label: body.label,
  }

  // ⚠️ ลำดับสำคัญ: เขียน Mongo ก่อน แล้วค่อย publish
  //
  //   ถ้า publish ก่อน: worker อาจดึงงานไปแล้ว query Mongo ทันก่อน insert เสร็จ
  //   → ได้ matchedCount 0 → งานหายจริง (ไม่ใช่แค่ข้อมูลผิด)
  //
  //   ถ้า publish พังหลังเขียน Mongo: งานจะค้าง 'queued' ตลอด
  //   → แก้ด้วยการ mark 'failed' + error ทันที ไม่ปล่อยให้ค้างเงียบ ๆ
  await docs(app).insertOne(record)

  try {
    await app.js.publish(env.NATS_SUBJECT, JSON.stringify(job))
  } catch (err) {
    app.log.error({ err, documentId: id }, 'ส่งงานเข้าคิวไม่สำเร็จ')
    await docs(app).updateOne(
      { _id: id } as never,
      {
        $set: {
          status: 'failed',
          error: `ส่งงานเข้าคิวไม่สำเร็จ: ${(err as Error).message}`,
          updatedAt: now(),
        },
      },
    )
    throw err
  }

  app.log.info({ documentId: id, templateId: body.templateId }, 'รับงานแล้ว')
  return record
}

export async function getDocument(
  app: App,
  id: string,
  req: { user?: { sub: string; name?: string } | null },
): Promise<DocumentRecord> {
  // กรองด้วย createdBy ด้วย — ไม่ใช่หาแล้วเช็คทีหลัง
  // ถ้าเช็คทีหลัง จะบอกได้แค่ว่า "ไม่พบ" ซึ่งถูกกว่าเช็คสิทธิ์ (ไม่บอกว่ามีจริง)
  const raw = await docs(app).findOne({ _id: id, createdBy: currentUser(req) } as never)
  if (!raw) throw new NotFoundError('Document', id)
  return toRecord(raw)
}

export async function listDocuments(
  app: App,
  query: { status?: string; limit: number; skip: number },
  req: { user?: { sub: string; name?: string } | null },
): Promise<{ items: DocumentRecord[]; total: number }> {
  const owner = currentUser(req)
  const filter = {
    createdBy: owner,
    ...(query.status ? { status: query.status } : {}),
  } as never

  const [rows, total] = await Promise.all([
    docs(app)
      .find(filter)
      .sort({ createdAt: -1 })
      .skip(query.skip)
      .limit(query.limit)
      .toArray(),
    docs(app).countDocuments(filter),
  ])

  return { items: rows.map(toRecord), total }
}

export async function deleteDocument(
  app: App,
  id: string,
  req: { user?: { sub: string; name?: string } | null },
): Promise<void> {
  const record = await docs(app).findOne({ _id: id, createdBy: currentUser(req) } as never)
  if (!record) throw new NotFoundError('Document', id)

  // ⚠️ ลบ S3 ก่อน แล้วค่อยลบ record ใน Mongo
  //   RustFS ไม่มี API ให้ scan ไฟล์กำพร้า → ถ้าลบ Mongo ก่อนแล้ว S3 พัง
  //   จะเสีย storageKey เดียววิธีที่จะตามไฟล์นั้นไปลบได้ (orphan ถาวร)
  if (record.storageKey) {
    await app.s3.del(record.storageKey)
  }

  const result = await docs(app).deleteOne({ _id: id } as never)
  if (result.deletedCount === 0) throw new NotFoundError('Document', id)

  app.log.info({ documentId: id, storageKey: record.storageKey }, 'ลบเอกสารแล้ว')
}

/** ผนวก presigned URL เข้า response — เรียกเฉพาะตอนสถานะเป็น done */
export async function withDownloadUrl(
  app: App,
  record: DocumentRecord,
  withUrl: boolean,
) {
  if (!withUrl || record.status !== 'done' || !record.storageKey) {
    return { ...record, downloadUrl: null }
  }
  const downloadUrl = await app.s3.getUrl(record.storageKey)
  return { ...record, downloadUrl }
}

/**
 * ดึงไฟล์ผลลัพธ์มาทั้งก้อน
 *
 * ทำไมต้องมีในขณะที่มี presigned URL อยู่แล้ว:
 *   · presigned URL ชี้ไปที่ endpoint ภายนอก (ผ่าน tailnet)
 *   · RustFS ไม่ตอบ OPTIONS → ไม่มี CORS → เบราว์เซอร์ fetch ข้ามโดเมนไม่ได้
 *   · แต่พรีวิวด้วย pdf.js ต้องดึงไฟล์มาทั้งก้อนเพื่อแปลงหน้าเป็นรูป
 *   → route นี้คือทางเดียวที่ไม่ต้องพึ่ง CORS
 *
 * การตรวจสิทธิ์ใช้ createdBy ใน query เหมือน getDocument
 * เพื่อไม่ให้บอกว่า "มีเอกสารนี้อยู่" แก่คนที่ไม่ใช่เจ้าของ
 */
export async function getDocumentFile(
  app: App,
  id: string,
  req: { user?: { sub: string; name?: string } | null },
): Promise<{ body: Buffer; contentType: string; filename: string }> {
  const raw = await docs(app).findOne({ _id: id, createdBy: currentUser(req) } as never)
  if (!raw) throw new NotFoundError('Document', id)

  const record = toRecord(raw)
  if (record.status !== 'done' || !record.storageKey) {
    throw new AppError('NOT_READY', 'เอกสารยังไม่เรนเดอร์เสร็จ', 409)
  }

  const body = await app.s3.get(record.storageKey)
  const ext = record.outputFormat
  const stem = (record.label ?? record._id).replace(/[\\/:*?"<>|]+/g, '_').slice(0, 80)

  return {
    body,
    contentType: contentTypeFor(ext),
    filename: `${stem}.${ext}`,
  }
}

/** content-type ของไฟล์ที่เรนเดอร์ได้ — ต้องตรงกับฝั่ง worker */
function contentTypeFor(format: string): string {
  return (
    {
      pdf: 'application/pdf',
      docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      odt: 'application/vnd.oasis.opendocument.text',
    })[format] ?? 'application/octet-stream'
  }
