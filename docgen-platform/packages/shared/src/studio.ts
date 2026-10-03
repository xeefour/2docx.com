import { z } from 'zod/v4'

/**
 * ข้อมูลฝั่ง Studio — ฟอร์มที่ผู้ใช้ออกแบบเอง, การแชร์แม่แบบ, แชทกับ AI,
 * บุ๊กมาร์ก และประวัติการสร้างเอกสาร
 *
 * ⚠️ `templateKey` คือ id ที่คงที่ของแม่แบบ (`TemplateSummary.id` ของ Carbone
 *    ซึ่งเป็นเลข 64-bit) — ถ้าแม่แบบไม่มี (อัปโหลดโดยไม่เปิด versioning)
 *    ให้ใช้ `versionId` แทน
 *    เก็บต่อ templateKey ไม่ใช่ versionId เพราะแม่แบบทุกเวอร์ชัน
 *    ควรใช้ฟอร์มเดียวกัน
 */

// ── ฟิลด์ในฟอร์ม ──────────────────────────────────────────────

/**
 * ชนิด input ที่ให้ผู้ใช้เลือกได้
 *
 * `integer` แยกจาก `number` เพราะกฎ "ต้องเป็นจำนวนเต็ม" ใช้บ่อยมากในเอกสารราชการ
 * (เลขที่หนังสือ ปี จำนวนเอกสาร) และผู้ใช้ต้องการสั่งมันได้ตรง ๆ ไม่ใช่ผ่าน regex
 */
export const FieldType = z.enum([
  'text',
  'textarea',
  'number',
  'integer',
  'select',
  'multiselect',
  'date',
  'checkbox',
  'email',
])
export type FieldType = z.infer<typeof FieldType>

/** ตัวเลือกของ select / multiselect */
export const FieldOption = z.object({
  value: z.string().min(1).max(200),
  label: z.string().min(1).max(200),
})
export type FieldOption = z.infer<typeof FieldOption>

/**
 * กติกาตรวจของฟิลด์เดียว
 *
 * `pattern` เก็บเป็น **string** ไม่ใช่ RegExp เพราะ RegExp ไม่ serialise เป็น JSON
 * (จะกลายเป็น {}) — ต้อง compile ใหม่ทุกครั้งที่ validate และต้องหนี pattern ตัวเองด้วย
 */
export const FieldRule = z.object({
  /** regex ต้อง match ทั้งหมด (ไม่ใช่บางส่วน) */
  pattern: z.string().max(500).optional(),
  /** ข้อความแสดงเมื่อไม่ผ่าน pattern */
  patternMessage: z.string().max(200).optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  minLength: z.number().int().min(0).optional(),
  maxLength: z.number().int().min(0).optional(),
  /** บังคับให้เป็นจำนวนเต็ม (สำหรับ type number) */
  integer: z.boolean().optional(),
})
export type FieldRule = z.infer<typeof FieldRule>

/** พฤติกรรมของ AI เมื่อช่วยกรอกฟิลด์นี้ */
export const FieldAi = z.object({
  /** เปิดให้ AI ช่วยเติมค่าให้ฟิลด์นี้ (default true) */
  enabled: z.boolean().default(true),
  /** บอก AI ว่าค่าควรเป็นแบบไหน เช่น "วันที่ออกเอกสาร ใส่เป็น วันที่ พ.ศ." */
  hint: z.string().max(300).optional(),
})
export type FieldAi = z.infer<typeof FieldAi>

export const FieldDef = z.object({
  /**
   * path ใน object `data` — รองรับ nested ด้วยจุด เช่น `ผู้รับ.ชื่อ`
   * ต้องตรงกับแท็ก `{d.…}` ในไฟล์แม่แบบ (ถ้าไม่ตรง Carbone จะไม่แทนค่าให้)
   */
  key: z.string().min(1).max(200),
  /** ข้อความบน label — ถ้าว่างจะใช้ key */
  label: z.string().max(200).default(''),
  type: FieldType.default('text'),
  /** จัดกลุ่มในฟอร์ม — ฟิลด์ว่างอยู่กลุ่ม 'ทั่วไป' */
  group: z.string().max(100).default(''),
  /** ลำดับในกลุ่ม — น้อยก่อน */
  order: z.number().int().default(0),
  required: z.boolean().default(false),
  placeholder: z.string().max(200).optional(),
  help: z.string().max(500).optional(),
  defaultValue: z.unknown().optional(),
  options: z.array(FieldOption).max(100).optional(),
  rules: FieldRule.optional(),
  ai: FieldAi.optional(),
})
export type FieldDef = z.infer<typeof FieldDef>

