import type { App } from '../../types.js'
import { AppError, NotFoundError, newId, normalizeEmail, now, roleAtLeast } from '@docgen/shared'
import type {
  AddMemberBody,
  CreateTeamBody,
  MemberRef,
  TeamAccess,
  TeamDetail,
  TeamMember,
  TeamRole,
} from '@docgen/shared'
import type { SessionUser } from '../auth/oidc.js'

/**
 * ── ทีม ──────────────────────────────────────────────────────────
 *
 * ── กติกาที่ห้ามละเริยก (เคยพังได้ง่ายกว่าที่คิด) ─────────────────────
 *
 * 1. **ทีมต้องมี owner อย่างน้อย 1 คนเสมอ**
 *   ถ้าไม่มีกฎนี้ ทีมจะกลายเป็นของที่ไม่มีใครลบได้ ถอนสมาชิกไม่ได้ แก้ชื่อไม่ได้
 *   เจอจริงเมื่อปล่อยให้ลบ owner คนสุดท้าย — ตอนนี้ผู้ดูแลทีมจะเปลี่ยนชื่อทีมไม่ได้เลย
 *   เพราะฉะนั้น**ทุกทางที่ลดจำนวน owner ต้องเช็คก่อนเสมอ**
 *   (ถอนสมาชิก · ลด role · ลบทีม)
 *
 * 2. **คนที่ไม่ได้อยู่ในทีม ห้ามแก้อะไรของทีมได้** — รวมถึง admin
 *   ตรรกะนี้อยู่ใน `member()` ไม่ใช่ที่ route → เรียกจากไหนก็ได้ผลเหมือนกัน
 *
 * 3. **คนที่ออกจากทีมแล้วเสียสิทธิ์ทันที**
 *   ไม่ต้องรอ TTL ของ session เพราะ role อ่านสดจาก Mongo ทุกครั้ง
 *   (ถ้าเก็บ role ไว้ใน session ผู้ที่ถูกถอนจะยังแก้ได้จนกว่า session จะหมดอายุ)
 *
 * 4. **ค้นชื่อทีมชนกันได้** — ไม่บังคับ unique
 *   ชื่อทีมเป็นแค่ป้ายบอกผู้ใช้ ไม่ใช่ตัวระบุ (URL ใช้ id)
 *   บังคับ unique แล้วจะเจอปัญหา "ชื่อนี้ถูกใช้" ตอนสร้างทีมที่สองชื่อเหมือนกัน
 *   ซึ่งแก้ยากกว่าที่คิด เพราะผู้ใช้ไม่รู้ว่าใครจองไว้
 */

/** โครง request ที่ service layer ใช้ */
type Req = { user?: SessionUser | null }

const TEAMS = 'teams'
const MEMBERS = 'team_members'

/** เอกสารสมาชิกใน Mongo */
interface MemberDoc {
  team: string
  /** null = ยังไม่เคยเข้าระบบ (เชิญด้วยอีเมล) — ดู `claimPendingInvites` */
  sub: string | null
  name: string | null
  /** เก็บเฉพาะตอน `sub` เป็น null · ผูกสำเร็จแล้วลบทิ้ง */
  email: string | null
  role: TeamRole
  at: Date
  by: string | null
}

function who(req: Req): SessionUser {
  const u = req.user
  if (!u?.sub) throw new AppError('AUTH_REQUIRED', 'ยังไม่ได้เข้าสู่ระบบ', 401)
  return u
}

// ── การอ่าน ─────────────────────────────────────────────────────

const members = (app: App) => app.mongo.collection<MemberDoc>(MEMBERS)

/** สมาชิกหนึ่งคนของทีมหนึ่งทีม */
export async function member(
  app: App,
  team: string,
  sub: string,
): Promise<MemberDoc | null> {
  return (await members(app).findOne({ team, sub } as never)) as unknown as MemberDoc | null
}

