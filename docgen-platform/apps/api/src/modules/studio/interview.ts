import { env } from '@docgen/shared'
import {
  AppError,
  getPath,
  mergeAiData,
  sampleValueFor,
  type FieldDef,
  type InterviewPlanBody,
  type InterviewPlanReply,
  type InterviewQuestion,
  type InterviewComposeBody,
  type InterviewComposeReply,
} from '@docgen/shared'
import type { App } from '../../types.js'
import { getFormSchema } from './service.js'
import { callModel, keepKnownKeys } from './llm.js'
import { readTemplateTags } from '../templates/tags.js'
import * as carbone from '../templates/carbone.js'

/**
 * สัมภาษณ์ผู้ใช้เพื่อกรอกฟอร์ม
 *
 * ── ต่างจากแชทอิสระ (`/chat`) อย่างไร ──────────────────────────────────
 *   แชทอิสระ: ผู้ใช้เล่าเอง → AI เดาค่าที่เหลือ (เร็ว แต่เสี่ยงแต่งข้อมูลที่ไม่มีจริง)
 *   สัมภาษณ์:    **โมเดลเป็นคนถาม** ทีละช่องที่ยังขาด → ผู้ใช้ตอบเฉพาะที่รู้จริง
 *                → AI เรียบเรียงคำตอบให้ตรงกับชนิดชอง (input property)
 *   จึงได้ข้อมูลที่ตรวจสอบได้ก่อนนำไปใส่เอกสารราชการจริง
 *
 * ⚠️ หัวใจคือ "ถามเฉพาะช่องที่ยังขาด" — ถ้าถามช่องที่ผู้ใช้กรอกเองแล้ว
 *   ระบบจะดูเหมือนไม่รู้ว่าอ่านข้อมูลเดิม และเสี่ยงทับค่าที่ถูกต้องไป
 */

/**
 * provider ที่จะใช้กับคำขอนี้
 *
 * ⚠️ ต้องตกไปที่ `env.LLM_PROVIDER` เมื่อ**ไม่ได้ส่งมา** ไม่ใช่ `'mock'`
 *   ผู้ใช้สั่ง 2026-10-06: ถอบตัวเลือกผู้ให้บริการออกจากหน้าเว็บ (ใช้ MiniMax อย่างเดียว)
 *   หน้าเว็บจึง**ไม่ส่ง** `provider` มาอีกต่อไป
 *   ถ้า default เป็น mock ตามเดิม ฟีเจอร์ทั้งหมดจะเงียบ ๆ กลายเป็นโหมดทดสอบ
 *   (ยัง "ทำงานได้" ผ่าน แต่ไม่ได้คิดจริง) และไม่มีอะไรฟ้อง
 *   → เหลือ `mock` เฉพาะตอน**สั่งมา**ชัดเจน (สคริปต์ทดสอบ / เครื่องที่ยังไม่ตั้ง key)
 */
function resolveProvider(requested?: string): string {
  return requested ?? env.LLM_PROVIDER
}

/** ช่องที่ควรถาม: ยังว่าง + เปิดให้ AI ช่วย + ไม่ใช่ชนิดที่ไม่มีค่าให้ถาม (เช่น checkbox ไม่ต้องถาม) */
function askableFields(fields: FieldDef[], data: Record<string, unknown>): FieldDef[] {
  return fields.filter((f) => {
    if (f.ai?.enabled === false) return false
    // ⚠️ ต้องใช้ getPath — key ของช่องมีจุดคั่น (เช่น `ผู้สมัคร.ชื่อ`) และค่าในฟอร์ม
    //   เก็บเป็น object ซ้อน การอ่าน data[f.key] จะได้ undefined **เสมอ**
    //   → ช่องที่ผู้ใช้กรอกเองแล้วจะถูกนับเป็น "ยังว่าง" และถูกถามซ้ำ
    const v = getPath(data, f.key)
    const empty = v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0)
    return empty
  })
}

/** ตัวเลือกของช่อง — ใช้ทั้งตอนถาม (ปุ่มให้กด) และตอนตรวจคำตอบ */
function optionsOf(f: FieldDef): string[] {
  return (f.options ?? []).map((o) => o.value)
}

