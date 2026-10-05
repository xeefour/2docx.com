/**
 * ไฟล์แม่แบบตัวอย่างต้องใช้ได้จริง — ไม่ใช่แค่มีอยู่
 *
 *   node --env-file=.env node_modules/tsx/dist/cli.mjs tools/test-sample-template.mts
 *
 * ── ผู้ใช้ชี้ ──────────────────────────────────────────────────────
 * *"แม่แบบตัวอย่างที่สร้างขึ้นมามีปัญหา มีขีดสีแดงขึ้นมา
 *   ผมอยากให้ทำใหม่ เอาตัวอย่างทุกประเภทใส่ลงไป เพื่อให้ผู้ใช้เอาไปตัดสินเอง"*
 *
 * ── ทำไมต้องเทสต์ไฟล์ที่ "สร้างเอง" ─────────────────────────────────
 * ไฟล์นี้ทำด้วยสคริปต์ ไม่ได้เปิดใน Word ตรวจทุกครั้ง
 *   และเจอบั๊กจริง 4 อย่างระหว่างทำรอบนี้ ทุกอย่างทดสอบกับ docserver แล้ว:
 *   1. ขีดสีแดง = Word ตรวจสะกดไทย → ต้องมี `<w:noProof/>` ครบ**ทุก run**
 *   2. หน้า "ตัวอย่างไวยากรณ์" ในไฟล์เดียวกัน = แท็กในคำอธิบายถูก**เรียกใช้จริง**
 *      เอกสารจึงซ้ำทั้งฉบับ (วัดได้ว่าได้หนังสือ 2 เล่มในไฟล์เดียว)
 *   3. `{d.x[i]}` ต้องมี `[i+1]` ต่อท้ายในย่อหน้าถัดไป ไม่งั้นไม่ทำซ้ำให้
 *   4. ข้อความที่จะซ่อนต้องอยู่**ใน** show() ถ้าอยู่นอกจะโชว์ตลอด
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { unzipSync, strFromU8 } from 'fflate'
import { parseTagsFromDocx } from '../apps/api/src/modules/templates/tags.js'

const FILE = 'D:/2docx.com/docgen-platform/apps/web/public/sample-template.docx'
const OUT = 'D:/2docx.com/docgen-platform/tests/nav-status/output-sample-template'
mkdirSync(OUT, { recursive: true })

let pass = 0
let fail = 0
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`)
  ok ? pass++ : fail++
}

const buf = readFileSync(FILE)
const xml = strFromU8(unzipSync(new Uint8Array(buf))['word/document.xml'] ?? new Uint8Array())

console.log('\n[1] ไม่มีขีดสีแดง — ปิดการตรวจสะกดทุก run')
const runs = (xml.match(/<w:r>/g) || []).length
const noProof = (xml.match(/<w:noProof\/>/g) || []).length
check('ทุก run มี <w:noProof/>', noProof >= runs, `run ${runs} · noProof ${noProof}`)
check('บอกภาษาเป็นไทย (กัน Word เดาผิดภาษาแล้วตรวจกลับมา)', /w:val="th-TH"/.test(xml), `พบ ${(xml.match(/w:val="th-TH"/g) || []).length} จุด`)

console.log('\n[2] ตัวอ่านแท็กของระบบต้องมองเห็นครบ')
const tags = parseTagsFromDocx(buf)
const paths = new Set(tags.map((t) => t.path))
console.log('   ', [...paths].join(' · '))
for (const w of ['ผู้รับ', 'เรื่อง', 'เลขที่', 'วันที่', 'รายการ', 'ชั่วเรื่อง', 'เนื้อหา', 'ชื่อผู้ลงนาม']) {
  check(`มีช่อง ${w}`, paths.has(w))
}
check('ไม่มี alias (Carbone 5 ไม่รองรับ ถ้ามีผู้ใช้จะได้ข้อความ {…} ดิบ)', !xml.includes('รหัสเอกสาร'))

console.log('\n[3] เรนเดอร์จริงกับ docserver แล้วเอกสารต้องไม่ซ้ำ/ไม่เพี้ยน')
// ⚠️ docserver ไม่มีพอร์ต → host ยิงไม่ถึง ต้องรันจากในเครือข่าย Docker
const base = (process.env.DOCSERVER_URL ?? 'http://127.0.0.1:4000').replace(/\/$/, '')
const H = {
  Authorization: `Bearer ${process.env.DOCSERVER_API_KEY}`,
  'carbone-version': '5',
  'Content-Type': 'application/json',
}
/** ค่าจากฟอร์มจริง: ช่องติ๊กที่ไม่ได้ติ๊กมีค่าเป็น boolean `false` */
const DATA = {
  เลขที่: 'บธ.1234/2568',
  วันที่: '2026-10-04T00:00:00.000Z',
  เรื่อง: 'ตัวอย่างเรื่อง',
  ผู้รับ: 'ผู้รับ',
  เนื้อหา: 'เนื้อหาหนังสือ',
  ชื่อผู้ลงนาม: 'ชื่อผู้ลงนาม',
  ตำแหน่ง: 'ตำแหน่ง',
  ชั่วเรื่อง: '',
  รายการ: ['สำเนาเอกสาร', 'แผนที่แนบท้าย'],
}

