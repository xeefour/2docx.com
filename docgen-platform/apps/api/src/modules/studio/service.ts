import {
  now,
  newId,
  AppError,
  NotFoundError,
  mergeAiData,
  roleAtLeast,
  sampleValueFor,
  type FieldDef,
  type FormSchema,
  type AccessEntry,
  type AccessView,
  type Visibility,
  type AccessRole,
  type TeamRole,
  type ChatSession,
  type ChatMessage,
  type BookmarkRecord,
  type TemplateHistory,
  type MyTemplateHistory,
  type MyHistoryItem,
} from '@docgen/shared'
import type { App } from '../../types.js'
import * as carbone from '../templates/carbone.js'
import { readTemplateTags } from '../templates/tags.js'
import { askLlm, type ChatTurn } from './llm.js'
import { notify, notifyMany } from './notifications.js'
import * as teams from '../teams/service.js'


/**
 * service ของฟีเจอร์ Studio: ฟอร์มที่ผู้ใช้ออกแบบเอง · การแชร์ · แชทกับ AI
 * · บุ๊กมาร์ก · ประวัติการสร้างเอกสาร
 *
 * ── โมเดลการเข้าถึง (สรุปให้จำ) ──────────────────────────────
 * ทุกอย่างผูกกับ `templateKey` = `TemplateSummary.id` ของ Carbone (เลข 64-bit)
 * ไม่ใช่ versionId — เพราะแม่แบบทุกเวอร์ชันควรใช้ฟอร์ม/สิทธิ์ชุดเดียวกัน
 *
 *   · ยังไม่มีเอกสารสิทธิ์            → `published` และทุกคนแก้ได้ (ตรงกับพฤติกรรมเดิม)
 *   · มีเอกสารสิทธิ์แล้ว               → เจ้าของ + ผู้ที่ถูกแชร์เท่านั้นที่แตะได้
 *   · เจ้าของ = คนแรกที่ "ตั้งค่าการแชร์" ของแม่แบบนั้น
 *     (การบันทึกฟอร์มไม่ผูกยึดเจ้าของ เพราะจะทำให้แม่แบบที่ทุกคนแก้ได้
 *      กลายเป็นของคนเดียวโดยที่ไม่ได้ตั้งใจ)
 */

const FORMS = 'form_schemas'
const ACCESS = 'template_access'
const CHATS = 'chat_sessions'
const BOOKMARKS = 'bookmarks'

/** ข้อความแชทสูงสุดที่เก็บต่อ session — กันไฟล์ใน Mongo บวม */
const MAX_MESSAGES = 200

// ── ผู้ใช้ปัจจุบัน ────────────────────────────────────────────

type Req = { user?: { sub: string; name?: string } | null }

/** ผู้เรียกปัจจุบัน — export ให้โมดูลอื่น (เช่น templates) ใช้ตรวจสิทธิ์ */
export function who(req: Req): { sub: string; name: string | null } {
  const u = req.user
  if (!u?.sub) throw new AppError('AUTH_REQUIRED', 'ยังไม่ได้เข้าสู่ระบบ', 401)
  return { sub: u.sub, name: u.name ?? null }
}

// ── ฟอร์ม (ฟิลด์ที่ผู้ใช้ออกแบบเอง) ───────────────────────────

/**
 * อ่านฟอร์มของแม่แบบ — ถ้ายังไม่มี คืนค่า null ให้หน้าเว็บตัดสินใจว่าจะเติมจากแท็กไหม
 *
 * ใช้ `_id` = templateKey → upsert ได้โดยไม่ต้องมี index เพิ่ม
 */
export async function getFormSchema(
  app: App,
  templateKey: string,
): Promise<FormSchema | null> {
  const raw = await app.mongo.collection<FormSchema>(FORMS).findOne({
    _id: templateKey,
  } as never)
  if (!raw) return null
  return { ...(raw as FormSchema), _id: String((raw as { _id: unknown })._id) }
}

export async function saveFormSchema(
  app: App,
  input: { templateKey: string; fields: FieldDef[]; name?: string | null },
  req: Req,
): Promise<FormSchema> {
  const user = who(req)
  await assertCanEdit(app, input.templateKey, user.sub)

  // กัน key ซ้ำ — ซ้ำแล้วฟอร์มจะเขียนทับกันเงียบ ๆ ซึ่งแก้ยากกว่าพูดตรง ๆ
  const seen = new Set<string>()
  for (const f of input.fields) {
    if (seen.has(f.key)) {
      throw new AppError('DUPLICATE_FIELD', `มีช่อง "${f.key}" ซ้ำกันสองครั้ง`, 422)
    }
    seen.add(f.key)
  }

  const doc: FormSchema = {
    _id: input.templateKey,
    templateKey: input.templateKey,
    name: input.name ?? null,
    fields: input.fields,
    updatedAt: now(),
    updatedBy: user.sub,
  }

  await app.mongo
    .collection<FormSchema>(FORMS)
    .replaceOne({ _id: input.templateKey } as never, doc as never, { upsert: true })

  return doc
}

/**
 * สร้างฟิลด์อัตโนมัติจากแท็ก `{d.*}` ที่แม่แบบใช้จริง
 *
 * ช่วยตอนผู้ใช้เพิ่งอัปโหลดแม่แบบแล้วยังไม่ได้ตั้งฟอร์ม
 * — ข้ามแท็กที่มีอยู่แล้ว แล้วเติมกลับเข้าไป (ไม่ทับของที่ตั้งไว้)
 */
export async function importTagsToForm(
  app: App,
  input: { versionId: string; templateKey: string; tags: string[] },
  req: Req,
): Promise<FormSchema> {
  const user = who(req)
  await assertCanEdit(app, input.templateKey, user.sub)

  const existing = (await getFormSchema(app, input.templateKey))?.fields ?? []
  const have = new Set(existing.map((f) => f.key))

  const added: FieldDef[] = []
  const order = existing.length
  for (const tag of input.tags) {
    if (!tag || have.has(tag)) continue
    added.push({
      key: tag,
      label: tag,
      type: 'text',
      group: '',
      order: order + added.length,
      required: false,
      ai: { enabled: true },
    })
  }

  const fields = [...existing, ...added]
  const doc: FormSchema = {
    _id: input.templateKey,
    templateKey: input.templateKey,
    name: (await getFormSchema(app, input.templateKey))?.name ?? null,
    fields,
    updatedAt: now(),
    updatedBy: user.sub,
  }

  await app.mongo
    .collection<FormSchema>(FORMS)
    .replaceOne({ _id: input.templateKey } as never, doc as never, { upsert: true })

  return doc
}

/** ค่าเริ่มต้นของทุกช่อง — ใช้เปิดฟอร์มครั้งแรกให้ไม่ว่างเปล่า */
export function fieldDefaults(fields: FieldDef[]): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const f of fields) out[f.key] = sampleValueFor(f)
  return out
}

/** ล้างฟอร์มทั้งหมด → หน้าเว็บจะกลับไปใช้ช่องจากแท็กอัตโนมัติแทน */
export async function deleteFormSchema(app: App, templateKey: string, req: Req): Promise<void> {
  const user = who(req)
  await assertCanEdit(app, templateKey, user.sub)
  await app.mongo.collection<FormSchema>(FORMS).deleteOne({ _id: templateKey } as never)
  app.log.info({ templateKey }, 'ล้างฟอร์มของแม่แบบแล้ว')
}

// ── การแชร์และสิทธิ์ ──────────────────────────────────────────

type AccessDoc = AccessEntry & { _id: string }

async function loadAccess(app: App, templateKey: string): Promise<AccessDoc | null> {
  const raw = await app.mongo
    .collection<AccessDoc>(ACCESS)
    .findOne({ _id: templateKey } as never)
  if (!raw) return null
  return { ...(raw as AccessDoc), _id: String((raw as { _id: unknown })._id) }
}

