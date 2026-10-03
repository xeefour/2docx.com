/**
 * เรียก API ของเรา — ทุกคำขอไปที่ origin เดียวกัน
 *
 * ⚠️ เหตุผลที่ไม่ต้องพึ่ง CORS: `next.config.mjs` ตั้ง rewrite `/api/*` ให้วิ่ง
 * มาที่ Fastify ที่พอร์ต 4001 เบราว์เซอร์จึงคุยกับ `localhost:3000` เสมอ
 * cookie session ของ Casdoor จึงถูกส่งมาด้วยทุกครั้ง
 */

const BASE = '/api'

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * เวลารอก่อนลองคำขอใหม่ (มิลลิวินาที) — รวมแล้ว ~3.9 วินาที
 *
 * ต้องยาวพอที่จะคลุม "API กำลังรีสตาร์ท" ซึ่งใช้เวลา
 * ตั้งแต่ process เก่าตายจนของใหม่ฟังพอร์ต 4001 ได้
 * ปกติใช้เวลา 1–2 วินาที · แรกสุดเป็น 0.4 วินาทีเพราะกรณีที่พบบ่อยที่สุด
 * คือ race ชิดขอบ ไม่ต้องรอนาน
 */
const RETRY_DELAYS = [400, 1100, 2400]

/**
 * สถานะที่ "ปลอดภัยที่จะลองใหม่" คือสถานะที่บอกได้แน่นอนว่า
 * Fastify **ยังไม่ได้ประมวลผลคำขอนี้** — ลองซ้ำแล้วจึงไม่มีโอกาส
 * ทำงานซ้ำ (สำคัญมากกับ POST ที่สร้างเอกสาร)
 *
 * · fetch throw        → ต่อไม่ได้เลย
 * · 502/503/504        → gateway ตอบว่าปลายทางไม่อยู่
 * · ไม่ใช่ JSON        → proxy ของ Next ตอบ HTML/ข้อความเปล่ามาเอง
 *                       (API ล่ม, หรือ process กำลังตาย)
 *
 * ⚠️ 500 ที่เป็น JSON จากตัว Fastify เอง = ของจริงที่พัง (เช่น bug)
 *   ถ้าลองซ้ำจะกลบอาการและอาจสร้างข้อมูลซ้ำ → ไม่ลองซ้ำ
 */
const isTransientStatus = (status: number): boolean => status === 502 || status === 503 || status === 504

/**
 * รอนานที่สุดก่อนลองใหม่เมื่อโดน rate limit
 *
 * ⚠️ ต้องจำกัดไว้ ไม่งั้นผู้ใช้จะนั่งมองหน้าค้างเกือบนาที
 *    เซิร์ฟเวอร์บอกมาว่าเหลืออีกกี่วินาที (`Retry-After` / `X-RateLimit-Reset`)
 *    ถ้านานกว่านี้แปลว่ารอครั้งเดียวไม่พอ → ต้องบอกผู้ใช้ตรง ๆ ว่ารออีกกี่วินาที
 */
const RATE_LIMIT_MAX_WAIT_MS = 12_000

/** อ่านจำนวนวินาทีที่เซิร์ฟเวอร์บอกให้รอ (คิดเป็น ms) — ไม่มี header คืน null */
function retryAfterMs(res: Response): number | null {
  const raw = res.headers.get('retry-after') ?? res.headers.get('x-ratelimit-reset')
  if (raw === null) return null
  const n = Number(raw)
  return Number.isFinite(n) ? Math.max(0, n * 1000) : null
}

/**
 * อัปโหลดรูปตัวอย่างหนึ่งรูป
 *
 * ⚠️ **ห้ามใช้ `call()` ตรง ๆ**
 *   `call()` ตั้ง `content-type: application/json` ทุกครั้งที่มี body
 *   ถ้าใช้กับ FormData เบราว์เซอร์จะ**ไม่เติม boundary ของ multipart**
 *   แล้ว Fastify อ่านไฟล์ไม่ออก (`req.file()` คืน undefined → 400 NO_FILE)
 *   และถ้า content-type ไม่ตรง Fastify จะไม่ยอมเข้า content-type parser
 *
 * ⚠️ ไม่ลองซ้ำอัตโนมัติ เพราะอัปโหลดเป็นการเขียน — ลองซ้ำ = อาจได้รูปซ้ำ
 *   (ต่างจาก GET ที่ retry ซ้ำได้)
 */