/** เอกสาร schema ของฟอร์ม 1 แม่แบบ (เก็บใน MongoDB collection `form_schemas`) */
export const FormSchema = z.object({
  _id: z.string(),
  templateKey: z.string(),
  name: z.string().nullable(),
  fields: z.array(FieldDef),
  updatedAt: z.date(),
  updatedBy: z.string().nullable(),
})
export type FormSchema = z.infer<typeof FormSchema>

export const UpsertFormBody = z.object({
  /** id ที่คงที่ของแม่แบบ — ใช้เป็น key */
  templateKey: z.string().min(1).max(200),
  fields: z.array(FieldDef).max(200),
})
export type UpsertFormBody = z.infer<typeof UpsertFormBody>

// ── การแชร์และสิทธิ์ ──────────────────────────────────────────

export const Visibility = z.enum(['private', 'published'])
export type Visibility = z.infer<typeof Visibility>

/** สิทธิ์ที่ให้เจ้าของแม่แบบแชร์ให้แต่ละคน */
export const AccessRole = z.enum(['viewer', 'editor'])
export type AccessRole = z.infer<typeof AccessRole>

export const AccessEntry = z.object({
  templateKey: z.string(),
  visibility: Visibility,
  owner: z.string(),
  ownerName: z.string().nullable(),
  sharedWith: z.array(
    z.object({
      sub: z.string(),
      name: z.string().nullable(),
      role: AccessRole,
      at: z.date(),
    }),
  ),
  updatedAt: z.date(),
})
export type AccessEntry = z.infer<typeof AccessEntry>

export const SetAccessBody = z.object({
  templateKey: z.string().min(1).max(200),
  visibility: Visibility,
})
export type SetAccessBody = z.infer<typeof SetAccessBody>

export const ShareBody = z.object({
  templateKey: z.string().min(1).max(200),
  /** subject ของผู้ถูกแชร์ (จาก Casdoor) */
  sub: z.string().min(1).max(200),
  /** ชื่อที่แสดง — บันทึกไว้กัน user ที่ยังไม่เคยล็อกอินหน้าเว็บนี้ */
  name: z.string().max(200).optional(),
  role: AccessRole.default('viewer'),
})
export type ShareBody = z.infer<typeof ShareBody>

/** สิทธิ์ของผู้ใช้ปัจจุบันที่มีต่อแม่แบบหนึ่งตัว */
export const AccessView = z.object({
  templateKey: z.string(),
  /** owner = เจ้าของ · shared = ถูกแชร์ให้เรา · published = เปิดสาธารณ */
  relation: z.enum(['owner', 'shared', 'published']),
  role: AccessRole.nullable(),
  canEdit: z.boolean(),
  visibility: Visibility,
  owner: z.string().nullable(),
  ownerName: z.string().nullable(),
  sharedWith: z.array(
    z.object({ sub: z.string(), name: z.string().nullable(), role: AccessRole, at: z.date() }),
  ),
})
export type AccessView = z.infer<typeof AccessView>

// ── แชทกับ AI ────────────────────────────────────────────────

export const ChatRole = z.enum(['user', 'assistant'])
export type ChatRole = z.infer<typeof ChatRole>

/**
 * ข้อความในแชท
 *
 * `data` คือ JSON ที่ AI เตรียมให้ในข้อความนั้น
 * เก็บไว้เพื่อย้อนดูว่า "รอบนี้ AI เดาให้อะไร" ไม่ใช่แค่ข้อความตอบ
 */
