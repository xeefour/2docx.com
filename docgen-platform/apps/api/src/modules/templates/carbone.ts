import { env, UpstreamError, type TemplateSummary } from '@docgen/shared'

/**
 * ตัวเรียก Carbone 5 Template Management API
 *
 * Carbone แยก id เป็นสองชนิด ต้องรู้ก่อนใช้:
 *   versionId  = SHA-256 ของไฟล์  (เปลี่ยนทุกครั้งที่แก้ไฟล์, ใช้ render ได้เสมอ)
 *   templateId = 64-bit คงที่     (มีเฉพาะแม่แบบที่เปิด versioning)
 *
 * ⚠️ แม่แบบที่อัปโหลดโดยไม่เปิด versioning จะไม่ถูกบันทึกลงฐานข้อมูล
 *    → GET /templates ไม่เห็น, PATCH ได้ 404, DELETE ได้ 404
 *    → เรนเดอร์ได้อย่างเดียว จัดการไม่ได้
 *    วิธีแก้คืออัปโหลดไฟล์เดิมซ้ำแบบเปิด versioning
 */

const base = () => env.DOCSERVER_URL.replace(/\/$/, '')

const headers = () => ({
  Authorization: `Bearer ${env.DOCSERVER_API_KEY}`,
  'carbone-version': '5',
})

/** Carbone ตอบ { success, data, ... } เสมอ — error ก็มี success: false */
async function call<T>(
  path: string,
  init: RequestInit & { label: string },
): Promise<T> {
  const res = await fetch(`${base()}${path}`, {
    ...init,
    headers: { ...headers(), ...(init.headers as Record<string, string>) },
    signal: AbortSignal.timeout(env.DOCSERVER_TIMEOUT_MS),
  })

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new UpstreamError('docserver', `${init.label} ตอบ ${res.status}`, body.slice(0, 500))
  }

  return (await res.json()) as T
}

interface CarboneEnvelope<T> {
  success?: boolean
  data?: T
  message?: string
  hasMore?: boolean
}

/** GET /templates — รายการแม่แบบที่ deploy แล้ว (เฉพาะที่มีใน DB) */
export async function listTemplates(query: {
  category?: string
  search?: string
  versionId?: string
  templateId?: string
}): Promise<{ items: TemplateSummary[]; hasMore: boolean }> {
  const q = new URLSearchParams()
  for (const [k, v] of Object.entries(query)) {
    if (v) q.set(k, v)
  }
  const suffix = q.toString() ? `?${q}` : ''

  const json = await call<CarboneEnvelope<TemplateSummary[]>>(`/templates${suffix}`, {
    method: 'GET',
    label: 'GET /templates',
  })

  /**
   * ⚠️ กรองทิ้งรายการที่ `id` เป็น null
   *
   * Carbone คืนรายการผสมสองชนิด:
   *   · record ใน DB      → มี `id` (เลข 64-bit) · มีชื่อ/หมวด/แท็ก · PATCH/DELETE ได้
   *   · ไฟล์ดิบใน /app/template → `id` = null · ไม่มี metadata · PATCH/DELETE ได้ 404
   *
   * ถ้าไม่กรอง ผู้ใช้จะเห็นแม่แบบซ้ำ 2 ชุด (ชุดละ 10) และกดลบแล้วได้ 404
   */
  return {
    items: (json.data ?? []).filter((t) => t?.id),
    hasMore: Boolean(json.hasMore),
  }
}

/** GET /templates/categories
 *
 * ⚠️ Carbone คืน `[{ name: "..." }]` ไม่ใช่ `["..."]`
 *    ดึงชื่อออกมาให้ consumer ได้เป็น string ตรง ๆ
 */
export async function listCategories(): Promise<string[]> {
  const json = await call<CarboneEnvelope<{ name?: string }[]>>('/templates/categories', {
    method: 'GET',
    label: 'GET /templates/categories',
  })
  return (json.data ?? []).map((c) => c?.name ?? '').filter(Boolean)
}

/** GET /templates/tags — รูปแบบเดียวกับ categories */
export async function listTags(): Promise<string[]> {
  const json = await call<CarboneEnvelope<{ name?: string }[]>>('/templates/tags', {
    method: 'GET',
    label: 'GET /templates/tags',
  })
  return (json.data ?? []).map((t) => t?.name ?? '').filter(Boolean)
}

