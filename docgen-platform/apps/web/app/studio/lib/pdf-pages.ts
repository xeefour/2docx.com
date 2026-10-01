/**
 * ตัดหน้าออกจาก PDF — ทำฝั่งเบราว์เซอร์ ไม่ต้องส่งไปให้เซิร์ฟเวอร์เรนเดอร์ใหม่
 *
 * ── ทำไมถึงตัดเอง ไม่ใช่ยิง API ใหม่ ──────────────────────────────
 *   งานเรนเดอร์ถึงเสร็จแล้ว (ไฟล์ PDF อยู่ในมือ) การตัดหน้าเป็นงานจัดโครงสร้างเอกสารล้วน ๆ
 *   ถ้ายิง API ใหม่ = เพิ่ม round-trip เพิ่ม worker เพิ่มจุดพัง
 *   แต่ถ้าไม่ตัด ผู้ใช้ที่สั่ง "หน้า 2-3" ได้ PDF ครบ 8 หน้าซึ่งไม่ตรงที่สั่ง
 */
import { PDFDocument } from 'pdf-lib'

/**
 * เก็บเฉพาะหน้าที่เลือก
 *
 * @param bytes PDF ฉบับเต็ม
 * @param pages เลขหน้า 1-based เรียงแล้ว
 */
export async function pickPdfPages(bytes: Uint8Array, pages: number[]): Promise<Uint8Array> {
  const src = await PDFDocument.load(bytes, { ignoreEncryption: true })
  const wanted = pages.map((n) => n - 1) // pdf-lib ใช้ 0-based

  /**
   * ⚠️ `copyPages` **ต้องเรียกบน document ปลายทาง**
   *
   *   ข้างใน pdf-lib คือ `PDFObjectCopier.for(srcDoc.context, this.context)`
   *   ถ้าเขียน `src.copyPages(src, idx)` → ทั้งสองปลายทางเป็น context ของ src
   *   หน้าที่คัดลอกมาจึงผูกกับ src ไม่ใช่ out
   *   แล้วพอ `out.addPage()` จะโยน
   *   "A `page` ... was from a different (foreign) PDF document"
   *   ต้องเป็น `out.copyPages(src, idx)` เท่านั้น
   */
  const out = await PDFDocument.create()
  const copied = await out.copyPages(src, wanted)

  // ⚠️ ต้อง copy metadata มาด้วย ไม่งั้นไฟล์ที่ได้จะไม่มีชื่อ/ผู้สร้างเดิม
  out.setTitle(src.getTitle() ?? '')
  out.setProducer(src.getProducer() ?? '')
  out.setCreator(src.getCreator() ?? '')
  for (const p of copied) out.addPage(p)
  return out.save()
}
