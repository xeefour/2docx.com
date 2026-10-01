import { env, AppError, type FieldDef } from '@docgen/shared'

/**
 * เรียกโมเดลภาษา — ตั้งใจให้สลับ provider ได้ด้วย env ไม่ต้องแก้โค้ด
 *
 *   LLM_PROVIDER=minimax  → https://api.minimax.io/v1  (ค่าเริ่มต้นเมื่อตั้ง key)
 *   LLM_PROVIDER=openai   → https://api.openai.com/v1  (OpenAI-compatible ทั่วไป)
 *   LLM_PROVIDER=mock     → ไม่ออกเน็ต เดา data จากชื่อฟิลด์ (ใช้ทดสอบ pipeline)
 *
 * ทุก provider ใช้ protocol เดียวกัน (OpenAI Chat Completions) จึงมีโค้ดยิงจริง
 * เพียงทางเดียว — ถ้าจะเพิ่ม Anthropic/Gemini ค่อยแตกเป็น adapter ตาม provider
 */

/** base URL เริ่มต้นของแต่ละ provider */
const DEFAULT_BASE: Record<string, string> = {
  minimax: 'https://api.minimax.io/v1',
  openai: 'https://api.openai.com/v1',
}

/** ใช้เมื่อ provider ไม่รู้จัก — OpenAI-compatible เป็นมาตรฐานที่หลายเจ้าใช้ตาม */
const FALLBACK_BASE = 'https://api.openai.com/v1'

export type ChatTurn = { role: 'user' | 'assistant'; content: string }

export type LlmAnswer = {
  /** ข้อความตอบที่อ่านรู้เรื่อง */
  reply: string
  /** JSON ที่โมเดลเตรียมให้ — กรองเฉพาะ key ที่แม่แบบรู้จักแล้ว */
  data: Record<string, unknown>
  provider: string
  model: string
  /** true ถ้าโมเดลตอบไม่ใช่ JSON — reply ยังใช้ได้ แต่ไม่มี data */
  unparsed: boolean
}

/** โครงสร้าง response ที่คาดหวัง (เขียนแค่ส่วนที่ใช้จริง) */
type ChatCompletionResponse = {
  choices?: Array<{ message?: { content?: string | null } }>
  error?: { message?: string; code?: string }
  usage?: { total_tokens?: number }
}

export function llmStatus(): { configured: boolean; provider: string; model: string; reason: string | null } {
  const provider = env.LLM_PROVIDER
  if (provider === 'mock') {
    return { configured: true, provider, model: 'mock', reason: null }
  }
  if (!env.LLM_API_KEY) {
    return {
      configured: false,
      provider,
      model: env.LLM_MODEL,
      reason:
        'ยังไม่ได้ตั้ง LLM_API_KEY — ' +
        'เพิ่ม key ลง .env แล้วรีสตาร์ท API (ตอนนี้ใช้โหมด mock ซึ่งไม่เรียก AI จริง)',
    }
  }
  return { configured: true, provider, model: env.LLM_MODEL, reason: null }
}

function baseUrlFor(provider: string): string {
  const base = env.LLM_BASE_URL ?? DEFAULT_BASE[provider] ?? FALLBACK_BASE
  return base.replace(/\/+$/, '')
}

/**
 * ดึง JSON ออกจากคำตอบของโมเดล
 *
 * โมเดลภาษาชอบห่อ JSON ด้วย ```json ... ``` หรือพ่นคำอธิบายนำหน้า/ท้าย
 * แม้สั่งชัดแล้วก็หลุดบ่อย → ต้องแกะเองอย่างเดียว
 *
 * คืน null ถ้าไม่มี JSON — คนเรียกต้องตัดสินใจว่าจะทำอย่างไรต่อ
 */
