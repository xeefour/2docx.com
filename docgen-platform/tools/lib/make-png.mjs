/**
 * สร้าง PNG ทรงเอกสาร A4 จริง ใช้ทดสอบซูมรูปตัวอย่าง
 *
 *   node logs/make-png.mjs  (เรียกจากสคริปต์อื่น)
 *
 * ── ทำไมต้องสร้างเอง ──────────────────────────────────────────────
 * รูปที่มีอยู่ในระบบทั้งหมดเป็นภาพหน้าเอกสารจริง แต่เทสต์เดิมใช้ PNG 1×1
 *   ซึ่งเล็กเกินกว่าจะวัดผลของการซูมได้ (ซูมเท่าไรก็ยังเล็กอยู่)
 *   ต้องมีภาพที่ "สูงกว่าพื้นที่วาง" จึงจะพิสูจน์ได้ว่าซูมแล้วเลื่อนดูได้จริง
 *
 * PNG เขียนเองได้ไม่ยาก: signature + IHDR + IDAT (zlib) + IEND
 *   ไม่ต้องพึ่งไลบรารีภาพใด ๆ (sharp/canvas ไม่ได้ติดตั้งในโปรเจกต์นี้)
 */
import { deflateSync } from 'node:zlib'

/** CRC-32 ตามสเปก PNG (poly 0xEDB88320) */
const CRC_TABLE = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c
  }
  return t
})()

function crc32(buf) {
  let c = -1
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body), 0)
  return Buffer.concat([len, body, crc])
}

/**
 * PNG สี RGB ไม่มี alpha
 * @param w ความกว้าง px
 * @param h ความสูง px
 * @param rgb [r,g,b] สีพื้น — ใช้แยกรูปให้แต่ละใบไม่ซ้ำกัน
 * @param bands เส้นแนวนอนสีอื่น (จำนวนครั้ง) ให้เห็นว่าเลื่อนถึงปลายจริง
 */
export function makePng(w, h, rgb = [255, 255, 255], bands = 0) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // color type = truecolor RGB
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0

  // raw = ทุกแถวขึ้นต้นด้วย byte filter (0 = None)
  const stride = w * 3
  const raw = Buffer.alloc((stride + 1) * h)
  for (let y = 0; y < h; y++) {
    const rowStart = y * (stride + 1)
    raw[rowStart] = 0
    // เส้นแนวนอนสีเข้ม ทุก ๆ N แถว → ตอนซูมต้องมองเห็นว่าเลื่อนได้จริง
    const isBand = bands > 0 && y % Math.max(1, Math.floor(h / (bands * 2 + 1))) === 0
    for (let x = 0; x < w; x++) {
      const p = rowStart + 1 + x * 3
      raw[p] = isBand ? 20 : rgb[0]
      raw[p + 1] = isBand ? 20 : rgb[1]
      raw[p + 2] = isBand ? 40 : rgb[2]
    }
  }

  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/** สัดส่วน A4 แนวตั้ง ≈ 1:1.414 */
export const A4 = { w: 850, h: Math.round(850 * 1.414) }