/** role ของผู้เรียกในทีมนั้น — null ถ้าไม่ได้อยู่ในทีม */
export async function roleIn(app: App, team: string | null | undefined, sub: string): Promise<TeamRole | null> {
  if (!team) return null
  return (await member(app, team, sub))?.role ?? null
}

/**
 * บังคับให้ผู้เรียกมีสิทธิ์ในทีมอย่างน้อยตามที่ระบุ
 *
 * ⚠️ ใช้ตัวนี้ทุกจุดที่แตะข้อมูลทีม ไม่งั้นจะมีจุดที่ลืมเช็ค
 */
export async function assertTeamRole(
  app: App,
  team: string,
  sub: string,
  min: TeamRole,
): Promise<MemberDoc> {
  const m = await member(app, team, sub)
  if (!m) throw new AppError('FORBIDDEN', 'คุณไม่ได้อยู่ในทีมนี้', 403)
  if (!roleAtLeast(m.role, min)) {
    throw new AppError('FORBIDDEN', `ต้องเป็น ${labelOfRole(min)} ของทีมจึงจะทำได้`, 403)
  }
  return m
}

/** ข้อความบอกสิทธิ์เป็นภาษาไทย ใช้ในข้อความ error */
export function labelOfRole(role: TeamRole): string {
  return { owner: 'เจ้าของทีม', admin: 'ผู้ดูแลทีม', editor: 'ผู้แก้ไข', viewer: 'ผู้ดู' }[role]
}

function toMemberView(d: MemberDoc): TeamMember {
  return {
    sub: d.sub ? String(d.sub) : null,
    name: d.name ?? null,
    email: d.email ?? null,
    role: d.role,
    at: d.at instanceof Date ? d.at : new Date(d.at),
    by: d.by ?? null,
    pending: !d.sub,
  }
}

/**
 * แปลงตัวระบุใน URL ให้เป็นเอกสารสมาชิก
 *
 * ⚠️ URL ใช้ `sub` ของผู้ใช้จริง หรืออีเมลของคนที่ยังรอผูก
 *   คนที่ยังไม่เคยเข้าระบบไม่มี `sub` → ต้องอ้างด้วยอีเมลแทน
 *   (ทางเลือกอื่นคือเพิ่ม id ให้ทุกแถว ซึ่งต้องแก้ URL + UI + test ทั้งชุด
 *    เปลี่ยนตอนนี้ยังไม่มีข้อมูลเก่าที่ต้องย้าย)
 */
async function resolveMember(
  app: App,
  team: string,
  who: MemberRef,
): Promise<MemberDoc | null> {
  const col = members(app)
  // อีเมลมี `@` เสมอ · `sub` ของ Casdoor ไม่มี
  if (who.includes('@')) {
    return (await col.findOne({ team, sub: null, email: normalizeEmail(who) } as never)) as unknown as MemberDoc | null
  }
  return (await col.findOne({ team, sub: who } as never)) as unknown as MemberDoc | null
}

const docOf = (app: App) => app.mongo.collection<{ _id: string; name: string; createdBy: string; createdAt: Date; updatedAt: Date }>(TEAMS)

/** ทีมทั้งหมดที่ผู้เรียกอยู่ — เรียงตามชื่อ ภาษาไทยเรียงแบบ locale */
export async function listMyTeams(app: App, req: Req): Promise<TeamAccess[]> {
  const { sub } = who(req)

  const rows = await members(app).find({ sub } as never).toArray()
  if (rows.length === 0) return []

  const teams = await docOf(app)
    .find({ _id: { $in: rows.map((r) => r.team) } } as never)
    .toArray()

  // นับสมาชิกและแม่แบบของทีมที่ผู้เรียกอยู่ทั้งหมด — รวมเป็น query เดียวแทน N+1
  const [memberCounts, templateCounts] = await Promise.all([
    members(app)
      .aggregate([{ $group: { _id: '$team', n: { $sum: 1 } } }] as never)
      .toArray() as Promise<{ _id: string; n: number }[]>,
    app.mongo
      .collection('template_access')
      .aggregate([
        { $match: { team: { $in: rows.map((r) => r.team) } } },
        { $group: { _id: '$team', n: { $sum: 1 } } },
      ] as never)
      .toArray() as Promise<{ _id: string; n: number }[]>,
  ])
  const mc = new Map(memberCounts.map((r) => [r._id, r.n]))
  const tc = new Map(templateCounts.map((r) => [r._id, r.n]))

  return teams
    .map((t) => ({
      team: String(t._id),
      name: t.name,
      role: rows.find((r) => r.team === String(t._id))?.role ?? null,
      memberCount: mc.get(String(t._id)) ?? 0,
      templateCount: tc.get(String(t._id)) ?? 0,
      createdAt: t.createdAt instanceof Date ? t.createdAt : new Date(t.createdAt),
    }))
    .sort((a, b) => a.name.localeCompare(b.name, 'th'))
}

