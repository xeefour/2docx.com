import type { App } from '../../types.js'
import { AppError } from '@docgen/shared'
import { getAccessView, who } from '../studio/service.js'
import * as carbone from './carbone.js'
import { notifyMany } from '../studio/notifications.js'
import { deleteAllPreviews } from './previews.js'

/** โครง request ที่ service layer ใช้ — ทำซ้ำที่นี่เพราะ `studio/service.ts` ไม่ export ออกมา */
type Req = { user?: { sub: string; name?: string } | null }

/**
 * ── ถังขยะแม่แบบ: ลบแล้วรอ 14 วัน ค่อยลบจริง ───────────────────────────
 *
 * ผู้ใช้สั่ง:
 *   *"เพิ่ม การลบแม่แบบ ถ้าผู้ใช้ลบไปแล้ว ให้รอก่อน 14 วัน ค่อยลบ
 *     แจ้งเตือนผู้ใช้ว่าจะลบแม่แบบนี้ ใครจะใช้ให้ clone ไปแทน
 *     ทำให้ restore ภายหลังได้"*
 *
 * ── ทำไมไม่ใช้ soft delete ของ Carbone ──────────────────────────────
 * Carbone มี `deleteTemplate` อยู่แล้ว แต่ retention ของมันคือ **24 ชั่วโมง**
 * (ค่า `expireAt` ที่ Carbone ตั้งเอง เรา control ไม่ได้) ซึ่งไม่ใช่ 14 วัน
 * และหลัง `expireAt` ผ่าน ไฟล์ถูกลบถาวร → **กู้คืนไม่ได้อีก**
 *
 * ฉะนั้นช่วง 14 วันต้องถูกนับ**ในฝั่งเราเอง**:
 *   กดลบ      → เขียน tombstone (ยังไม่แตะ Carbone เลย ไฟล์ยังใช้ได้ปกติ)
 *   ครบ 14 วัน → sweep มาลบจริง (เรียก Carbone delete + ลบข้อมูลเรา)
 *   กดกู้คืน  → ลบ tombstone ทิ้ง ไฟล์กลับมาใช้ได้ทันที
 *
 * ข้อดีของการ "ไม่แตะ Carbone" ตอนกดลบ:
 *   · คนที่ใช้แม่แบบอยู่ยังเปิดทำงานต่อได้ตลอดช่วง 14 วัน
 *   · กู้คืนได้เสมอ เพราะไฟล์ยังอยู่ครบ
 *   · ไม่ต้องพึ่งค่าคอนฟิกของ Carbone ที่เราควบคุมไม่ได้
 */

const TOMBSTONES = 'template_tombstones'

/** ผู้ใช้สั่ง 14 วัน */
export const RETENTION_DAYS = 14

/** ตรวจทุกกี่นาที — ไม่ต้องถี่ เพราะผลต่างกันแค่ไม่กี่นาทีของ 14 วัน */
const SWEEP_INTERVAL_MS = 15 * 60_000

export interface Tombstone {
  _id: string
  templateKey: string
  name: string
  category: string
  tags: string[]
  versionId: string
  deletedAt: Date
  /** ครบเวลานี้แล้ว sweep จะลบไฟล์ทิ้งถาวร */
  purgeAt: Date
  deletedBy: string
  deletedByName: string | null
}

export interface TombstoneView {
  templateKey: string
  name: string
  category: string
  tags: string[]
  versionId: string
  deletedAt: string
  purgeAt: string
  /** เหลือกี่วันก่อนถูกลบถาวร — คำนวณเป็น "ศูนย์" เมื่อเลยกำหนดแล้วแต่ยังไม่ถูก sweep */
  daysLeft: number
  deletedBy: string
  deletedByName: string | null
  /** ผู้เรียกดูนี้เป็นเจ้าของไหม — ใช้ตัดสิทธิ์กู้คืน */
  canRestore: boolean
}

