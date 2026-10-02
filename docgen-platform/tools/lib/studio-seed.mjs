/**
 * เตรียมแม่แบบให้พร้อมเรนเดอร์ก่อนเทสต์ด้วยเบราว์เซอร์ — และคืนสภาพเดิมตอนจบ
 *
 *   import { importTags, snapshotForm, restoreForm, FILL_FIELDS_JS } from './lib/studio-seed.mjs'
 *
 * ── ทำไมต้องมี ────────────────────────────────────────────────
 *   เทสต์ที่เปิดหน้าแก้แม่แบบแล้วกด "เรนเดอร์ตัวอย่าง" **ต้องกรอกฟอร์มให้ครบก่อน**
 *   เพราะแอปบล็อกการเรนเดอร์เมื่อช่องบังคับยังว่าง
 *
 *   เคยตกแบบนี้: `test-download-pages` เปิดแม่แบบ `ทดสอบหัวกระดาษ` แล้วกดเรนเดอร์ทันที
 *   → ขึ้น "ยังกรอกไม่ครบ 1 ช่อง — สุ่มเฉพาะในทับหนังสือ" → ไม่มี canvas ให้วัด
 *   → เทสต์ตกทั้งชุด แต่พอรันเดี่ยวกลับผ่าน เพราะแม่แบบที่ `prefer` เลือกเปลี่ยนไปตามลำดับรายการ
 *
 * ── กฎที่ต้องไม่ลืม ────────────────────────────────────────────
 *   1. `import-tags` **เขียนทับ** ฟอร์มเดิม → ต้อง snapshot ก่อน แล้ว `restoreForm` ตอนจบ
 *      ไม่งั้นเทสต์หนึ่งจะไปลบฟอร์มของแม่แบบที่เทสต์อื่นใช้อยู่
 *   2. กรอกทุกช่องที่พิมพ์ได้ ไม่ต้องเดาว่าแม่แบบนี้มีช่องอะไรบ้าง
 *      (แอปยิง `import-tags` ให้เองตอนเปิด แต่ถ้ายังไม่ทันเขียน ให้เรียกเองดีกว่าเดา)
 */

const API = process.env.API_URL ?? 'http://127.0.0.1:4001'

/** อ่านฟอร์มปัจจุบันของแม่แบบไว้ก่อนจะไปแก้ (คืน `null` ถ้ายังไม่เคยตั้งฟอร์ม) */
export async function snapshotForm(headers, key) {
  if (!key) return null
  const res = await fetch(`${API}/api/form/${key}`, { headers })
  if (!res.ok) return null
  const body = await res.json()
  return { fields: body?.fields ?? [] }
}

/**
 * คืนฟอร์มที่ snapshot ไว้
 *
 * ⚠️ ถ้าเดิมไม่มีฟอร์มเลย ต้อง **ลบ** ไม่ใช่ `PUT` ค่าว่าง
 *    เพราะ `PUT []` จะทำให้แม่แบบนั้นมี "ฟอร์มว่าง" ซึ่งต่างจากไม่มีฟอร์ม
 *    และแอปจะเลิกแสดงแท็ก `หน่วยงาน`/`เนื้อหา` ให้ยิง import-tags อัตโนมัติ
 */
export async function restoreForm(headers, key, snap) {
  if (!key) return
  if (snap && snap.fields.length > 0) {
    await fetch(`${API}/api/form/${key}`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ fields: snap.fields }),
    })
  } else {
    await fetch(`${API}/api/form/${key}`, { method: 'DELETE', headers })
  }
}

/** สร้างช่องกรอกจากแท็กจริงของแม่แบบ (ไม่ต้องเดาว่าแม่แบบนี้ควรมีช่องอะไรบ้าง) */
export async function importTags(headers, tpl) {
  if (!tpl?.versionId) return { ok: false, status: 'ไม่มี versionId' }
  const res = await fetch(`${API}/api/form/${tpl.id ?? tpl.versionId}/import-tags`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ versionId: tpl.versionId }),
  })
  return { ok: res.ok, status: res.status }
}

/**
 * นิพจน์ JS สำหรับกรอกทุกช่องที่พิมพ์ได้ในคอลัมน์ฟอร์มฝั่งซ้าย
 *
 * ⚠️ ต้องใช้ setter ของ prototype แล้วยิง `input`
 *    React จะไม่เห็นการเปลี่ยนค่าที่ทำด้วย `el.value = ...` ตรง ๆ
 * ⚠️ ต้องหลีกเลี่ยง `.editor-col--right` — คอลัมน์ขวามีช่องค้นหาของแท็บอื่นปนอยู่
 */
export const FILL_FIELDS_JS = `(() => {
  const scope = document.querySelector('.editor-col:not(.editor-col--right)')
  if (!scope) return 0
  const set = (el, v) => {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement : HTMLInputElement
    Object.getOwnPropertyDescriptor(proto.prototype, 'value').set.call(el, v)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }
  const fields = [...scope.querySelectorAll('input[type=text], input[type=email], textarea')]
  fields.forEach((el, i) => set(el, 'ทดสอบข้อมูล ' + (i + 1)))
  return fields.length
})()`