/**
 * แปลงเอกสารสิทธิ์เป็นมุมมองของผู้ใช้คนนี้
 *
 * ⚠️ ลำดับความสำคัญ (อ่านตามลำดับนี้ ไม่งั้นสิทธิ์จะซ้อนกัน):
 *   1. **เจ้าของส่วนตัว** — เจ้าของจริงเสมอ ไม่ว่าจะอยู่ทีมหรือไม่
 *   2. **สมาชิกทีม** — ได้สิทธิ์ตาม role ในทีม (editor ขึ้นไปแก้ได้)
 *   3. **ถูกแชร์รายคน** — สิทธิ์ที่เจ้าของให้เฉพาะราย
 *   4. **เปิดสาธารณ** — ตามกติกาเดิม ทุกคนแก้ได้
 *
 *   สมาชิกทีมมาก่อนการแชร์รายคน เพราะแม่แบบของทีมควรให้สิทธิ์ตามทีม
 *   ไม่ใช่ตามรายคนที่ถูกแชร์ (ถ้าสลับ สมาชิกทีมที่ถูกลดเป็น viewer
 *   ส่วนตัวจะกลับมาได้สิทธิ์เต็มเพราะเคยถูกแชร์ role editor ค้างไว้)
 */
function toView(
  doc: AccessDoc | null,
  templateKey: string,
  sub: string,
  teamRole: TeamRole | null = null,
  teamName: string | null = null,
): AccessView {
  if (!doc) {
    // ยังไม่มีใครตั้งค่าการแชร์ → เปิดสาธารณ แก้ได้ทุกคน (พฤติกรรมเดิมของระบบ)
    return {
      templateKey,
      relation: 'published',
      role: null,
      teamRole: null,
      canEdit: true,
      visibility: 'published',
      owner: null,
      ownerName: null,
      team: null,
      teamName: null,
      sharedWith: [],
    }
  }

  const isOwner = doc.owner === sub
  // สมาชิกทีม = แม่แบบนี้มีทีม **และ** ผู้เรียกอยู่ในทีมนั้น (ขาดอย่างใดอย่างหนึ่ง = ไม่ใช่)
  const isTeamMember = Boolean(doc.team && teamRole)
  const shared = doc.sharedWith.find((s) => s.sub === sub) ?? null

  let relation: AccessView['relation'] = 'published'
  if (isOwner) relation = 'owner'
  else if (isTeamMember) relation = 'team'
  else if (shared) relation = 'shared'

  /**
   * สมาชิกทีมแก้ได้ตั้งแต่ `editor` ขึ้นไป
   * `admin`/`owner` ก็แก้ได้อยู่แล้ว (สูงกว่า editor)
   */
  const teamCanEdit = roleAtLeast(teamRole, 'editor')

  /**
   * ⚠️ ซ่อนรายชื่อผู้ถูกแชร์เมื่อผู้เรียกไม่มีสิทธิ์จริง
   *
   *   เคยส่ง `sharedWith` ให้ทุกคนที่ยิง `GET /api/access/:key`
   *   แม้แม่แบบเป็น private → ใครก็รู้ว่าแม่แบบนี้ของใคร แชร์ให้ใครบ้าง
   *   (เป็นของเดิมตั้งแต่ก่อนมีระบบทีม แต่ทีมทำให้ร้ายขึ้น
   *   เพราะจะเห็นทั้งรายชื่อสมาชิกทีมด้วย)
   *
   *   คง `200` + `canEdit: false` ไว้ เพราะหน้าเว็บใช้บอกว่า "คุณแก้ไม่ได้"
   *   ถ้าตอบ 403 หน้าแก้ไขจะพัง (เคยคิดจะเปลี่ยน แล้วพังกว่าที่คาด)
   */
  const hasRelation = isOwner || isTeamMember || Boolean(shared)
  const redact = doc.visibility === 'private' && !hasRelation

  return {
    templateKey,
    relation,
    role: isOwner ? 'editor' : (shared?.role ?? null),
    teamRole: isTeamMember ? teamRole : null,
    // ⚠️ เปิดสาธารณ = แก้ได้ทุกคน (หน้าเว็บเขียนไว้ตรงนี้ตั้งแต่แรก)
    //   เคยคิดว่า published แค่ "ดูได้" → พอมีเอกสารสิทธิ์ปุ๊บ แม่แบบที่เปิดสาธารณ
    //   กลับกลายเป็น "แก้ได้คนเดียว" ทั้งที่ข้อความบนหน้าจอยังบอกว่าทุกคนแก้ได้
    canEdit: isOwner || teamCanEdit || shared?.role === 'editor' || doc.visibility === 'published',
    visibility: doc.visibility,
    owner: doc.owner,
    ownerName: doc.ownerName,
    team: redact ? null : (doc.team ?? null),
    teamName: isTeamMember ? teamName : null,
    sharedWith: redact ? [] : doc.sharedWith,
  }
}

/**
 * แม่แบบนี้เป็นของทีม และผู้เรียกเป็น admin ของทีมนั้นไหม
 *
 * ใช้กับการกระทำ**ระดับการจัดการ** (เปลี่ยน visibility · เพิ่มคนแชร์ · ถอนสิทธิ์ · ล้างการตั้งค่า)
 * ซึ่งเดิมอนุญาตแค่เจ้าของส่วนตัว — ทีมต้องทำแทนได้ ไม่งั้นผู้ที่อัปโหลด
 * จะเป็นคนเดียวที่คุมแม่แบบของทีมตลอดชีวิต
 *
 * @param team  ทีมของแม่แบบ — null/ไม่มี = ไม่ใช่แม่แบบของทีม → false
 */
async function isTeamAdmin(app: App, team: string | null | undefined, sub: string): Promise<boolean> {
  if (!team) return false
  return roleAtLeast(await teams.roleIn(app, team, sub), 'admin')
}

/** บังคับให้เป็น admin ของทีม — ใช้เมื่อผู้เรียกไม่ใช่เจ้าของส่วนตัว */
async function assertTeamAdmin(
  app: App,
  team: string | null | undefined,
  sub: string,
  message: string,
): Promise<void> {
  if (await isTeamAdmin(app, team, sub)) return
  throw new AppError('FORBIDDEN', message, 403)
}

/**
 * โหลด AccessDoc + role ของผู้เรียกในทีมเจ้าของ มาพร้อมกัน
 *
 * ⚠️ `toView` เดิมรับแค่ AccessDoc ซึ่ง**ไม่พอ**เมื่อมีทีม
 *   เพราะต้องรู้ว่าผู้เรียกเป็นสมาชิกทีมนั้นหรือไม่ ถึงจะตัดสินใจเรื่องสิทธิ์ได้
 *   ถ้าเดาเองว่า "มี field team = คนนี้มีสิทธิ์" จะเปิดแม่แบบทีมให้คนนอกทีม
 */
async function loadView(
  app: App,
  templateKey: string,
  sub: string,
): Promise<AccessView> {
  const doc = await loadAccess(app, templateKey)
  const team = doc?.team ?? null
  if (!team) return toView(doc, templateKey, sub)

  const [role, teamDoc] = await Promise.all([
    teams.roleIn(app, team, sub),
    app.mongo.collection<{ _id: string; name: string }>('teams').findOne({ _id: team } as never),
  ])
  return toView(doc, templateKey, sub, role, teamDoc?.name ?? null)
}

export async function getAccessView(
  app: App,
  templateKey: string,
  req: Req,
): Promise<AccessView> {
  const { sub } = who(req)
  return loadView(app, templateKey, sub)
}

/**
 * ตรวจว่าแก้สิทธิ์/ฟอร์มของแม่แบบนี้ได้ไหม
 *
 * export ให้โมดูล `templates` ใช้ตรวจก่อนอัปโหลดไฟล์แทนแม่แบบ
 * (การเขียนทับแม่แบบกระทบคนทุกคน จึงต้องเข้มกว่าแก้ metadata)
 */
