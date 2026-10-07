import { z } from 'zod/v4'

/**
 * ── รายงานปัญหาจากผู้ใช้ ─────────────────────────────────────────────
 *
 * ผู้ใช้สั่ง:
 *   *"เวลาผู้ใช้มีปัญหา จะได้รายงานมาให้ผมรู้ พร้อม screenshot มาให้ระบบทราบ"*
 *
 * ── ทำไมต้องมีที่รายงานของตัวเอง ไม่ใช่ให้ผู้ใช้ "คัดลอก URL ไปส่งเรา" ──
 *   ปุ่ม "คัดลอกข้อมูลแก้ปัญหา" ในแถบ URL มีอยู่แล้ว แต่มันผิดช่องทางสองข้อ
 *
 *   1. **ไม่มีใครส่ง** — ผู้ใช้ต้องสลับไปแอปอื่น หาแชทของเรา วาง แล้วกดส่งเอง
 *      ในเวลาที่หน้าเว็บกำลังเปิดช้าและมี error ค้างอยู่ (ซึ่งคือช่วงเวลาที่เขาจะกดรายงาน)
 *   2. **หลุดรายละเอียด** — ข้อความวางในแชทไม่มีโครงสร้าง ไม่มี URL/หน้าจอ/error
 *      แล้วเปลี่ยนไปเรื่องอื่นก่อนส่ง → เวลามาแก้จริงก็จำไม่ได้แล้วว่าเจออะไร
 *
 *   ปุ่มรายงานในระบบแก้ทั้งสองข้อ: กดครั้งเดียวได้ครบทั้งหน้าที่เกิด ข้อความ
 *   error ล่าสุด และภาพหน้าจอ แล้วเข้ากล่องจดหมายของผู้ดูแลทันที
 *
 * ── ขอบเขตที่ตั้งใจ ─────────────────────────────────────────────────
 *   · **ผู้ส่ง** = ผู้ใช้ที่ล็อกอินอยู่ (ทุกคนส่งได้ ยิ่งรายงานง่ายยิ่งได้รายงาน)
 *   · **ผู้อ่าน** = คนที่ `sub` อยู่ใน `REPORT_TO_SUBS` เท่านั้น (ปุ่มจะโผล่เฉพาะเขา)
 *     เหตุผลที่ผู้ส่งห้ามอ่านของคนอื่น: รายงานมีหน้าจอของระบบเรา + ชื่อผู้ใช้
 *     ถ้าเปิดให้ทุกคนอ่านได้ = ระบบเรามีช่องโหว่ร้ายแรงกว่ารายงานปัญหาทิ้งไป
 */

/** สถานะการดูแล — ผู้ดูแลเป็นคนเปลี่ยน ไม่ใช่ผู้ส่ง */
export const ReportStatus = z.enum(['open', 'doing', 'fixed'])
export type ReportStatus = z.infer<typeof ReportStatus>

/** ป้ายไทยของสถานะ — เก็บไว้ที่ shared เพื่อให้ทั้ง API และหน้าเว็บใช้คำเดียวกัน */
export const REPORT_STATUS_LABEL: Record<ReportStatus, string> = {
  open: 'ยังไม่ได้แก้',
  doing: 'กำลังแก้',
  fixed: 'แก้แล้ว',
}

