/**
 * ตัวช่วยจัดการฟอร์มในฝั่งเบราว์เซอร์
 *
 * ⚠️ ทำซ้ำจาก `packages/shared/src/studio.ts` **โดยตั้งใจ**
 *    เพราะ `import { … } from '@docgen/shared'` จะดึง `env.ts` มาด้วย
 *    ซึ่งอ่าน `process.env` และ `process.exit(1)` เมื่อค่าไม่ครบ
 *    ในเบราว์เซอร์ไม่มี process → หน้าเว็บพังทันที
 *    ถ้าวันหนึ่งอยากแชร์จริง ๆ ต้องแยก env ออกเป็นโมดูลของมันเองก่อน
 *    (ดู TODO ใน README หัวข้อ "แชร์โค้ดกับ web")
 *
 * กติกาต้องเหมือนกันทั้งสองฝั่ง ไม่งั้นผู้ใช้จะเห็น error คนละชุดกับที่ API ตรวจ
 */
import type { FieldDef } from './api'

// ── id ของช่องบนหน้าเว็บ ─────────────────────────────────────

/**
 * สร้าง `id` ของ `<input>`/`<textarea>` ที่ไม่ซ้ำกันแน่นอน
 *
 * ⚠️ ของเดิมคือ `` `f-${key.replace(/[^\w-]/g, '_')}` `` ซึ่ง**ชนกันเมื่อ key เป็นภาษาไทย**
 *    เพราะ `\w` ของ JavaScript ครอบคลุมแค่ `[A-Za-z0-9_]` — อักษรไทยทั้งหมด
 *    ถูกแทนด้วย `_` กลายเป็น `f-______` ที่เหมือนกันหมด เช่น
 *    `เรื่อง` (5 ตัว) และ `สิ่งที่ขอ` (8 ตัว) ออกมา id เดียวกัน
 *
 *    ผลที่ตามมา — กดชื่อช่องแล้วโฟกัสผิดช่อง และ `getElementById` คืนตัวแรกเสมอ
 *    (เทสต์จึงอ่านค่าผิดช่องแล้วรายงานว่าฟีเจอร์ไม่ทำงาน ทั้งที่มันทำงาน)
 *
 * วิธีแก้: เก็บ slug ที่อ่านออกไว้หน้า ๆ แล้วต่อท้ายด้วย hash ของ key เต็ม ๆ
 * คนละ key ได้คนละ hash เสมอ (ชนกันได้แทบไม่เป็นไปได้ในฟอร์มหนึ่งใบ)
 */
export function fieldDomId(key: string): string {
  let h = 5381
  for (let i = 0; i < key.length; i++) h = ((h * 33) ^ key.charCodeAt(i)) >>> 0
  const slug = key.replace(/[^\w-]/g, '_').slice(0, 20) || 'x'
  return `f-${slug}-${h.toString(36)}`
}

/**
 * `key` ของกลุ่มฟิลด์ที่**นิ่ง** ไม่ขยับตอนผู้ใช้พิมพ์
 *
 * ⚠️ ห้ามใช้ชื่อกลุ่มเป็น key
 *
 *   ชื่อกลุ่มเปลี่ยนทุกตัวอักษรที่พิมพ์ในช่อง "กลุ่ม" (`field-group-N`)
 *   ถ้าใช้ชื่อเป็น key → React ถอดกลุ่มทิ้งแล้วใส่ใหม่ทุกครั้ง
 *   → โฟกัสในช่องที่กำลังพิมพ์หลุดทันที (ผู้ใช้เจอและรายงานแล้ว)
 *
 *   ใช้ "ลำดับของช่องตัวแรกในกลุ่ม" แทน ซึ่งเปลี่ยนเฉพาะตอนเพิ่ม/ลบ/ย้ายช่อง
 *   ซึ่งเป็นความตั้งใจของผู้ใช้อยู่แล้ว
 */
export function groupKey(group: { group: string; fields: FieldDef[] }, all: FieldDef[]): string {
  const idxs = group.fields.map((f) => all.indexOf(f)).filter((i) => i >= 0)
  // กลุ่มสังเคราะห์ (ช่องที่ยังไม่ได้ทำเป็นฟอร์ม) ไม่มีใน all → ใช้ชื่อกลุ่มซึ่งไม่เคยเปลี่ยน
  return `g-${idxs.length ? Math.min(...idxs) : group.group}`
}

// ── dot path ────────────────────────────────────────────────

export function getPath(data: Record<string, unknown>, path: string): unknown {
  const parts = path.split('.')
  let cur: unknown = data
  for (const p of parts) {
    if (cur === null || typeof cur !== 'object') return undefined
    cur = (cur as Record<string, unknown>)[p]
  }
  return cur
}