async function uploadPreview(
  templateKey: string,
  blob: Blob,
  filename: string,
  kind: 'auto' | 'upload',
): Promise<PreviewImage> {
  const form = new FormData()
  form.set('kind', kind)
  form.set('file', blob, filename)

  const res = await fetch(
    `${BASE}/templates/${encodeURIComponent(templateKey)}/previews`,
    {
      method: 'POST',
      credentials: 'same-origin',
      body: form, // ⚠️ ห้ามตั้ง content-type เอง — ปล่อยให้เบราว์เซอร์เติม boundary
    },
  )

  if (res.status === 401) {
    window.location.href = '/auth/login'
    throw new ApiError(401, 'UNAUTHORIZED', 'ยังไม่ได้เข้าสู่ระบบ')
  }

  const text = await res.text()
  let body: unknown = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = null
  }

  if (!res.ok) {
    const m = (body as { message?: string } | null)?.message
    throw new ApiError(
      res.status,
      (body as { code?: string } | null)?.code ?? 'UNKNOWN',
      m ?? (res.status === 413 ? 'ไฟล์รูปใหญ่เกินไป' : `บันทึกรูปไม่สำเร็จ (${res.status})`),
    )
  }

  return body as PreviewImage
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  /**
   * ⚠️ อย่าตั้ง content-type เมื่อไม่มี body
   * Fastify ตอบ 500 ทันทีว่า
   *   "Body cannot be empty when content-type is set to 'application/json'"
   * ซึ่งทำให้ DELETE ที่ไม่ส่ง body พังทุกครั้ง
   */
  const hasBody = init?.body !== undefined
  const headers = hasBody ? { 'content-type': 'application/json', ...init?.headers } : init?.headers

  let attempt = 0
  let lastError: ApiError | null = null
  /** จำนวนครั้งที่ยอมรอเพื่อลองใหม่หลังโดน 429 — แยกจาก retry ของ transient */
  let rateLimitWaits = 0

  // วนจนกว่าจะสำเร็จ หรือ ลองครบตาม RETRY_DELAYS
  for (;;) {
    let res: Response
    try {
      res = await fetch(`${BASE}${path}`, {
        // session เป็น cookie → ต้องบอกเบราว์เซอร์ให้แนบมาด้วย
        credentials: 'same-origin',
        ...init,
        headers,
      })
    } catch (err) {
      // เครือข่ายล้ม / API ไม่ได้ฟังพอร์ต → ยังไม่ได้ประมวลผลคำขอ
      lastError = new ApiError(
        0,
        'NETWORK',
        `เชื่อมต่อ API ไม่สำเร็จ — ${err instanceof Error ? err.message : String(err)}`,
      )
      if (attempt < RETRY_DELAYS.length) {
        await sleep(RETRY_DELAYS[attempt++]!)
        continue
      }
      throw new ApiError(
        0,
        'NETWORK',
        `${lastError.message}\nลองแล้ว ${attempt + 1} ครั้ง — ` +
          'ตรวจว่า API ที่พอร์ต 4001 ยังรันอยู่ไหม (npm run dev)',
      )
    }

    if (res.status === 401) {
      /**
       * ⚠️ path ของ auth ไม่ได้อยู่ใต้ prefix `/api`
       * route ของมันคือ `/auth/login` — ไม่ใช่ `/api/auth/login`
       * (ถ้าเรียกผิดจะโดน auth hook บล็อกเป็น 401 ก่อนถึง router)
       * และ cookie ไม่แยกพอร์ต → ตั้งที่ :4001 แล้วใช้ที่ :3000 ได้เลย
       */
      window.location.href = '/auth/login'
      throw new ApiError(401, 'UNAUTHORIZED', 'ยังไม่ได้เข้าสู่ระบบ')
    }

    const text = await res.text()
    let body: any = null
    let parseFailed = false
    try {
      body = text ? JSON.parse(text) : null
    } catch {
      parseFailed = true
    }

    /**
     * ⚠️ 429 = คิวของเราแน่นชั่วคราว ไม่ใช่ของที่พัง
     *
     *   เคยเจอว่า: ผู้ใช้กดบุ๊กมาร์กแล้วขึ้น "ยิงบ่อยเกินไป" แล้วกดซ้ำไม่ได้เลย
     *   เพราะ `isTransientStatus` ครอบแค่ 502/503/504 → 429 หลุดไปโดนไม่รอ
     *   ทั้งที่เซิร์ฟเวอร์ส่ง `Retry-After` มาบอกว่ารอได้พอดี
     *
     *   ไม่งั้นไม่ต้องแก้ที่ `isTransientStatus` เพราะนั่นหมายถึง
     *   "เซิร์ฟเวอร์ยังไม่ได้ประมวลผลคำขอนี้" ซึ่ง 429 ไม่ใช่
     *   (429 ถูกปฏิเสธก่อนถึง handler — ทำซ้ำแล้วไม่มีผลข้างเคียง)
     */
    if (res.status === 429) {
      const wait = retryAfterMs(res)
      const msg = body?.message ?? 'ยิงถี่เกินไป'
      if (rateLimitWaits < 1 && wait !== null && wait <= RATE_LIMIT_MAX_WAIT_MS) {
        rateLimitWaits++
        await sleep(wait + 300)
        continue
      }
      const secs = wait === null ? null : Math.ceil(wait / 1000)
      throw new ApiError(
        429,
        body?.code ?? 'RATE_LIMITED',
        secs === null
          ? `${msg} — ลองใหม่อีกครั้งในอีกสักครู่`
          : `${msg}\nโควตาจะเต็มใหม่ใน ${secs} วินาที — กดซ้ำได้เลย ไม่ต้องรีเฟรช`,
      )
    }

    // ตอบไม่ใช่ JSON หรือเป็นสถานะ gateway → ลองใหม่ได้อย่างปลอดภัย
    if (parseFailed || isTransientStatus(res.status)) {
      /**
       * ⚠️ ตอนนี้ไม่ใช่ JSON เช่น API กำลังรีสตาร์ท → proxy ของ Next ตอบ
       *    "Internal Server Error" เป็น text ธรรมดากลับมา
       *    ถ้าปล่อยให้ SyntaxError หลุด ผู้ใช้จะเห็น "Unexpected token 'I'"
       *    ซึ่งบอกอะไรไม่ได้เลย
       */
      const preview = text.trim().slice(0, 60).replace(/\s+/g, ' ')
      lastError = new ApiError(
        res.status || 502,
        'BAD_RESPONSE',
        `เชื่อมต่อ API ไม่สำเร็จ — ได้ ${res.status} ${res.statusText || ''} ` +
          `แทน JSON (${preview}…)`,
      )
      if (attempt < RETRY_DELAYS.length) {
        await sleep(RETRY_DELAYS[attempt++]!)
        continue
      }
      throw new ApiError(
        lastError.status,
        'BAD_RESPONSE',
        `${lastError.message}\nลองแล้ว ${attempt + 1} ครั้ง — ` +
          'มักเกิดตอน API กำลังรีสตาร์ทหรือยังไม่ได้สตาร์ท ' +
          'รอสักครู่แล้วลองใหม่ (หรือกดรีเฟรชหน้าเว็บ)',
      )
    }

    if (!res.ok) {
      throw new ApiError(res.status, body?.code ?? 'ERROR', body?.message ?? `HTTP ${res.status}`)
    }
    return body as T
  }
}