export async function assertCanEdit(app: App, templateKey: string, sub: string): Promise<void> {
  const view = await loadView(app, templateKey, sub)
  if (!view.canEdit) {
    throw new AppError(
      'FORBIDDEN',
      view.visibility === 'private'
        ? 'แม่แบบนี้เป็นแบบส่วนตัว — ขอสิทธิ์จากเจ้าของก่อน'
        : 'คุณมีสิทธิ์แค่ดูอย่างเดียวสำหรับแม่แบบนี้',
      403,
    )
  }
}

/**
 * ตรวจว่า**เห็น**แม่แบบนี้ได้ไหม (ใช้กับการดาวน์โหลดไฟล์แม่แบบ)
 *
 * ⚠️ แม่แบบส่วนตัวที่ไม่ได้แชร์ให้เรา = ห้ามดาวน์โหลด
 *    ไม่งั้นใครก็กด URL ได้ แม้หน้าเว็บจะไม่โชว์ปุ่ม
 */
/**
 * ผู้อัปโหลดแม่แบบใหม่ = เป็นเจ้าของแม่แบบนั้นทันที
 *
 * ผู้ใช้สั่ง: *"สิทธิ์เจ้าของแม่แบบ — เสนอให้ผู้อัปโหลดเป็นเจ้าของอัตโนมัติ"*
 *
 * ⚠️ **แย่งไม่ได้** — ถ้ามีเจ้าของอยู่แล้วจะไม่ทำอะไรเลย ไม่ว่าจะอัปโหลดกี่ครั้ง
 * ⚠️ เรียกจาก route ที่ "สร้างแม่แบบใหม่" เท่านั้น ห้ามเรียกจาก `replace`
 *    เพราะ replace คือการเขียนทับของเดิม สิทธิ์เดิมต้องไม่ขยับ
 *
 * คืน `claimed` = ตั้งเจ้าของให้แล้ว · `kept` = มีเจ้าของอยู่แล้ว · `skipped` = ไม่มี key ให้ทำ
 */
export async function claimOwner(
  app: App,
  templateKey: string,
  req: Req,
): Promise<'claimed' | 'kept' | 'skipped'> {
  const user = who(req)
  if (!templateKey) return 'skipped'

  const existing = await loadAccess(app, templateKey)
  if (existing?.owner) return 'kept'

  const doc: AccessDoc = {
    _id: templateKey,
    templateKey,
    // ค่าเริ่มต้นเป็นเปิดสาธารณ ไม่ใช่ส่วนตัว
    //   ถ้าใส่ private ตั้งแต่แรก ผู้ใช้ที่เพิ่งอัปโหลดจะเอาลิงก์ไปส่งให้ใครไม่ได้เลย
    visibility: existing?.visibility ?? 'published',
    owner: user.sub,
    ownerName: user.name,
    sharedWith: existing?.sharedWith ?? [],
    updatedAt: now(),
  }

  await app.mongo
    .collection<AccessDoc>(ACCESS)
    .replaceOne({ _id: templateKey } as never, doc as never, { upsert: true })

  app.log.info({ templateKey, owner: user.sub }, 'ผู้อัปโหลดกลายเป็นเจ้าของแม่แบบอัตโนมัติ')
  return 'claimed'
}

/**
 * ตรวจว่า**เขียนทับไฟล์แม่แบบ**ได้ไหม — เข้มกว่าการแก้ฟอร์ม
 *
 * ผู้ใช้เลือกกติกานี้เอง: *"แก้ฟอร์มได้ทุกคน แต่เปลี่ยนไฟล์แม่แบบต้องเป็นเจ้าของเท่านั้น"*
 *   เพราะการเขียนทับกระทบคนที่ใช้แม่แบบนี้อยู่ทุกคน ไม่ใช่แค่แก้ช่องกรอกของตัวเอง
 *
 * ⚠️ แม่แบบที่**ยังไม่มีเจ้าของ** = ยังไม่มีใครคุม (ที่อัปโหลดไว้ก่อนมีระบบนี้)
 *   ให้ผ่านไปก่อน เหมือนกติกาของ `setVisibility` กับ `trashTemplate`
 *   ไม่งั้นแม่แบบเก่าทั้งหมดจะกลายเป็น "แก้ไขไม่ได้เลย" ใครก็ทำอะไรไม่ได้
 */
export async function assertCanReplace(app: App, templateKey: string, sub: string): Promise<void> {
  const view = await loadView(app, templateKey, sub)
  if (view.owner && view.relation !== 'owner') {
    throw new AppError('FORBIDDEN', 'เปลี่ยนไฟล์แม่แบบได้เฉพาะเจ้าของเท่านั้น', 403)
  }
}

export async function assertCanView(app: App, templateKey: string, sub: string): Promise<void> {
  const view = await loadView(app, templateKey, sub)
  if (view.visibility === 'private' && view.relation !== 'owner' && view.relation !== 'shared') {
    throw new AppError('FORBIDDEN', 'แม่แบบนี้เป็นแบบส่วนตัว — ขอสิทธิ์จากเจ้าของก่อน', 403)
  }
}

/**
 * ตั้งค่า publish / private
 *
 * คนแรกที่เรียกฟังก์นี้ของแม่แบบนั้นกลายเป็นเจ้าของโดยอัตโนมัติ
 */
export async function setVisibility(
  app: App,
  input: { templateKey: string; visibility: Visibility },
  req: Req,
): Promise<AccessView> {
  const user = who(req)
  const existing = await loadAccess(app, input.templateKey)

  // ถ้ามีเจ้าของอยู่แล้วและเราไม่ใช่ → ไม่ยอมให้เปลี่ยน
  //
  // ⚠️ ห้ามใช้ `assertCanEdit` ตรงนี้
  //   เพราะ `canEdit` บอกว่า "เปิดสาธารณ = ทุกคนแก้ได้" (กติกาใหม่)
  //   ถ้าใช้ตรงนี้ คนอื่นจะพลิกแม่แบบของเจ้าของเป็นส่วนตัวได้
  //   การเปลี่ยน visibility เป็นการจัดการ ไม่ใช่การแก้ฟอร์ม → ต้องเจ้าของเท่านั้น
  //
  // ⚠️ แต่ **admin ของทีมเจ้าของแม่แบบนั้น** ต้องเปลี่ยนได้
  //   ไม่งั้นแม่แบบของทีมจะตั้ง visibility ไม่ได้เลย
  //   แม้คนที่อัปโหลดจะออกจากทีมไปแล้วก็ตาม (ทีมเป็นเจ้าของร่วม)
  if (existing?.owner && existing.owner !== user.sub) {
    await assertTeamAdmin(app, existing.team, user.sub, 'เฉพาะเจ้าของทีมเท่านั้นที่เปลี่ยนการมองเห็นแม่แบบของทีมได้')
  }

  const doc: AccessDoc = {
    _id: input.templateKey,
    templateKey: input.templateKey,
    visibility: input.visibility,
    owner: existing?.owner ?? user.sub,
    ownerName: existing?.ownerName ?? user.name,
    sharedWith: existing?.sharedWith ?? [],
    updatedAt: now(),
  }

  await app.mongo
    .collection<AccessDoc>(ACCESS)
    .replaceOne({ _id: input.templateKey } as never, doc as never, { upsert: true })

  app.log.info(
    { templateKey: input.templateKey, visibility: input.visibility, owner: doc.owner },
    'อัปเดตการแชร์แม่แบบ',
  )

  /**
   * แจ้งคนที่ถูกแชร์ เมื่อเจ้าของพลิกแม่แบบเป็นสาธารณ/ส่วนตัว
   *
   * ⚠️ แจ้งเฉพาะตอน**เปลี่ยนจริง**
   *   ถ้าไม่เช็คค่าเดิม การกด "เปิดสาธารณ" ซ้ำ ๆ จะทำให้กล่องจดหมาย
   *   ของทุกคนรกขึ้นทุกครั้งที่กด ซึ่งแย่กว่าไม่แจ้งเลย
   *   และการตั้งค่าครั้งแรก (ยังไม่มี existing) ไม่ใช่ "การเปลี่ยน"
   */
  const visBefore = existing?.visibility
  if (visBefore && visBefore !== input.visibility) {
    const opened = input.visibility === 'published'
    await notifyMany(
      app,
      doc.sharedWith.map((s) => s.sub),
      {
        kind: 'system',
        title: opened ? 'เปิดแม่แบบเป็นสาธารณแล้ว' : 'แม่แบบนี้กลับไปเป็นแบบส่วนตัวแล้ว',
        body: opened
          ? `${user.name ?? 'เจ้าของ'} เปิดแม่แบบนี้ให้ทุกคนเข้ามาแก้ได้`
          : `${user.name ?? 'เจ้าของ'} ปิดแม่แบบนี้เป็นแบบส่วนตัว — สิทธิ์ที่เคยได้จากการแชร์ยังอยู่`,
        link: `/studio/${input.templateKey}`,
      },
    )
  }

  return toView(doc, input.templateKey, user.sub)
}