/** เขียนค่าโดยคืน object ใหม่ (React เทียบด้วย reference) */
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
  cur[parts[parts.length - 1]!] = value
  return out
}

/** เรียงตาม group แล้ว order */
export function sortFields(fields: FieldDef[]): FieldDef[] {
  return [...fields].sort((a, b) => {
    const g = (a.group || '').localeCompare(b.group || '', 'th')
    if (g !== 0) return g
    if (a.order !== b.order) return a.order - b.order
    return a.key.localeCompare(b.key, 'th')
  })
}

// ── ค่ายาว (hash / URL / id) ───────────────────────────────────

/** เกินนี้ถือว่ายาวเกินอ่าน แล้วต้องย่อ */
export const LONG_VALUE_AT = 40

/**
 * ค่านี้ "อ่านไม่ออกอยู่แล้ว" จึงควรย่อ — หรือเปล่า
 *
 * ── ทำไมต้องกรองก่อนย่อ ไม่ย่อทุกค่าที่ยาว ──────────────────────────────
 *   ย่อข้อความที่คนอ่านออก = **ทำลายข้อมูลที่ผู้ใช้ต้องใช้อ่าน**
 *   ค่าที่ยาวแต่ยังต้องอ่านทั้งหมด เช่น ชื่อ-ที่อยู่ภาษาไทย (ไม่มีช่องว่างระหว่างคำ!)
 *   หรือประโยคยาว ๆ ต้องอยู่เป็นช่องกรอกปกติ ให้เลื่อนดูเองทางแนวนอน
 *
 *   สิ่งที่ย่อแล้ว**มีประโยชน์จริง**มีแค่ 3 อย่าง คือค่าที่ "อ่านออกแต่จำไม่ได้"
 *   ได้แก่ hash / id / URL / base64 — ล้วนเป็น ASCII ที่ไม่มีช่องว่าง
 *   ถ้าเจอภาษาไทยในค่านั้น แปลว่ามันคือข้อความที่คนเขียน ไม่ใช่รหัส
 */
export function looksLikeToken(s: string): boolean {
  if (s.length <= LONG_VALUE_AT) return false
  if (/\s/.test(s)) return false
  // อักขระนอก ASCII = ภาษาอื่นที่คนอ่านออก (ไทย/จีน/ญี่ปุ่น…) → ไม่ใช่รหัส
  return /^[\x21-\x7E]+$/.test(s)
}

/**
 * ย่อค่ายาวเป็น "หัว…ท้าย"
 *
 * ── ทำไมต้องย่อตรงกลาง ไม่ใช่ท้ายอย่างเดียว ────────────────────────────
 *   ค่าแบบ hash (เช่น `versionId` ยาว 64 ตัว) ขึ้นต้นด้วย `34ad6c80…` ซึ่งเป็นส่วนที่
 *   **ไม่มีความหมายอะไรกับคนอ่าน** แต่ปลาย ๆ มักบอกว่าเป็นค่าของอะไร
 *   ถ้าย่อแบบ CSS ปกติ (`text-overflow: ellipsis`) จะตัด**ท้าย**ทิ้ง
 *   → ผู้ใช้เห็นหัวที่ไม่มีความหมาย 64 ตัวเต็ม ๆ แล้วเข้าใจว่าเป็นค่าเดียวกัน
 *      กับค่าอื่นในระบบ ซึ่งไม่จริง
 */
export function middleTruncate(s: string, head = 10, tail = 8): string {
  if (!looksLikeToken(s)) return s
  return `${s.slice(0, head)}…${s.slice(-tail)}`
}

/**
 * จัดกลุ่มฟิลด์
 *
 * ⚠️ **ลำดับกลุ่มต้องไม่ผูกกับชื่อกลุ่ม**
 *
 *   เดิมเรียงด้วย `sortFields()` ซึ่งเรียงตามชื่อกลุ่ม (a→z แบบไทย)
 *   พิมพ์ชื่อกลุ่มในช่อง "กลุ่ม" (`field-group-N`) แล้วกลุ่มจะย้ายตำแหน่ง
 *   **ทันทีทุกตัวอักษร** → React ย้าย DOM node ของทั้งกลุ่ม
 *   (ซึ่งกำลังมีโฟกัสอยู่) → โฟกัสหลุด
 *
 *   อาการที่ผู้ใช้เจอ: *"พิมพ์ 1 ตัวอักษา แล้วหลุด focus ต้องคลิกใหม่ถึงจะพิมพ์ได้"*
 *   และ IME ไทยพังหนักกว่านั้น เพราะ input ที่กำลัง "เรียงพิมพ์" ถูกย้ายกลางคัน
 *
 *   แก้แล้ว: เรียงกลุ่มตาม**ช่องตัวแรกที่อยู่ในกลุ่ม** (ลำดับที่ผู้ใช้จัดเองด้วยปุ่ม ↑↓)
 *   → พิมพ์ชื่อกลุ่มแล้วไม่มีอะไรขยับ → โฟกัสอยู่ตรงที่
 */