const render = async (convertTo) => {
  const res = await fetch(`${base}/render/template?download=true`, {
    method: 'POST',
    headers: H,
    body: JSON.stringify({ template: buf.toString('base64'), data: DATA, convertTo }),
    signal: AbortSignal.timeout(90_000),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status} ${(await res.text()).slice(0, 200)}`)
  return Buffer.from(await res.arrayBuffer())
}

try {
  const out = await render('docx')
  writeFileSync(`${OUT}/sample-rendered.docx`, out)
  const doc = strFromU8(unzipSync(new Uint8Array(out))['word/document.xml'] ?? new Uint8Array())
  const paras = [...doc.matchAll(/<w:p[ >][\s\S]*?<\/w:p>/g)].map((m) =>
    [...m[0].matchAll(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g)].map((t) => t[1]).join(''),
  )
  console.log('    ผลลัพธ์:')
  paras.forEach((t, i) => console.log(`      ${String(i + 1).padStart(2)} ${t}`))

  check('เรนเดอร์ได้โดยไม่ error', true, `${out.length} ไบต์`)
  check('ไม่เหลือแท็กค้างในเอกสาร', !/\{d\./.test(doc), paras.find((p) => /\{d\./.test(p)) ?? '')
  const heads = paras.filter((p) => p.startsWith('ที่ ')).length
  check('หัวหนังสือมีครั้งเดียว (เคยได้ 2 เล่มในไฟล์เดียว)', heads === 1, `${heads} ครั้ง`)
  check(
    'บรรทัดรายการถูกทำซ้ำครบ 2 รายการ',
    paras.includes('สำเนาเอกสาร') && paras.includes('แผนที่แนบท้าย'),
    paras.slice(11, 15).join(' | '),
  )
  check(
    'หลังบล็อกทำซ้ำ ย่อหน้าถัดไปไม่หาย/ไม่ซ้ำ',
    paras.includes('ด้วยความเคารพ') && paras.includes('(ลงชื่อ)'),
  )
  check('ข้อความใน show() หายไปเมื่อไม่ได้ติ๊ก', !paras.some((p) => p.includes('ด้วยความปรารถนาดี')))
} catch (e) {
  check('เรนเดอร์ผ่าน docserver', false, String(e?.message ?? e))
}

try {
  const pdf = await render('pdf')
  writeFileSync(`${OUT}/sample.pdf`, pdf)
  check('เรนเดอร์เป็น PDF ได้ (ปุ่ม "เรนเดอร์ตัวอย่าง" ใช้เส้นทางนี้)', pdf.length > 1000, `${pdf.length} ไบต์`)
} catch (e) {
  check('เรนเดอร์เป็น PDF ได้', false, String(e?.message ?? e))
}

console.log(`\n── ผ่าน ${pass} · ไม่ผ่าน ${fail} ─────────────────────`)
console.log(`ภาพ/ไฟล์: ${OUT}`)
process.exit(fail === 0 ? 0 : 1)