/** คำอธิบายช่องให้โมเดลเข้าใจ — ยิ่งละเอียดยิ่งถามตรง */
function describeField(f: FieldDef): string {
  const parts = [`- key: ${f.key} | ชนิด: ${f.type}`]
  if (f.label) parts.push(`| ป้าย: ${f.label}`)
  if (f.required) parts.push('| จำเป็นต้องมี')
  if (f.help) parts.push(`| คำอธิบาย: ${f.help}`)
  if (f.ai?.hint) parts.push(`| ต้องการ: ${f.ai.hint}`)
  if (f.options?.length) parts.push(`| ตัวเลือกที่มี: ${f.options.map((o) => o.value).join(', ')}`)
  return parts.join(' ')
}

/** system prompt สำหรับขั้น "วางแผนคำถาม" */
function buildPlanPrompt(input: {
  templateName?: string
  pending: FieldDef[]
  mode: 'one' | 'batch'
  count: number
  answers: Record<string, string>
  asked: string[]
}): string {
  const { templateName, pending, mode, count, answers, asked } = input
  const lines: string[] = [
    'คุณเป็นผู้สัมภาษณ์เพื่อเก็บข้อมูลสำหรับสร้างเอกสารราชการไทย',
    templateName ? `เอกสารที่กำลังทำคือ "${templateName}"` : '',
    '',
    'หน้าที่ของคุณ: ถามผู้ใช้เป็นคำถาม **ทีละช่อง** เพื่อเก็บค่าที่ยังขาด',
    'ห้ามถามเกินหนึ่งเรื่องต่อหนึ่งคำถาม และห้ามถามเรื่องที่ถามไปแล้ว',
    'ห้ามเดาแทนผู้ใช้ — ถามให้เขาตอบเองเท่านั้น',
    '',
    'ตอบกลับเป็น JSON หนึ่ง object ในรูปแบบนี้:',
    '{',
    '  "_reply": "คำอธิบายสั้น ๆ ว่ากำลังจะถามเรื่องอะไร ภาษาไทย ไม่เกิน 2 บรรทัด",',
    '  "_questions": [',
    '    { "key": "<key ของช่อง>", "question": "<คำถามที่ถามผู้ใช้>", "help": "<คำอธิบายสั้น ๆ ถ้าจำเป็น>" }',
    '  ]',
    '}',
    '',
    'กฎสำคัญ:',
    '- ใช้ key ข้างล่างเท่านั้น ห้ามสร้าง key ใหม่',
    '- ถามเป็นภาษาไทยที่สุภาพ ใช้คำทางการ เช่น "กรุณาระบุ…"',
    '- ถ้าเป็นช่องวันที่ ให้ถามวัน/เดือน/ปี พ.ศ. ในคำถามด้วย',
    '- ถ้าช่องมีตัวเลือกที่กำหนด ให้ใส่ "options": ["ตัวเลือก1", "ตัวเลือก2"] เพื่อให้ผู้ใช้เลือกได้',
    mode === 'one'
      ? '- ถามครั้งละ **1 คำถาม** เท่านั้น'
      : `- ถามได้ไม่เกิน ${count} คำถามต่อรอบ และควรเป็นเรื่องที่เกี่ยวกัน`,
    '- ถ้าไม่มีช่องไหนเหลือให้ถามแล้ว ให้ตอบแค่ { "_reply": "…", "_questions": [] }',
  ]

  if (Object.keys(answers).length > 0) {
    lines.push('', 'ผู้ใช้ตอบไปแล้วดังนี้ (ห้ามถามซ้ำ):')
    for (const [k, v] of Object.entries(answers)) {
      const f = pending.find((x) => x.key === k)
      lines.push(`- ${f?.label || k}: ${v}`)
    }
  }
  if (asked.length > 0) lines.push('', `ถามไปแล้วแต่ยังไม่ได้คำตอบ: ${asked.join(', ')}`)

  lines.push('', 'ช่องที่ยังว่างและต้องถาม:')
  for (const f of pending) lines.push(describeField(f))

  return lines.filter((l) => l !== '').join('\n')
}

