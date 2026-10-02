/**
 * ผูกสถานะหน้า Studio ไว้กับ URL
 *
 * ── รูปแบบ URL ──────────────────────────────────────────────────
 *   /studio                                   → หน้ารายการ
 *   /studio/<key>?tabs=form&pane=preview       → เปิดแม่แบบ · ซ้าย=ฟอร์ม · ขวา=ตัวอย่าง
 *   /studio/<key>?tabs=json&pane=fields        → ซ้าย=JSON · ขวา=ช่องฟอร์ม
 *   /studio/<key>?tabs=history&pane=preview    → ซ้าย=ประวัติของฉัน · ขวา=ตัวอย่าง
 *
 * หน้าแก้ไขแบ่งเป็น 2 ฝั่ง แต่ละฝั่งมีแท็บของตัวเอง → ต้องมี query 2 ตัว
 *
 * ⚠️ `history` มีได้ทั้งสองฝั่ง (ซ้าย=ประวัติของฉัน · ขวา=ผู้ใช้แม่แบบนี้)
 *    จึงต้องดู `?tabs=` ก่อนเสมอ แล้วค่อยตีความ `?pane=`
 *
 * ── ทำไมใช้ history API ตรง ๆ ไม่ใช่ router ของ Next ──────────────
 *   · ไม่ต้องวนกลับไปเซิร์ฟเวอร์ — URL เปลี่ยนทันที หน้าไม่กะพริบ
 *   · ปุ่มย้อนกลับ/ไป-กลับของเบราว์เซอร์ใช้ได้ถูกต้อง เพราะเราใช้ pushState จริง
 *     (ถ้าเก็บสถานะไว้แค่ใน React state ปุ่มย้อนกลับจะไม่พากลับไปหน้าก่อนหน้า)
 *   · ไม่ต้องมี route ซ้ำสำหรับแต่ละ query
 *
 * ⚠️ pushState/replaceState ของ Next ไม่มี event ให้ฟัง
 *    ผู้เรียกจึงต้องฟัง `popstate` เอง (ได้จากปุ่มย้อนกลับของเบราว์เซอร์)
 *    — `Studio.tsx` กับ `TemplateEditor.tsx` ฟังอยู่ทั้งคู่
 */

export const STUDIO_BASE = '/studio'

/** แท็บฝั่งซ้าย (สิ่งที่กรอกลงเอกสาร) */
export const TAB_PARAM = 'tabs'
/** แท็บฝั่งขวา (เรื่องของตัวแม่แบบ) */
export const PANE_PARAM = 'pane'

/**
 * ดึง key ของแม่แบบจาก path
 *
 *   /studio          → null
 *   /studio/         → null   (มี slash ท้าย)
 *   /studio/15210…   → '15210…'
 *   /docs            → null   (ไม่ใช่หน้า studio)
 */
export function readTemplateKey(pathname: string): string | null {
  const path = pathname.replace(/\/+$/, '') // ตัด slash ท้ายทิ้ง
  if (path === STUDIO_BASE) return null
  if (!path.startsWith(`${STUDIO_BASE}/`)) return null
  const key = path.slice(STUDIO_BASE.length + 1)
  return key || null
}

/**
 * ประกอบ URL ของหน้า studio
 *
 * @param key  key แม่แบบ · null = หน้ารายการ
 * @param tab  แท็บฝั่งซ้ายที่เปิดอยู่
 * @param pane แท็บฝั่งขวาที่เปิดอยู่
 */
export function studioPath(key: string | null, tab?: string | null, pane?: string | null): string {
  const base = key ? `${STUDIO_BASE}/${encodeURIComponent(key)}` : STUDIO_BASE
  const q = new URLSearchParams()
  if (tab) q.set(TAB_PARAM, tab)
  if (pane) q.set(PANE_PARAM, pane)
  const query = q.toString()
  return query ? `${base}?${query}` : base
}

/** อ่านค่า query param ตัวหนึ่ง (คืน null ถ้าไม่มีหรืออ่านไม่ได้) */
export function readParam(search: string, name: string): string | null {
  try {
    return new URLSearchParams(search).get(name)
  } catch {
    return null
  }
}

/**
 * เปลี่ยน URL โดยไม่ต้องโหลดหน้าใหม่
 *
 * @param mode `push`   เพิ่มประวัติ (เปิด/ปิดแม่แบบ — กดย้อนกลับได้)
 *              `replace` แทนที่รายการเดิม (สลับแท็บ — ไม่ควรกองประวัติ)
 */
export function setUrl(path: string, mode: 'push' | 'replace' = 'push'): void {
  if (typeof window === 'undefined') return
  // ถ้า URL เหมือนเดิมอยู่แล้ว ไม่ต้องแตะ history (กันรายการซ้ำตอนกดแท็บเดิม)
  if (window.location.pathname + window.location.search === path) return
  if (mode === 'push') window.history.pushState(null, '', path)
  else window.history.replaceState(null, '', path)
}
