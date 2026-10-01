/**
 * ทดสอบการคำนวณจุดขีดของไม้บรรทัด — ฟังก์ชันบริสุทธิ์ ไม่ต้องมีเบราว์เซอร์
 *
 *   npx.cmd tsx tools/test-ruler.mjs
 *
 * ⚠️ ตัวเลขบนไม้บรรทัดผิด = ผู้ใช้วัดผิด
 *    จึงต้องเช็กทั้งการแปลงหน่วย ความถี่จุดขีด และการไม่มีเลขซ้อนกัน
 */
import { formatTick, MIN_LABEL_GAP, pageUnits, pickStep, ticks } from '../apps/web/app/studio/lib/ruler.ts'

let pass = 0
let fail = 0
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`)
  ok ? pass++ : fail++
}

/** A4 = 595.28 × 841.89 pt · Letter = 612 × 792 pt */
const A4 = { w: 595.28, h: 841.89 }
const LETTER = { w: 612, h: 792 }

console.log('\n[1] แปลงหน่วยจาก pt (PDF unit) → หน่วยที่ผู้ใช้เห็น')
{
  const cm = pageUnits(A4.w, A4.h, 'cm')
  check('A4 กว้าง 21 ซม.', Math.abs(cm.w - 21) < 0.02, `${cm.w.toFixed(3)} ซม.`)
  check('A4 สูง 29.7 ซม.', Math.abs(cm.h - 29.7) < 0.02, `${cm.h.toFixed(3)} ซม.`)
  const inch = pageUnits(A4.w, A4.h, 'in')
  check('A4 กว้าง 8.27 นิ้ว', Math.abs(inch.w - 8.267) < 0.01, `${inch.w.toFixed(3)} นิ้ว`)
  check('A4 สูง 11.69 นิ้ว', Math.abs(inch.h - 11.693) < 0.01, `${inch.h.toFixed(3)} นิ้ว`)
  const l = pageUnits(LETTER.w, LETTER.h, 'in')
  check('Letter กว้าง 8.5 นิ้ว', l.w === 8.5, `${l.w} นิ้ว`)
  check('ซม. ของ Letter ≈ 21.59', Math.abs(pageUnits(LETTER.w, LETTER.h, 'cm').w - 21.59) < 0.01)
}

console.log('\n[2] เลือกขั้นจุดขีด — ตัวเลขต้องไม่ซ้อนกัน')
{
  // A4 กว้าง 21 ซม. · ความกว้างจริงบนจอต่างกันตามซูม
  const cases = [
    [21, 900, 'กว้างมาก (ซูม 150%)'],
    [21, 600, 'ปกติ'],
    [21, 300, 'ซูม 50%'],
    [21, 180, 'จอแคบ'],
    [8.27, 600, 'หน่วยนิ้ว'],
    [8.27, 200, 'นิ้วจอแคบ'],
  ]
  for (const [total, px, label] of cases) {
    const { major } = pickStep(total, px)
    const gap = (major / total) * px
    check(
      `${label}: ระยะระหว่างตัวเลข ≥ ${MIN_LABEL_GAP}px`,
      gap >= MIN_LABEL_GAP - 0.5,
      `ขั้น ${major} · ${gap.toFixed(0)}px`,
    )
  }
  check('ถ้ากว้างมากต้องได้ขั้นละเอียดกว่า', pickStep(21, 900).major < pickStep(21, 180).major)
  check('ขั้นหลักหาร 5 ได้เป็นขีดย่อย', pickStep(21, 600).minor === pickStep(21, 600).major / 5)
}

console.log('\n[3] รายการจุดขีด')
{
  const t = ticks(21, 600)
  check('ขึ้นต้นที่ 0 เสมอ', t.major[0] === 0)
  check('ไม่เกินขนาดหน้า', t.major[t.major.length - 1] <= 21, `สูงสุด ${t.major[t.major.length - 1]}`)
  check('ไม่มีตัวเลขซ้ำ', new Set(t.major).size === t.major.length)
  check('ไม่มีเลขซ้ำทศนิยมยาว (เช่น 0.30000000000000004)', t.minor.every((v) => String(v).length <= 6), t.minor.slice(0, 4).join(','))
  check('จุดขีดย่อยอยู่ระหว่างจุดหลักเสมอ', t.minor.every((v) => v < 21))

  const i = ticks(8.27, 600)
  check('นิ้ว: ขึ้นต้นที่ 0', i.major[0] === 0)
  check('นิ้ว: ไม่เกิน 8.27', i.major[i.major.length - 1] <= 8.27, `สูงสุด ${i.major[i.major.length - 1]}`)

  // เอกสารหน้าเดียวเล็ก ๆ
  const small = ticks(5, 300)
  check('หน้าเล็กก็ยังมีจุดขีด', small.major.length >= 3, `${small.major.length} จุด`)
  check('หน้าเล็กขึ้นต้นที่ 0', small.major[0] === 0)
}

console.log('\n[4] รูปแบบตัวเลขบนไม้บรรทัด')
check('0 ไม่ต้องมีทศนิยม', formatTick(0, 'cm') === '0' && formatTick(0, 'in') === '0')
check('ซม. ไม่มีทศนิยมเกิน 2 ตำแหน่ง', formatTick(1.5, 'cm') === '1.5', formatTick(1.5, 'cm'))
check('นิ้วมีทศนิยม 1 ตำแหน่ง', formatTick(0.5, 'in') === '0.5', formatTick(0.5, 'in'))
check('นิ้วปัด 1.25 → 1.3', formatTick(1.25, 'in') === '1.3', formatTick(1.25, 'in'))

console.log(`\n── ผ่าน ${pass} · ไม่ผ่าน ${fail} ─────────────────────\n`)
process.exit(fail ? 1 : 0)