export const ChatMessage = z.object({
  id: z.string(),
  role: ChatRole,
  content: z.string(),
  /** ข้อมูลที่ AI เติมให้ในรอบนี้ (เฉพาะฝั่ง assistant) */
  data: z.record(z.string(), z.unknown()).nullable().default(null),
  at: z.date(),
})
export type ChatMessage = z.infer<typeof ChatMessage>

export const ChatSession = z.object({
  _id: z.string(),
  templateKey: z.string(),
  title: z.string(),
  user: z.string(),
  messages: z.array(ChatMessage),
  createdAt: z.date(),
  updatedAt: z.date(),
})
export type ChatSession = z.infer<typeof ChatSession>

/**
 * ขอบเขต "คุยกับ AI เฉพาะช่องเดียว" — ใช้กับไอคอน AI ที่อยู่ข้างช่องกรอก
 *
 * โหมดนี้ต่างจากแชทใหญ่ตรงที่
 *   · โมเดลโฟกัสแค่ช่องเดียว (ร่างข้อความ · แก้ให้อ่านง่าย · ให้คำแนะนำ)
 *   · ค่าที่ AI เสนอ **ไม่ถูกเขียนทับช่องทันที** — ผู้ใช้ต้องกดยืนยันเอง
 *   · ไม่บันทึกลงประวัติแชท (เป็นเรื่องชั่วคราวของช่องนั้น)
 */
export const ChatField = z.object({
  /** key ของช่องในฟอร์ม ต้องตรงกับแท็ก `{d.…}` */
  key: z.string().min(1).max(200),
  /** ป้ายที่ผู้ใช้เห็นหน้าจอ — ใส่ใน prompt ให้ AI รู้ว่าช่วยเรื่องอะไร */
  label: z.string().max(200).optional(),
  /** ชนิดช่อง: `text` · `textarea` · `email` · `date` */
  type: z.string().max(40).optional(),
  /** ค่าที่ผู้ใช้กรอกไว้แล้ว (ถ้ามี) — ให้ AI แก้ต่อจากของเดิม */
  value: z.string().max(8000).optional(),
})
export type ChatField = z.infer<typeof ChatField>

export const ChatBody = z.object({
  templateKey: z.string().min(1).max(200),
  /** เว้นว่าง = เริ่ม session ใหม่ */
  sessionId: z.string().max(100).optional(),
  /** สิ่งที่ผู้ใช้พิมพ์ — คนละย่อหนึ่งรอบ */
  message: z.string().min(1).max(4000),
  /** ข้อมูลที่กรอกไว้แล้ว ให้ AI รู้ว่าขาดอะไร */
  data: z.record(z.string(), z.unknown()).default({}),
  /** ชื่อแม่แบบ — ใส่ใน prompt ให้ AI เข้าใจบริบท */
  templateName: z.string().max(200).optional(),
  /** ถ้ามี = จำกัดขอบเขตเป็นช่องเดียว (ไอคอน AI ข้างช่องกรอก) */
  field: ChatField.optional(),
})
export type ChatBody = z.infer<typeof ChatBody>

export const ChatReply = z.object({
  sessionId: z.string(),
  /** ข้อความตอบของ AI ในรูปแบบที่อ่านรู้เรื่อง */
  reply: z.string(),
  /** ข้อมูลที่ได้หลัง merge กับของเดิม */
  data: z.record(z.string(), z.unknown()),
  /** key ที่ AI เพิ่มหรือแก้ในรอบนี้ */
  changed: z.array(z.string()),
  provider: z.string(),
  model: z.string(),
})
export type ChatReply = z.infer<typeof ChatReply>

/** สถานะ LLM — ให้ UI แสดงว่าตั้งค่าแล้วหรือยัง (และใช้ provider อะไรอยู่) */
export const LlmStatus = z.object({
  configured: z.boolean(),
  provider: z.string(),
  model: z.string(),
  /** เหตุผลที่ยังใช้ไม่ได้ — แสดงให้ผู้ใช้อ่านเข้าใจ */
  reason: z.string().nullable(),
})
export type LlmStatus = z.infer<typeof LlmStatus>

