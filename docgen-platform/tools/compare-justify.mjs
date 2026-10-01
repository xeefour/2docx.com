/**
 * เทียบการกระจายย่อหน้าของแม่แบบที่คล้ายกัน ด้วยเนื้อหายาวพอให้เห็นผลจริง
 *
 * ปัญหาที่เจอ: การวัดรอบก่อนใช้ข้อความสั้นจนได้แค่ 2 บรรทัด
 * → บรรทัดแรกถูกยืดเต็ม บรรทัดที่สองเป็นบรรทัดสุดท้าย (ไม่ยืดตามหลัก)
 * → ผลลัพธ์จึงดูเหมือนกันหมด ต่างกันแค่ ~11 จุด มองไม่ออก
 *
 * รอบนี้ใช้เนื้อหายาว 4+ บรรทัด ซึ่งแยก "กระจาย" กับ "ชิดซ้าย" ออกได้ชัดเจน
 * เพราะบรรทัดกลาง ๆ ต้องยืดเต็มขอบขวาทั้งหมด
 *
 *   node --env-file=.env tools/compare-justify.mjs
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

const API = process.env.DOCSERVER_URL
const H = { Authorization: `Bearer ${process.env.DOCSERVER_API_KEY}`, 'carbone-version': '5' }
const HJSON = { ...H, 'Content-Type': 'application/json' }
const OUT = 'D:/2docx.com/tests/part-09-thai-distribute/output-justify'

/** เนื้อหายาวพอจะได้ 4-5 บรรทัด — ยิ่งยาวยิ่งเห็นชัดว่ากระจายหรือไม่ */
const DATA = {
  เรื่อง: 'ขออนุญาตไปราชการและรายงานผลการดำเนินการตามคำสั่งของอำเภอเนินมะปราง',
  เรียน: 'พนักงานอัยการจังหวัดนครราชสีมา',
  ชื่อ: 'นายสมชาย ใจดี',
  ที่อยู่: '123 หมู่ 4 ตำบลบ้านโคก อำเภอเนินมะปราง จังหวัดนครราชสีมา',
  เนื้อหา:
    'ด้วยข้าพเจ้า นายธีระศักดิ์ พยุหกฤษ ตำแหน่งปลัดอำเภอฝ่ายอนุรักษ์ทรัพยากรธรรมชาติ ' +
    'จึงขอรายงานความเห็นของหน่วยงานที่ได้รับมอบหมายในการดำเนินการพิจารณาเรื่องนี้ ว่า ' +
    'สนับสนุนในการอนุญัติเงินไปใช้จ่ายในการดำเนินการตามแผนงานที่ได้รับความเห็นชอบ ' +
    'และให้รับรองว่าการดำเนินการดังกล่าวอยู่ในอำนาจหน้าที่ พร้อมทั้งได้ดำเนินการตรวจสอบ ' +
    'สิ่งแวดล้อมและพิจารณาความเหมาะสมของโครงการเรียบร้อยแล้ว',
  สิ่งที่แนบ: 'สำเนาหนังสือรายงานผลการดำเนินการจำนวน 1 ฉบับ',
  ที่: 'ชม.0511.01/1234',
  เลขที่หนังสือ: '1234',
  อำเภอ: 'เนินมะปราง',
  ชื่อเจ้าหน้าที่: 'นายสมชาย ใจดี',
  ตำแหน่ง: 'นายอำเภอ',
}

mkdirSync(OUT, { recursive: true })

const list = (await (await fetch(`${API}/templates`, { headers: H })).json()).data ?? []

console.log('กำลังเรนเดอร์ PDF ด้วยเนื้อหายาว 4+ บรรทัด…\n')

const rows = []

for (const key of ['สำเนา 1', 'สำเนา 2', 'สำเนา 3', 'อัยการ']) {
  const t = list.find((x) => x.id && x.name?.includes(key))
  if (!t) {
    console.log(`⏭  ไม่เจอ "${key}"`)
    continue
  }

  // เรนเดอร์เป็น docx ก่อน (คง thaiDistribute) แล้วแก้เป็น both แบบเดียวกับที่ worker ทำ
  const r1 = await fetch(`${API}/render/${t.versionId}`, {
    method: 'POST',
    headers: HJSON,
    body: JSON.stringify({ data: DATA, convertTo: 'docx' }),
  })
  const j1 = await r1.json()
  if (!j1.success) throw new Error(JSON.stringify(j1).slice(0, 150))
  const docx = Buffer.from(
    await (await fetch(`${API}/render/${j1.data.renderId}`, { headers: H })).arrayBuffer(),
  )

  const { normalizeThaiAlignment } = await import('../packages/shared/src/normalize.ts')
  const { buf: patched, result } = normalizeThaiAlignment(docx)

  const r2 = await fetch(`${API}/render/template?download=true`, {
    method: 'POST',
    headers: HJSON,
    body: JSON.stringify({ template: patched.toString('base64'), data: {}, convertTo: 'pdf' }),
  })
  const pdf = Buffer.from(await r2.arrayBuffer())

  const file = `${OUT}/${key.replace(/[^\w฀-๿]+/g, '_')}.pdf`
  writeFileSync(file, pdf)

  // หน้าแรกเป็น PNG เพื่อดูด้วยตา — ให้ Python เขียนเอง (stdout มี warning ปน อย่าเอามาทับไฟล์)
  const png = `${OUT}/${key.replace(/[^\w฀-๿]+/g, '_')}.png`
  execFileSync('python', [
    '-c',
    `import pymupdf as fitz;d=fitz.open(r"${file}");d[0].get_pixmap(dpi=110).save(r"${png}")`,
  ])

  rows.push({ key, file, replaced: result.replaced, bytes: pdf.length })
  console.log(
    `✅ ${t.name}\n   แก้ตอนส่งออก: ${JSON.stringify(result.replaced) || '(ไม่มีค่าที่ต้องแก้)'}\n   → ${file}\n`,
  )
}

console.log('='.repeat(64))
console.log('ผลวัด (ระยะเหลือขวาเฉลี่ย — ยิ่งใกล้ 0 ยิ่งกระจาย):')
for (const r of rows) {
  const out = execFileSync('python', [
    'D:/2docx.com/tests/part-09-thai-distribute/measure_align.py',
    r.file,
    r.key,
  ]).toString()
  const full = out.match(/บรรทัดที่ยืดเต็มขอบขวา: (\d+)/)?.[1]
  const avg = out.match(/ระยะเหลือขวาเฉลี่ย: ([\d.-]+)/)?.[1]
  const patched = Object.keys(r.replaced).length ? 'แก้แล้ว' : '⚠ ไม่ได้แก้'
  console.log(`  ${r.key.padEnd(10)} เต็มขอบขวา ${full} บรรทัด · เหลือขวาเฉลี่ย ${avg} จุด   [${patched}]`)
}