/** system prompt สำหรับขั้น "เรียบเรียงคำตอบเป็นค่าของช่อง" */
function buildComposePrompt(input: {
  templateName?: string
  fields: FieldDef[]
  answers: Record<string, string>
}): string {
  const { templateName, fields, answers } = input
  const byKey = new Map(fields.map((f) => [f.key, f]))

  const lines: string[] = [
    'คุณเป็นผู้ช่วยแปลงคำตอบของผู้ใช้ให้เป็นค่าที่ช่องกรอกรับได้',
    templateName ? `เอกสารที่กำลังทำคือ "${templateName}"` : '',
    '',
    'หน้าที่ของคุณ: เอาคำตอบเชิงภาษา (เช่น "พรุ่งนี้เช้า") ไปแปลงเป็น **ค่าที่ช่องนั้นรับได้จริง**',
    'ตอบกลับเป็น JSON หนึ่ง object ในรูปแบบนี้:',
    '{',
    '  "_reply": "สรุปสั้น ๆ ว่าเติมอะไรบ้าง ภาษาไทย ไม่เกิน 3 บรรทัด",',
    '  "<key ของช่อง>": "<ค่าที่เข้ากับชนิดของช่องนั้น>"',
    '}',
    '',
    'กฎสำคัญ:',
    '- ใช้ key ข้างล่างเท่านั้น ห้ามสร้าง key ใหม่',
    '- **ห้ามแต่งข้อมูล** ถ้าคำตอบไม่ครบ ให้เว้นช่องนั้นไว้ (ไม่ต้องใส่ key ลงไปเลย)',
    '- ช่อง number/integer → ตัวเลขล้วน ไม่มีหน่วย ไม่มีจุลภาค ไม่มีเครื่องหมายคั่นพัน',
    '- ช่อง date → เขียนเป็น วัน/เดือน/ปี พ.ศ. เช่น "15 มกราคม 2569"',
    '- ช่อง select → ต้องเป็นค่าที่อยู่ในรายการตัวเลือกที่กำหนดเท่านั้น',
    '- ช่อง checkbox → true หรือ false',
    '- ช่อง email → ต้องเป็นอีเมลที่ถูกต้อง',
    '- ช่อง textarea → ข้อความยาวได้ ใช้ \\n ได้',
    '- ถ้ามีกฎความยาว/ช่วงค่า ต้องทำให้ค่าที่ได้อยู่ในช่วงนั้น',
  ]

  lines.push('', 'คำตอบของผู้ใช้ และช่องที่ต้องการ:')
  for (const [key, answer] of Object.entries(answers)) {
    const f = byKey.get(key)
    lines.push(`- ${describeField(f ?? { key, type: 'text', label: '', group: '', order: 0, required: false })}`)
    lines.push(`  คำตอบ: ${answer}`)
  }

  return lines.filter((l) => l !== '').join('\n')
}

/**
 * แปลงคำตอบของผู้ใช้ให้เข้ากับชนิดของช่อง **ฝั่งเซิร์ฟเวอร์**
 *
 * ── ทำไมต้องแปลงซ้ำฝั่งเซิร์ฟเวอร์ แม้โมเดลจะถูกสั่งแล้ว ──────────────
 *   โมเดลเป็น LLM — ถึงสั่งว่า "ตัวเลขล้วน" ก็ยังคืน "๑๒๓" หรือ "12 ห้อง" ได้
 *   ถ้าปล่อยผ่านไป ผู้ใช้จะเจอช่องที่ validate ไม่ผ่าน แล้วหาว่าทำไม
 *   แต่ไม่บอกว่าคำตอบตัวเองผิดรูป → แก้ที่ต้นเหตุคือตรงนี้
 */
