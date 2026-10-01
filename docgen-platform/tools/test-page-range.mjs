/**
 * ทดสอบตัวแยกช่วงหน้า — ฟังก์ชันบริสุทธิ์ ไม่ต้องมีเบราว์เซอร์
 *
 *   npx.cmd tsx tools/test-page-range.mjs
 *
 * ⚠️ import ไฟล์ `.ts` ของแอปตรง ๆ ไม่คัดลอกโค้ดมาทดสอบ
 *    ถ้าคัดลอก วันหนึ่งแอปเปลี่ยนแต่เทสต์ยังทดสอบโค้ดเก่า
 *    (tsx อยู่ใน devDependencies ของ monorepo อยู่แล้ว ใช้ได้เลย)
 */
import {
  parsePageRange,
  allPages,
  describeSelection,
  pageSuffix,
} from '../apps/web/app/studio/lib/pages.ts'

let pass = 0
let fail = 0
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`)
  ok ? pass++ : fail++
}

const ok = (spec, total) => {
  const r = parsePageRange(spec, total)
  return r.ok ? r.pages : `ข้อผิดพลาด: ${r.reason}`
}
const isErr = (spec, total) => {
  const r = parsePageRange(spec, total)
  return r.ok ? false : r.reason
}

console.log('\n[1] ค่าว่าง = ทุกหน้า')
check('ว่าง → ทุกหน้า', JSON.stringify(ok('', 3)) === '[1,2,3]', JSON.stringify(ok('', 3)))
check('ช่องว่างเต็ม → ทุกหน้า', JSON.stringify(ok('   ', 2)) === '[1,2]')
check('เอกสาร 0 หน้า → array ว่าง', JSON.stringify(ok('', 0)) === '[]')

console.log('\n[2] หน้าเดี่ยวและช่วง')
check('หน้าเดี่ยว', JSON.stringify(ok('2', 5)) === '[2]', JSON.stringify(ok('2', 5)))
check('ช่วง 1-3', JSON.stringify(ok('1-3', 5)) === '[1,2,3]', JSON.stringify(ok('1-3', 5)))
check('ผสม 1-3, 5', JSON.stringify(ok('1-3, 5', 8)) === '[1,2,3,5]', JSON.stringify(ok('1-3, 5', 8)))
check('มีช่องว่างข้าง ๆ ได้', JSON.stringify(ok(' 1 , 3 ', 5)) === '[1,3]')

console.log('\n[3] ช่วงเปิด/ปิด')
check('8- = จากหน้า 8 ถึงสุด', JSON.stringify(ok('8-', 10)) === '[8,9,10]', JSON.stringify(ok('8-', 10)))
check('-3 = ตั้งแต่แรกถึงหน้า 3', JSON.stringify(ok('-3', 8)) === '[1,2,3]', JSON.stringify(ok('-3', 8)))
check('1- ทั้งฉบับ', JSON.stringify(ok('1-', 3)) === '[1,2,3]')

console.log('\n[4] กันซ้ำและเรียงให้')
check('เรียงเลขให้', JSON.stringify(ok('3,1,2', 5)) === '[1,2,3]', JSON.stringify(ok('3,1,2', 5)))
check('ตัดค่าซ้ำ', JSON.stringify(ok('2,2,1', 5)) === '[1,2]', JSON.stringify(ok('2,2,1', 5)))
check('ทับกันข้ามช่วง', JSON.stringify(ok('1-3,2-5', 6)) === '[1,2,3,4,5]', JSON.stringify(ok('1-3,2-5', 6)))
check('ข้ามช่องว่างเปล่า 1,,3', JSON.stringify(ok('1,,3', 5)) === '[1,3]')

console.log('\n[5] ข้อความผิดต้องต้องบอกเหตุผล ไม่ใช่เงียบ ๆ')
const cases = [
  ['abc', 5, 'ต้องเป็นตัวเลข'],
  ['0', 5, 'หน้าเริ่มที่ 1'],
  ['99', 5, 'เอกสารมีแค่ 5 หน้า'],
  ['1-99', 5, 'เอกสารมีแค่ 5 หน้า'],
  ['5-1', 5, 'ช่วงกลับด้าน'],
  ['1.5', 5, 'ต้องเป็นตัวเลข'],
  ['-0', 5, 'หน้าเริ่มที่ 1'],
  [',', 5, 'ยังไม่ได้เลือกหน้า'],
]
for (const [spec, total, why] of cases) {
  const r = isErr(spec, total)
  check(`"${spec}" → แจ้งว่า ${why}`, r !== false && r.includes(why), r === false ? 'กลับผ่าน!' : r)
}
check('เอกสาร 0 หน้า + พิมพ์หน้า', isErr('1', 0) !== false, isErr('1', 0))

console.log('\n[6] ข้อความอธิบายและชื่อไฟล์')
check('ทั้งหมด → "ทั้งหมด 5 หน้า"', describeSelection([1, 2, 3, 4, 5], 5) === 'ทั้งหมด 5 หน้า', describeSelection([1, 2, 3, 4, 5], 5))
check('บางส่วน → "3 จาก 5 หน้า"', describeSelection([1, 2, 3], 5) === '3 จาก 5 หน้า', describeSelection([1, 2, 3], 5))
check('ทั้งหมด → ไม่ต่อท้ายชื่อ', pageSuffix([1, 2, 3], 3) === '', `"${pageSuffix([1, 2, 3], 3)}"`)
check('หน้าเดี่ยว → -หน้า2', pageSuffix([2], 8) === '-หน้า2', `"${pageSuffix([2], 8)}"`)
check('ช่วง → -หน้า2-4', pageSuffix([2, 3, 4], 8) === '-หน้า2-4', `"${pageSuffix([2, 3, 4], 8)}"`)

console.log('\n[7] allPages')
check('คืนเลขเรียง 1..n', JSON.stringify(allPages(3)) === '[1,2,3]', JSON.stringify(allPages(3)))
check('n=0 → ว่าง', JSON.stringify(allPages(0)) === '[]')
check('n ติดลบ → ว่าง ไม่พัง', JSON.stringify(allPages(-5)) === '[]')

console.log(`\n── ผ่าน ${pass} · ไม่ผ่าน ${fail} ─────────────────────\n`)
process.exit(fail ? 1 : 0)
