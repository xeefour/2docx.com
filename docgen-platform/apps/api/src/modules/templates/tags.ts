/**
 * ดึงรายการแท็ก `{d.*}` ที่ใช้จริงในไฟล์แม่แบบ
 *
 * ทำไมต้องแกะฝั่งเซิร์ฟเวอร์ — `.docx` คือไฟล์ zip
 * เบราว์เซอร์แกะเองไม่ได้โดยไม่ต้องลาก library น้ำหนักเข้ามา
 * แถมไฟล์ 20 MB ยิงผ่านเน็ตไปให้เบราว์เซอร์แกะทุกครั้งก็ช้าเปล่า
 *
 * ── จุดที่ทำให้พลาด ─────────────────────────────────────────────
 * Word แบ่งข้อความเป็น "run" หลายก้อน ข้อความเดียวกันอาจถูกแบ่งข้าม ๆ `<w:t>`
 * เช่น `{d.` อยู่ run แรก แต่ `ชื่อ}` อยู่ run ถัดไป
 * → regex บน XML ดิบจะ **พลาดทั้งแท็ก**
 * ทางแก้คือดึงข้อความทุก `<w:t>` มาต่อกันตามลำดับก่อน แล้วค่อย regex
 */

import { unzipSync, strFromU8 } from 'fflate'
import { downloadTemplate } from './carbone.js'

/** ไฟล์ใน docx ที่มีเนื้อหาเอกสารอยู่จริง */
const CONTENT_PARTS = [
  /^word\/document\.xml$/,
  /^word\/header\d*\.xml$/,
  /^word\/footer\d*\.xml$/,
  /^word\/footnotes\.xml$/,
  /^word\/endnotes\.xml$/,
]

/**
 * ชื่อ field ที่แท็กอ้างถึง
 *
 * ครอบคลุม syntax ของ Carbone ทุกแบบที่ใช้บ่อย:
 *   `{d.ชื่อ}`                              → ชื่อ
 *   `{d.วันที่:formatD('DD/MM/YYYY')}`      → วันที่   (ตัด formatter ทิ้ง)
 *   `{d.ปกติ:ifEQ(true):show('x')}`         → ปกติ    (ตัดเงื่อนไขทิ้ง)
 *   `{ifEQ(d.ปกติ):show('x')}`              → ปกติ    (อ้างข้ามูลในเงื่อนไข)
 *   `{d.items[i].รายการ}`                   → items[i].รายการ
 *   `{#alias = d.รหัส}`                     → รหัส
 *
 * path จบที่ `:` `)` `'` `"` ช่องว่าง หรือ `{` `}` เท่านั้น
 * — เพราะชื่อ field จริง ๆ ไม่มีอักขระเหล่านี้
 */
const REF_RE = /d\.([^\s:)'"{}[\]]+)/g

/** ดึงข้อความทุกก้อนในไฟล์ XML มาต่อกันตามลำดับที่อ่านได้ */
function extractText(xml: string): string {
  // เอาเนื้อหาใน <w:t> … </w:t> และตัด tag อื่นทิ้ง
  const runs = xml.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)
  let out = ''
  for (const r of runs) {
    const chunk = r[1]
    if (chunk === undefined) continue
    // entity กลับเป็นอักขระจริง ไม่งั้นชื่อฟิลด์ที่มี & จะหายไป
    out += chunk
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&amp;/g, '&')
  }
  return out
}

/** ชิ้นส่วนที่มีแท็กซ้ำกันเยอะ — นับแล้วเรียงตามจำนวนครั้งที่ใช้ */
export type TemplateTag = {
  /** เช่น "ชื่อ" หรือ "items[i].รายการ" */
  path: string
  /** ตัวแปรระดับบนสุด เช่น "items" — ใช้ตอนสร้าง JSON ตัวอย่างให้อัตโนมัติ */
  root: string
  count: number
}

