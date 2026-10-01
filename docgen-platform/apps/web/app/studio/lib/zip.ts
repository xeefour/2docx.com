/**
 * รวมหลายไฟล์เป็น ZIP ไฟล์เดียว — ทำงานฝั่งเบราว์เซอร์ ไม่ต้องส่งไปเซิร์ฟเวอร์
 *
 * ── ทำไม `level: 0` (ไม่บีบอัด) ───────────────────────────────────
 *   เนื้อหาที่เราใส่คือ PNG ซึ่ง**บีบอัดมาแล้ว** การบีบซ้ำไม่ได้ผลอะไร
 *   แต่เพิ่มเวลา CPU และเพิ่มหน่วยความจำตอนแตก ZIP
 *   (เอกสาร 20 หน้า @2x กินหลายสิบ MB ใน canvas อยู่แล้ว)
 *
 * ── ทำไมไม่ใช้ `CompressionStream` ของเบราว์เซอร์ ───────────────
 *   มันบีบอัดแบบ DEFLATE แต่เขียนไฟล์ ZIP ดิบเองไม่ได้ ต้องมีคนจัดโครงสร้าง
 *   ส่วน `fflate` เขียนโครงสร้าง ZIP ให้ครบ (local header + central directory + EOCD)
 *   และเป็น dependency ที่ monorepo นี้มีอยู่แล้ว
 */
import { zipSync } from 'fflate'

export type ZipEntry = { name: string; data: Uint8Array }

/** รวมเป็น Blob พร้อมชื่อไฟล์ */
export function makeZip(entries: ZipEntry[], filename: string): { blob: Blob; filename: string } {
  if (entries.length === 0) throw new Error('ไม่มีไฟล์ที่จะรวม')

  const table: Record<string, Uint8Array> = {}
  for (const e of entries) {
    /**
     * ⚠️ กันชื่อซ้ำ — ถ้าผู้ใช้เลือกหน้า 1-3 แล้วสั่งซ้ำ
     *    `zipSync` จะเขียนทับไฟล์เดิมเงียบ ๆ แล้ว ZIP สั้นลงกว่าที่ควร
     */
    let name = e.name
    for (let i = 2; table[name]; i++) name = e.name.replace(/(\.[^.]+)$/, `-${i}$1`)
    table[name] = e.data
  }

  const bytes = zipSync(table, { level: 0 })
  // คัดลอกเป็น ArrayBuffer สะอาด — Blob ต้องการ BufferSource ที่ไม่มี offset
  return { blob: new Blob([bytes.slice().buffer], { type: 'application/zip' }), filename }
}

/** Blob → Uint8Array (สำหรับปั่น canvas) */
export async function blobToBytes(blob: Blob): Promise<Uint8Array> {
  return new Uint8Array(await blob.arrayBuffer())
}