/** สร้าง view พร้อมคำนวณวันคงเหลือ */
export function toTombstoneView(t: Tombstone, sub: string): TombstoneView {
  const now = Date.now()
  return {
    templateKey: t.templateKey,
    name: t.name,
    category: t.category,
    tags: t.tags,
    versionId: t.versionId,
    deletedAt: t.deletedAt.toISOString(),
    purgeAt: t.purgeAt.toISOString(),
    daysLeft: Math.max(0, Math.ceil((t.purgeAt.getTime() - now) / 86_400_000)),
    deletedBy: t.deletedBy,
    deletedByName: t.deletedByName,
    canRestore: t.deletedBy === sub,
  }
}

/**
 * ลบแม่แบบแบบรอ 14 วัน
 *
 * ⚠️ **เจ้าของเท่านั้น** ที่ลบได้
 *   คนที่มีสิทธิ์แก้ไข (`canEdit`) ยังลบไม่ได้ เพราะการลบทำให้แม่แบบหายจาก
 *   รายการของทุกคน ซึ่งเป็นการกระทบคนอื่น ไม่ใช่แค่แก้ของตัวเอง
 *   ยกเว้นแม่แบบที่**ยังไม่มีเจ้าของ** (owner === null) = ยังไม่มีใครคุม
 *   ให้คนแรกที่กดลบเป็นเจ้าของ เหมือนกติกาของ `setVisibility`
 */
export async function trashTemplate(app: App, templateKey: string, req: Req): Promise<TombstoneView> {
  const user = who(req)
  const view = await getAccessView(app, templateKey, req)

  if (view.owner && view.relation !== 'owner') {
    throw new AppError('FORBIDDEN', 'เฉพาะเจ้าของแม่แบบเท่านั้นที่ลบได้', 403)
  }

  // ดึงข้อมูลแม่แบบมาเก็บไว้ เผื่อหน้า "ถังขยะ" ต้องโชว์ชื่อทันทีที่กดลบ
  //   (ไม่งั้นหลังลบออกจากรายการแล้วจะไม่มีชื่อให้โชว์ ผู้ใช้หาไม่เจอว่าลบอะไร)
  let name = templateKey
  let category = ''
  let tags: string[] = []
  try {
    const { items } = await carbone.listTemplates({})
    const hit = items.find((t) => (t.id ?? t.versionId) === templateKey)
    if (hit) {
      name = hit.name ?? templateKey
      category = hit.category ?? ''
      tags = hit.tags ?? []
    }
  } catch (err) {
    // ดึงข้อมูลไม่ได้ไม่ทำให้ลบไม่ได้ — แค่ตอนกู้คืนจะไม่มีชื่อสวย
    app.log.warn({ err, templateKey }, 'อ่านข้อมูลแม่แบบก่อนลบไม่สำเร็จ (จะใช้ key เป็นชื่อแทน)')
  }

  const now = new Date()
  const doc: Tombstone = {
    _id: templateKey,
    templateKey,
    name,
    category,
    tags,
    versionId: templateKey,
    deletedAt: now,
    purgeAt: new Date(now.getTime() + RETENTION_DAYS * 86_400_000),
    deletedBy: user.sub,
    deletedByName: user.name,
  }
  await app.mongo.collection<Tombstone>(TOMBSTONES).replaceOne({ _id: templateKey } as never, doc as never, {
    upsert: true,
  })
  app.log.info(
    { templateKey, name, purgeAt: doc.purgeAt.toISOString() },
    'ย้ายแม่แบบเข้าถังขยะ (รอก่อนลบจริง)',
  )

  /**
   * แจ้งว่าแม่แบบกำลังจะหายถาวร
   *
   * ผู้ใช้สั่งรอบถังขยะว่า *"แจ้งเตือนผู้ใช้ว่าจะลบแม่แบบนี้ ใครจะใช้ให้ clone ไปแทน"*
   * และตอนนี้เลือกเป็น *"ระบบแจ้งเรื่องของแม่แบบ: ใกล้ถูกลบถาวร"*
   *   → กล่องจดหมายคือที่ที่เหมาะกับการเตือนเรื่องแบบนี้
   *   (ไม่ใช่ toast ตอนกดลบ เพราะ toast หายไปใน 2 วินาที ทั้งที่ผู้ใช้มีเวลาคิด 14 วัน)
   *
   * ⚠️ แจ้งทั้งคนที่กดลบ **และ** ทุกคนที่เคยถูกแชร์
   *   เพราะคนที่ถูกแชร์จะเข้าไปใช้ต่อไม่ได้เลยตอนหายถาวร
   *   ถ้าอยากเก็บไว้ใช้ต่อ ต้องรู้เรื่องนี้ก่อน ไม่ใช่หลังเปิดแล้วเจอ 404
   *
   * ⚠️ ตรงนี้มีชื่อแม่แบบอยู่แล้ว (ดึงมาตอน `trashTemplate` ด้านบน)
   *   จึงใส่ templateName ได้เลย ต่างจากการแชร์/ถอนสิทธิ์ที่ไม่มี
   */
  await notifyMany(app, [user.sub, ...view.sharedWith.map((s) => s.sub)], {
    kind: 'system',
    title: 'แม่แบบกำลังจะถูกลบถาวร',
    body: `"${name}" จะหายถาวรใน ${RETENTION_DAYS} วัน — ถ้าจะใช้ต่อ ให้ clone เก็บไว้ก่อน`,
    link: `/studio/${templateKey}`,
    templateName: name,
  })

  return toTombstoneView(doc, user.sub)
}