function coerceForField(f: FieldDef | undefined, raw: unknown): unknown | undefined {
  if (raw === null || raw === undefined) return undefined
  const text = typeof raw === 'string' ? raw.trim() : raw

  switch (f?.type) {
    case 'integer':
    case 'number': {
      // ดึงเฉพาะตัวเลขออกมา — รองรับ "12 ห้อง", "อัตรา 5%", "๑,๒๓๔"
      const digits = String(text).replace(/[๐-๙]/g, (c) => String(c.charCodeAt(0) - 0x0e50))
      const m = /-?\d+(?:\.\d+)?/.exec(digits.replace(/,/g, ''))
      if (!m) return undefined
      const n = Number(m[0])
      if (!Number.isFinite(n)) return undefined
      let v = f.type === 'integer' ? Math.round(n) : n
      if (f.rules?.min !== undefined && v < f.rules.min) v = f.rules.min
      if (f.rules?.max !== undefined && v > f.rules.max) v = f.rules.max
      return v
    }
    case 'checkbox': {
      if (typeof text === 'boolean') return text
      const s = String(text).toLowerCase()
      return ['true', 'yes', 'ใช่', 'ต้องการ', '1', 'มี'].some((y) => s.includes(y))
    }
    case 'select': {
      const opts = optionsOf(f)
      if (opts.length === 0) return typeof text === 'string' ? text : String(text)
      const s = String(text)
      // จับคู่แบบตรงก่อน แล้วค่อยแบบครอบคำ (โมเดลมักใส่คำอธิบายเพิ่ม)
      const hit = opts.find((o) => o === s) ?? opts.find((o) => s.includes(o) || o.includes(s))
      return hit
    }
    case 'multiselect': {
      const opts = optionsOf(f)
      const s = typeof text === 'string' ? text : String(text)
      const picked = opts.filter((o) => s.includes(o))
      return picked.length ? picked : undefined
    }
    case 'email': {
      const m = /[\w.+-]+@[\w-]+\.[\w.-]+/.exec(String(text))
      return m ? m[0] : undefined
    }
    default: {
      if (typeof text !== 'string') return text
      const max = f?.rules?.maxLength
      const min = f?.rules?.minLength
      let s = text
      if (max && s.length > max) s = s.slice(0, max)
      if (min && s.length > 0 && s.length < min) return undefined   // สั้นเกิน → ทิ้ง ดีกว่าเติมค่าที่ validate ไม่ผ่าน
      return s
    }
  }
}

/** mock ของขั้นวางแผน — ถามตาม label ของช่อง ไม่ต้องใช้ key */
function mockPlan(input: { pending: FieldDef[]; mode: 'one' | 'batch'; count: number }) {
  const slice = input.mode === 'one' ? input.pending.slice(0, 1) : input.pending.slice(0, input.count)
  return slice.map((f) => ({
    key: f.key,
    question: `กรุณาระบุ${f.label || f.key}${f.required ? ' (จำเป็น)' : ''}`,
    options: optionsOf(f).length ? optionsOf(f) : undefined,
  }))
}

/** mock ของขั้นเรียบเรียง — ใช้คำตอบดิบตามชนิดชอง (เพื่อทดสอบ flow ฝั่ง UI) */
function mockCompose(input: { fields: FieldDef[]; answers: Record<string, string> }) {
  const byKey = new Map(input.fields.map((f) => [f.key, f]))
  const data: Record<string, unknown> = {}
  for (const [key, answer] of Object.entries(input.answers)) {
    const f = byKey.get(key)
    const v = coerceForField(f, answer)
    if (v !== undefined) data[key] = v
  }
  return data
}

async function fieldsAndTags(
  app: App,
  templateKey: string,
): Promise<{ fields: FieldDef[]; tags: string[] }> {
  const form = await getFormSchema(app, templateKey)
  const fields = form?.fields ?? []
  if (fields.length > 0) return { fields, tags: [] }
  // ยังไม่ได้ตั้งฟอร์ม → ใช้แท็กของแม่แบบเป็นคีย์สำรอง (เหมือน /chat)
  try {
    const { items } = await carbone.listTemplates({ templateId: templateKey })
    const paths = new Set<string>()
    for (const t of items) {
      const r = await readTemplateTags(t.versionId)
      for (const tag of r.items) paths.add(tag.path)
    }
    return { fields: [], tags: [...paths] }
  } catch {
    return { fields: [], tags: [] }
  }
}