// ── ชนิดข้อมูล ───────────────────────────────────────────────
export type Template = {
  id: string | null
  versionId: string
  name: string
  category: string
  tags: string[]
  type: string
  size: number
  createdAt: number
}

export type TemplateTag = { path: string; root: string; count: number }

export type DocumentRecord = {
  _id: string
  status: 'queued' | 'rendering' | 'done' | 'failed'
  downloadUrl: string | null
  storageKey: string | null
  error: string | null
  outputFormat: string
}

/**
 * ฟิลด์ในฟอร์ม — ผู้ใช้ออกแบบเองใน Studio
 *
 * ⚠️ type นี้ซ้ำกับ `packages/shared/src/studio.ts` โดยตั้งใจ
 *    ดูเหตุผลที่หัวไฟล์ `lib/fields.ts`
 */
export type FieldType =
  | 'text'
  | 'textarea'
  | 'number'
  | 'integer'
  | 'select'
  | 'multiselect'
  | 'date'
  | 'checkbox'
  | 'email'

export type FieldOption = { value: string; label: string }

export type FieldRule = {
  pattern?: string
  patternMessage?: string
  min?: number
  max?: number
  minLength?: number
  maxLength?: number
  integer?: boolean
}

export type FieldDef = {
  key: string
  label: string
  type: FieldType
  group: string
  order: number
  required: boolean
  placeholder?: string
  help?: string
  defaultValue?: unknown
  options?: FieldOption[]
  rules?: FieldRule
  ai?: { enabled: boolean; hint?: string }
}