/** เอาออกจากถังขยะ — ไฟล์กลับมาใช้ได้ทันที เพราะยังไม่เคยถูกลบจริง */
export async function restoreTemplate(app: App, templateKey: string, req: Req): Promise<void> {
  const user = who(req)
  const col = app.mongo.collection<Tombstone>(TOMBSTONES)
  const found = await col.findOne({ _id: templateKey } as never)
  if (!found) {
    throw new AppError('NOT_FOUND', 'แม่แบบนี้ไม่ได้อยู่ในถังขยะ', 404)
  }
  if (found.deletedBy !== user.sub) {
    throw new AppError('FORBIDDEN', 'กู้คืนได้เฉพาะคนที่เป็นคนลบเท่านั้น', 403)
  }
  await col.deleteOne({ _id: templateKey } as never)
  app.log.info({ templateKey }, 'กู้คืนแม่แบบจากถังขยะแล้ว')
}

/**
 * รายการในถังขยะ — คืนเฉพาะของที่ผู้เรียกเป็นคนลบ แบ่งหน้าแล้ว
 *
 * ⚠️ ต้องนับ `total` แยก ห้ามใช้ `items.length` เด็ดขาด
 *   เพราะผู้ใช้กดกู้คืน/ลบระหว่างที่อยู่หน้า 3 จำนวนก็เปลี่ยนทันที
 *   ถ้าใช้จำนวนที่คืนมาต่อหน้า หน้าสุดท้ายจะโชว์ซ้ำถาวรจนกว่าจะกดหน้าก่อนหน้า
 *
 * ⚠️ เรียงด้วย `deletedAt: -1` ไม่ใช่ `_id` เพราะ tombstone คนละชุดกับแม่แบบ
 *   (คีย์คือ versionId ยาว ๆ ไม่เรียงตามเวลา)
 */
export async function listTombstones(
  app: App,
  req: Req,
  query: { limit: number; skip: number },
): Promise<{ items: TombstoneView[]; total: number }> {
  const user = who(req)
  const col = app.mongo.collection<Tombstone>(TOMBSTONES)
  const filter = { deletedBy: user.sub } as never
  const [rows, total] = await Promise.all([
    col
      .find(filter)
      .sort({ deletedAt: -1 } as never)
      .skip(query.skip)
      .limit(query.limit)
      .toArray(),
    col.countDocuments(filter),
  ])
  return { items: rows.map((t) => toTombstoneView(t, user.sub)), total }
}