/** ขั้นที่ 1 — ขอคำถามชุดถัดไป */
export async function planInterview(
  app: App,
  input: InterviewPlanBody,
): Promise<InterviewPlanReply> {
  const { fields, tags } = await fieldsAndTags(app, input.templateKey)

  // ยังไม่ได้ตั้งฟอร์ม → ถามจากแท็กแทน (ยังไม่รู้ชนิด จึงถามเป็นข้อความอิสระ)
  const pseudo: FieldDef[] = tags.map((t) => ({
    key: t, label: t, type: 'text', group: '', order: 0, required: false, ai: { enabled: true },
  }))

  const source = fields.length > 0 ? fields : pseudo
  const remainingKeys = askableFields(source, input.data).map((f) => f.key)
  const notAsked = new Set(input.asked)
  const pending = askableFields(source, input.data).filter((f) => !notAsked.has(f.key))
  const provider = resolveProvider(input.provider)

  if (pending.length === 0) {
    return {
      questions: [],
      remaining: [],
      reply: 'ถามครบทุกช่องที่ต้องการแล้ว — กด "วิเคราะห์และเติมข้อมูล" ได้เลย',
      provider,
      model: provider,
    }
  }

  const count = input.mode === 'one' ? 1 : input.batchSize

  if (provider === 'mock') {
    return {
      questions: mockPlan({ pending, mode: input.mode, count }),
      remaining: remainingKeys,
      reply: 'โหมดทดสอบ (mock) — ถามตามชื่อช่องโดยไม่ได้คิดจริง',
      provider: 'mock',
      model: 'mock',
    }
  }

  const { parsed, provider: usedProvider, model } = await callModel({
    system: buildPlanPrompt({
      templateName: input.templateName,
      pending,
      mode: input.mode,
      count,
      answers: input.answers,
      asked: input.asked,
    }),
    // โมเดลต้องเห็นคำตอบที่ผู้ใช้ให้มาแล้วด้วย ถึงจะถามต่อได้โดยไม่หลุดประเด็น
    messages: [{ role: 'user', content: 'เริ่มสัมภาษณ์เพื่อเก็บข้อมูลให้ครบ' }],
    provider,
    log: (meta) => app.log.warn({ ...meta, scope: 'llm' }, 'เรียกโมเดลเพื่อวางแผนคำถามไม่สำเร็จ'),
  })

  const reply = typeof parsed?._reply === 'string' ? parsed._reply : ''
  const rawQuestions = Array.isArray(parsed?._questions) ? (parsed._questions as unknown[]) : []

  const questions: InterviewQuestion[] = rawQuestions
    .map((q): InterviewQuestion | null => {
      const o = (q ?? {}) as Record<string, unknown>
      const key = typeof o.key === 'string' ? o.key : ''
      const question = typeof o.question === 'string' ? o.question.trim() : ''
      // ⚠️ ตัดทิ้งคำถามที่ชี้ key ที่ไม่มีจริง — โมเดลมักแต่ง key ขึ้นเองบ่อย
      if (!key || !remainingKeys.includes(key) || !question) return null
      const f = source.find((x) => x.key === key)
      const opts = Array.isArray(o.options) ? o.options.filter((x): x is string => typeof x === 'string') : undefined
      return {
        key,
        question: question.slice(0, 500),
        help: typeof o.help === 'string' ? o.help.slice(0, 300) : f?.help ?? undefined,
        options: opts?.length ? opts.slice(0, 20) : optionsOf(f!).length ? optionsOf(f!) : undefined,
      }
    })
    .filter((q): q is InterviewQuestion => q !== null)
    .slice(0, count)

  if (questions.length === 0 && reply) {
    app.log.warn({ scope: 'llm' }, 'โมเดลไม่คืนคำถามที่ใช้ได้ — ใช้คำถามสำรองแทน')
  }

  return {
    questions: questions.length
      ? questions
      : mockPlan({ pending, mode: input.mode, count }),
    remaining: remainingKeys,
    reply: questions.length ? reply : 'โมเดลตอบคำถามมาไม่ครบ จึงถามตามชื่อช่องแทน',
    provider: usedProvider,
    model,
  }
}

