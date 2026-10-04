/**
 * checkbox ที่ไม่ได้ติ๊ก ต้องไม่พิมพ์คำว่า "false" ลงในเอกสาร
 *
 *   node --env-file=.env node_modules/tsx/dist/cli.mjs tools/test-checkbox-false.mts
 *
 * ── บั๊กที่เจอ ──────────────────────────────────────────────────────
 * ช่อง checkbox ในฟอร์มเก็บค่าเป็น boolean เสมอ (`sampleValueFor` คืน `false`
 * และ `FormFields.tsx` ใช้ `checked={value === true}`)
 * แต่ Carbone 5 พิมพ์ boolean `false` ออกมาเป็น **คำว่า "false"** ตรง ๆ
 * ผู้ใช้ที่เขียนแม่แบบตามคู่มือ (`ifEQ(true):show()`) จะเจอคำว่านี้โผล่มา
 * ทุกครั้งที่ไม่ได้ติ๊กกล่อง — แก้เองไม่ได้
 *
 * ── ทำไมต้องเทสต์ 3 ชั้น ไม่ใช่ชั้นเดียว ─────────────────────────────
 * 1. ตัวแก้ (`normalizeCarboneData`) — ตรวจว่าแปลงถูกตัว ไม่แตะของอื่น
 * 2. docserver จริง — พิสูจน์ว่าการแปลงนั้น**เปลี่ยนผลลัพธ์ในไฟล์จริง**
 *    ไม่ใช่แค่ทฤษฎีว่า Carbone ควรจะซ่อน
 * 3. การต่อสายใน worker — เทสต์ชั้น 1 ผ่านเสมอแม้ไม่ได้เรียกใช้จริง
 *    (เคยเจอเกณฑ์ที่ผ่านทั้งที่โค้ดพังในรอบ UX) จึงต้องตรวจว่า
 *    `renderDocument` เรียกตัวแก้ก่อนยิง Carbone จริง
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { unzipSync, strFromU8 } from 'fflate'
import { normalizeCarboneData } from '../packages/shared/src/index.js'

const SAMPLE = 'D:/2docx.com/docgen-platform/apps/web/public/sample-template.docx'
const WORKER = 'D:/2docx.com/docgen-platform/apps/worker/src/docserver.ts'
const OUT = 'D:/2docx.com/docgen-platform/tests/nav-status/output-checkbox-false'
mkdirSync(OUT, { recursive: true })

let pass = 0
let fail = 0
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`)
  ok ? pass++ : fail++
}

// ── [1] ตัวแก้แปลงถูกตัว และไม่ไปแตะค่าอื่น ───────────────────────
console.log('\n[1] normalizeCarboneData — false เป็น "" แต่ที่เหลืออยู่ครบ')
{
  const input = {
    ติดตาม: false,
    เปิดใช้งาน: true,
    ชื่อ: 'สมชาย',
    จำนวน: 0,
    ว่าง: '',
    ไม่มีค่า: null,
    รายการ: [{ เลือก: false }, { เลือก: true }],
    ซ้อน: { ชั้น: { ลึก: false } },
  }
  const before = structuredClone(input)
  const { data, result } = normalizeCarboneData(input as Record<string, unknown>)

  check('false ระดับบนเป็น ""', data.ติดตาม === '')
  check('true ยังเป็น true (แม่แบบต้องใช้ ifEQ(true))', data.เปิดใช้งาน === true)
  check('false ในอาร์เรย์ของ object ถูกแปลง', (data.รายการ as any[])[0].เลือก === '')
  check('true ในอาร์เรย์ยังเป็น true', (data.รายการ as any[])[1].เลือก === true)
  check('false ใน object ซ้อนชั้นถูกแปลง', (data.ซ้อน as any).ชั้น.ลึก === '')
  check('0 ไม่ถูกแตะ (0 มีความหมายต่างจากค่าว่าง)', data.จำนวน === 0)
  check("'' ไม่ถูกแตะ", data.ว่าง === '')
  check('null ไม่ถูกแตะ', data.ไม่มีค่า === null)
  check('ชื่อยังเป็นชื่อเดิม', data.ชื่อ === 'สมชาย')
  check('นับจุดที่แปลงได้ถูก', result.converted === 3, `${result.converted} จุด`)
  check('รายงานพาธไว้ให้ดูใน log', result.paths.includes('ซ้อน.ชั้น.ลึก'), result.paths.join(' · '))
  check('ไม่แก้ต้นฉบับที่ส่งเข้ามา (Mongo/พรีวิวใช้ต่อ)', JSON.stringify(input) === JSON.stringify(before))
}
{
  const { data, result } = normalizeCarboneData({ ว่างล้วน: '', ปกติ: 1 })
  check('ไม่มี false เลย → คืนค่าเดิมและไม่ตั้ง changed', result.changed === false && (data.ว่างล้วน === ''))
}
{
  const d = new Date(0)
  const { data } = normalizeCarboneData({ เมื่อ: d })
  check('ไม่แปลง Date เป็นวัตถุเปล่า', data.เมื่อ === d)
}
{
  // ข้อมูลที่อ้างถึงตัวเอง — ต้องไม่วนไม่รู้จบ
  const loop: Record<string, unknown> = { ติ๊ก: false }
  loop.ตัวเอง = loop
  const { data, result } = normalizeCarboneData(loop)
  check('ข้อมูลอ้างถึงตัวเองไม่ทำให้ค้าง', result.converted === 1 && (data as any).ติ๊ก === '')
}

// ── [2] docserver จริง — การแปลงเปลี่ยนผลลัพธ์จริงไหม ──────────────
console.log('\n[2] docserver 5.15.2 จริง — ค่า false ดิบพิมพ์คำว่า "false" จริงหรือเปล่า')
const base = (process.env.DOCSERVER_URL ?? 'http://127.0.0.1:4000').replace(/\/$/, '')
const H = {
  Authorization: `Bearer ${process.env.DOCSERVER_API_KEY}`,
  'carbone-version': '5',
  'Content-Type': 'application/json',
}
const sample = readFileSync(SAMPLE)

/** ค่าจากฟอร์มจริงตอนผู้ใช้ไม่ได้ติ๊กกล่อง = boolean `false` */
const FORM_DATA = {
  เลขที่: 'บธ.1234/2568',
  วันที่: '2026-10-04T00:00:00.000Z',
  เรื่อง: 'ทดสอบ checkbox',
  ผู้รับ: 'ผู้รับ',
  เนื้อหา: 'เนื้อหา',
  ชื่อผู้ลงนาม: 'ผู้ลงนาม',
  ตำแหน่ง: 'ตำแหน่ง',
  ชั่วเรื่อง: false,
  รายการ: ['สำเนา'],
}