export function extractJson(text: string): Record<string, unknown> | null {
  const cleaned = text
    .replace(/```(?:json)?\s*/gi, '')
    .replace(/```/g, '')
    .trim()

  // ไล่จาก { แรกที่วงเปิด–ปิดสมดุล เพราะข้อความนำหน้าอาจมี { ในตัวอักษร
  const start = cleaned.indexOf('{')
  if (start === -1) return null

  let depth = 0
  let inString = false
  let escaped = false

  for (let i = start; i < cleaned.length; i++) {
    const ch = cleaned[i]
    if (escaped) {
      escaped = false
      continue
    }
    if (ch === '\\') {
      escaped = true
      continue
    }
    if (ch === '"') {
      inString = !inString
      continue
    }
    if (inString) continue
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) {
        try {
          const parsed: unknown = JSON.parse(cleaned.slice(start, i + 1))
          return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? (parsed as Record<string, unknown>)
            : null
        } catch {
          return null
        }
      }
    }
  }
  return null
}

/** ทิ้ง key ที่แม่แบบไม่รู้จัก — กันโมเดลแต่ง key ขึ้นเองจนข้อมูลเพี้ยน */
function keepKnownKeys(
  data: Record<string, unknown>,
  allowed: Set<string>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(data)) {
    if (allowed.has(k)) out[k] = v
  }
  return out
}

/** สร้าง system prompt ที่บอกโมเดลว่าต้องกรอกอะไรบ้าง */
export function buildSystemPrompt(input: {
  templateName?: string
  fields: FieldDef[]
  tags: string[]
}): string {
  const { templateName, fields, tags } = input

  const lines: string[] = [
    'คุณเป็นผู้ช่วยกรอกข้อมูลสำหรับสร้างเอกสารราชการไทย',
    templateName ? `แม่แบบที่กำลังทำงานอยู่คือ "${templateName}"` : '',
    '',
    'หน้าที่ของคุณ: อ่านสิ่งที่ผู้ใช้เล่า แล้วเติมค่าในช่องของแม่แบบให้ครบที่สุด',
    'ห้ามแต่งข้อมูลที่ผู้ใช้ไม่ได้บอก — ถ้าไม่รู้ให้เว้นว่างไว้',
    '',
    'ตอบกลับเป็น JSON หนึ่ง object เท่านั้น ในรูปแบบนี้:',
    '{',
    '  "_reply": "อธิบายสั้น ๆ ว่ากรอกอะไรไปบ้าง ภาษาไทย ไม่เกิน 2 บรรทัด",',
    '  "ค่าในช่อง1": "ค่าที่เติมให้",',
    '  "ค่าในช่อง2": "ค่าที่เติมให้"',
    '}',
    '',
    'กฎสำคัญ:',
    '- ใช้ key เดียวกับที่ระบุด้านล่างเท่านั้น ห้ามสร้าง key ใหม่',
    '- ตัวเลขที่ระบุว่าเป็นจำนวนเต็ม ห้ามมีจุดทศนิยม',
    '- วันที่ให้ใส่เป็น วัน/เดือน/ปี พ.ศ. เช่น "15 มกราคม 2569"',
    '- ถ้าข้อมูลยาว ให้คงหลายบรรทัดได้ (ใส่ \\n ใน string)',
    '- ถ้าไม่มีช่องไหนที่เติมได้เลย ให้ตอบแค่ { "_reply": "..." }',
  ]

  const usable = fields.filter((f) => f.ai?.enabled !== false)
  if (usable.length > 0) {
    lines.push('', 'ช่องที่ต้องกรอก (key | ชนิด | คำอธิบาย):')
    for (const f of usable) {
      const parts = [`- ${f.key} (${f.type})`]
      if (f.label) parts.push(f.label)
      if (f.required) parts.push('[required]')
      if (f.options?.length) parts.push(`ตัวเลือก: ${f.options.map((o) => o.value).join(', ')}`)
      if (f.ai?.hint) parts.push(`(${f.ai.hint})`)
      lines.push(parts.join(' '))
    }
  } else if (tags.length > 0) {
    lines.push(
      '',
      'ยังไม่ได้ตั้งฟอร์ม — ให้ใช้ key เหล่านี้ที่แม่แบบใช้จริง:',
      ...tags.map((t) => `- ${t}`),
    )
  }

  return lines.filter((l) => l !== '').join('\n')
}

