import { env, roleAtLeast, now, normalizeEmail, AppError } from '@docgen/shared'
import type { App } from '../../types.js'
import type { SessionUser } from '../auth/oidc.js'
import { roleIn } from '../teams/service.js'
import { notify } from '../studio/notifications.js'
import { sendMail } from './mail.js'

/**
 * ── เชิญด้วยอีเมล ──────────────────────────────────────────────────
 *
 * ปัญหาที่แก้: คนที่ยังไม่เคยเข้าระบบ **ไม่มี `sub`** ให้ระบบรู้จัก
 *   ช่องแชร์เลยบังคับให้พิมพ์ subject ของ Casdoor ซึ่งเป็น id ยาว ๆ ที่มองไม่ออก
 *   ทางออกคือเก็บคำเชิญผูกกับ**อีเมล** แล้วผูกเป็นสิทธิ์จริงตอนเขาเข้าสู่ระบบครั้งแรก
 *
 * ⚠️ เก็บคำเชิญ**แยกจาก `sharedWith`** ไม่ใช่ยัดเข้าไปในนั้น
 *   `sharedWith` คือ "คนที่มีสิทธิ์แล้ว" ทุกแถวมี `sub` จริงเสมอ
 *   ถ้าแทรกแถวที่ยังไม่มี `sub` ลงไป ทุกจุดที่อ่าน `sharedWith`
 *   (นับสิทธิ์ · ส่งแจ้งเตือน · แสดงรายชื่อ) จะต้องแก้ตาม และพังเงียบ ๆ
 *   แยกชุดแล้วของเดิมยังถูกต้องทั้งหมด
 *
 * รูปแบบนี้เดียวกับ `claimPendingInvites` ของระบบทีม (สมาชิกที่ยังไม่เคยเข้าระบบ)
 */

const PENDING = 'pending_shares'
const ACCESS = 'template_access'

type Req = { user?: SessionUser | null }

/** เอกสารคำเชิญที่ยังไม่ผูกกับผู้ใช้จริง */
interface PendingShareDoc {
  /** `${templateKey}::${email}` — กันเชิญคนเดิมซ้ำด้วย _id เลย */
  _id: string
  templateKey: string
  email: string
  role: 'viewer' | 'editor'
  /** sub ของคนที่เชิญ */
  by: string
  byName: string | null
  at: Date
}

const pending = (app: App) => app.mongo.collection<PendingShareDoc>(PENDING)

const idOf = (templateKey: string, email: string) => `${templateKey}::${email}`

function who(req: Req): SessionUser {
  const u = req.user
  if (!u?.sub) throw new AppError('AUTH_REQUIRED', 'ยังไม่ได้เข้าสู่ระบบ', 401)
  return u
}

/** ลิงก์ที่ส่งไปในอีเมล — พาไปหน้าแบบร่างนั้นเลย */
function templateUrl(templateKey: string): string {
  // ⚠️ ต้องใช้แค่ origin ไม่ใช้ทั้ง AUTH_SUCCESS_REDIRECT
  //   เพราะค่านั้นลงท้ายด้วย /studio อยู่แล้ว (เช่น http://localhost:8090/studio)
  //   ถ้าเอาทั้งค่ามาต่อ /studio อีก จะได้ /studio/studio/<key> → 404
  const { origin } = new URL(env.AUTH_SUCCESS_REDIRECT)
  return `${origin}/studio/${encodeURIComponent(templateKey)}`
}

/**
 * เชิญคนที่ยังไม่เคยเข้าระบบ ด้วยอีเมล
 *
 * @returns บอกด้วยว่าส่งอีเมลสำเร็จไหม — ไม่ใช่ boolean ตรง ๆ
 *   เพราะผู้ใช้ต้องรู้ว่า "ส่งไม่ได้" ไม่ใช่แค่เห็น error
 */
export async function inviteByEmail(
  app: App,
  input: { templateKey: string; email: string; role: 'viewer' | 'editor' },
  req: Req,
): Promise<{ pending: true; emailed: boolean; reason: string | null }> {
  const user = who(req)
  const email = normalizeEmail(input.email)
  if (!email) throw new AppError('BAD_REQUEST', 'อีเมลไม่ถูกต้อง', 422)

  const access = await app.mongo
    .collection(ACCESS)
    .findOne({ _id: input.templateKey } as never)

  if (access && access.owner !== user.sub) {
    // เงื่อนไขเดียวกับ addShare: เจ้าของส่วนตัว หรือผู้ดูแลทีมเจ้าของ
    const teamRole = await roleIn(app, (access as { team?: string | null }).team, user.sub)
    if (!teamRole || !roleAtLeast(teamRole, 'admin')) {
      throw new AppError('FORBIDDEN', 'เฉพาะเจ้าของเท่านั้นที่เชิญคนอื่นได้', 403)
    }
  }

  if (email === normalizeEmail(user.email)) {
    throw new AppError('BAD_REQUEST', 'คุณเป็นเจ้าของอยู่แล้ว', 422)
  }

  const at = now()
  await pending(app).updateOne(
    { _id: idOf(input.templateKey, email) } as never,
    { $set: { templateKey: input.templateKey, email, role: input.role, by: user.sub, byName: user.name, at } } as never,
    { upsert: true },
  )

  app.log.info({ templateKey: input.templateKey, email, role: input.role }, 'บันทึกคำเชิญ (รอผู้เข้าระบบ)')

  const url = templateUrl(input.templateKey)
  const roleText = input.role === 'editor' ? 'แก้ไขได้' : 'ดูอย่างเดียว'
  const sent = await sendMail({
    to: email,
    subject: `${user.name || 'เพื่อน'} เชิญคุณใช้แม่แบบเอกสาร`,
    text: [
      `${user.name || 'เพื่อน'} เปิดสิทธิ์แม่แบบเอกสารฉบับนี้ให้คุณ (${roleText})`,
      '',
      url,
      '',
      'ครั้งแรกที่คุณเข้าสู่ระบบด้วยอีเมลนี้ สิทธิ์จะเข้ามาอัตโนมัติ',
      'ถ้าไม่ได้ขอสิทธิ์นี้ แค่ละเลยอีเมลนี้ได้เลย',
    ].join('\n'),
  })

  return { pending: true, emailed: sent.sent, reason: sent.reason }
}