/** รายละเอียดทีม + สมาชิก — คนนอกทีมดูได้แต่เห็น role ตัวเองเป็น null */
/**
 * ชื่อทีมจาก id — คืน `null` ถ้าไม่มีทีมนี้อยู่แล้ว
 *
 * ── ทำไมต้องมีตัวนี้ ไม่ใช้ getTeam ─────────────────────────────────────────────
 *   getTeam ดึงรายชื่อสมาชิกทั้งทีม + นับแม่แบบมาให้ด้วย
 *   ซึ่งเกินจำเป็นมากสำหรับที่แค่อยากรู้ว่าทีมนี้ชื่ออะไร (เช่นแปลงบุ๊กมาร์กเป็นข้อความ)
 *   และจะโยน error ถ้าทีมถูกลบไปแล้ว ซึ่งเป็นเรื่องที่ต้องจัดการ ไม่ใช่ข้อผิดพลาด
 */
export async function teamName(app: App, id: string): Promise<string | null> {
  const t = (await docOf(app).findOne({ _id: id } as never)) as { name?: unknown } | null
  return typeof t?.name === 'string' ? t.name : null
}

export async function getTeam(app: App, req: Req, id: string): Promise<TeamDetail> {
  const me = who(req)

  const t = await docOf(app).findOne({ _id: id } as never)
  if (!t) throw new NotFoundError('ทีม', id)

  const [rows, templateCount] = await Promise.all([
    members(app).find({ team: id } as never).toArray(),
    app.mongo.collection('template_access').countDocuments({ team: id } as never),
  ])

  const order: TeamRole[] = ['owner', 'admin', 'editor', 'viewer']
  rows.sort(
    (a, b) =>
      // คนที่ยังรอผูกไปท้ายสุดเสมอ — เพราะยังไม่มีชื่อจริงให้เทียบ
      Number(!a.sub) - Number(!b.sub) ||
      order.indexOf(a.role) - order.indexOf(b.role) ||
      (a.name ?? a.email ?? '').localeCompare(b.name ?? b.email ?? '', 'th'),
  )

  return {
    team: String(t._id),
    name: t.name,
    createdAt: t.createdAt instanceof Date ? t.createdAt : new Date(t.createdAt),
    members: rows.map(toMemberView),
    myRole: rows.find((r) => r.sub === me.sub)?.role ?? null,
    templateCount,
    meEmail: me.email ?? null,
  }
}

// ── การเขียน ────────────────────────────────────────────────────

/** สร้างทีมใหม่ — ผู้สร้างเป็น owner คนแรกเสมอ */
export async function createTeam(app: App, req: Req, body: CreateTeamBody): Promise<TeamDetail> {
  const me = who(req)
  const id = newId('team')
  const at = now()

  await docOf(app).insertOne({
    _id: id,
    name: body.name.trim(),
    createdBy: me.sub,
    createdAt: at,
    updatedAt: at,
  } as never)

  const col = members(app)
  const docs: MemberDoc[] = [
    {
      team: id,
      sub: me.sub,
      name: me.name,
      email: me.email,
      role: 'owner',
      at,
      by: null,
    },
    // ข้ามอีเมลที่ตรงกับผู้สร้าง ไม่งั้นจะมี owner 2 คนในบรรทัดเดียว
    ...body.members
      .filter((m) => m.email !== normalizeEmail(me.email))
      .map<MemberDoc>((m) => ({
        team: id,
        sub: null,
        name: null,
        email: normalizeEmail(m.email),
        role: m.role,
        at,
        by: me.sub,
      })),
  ]
  await col.insertMany(docs as never)

  app.log.info({ team: id, name: body.name, members: docs.length }, 'สร้างทีมแล้ว')
  return getTeam(app, req, id)
}