/** GET /template/{id} — ดาวน์โหลดไฟล์แม่แบบ (ใช้ versionId หรือ templateId ได้) */
export async function downloadTemplate(
  id: string,
): Promise<{ body: Buffer; filename: string; contentType: string }> {
  const res = await fetch(`${base()}/template/${encodeURIComponent(id)}`, {
    headers: headers(),
    signal: AbortSignal.timeout(env.DOCSERVER_TIMEOUT_MS),
  })

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new UpstreamError('docserver', `GET /template ตอบ ${res.status}`, body.slice(0, 500))
  }

  const disposition = res.headers.get('content-disposition') ?? ''
  // content-disposition: attachment; filename="xxx.docx"
  const match = /filename="?([^";]+)"?/i.exec(disposition)
  const ext = /\.(docx|xlsx|pptx|odt|odp|ods|pdf|doc|odf)$/i.exec(id)?.[1]
  const filename = match?.[1]?.trim() || `${id}${ext ? '.' + ext : ''}`

  return {
    body: Buffer.from(await res.arrayBuffer()),
    filename,
    contentType: res.headers.get('content-type') ?? 'application/octet-stream',
  }
}

export interface UploadInput {
  filename: string
  contentType: string
  body: Buffer
  /** เปิด versioning เพื่อให้ได้ templateId 64-bit และจัดการ metadata ได้ */
  versioning?: boolean
  /** เพิ่ม version ต่อยอดจาก templateId เดิม */
  id?: string
  name?: string
  comment?: string
  category?: string
  tags?: string[]
  /** ไฟล์ข้อมูลตัวอย่างสำหรับ Studio */
  sampleJson?: string
}

/** POST /template — อัปโหลดแม่แบบ (multipart/form-data) */
export async function uploadTemplate(input: UploadInput) {
  const form = new FormData()

  // ⚠️ ลำดับ field สำคัญมาก — Carbone ต้องรู้ค่า versioning
  //    ก่อนเริ่มอ่านไฟล์ ไม่งั้นได้ 400 "The 'versioning' field must be sent
  //    before the 'template' file field in the form data" (code w131)
  //    → ใส่ field ข้อความทั้งหมดก่อน แล้วค่อยแนบไฟล์เป็น field สุดท้าย
  if (input.versioning !== undefined) form.set('versioning', String(input.versioning))
  if (input.id) form.set('id', input.id)
  if (input.name) form.set('name', input.name)
  if (input.comment) form.set('comment', input.comment)
  if (input.category) form.set('category', input.category)
  if (input.tags?.length) form.set('tags', JSON.stringify(input.tags))
  if (input.sampleJson) {
    form.set('data', new Blob([input.sampleJson], { type: 'application/json' }), 'data.json')
  }

  // ไฟล์ต้องเป็น field สุดท้ายเสมอ
  form.set(
    'template',
    new Blob([new Uint8Array(input.body)], { type: input.contentType }),
    input.filename,
  )

  // ⚠️ ห้ามใส่ header `Expect` แม้เอกสาร Carbone จะมีในตัวอย่าง curl
  //    curl ใส่ `Expect: 100-continue` เองอัตโนมัติตอนอัปโหลดไฟล์ใหญ่
  //    แต่ Node fetch (undici) บล็อก hop-by-hop header ตัวนี้
  //    ใส่แล้วจะได้ NotSupportedError: expect header not supported
  const json = await call<CarboneEnvelope<Record<string, unknown>>>('/template', {
    method: 'POST',
    body: form,
    label: 'POST /template',
  })

  const d = (json.data ?? {}) as Record<string, unknown>
  return {
    id: (d.id as string | undefined) ?? null,
    versionId: (d.versionId as string | undefined) ?? '',
    templateId: (d.templateId as string | undefined) ?? null,
    templateExtension: (d.templateExtension as string | undefined) ?? null,
    type: (d.type as string | undefined) ?? null,
    size: typeof d.size === 'number' ? d.size : null,
    createdAt: (d.createdAt as number | string | undefined) ?? null,
  }
}

/** PATCH /template/{id} — แก้ metadata */
export async function updateTemplate(
  id: string,
  patch: Record<string, unknown>,
): Promise<void> {
  await call(`/template/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
    label: 'PATCH /template',
  })
}

/**
 * DELETE /template/{id}
 *
 * ⚠️ Carbone ลบแบบ soft — ตั้ง expireAt = now แล้วค่อยลบไฟล์จริงหลัง retention delay
 *    (ค่าเริ่มต้น 24 ชม.) ไฟล์จะยังอยู่ใน volume ชั่วครู่
 */
export async function deleteTemplate(id: string): Promise<void> {
  await call(`/template/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    label: 'DELETE /template',
  })
}
