import type { App } from '../../types.js'
import { AppError } from '@docgen/shared'
import { assertCanReplace, assertCanView, who } from '../studio/service.js'

/**
 * ── ตัวอย่างแม่แบบเป็นรูป ──────────────────────────────────────────
 *
 * เก็บรูปภาพของแม่แบบไว้ใน RustFS/S3 + Mongo (metadata เท่านั้น)
 * เพราะ RustFS ไม่มี CORS → เบราว์เซอร์อ่านข้ามโดเมนไม่ได้
 * ทำแบบเดียวกับเอกสารผลลัพธ์: API เป็นตัวส่งไฟล์แทน
 *
 * ── รูปมาจากสองทาง ──────────────────────────────────────────────
 *   ① `auto`   — ระบบสร้างให้จากหน้าแรกของแม่แบบ (ผู้ใช้กดปุ่มเอง)
 *   ② `upload` — เจ้าของอัปโหลดรูปเพิ่มเอง
 * ทั้งสองทางเก็บรูปแบบเดียวกัน ไม่ต้องแยกโค้ดแสดงผล
 *
 * ⚠️ **รูปอัตโนมัติทำที่ฝั่งเบราว์เซอร์ ไม่ใช่เซิร์ฟเวอร์**
 *   worker มีแค่ `pdf-lib` ซึ่งแก้เอกสารได้แต่**ไม่แปลง PDF เป็นภาพ**
 *   (ต้องใช้ pdfium/poppler/canvas ซึ่งเป็น native dep ที่เครื่องนี้ติดตั้งไม่ได้)
 *   เบราว์เซอร์มี pdf.js อยู่แล้วและวาดหน้าเป็น canvas ได้
 *   → ขั้นตอนคือ เรนเดอร์แม่แบบเป็น PDF (Carbone) → วาดหน้า 1 เป็น PNG → อัปโหลด
 */

/** โครง request ที่ service layer ใช้ — ทำซ้ำที่นี่เหมือน `trash.ts` */
type Req = { user?: { sub: string; name?: string } | null }

const PREVIEWS = 'template_previews'

/** กันไม่ให้แม่แบบเดียวกินพื้นที่เกินจำเป็น (ภาพย่อแต่ละหน้าก็ ~100–300 KB) */
export const MAX_PREVIEWS = 12

/** ขนาดไฟล์รูปสูงสุด 5 MB — เกินนี้แปลว่าอัปโหลดผิดขนาด (เช่น ภาพต้นฉบับ) */
export const MAX_PREVIEW_BYTES = 5 * 1024 * 1024

const ALLOWED_CT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
}

/**
 * ตรวจชนิดไฟล์จาก**ไบต์จริง** ไม่เชื่อ `Content-Type` ที่เบราว์เซอร์ส่งมา
 *
 * ⚠️ ต้องเช็ก เพราะไฟล์นี้จะถูกส่งกลับไปแสดงในหน้าเว็บของเราเอง
 *   ถ้าเชื่อ mimetype แล้วมีใครส่ง `text/html` มา ก็จะกลายเป็น
 *   ไฟล์ HTML ที่รันบนโดเมนเราได้ (stored XSS)
 *
 * ลายเซ็น: PNG = `89 50 4E 47` · JPEG = `FF D8 FF` · WebP = `RIFF....WEBP`
 *
 * export ให้ `modules/account` ใช้ตัวเดียวกัน — ตรรกะตรวจไฟล์รูปเป็นเรื่องความปลอดภัย
 * ถ้าเขียนซ้ำสองที่แล้วแก้ที่เดียว อีกที่จะเงียบ ๆ
 */
