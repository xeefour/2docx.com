/**
 * `/api/reports` — รายงานปัญหาที่ผู้ใช้ส่งมา
 *
 * ⚠️ ข้อตกลงสิทธิ์ของชุดนี้ (อ่านให้ตรงก่อนแก้อะไรในไฟล์นี้)
 *   · **ส่ง**: ผู้ใช้ที่ล็อกอินทุกคน
 *   · **อ่าน/แก้สถานะ/ดูภาพ**: เฉพาะ `sub` ที่อยู่ใน `REPORT_TO_SUBS`
 *
 *   เหตุผลที่ผู้ส่งอ่านของคนอื่นไม่ได้: รายงานมีหน้าจอของระบบเราพร้อมชื่อผู้ใช้อื่น
 *   ถ้าเปิดให้ทุกคนอ่านได้ = ระบบเรามีช่องโหว่ร้ายกว่ารายงานปัญหาทิ้งไป
 *
 * ⚠️ การส่งรายงานต้อง**ไม่พัง**เพราะผู้รับไม่ถูกตั้งค่า
 *   ถ้าไม่มี `REPORT_TO_SUBS` ก็ยังบันทึกไว้ให้ แล้วคืนข้อความว่าไม่มีใครรับ
 *   ผู้ใช้ที่เจอปัญหาจริงจะได้กดรายงานได้ แล้วเราค่อยไปตั้งค่าทีหลัง
 *   ถ้าตอบ 503 แทน เขาจะไปหาทางอื่น แล้วเราจะไม่ได้รู้ว่ามีปัญหาอะไร
 */
import { z } from 'zod/v4'
import {
  AppError,
  NotFoundError,
  IssueReport,
  IssueReportList,
  ReportProblemBody,
  UpdateReportBody,
  newId,
  now,
  reportReceivers,
} from '@docgen/shared'
import type { App } from '../../types.js'
import { who } from '../studio/service.js'
import { sniffImage } from '../templates/previews.js'
import { notifyMany } from '../studio/notifications.js'

const tags = ['reports']

const REPORTS = 'issue_reports'

/** สูงสุด 8 MB — ภาพหน้าจอเต็มจอ 4K เป็น PNG จะเกิน 10 MB บ่อย แต่ยังไม่ถึงขนาดเอกสาร */
const MAX_SHOT = 8 * 1024 * 1024

/**
 * ใครได้อ่านรายงานได้บ้าง
 *
 * ⚠️ ตรวจทุกครั้งที่เรียก ไม่แครฟค่าครั้งแรก
 *   เพราะรายชื่อผู้รับเปลี่ยนตาม env แต่ process ยังรันอยู่ (ยังไม่ restart)
 *   ถ้า cache ครั้งเดียว คนที่เพิ่งเพิ่มเข้ารายชื่อจะไม่มีสิทธิ์จนกว่าจะ restart
 *
 * ⚠️ ตอบ 404 ไม่ใช่ 403
 *   ถ้าตอบ 403 ผู้ส่งที่เผลอกดะเป็นผู้ดูแลจะรู้ว่ามีฟีเจอร์รายงานปัญหาอยู่ตรงนี้
 *   และเดาไปเรียกทีละ endpoint ว่ามีอะไรให้เห็นบ้าง
 *   404 ทำให้เขาคิดว่าหน้านี้ไม่มีอยู่จริง ซึ่งปลอดภัยกว่า
 */
export function assertReportReceiver(sub: string): void {
  if (!reportReceivers().includes(sub)) {
    throw new AppError('NOT_FOUND', 'ไม่พบหน้ารายงานปัญหา', 404)
  }
}