/** เพิ่มคนเข้าใช้งาน — เจ้าของเท่านั้นที่เรียกได้ */
export async function addShare(
  app: App,
  input: { templateKey: string; sub: string; name?: string; role: AccessRole },
  req: Req,
): Promise<AccessView> {
  const user = who(req)
  const existing = await loadAccess(app, input.templateKey)

  if (existing && existing.owner !== user.sub) {
    await assertTeamAdmin(app, existing.team, user.sub, 'เฉพาะเจ้าของทีมเท่านั้นที่เพิ่มคนอื่นเข้าแม่แบบของทีมได้')
  }
  if (input.sub === user.sub) {
    throw new AppError('BAD_REQUEST', 'เจ้าของอยู่ในรายชื่ออยู่แล้ว', 422)
  }

  const doc: AccessDoc = {
    _id: input.templateKey,
    templateKey: input.templateKey,
    // ค่าเริ่มต้นคือ published — เพิ่มคนเข้ามาแล้วเขายังเห็นแม่แบบอยู่
    visibility: existing?.visibility ?? 'published',
    owner: existing?.owner ?? user.sub,
    ownerName: existing?.ownerName ?? user.name,
    sharedWith: [
      ...(existing?.sharedWith ?? []).filter((s) => s.sub !== input.sub),
      { sub: input.sub, name: input.name ?? null, role: input.role, at: now() },
    ],
    updatedAt: now(),
  }

  await app.mongo
    .collection<AccessDoc>(ACCESS)
    .replaceOne({ _id: input.templateKey } as never, doc as never, { upsert: true })

  app.log.info(
    { templateKey: input.templateKey, share: input.sub, role: input.role },
    'แชร์แม่แบบให้ผู้ใช้อีกคน',
  )

  /**
   * แจ้งผู้ถูกแชร์ — ผู้ใช้สั่ง *"จากเพื่อนที่ส่งมาให้ เช่น แชร์แม่แบบให้"*
   *
   * ⚠️ แยกเป็นสองกรณี เพราะความหมายต่างกันมาก
   *   · ไม่เคยอยู่ในรายชื่อ → เป็นการ**แชร์ใหม่** → ประเภท `share`
   *   · อยู่ในรายชื่ออยู่แล้วแต่สิทธิ์ต่างจากเดิม → เป็นการ**เปลี่ยนสิทธิ์**
   *     → ประเภท `access` (ถ้าใส่ `share` ผู้ใช้จะเห็นมันปนกับของใหม่จริง)
   *
   * ⚠️ ไม่ดึงชื่อแม่แบบมาใส่
   *   Carbone ไม่มี GET metadata รายตัว — ต้อง list ทั้งหมดมาแย่แม่แบบทุกครั้งที่แชร์
   *   แลกกับข้อความที่สั้นลง ไม่คุ้ม (ผู้ใช้แค่คลิกไปดูหน้าแม่แบบก็รู้อยู่แล้ว)
   *   ถ้าวันหนึ่งเก็บชื่อไว้ใน `template_access` ค่อยเติมตรงนี้
   */
  const prior = existing?.sharedWith.find((s) => s.sub === input.sub)
  const roleText = input.role === 'editor' ? 'แก้ไขได้' : 'ดูอย่างเดียว'
  if (prior && prior.role !== input.role) {
    await notify(app, {
      user: input.sub,
      kind: 'access',
      title: 'สิทธิ์ของคุณเปลี่ยนแล้ว',
      body: `${user.name ?? 'เจ้าของ'} เปลี่ยนสิทธิ์ของคุณเป็น "${roleText}"`,
      link: `/studio/${input.templateKey}`,
    })
  } else {
    await notify(app, {
      user: input.sub,
      kind: 'share',
      title: 'มีคนแชร์แม่แบบให้คุณ',
      body: `${user.name ?? 'เจ้าของ'} แชร์แม่แบบให้คุณ (${roleText})`,
      link: `/studio/${input.templateKey}`,
    })
  }

  return toView(doc, input.templateKey, user.sub)
}

export async function removeShare(
  app: App,
  input: { templateKey: string; sub: string },
  req: Req,
): Promise<AccessView> {
  const user = who(req)
  const existing = await loadAccess(app, input.templateKey)
  if (!existing) throw new NotFoundError('การแชร์แม่แบบ', input.templateKey)
  if (existing.owner !== user.sub) {
    await assertTeamAdmin(app, existing.team, user.sub, 'เฉพาะเจ้าของทีมเท่านั้นที่ถอนสิทธิ์แม่แบบของทีมได้')
  }

  const doc: AccessDoc = {
    ...existing,
    sharedWith: existing.sharedWith.filter((s) => s.sub !== input.sub),
    updatedAt: now(),
  }
  await app.mongo
    .collection<AccessDoc>(ACCESS)
    .replaceOne({ _id: input.templateKey } as never, doc as never, { upsert: true })

  /**
   * แจ้งคนที่ถูกถอนสิทธิ์
   *
   * ⚠️ ต้องแจ้ง ไม่งั้นเขาจะเปิดแม่แบบแล้วเจอ 403 โดยไม่มีคำอธิบาย
   *   (หน้าเว็บเขียนไว้ว่าสิทธิ์ถูกถอน แต่ผู้ถูกถอนไม่เคยเห็นข้อความนั้น)
   */
  await notify(app, {
    user: input.sub,
    kind: 'access',
    title: 'ถูกถอนสิทธิ์แม่แบบ',
    body: `${user.name ?? 'เจ้าของ'} ถอนสิทธิ์ของคุณออกจากแม่แบบนี้แล้ว`,
    link: `/studio/${input.templateKey}`,
  })

  return toView(doc, input.templateKey, user.sub)
}

/** ล้างเอกสารสิทธิ์ทิ้ง → กลับไปเป็น "เปิดสาธารณ แก้ได้ทุกคน" แบบเริ่มต้น */
export async function deleteAccess(app: App, templateKey: string, req: Req): Promise<void> {
  const user = who(req)
  const existing = await loadAccess(app, templateKey)
  if (!existing) return
  if (existing.owner !== user.sub) {
    await assertTeamAdmin(app, existing.team, user.sub, 'เฉพาะเจ้าของทีมเท่านั้นที่ล้างการตั้งค่าการแชร์แม่แบบของทีมได้')
  }
  await app.mongo.collection<AccessDoc>(ACCESS).deleteOne({ _id: templateKey } as never)
  app.log.info({ templateKey }, 'ล้างการตั้งค่าการแชร์แล้ว')
}