/**
 * รูปตัวอย่างของแม่แบบหนึ่งรูป
 *
 * `kind`: ของระบบสร้างให้ (`auto`) หรือเจ้าของอัปโหลดเอง (`upload`)
 */
export type PreviewImage = {
  id: string
  url: string
  contentType: string
  kind: 'auto' | 'upload'
  by: string
  byName: string | null
  createdAt: string
}

export type AccessView = {
  templateKey: string
  relation: 'owner' | 'shared' | 'published'
  role: 'viewer' | 'editor' | null
  canEdit: boolean
  visibility: 'private' | 'published'
  owner: string | null
  ownerName: string | null
  sharedWith: Array<{ sub: string; name: string | null; role: 'viewer' | 'editor'; at: string }>
}

/**
 * ผู้ใช้คนนี้**ลบ**แม่แบบนี้ได้ไหม — ต้องตรงกับฝั่ง API เป๊ะ
 *
 * API `trashTemplate()`: `if (view.owner && view.relation !== 'owner') → 403`
 *   แปลว่าลบได้เมื่อ ① เป็นเจ้าของ หรือ ② แม่แบบยัง**ไม่มีเจ้าของ**เลย
 *   (ข้อ ② คือกติกา "ใครกดก่อนคนนั้นเป็นเจ้าของ" สำหรับแม่แบบเก่าที่อัปโหลด
 *   ก่อนมีระบบสิทธิ์ — ตรงกับ `canManage` ใน `SharePanel` และ `setVisibility`)
 *
 * ⚠️ ถ้าเช็คแค่ `relation === 'owner'`
 *    → แม่แบบเก่าที่ยังไม่มีเจ้าของจะ**ลบจากหน้ารายการไม่ได้เลย** ทั้งที่ API อนุญาต
 *    → และจะไม่ตรงกับหน้าแก้ไขที่ใช้กติกาเดียวกันอยู่แล้ว
 *
 * ⚠️ `view` ที่ยังโหลดไม่เสร็จ = ยัง**ไม่รู้** → คืน false
 *    ปล่อยให้โชว์ปุ่มลบตอนยังไม่รู้สิทธิ์ คือชวนคนกดแล้วได้ 403
 */
export function canDeleteTemplate(view?: AccessView | null): boolean {
  if (!view) return false
  return view.relation === 'owner' || view.owner === null
}

/**
 * ชื่อแม่แบบสำเนา — ตัดท้ายเดิมออกก่อน ไม่ให้เป็น "(สำเนา) (สำเนา)"
 *
 * กดสำเนาซ้ำบนแม่แบบที่เพิ่งสำเนามา ต้องได้ "ชื่อเดิม (สำเนา)" ทุกครั้ง
 * ไม่ใช่ยาวขึ้นเรื่อย ๆ จนอ่านไม่ออกว่าเป็นของใคร
 */
export function cloneName(name: string | null | undefined): string {
  const base = (name ?? '').trim() || 'แม่แบบ'
  return `${base.replace(/\s*\(สำเนา\)\s*$/, '')} (สำเนา)`
}

/**
 * แม่แบบที่อยู่ในถังขยะ (รอก่อนลบจริง 14 วัน)
 *
 * `daysLeft` คำนวณมาจากฝั่ง server เสมอ
 * เพราะเวลาของเบราว์เซอร์กับ server ไม่ตรงกัน และถ้าให้คำนวณเอง
 * ผู้ใช้จะเห็นจำนวนวันเพี้ยนเวลาเปิดหน้าค้างไว้
 */
export type Tombstone = {
  templateKey: string
  name: string
  category: string
  tags: string[]
  versionId: string
  deletedAt: string
  purgeAt: string
  daysLeft: number
  deletedBy: string
  deletedByName: string | null
  canRestore: boolean
}

export type ChatMessage = {
  id: string
  role: 'user' | 'assistant'
  content: string
  data: Record<string, unknown> | null
  at: string
}

export type ChatSessionMeta = {
  _id: string
  templateKey: string
  title: string
  messageCount: number
  updatedAt: string
}

export type ChatSession = ChatSessionMeta & { messages: ChatMessage[] }

export type ChatReply = {
  sessionId: string
  reply: string
  data: Record<string, unknown>
  changed: string[]
  provider: string
  model: string
}