export function sniffImage(b: Buffer): string | null {
  if (b.byteLength >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
    return 'image/png'
  }
  if (b.byteLength >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {
    return 'image/jpeg'
  }
  if (
    b.byteLength >= 12 &&
    b.toString('ascii', 0, 4) === 'RIFF' &&
    b.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return 'image/webp'
  }
  return null
}

export type PreviewView = {
  id: string
  url: string
  contentType: string
  kind: 'auto' | 'upload'
  by: string
  byName: string | null
  createdAt: string
}

type PreviewDoc = {
  _id: string
  templateKey: string
  storageKey: string
  contentType: string
  kind: 'auto' | 'upload'
  by: string
  byName: string | null
  createdAt: string
}

/** id ใหม่ — เรียงตามเวลาเพื่อให้ค่าเรียงง่ายใน Mongo (ไม่ต้องเพิ่ม index อีก) */
function newId(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
}

const storageKeyFor = (templateKey: string, id: string, ext: string) =>
  `previews/${templateKey}/${id}.${ext}`

/** อ่านเอกสารสิทธิ์ของแม่แบบนี้ (ใช้ทั้งตอนดูและตอนเพิ่ม/ลบ) */
async function loadAll(app: App, templateKey: string): Promise<PreviewDoc[]> {
  const rows = await app.mongo
    .collection<PreviewDoc>(PREVIEWS)
    .find({ templateKey } as never)
    .sort({ createdAt: 1, _id: 1 } as never)
    .toArray()
  return rows as unknown as PreviewDoc[]
}

/** รายการตัวอย่างทั้งหมดของแม่แบบ — คนที่ดูแม่แบบได้ดูตัวอย่าง (ไม่ต้องเป็นเจ้าของ) */
export async function listPreviews(app: App, templateKey: string, req: Req): Promise<PreviewView[]> {
  const { sub } = who(req)
  await assertCanView(app, templateKey, sub)

  const docs = await loadAll(app, templateKey)
  // ต้องคืน Promise.all เพราะแต่ละอันยิง S3 เพื่อออก presigned URL
  return Promise.all(
    docs.map(async (d) => ({
      id: d._id,
      url: await app.s3.getUrl(d.storageKey),
      contentType: d.contentType,
      kind: d.kind,
      by: d.by,
      byName: d.byName,
      createdAt: d.createdAt,
    })),
  )
}

/**
 * เพิ่มตัวอย่างหนึ่งรูป — **เจ้าของเท่านั้น**
 *
 * ใช้กติกาเดียวกับ `assertCanReplace` (เจ้าของ หรือแม่แบบที่ยังไม่มีเจ้าของ)
 * เพราะ "เพิ่มรูปตัวอย่าง" เป็นการเปลี่ยนสิ่งที่คนอื่นเห็นในรายการ
 * เหมือนกับเปลี่ยนชื่อ/หมวด/แท็ก ไม่ใช่การแก้ของตัวเอง
 */
export async function addPreview(
  app: App,
  templateKey: string,
  body: Buffer,
  kind: 'auto' | 'upload',
  req: Req,
): Promise<PreviewView> {
  const user = who(req)
  await assertCanReplace(app, templateKey, user.sub)

  // ⚠️ ใช้ชนิดจากไบต์จริงเสมอ ไม่เชื่อ mimetype ที่ client ส่งมา
  //   (ดูคอมเมนต์ที่ sniffImage — ไม่งั้นรัน HTML บนโดเมนเราได้)
  const sniffed = sniffImage(body)
  const ext = ALLOWED_CT[sniffed ?? '']
  if (!sniffed || !ext) {
    throw new AppError('VALIDATION', 'รองรับเฉพาะไฟล์ PNG, JPEG และ WebP', 400)
  }
  const contentType = sniffed
  if (body.byteLength === 0) throw new AppError('VALIDATION', 'ไฟล์รูปว่างเปล่า', 400)
  if (body.byteLength > MAX_PREVIEW_BYTES) {
    throw new AppError(
      'VALIDATION',
      `ไฟล์รูปใหญ่เกิน ${Math.round(MAX_PREVIEW_BYTES / 1024 / 1024)} MB`,
      400,
    )
  }

  const existing = await loadAll(app, templateKey)
  if (existing.length >= MAX_PREVIEWS) {
    throw new AppError('CONFLICT', `เก็บตัวอย่างได้สูงสุด ${MAX_PREVIEWS} รูป ลบรูปเก่าออกก่อนเพิ่มใหม่`, 409)
  }

  const id = newId()
  const storageKey = storageKeyFor(templateKey, id, ext)
  await app.s3.put(storageKey, body, contentType)

  const doc: PreviewDoc = {
    _id: id,
    templateKey,
    storageKey,
    contentType,
    kind,
    by: user.sub,
    byName: user.name,
    createdAt: new Date().toISOString(),
  }
  try {
    await app.mongo.collection(PREVIEWS).insertOne(doc as never)
  } catch (e) {
    // ⚠️ ลบ S3 ทิ้งก่อน ไม่งั้นจะเหลือไฟล์กำพร้า (เคยเจอกรณีนี้กับเอกสารที่ถูกลบระหว่างเรนเดอร์)
    await app.s3.del(storageKey).catch(() => {})
    throw e
  }

  return {
    id,
    url: await app.s3.getUrl(storageKey),
    contentType,
    kind,
    by: user.sub,
    byName: user.name,
    createdAt: doc.createdAt,
  }
}

/** ลบตัวอย่างหนึ่งรูป — เจ้าของเท่านั้น */
export async function deletePreview(
  app: App,
  templateKey: string,
  id: string,
  req: Req,
): Promise<void> {
  const user = who(req)
  await assertCanReplace(app, templateKey, user.sub)

  const doc = (await app.mongo
    .collection<PreviewDoc>(PREVIEWS)
    .findOne({ _id: id, templateKey } as never)) as unknown as PreviewDoc | null
  if (!doc) throw new AppError('NOT_FOUND', 'ไม่พบรูปตัวอย่างนี้', 404)

  // ลบไฟล์ก่อนแล้วค่อยลบเมตาดาตา = ถ้าพังกลางทางจะได้ยังเห็นรูปอยู่
  // (สลับกัน = เมตาหายแต่รูปค้างใน S3 = รั่วพื้นที่เงียบ ๆ)
  await app.s3.del(doc.storageKey).catch((err: unknown) => {
    app.log.warn({ err: String(err), storageKey: doc.storageKey }, 'ลบไฟล์ตัวอย่างไม่สำเร็จ')
  })
  await app.mongo.collection(PREVIEWS).deleteOne({ _id: id } as never)
  app.log.info({ templateKey, id, by: user.sub }, 'ลบรูปตัวอย่างแม่แบบแล้ว')
}

/**
 * ภาพย่อ (รูปแรก) ของหลายแม่แบบใน**คำขอเดียว**
 *
 * ⚠️ ทำเป็น batch เพราะหน้ารายการมีหลายแถว
 *   ถ้ายิงทีละแถว (N+1) หน้าแรกจะยิงหลายสิบคำขอพร้อมกัน
 *   และแต่ละอันยังยิง S3 เพื่อออก presigned URL อีก
 *
 * @returns key → รูปแรก หรือ `null` ถ้าแม่แบบนั้นยังไม่มีตัวอย่าง
 */
export async function listThumbs(
  app: App,
  keys: string[],
  req: Req,
): Promise<Record<string, { id: string; url: string } | null>> {
  const { sub } = who(req)
  if (!keys.length) return {}

  /**
   * ⚠️ ต้องเช็คสิทธิ์**ทีละ key** แล้วค่อยดึงรูป
   *   ไม่งั้นแค่รู้ key ของแม่แบบส่วนตัวของคนอื่น ก็ดูภาพย่อได้
   *   (ช่องทางเดียวกับที่เคยเจอกับการดาวน์โหลดไฟล์แม่แบบ)
   */
  const allowed: string[] = []
  for (const k of keys) {
    try {
      await assertCanView(app, k, sub)
      allowed.push(k)
    } catch {
    }
  }
  if (!allowed.length) return {}

  const rows = (await app.mongo
    .collection<PreviewDoc>(PREVIEWS)
    .find({ templateKey: { $in: allowed } } as never)
    .sort({ createdAt: 1, _id: 1 } as never)
    .toArray()) as unknown as PreviewDoc[]

  // เก็บเฉพาะรูปแรกของแต่ละแม่แบบ (เรียงตาม createdAt อยู่แล้ว)
  const first = new Map<string, PreviewDoc>()
  for (const d of rows) if (!first.has(d.templateKey)) first.set(d.templateKey, d)

  const out: Record<string, { id: string; url: string } | null> = {}
  // ค่าเริ่มต้นคือ null = "ยังไม่มีตัวอย่าง" หรือ "ดูไม่ได้" (เจ้าของเท่านั้นที่เพิ่มได้)
  // ค่าจริงของ key ที่ผ่านสิทธิ์จะถูกเขียนทัดลงไปข้างล่าง
  for (const k of keys) out[k] = null
  await Promise.all(
    allowed.map(async (k) => {
      const d = first.get(k)
      out[k] = d ? { id: d._id, url: await app.s3.getUrl(d.storageKey) } : null
    }),
  )
  return out
}

/**
 * ดึงไฟล์รูปมาทั้งก้อน เพื่อให้ API เป็นตัวส่งแทน
 *
 * ⚠️ ทำไมไม่ใช้ presigned URL ตรง ๆ ใน `<img src>`:
 *   RustFS ชี้ไปที่ endpoint ภายใอและไม่มี CORS
 *   → รูปจะโหลดได้แต่แคชไม่ได้ และถ้าตั้ง CSP ที่บล็อก `img-src` จะพังทันที
 *   ส่งผ่าน API เสมอ = ทำงานได้ทุกกรณี แบบเดียวกับ `/documents/:id/file`
 */
export async function getPreviewFile(
  app: App,
  templateKey: string,
  id: string,
  req: Req,
): Promise<{ body: Buffer; contentType: string }> {
  const { sub } = who(req)
  await assertCanView(app, templateKey, sub)

  const doc = (await app.mongo
    .collection<PreviewDoc>(PREVIEWS)
    .findOne({ _id: id, templateKey } as never)) as unknown as PreviewDoc | null
  if (!doc) throw new AppError('NOT_FOUND', 'ไม่พบรูปตัวอย่างนี้', 404)

  return { body: await app.s3.get(doc.storageKey), contentType: doc.contentType }
}

/**
 * ลบตัวอย่างทั้งหมด — เรียกจาก `purgeTemplate`
 *
 * ⚠️ ต้องเรียกก่อน/พร้อมกับการลบแม่แบบ ไม่งั้นรูปจะค้างใน S3 ตลอดไป
 *   (Mongo หายที่เดียว = เราหาทางชี้กลับไป S3 ไม่ได้อีกแล้ว)
 */
export async function deleteAllPreviews(app: App, templateKey: string): Promise<void> {
  const docs = await loadAll(app, templateKey)
  if (!docs.length) return
  await Promise.all(
    docs.map((d) =>
      app.s3
        .del(d.storageKey)
        .catch((err: unknown) =>
          app.log.warn({ err: String(err), storageKey: d.storageKey }, 'ลบไฟล์ตัวอย่างไม่สำเร็จ'),
        ),
    ),
  )
  await app.mongo.collection(PREVIEWS).deleteMany({ templateKey } as never)
  app.log.info({ templateKey, n: docs.length }, 'ลบรูปตัวอย่างทั้งหมดของแม่แบบแล้ว')
}