/**
 * สิทธิ์ของผู้ใช้หลายแม่แบบพร้อมกัน
 * หน้าเว็บต้องรู้ว่าแม่แบบไหนเป็น private ของคนอื่น (ต้องซ่อน)
 * และแม่แบบไหนถูกแชร์ให้เรา (ต้องขึ้น tab "แชร์กับฉัน")
 * — ถ้าถามทีเดียวต่อแม่แบบจะเป็น N+1 ตอนเปิดหน้ารายการ
 */
export async function resolveAccess(
  app: App,
  keys: string[],
  req: Req,
): Promise<Record<string, AccessView>> {
  const { sub } = who(req)
  const wanted = [...new Set(keys)].slice(0, 200)
  if (wanted.length === 0) return {}

  const rows = await app.mongo
    .collection<AccessDoc>(ACCESS)
    .find({ _id: { $in: wanted } } as never)
    .toArray()

  /**
   * โหลดทีมของผู้เรียก**ครั้งเดียว** ไม่งั้นจะเป็น N+1
   *
   * ⚠️ หน้ารายการส่งมาสูงสุด 200 แม่แบบ ถ้า query role ทีละแม่แบบ
   *   จะยิง Mongo 200 ครั้งต่อการเปิดหน้าเดียว
   *   (เคยคิดว่าไม่ต้อง role เพราะไม่มีทีม — พอมีทีมต้องมีตารางนี้)
   */
  const myTeams = await loadMyTeamMap(app, sub)

  const byKey = new Map(rows.map((r) => [String((r as { _id: unknown })._id), r as AccessDoc]))
  const out: Record<string, AccessView> = {}
  for (const k of wanted) {
    const doc = byKey.get(k) ?? null
    const t = doc?.team ? myTeams.get(doc.team) : undefined
    out[k] = toView(doc, k, sub, t?.role ?? null, t?.name ?? null)
  }
  return out
}

/** ทีมทั้งหมดที่ผู้ใช้อยู่ → Map<teamId, {role, name}> (อ่านครั้งเดียว ใช้ซ้ำในลูป) */
async function loadMyTeamMap(
  app: App,
  sub: string,
): Promise<Map<string, { role: TeamRole; name: string }>> {
  const [rows, teamsCol] = await Promise.all([
    app.mongo
      .collection<{ team: string; role: TeamRole }>('team_members')
      .find({ sub } as never)
      .toArray(),
    app.mongo.collection<{ _id: string; name: string }>('teams').find({} as never).toArray(),
  ])
  if (rows.length === 0) return new Map()

  const names = new Map(teamsCol.map((t) => [String(t._id), t.name]))
  return new Map(
    rows.map((r) => [r.team, { role: r.role, name: names.get(r.team) ?? '' }]),
  )
}

/**
 * ย้ายแม่แบบเข้า/ออกทีม
 *
 * ── ใครทำอะไรได้ ────────────────────────────────────────────
 *   **เข้าทีม** — เจ้าของส่วนตัว หรือ admin ของทีมปลายทาง (สำหรับแม่แบบที่ยังไม่มีเจ้าของ)
 *   **ออกจากทีม** — เจ้าของส่วนตัว หรือ admin ของทีมเดิม
 *
 *   ⚠️ ห้ามใช้แค่ `canEdit` — เพราะ `canEdit` จริงสำหรับแม่แบบ published
 *     ถ้าใช้ตรงนี้ ใครก็ได้ที่เปิดแม่แบบสาธารณเข้ามากวาดในทีมตัวเองได้
 *     (แม่แบบสาธารณแก้ได้ทุกคน → ถ้าใช้ canEdit ก็เท่ากับใครก็ "ยึด" ได้)
 *
 * ── ย้ายเข้าทีม = บังคับเป็น private ────────────────────────────
 *   กติกาเดิมของระบบคือ "published = ทุกคนแก้ได้"
 *   ถ้าย้ายเข้าทีมแล้วยังเปิดสาธารณอยู่ แม่แบบนั้นจะยังแก้ได้โดยคนนอกทีม
 *   → ทีมก็ไม่มีความหมาย → จึงตั้งเป็น private ให้อัตโนมัติ
 *   (admin ทีมเปิดสาธารณเองได้ภายหลังถ้าต้องการ)
 */
export async function setTemplateTeam(
  app: App,
  input: { templateKey: string; team: string | null },
  req: Req,
): Promise<AccessView> {
  const user = who(req)
  const existing = await loadAccess(app, input.templateKey)

  if (input.team) {
    // ต้องเป็น admin ของทีมปลายทางเสมอ ไม่งั้นใครก็ชวนคนอื่นเข้าทีมตัวเองได้
    await teams.assertTeamRole(app, input.team, user.sub, 'admin')

    // แม่แบบที่มีเจ้าของเป็นคนอื่น = ต้องให้เจ้าของย้ายเอง ไม่ใช่ลากเข้ามาเอง
    const isPersonalOwner = !existing?.owner || existing.owner === user.sub
    if (!isPersonalOwner) {
      throw new AppError(
        'FORBIDDEN',
        'แม่แบบนี้มีเจ้าของอยู่แล้ว — ให้เจ้าของย้ายเข้าทีมเอง',
        403,
      )
    }
  } else if (existing?.team) {
    await assertTeamAdmin(app, existing.team, user.sub, 'เฉพาะเจ้าของทีมเท่านั้นที่ถอนแม่แบบออกจากทีมได้')
  }

  if (!existing) {
    if (!input.team) {
      // ถอนทีมจากแม่แบบที่ไม่มีเอกสารสิทธิ์ = ไม่มีอะไรให้ทำ
      return toView(null, input.templateKey, user.sub)
    }
    // แม่แบบยังไม่มีเอกสารสิทธิ์ (ไม่มีใครตั้งค่า) → สร้างใหม่ โดยผู้ทำคือเจ้าของ
    const doc: AccessDoc = {
      _id: input.templateKey,
      templateKey: input.templateKey,
      visibility: 'private',
      owner: user.sub,
      ownerName: user.name,
      team: input.team,
      sharedWith: [],
      updatedAt: now(),
    }
    await app.mongo.collection<AccessDoc>(ACCESS).insertOne(doc as never)
    app.log.info({ templateKey: input.templateKey, team: input.team }, 'ย้ายแม่แบบเข้าทีม')
    return toView(doc, input.templateKey, user.sub, 'owner', null)
  }

  const doc: AccessDoc = {
    ...existing,
    // เข้าทีม → private เสมอ · ออกจากทีม → คืนค่าเดิม (ไม่เดา ผู้ใช้ตั้งเองภายหลัง)
    visibility: input.team ? 'private' : existing.visibility,
    team: input.team,
    updatedAt: now(),
  }
  await app.mongo
    .collection<AccessDoc>(ACCESS)
    .replaceOne({ _id: input.templateKey } as never, doc as never)

  app.log.info(
    { templateKey: input.templateKey, team: input.team, visibility: doc.visibility },
    input.team ? 'ย้ายแม่แบบเข้าทีม' : 'ถอนแม่แบบออกจากทีม',
  )
  return loadView(app, input.templateKey, user.sub)
}

// ── แชทกับ AI ────────────────────────────────────────────────

function toSession(raw: unknown): ChatSession {
  const r = raw as Record<string, unknown>
  return {
    ...(r as unknown as ChatSession),
    _id: String(r._id),
    messages: ((r.messages ?? []) as ChatMessage[]).map((m) => ({ ...m })),
  }
}

export async function listChatSessions(
  app: App,
  templateKey: string | undefined,
  req: Req,
): Promise<Array<{ _id: string; templateKey: string; title: string; messageCount: number; updatedAt: Date }>> {
  const { sub } = who(req)
  const filter = {
    user: sub,
    ...(templateKey ? { templateKey } : {}),
  } as never

  const rows = await app.mongo
    .collection<ChatSession>(CHATS)
    .find(filter)
    .sort({ updatedAt: -1 })
    .limit(50)
    .toArray()

  return rows.map((r) => ({
    _id: String(r._id),
    templateKey: r.templateKey,
    title: r.title,
    messageCount: r.messages?.length ?? 0,
    updatedAt: r.updatedAt,
  }))
}