export type LlmStatus = {
  configured: boolean
  provider: string
  model: string
  reason: string | null
}

export type BookmarkRecord = {
  _id: string
  user: string
  templateKey: string
  versionId: string
  templateName: string | null
  note: string | null
  createdAt: string
}

export type TemplateHistory = {
  users: Array<{
    sub: string
    name: string | null
    count: number
    lastAt: string
    okCount: number
    failCount: number
  }>
  items: Array<{
    _id: string
    label: string | null
    status: string
    outputFormat: string
    createdBy: string | null
    createdByName: string | null
    createdAt: string
  }>
  total: number
}

/**
 * ประวัติของฉันเอง — มาพร้อมค่าที่กรอกไว้ เพื่อกู้มาแก้ต่อ
 *
 * ⚠️ API กรอง `createdBy` ให้เสมอ ค่าของคนอื่นจึงไม่มีทางหลุดมา
 */
export type MyHistory = {
  items: Array<{
    _id: string
    label: string | null
    status: string
    outputFormat: string
    createdAt: string
    data: Record<string, unknown>
  }>
  total: number
}

/** key ที่ใช้ผูกข้อมูลทั้งหมดของแม่แบบหนึ่งตัว */
export const templateKeyOf = (t: Template): string => String(t.id ?? t.versionId)