/**
 * system prompt สำหรับโหมด "ช่วยช่องเดียว"
 *
 * ต่างจาก `buildSystemPrompt` ตรงที่ไม่บอกให้เติมทั้งฟอร์ม
 * — ให้ทำงานแค่คำเดียวกับช่องที่ผู้ใช้กดไอคอน ไม่ว่างแตะช่องอื่น
 */
export function buildFieldSystemPrompt(input: {
  templateName?: string
  field: { key: string; label?: string; type?: string; value?: string }
}): string {
  const { templateName, field } = input
  const label = field.label?.trim() || field.key
  const kind = field.type ?? 'text'
  const has = Boolean(field.value && field.value.trim())

  const lines: string[] = [
    'คุณเป็นผู้ช่วยเขียนข้อความภาษาไทยสำหรับเอกสารราชการ',
    templateName ? `เอกสารที่กำลังทำงานอยู่คือ "${templateName}"` : '',
    '',
    `ผู้ใช้กำลังดูและแก้ไขช่อง "${label}" (key: ${field.key}, ชนิด: ${kind})`,
    has ? `ขณะนี้ช่องนี้มีค่าอยู่แล้ว:\n"""\n${field.value}\n"""` : 'ขณะนี้ช่องนี้ยังว่างอยู่',
    '',
    'หน้าที่ของคุณ: ช่วยร่าง แก้ไข หรือให้คำแนะนำ **เฉพาะช่องนี้ช่องเดียว**',
    '',
    'ตอบกลับเป็น JSON หนึ่ง object เท่านั้น ในรูปแบบนี้:',
    '{',
    '  "_reply": "คำแนะนำสั้น ๆ ภาษาไทย ไม่เกิน 3 บรรทัด",',
    `  "${field.key}": "ข้อความที่เสนอให้ใส่ในช่องนี้"`,
    '}',
    '',
    'กฎสำคัญ:',
    `- key ข้างบนคือช่องเดียวที่อนุญาตให้แตะ ห้ามสร้างหรือแก้ key อื่นเด็ดขาด`,
    has
      ? '- ถ้าผู้ใช้ขอ "แก้ไข" ให้รักษาสาระเดิมไว้แล้วปรับให้อ่านง่ายขึ้น'
      : '- ถ้าผู้ใช้ขอ "ร่างให้" ให้เขียนข้อความใหม่ให้ใส่ได้เลย',
    '- ถ้าคำถามเป็นการขอคำแนะนำ (ไม่ต้องการแก้ข้อความ) ให้ตอบใน "_reply"',
    '  และใส่ค่าในช่องเป็น ""',
    '- ถ้าข้อมูลที่ต้องใช้ยังไม่พอ ห้ามแต่งข้อเท็จจริง — ถามกลับใน "_reply" และเว้นค่าว่าง',
    '- ถ้าช่องเป็นตัวเลข ให้ตอบเป็นตัวเลขล้วน ๆ ไม่มีหน่วยและไม่มีจุลภาค',
    '- ถ้าช่องเป็นวันที่ ให้ตอบเป็น วัน/เดือน/ปี พ.ศ. เช่น "15 มกราคม 2569"',
    '- ข้อความยาวได้ ใส่ \\n ได้ ถ้าเป็นช่อง textarea',
    '- ห้ามห่อ JSON ด้วย ``` เพราะระบบจะอ่านค่าตรง ๆ',
  ]

  return lines.filter((l) => l !== '').join('\n')
}

/**
 * โหมด mock — ไม่เรียกเครือข่าย
 *
 * คืน JSON ที่กรอกจากข้อความผู้ใช้ตาม key ที่มี โดยใส่ค่าเป็นข้อความย่อ
 * มีไว้ให้ทดสอบ flow ข้างล่าง (ปุ่ม ประวัติ การ merge) ได้โดยไม่ต้องมี API key
 * — ไม่ใช่ AI จริง อย่าเอาไปวัดคุณภาพอะไร
 */