/** บันทึกรายงานหนึ่งฉบับ + ส่งกระดิ่งให้ผู้ดูแลทุกคน */
export async function createReport(
  app: App,
  req: { user?: { sub: string; name?: string } | null },
  body: z.infer<typeof ReportProblemBody>,
  shot: { buffer: Buffer; contentType: string } | null,
): Promise<{ id: string; delivered: number }> {
  const me = who(req)
  const id = newId('rpt')

  let shotKey: string | null = null
  let shotType: string | null = null
  if (shot) {
    /**
     * ⚠️ ใส่ id ของรายงานลงใน key เพื่อให้แน่นอนว่าไฟล์นี้ผูกกับรายงานฉบับนี้
     *   ไม่ใช้แค่ timestamp เพราะถ้าส่งพร้อมกันสองฉบับจะชนกัน
     */
    shotKey = `reports/${id}.${shot.contentType === 'image/jpeg' ? 'jpg' : shot.contentType === 'image/webp' ? 'webp' : 'png'}`
    shotType = shot.contentType
    await app.s3.put(shotKey, shot.buffer, shot.contentType)
  }

  const doc: IssueReport = {
    _id: id,
    reporter: me.sub,
    // ⚠️ เก็บชื่อที่แสดงตอนรายงานไว้ด้วย — ชื่อใน Casdoor เปลี่ยนทีหลัง
    //   ถ้าไปอ่านชื่อสดตอนเปิดหน้า รายงานเก่าจะโชว์ชื่อใหม่ที่ไม่เกี่ยวกับตอนที่แจ้ง
    reporterName: me.name ?? me.sub,
    summary: body.summary,
    details: body.details,
    pageUrl: body.pageUrl,
    diagnostics: body.diagnostics,
    shotKey,
    shotType,
    status: 'open',
    createdAt: now(),
    resolvedAt: null,
  }

  try {
    await app.mongo.collection<IssueReport>(REPORTS).insertOne(doc as never)
  } catch (err) {
    // รายงานคืองานหลักของคำขอนี้ — ถ้าบันทึกไม่ได้ ภาพที่อัปโหลดมาก็เปล่าประโยชน์
    if (shotKey) await app.s3.del(shotKey).catch(() => undefined)
    throw err
  }

  const receivers = reportReceivers()
  /**
   * ⚠️ ส่งกระดิ่ง**หลัง**บันทึกเสร็จ ไม่ใช่พร้อมกัน
   *   ถ้าส่งก่อนแล้วบันทึกพัง ผู้ดูแลจะเจอกระดิ่งที่กดไปแล้วไม่มีอะไรให้ดู
   *   (คลิกแล้วได้ 404 ทำให้เสียความเชื่อถือทั้งช่องทาง)
   */
  const delivered = await notifyMany(app, receivers, {
    kind: 'issue',
    title: `ปัญหาจาก ${me.name ?? me.sub}: ${body.summary}`,
    body: body.details || body.pageUrl || 'ผู้ใช้แจ้งปัญหาโดยไม่ได้เขียนรายละเอียด',
    link: `/reports?open=${id}`,
  })

  if (receivers.length === 0) {
    app.log.warn(
      { reportId: id },
      'บันทึกรายงานแล้วแต่ไม่มีใครรับ — ตั้ง REPORT_TO_SUBS ใน .env มิฉะนั้นรายงานนี้จะไม่มีใครเห็น',
    )
  } else if (delivered === 0) {
    app.log.warn({ reportId: id, receivers }, 'มีผู้รับในรายชื่อแต่ส่งกระดิ่งไม่สำเร็จเลย')
  }

  return { id, delivered }
}

/**
 * เปิดรายงานทั้งหมด — ผู้ดูแลเท่านั้น
 *
 * คืน `open` มาด้วยเพื่อให้หน้าเว็บทำป้ายบนเมนูได้โดยไม่ต้องนับซ้ำ
 * และเพื่อให้ตรงกับฐานข้อมูลเสมอ (ถ้าให้หน้าเว็บนับเองจะนับจากข้อมูลที่ตัดไปแล้ว)
 */
export async function listReports(app: App, req: { user?: { sub: string } | null }): Promise<IssueReportList> {
  const me = who(req)
  assertReportReceiver(me.sub)

  const col = app.mongo.collection<IssueReport>(REPORTS)
  const [items, total, open] = await Promise.all([
    col.find({}).sort({ createdAt: -1 }).limit(200).toArray(),
    col.countDocuments({}),
    // "ยังไม่ได้แก้" = ยังไม่มีวันที่ปิด ไม่ใช่ status === 'open'
    //   เพราะ 'doing' ก็ยังค้างอยู่ และควรนับเป็นงานที่ต้องทำเหมือนกัน
    col.countDocuments({ resolvedAt: null }),
  ])

  return { items: items.map(toView), total, open }
}