/** เปลี่ยนชื่อทีม */
export async function renameTeam(
  app: App,
  req: Req,
  id: string,
  name: string,
): Promise<{ name: string }> {
  const { sub } = who(req)
  await assertTeamRole(app, id, sub, 'admin')

  const name2 = name.trim()
  if (!name2) throw new AppError('VALIDATION', 'ชื่อทีมห้ามว่าง', 400)

  await docOf(app).updateOne({ _id: id } as never, { $set: { name: name2, updatedAt: now() } } as never)
  app.log.info({ team: id, name: name2 }, 'เปลี่ยนชื่อทีมแล้ว')
  return { name: name2 }
}

/**
 * ลบทีม
 *
 * ⚠️ แม่แบบของทีม**ไม่ถูกลบ** — ถอน `team` ออกให้กลับเป็นของคนที่อัปโหลด
 *   ถ้าลบแม่แบบทิ้งไปด้วย = คนที่อัปโหลดเสียงานที่ทำไว้ทั้งชุดโดยไม่ได้เตือน
 *   และถ้าไม่ถอน `team` ไว้ แม่แบบจะติด team id ที่ไม่มีอยู่จริง = เข้าไม่ได้อีก
 */
export async function deleteTeam(
  app: App,
  req: Req,
  id: string,
): Promise<{ templatesReleased: number; bookmarksReleased: number }> {
  const { sub } = who(req)
  await assertTeamRole(app, id, sub, 'owner')

  const res = await app.mongo
    .collection('template_access')
    .updateMany({ team: id } as never, { $set: { team: null, updatedAt: now() } } as never)

  /*
   * ⚠️ บุ๊กมาร์กที่เก็บไว้ในทีมนี้ต้องถูกคืนเป็น**ส่วนตัว**ของผู้กดดาว
   *   ไม่งั้นบุ๊กมาร์กจะชี้ไปทีมที่ถูกลบไปแล้ว
   *   → แท็บบุ๊กมาร์กแสดงชื่อทีมค้าง/ว่าง และถ้าเอาทีมนี้เป็นตัวเลือกตอนย้ายที่เก็บ
   *     ผู้ใช้จะเห็นตัวเลือกที่กดแล้วไม่ได้อะไร โดยไม่มี error
   *   เหตุผลที่ต้องทำ: บุ๊กมาร์กเป็นของผู้ใช้ ไม่ควรหายไปกับทีม
   */
  const bm = await app.mongo
    .collection('bookmarks')
    .updateMany({ team: id } as never, { $set: { team: null } } as never)

  await members(app).deleteMany({ team: id } as never)
  await docOf(app).deleteOne({ _id: id } as never)

  app.log.info(
    { team: id, templatesReleased: res.modifiedCount, bookmarksReleased: bm.modifiedCount },
    'ลบทีมแล้ว',
  )
  return { templatesReleased: res.modifiedCount, bookmarksReleased: bm.modifiedCount }
}

/**
 * เชิญสมาชิกเข้าทีม **ด้วยอีเมล**
 *
 * ⚠️ เราไม่มีที่เก็บรายชื่อผู้ใช้ และไม่อยากเรียก Casdoor API
 *   → คนที่ยังไม่เคยเข้าระบบ จะถูกเก็บเป็นแถว "รอผูก" (`sub: null` + `email`)
 *   แล้วผูกให้อัตโนมัติตอนเขาเข้าสู่ระบบครั้งแรก (`claimPendingInvites`)
 *   เชิญซ้ำด้วยอีเมลเดิม = อัปเดต role ของแถวเดิม ไม่ใช่เพิ่มคนใหม่
 */