function mockAnswer(input: {
  userText: string
  fields: FieldDef[]
  tags: string[]
  templateName?: string
}): LlmAnswer {
  const keys = input.fields.length > 0 ? input.fields.map((f) => f.key) : input.tags
  const text = input.userText.trim()
  const data: Record<string, unknown> = {}

  keys.forEach((key, i) => {
    const f = input.fields.find((x) => x.key === key)
    if (f?.type === 'checkbox') {
      data[key] = true
      return
    }
    if (f?.type === 'select' || f?.type === 'multiselect') {
      const opt = f.options?.[i % f.options.length]
      if (!opt) return
      data[key] = f.type === 'multiselect' ? [opt.value] : opt.value
      return
    }
    if (f?.type === 'integer' || f?.type === 'number') {
      data[key] = i + 1
      return
    }
    // เครดิตคำแรกให้ key แรก เพื่อให้เห็นว่าข้อมูลผู้ใช้ถูกส่งไปจริง
    data[key] = i === 0 ? text.slice(0, 200) : `[mock] ${key}`
  })

  return {
    reply:
      `โหมด mock — ยังไม่ได้ต่อ AI จริง (โหมดนี้เดาจากชื่อฟิลด์ทั้งหมด)\n` +
      `เติมให้ ${keys.length} ช่อง: ${keys.join(', ') || '(แม่แบบนี้ยังไม่มีช่อง)'}`,
    data,
    provider: 'mock',
    model: 'mock',
    unparsed: false,
  }
}

/** โหมด mock ของ "ช่วยช่องเดียว" — คืนสิ่งที่ผู้ใช้พิมพ์มากลับไปให้ลองใส่ช่อง */
function mockFieldAnswer(input: {
  userText: string
  field: { key: string; label?: string; type?: string; value?: string }
}): LlmAnswer {
  const text = input.userText.trim()
  const label = input.field.label?.trim() || input.field.key
  return {
    reply:
      `โหมด mock — ยังไม่ได้ต่อ AI จริง\n` +
      `รับคำขอของคุณไว้แล้วสำหรับช่อง "${label}"` +
      `${input.field.value?.trim() ? ' (มีของเดิมอยู่แล้ว)' : ''}`,
    data: text ? { [input.field.key]: text } : {},
    provider: 'mock',
    model: 'mock',
    unparsed: false,
  }
}

/**
 * ถามโมเดล แล้วได้กลับมาเป็น `data` ที่พร้อม merge
 *
 * @param provider override เฉพาะคำขอนี้ (ใช้ทดสอบว่าสลับโมเดลได้จริง)
 */