/** เปลี่ยนสถานะ — ผู้ดูแลเท่านั้น */
export async function setReportStatus(
  app: App,
  req: { user?: { sub: string } | null },
  id: string,
  body: z.infer<typeof UpdateReportBody>,
): Promise<IssueReport> {
  const me = who(req)
  assertReportReceiver(me.sub)

  const done = body.status === 'fixed'
  const res = await app.mongo.collection<IssueReport>(REPORTS).updateOne(
    { _id: id } as never,
    { $set: { status: body.status, resolvedAt: done ? now() : null } } as never,
  )
  if (res.matchedCount === 0) {
    throw new NotFoundError('รายงาน', id)
  }

  const found = await app.mongo.collection<IssueReport>(REPORTS).findOne({ _id: id } as never)
  return toView(found as IssueReport)
}

/** ดึงภาพหน้าจอที่แนบมา — ผู้ดูแลเท่านั้น */
export async function getReportShot(
  app: App,
  req: { user?: { sub: string } | null },
  id: string,
): Promise<{ body: Buffer; contentType: string } | null> {
  const me = who(req)
  assertReportReceiver(me.sub)

  const found = await app.mongo.collection<IssueReport>(REPORTS).findOne({ _id: id } as never)
  if (!found?.shotKey || !found.shotType) return null
  return { body: await app.s3.get(found.shotKey), contentType: found.shotType }
}

/** เช็คภาพที่แนบมาว่าเป็นรูปจริงไหม — เรียกก่อนบันทึก เพื่อไม่ให้เขียนขยะลง S3 */
export function checkShot(buffer: Buffer): { contentType: string } {
  const contentType = sniffImage(buffer)
  if (!contentType) {
    throw new AppError('BAD_IMAGE', 'ไฟล์แนบมาไม่ใช่รูปภาพ (รองรับ PNG, JPEG, WebP)', 400)
  }
  if (buffer.byteLength > MAX_SHOT) {
    throw new AppError('SHOT_TOO_BIG', 'รูปใหญ่เกิน 8 MB — ลองแนบภาพที่ถ่ายเฉพาะส่วนที่มีปัญหาแทน', 400)
  }
  return { contentType }
}

/**
 * ลบรายงาน + ภาพที่แนบมา
 *
 * ต้องมีจริง ๆ ไม่ใช่ของแถม เพราะรายงานมีรูปขนาดใหญ่ปะปนใน S3
 *   ถ้าลบแถวใน Mongo แต่ลืมภาพ → ไฟล์ใน S3 ค้างถาวรและไม่มีทางรู้ว่าเป็นของใคร
 *
 * ⚠️ ลบภาพ**ก่อน**ลบแถว
 *   ถ้าลบแถวก่อนแล้วภาพลบไม่สำเร็จ เราจะหา shotKey ไม่ได้อีก → ค้างถาวรแน่นอน
 */
export async function deleteReport(
  app: App,
  req: { user?: { sub: string } | null },
  id: string,
): Promise<boolean> {
  const me = who(req)
  assertReportReceiver(me.sub)

  const col = app.mongo.collection<IssueReport>(REPORTS)
  const found = await col.findOne({ _id: id } as never)
  if (!found) return false

  if (found.shotKey) {
    try {
      await app.s3.del(found.shotKey)
    } catch (err) {
      app.log.warn({ err, key: found.shotKey }, 'ลบภาพที่แนบมาไม่สำเร็จ — ยังลบแถวรายงานต่อ')
    }
  }
  await col.deleteOne({ _id: id } as never)
  return true
}

/** แปลง doc ใน Mongo เป็นรูปแบบที่ส่งออกไป */
function toView(d: IssueReport): IssueReport {
  return {
    ...d,
    _id: String(d._id),
    reporter: String(d.reporter),
    createdAt: d.createdAt instanceof Date ? d.createdAt : new Date(d.createdAt),
    resolvedAt: d.resolvedAt instanceof Date ? d.resolvedAt : null,
  }
}