// ── บุ๊กมาร์ก ────────────────────────────────────────────────

export const BookmarkRecord = z.object({
  _id: z.string(),
  user: z.string(),
  templateKey: z.string(),
  versionId: z.string(),
  templateName: z.string().nullable(),
  note: z.string().max(500).nullable(),
  createdAt: z.date(),
})
export type BookmarkRecord = z.infer<typeof BookmarkRecord>

export const CreateBookmarkBody = z.object({
  templateKey: z.string().min(1).max(200),
  versionId: z.string().min(1).max(200),
  templateName: z.string().max(200).optional(),
  note: z.string().max(500).optional(),
})
export type CreateBookmarkBody = z.infer<typeof CreateBookmarkBody>

// ── ประวัติการสร้างเอกสาร ────────────────────────────────────

/** สรุปต่อคน — "ใครใช้แม่แบบนี้บ้าง" */
export const HistoryUser = z.object({
  sub: z.string(),
  name: z.string().nullable(),
  count: z.number(),
  lastAt: z.date(),
  okCount: z.number(),
  failCount: z.number(),
})
export type HistoryUser = z.infer<typeof HistoryUser>

export const TemplateHistory = z.object({
  users: z.array(HistoryUser),
  items: z.array(
    z.object({
      _id: z.string(),
      label: z.string().nullable(),
      status: z.string(),
      outputFormat: z.string(),
      createdBy: z.string().nullable(),
      createdByName: z.string().nullable(),
      createdAt: z.date(),
    }),
  ),
  total: z.number(),
})
export type TemplateHistory = z.infer<typeof TemplateHistory>

/**
 * ประวัติของ **ฉันเอง** กับแม่แบบหนึ่งตัว — เอาไว้กู้ค่ามาแก้ต่อ
 *
 * ⚠️ ต่างจาก `TemplateHistory` ตรงที่คืน `data` ด้วย
 *    จึง**ต้อง**กรองด้วย `createdBy = ผู้เรียก` เสมอ
 *    ค่าที่กรอกของคนอื่น (ชื่อ เลขบัตร ที่อยู่) ห้ามหลุดออกไป
 */
export const MyHistoryItem = z.object({
  _id: z.string(),
  label: z.string().nullable(),
  status: z.string(),
  outputFormat: z.string(),
  createdAt: z.date(),
  /** ค่าที่กรอกตอนสั่งเรนเดอร์ครั้งนั้น — เอกสารเก่าจะเป็น `{}` */
  data: z.record(z.string(), z.unknown()),
})
export type MyHistoryItem = z.infer<typeof MyHistoryItem>

export const MyTemplateHistory = z.object({
  items: z.array(MyHistoryItem),
  total: z.number(),
})
export type MyTemplateHistory = z.infer<typeof MyTemplateHistory>

/** ค้นหาในประวัติ — คำค้นว่าง = ไม่กรอง */
export const MyHistoryQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(30),
  /**
   * ข้ามกี่ฉบับ — ใช้แบ่งหน้า
   *
   * ⚠️ เพดานไว้ที่ 50,000 เหมือน `/history/:key` เพราะ `skip` ต้องไล่ทีละเอกสาร
   *    ถ้าไม่เพดาน ผู้ใช้พิมพ์ `?skip=99999999` แล้วค้างจน API ตอบไม่ทัน
   */
  skip: z.coerce.number().int().min(0).max(50_000).default(0),
  /** ค้นทั้งชื่อฉบับและค่าที่กรอกไว้ (เช่น ชื่อผู้รับ) */
  q: z.string().max(200).default(''),
})
export type MyHistoryQuery = z.infer<typeof MyHistoryQuery>

// ── ตัวช่วยจัดการฟอร์ม ────────────────────────────────────────

/** อ่านค่าแบบ dot path — `ผู้รับ.ชื่อ` */
export function getPath(data: Record<string, unknown>, path: string): unknown {
  const parts = path.split('.')
  let cur: unknown = data
  for (const p of parts) {
    if (cur === null || typeof cur !== 'object') return undefined
    cur = (cur as Record<string, unknown>)[p]
  }
  return cur
}