export async function askLlm(input: {
  messages: ChatTurn[]
  fields: FieldDef[]
  tags: string[]
  templateName?: string
  provider?: string
  /** ถ้ามี = จำกัดขอบเขตเป็นช่องเดียว ใช้ system prompt อีกชุด */
  field?: { key: string; label?: string; type?: string; value?: string }
  /** callback สำหรับ log — route จะส่ง app.log เข้ามา */
  log?: (meta: Record<string, unknown>) => void
}): Promise<LlmAnswer> {
  const provider = input.provider ?? env.LLM_PROVIDER
  const userText = [...input.messages].reverse().find((m) => m.role === 'user')?.content ?? ''

  if (provider === 'mock') {
    return input.field
      ? mockFieldAnswer({ userText, field: input.field })
      : mockAnswer({
          userText,
          fields: input.fields,
          tags: input.tags,
          templateName: input.templateName,
        })
  }

  /**
   * ⚠️ provider ที่ส่งมาจากหน้าเว็บ **ทับค่าใน .env ได้**
   *    ถ้าไม่เช็คตรงนี้ ผู้ใช้ที่เลือก MiniMax จะได้ยิง API จริงโดยไม่มี key
   *    แล้วได้ 401 ซึ่งอ่านไม่ออกว่าต้องไปตั้งอะไรตรงไหน
   */
  if (!env.LLM_API_KEY) {
    throw new AppError(
      'LLM_NOT_CONFIGURED',
      `ยังตั้ง ${provider} ไม่ได้ — ยังไม่มี LLM_API_KEY ใน .env\n` +
        'ตั้ง key แล้วรีสตาร์ท API หรือเลือก "ทดสอบ (mock)" ไว้ก่อน',
      503,
    )
  }

  const url = `${baseUrlFor(provider)}/chat/completions`
  // ต้องดึงออกมาเป็นตัวแปรก่อน — TypeScript ไม่ narrow `input.field` ให้ทั้งฟังก์ชัน
  const scope = input.field
  const body: Record<string, unknown> = {
    model: env.LLM_MODEL,
    messages: [
      {
        role: 'system',
        content: scope
          ? buildFieldSystemPrompt({ templateName: input.templateName, field: scope })
          : buildSystemPrompt(input),
      },
      // ประวัติแชทย้อนหลังจำกัดไว้ 8 รอบล่าสุด — กัน prompt บวมเกินไป
      ...input.messages.slice(-8).map((m) => ({ role: m.role, content: m.content })),
    ],
    temperature: env.LLM_TEMPERATURE,
    max_tokens: env.LLM_MAX_TOKENS,
  }

  // MiniMax M3 เปิด thinking โดยค่าเริ่มต้น (ช้ากว่าหลายเท่าเมื่อแค่เติมค่าในฟอร์ม)
  if (provider === 'minimax' && env.LLM_THINKING === 'disabled') {
    body.thinking = { type: 'disabled' }
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), env.LLM_TIMEOUT_MS)

  let res: Response
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${env.LLM_API_KEY}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
  } catch (err) {
    const aborted = (err as Error).name === 'AbortError'
    throw new AppError(
      aborted ? 'LLM_TIMEOUT' : 'LLM_UNREACHABLE',
      aborted
        ? `โมเดลไม่ตอบภายใน ${Math.round(env.LLM_TIMEOUT_MS / 1000)} วินาที`
        : `ติดต่อ ${provider} ไม่ได้: ${(err as Error).message}`,
      502,
    )
  } finally {
    clearTimeout(timer)
  }

  const text = await res.text()
  let json: ChatCompletionResponse
  try {
    json = JSON.parse(text) as ChatCompletionResponse
  } catch {
    throw new AppError('LLM_BAD_RESPONSE', `โมเดลตอบกลับมาไม่ใช่ JSON (HTTP ${res.status})`, 502)
  }

  if (!res.ok) {
    input.log?.({ status: res.status, provider, model: env.LLM_MODEL, body: text.slice(0, 300) })
    throw new AppError(
      'LLM_ERROR',
      `โมเดลตอบกลับมา ${res.status}: ${json.error?.message ?? text.slice(0, 200)}`,
      502,
    )
  }

  const content = json.choices?.[0]?.message?.content ?? ''
  if (!content) {
    throw new AppError('LLM_EMPTY', 'โมเดลไม่ได้ตอบอะไรเลย', 502)
  }

  const parsed = extractJson(content)
  if (!parsed) {
    // ไม่ทิ้งคำตอบทิ้ง — ผู้ใช้ยังอ่านคำแนะนำจาก AI ได้ แค่ไม่มี data มาเติม
    return { reply: content.trim(), data: {}, provider, model: env.LLM_MODEL, unparsed: true }
  }

  const reply = typeof parsed._reply === 'string' ? parsed._reply : 'เติมข้อมูลให้แล้ว'
  delete parsed._reply

  /**
   * โหมดช่องเดียวอนุญาตให้แตะ key นั้นเท่านั้น
   * แม้โมเดลจะแต่ง key อื่นมา — ตัดทิ้งทั้งหมด กันข้อมูลรั่วไปช่องอื่น
   */
  const allowed = scope ? new Set([scope.key]) : new Set([...input.fields.map((f) => f.key), ...input.tags])
  const data = keepKnownKeys(parsed, allowed)

  return { reply, data, provider, model: env.LLM_MODEL, unparsed: false }
}