/** คำเชิญที่ยังค้างอยู่ของแม่แบบหนึ่งตัว — ใช้แสดงในหน้าแชร์ */
export async function listPendingShares(
  app: App,
  templateKey: string,
): Promise<Array<{ email: string; role: 'viewer' | 'editor'; at: Date }>> {
  const rows = await pending(app)
    .find({ templateKey } as never)
    .sort({ at: -1 })
    .toArray()
  return rows.map((r) => ({
    email: r.email,
    role: r.role,
    at: r.at instanceof Date ? r.at : new Date(r.at),
  }))
}

/** ยกเลิกคำเชิญที่ยังไม่ผูก */
export async function cancelPendingShare(
  app: App,
  input: { templateKey: string; email: string },
  req: Req,
): Promise<boolean> {
  const user = who(req)
  const email = normalizeEmail(input.email)
  const access = await app.mongo.collection(ACCESS).findOne({ _id: input.templateKey } as never)
  if (access && access.owner !== user.sub) {
    const teamRole = await roleIn(app, (access as { team?: string | null }).team, user.sub)
    if (!teamRole || !roleAtLeast(teamRole, 'admin')) {
      throw new AppError('FORBIDDEN', 'เฉพาะเจ้าของเท่านั้นที่ยกเลิกคำเชิญได้', 403)
    }
  }
  const res = await pending(app).deleteOne({ _id: idOf(input.templateKey, email) } as never)
  return res.deletedCount > 0
}

/**
 * ผูกคำเชิญค้างให้เป็นสิทธิ์จริง — เรียกตอนเข้าสู่ระบบสำเร็จ
 *
 * ⚠️ ทำเป็น**รายแม่แบบ** ไม่ใช่ replace ทั้งเอกสาร
 *   `sharedWith` อาจถูกแก้ไปพร้อมกันระหว่างที่เราอ่านมา
 *   ถ้า replace ทั้งก้อนจะทับการแก้ของเจ้าของทิ้ง (เขย่าเอกสารทั้งฉบับ)
 */
export async function claimPendingShares(app: App, user: SessionUser): Promise<number> {
  const email = normalizeEmail(user.email)
  if (!email || !user.sub) return 0

  const rows = await pending(app).find({ email } as never).toArray()
  if (rows.length === 0) return 0

  const col = app.mongo.collection(ACCESS)
  let claimed = 0

  for (const row of rows) {
    const current = (await col.findOne({ _id: row.templateKey } as never)) as unknown as {
      sharedWith?: { sub: string; name: string | null; role: 'viewer' | 'editor' }[]
    } | null
    if (!current) {
      // แม่แบบถูกลบไปแล้ว → ทิ้งคำเชิญ ไม่งั้นค้างเป็นแถวกรอ
      await pending(app).deleteOne({ _id: row._id } as never)
      continue
    }

    const already = (current.sharedWith ?? []).some((s) => s.sub === user.sub)
    if (already) {
      await pending(app).deleteOne({ _id: row._id } as never)
      continue
    }

    await col.updateOne(
      { _id: row.templateKey } as never,
      {
        $push: {
          sharedWith: {
            sub: user.sub,
            name: user.name || null,
            role: row.role,
            at: now(),
          },
        },
        $set: { updatedAt: now() },
      } as never,
    )
    await pending(app).deleteOne({ _id: row._id } as never)

    await notify(app, {
      user: user.sub,
      kind: 'access',
      title: 'ได้สิทธิ์แม่แบบที่ถูกเชิญไว้',
      body: `${row.byName ?? 'เพื่อน'} เชิญคุณใช้แม่แบบฉบับนี้ — เปิดดูได้แล้ว`,
    })
    claimed++
  }

  if (claimed > 0) {
    app.log.info({ sub: user.sub, email, claimed }, 'ผูกคำเชิญแม่แบบเป็นสิทธิ์จริงแล้ว')
  }
  return claimed
}