/** ขั้นที่ 2 — เอาคำตอบมาเรียบเรียงเป็นค่าของช่อง */
export async function composeInterview(
  app: App,
  input: InterviewComposeBody,
): Promise<InterviewComposeReply> {
  const { fields, tags } = await fieldsAndTags(app, input.templateKey)
  const pseudo: FieldDef[] = tags.map((t) => ({
    key: t, label: t, type: 'text', group: '', order: 0, required: false, ai: { enabled: true },
  }))
  const source = fields.length > 0 ? fields : pseudo
  const known = new Set(source.map((f) => f.key))

  // ตัดคำตอบที่ไม่เกี่ยวกับช่องนี้ทิ้งก่อน — ไม่งั้นโมเดลจะเดาค่าให้ช่องที่ไม่มี
  const answers = Object.fromEntries(
    Object.entries(input.answers).filter(([k, v]) => known.has(k) && typeof v === 'string' && v.trim() !== ''),
  )
  /*
   * ⚠️ คำตอบที่ทิ้งต้อง **รายงาน** ไม่ใช่หายเงียบ
   *   เพราะผู้ใช้เพิ่งพิมพ์คำตอบไปด้วยมือ ถ้าหายไปเงียบ ๆ เขาจะเชื่อว่าใส่ไปแล้ว
   *   แต่พอสร้างเอกสารกลับไม่มีค่านั้น → เสียเวลาไปตรวจเอกสารแทนที่จะรู้ตอนนี้
   */
  const rejected = Object.keys(input.answers).filter((k) => !known.has(k))
  const wanted = resolveProvider(input.provider)

  if (Object.keys(answers).length === 0) {
    return {
      data: input.data,
      changed: [],
      skipped: rejected,
      reply: rejected.length > 0 ? 'ไม่พบช่องที่ตรงกับคำตอบที่ส่งมา' : 'ยังไม่มีคำตอบให้ประมวลผล',
      provider: wanted,
      model: wanted,
    }
  }

  let raw: Record<string, unknown>
  let provider: string
  let model: string
  let reply = ''

  if (wanted === 'mock') {
    raw = mockCompose({ fields: source, answers })
    provider = 'mock'
    model = 'mock'
    reply = 'โหมดทดสอบ (mock) — เอาคำตอบมาใส่ตามชนิดชองโดยไม่ได้คิดจริง'
  } else {
    const res = await callModel({
      system: buildComposePrompt({ templateName: input.templateName, fields: source, answers }),
      messages: [{ role: 'user', content: 'เรียบเรียงคำตอบทั้งหมดให้เป็นค่าของแต่ละช่อง' }],
      provider: wanted,
      log: (meta) => app.log.warn({ ...meta, scope: 'llm' }, 'เรียกโมเดลเพื่อเรียบเรียงคำตอบไม่สำเร็จ'),
    })
    provider = res.provider
    model = res.model
    reply = typeof res.parsed?._reply === 'string' ? res.parsed._reply : res.raw.trim().slice(0, 400)
    const allowed = new Set(Object.keys(answers))
    raw = keepKnownKeys(res.parsed ?? {}, allowed)
  }

  // แปลงตามชนิดชอง + ตัดทิ้งที่แปลงไม่ได้ พร้อมบอกผู้ใช้ว่าข้อไหนหลุด
  const coerced: Record<string, unknown> = {}
  const skipped: string[] = []
  for (const [key, value] of Object.entries(raw)) {
    const f = source.find((x) => x.key === key)
    const v = coerceForField(f, value)
    if (v === undefined || v === '') {
      skipped.push(key)
      continue
    }
    coerced[key] = v
  }
  // คำตอบที่ผู้ใช้ให้แต่โมเดลไม่คืนค่ามาเลย → ต้องเตือน ไม่ใช่เงียบทิ้ง
  for (const key of Object.keys(answers)) {
    if (!(key in coerced) && !skipped.includes(key)) skipped.push(key)
  }
  // คำตอบที่ชี้ key ซึ่งไม่มีในฟอร์ม → รายงานรวมไปด้วย (เรียงท้ายสุด = ไม่รกกับของที่แปลงไม่ได้)
  for (const key of rejected) if (!skipped.includes(key)) skipped.push(key)

  const merged = mergeAiData(input.data, coerced)

  app.log.info(
    { templateKey: input.templateKey, provider, changed: merged.changed.length, skipped: skipped.length },
    'สัมภาษณ์เรียบเรียงคำตอบแล้ว',
  )

  return { data: merged.data, changed: merged.changed, skipped, reply, provider, model }
}

/** ค่าเริ่มต้นของช่อง ใช้เป็นตัวอย่างให้ผู้ใช้ดูว่าช่องนี้คาดหวังอะไร */
export function defaultForField(f: FieldDef): unknown {
  return sampleValueFor(f)
}