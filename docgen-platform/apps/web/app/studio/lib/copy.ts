/**
 * คัดลอกข้อความไปคลิปบอร์ด — มีทางสำรองกรณี clipboard ถูกบล็อก
 *
 *   import { copyText } from './lib/copy'
 *
 * ── ทำไมต้องมีไฟล์นี้ ────────────────────────────────────────────
 * เคยมีฟังก์ชันนี้อยู่ใน `components/AppStatus.tsx` (แถบ URL มุมล่าง)
 * แล้วต้องการใช้ซ้ำใน SharePanel ตอนแสดงลิงก์สาธารณ
 *
 *   ไม่คัดลอกโค้ดไปวางที่สองที่ เพราะ**ทางสำรองนี้แก้ยาก**
 *   คนหนึ่งไปแก้เฉพาะฝั่งตัวเอง แล้วอีกฝั่งยังพังอยู่โดยไม่มีใครรู้
 *
 * ⚠️ ทางสำรองใช้ `document.execCommand('copy')` ซึ่งเบราว์เซอร์รุ่นใหม่
 *    เตือนว่าเลิกใช้ แต่ยังจำเป็นตอนผู้ใช้ไม่ได้กดอนุญาต clipboard
 *    (เช่น กดผ่านสคริปต์อัตโนมัติ หรือ http ที่ไม่ใช่ localhost)
 *    จึงยังต้องมี แต่ต้องอยู่ในที่เดียว
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    /* ตกไปลองวิธีถัดไป */
  }
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.setAttribute('readonly', '')
    ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0'
    document.body.appendChild(ta)
    ta.select()
    const ok = document.execCommand('copy')
    ta.remove()
    return ok
  } catch {
    return false
  }
}