export const api = {
  listTemplates: (search?: string) =>
    call<{ items: Template[]; hasMore: boolean }>(
      `/templates${search ? `?search=${encodeURIComponent(search)}` : ''}`,
    ),

  categories: () => call<{ items: string[] }>('/templates/categories'),

  templateTags: (versionId: string) =>
    call<{ items: TemplateTag[]; sample: Record<string, unknown> }>(
      `/templates/${encodeURIComponent(versionId)}/tags`,
    ),

  updateTemplate: (versionId: string, patch: { name?: string; category?: string; tags?: string[] }) =>
    call<void>(`/templates/${encodeURIComponent(versionId)}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),

  /**
   * ลบแม่แบบ → เข้าถังขยะ (ไฟล์ยังอยู่ รอ 14 วันถึงลบจริง)
   *
   * ⚠️ เดิมหน้านี้คืน `void` เพราะ route เดิมตอบ 204
   *   ตอนนี้ตอบข้อมูล tombstone กลับมา เพื่อให้หน้าเว็บบอกผู้ใช้ได้ว่า
   *   "จะลบถาวรในอีกกี่วัน" โดยไม่ต้องคำนวณเองที่ฝั่งเบราว์เซอร์
   */
  deleteTemplate: (versionId: string) =>
    call<Tombstone>(`/templates/${encodeURIComponent(versionId)}`, { method: 'DELETE' }),

  /** กู้คืนแม่แบบจากถังขยะ — ไฟล์ยังอยู่ครบ จึงใช้ได้ทันที */
  restoreTemplate: (templateKey: string) =>
    call<void>(`/templates/${encodeURIComponent(templateKey)}/restore`, { method: 'POST' }),

  /** แม่แบบที่ผู้เรียกเป็นคนลบ — ใช้ทำหน้า "ถังขยะ" */
  trashList: () => call<{ items: Tombstone[] }>('/templates/trash'),

  /**
   * สถานะถังขยะของแม่แบบหนึ่งตัว (ใช้โชว์ป้ายเตือนผู้ที่เปิดแม่แบบ)
   *
   * ⚠️ คืนเป็น `{ item }` ไม่ใช่ค่าตรง ๆ ให้ตรงกับ schema ของ API
   */
  trashOf: (templateKey: string) =>
    call<{ item: Tombstone | null }>(`/templates/${encodeURIComponent(templateKey)}/trash`),

  /**
   * clone แม่แบบ — ดึงไฟล์ต้นฉบับมาอัปโหลดเป็นแม่แบบใหม่
   *
   * ผู้ใช้สั่ง: *"ใครจะใช้ให้ clone ไปแทน"* ตอนแม่แบบเข้าถังขยะ
   *
   * ⚠️ ต้องดึงไฟล์**ก่อน**ครบ 14 วัน
   *   หลังครบกำหนดตัวกวาดจะลบไฟล์ทิ้งจริง แล้ว clone ไม่ได้อีก
   *   ปุ่ม clone จึงต้องหายไปพร้อมกับป้ายเตือน
   */
  cloneTemplate: async (templateKey: string, meta: { name: string; category: string; tags: string[] }) => {
    const res = await fetch(`${BASE}/templates/${encodeURIComponent(templateKey)}`, {
      credentials: 'same-origin',
    })
    if (!res.ok) {
      const body = await res.json().catch(() => null)
      throw new ApiError(res.status, body?.code ?? 'ERROR', body?.message ?? 'ดึงไฟล์แม่แบบไม่สำเร็จ')
    }
    const blob = await res.blob()
    // ชื่อไฟล์ต้องมีนามสกุลเดิมไว้ เพราะ API เดาชนิดไฟล์จากนามสกุล
    //   ถ้าไม่มีจะได้ชื่อแบบ "xxx" ซึ่ง Carbone รับไม่รู้จัก
    const ext = /\.docx|\.xlsx|\.pptx|\.odt|\.ods|\.odp|\.doc/i.exec(
      (res.headers.get('content-disposition') ?? '') + blob.type,
    )
    const name = ext ? `${meta.name}${ext[0]}` : `${meta.name}.docx`
    return api.uploadTemplate(new File([blob], name), meta)
  },

  /**
   * อัปโหลดแม่แบบใหม่
   *
   * ⚠️ field ข้อความต้องมาก่อน field ไฟล์ — Carbone บังคับลำดับนี้ (code w131)
   * และห้ามใส่ header `Expect` เด็ดขาด เพราะ fetch ของเบราว์เซอร์จะโยน error
   */
  uploadTemplate: (file: File, meta: { name: string; category: string; tags: string[] }) => {
    const form = new FormData()
    form.set('versioning', 'true')
    form.set('name', meta.name)
    if (meta.category) form.set('category', meta.category)
    if (meta.tags.length) form.set('tags', JSON.stringify(meta.tags))
    form.set('template', file, file.name)

    return fetch(`${BASE}/templates`, { method: 'POST', body: form, credentials: 'same-origin' })
      .then(async (res) => {
        const body = await res.json().catch(() => null)
        if (!res.ok) throw new ApiError(res.status, body?.code ?? 'ERROR', body?.message ?? 'อัปโหลดไม่สำเร็จ')
        return body
      })
  },

  /**
   * อัปโหลดไฟล์ใหม่**แทนแม่แบบเดิม** → เป็นเวอร์ชันถัดไปของแม่แบบนั้น
   *
   * ⚠️ ต่างจาก `uploadTemplate` ตรงที่ส่ง `id` = templateKey
   *    คนละเรื่องกัน: อันนี้คือแก้ตัวเดิม (สิทธิ์/ประวัติ/ช่องฟอร์มยังอยู่)
   *    อีกอันคือสร้างแม่แบบใหม่จากศูนย์
   *
   * ⚠️ field ข้อความต้องมาก่อน field ไฟล์ — Carbone บังคับลำดับนี้ (code w131)
   *    และห้ามใส่ header `Expect` เด็ดขาด
   */
  replaceTemplate: (
    templateKey: string,
    file: File,
    meta: { name: string; category: string; tags: string[] },
  ) => {
    const form = new FormData()
    form.set('versioning', 'true')
    form.set('id', templateKey)
    if (meta.name) form.set('name', meta.name)
    if (meta.category) form.set('category', meta.category)
    if (meta.tags.length) form.set('tags', JSON.stringify(meta.tags))
    form.set('template', file, file.name)

    return fetch(`${BASE}/templates/${encodeURIComponent(templateKey)}/replace`, {
      method: 'POST',
      body: form,
      credentials: 'same-origin',
    }).then(async (res) => {
      const body = await res.json().catch(() => null)
      if (!res.ok) throw new ApiError(res.status, body?.code ?? 'ERROR', body?.message ?? 'อัปโหลดไม่สำเร็จ')
      return body as { versionId: string; templateId?: string | null }
    })
  },

  /**
   * URL ไฟล์แม่แบบต้นฉบับ — ใช้กับ `<a download>`
   * (cookie เดินไปด้วยเพราะ same-origin · API ตรวจสิทธิ์ให้อยู่แล้ว)
   */
  templateFileUrl: (templateKey: string) =>
    `/api/templates/${encodeURIComponent(templateKey)}`,

  createDocument: (body: {
    templateId: string
    data: Record<string, unknown>
    outputFormat: string
    label?: string
  }) =>
    call<{ _id: string; status: string }>('/documents', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  getDocument: (id: string) => call<DocumentRecord>(`/documents/${id}`),

  /**
   * ลบเอกสาร
   *
   * ⚠️ ห้ามส่ง body — Fastify ตอบ 500 ทันทีถ้า content-type ถูกตั้งแต่ไม่มี body
   *    (helper `call` จัดการให้แล้ว เพราะมันเช็ค `init?.body !== undefined`)
   */
  deleteDocument: (id: string) => call<void>(`/documents/${id}`, { method: 'DELETE' }),

  /**
   * URL สำหรับดึงไฟล์ผลลัพธ์
   *
   * ใช้แทน presigned URL เพราะ:
   *   · presigned URL ชี้ไปที่ endpoint ภายนอก (ผ่าน tailnet)
   *   · RustFS ไม่ตอบ OPTIONS → ไม่มี CORS → เบราว์เซอร์ fetch ข้ามโดเมนไม่ได้
   *   · pdf.js ต้องดึงไฟล์มาทั้งก้อนเพื่อวาดหน้าเป็นรูป
   */
  fileUrl: (id: string) => `/api/documents/${encodeURIComponent(id)}/file`,

  // ── ตัวอย่างแม่แบบเป็นรูป ─────────────────────────────────────
  /**
   * ภาพย่อของหลายแม่แบบในคำขอเดียว (หน้ารายการ)
   *
   * @returns key → รูปแรก หรือ `null` (ยังไม่มีรูป / ดูไม่ได้)
   */
  thumbs: (keys: string[]) =>
    call<{ items: Record<string, { id: string; url: string } | null> }>(
      `/templates/thumbs?keys=${encodeURIComponent(keys.join(','))}`,
    ),

  listPreviews: (templateKey: string) =>
    call<{ items: PreviewImage[] }>(`/templates/${encodeURIComponent(templateKey)}/previews`),

  addPreview: uploadPreview,

  deletePreview: (templateKey: string, id: string) =>
    call<void>(
      `/templates/${encodeURIComponent(templateKey)}/previews/${encodeURIComponent(id)}`,
      { method: 'DELETE' },
    ),

  /**
   * URL รูปสำหรับ `<img src>`
   *
   * ⚠️ ใช้ route ของ API ไม่ใช่ `PreviewImage.url` (presigned URL)
   *   RustFS ไม่ตอบ OPTIONS → ไม่มี CORS และชี้ไปที่ endpoint ภายใอผ่าน tailnet
   *   ถ้าโหลดไม่ได้จะเห็นกรอบรูปเสียทั้งการ์ด
   */
  previewFileUrl: (templateKey: string, id: string) =>
    `/api/templates/${encodeURIComponent(templateKey)}/previews/${encodeURIComponent(id)}/file`,

  // ── ฟอร์มที่ผู้ใช้ออกแบบเอง ─────────────────────────────────
  getForm: (templateKey: string) =>
    call<{ templateKey: string; fields: FieldDef[]; updatedAt: string | null }>(
      `/form/${encodeURIComponent(templateKey)}`,
    ),

  saveForm: (templateKey: string, fields: FieldDef[]) =>
    call<{ templateKey: string; fields: FieldDef[] }>(`/form/${encodeURIComponent(templateKey)}`, {
      method: 'PUT',
      body: JSON.stringify({ fields }),
    }),

  clearForm: (templateKey: string) =>
    call<void>(`/form/${encodeURIComponent(templateKey)}`, { method: 'DELETE' }),

  /** สร้างช่องอัตโนมัติจากแท็ก `{d.*}` ที่แม่แบบใช้จริง */
  importTags: (templateKey: string, versionId: string) =>
    call<{ templateKey: string; fields: FieldDef[] }>(
      `/form/${encodeURIComponent(templateKey)}/import-tags`,
      { method: 'POST', body: JSON.stringify({ versionId }) },
    ),

  // ── การแชร์ ───────────────────────────────────────────────
  getAccess: (templateKey: string) =>
    call<AccessView>(`/access/${encodeURIComponent(templateKey)}`),

  setVisibility: (templateKey: string, visibility: 'private' | 'published') =>
    call<AccessView>(`/access/${encodeURIComponent(templateKey)}`, {
      method: 'PUT',
      body: JSON.stringify({ visibility }),
    }),

  clearAccess: (templateKey: string) =>
    call<void>(`/access/${encodeURIComponent(templateKey)}`, { method: 'DELETE' }),

  share: (templateKey: string, sub: string, role: 'viewer' | 'editor', name?: string) =>
    call<AccessView>(`/access/${encodeURIComponent(templateKey)}/share`, {
      method: 'POST',
      body: JSON.stringify({ sub, role, name }),
    }),

  unshare: (templateKey: string, sub: string) =>
    call<AccessView>(
      `/access/${encodeURIComponent(templateKey)}/share/${encodeURIComponent(sub)}`,
      { method: 'DELETE' },
    ),

  /** สิทธิ์หลายแม่แบบพร้อมกัน — หน้ารายการถามครั้งเดียว ไม่งั้นเป็น N+1 */
  resolveAccess: (keys: string[]) =>
    call<Record<string, AccessView>>('/access/resolve', {
      method: 'POST',
      body: JSON.stringify({ keys }),
    }),

  // ── ประวัติการสร้างเอกสารของแม่แบบ ────────────────────────
  history: (templateKey: string, page?: { limit?: number; skip?: number }) => {
    const q = new URLSearchParams()
    if (page?.limit) q.set('limit', String(page.limit))
    if (page?.skip) q.set('skip', String(page.skip))
    const suffix = q.toString() ? `?${q}` : ''
    return call<TemplateHistory>(`/history/${encodeURIComponent(templateKey)}${suffix}`)
  },

  /**
   * ประวัติส่วนตัว — เอาไว้กู้ค่าเดิมมาแก้ต่อ
   *
   * @param q คำค้น ค้นทั้งชื่อฉบับและค่าที่กรอก (เช่น ชื่อผู้รับ)
   * @param page หน้าที่ขอ — คนเดียวมีได้เป็นร้อยฉบับ ต้องให้ server ตัด
   */
  myHistory: (templateKey: string, q = '', page?: { limit?: number; skip?: number }) => {
    const p = new URLSearchParams({ q })
    if (page?.limit) p.set('limit', String(page.limit))
    if (page?.skip) p.set('skip', String(page.skip))
    return call<MyHistory>(`/history/${encodeURIComponent(templateKey)}/mine?${p.toString()}`)
  },

  // ── AI ช่วยกรอกข้อมูล ────────────────────────────────────
  llmStatus: () => call<LlmStatus>('/llm/status'),

  chat: (body: {
    templateKey: string
    message: string
    data: Record<string, unknown>
    sessionId?: string
    templateName?: string
    provider?: 'minimax' | 'openai' | 'mock'
    /** ถ้ามี = จำกัดขอบเขตเป็นช่องเดียว (ไอคอน AI ข้างช่องกรอก) */
    field?: {
      key: string
      label?: string
      type?: string
      value?: string
    }
  }) => call<ChatReply>('/chat', { method: 'POST', body: JSON.stringify(body) }),

  chatSessions: (templateKey?: string) =>
    call<{ items: ChatSessionMeta[] }>(
      `/chat/sessions${templateKey ? `?templateKey=${encodeURIComponent(templateKey)}` : ''}`,
    ),

  chatSession: (id: string) => call<ChatSession>(`/chat/sessions/${encodeURIComponent(id)}`),

  deleteChatSession: (id: string) =>
    call<void>(`/chat/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  // ── บุ๊กมาร์ก ────────────────────────────────────────────
  bookmarks: () => call<{ items: BookmarkRecord[] }>('/bookmarks'),

  addBookmark: (body: { templateKey: string; versionId: string; templateName?: string }) =>
    call<BookmarkRecord>('/bookmarks', { method: 'POST', body: JSON.stringify(body) }),

  removeBookmark: (templateKey: string) =>
    call<void>(`/bookmarks/${encodeURIComponent(templateKey)}`, { method: 'DELETE' }),
}

/** รอจนเอกสารเรนเดอร์เสร็จ — คืน record สุดท้าย */
export async function waitForRender(
  id: string,
  onTick?: (status: string) => void,
  timeoutMs = 120_000,
): Promise<DocumentRecord> {
  const started = Date.now()
  let last = ''

  while (Date.now() - started < timeoutMs) {
    const doc = await api.getDocument(id)
    if (doc.status !== last) {
      last = doc.status
      onTick?.(doc.status)
    }
    if (doc.status === 'done' || doc.status === 'failed') return doc
    await new Promise((r) => setTimeout(r, 900))
  }
  throw new Error('เรนเดอร์ไม่เสร็จในเวลาที่กำหนด')
}
