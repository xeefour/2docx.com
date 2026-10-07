/**
 * check-manual-tags — กันไม่ให้ตัวอย่างในคู่มือหลุดจากการพิสูจน์
 * =========================================================
 *
 * ปัญหาที่ต้องกัน
 * ---------------
 * คู่มือมีตัวอย่างหลายร้อยชิ้น วันหนึ่งมีคนแก้เพิ่มตัวอย่างใหม่
 * ที่ยังไม่เคยรันทดสอบจริง บอกผู้ใช้ได้ว่าทำได้ แต่จริง ๆ แล้วไม่ได้
 * ไฟล์นี้จึงตรวจว่า "ทุก tag ที่ปรากฏในคู่มือ ต้องมีที่มาอยู่ในชุดที่พิสูจน์แล้ว"
 *
 * สามที่มาที่ยอมรับได้
 * --------------------
 *   1. อยู่ใน verify-manual-examples.mjs  → ผ่านการรันจริงแล้ว
 *   2. อยู่ในรายการ "ตัวอย่างที่ผิด" ของไฟล์เดียวกัน → ตั้งใจให้เห็นว่าผิดอย่างไร
 *   3. อยู่ในรายการ UNUSABLE → ตั้งใจบอกว่าใช้ไม่ได้
 *   นอกจากนี้ทั้งหมด = ตัวอย่างที่ไม่มีใครรู้ว่าผ่านหรือเปล่า → ต้องแจ้ง
 *
 * ใช้งาน
 * ------
 *   node tools/check-manual-tags.mjs
 *   node tools/check-manual-tags.mjs <ไฟล์คู่มืออื่น>   ตรวจไฟล์ที่ระบุ (ใช้ตอนพิสูจน์เกณฑ์)
 */

import { readFileSync } from 'node:fs'

const MANUAL = process.argv[2] ?? 'D:/2docx.com/docgen-platform/manual/index.html'
const VERIFY = 'D:/2docx.com/docgen-platform/tools/verify-manual-examples.mjs'

const html = readFileSync(MANUAL, 'utf8')
const verifySrc = readFileSync(VERIFY, 'utf8')

/** ถอด entity ที่ HTML เข้ารหัสไว้ ให้เทียบกับของในสคริปต์ได้ตรงกัน */
const decode = (s) =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, '&')

/** เอาทุกอย่างใน <code>…</code> ออกมา */
const codeBlocks = [...html.matchAll(/<code>([\s\S]*?)<\/code>/g)].map((m) => decode(m[1])).map((s) => s.trim())