export async function getChatSession(
  app: App,
  id: string,
  req: Req,
): Promise<ChatSession> {
  const { sub } = who(req)
  const raw = await app.mongo
    .collection<ChatSession>(CHATS)
    .findOne({ _id: id, user: sub } as never)
  if (!raw) throw new NotFoundError('แชท', id)
  return toSession(raw)
}

export async function deleteChatSession(app: App, id: string, req: Req): Promise<void> {
  const { sub } = who(req)
  const res = await app.mongo
    .collection<ChatSession>(CHATS)
    .deleteOne({ _id: id, user: sub } as never)
  if (res.deletedCount === 0) throw new NotFoundError('แชท', id)
}

/**
 * ส่งข้อความไปหา AI แล้วเอา JSON ที่ได้กลับมา
 *
 * ขั้นตอน
 *   1. โหลด (หรือสร้าง) session ของผู้ใช้คนนี้กับแม่แบบนั้น
 *   2. แนบข้อความผู้ใช้ + ประวัติเข้าไป
 *   3. เอา "ช่องที่ต้องกรอก" จากฟอร์ม (หรือแท็กของแม่แบบ ถ้ายังไม่ได้ตั้งฟอร์ม)
 *      ไปบอกโมเดล — ไม่งั้นมันจะแต่ง key ขึ้นเองจนข้อมูลเพี้ยน
 *   4. merge กับข้อมูลเดิม โดย **ไม่ทับ** ค่าที่ผู้ใช้กรอกเอง
 *   5. บันทึกทั้งสองข้อความลง session
 */
/**
 * ช่วยช่องเดียว — คืน "ข้อเสนอ" ให้ผู้ใช้ตัดสินใจใส่เอง
 *
 * ต่างจาก `chat` ปกติตรงที่
 *   · ไม่บันทึกประวัติ (ชั่วคราวของช่องนั้น ไม่ควรไปกองในประวัติแชทของแม่แบบ)
 *   · ไม่ merge ทับข้อมูลเดิม — `data` คือ "สิ่งที่ AI เสนอ" ยังไม่ถูกใช้
 *   · ประวัติสนทนาในตัว popover อยู่ฝั่งหน้าเว็บ ส่งมาทีละข้อความพอ
 */
async function fieldAdvice(
  app: App,
  input: {
    templateKey: string
    message: string
    templateName?: string
    provider?: string
    field: { key: string; label?: string; type?: string; value?: string }
  },
  _req: Req,
): Promise<{
  sessionId: string
  reply: string
  data: Record<string, unknown>
  changed: string[]
  provider: string
  model: string
}> {
  const form = await getFormSchema(app, input.templateKey)
  const def = form?.fields.find((f) => f.key === input.field.key)

  const answer = await askLlm({
    messages: [{ role: 'user', content: input.message }],
    fields: form?.fields ?? [],
    tags: [],
    templateName: input.templateName,
    provider: input.provider,
    field: { ...input.field, label: input.field.label ?? def?.label },
    log: (meta) => app.log.warn({ ...meta, scope: 'llm' }, 'เรียกโมเดลไม่สำเร็จ (ช่องเดียว)'),
  })

  // key อื่นถูกกรองทิ้งใน askLlm แล้ว — กันพลาดซ้ำอีกชั้นตรงนี้
  const proposal =
    answer.data[input.field.key] === undefined ? {} : { [input.field.key]: answer.data[input.field.key] }

  app.log.info(
    { templateKey: input.templateKey, fieldKey: input.field.key, provider: answer.provider },
    'AI ตอบช่องเดียวแล้ว',
  )

  return {
    sessionId: `field-${input.field.key}`,
    reply: answer.reply,
    data: proposal,
    changed: Object.keys(proposal),
    provider: answer.provider,
    model: answer.model,
  }
}

export async function chat(
  app: App,
  input: {
    templateKey: string
    sessionId?: string
    message: string
    data: Record<string, unknown>
    templateName?: string
    provider?: string
    /** ถ้ามี = โหมด "ช่วยช่องเดียว" (ไอคอน AI ข้างช่องกรอก) */
    field?: { key: string; label?: string; type?: string; value?: string }
  },
  req: Req,
): Promise<{
  sessionId: string
  reply: string
  data: Record<string, unknown>
  changed: string[]
  provider: string
  model: string
}> {
  const user = who(req)

  /**
   * โหมดช่องเดียวถือเป็นการ "ขอความเสนอ" ไม่ใช่การเติมฟอร์ม
   *   · ไม่ต่อ session เดิม และไม่บันทึกลง Mongo — เป็นเรื่องชั่วคราวของช่องนั้น
   *     (ถ้าบันทึก จะไปปนกับรายการ "ประวัติแชท" ของแผง AI ใหญ่)
   *   · ไม่ merge ทับของเดิม — คืนค่าให้ผู้ใช้กดยืนยันเอง
   */
  const field = input.field
  if (field) return fieldAdvice(app, { ...input, field }, req)

  const session = input.sessionId
    ? await getChatSession(app, input.sessionId, req)
    : null

  const turns: ChatTurn[] = [
    ...(session?.messages ?? []).map((m) => ({ role: m.role, content: m.content })),
    { role: 'user' as const, content: input.message },
  ]

  const form = await getFormSchema(app, input.templateKey)
  const fields = form?.fields ?? []
  // ยังไม่ได้ตั้งฟอร์ม → ใช้แท็กของแม่แบบเป็นคีย์ให้ AI
  const tags = fields.length > 0 ? [] : await tagsOfTemplate(app, input.templateKey)

  const answer = await askLlm({
    messages: turns,
    fields,
    tags,
    templateName: input.templateName,
    provider: input.provider,
    log: (meta) => app.log.warn({ ...meta, scope: 'llm' }, 'เรียกโมเดลไม่สำเร็จ'),
  })

  const merged = mergeAiData(input.data, answer.data)

  const at = now()
  const userMsg: ChatMessage = {
    id: newId('m'),
    role: 'user',
    content: input.message,
    data: null,
    at,
  }
  const botMsg: ChatMessage = {
    id: newId('m'),
    role: 'assistant',
    content: answer.reply,
    data: answer.data,
    at,
  }

  const sessionId = session?._id ?? newId('chat')
  // ชื่อแชท = ข้อความแรกของผู้ใช้ ตัดให้สั้น
  const title =
    session?.title ?? (input.message.slice(0, 60).replace(/\s+/g, ' ').trim() || 'แชทใหม่')

  const messages = [...(session?.messages ?? []), userMsg, botMsg].slice(-MAX_MESSAGES)

  const doc: ChatSession = {
    _id: sessionId,
    templateKey: input.templateKey,
    title,
    user: user.sub,
    messages,
    createdAt: session?.createdAt ?? at,
    updatedAt: at,
  }

  await app.mongo
    .collection<ChatSession>(CHATS)
    .replaceOne({ _id: sessionId } as never, doc as never, { upsert: true })

  app.log.info(
    {
      sessionId,
      templateKey: input.templateKey,
      provider: answer.provider,
      changed: merged.changed.length,
      unparsed: answer.unparsed,
    },
    'AI ตอบแชทแล้ว',
  )

  return {
    sessionId,
    reply: answer.reply,
    data: merged.data,
    changed: merged.changed,
    provider: answer.provider,
    model: answer.model,
  }
}