export function parseTagsFromDocx(buf: Buffer): TemplateTag[] {
  let files: Record<string, Uint8Array>
  try {
    files = unzipSync(new Uint8Array(buf))
  } catch {
    throw new Error('ไฟล์นี้ไม่ใช่ .docx / .xlsx / .pptx (แกะ zip ไม่ได้)')
  }

  const found = new Map<string, number>()

  for (const [name, data] of Object.entries(files)) {
    if (!CONTENT_PARTS.some((re) => re.test(name))) continue

    const text = extractText(strFromU8(data))
    for (const m of text.matchAll(REF_RE)) {
      const path = m[1]?.trim()
      if (!path) continue
      found.set(path, (found.get(path) ?? 0) + 1)
    }
  }

  return [...found.entries()]
    .map(([path, count]) => ({
      path,
      root: path.split(/[.[]/, 1)[0] ?? path,
      count,
    }))
    .sort((a, b) => b.count - a.count || a.path.localeCompare(b.path, 'th'))
}

/** ตัวอย่างค่าเริ่มต้นสำหรับ JSON ที่ผู้ใช้จะกรอก — ใช้กับ editor ฝั่งเว็บ */
function seedValue(path: string): unknown {
  // มี index ([i] หรือ [i+1]) = ต้องเป็นอาร์เรย์
  if (/\[\s*\d/.test(path)) return ['ค่า 1', 'ค่า 2']
  return `«${path}»`
}

/** สร้าง JSON ตัวอย่างจากรายการแท็ก เพื่อให้ผู้ใช้แก้แค่ค่า ไม่ต้องเดาโครงสร้าง */
export function buildSampleData(tags: TemplateTag[]): Record<string, unknown> {
  const root: Record<string, unknown> = {}

  for (const tag of tags) {
    // `items[i+1].ชื่อ` → ['items[i+1]', 'ชื่อ']  (เก็บ `[i+1]` ไว้เพราะบอกได้ว่าระดับนี้เป็นอาร์เรย์)
    const raws = tag.path.split('.').filter(Boolean)
    let node: Record<string, unknown> = root

    raws.forEach((raw, i) => {
      const field = raw.replace(/\[\s*[^\]]*\]\s*/g, '')
      if (!field) return
      const isLast = i === raws.length - 1

      if (isLast) {
        node[field] = seedValue(tag.path)
        return
      }

      /**
       * ระดับนี้ต้องเป็น container เพื่อรองรับแท็กที่ลึกกว่า
       *
       * ⚠️ ต้องแทนทิ้งใหม่เสมอถ้าเป็นอาร์เรย์ แต่ของเดิมไม่ใช่
       *   เพราะแท็กอีกตัวอาจทำให้ field นี้เป็น leaf (สตริง) มาแล้ว
       *   เช่น มีทั้ง `{d.การอนุมัติ[i+1]}` และ `{d.การอนุมัติ[i+1].ชื่อ}`
       *   ตัวแรกทำให้เป็นสตริง ตัวหลังจะพยายามเขียนลงสตริง → error
       */
      const wantArray = /\[\s*\d/.test(raw)
      const current = node[field]
      const isObject = current !== null && typeof current === 'object'
      if (!isObject || (wantArray && !Array.isArray(current))) {
        node[field] = wantArray ? [] : {}
      }

      const child = node[field] as Record<string, unknown> | unknown[]
      if (Array.isArray(child)) {
        // สร้างตัวแรกของอาร์เรย์ให้เป็น object เสมอ เพื่อให้ต่อลงไปได้
        if (child[0] === null || typeof child[0] !== 'object') child[0] = {}
        node = child[0] as Record<string, unknown>
      } else {
        node = child as Record<string, unknown>
      }
    })
  }

  return root
}

/** ดึงแท็ก + ตัวอย่าง JSON จากแม่แบบใน Carbone */
export async function readTemplateTags(versionId: string) {
  // downloadTemplate คืน { body, filename, contentType } — เอามาแค่ body
  const { body } = await downloadTemplate(versionId)
  const tags = parseTagsFromDocx(body)
  return { items: tags, sample: buildSampleData(tags) }
}