const render = async (data: Record<string, unknown>, tag: string) => {
  const res = await fetch(`${base}/render/template?download=true`, {
    method: 'POST',
    headers: H,
    body: JSON.stringify({ template: sample.toString('base64'), data, convertTo: 'docx' }),
    signal: AbortSignal.timeout(90_000),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status} ${(await res.text()).slice(0, 200)}`)
  const out = Buffer.from(await res.arrayBuffer())
  writeFileSync(`${OUT}/${tag}.docx`, out)
  const doc = strFromU8(unzipSync(new Uint8Array(out))['word/document.xml'] ?? new Uint8Array())
  return [...doc.matchAll(/<w:p[ >][\s\S]*?<\/w:p>/g)].map((m) =>
    [...m[0].matchAll(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g)].map((t) => t[1]).join(''),
  )
}

try {
  // ก่อนแก้: ส่ง `false` ดิบ ๆ ตามที่ Mongo เก็บจริง
  const beforeParas = await render(FORM_DATA, 'before-false-raw')
  const beforeLeak = beforeParas.some((p) => p.trim() === 'false')
  check('ยืนยันบั๊กเดิม: ส่ง false ดิบแล้วคำว่า "false" โผล่ในเอกสาร', beforeLeak)

  // หลังแก้: ผ่านตัวแก้ก่อน
  const { data: fixed } = normalizeCarboneData(FORM_DATA as Record<string, unknown>)
  const afterParas = await render(fixed as Record<string, unknown>, 'after-normalized')
  const afterLeak = afterParas.some((p) => p.trim() === 'false')
  check('หลังแก้: ไม่เหลือคำว่า "false" ในเอกสาร', !afterLeak, afterLeak ? 'ยังรั่วอยู่' : 'สะอาด')
  check('ข้อความใน show() ยังซ่อนอยู่เหมือนเดิม', !afterParas.some((p) => p.includes('ด้วยความปรารถนาดี')))
  check('เอกสารยังเรนเดอร์ครบ ไม่พังจากการแปลงค่า', afterParas.some((p) => p.includes('ทดสอบ checkbox')))
} catch (e) {
  check('เรนเดอร์ผ่าน docserver', false, String((e as Error)?.message ?? e))
}

// ── [3] การต่อสาย: worker ต้องเรียกตัวแก้ก่อนยิง Carbone จริง ──────
console.log('\n[3] ต่อสายเข้า worker แล้วจริง — ไม่ใช่แค่มีฟังก์ชันที่ผ่านเทสต์')
{
  const src = readFileSync(WORKER, 'utf8')
  const call = src.indexOf('normalizeCarboneData(')
  // ต้องการ "จุดเรียก" ไม่ใช่ "ที่ประกาศฟังก์ชัน" (ของประกาศอยู่บนสุดของไฟล์เสมอ
  // ถ้านับผิดจุด เกณฑ์นี้จะผ่านตลอดแม้เรียกผิดลำดับจริง)
  const send = src.indexOf('renderToBuffer(templateId')
  check('worker เรียก normalizeCarboneData', call !== -1)
  check('เรียกก่อนยิง Carbone', call !== -1 && send !== -1 && call < send, `เรียกที่ ${call} · ยิงที่ ${send}`)
  check('ใช้ค่าที่แปลงแล้วส่งต่อ (ไม่ใช้ตัวดิบ)', /renderToBuffer\(templateId, \{ data,/.test(src))
  check('ค่าใน Mongo ไม่ถูกแก้ (แยกชื่อ rawData)', /data: rawData/.test(src))
}

console.log(`\n── ผ่าน ${pass} · ไม่ผ่าน ${fail} ─────────────────────`)
console.log(`ไฟล์ที่เรนเดอร์ไว้เทียบ: ${OUT}`)
process.exit(fail === 0 ? 0 : 1)