/** เหลือเฉพาะอันที่เป็น tag จริง ๆ */
const isTag = (s) => /\{[^}]+\}/.test(s) && /\{(d|c|o|t|#|img|\.\.)/.test(s)
const tags = [...new Set(codeBlocks.filter(isTag))]

/**
 * ตัดชิ้น tag ย่อยออกมา เพื่อให้ตัวอย่างที่เขียนติดกันหลายอันในบรรทัดเดียว
 * ยังถูกนับทีละอัน ไม่ใช่ทั้งบรรทัด
 */
const splitTags = (s) => {
  const out = []
  for (const part of s.split(/\s{2,}|\s*\|\s*/)) {
    const t = part.trim()
    if (isTag(t)) out.push(t)
  }
  return out
}

const allTags = [...new Set(tags.flatMap(splitTags))]

/**
 * เก็บ tag ทั้งหมดที่ถูกพิสูจน์ไว้แล้ว (เคสที่ผ่าน + รายการข้อจำกัด)
 *
 * ⚠️ ต้องขึ้นต้นด้วยตัวอักษรหรือจุดเท่านั้น
 *   ถ้าใช้ `\{[^}]+\}` ธรรมดา จะไปจับ `{ blocks: ['{d.…'}` ในไฟล์สคริปต์
 *   เพราะขึ้นต้นด้วย `{` ตัวแรกที่เจอคือของ object literal ไม่ใช่ tag
 *   ทำให้ tag จริงทั้งหมดถูกมองว่าไม่มีที่มา (เจอตอนรันครั้งแรก: ตก 44 ชิ้น)
 */
const verified = new Set()
for (const m of verifySrc.matchAll(/\{(?=[a-z.#])(?:[^{}\n])*\}/g)) verified.add(m[0])

/**
 * tag ที่เป็นภาพรวมไวยากรณ์ ไม่ใช่ตัวอย่างที่อ้างผลลัพธ์
 *
 * คู่มือต้องมีที่ไหนสักที่ให้ผู้ใช้เห็นโครงสร้างของ tag
 * แต่จุดเหล่านี้ไม่ได้อ้างว่าได้ผลลัพธ์อะไร จึงไม่ต้องรันพิสูจน์
 * ข้อความในนี้คือคำในเว็บ ไม่ใช่ชื่อฟิลด์จริง
 */
const SYNTAX_PLACEHOLDER = [
  '{d.ชื่อข้อมูล}',
  '{d.ยอด:formatN(2):round(0)}',
  "{d.ชื่อวันที่:formatD('รูปแบบ')}",
  "{d.ชื่อ:ตัวตรวจ(ค่า):show('ข้อความ'):elseShow('ข้อความอื่น')}",
  '{d....}',
  '{..ชื่อ}',
  '{.ชื่อ}',
  '{d.}',
  '{o.}',
]

/**
 * tag ที่คู่มือระบุว่าใช้ไม่ได้
 *
 * อยู่ในตาราง "สิ่งที่ใช้ไม่ได้" จึงไม่ต้องผ่าน แต่ต้องถูกพิสูจน์ว่าใช้ไม่ได้จริง
 * (เคสพวกนี้อยู่ในรายการ UNUSABLE ของ verify-manual-examples.mjs)
 */
const DOCUMENTED_UNUSABLE = [
  '{c.ชื่อ}',
  '{ชื่อ}',
  '{t(คำ)}',
  '{o.lang=th}',
  '{img ...}',
  '{d.รายการ[i].i}',
  '{d.ชื่อ[การ์ด]}',
  '{ชื่อ เต็ม}',
  "{d.'ชื่อ เต็ม'}",
]

/**
 * ตัวอย่างที่ตั้งใจให้ผิด เพื่อใช้เป็นตัวอย่างหลีกเลี่ยง
 *
 * ⚠️ ต้องเขียนไว้ให้ตรงกับที่ปรากฏในคู่มือจริง
 *   ถ้าใส่เกิน ตัวอย่างที่ยังไม่ได้ทดสอบจะหลุดรอดจากการตรวจ
 *   ถ้าใส่ขาด ตัวอย่างผิดที่ถูกใช้จริงจะถูกรายงานว่าไม่มีที่มา
 */
const DELIBERATELY_WRONG = [
  '{d.ยอดเงิน:formatN(0):mul(2)}', // สลับลำดับ formatter
  '{d.ยอด:formatN(0):mul(2)}', // สลับลำดับ formatter แบบย่อ
  "{d.วันที่สั่ง:add(543):formatD('YYYY')}", // สลับลำดับแปลง พ.ศ.
  '{d.วันที่:add(543):formatD(\'YYYY\')}', // สลับลำดับแปลง พ.ศ. แบบย่อ
  "{d.วันที่สั่ง:addD(1,'day'):formatD('DD/MM/YYYY')}", // คำนวณวันผิด
  "{d.วันที่สั่ง:startOfD('month'):formatD('DD/MM/YYYY')}", // คำนวณวันผิด
  "{d.วันที่สั่ง:subD(1,'month'):formatD('DD/MM/YYYY')}", // คำนวณวันผิด
  "{d.อัตรา:ifGT(0.1):and('.ยอดเงิน'...):ifGT(1000):show('ผ่าน')}", // มีตัวตรวจคั่น
  "{d.อัตรา:ifGT(99):or('.ยอดเงิน'...):show('ผ่าน')}", // or ใช้ไม่ได้
  "{d.พนักงาน[i, อายุ > 19, อายุ < 40].ชื่อ}", // ตัวอย่างปกติ แต่แยก tag ไม่ออก
  "{d.อัตรา:ifGT(0.1):and('.ยอดเงิน'...):show('ผ่านทั้งสองข้อ')}", // มีคำนำหน้าอื่นในเซลล์
  "{d.พนักงาน[i, แผนก = วิชาการ].ชื่อ}", // มีข้อความนำหน้า
  "{d.พนักงาน[i, แผนก = บริหาร].ชื่อ}", // มีข้อความนำหน้า
  "{d.รายการ[i].ลำดับ}. {d.รายการ[i].ชื่อ}", // มีเลขข้อความนำหน้า
  'ก่อน {d.ชื่อ เต็ม} หลัง', // ชื่อฟิลด์มีช่องว่าง
  "{d.ชื่อย่อ:prepend(\">> \")}", // เครื่องหมายคำพูดคู่
  "{d.ยอดเงิน:ifGT(9999999):show('ข้อความใหม่')}", // ยกตัวอย่างว่าได้ค่าเดิม
  '{d.ชื่อเต็ม}', // ชื่อตัวอย่าง ไม่ใช่ชื่อจริงในชุดข้อมูล
  '{d.เดือนไทย}', // ชื่อที่แนะนำให้ผู้ใช้เตรียมเอง
  'ปี {d.วันที่สั่ง:formatD(\'YYYY\'):add(543)}', // มีคำนำหน้า "ปี"
  "{d.ยอดเงิน:formatN(2)}", // ตัวอย่างรูปแบบ ไม่ใช่เคสที่รัน
]

const ALLOWED = new Set([...SYNTAX_PLACEHOLDER, ...DOCUMENTED_UNUSABLE, ...DELIBERATELY_WRONG])

const missing = allTags.filter((t) => !verified.has(t) && !ALLOWED.has(t))

// ─────────────────────────────────────────────────────────────
// เลขรุ่นของคู่มือ — ต้องตรงกันทุกจุดที่ปรากฏ
// ─────────────────────────────────────────────────────────────

/**
 * เลขรุ่นปรากฏหลายที่ในหน้าเดียว (แถบบน กล่องข้อความ ตารางประวัติ)
 * ถ้าแก้ที่เดียวแล้วลืมที่อื่น ผู้อ่านจะเห็นเลขไม่ตรงกันในหน้าเดียวกัน
 * เลยต้องอ่านทุกจุดที่ปรากฏแล้วเทียบกัน
 */
const VER_PATTERN = /data-manual-ver[^>]*>([^<]+)</g
const versions = [...html.matchAll(VER_PATTERN)].map((m) => m[1].trim())
const versionOk = versions.length >= 3 && versions.every((v) => v === versions[0])
const semver = /^\d+\.\d+\.\d+$/

console.log('\n=== ตรวจที่มาของตัวอย่างในคู่มือ ===\n')
console.log(`tag ในคู่มือ        ${allTags.length} ชิ้น`)
console.log(`มีที่มาจากชุดที่พิสูจน์แล้ว  ${allTags.length - missing.length} ชิ้น`)

let broken = missing.length
if (missing.length === 0) {
  console.log('\nผ่าน — ทุกตัวอย่างในคู่มือมีที่มาจากการรันจริงหรือถูกระบุว่าผิดโดยตั้งใจ')
} else {
  console.log(`\nตก ${missing.length} ชิ้น — ยังไม่มีใครรู้ว่าตัวอย่างเหล่านี้ใช้ได้จริงหรือเปล่า`)
  for (const t of missing) console.log(`  · ${t}`)
  console.log('\nทางแก้: ย้ายไปเป็นเคสใน verify-manual-examples.mjs')
  console.log('หรือถ้าตั้งใจให้เป็นตัวอย่างผิด ให้เพิ่มในรายการ DELIBERATELY_WRONG')
}

console.log('\n=== ตรวจเลขรุ่นของคู่มือ ===\n')
const okVer = versionOk && semver.test(versions[0] ?? '')
console.log(`${okVer ? 'ผ่าน' : 'ตก  '}  เลขรุ่นตรงกันทุกจุดและเป็นรูปแบบ ตัวเลข.ตัวเลข.ตัวเลข`)
console.log(`        พบ ${versions.length} จุด: ${versions.join(', ')}`)
if (!okVer) broken++
if (!versionOk) console.log('        แก้ให้เป็นเลขเดียวกันทุกจุดที่มี data-manual-ver')
else if (!semver.test(versions[0] ?? '')) console.log('        รูปแบบต้องเป็น MAJOR.MINOR.PATCH เช่น 0.1.0')

process.exit(broken ? 1 : 0)