export async function addMember(
  app: App,
  req: Req,
  id: string,
  body: AddMemberBody,
): Promise<TeamMember> {
  const me = who(req)
  await assertTeamRole(app, id, me.sub, 'admin')

  const email = normalizeEmail(body.email)
  if (email && email === normalizeEmail(me.email)) {
    throw new AppError('BAD_REQUEST', 'คุณอยู่ในทีมนี้อยู่แล้ว', 422)
  }

  const at = now()
  // ไม่ allow `role: 'owner'` ตรงนี้ — การเพิ่ม owner ใหม่ต้องเป็นการเลื่อน role
  // ของคนที่อยู่ทีมอยู่แล้ว (ดู updateMember) ไม่งั้นจะมีทางเพิ่ม owner
  // โดยไม่ผ่านการเช็คว่าทีมยังมี owner คนอื่นเหลือ
  await members(app).updateOne(
    { team: id, sub: null, email } as never,
    { $set: { role: body.role, at, by: me.sub } } as never,
    { upsert: true },
  )

  app.log.info({ team: id, email, role: body.role }, 'เชิญสมาชิกทีมแล้ว')
  return toMemberView((await resolveMember(app, id, email))!)
}

/**
 * ผูกแถว "รอผูก" เข้ากับผู้ใช้จริง — เรียกตอนเข้าสู่ระบบสำเร็จ
 *
 * ⚠️ กรณี "เชิญคนที่เป็นสมาชิกอยู่แล้วด้วยอีเมลเดิม" (พิมพ์ผิด/เชิญซ้ำ)
 *   เราหา `sub` ของสมาชิกเดิมไม่ได้ เพราะไม่ได้เก็บอีเมลไว้
 *   → คงแถวเดิมไว้ (สิทธิ์ที่เขามีอยู่จริง) แล้ว**ลบแถวรอผูกทิ้ง**
 *   ไม่งั้นคนเดียวจะมีสองแถวในทีมเดียว นับสมาชิกผิด
 */
export async function claimPendingInvites(app: App, user: SessionUser): Promise<number> {
  const email = normalizeEmail(user.email)
  if (!email || !user.sub) return 0

  const pending = await members(app).find({ sub: null, email } as never).toArray()
  if (pending.length === 0) {
    // ไม่มีแถวรอ แต่ยังเติมชื่อให้แถวเก่าที่เคยเชิญด้วย `sub` ไว้ได้
    await members(app).updateMany(
      { sub: user.sub, name: null } as never,
      { $set: { name: user.name } } as never,
    )
    return 0
  }

  let claimed = 0
  for (const row of pending) {
    const dup = await member(app, row.team, user.sub)
    if (dup) {
      await members(app).deleteOne({ team: row.team, sub: null, email } as never)
      continue
    }
    await members(app).updateOne(
      { team: row.team, sub: null, email } as never,
      // ⚠️ ลบ `email` ทิ้งทันทีที่ผูกสำเร็จ — หลักการเดียวกับ `/account`:
      //   ข้อมูลประจำตัวอ่านสดจาก session เก็บซ้ำจะเพี้ยนเมื่อผู้ใช้เปลี่ยนอีเมลที่ Casdoor
      { $set: { sub: user.sub, name: user.name }, $unset: { email: '' } } as never,
    )
    claimed++
  }

  if (claimed > 0) app.log.info({ sub: user.sub, email, teams: claimed }, 'ผูกสมาชิกที่รอเข้าระบบแล้ว')
  return claimed
}

/**
 * เปลี่ยนสิทธิ์สมาชิก
 *
 * ⚠️ ข้อ 1 ในหัวไฟล์: ห้ามลด role ของ owner คนสุดท้าย
 *   เช็ค "คนนี้เป็น owner อยู่ไหม" ก่อน แล้วค่อยดูว่าเหลือ owner อีกกี่คน
 */