/**
 * เขียนค่าแบบ dot path โดย **ไม่แก้ object เดิม**
 *
 * คืนค่า object ใหม่เสมอ เพราะ React เทียบด้วย reference —
 * ถ้าแก้ของเดิมในที่ state จะไม่ re-render
 */
export function setPath(
  data: Record<string, unknown>,
  path: string,
  value: unknown,
): Record<string, unknown> {
  const parts = path.split('.').filter(Boolean)
  const out: Record<string, unknown> = { ...data }
  if (parts.length === 0) {
    out[path] = value
    return out
  }
  let cur = out
  for (const p of parts.slice(0, -1)) {
    const child = cur[p]
    const next =
      child && typeof child === 'object' && !Array.isArray(child)
        ? { ...(child as Record<string, unknown>) }
        : {}
    cur[p] = next
    cur = next
  }
  // parts ไม่ว่างแล้ว ประกันว่ามีสมาชิกสุดท้ายเสมอ
  cur[parts[parts.length - 1]!] = value
  return out
}

/** ลบ key ทิ้งแบบ dot path */
export function deletePath(
  data: Record<string, unknown>,
  path: string,
): Record<string, unknown> {
  const parts = path.split('.').filter(Boolean)
  if (parts.length === 0) return { ...data }
  const out: Record<string, unknown> = { ...data }
  let cur = out
  for (const p of parts.slice(0, -1)) {
    const child = cur[p]
    if (!child || typeof child !== 'object' || Array.isArray(child)) return out
    const next = { ...(child as Record<string, unknown>) }
    cur[p] = next
    cur = next
  }
  delete cur[parts[parts.length - 1]!]
  return out
}

/**
 * merge ข้อมูลจาก AI เข้ากับของเดิม
 *
 * - ค่าใหม่ → เพิ่ม
 * - ค่าเดิมว่าง → เติม
 * - ค่าเดิมที่ผู้ใช้กรอกเอง → **คงไว้** (ไม่ให้ AI ไปทับของที่คนพิมพ์เอง)
 *
 * คืนทั้งข้อมูลใหม่และรายการ key ที่เปลี่ยน เพื่อให้ UI บอกผู้ใช้ได้
 */
export function mergeAiData(
  current: Record<string, unknown>,
  incoming: Record<string, unknown>,
): { data: Record<string, unknown>; changed: string[] } {
  let data: Record<string, unknown> = { ...current }
  const changed: string[] = []
  for (const [key, value] of Object.entries(incoming)) {
    const existing = getPath(data, key)
    const empty =
      existing === undefined ||
      existing === null ||
      existing === '' ||
      (Array.isArray(existing) && existing.length === 0)
    if (empty && value !== null && value !== undefined) {
      data = setPath(data, key, value)
      changed.push(key)
    }
  }

  return { data, changed }
}

/** เรียงฟิลด์ตาม group แล้ว order — ใช้ตอน render */
export function sortFields(fields: FieldDef[]): FieldDef[] {
  return [...fields].sort((a, b) => {
    const g = (a.group || '').localeCompare(b.group || '', 'th')
    if (g !== 0) return g
    if (a.order !== b.order) return a.order - b.order
    return a.key.localeCompare(b.key, 'th')
  })
}

/** จัดกลุ่มฟิลด์ตามชื่อ group คืนมา เรียงตามตัวอักษร */
export function groupFields(
  fields: FieldDef[],
): Array<{ group: string; fields: FieldDef[] }> {
  const map = new Map<string, FieldDef[]>()
  for (const f of sortFields(fields)) {
    const g = f.group || 'ทั่วไป'
    const list = map.get(g)
    if (list) list.push(f)
    else map.set(g, [f])
  }
  return [...map.entries()].map(([group, list]) => ({ group, fields: list }))
}

/** สร้าง regex จาก pattern ของฟิลด์ — คืน null ถ้า pattern ผิด */
export function compilePattern(pattern: string | undefined): RegExp | null {
  if (!pattern) return null
  try {
    return new RegExp(pattern)
  } catch {
    return null
  }
}