/** ข้อมูลฟอร์มที่หน้าเว็บส่งมาพร้อมรูป (ส่งเป็น `multipart/form-data`) */
export const ReportProblemBody = z.object({
  /** สรุปสั้น ๆ ว่าเจอปัญหาอะไร — บังคับให้มี เพราะใช้เป็นชื่อในกล่องจดหมาย */
  summary: z.string().trim().min(3).max(200),
  /** รายละเอียดเพิ่มเติมจากผู้ใช้ (ไม่บังคับ — บางปัญหาพูกับภาพอย่างเดียวก็พอ) */
  details: z.string().trim().max(4_000).default(''),
  /**
   * หน้าที่เกิดปัญหา — เก็บเป็น `pathname + search` เท่านั้น
   *
   * ⚠️ ไม่เก็บ URL เต็ม เพราะจะผูกข้อมูลไปกับโดเมนที่ deploy
   *   และไม่เก็บ hash/query ที่อาจมี token ปนอยู่
   */
  pageUrl: z.string().trim().max(500).default(''),
  /**
   * ข้อความวินิจฉัยจากฝั่งเบราว์เซอร์
   *
   *   คัดลอกมาจาก `buildDiagnostic()` ใน `AppStatus.tsx` หน้าเดียวกับปุ่มรายงาน
   *   → ผู้ดูแลได้ error ล่าสุด + ขนาดจอ + เบราว์เซอร์ โดยไม่ต้องถามผู้ใช้อีก
   */
  diagnostics: z.string().trim().max(8_000).default(''),
})
export type ReportProblemBody = z.infer<typeof ReportProblemBody>

/** รายงานหนึ่งฉบับ (เก็บใน MongoDB collection `issue_reports`) */
export const IssueReport = z.object({
  _id: z.string(),
  /** sub ของผู้ส่ง */
  reporter: z.string(),
  /** ชื่อที่แสดงตอนรายงาน — เก็บคำไว้เพราะชื่อที่ Casdoor เปลี่ยนทีหลังต้องไม่ทำให้รายงานเก่ามั่ว */
  reporterName: z.string(),
  summary: z.string(),
  details: z.string(),
  pageUrl: z.string(),
  diagnostics: z.string(),
  /** storage key ของภาพหน้าจอใน S3 — null = ผู้ใช้ไม่ได้แนบภาพ */
  shotKey: z.string().nullable(),
  /** content type ของภาพ (ตรวจจาก magic bytes ไม่ใช่ที่ client บอกมา) */
  shotType: z.string().nullable(),
  status: ReportStatus,
  createdAt: z.date(),
  /** เวลาที่ผู้ดูแลเปลี่ยนสถานะ — null = ยังไม่เคยแตะ */
  resolvedAt: z.date().nullable(),
})
export type IssueReport = z.infer<typeof IssueReport>

/** คำขอเปลี่ยนสถานะจากหน้า `/reports` */
export const UpdateReportBody = z.object({
  status: ReportStatus,
})
export type UpdateReportBody = z.infer<typeof UpdateReportBody>

export const IssueReportList = z.object({
  items: z.array(IssueReport),
  total: z.number(),
  /** จำนวนที่ยังไม่ได้แก้ — ใช้ทำป้ายบนเมนู ไม่ต้องให้หน้าเว็บนับเอง */
  open: z.number(),
})
export type IssueReportList = z.infer<typeof IssueReportList>

/**
 * คำตอบของ `POST /reports`
 *
 * ⚠️ ต้องเป็น **Zod schema** ไม่ใช่ JSON Schema ดิบ
 *   โปรเจกต์นี้ใช้ `@fastify/type-provider-zod` ซึ่งบังคับให้ทุก `response:` เป็น Zod
 *   ถ้าใส่ JSON Schema ดิบ Fastify จะตอบ 500 ตอน**serialize คำตอบ**
 *
 *   ⚠️ อันตรายกว่าที่คิด เพราะงานทั้งหมดเกิดขึ้นแล้ว:
 *     รายงานถูกบันทึก + กระดิ่งถูกส่ง แล้วค่อยล้มตอนส่งคำตอบกลับ
 *     ผู้ใช้เห็น "ส่งไม่สำเร็จ" → กดใหม่ → ได้รายงานซ้ำ
 *     และผู้ดูแลเห็นรายงานที่ "ไม่มีใครส่ง" (เจอจริงรอบแรกที่รัน probe)
 */
export const CreateReportView = z.object({
  id: z.string(),
  /** ส่งถึงผู้ดูแลกี่คน — 0 = ยังไม่ได้ตั้ง REPORT_TO_SUBS (รายงานยังถูกบันทึกไว้) */
  delivered: z.number(),
})
export type CreateReportView = z.infer<typeof CreateReportView>