export async function updateMember(
  app: App,
  req: Req,
  id: string,
  targetRef: MemberRef,
  role: TeamRole,
): Promise<TeamMember> {
  const me = who(req)

  const target = await resolveMember(app, id, targetRef)
  if (!target) throw new NotFoundError('สมาชิก', targetRef)

  // ห้ามลดสิทธิ์ตัวเองถ้าตัวเองเป็น owner — กันเผลอทำทีมตัวเองค้าง
  // (เจ้าของคนเดียวกดลดสิทธิ์ตัวเองแล้วไม่มีใครเลื่อนตัวเองกลับได้อีก)
  // คนที่ยังรอผูก (`sub: null`) จับคู่กับเราเองไม่ได้อยู่แล้ว → ข้ามไป
  if (target.sub === me.sub && target.role === 'owner' && role !== 'owner') {
    throw new AppError(
      'FORBIDDEN',
      'เจ้าของทีมคนสุดท้ายย้ายสิทธิ์เจ้าของให้คนอื่นก่อน หรือเพิ่มเจ้าของคนใหม่',
      403,
    )
  }

  if (target.role === 'owner' && role !== 'owner') {
    await assertNotLastOwner(app, id, target.sub as string)
  }

  await members(app).updateOne(
    { team: id, sub: target.sub, ...(target.sub === null ? { email: target.email } : {}) } as never,
    { $set: { role } } as never,
  )
  app.log.info({ team: id, target: targetRef, role }, 'เปลี่ยนสิทธิ์สมาชิกแล้ว')
  return toMemberView((await resolveMember(app, id, targetRef))!)
}

/** ถอนสมาชิก — เช็ค owner คนสุดท้ายเหมือนกัน */
export async function removeMember(app: App, req: Req, id: string, targetRef: MemberRef): Promise<void> {
  const me = who(req)

  const target = await resolveMember(app, id, targetRef)
  if (!target) throw new NotFoundError('สมาชิก', targetRef)

  if (target.sub === me.sub && target.role === 'owner') {
    throw new AppError('FORBIDDEN', 'เจ้าของทีมคนสุดท้ายออกจากทีมไม่ได้', 403)
  }
  if (target.role === 'owner') {
    await assertNotLastOwner(app, id, target.sub as string)
  }

  await members(app).deleteOne(
    { team: id, sub: target.sub, ...(target.sub === null ? { email: target.email } : {}) } as never,
  )

  /*
   * ⚠️ บุ๊กมาร์กที่คนนี้เก็บไว้ในทีมนี้ต้องกลับเป็น**ส่วนตัว**
   *   ไม่งั้นหลังออกจากทีม เขาจะเห็นบุ๊กมาร์กที่ชี้ไปทีมที่ตัวเองไม่มีสิทธิ์แล้ว
   *   และถ้ากดย้ายที่เก็บจะได้ 403 โดยที่เห็นไม่บอกว่าทำไม
   *   `target.sub` เป็น null ได้เมื่อเป็นแถว "รอเข้าระบบ" (ยังไม่เคยล็อกอิน) → ข้ามไป
   */
  if (target.sub) {
    await app.mongo
      .collection('bookmarks')
      .updateMany({ user: target.sub, team: id } as never, { $set: { team: null } } as never)
  }

  app.log.info({ team: id, removed: targetRef, by: me.sub }, 'ถอนสมาชิกออกจากทีมแล้ว')
}

/**
 * กันไม่ให้ owner คนสุดท้ายหลุดสิทธิ์ — ใช้ร่วมกันทั้ง "ลด role" และ "ถอนสมาชิก"
 */
async function assertNotLastOwner(app: App, team: string, sub: string): Promise<void> {
  const owners = await members(app).countDocuments({ team, role: 'owner' } as never)
  if (owners <= 1) {
    throw new AppError(
      'FORBIDDEN',
      'ทีมต้องมีเจ้าของอย่างน้อย 1 คน — เลื่อนคนอื่นเป็นเจ้าของก่อน',
      403,
    )
  }
}