/**
 * ตรวจข้อมูลทั้งชุดตามฟิลด์
 *
 * คืน map `path → ข้อความ error` (ว่าง = ผ่านทั้งหมด)
 * ใช้ทั้งในฟอร์มเว็บ (ตรวจสดขณะพิมพ์) และที่ API ก่อนรันเรนเดอร์
 */
export function validateFormData(
  fields: FieldDef[],
  data: Record<string, unknown>,
): Record<string, string> {
  const errors: Record<string, string> = {}

  for (const f of fields) {
    const raw = getPath(data, f.key)
    const isBlank =
      raw === undefined ||
      raw === null ||
      raw === '' ||
      (Array.isArray(raw) && raw.length === 0)

    if (f.required && isBlank) {
      errors[f.key] = 'ช่องนี้ต้องกรอก'
      continue
    }
    if (isBlank) continue

    // checkbox ใช้ boolean ไม่ใช่ string
    if (f.type === 'checkbox') {
      if (typeof raw !== 'boolean') errors[f.key] = 'ต้องเป็นค่าใช่/ไม่ใช่'
      continue
    }

    if (f.type === 'multiselect' || f.type === 'select') {
      const values = Array.isArray(raw) ? raw.map(String) : [String(raw)]
      const allowed = new Set((f.options ?? []).map((o) => o.value))
      if (allowed.size > 0 && values.some((v) => !allowed.has(v))) {
        errors[f.key] = 'ค่าที่เลือกไม่อยู่ในรายการที่กำหนด'
        continue
      }
    }

    if (f.type === 'integer' || f.type === 'number' || f.rules?.integer) {
      const n = typeof raw === 'number' ? raw : Number(String(raw).replace(/,/g, ''))
      if (Number.isNaN(n)) {
        errors[f.key] = 'ต้องเป็นตัวเลข'
        continue
      }
      if ((f.type === 'integer' || f.rules?.integer) && !Number.isInteger(n)) {
        errors[f.key] = 'ต้องเป็นจำนวนเต็ม'
        continue
      }
      if (f.rules?.min !== undefined && n < f.rules.min) {
        errors[f.key] = `ต้องไม่น้อยกว่า ${f.rules.min}`
        continue
      }
      if (f.rules?.max !== undefined && n > f.rules.max) {
        errors[f.key] = `ต้องไม่มากกว่า ${f.rules.max}`
        continue
      }
    }

    if (f.type === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(raw))) {
      errors[f.key] = 'รูปแบบอีเมลไม่ถูกต้อง'
      continue
    }

    const text = Array.isArray(raw) ? raw.join(', ') : String(raw)
    if (f.rules?.minLength !== undefined && text.length < f.rules.minLength) {
      errors[f.key] = `ต้องมีอย่างน้อย ${f.rules.minLength} ตัวอักษร`
      continue
    }
    if (f.rules?.maxLength !== undefined && text.length > f.rules.maxLength) {
      errors[f.key] = `ต้องไม่เกิน ${f.rules.maxLength} ตัวอักษร`
      continue
    }

    const re = compilePattern(f.rules?.pattern)
    if (re && !re.test(text)) {
      errors[f.key] = f.rules?.patternMessage || 'รูปแบบไม่ตรงตามที่กำหนด'
      continue
    }
  }

  return errors
}

/** ตัวอย่างค่าเริ่มต้นของฟิลด์ 1 ตัว (ตามชนิด) — ใช้ตอนกด "เติมจากแท็ก" */
export function sampleValueFor(
  f: Pick<FieldDef, 'type' | 'options' | 'defaultValue'>,
): unknown {
  if (f.defaultValue !== undefined) return f.defaultValue
  const first = f.options?.[0]
  switch (f.type) {
    case 'checkbox':
      return false
    case 'number':
    case 'integer':
      return 0
    case 'multiselect':
      return first ? [first.value] : []
    case 'select':
      return first ? first.value : ''
    case 'date':
      return ''
    default:
      return ''
  }
}