/** แท็ก `{d.*}` ของแม่แบบ — ใช้เป็นคีย์สำรองตอนยังไม่ได้ตั้งฟอร์ม */
async function tagsOfTemplate(app: App, templateKey: string): Promise<string[]> {
  try {
    const { items } = await carbone.listTemplates({ templateId: templateKey })
    const paths = new Set<string>()
    for (const t of items) {
      const r = await readTemplateTags(t.versionId)
      for (const tag of r.items) paths.add(tag.path)
    }
    return [...paths]
  } catch (err) {
    // แท็กอ่านไม่ได้ไม่ใช่เรื่องค้าง — AI ยังคุยได้ แค่ไม่รู้คีย์
    app.log.warn({ templateKey, err: (err as Error).message }, 'อ่านแท็กของแม่แบบไม่ได้')
    return []
  }
}

// ── บุ๊กมาร์ก ────────────────────────────────────────────────

export async function listBookmarks(
  app: App,
  req: Req,
): Promise<BookmarkRecord[]> {
  const { sub } = who(req)
  const rows = await app.mongo
    .collection<BookmarkRecord>(BOOKMARKS)
    .find({ user: sub } as never)
    .sort({ createdAt: -1 })
    .limit(200)
    .toArray()

  /*
   * เติม `teamName` ให้ฝั่งเว็บ ไม่ต้องยิงเพิ่มหนึ่งรอบต่อบุ๊กมาร์ก
   *
   * ⚠️ ชื่อทีมที่ไม่เจอ = ทีมถูกลบไปแล้ว (หรือผู้ใช้ถูกถอนออกจากทีม)
   *   คืน `null` ให้ฝั่งเว็บไปแสดงว่า "ส่วนตัว" แทนที่จะค้างชี้ไปทีมที่ไม่มีอยู่จริง
   */
  const teamIds = [...new Set(rows.map((r) => r.team).filter((t): t is string => !!t))]
  const names = new Map<string, string>()
  if (teamIds.length > 0) {
    const docs = await app.mongo
      .collection<{ _id: string; name: string }>('teams')
      .find({ _id: { $in: teamIds } } as never)
      .toArray()
    for (const d of docs) names.set(String(d._id), d.name)
  }

  return rows.map((r) => ({
    ...r,
    _id: String(r._id),
    teamName: r.team ? names.get(r.team) ?? null : null,
  }))
}

export async function addBookmark(
  app: App,
  input: {
    templateKey: string
    versionId: string
    templateName?: string
    note?: string
    /** `null`/ไม่ส่ง = เก็บส่วนตัว */
    team?: string | null
  },
  req: Req,
): Promise<BookmarkRecord> {
  const { sub } = who(req)

  /*
   * ⚠️ ต้องเช็คว่าเป็นสมาชิกทีมนั้นจริง ไม่งั้นส่ง id ทีมอะไรมาก็เก็บได้
   *   บุ๊กมาร์กเป็นของส่วนตัว การชี้ไปทีมที่ตัวเองไม่มีสิทธิ์
   *   จะทำให้ข้อมูลของทีมรั่วออกไปทางชื่อทีม โดยไม่มี error
   */
  const team = input.team ?? null
  if (team && !(await teams.roleIn(app, team, sub))) {
    throw new AppError('FORBIDDEN', 'ไม่ได้เป็นสมาชิกทีมนี้ จึงเก็บบุ๊กมาร์กลงทีมไม่ได้', 403)
  }

  // กดบุ๊กมาร์กซ้ำ = เอาอันเดิมกลับมา ไม่ต้องเพิ่มซ้ำให้รก
  const col = app.mongo.collection<BookmarkRecord>(BOOKMARKS)
  const existing = await col.findOne({ user: sub, templateKey: input.templateKey } as never)

  if (existing) {
    /*
     * กดดาวซ้ำแล้วเลือกทีมใหม่ = **เปลี่ยนที่เก็บ** ไม่ใช่สร้างรายการใหม่
     *   เพราะหนึ่งแม่แบบมีบุ๊กมาร์กได้แค่รายการเดียว (ดู BookmarkRecord)
     *   `updatedAt` ไม่ต้องแตะ `createdAt` เพื่อให้เรียงตามเวลาที่กดครั้งแรกเหมือนเดิม
     */
    const patch = {
      templateName: input.templateName ?? existing.templateName,
      note: input.note ?? existing.note,
      team,
    }
    await col.updateOne({ _id: existing._id } as never, { $set: patch } as never)
    return {
      ...(existing as BookmarkRecord),
      ...patch,
      _id: String(existing._id),
      teamName: team ? await teams.teamName(app, team) : null,
    }
  }

  const doc: BookmarkRecord = {
    _id: newId('bm'),
    user: sub,
    templateKey: input.templateKey,
    versionId: input.versionId,
    templateName: input.templateName ?? null,
    note: input.note ?? null,
    createdAt: now(),
    team,
  }
  await col.insertOne(doc as never)
  return {
    ...doc,
    teamName: team ? await teams.teamName(app, team) : null,
  }
}

export async function removeBookmark(
  app: App,
  templateKey: string,
  req: Req,
): Promise<void> {
  const { sub } = who(req)
  const res = await app.mongo
    .collection<BookmarkRecord>(BOOKMARKS)
    .deleteOne({ user: sub, templateKey } as never)
  if (res.deletedCount === 0) throw new NotFoundError('บุ๊กมาร์ก', templateKey)
}

// ── ประวัติการสร้างเอกสารของแม่แบบ ───────────────────────────

/**
 * ใครใช้แม่แบบนี้บ้าง
 *
 * ⚠️ เอกสารใน `documents` เก็บ `templateId` = **versionId** ไม่ใช่ id ที่คงที่
 *    ต้องแปลงก่อน — ไม่งั้นแม่แบบที่มีหลายเวอร์ชันจะได้ประวัติมาแค่เวอร์ชันเดียว
 */
export async function templateHistory(
  app: App,
  templateKey: string,
  page: { limit: number; skip: number },
): Promise<TemplateHistory> {
  const versionIds = await versionIdsOf(app, templateKey)
  if (versionIds.length === 0) return { users: [], items: [], total: 0 }

  const filter = { templateId: { $in: versionIds } } as never
  const col = app.mongo.collection<Record<string, unknown>>('documents')

  const [items, total, byUser] = await Promise.all([
    col.find(filter).sort({ createdAt: -1 }).skip(page.skip).limit(page.limit).toArray(),
    col.countDocuments(filter),
    col
      .aggregate<{ _id: string; name: string | null; count: number; lastAt: Date; ok: number; fail: number }>([
        { $match: { templateId: { $in: versionIds } } },
        {
          $group: {
            _id: '$createdBy',
            name: { $last: '$createdByName' },
            count: { $sum: 1 },
            lastAt: { $max: '$createdAt' },
            ok: { $sum: { $cond: [{ $eq: ['$status', 'done'] }, 1, 0] } },
            fail: { $sum: { $cond: [{ $eq: ['$status', 'failed'] }, 1, 0] } },
          },
        },
        { $sort: { count: -1 } },
        { $limit: 100 },
      ])
      .toArray(),
  ])

  return {
    users: byUser.map((u) => ({
      sub: String(u._id ?? 'ไม่ระบุ'),
      name: u.name ?? null,
      count: u.count,
      lastAt: u.lastAt,
      okCount: u.ok,
      failCount: u.fail,
    })),
    items: items.map((d) => ({
      _id: String(d._id),
      label: (d.label as string | null) ?? null,
      status: String(d.status ?? ''),
      outputFormat: String(d.outputFormat ?? ''),
      createdBy: (d.createdBy as string | null) ?? null,
      createdByName: (d.createdByName as string | null) ?? null,
      createdAt: d.createdAt as Date,
    })),
    total,
  }
}

