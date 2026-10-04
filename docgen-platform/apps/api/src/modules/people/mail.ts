import nodemailer from 'nodemailer'
import type { Transporter } from 'nodemailer'
import { env } from '@docgen/shared'
import type { App } from '../../types.js'

/**
 * ── ส่งอีเมลผ่าน SMTP ───────────────────────────────────────────────
 *
 * ⚠️ ทำไมถึงต้องมี และทำไมต้องเป็นแบบ "ยังไม่มีก็ปล่อยให้ระบบทำงานต่อ"
 *
 * ระบบนี้เดิมไม่มีช่องทางส่งอีเมลเลย และไม่จำเป็นต้องมี
 *   การแชร์แม่แบบทำงานได้ครบทุกอย่างโดยไม่ต้องส่งอีเมล
 *   → การบังคับให้ตั้ง SMTP ตอนบูตจะทำให้ระบบที่ยังไม่ได้ตั้งค่าล้มทั้งระบบ
 *     ทั้งที่ฟีเจอร์อื่นใช้ได้ปกติ
 *
 * ทางเลือกคือ "ยังไม่ได้ตั้ง = ยังรับคำเชิญได้ แต่ไม่ส่งอีเมล"
 *   แล้วบอกผู้ใช้ตรง ๆ ว่าส่งไม่ได้ เพราะสิทธิ์จะได้ตอนเขาเข้าระบบครั้งแรกอยู่ดี
 *   (ดู `claimPendingShares`) — ไม่มีอะไรสูญหาย ไม่ต้องกลัวผู้ใช้เชื่อว่าส่งแล้ว
 */

let transporter: Transporter | null = null

/** ตั้งค่าครบทุกตัวที่จำเป็นต่อการยิงจริงหรือยัง */
export function mailReady(): boolean {
  return Boolean(env.SMTP_HOST && env.SMTP_USER && env.SMTP_PASS)
}

/**
 * เหตุผลที่ส่งไม่ได้ — เป็นภาษาไทย ใช้แสดงผลให้ผู้ใช้ได้เลย
 * ไม่ต้องแปลงเองที่จุดเรียก
 */
export function mailUnavailableReason(): string {
  if (!env.SMTP_HOST) return 'ยังไม่ได้ตั้งค่าเซิร์ฟเวอร์อีเมล (SMTP_HOST)'
  if (!env.SMTP_USER) return 'ยังไม่ได้ตั้งผู้ใช้อีเมล (SMTP_USER)'
  if (!env.SMTP_PASS) return 'ยังไม่ได้ตั้งรหัสผ่านอีเมล (SMTP_PASS)'
  return 'ตั้งค่าอีเมลไม่ครบ'
}

/**
 * สร้าง transporter ครั้งเดียวแล้วใช้ซ้ำ
 *
 * ⚠️ สร้างใหม่ทุกครั้ง = สร้าง TCP connection ใหม่ทุกฉบับที่ส่ง
 *   nodemailer เก็บ connection pool ไว้เอง ถ้าตัวเดียวทั้งอายุพอแล้ว
 */
function getTransporter(): Transporter {
  if (transporter) return transporter
  transporter = nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_SECURE,
    // บางเจ้าไม่ยอมประกาศเองตอนบอกความสามารถ → ถาม capability ตรง ๆ
    tls: { rejectUnauthorized: false },
  })
  return transporter
}

export type MailResult = { sent: boolean; reason: string | null }

/**
 * ส่งอีเมลหนึ่งฉบับ
 *
 * ⚠️ **กลืน error เสมอ** และคืนผลเป็น boolean เหมือน `notify` ในระบบจดหมาย
 *   เหตุผลเดียวกัน: การส่งอีเมลเป็นเรื่องเสริม
 *   ถ้าล้มแล้วทำให้ "เชิญสำเร็จ" กลายเป็น 500 ผู้ใช้จะคิดว่าเชิญไม่สำเร็จ
 *   แล้วกดซ้ำจนได้สิทธิ์ซ้ำ — แต่สิทธิ์จริง ๆ เข้าไปอยู่ในระบบเรียบร้อยแล้ว
 */
export async function sendMail(input: {
  to: string
  subject: string
  text: string
}): Promise<MailResult> {
  if (!mailReady()) {
    return { sent: false, reason: mailUnavailableReason() }
  }
  try {
    await getTransporter().sendMail({
      from: env.SMTP_FROM,
      to: input.to,
      subject: input.subject,
      text: input.text,
    })
    return { sent: true, reason: null }
  } catch (err) {
    // log ไว้ให้ช่างเห็น แต่ไม่โยน error กลับไปหาผู้เรียก
    console.error('[mail] ส่งไม่สำเร็จ', err)
    return { sent: false, reason: 'ส่งอีเมลไม่สำเร็จ — ลองใหม่อีกครั้ง' }
  }
}

/** log ไว้ตอนบูตว่าระบบส่งอีเมลได้หรือไม่ — กัน "ตั้งไว้แต่ผิด" แล้วไม่มีใครรู้ */
export function logMailStatus(app: App): void {
  if (mailReady()) {
    app.log.info({ host: env.SMTP_HOST, port: env.SMTP_PORT }, 'พร้อมส่งอีเมล (SMTP)')
  } else {
    app.log.warn(
      { reason: mailUnavailableReason() },
      'ยังส่งอีเมลไม่ได้ — ระบบรับคำเชิญไว้ให้แล้ว แต่ไม่ส่งอีเมลแจ้ง',
    )
  }
}