/** ข้อมูล tombstone ของแม่แบบหนึ่งตัว (ไม่ต้องเช็คสิทธิ์ — ใช้แสดงป้ายเตือน) */
export async function getTombstone(app: App, templateKey: string): Promise<Tombstone | null> {
  return app.mongo.collection<Tombstone>(TOMBSTONES).findOne({ _id: templateKey } as never)
}

/** key ของแม่แบบที่อยู่ในถังขยะทั้งหมด — ใช้กรองออกจากรายการ */
export async function listTombstoneKeys(app: App): Promise<Set<string>> {
  const all = await app.mongo
    .collection<Tombstone>(TOMBSTONES)
    .find({} as never)
    .project({ _id: 1 } as never)
    .toArray()
  return new Set(all.map((d) => String(d._id)))
}

/**
 * ลบจริง — เรียก Carbone + ลบข้อมูลฝั่งเรา
 *
 * ⚠️ ลบ access/form ด้วย เพราะถ้าคืนมาภายหลัง (หรือคนสร้าง key เดิมซ้ำ)
 *   สิทธิ์เก่าและฟอร์มเก่าจะตามมาด้วยทั้งที่คนอื่นน่าจะไม่อยากได้
 *   แม้การคืนภายหลังจะกู้ไฟล์กลับมา แต่ผู้ใช้คาดว่าเป็นแม่แบบใหม่
 */
export async function purgeTemplate(app: App, templateKey: string): Promise<void> {
  await carbone.deleteTemplate(templateKey)
  await Promise.all([
    // ⚠️ ลบรูปตัวอย่างด้วย — ไม่งั้นไฟล์ใน S3 ค้างตลอดไป
    //   (Mongo หายแล้วเราหาทางชี้กลับไป S3 ไม่ได้อีก = รั่วพื้นที่เงียบ ๆ)
    deleteAllPreviews(app, templateKey),
    app.mongo.collection(TOMBSTONES).deleteOne({ _id: templateKey } as never),
    app.mongo.collection('template_access').deleteOne({ _id: templateKey } as never),
    app.mongo.collection('form_schemas').deleteOne({ _id: templateKey } as never),
  ])
  app.log.info({ templateKey }, 'ลบแม่แบบถาวรหลังครบกำหนด 14 วัน')
}

/**
 * ตัวกวาดเก็บกวาด — ลบแม่แบบที่ครบ 14 วันแล้ว
 *
 * ⚠️ ลบทีละตัว และ catch รายตัว
 *   ถ้าตัวหนึ่งลบไม่สำเร็จ (เช่น Carbone ล่ม) ต้องไม่ทำให้ที่เหลือค้างทั้งหมด
 *   และไม่ต้อง log error ตัวเดียวจนพรุ่งนี้
 */
export async function sweepTombstones(app: App): Promise<number> {
  const due = await app.mongo
    .collection<Tombstone>(TOMBSTONES)
    .find({ purgeAt: { $lte: new Date() } } as never)
    .toArray()
  let done = 0
  for (const t of due) {
    try {
      await purgeTemplate(app, t.templateKey)
      done++
    } catch (err) {
      app.log.error({ err, templateKey: t.templateKey }, 'ลบแม่แบบตามกำหนดไม่สำเร็จ (จะลองรอบถัดไป)')
    }
  }
  if (done > 0) app.log.info({ done }, 'กวาดถังขยะเสร็จรอบนี้')
  return done
}

/** เริ่มตัวกวาด — เรียกครั้งเดียวตอนบูต */
export function startTrashSweeper(app: App): void {
  const tick = () => {
    sweepTombstones(app).catch((err) => app.log.error({ err }, 'กวาดถังขยะไม่สำเร็จ'))
  }
  // หน่วงรอบแรกไว้ก่อน เพื่อไม่ให้ไปชนกับงานตอนบูตอื่น
  setTimeout(tick, 30_000)
  setInterval(tick, SWEEP_INTERVAL_MS)
  app.log.info({ intervalMs: SWEEP_INTERVAL_MS, retentionDays: RETENTION_DAYS }, 'เริ่มตัวกวาดถังขยะแม่แบบ')
}