/**
 * ประวัติของฉันเองกับแม่แบบหนึ่งตัว — เอาไว้กู้ค่ามาแก้ต่อ
 *
 * ── ต่างจาก `templateHistory` ยังไง ──────────────────────────
 *   `templateHistory` = มุมมองรวมทุกคน (ใครใช้บ้าง) → **ไม่** คืนค่าที่กรอก
 *   `myTemplateHistory` = เฉพาะของฉัน → คืน `data` เพื่อกู้ค่ามาแก้
 *
 * ⚠️ กรอง `createdBy` เสมอ ค่าที่กรอกของคนอื่นเป็นข้อมูลส่วนตัว
 *    (ชื่อผู้รับ เลขบัตร ที่อยู่) ห้ามหลุดออกไปกับการค้นหา
 *
 * ── แบ่งหน้า ─────────────────────────────────────────────────────────
 * คนเดียวสั่งเรนเดอร์แม่แบบเดียวกันได้เป็นร้อยฉบับ (ผู้ใช้สั่งว่า *"ถ้ามีมากๆ
 * ทำเป็น pageination"*) ถ้ายิงมาทั้งหมดทุกครั้งที่เปลี่ยนหน้า
 * จะทั้งช้าลงและดึง `data` ทั้งหมดมาทิ้งในหน่วยความจำเปล่า ๆ
 *
 * → ให้ Mongo ตัดให้เสมอ (`skip` + `limit`) ทั้งโหมดไม่ค้นและโหมดค้น
 *   `total` ยังเป็นจำนวนทั้งหมด (ไม่ใช่จำนวนหน้านี้) เพื่อให้หน้าจอคำนวณจำนวนหน้าได้
 */
export async function myTemplateHistory(
  app: App,
  templateKey: string,
  query: { limit: number; skip: number; q: string },
  req: Req,
): Promise<MyTemplateHistory> {
  const { sub } = who(req)
  const versionIds = await versionIdsOf(app, templateKey)
  if (versionIds.length === 0) return { items: [], total: 0 }

  const base = {
    templateId: { $in: versionIds },
    createdBy: sub,
  } as never
  const col = app.mongo.collection<Record<string, unknown>>('documents')
  const q = query.q.trim()

  /**
   * ── ไม่ค้น: ทำแบบเดิม ให้ Mongo นับและตัดให้ (เร็ว) ──
   */
  if (!q) {
    const [rows, total] = await Promise.all([
      col.find(base).sort({ createdAt: -1 }).skip(query.skip).limit(query.limit).toArray(),
      col.countDocuments(base),
    ])
    return { items: rows.map(toHistoryItem), total }
  }

  /**
   * ── ค้น: กรองฝั่ง Node เพราะ Mongo หาค่าข้างใน object ไม่ได้ ──
   *
   * ⚠️ เคยลองใช้ `{ data: { $regex } }` และ `{ 'data.$**': { $regex } }`
   *    ผลคือ **ไม่เจอแม้แต่เอกสารที่ค่าตรงเป๊ะ** เพราะ key ของเราเป็น
   *    dot path ของแม่แบบ Carbone เช่น `ผู้รับ.ชื่อ`
   *    → Mongo แปลง `data.ผู้รับ.ชื่อ` เป็น "ดูใน data แล้วลงไป ผู้รับ แล้วลงไป ชื่อ"
   *      ซึ่งไม่มีอยู่จริง (จุดอยู่ในชื่อ key ไม่ใช่โครงสร้าง)
   *    wildcard `$**` ก็ช่วยไม่ได้ในเคสนี้
   *
   * เป็นการสแกนฝั่งแอป จึงต้องจำกัดจำนวนที่อ่าน
   * ประวัติส่วนตัวของคนเดียวมีจำนวนจำกัด จึงยอมรับข้อแลกเปลี่ยนนี้
   * (ถ้าวันหนึ่งต้องค้นทั้งระบบ ให้เพิ่มคอลัมน์ "ข้อความค้นหา" แยก + text index)
   */
  const scan = await col
    .find(base)
    .sort({ createdAt: -1 })
    .limit(SEARCH_SCAN_LIMIT)
    .toArray()

  const needle = q.toLocaleLowerCase('th')
  const hit = scan.filter((d) => {
    if (String(d.label ?? '').toLocaleLowerCase('th').includes(needle)) return true
    return searchableText(d.data).includes(needle)
  })

  return { items: hit.slice(query.skip, query.skip + query.limit).map(toHistoryItem), total: hit.length }
}

/** จำนวนฉบับสูงสุดที่ยอมสแกนตอนค้นหา */
const SEARCH_SCAN_LIMIT = 500

/** แปลงเอกสารใน Mongo เป็นรายการประวัติ (เอกสารเก่าที่ไม่มี `data` → `{}`) */
function toHistoryItem(d: Record<string, unknown>): MyHistoryItem {
  return {
    _id: String(d._id),
    label: (d.label as string | null) ?? null,
    status: String(d.status ?? ''),
    outputFormat: String(d.outputFormat ?? ''),
    createdAt: d.createdAt as Date,
    data: (d.data as Record<string, unknown> | undefined) ?? {},
  }
}

/**
 * รวม**ค่า**ทั้งหมดใน `data` เป็นข้อความเดียว เพื่อให้ค้นด้วยชื่อผู้รับเจอ
 *
 * รวมทั้ง key ด้วย เพราะบางครั้งผู้ใช้จำชื่อฟิลด์มากกว่าค่า
 */
function searchableText(data: unknown, depth = 0): string {
  if (data === null || data === undefined) return ''
  if (depth > 6) return '' // กันวนถ้า data มีโครงสร้างเป็นวง/ลึกผิดปกติ
  if (typeof data === 'string' || typeof data === 'number' || typeof data === 'boolean') {
    return String(data)
  }
  if (Array.isArray(data)) return data.map((v) => searchableText(v, depth + 1)).join(' ')
  if (typeof data === 'object') {
    return Object.entries(data as Record<string, unknown>)
      .map(([k, v]) => `${k} ${searchableText(v, depth + 1)}`)
      .join(' ')
  }
  return ''
}

/** หา versionId ของแม่แบบหนึ่งตัว (เวอร์ชันที่ปล่อยอยู่) */
async function versionIdsOf(app: App, templateKey: string): Promise<string[]> {
  // key ที่ไม่ใช่เลข = versionId โดยตรง
  if (!/^\d+$/.test(templateKey)) return [templateKey]

  /**
   * ⚠️ **Carbone 5.x ไม่รู้จัก query `templateId` เลย** — ยิงไปก็ได้รายการเต็มกลับมา
   *
   *   ยืนยันแล้ว: ยิง `GET /templates` เท่าไรก็ได้ 22 รายการเท่ากันหมด
   *   ทั้งที่ในระบบมีแม่แบบที่มี `id` แค่ 12 ตัว และไม่มี `id` อีก 10 ตัว
   *
   *   ถ้าเชื่อว่ามันกรองแล้วเอา `versionId` ทั้งหมดไป `$in`
   *   → ได้ประวัติของ**ทั้งระบบ** ไม่ใช่ของแม่แบบนี้
   *   (อาการที่เห็น: ทุกแม่แบบโชว์ 350 ฉบับ / 100 คน เท่ากันหมด ไม่ว่าจะเป็นตัวไหน)
   *
   *   → กรองด้วย `id` เองฝั่งเรา
   *
   * ⚠️ ข้อจำกัดที่หลีกเลี่ยงไม่ได้: Carbone ไม่มีประวัติเวอร์ชัน
   *   คืนเวอร์ชันที่**ปล่อยอยู่** เท่านั้น → เอกสารที่สร้างจากเวอร์ชันเก่า
   *   (ก่อนมีการกด "อัปโหลดแม่แบบใหม่แทน") จะไม่ปรากฏในประวัติ
   */
  try {
    const { items } = await carbone.listTemplates({})
    return items.filter((t) => String(t.id) === templateKey).map((t) => t.versionId)
  } catch (err) {
    app.log.warn({ templateKey, err: (err as Error).message }, 'หา version ของแม่แบบไม่ได้')
    return []
  }
}