export function groupFields(
  fields: FieldDef[],
): Array<{ group: string; fields: FieldDef[] }> {
  const byOrder = [...fields].sort((a, b) => {
    if (a.order !== b.order) return a.order - b.order
    return a.key.localeCompare(b.key, 'th')
  })

  const map = new Map<string, FieldDef[]>()
  for (const f of byOrder) {
    const g = f.group || 'ทั่วไป'
    const list = map.get(g)
    if (list) list.push(f)
    else map.set(g, [f])
  }
  return [...map.entries()].map(([group, fields]) => ({ group, fields }))
}

// ── ตรวจข้อมูล ──────────────────────────────────────────────

/**
 * ค่านี้ "ยังไม่ได้กรอก" หรือไม่ — ใช้ร่วมกันทั้ง validate และนับความคืบหน้า
 *
 * ⚠️ ต้องเป็นนิยามเดียวกันเสมอ
 *   ถ้า validate นับว่าว่าง แต่ที่อื่นนับว่าไม่ว่าง
 *   ผู้ใช้จะเห็น "กรอกครบแล้ว" แต่กดสร้างแล้วถูกปฏิเสธ
 *   และไม่มีใครเข้าใจว่าทำไมสองที่ไม่ตรงกัน
 */
export function isBlankField(v: unknown): boolean {
  return v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0)
}

/**
 * นับว่ากรอกไปกี่ช่องแล้ว — ใช้บอกผู้ใช้ว่า "พร้อมสร้างเอกสารหรือยัง"
 *
 * ⚠️ ต้องเดินด้วย `getPath` เสมอ เพราะ key ของช่องจริง ๆ มีจุดคั่น
 *   (เช่น `ทดสอบ.ชื่อ30160`) ถ้าอ่านแบบ `data[key]` แบนจะได้ `undefined` ทุกช่อง
 *   แล้วบอกผู้ใช้ว่า "ยังไม่ได้กรอกเลย" ทั้งที่กรอกครบแล้ว
 */
export function countFilled(
  fields: FieldDef[],
  data: Record<string, unknown>,
): { filled: number; total: number } {
  let filled = 0
  for (const f of fields) {
    if (!isBlankField(getPath(data, f.key))) filled++
  }
  return { filled, total: fields.length }
}

function compilePattern(pattern: string | undefined): RegExp | null {
  if (!pattern) return null
  try {
    return new RegExp(pattern)
  } catch {
    return null
  }
}

/** คืน map `path → ข้อความ error` (ต้องตรงกับฝั่ง API) */
export function validateFormData(
  fields: FieldDef[],
  data: Record<string, unknown>,
): Record<string, string> {
  const errors: Record<string, string> = {}

  for (const f of fields) {
    const raw = getPath(data, f.key)
    const isBlank = isBlankField(raw)

    if (f.required && isBlank) {
      errors[f.key] = 'ช่องนี้ต้องกรอก'
      continue
    }
    if (isBlank) continue

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

/** ค่าเริ่มต้นตามชนิด — ใช้เปิดฟอร์มครั้งแรก */
export function sampleValueFor(f: FieldDef): unknown {
  const first = f.options?.[0]
  switch (f.type) {
    case 'checkbox':
      return false
    case 'number':
    case 'integer':
      return ''
    case 'multiselect':
      return first ? [first.value] : []
    default:
      return ''
  }
}

/** เติมค่าเริ่มต้นของทุกช่องที่ยังไม่มีค่า (ไม่ทับของที่ผู้ใช้กรอก) */
export function withDefaults(
  fields: FieldDef[],
  data: Record<string, unknown>,
): Record<string, unknown> {
  let out = data
  for (const f of fields) {
    const cur = getPath(out, f.key)
    if (cur === undefined || cur === null || cur === '') {
      out = setPath(out, f.key, sampleValueFor(f))
    }
  }
  return out
}

/** ชื่อแสดงผลของ field */
export function fieldLabel(f: FieldDef): string {
  return f.label?.trim() || f.key
}
