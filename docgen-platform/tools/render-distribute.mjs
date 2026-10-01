/**
 * เรนเดอร์แม่แบบที่แก้การจัดย่อหน้าแล้ว → PDF + ดึงขอบกระดาษจริงจากไฟล์
 *
 * ใช้คู่กับ tests/part-09-thai-distribute/measure_align.py เพื่อพิสูจน์ว่า
 * `thaiDistribute → both` ให้ผลกระจายจริงในเอกสารราชการของเรา ไม่ใช่แค่ผลทดลอง
 * ในเอกสารสังเคราะห์
 *
 * ขอบกระดาษดึงจาก `w:pgMar` ใน docx (หน่วย twips) แล้วแปลงเป็น ซม.
 * ไม่เดาแบบตายตัว เพราะแม่แบบแต่ละฉบับขอบไม่เท่ากัน
 *
 *   node --env-file=.env tools/render-distribute.mjs
 *   node --env-file=.env tools/render-distribute.mjs --baseline
 *
 * `--baseline` = เรนเดอร์ไฟล์**ต้นฉบับจาก backup** (ยังมี thaiDistribute) เพื่อเทียบ
 *   อัปโหลดแบบไม่เปิด versioning ซึ่ง Carbone จะคืน `templateId` = hash ของไฟล์เดิม
 *   → ไม่สร้างไฟล์ใหม่ และ**ห้ามลบ** เพราะจะเป็นการลบต้นฉบับจริง
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { readFileSync } from 'node:fs'
import { unzipSync, strFromU8 } from 'fflate'

const API = process.env.DOCSERVER_URL
const H = { Authorization: `Bearer ${process.env.DOCSERVER_API_KEY}`, 'carbone-version': '5' }
const HJSON = { ...H, 'Content-Type': 'application/json' }
const OUT = 'D:/2docx.com/tests/part-09-thai-distribute/output-templates'
const BACKUP = 'D:/2docx.com/docserver-backup-20260930/template'
const BASELINE = process.argv.includes('--baseline')

/** ข้อมูลตัวอย่างให้พอยืดเต็มบรรทัด — วัดการกระจายต้องมีเนื้อหายาวพอ */
const DATA = {
  เรื่อง: 'ขออนุญาตไปราชการและรายงานผลการดำเนินการตามคำสั่งของอำเภอเนินมะปราง',
  เรียน: 'พนักงานอัยการจังหวัดนครราชสีมา',
  ชื่อ: 'นายสมชาย ใจดี',
  ที่อยู่: '123 หมู่ 4 ตำบลบ้านโคก อำเภอเนินมะปราง จังหวัดนครราชสีมา',
  เนื้อหา:
    'ด้วยข้าพเจ้า นายสมชาย ใจดี ตำแหน่งนายอำเภอเนินมะปราง จังหวัดนครราชสีมา ' +
    'เห็นว่าควรดำเนินการเรื่องนี้เพื่อให้เป็นไปตามระเบียบและคำสั่งที่เกี่ยวข้อง จึงเรียนมาเพื่อพิจารณาดังต่อไปนี้',
  สิ่งที่แนบ: 'สำเนาหนังสือรายงานผลการดำเนินการจำนวน 1 ฉบับ',
  ที่: 'ชม.0511.01/1234',
  เลขที่หนังสือ: '1234',
  อำเภอ: 'เนินมะปราง',
  ชื่อเจ้าหน้าที่: 'นายสมชาย ใจดี',
  ตำแหน่ง: 'นายอำเภอ',
}

/** อ่านขอบกระดาษซ้าย/ขวา (cm) จาก w:pgMar — twips → cm (1 twip = 1/1440 นิ้ว) */
function pageMargins(docx) {
  const files = unzipSync(new Uint8Array(docx))
  const xml = strFromU8(files['word/document.xml'])
  const sect = xml.match(/<w:pgMar\b[^>]*>/)?.[0]
  if (!sect) return null
  const num = (k) => {
    const v = Number(sect.match(new RegExp(`w:${k}="(-?\\d+)"`))?.[1])
    return Number.isFinite(v) ? Math.abs(v) / 1440 * 2.54 : null
  }
  return { left: num('left'), right: num('right') }
}

async function render(versionId) {
  const r = await fetch(`${API}/render/${versionId}`, {
    method: 'POST',
    headers: HJSON,
    body: JSON.stringify({ data: DATA, convertTo: 'pdf' }),
  })
  const j = await r.json()
  if (!j.success) throw new Error(`เรนเดอร์ไม่สำเร็จ: ${JSON.stringify(j).slice(0, 200)}`)
  const dl = await fetch(`${API}/render/${j.data.renderId}`, { headers: H })
  return Buffer.from(await dl.arrayBuffer())
}

mkdirSync(OUT, { recursive: true })

// เฉพาะที่แก้ thaiDistribute → both รอบนี้
// ⚠️ `file` = ชื่อไฟล์ใน backup · `sha` = hash ของ**เนื้อหา** (คนละอันกับชื่อไฟล์ใน 1 รายการ)
const TARGETS = [
  { key: 'สำเนา 1', sha: '555288e5fc99572e131039402d4d79c09ee06fedf7d232f0363b4f88439780f8' },
  { key: 'สำเนา 2', sha: '9aa9bbcdca69b2a2b7ea28702b9bc4d6f736872f1b0f17f587957ad4e98e8172' },
  { key: 'สำเนา 3', sha: '9caa0c73d29b473cb6d2585dd3cb6719125d5694e94da7f4410ac313b4f9afcc' },
  {
    key: 'อัยการ',
    sha: '6011892addbd4545daef654524a4a4b0d48e2c06c0830705ceb51839b28d9c3e',
    file: 'c7b138d52c776cfb69f9e845b87f0e525b95bbd27eb51bf93f4b49ff047849a7',
  },
]

/**
 * ⚠️ baseline ต้องเรนเดอร์ด้วย content hash ตรง ๆ ห้ามอัปโหลดซ้ำ
 *
 * ไฟล์ต้นฉบับยังอยู่ใน /app/template อยู่แล้ว (Carbone เก็บแบบ content-addressed
 * การอัปโหลดเวอร์ชันใหม่ไม่ได้ทับไฟล์เก่า) → เรนเดอร์ด้วย hash ได้เลย
 *
 * เคยเพิ่ม `POST /template` เพื่อขอ id แล้วผลวัดผิด (ได้ผลของเวอร์ชันใหม่แทนของเก่า)
 * แถมการ DELETE ตามมาจะเป็นการลบ**ต้นฉบับจริง** ออกจาก /app/template ทันที
 */

const list = BASELINE ? [] : (await (await fetch(`${API}/templates`, { headers: H })).json()).data ?? []
const manifest = []

for (const { key, sha, file: backupFile } of TARGETS) {
  const t = BASELINE ? null : list.find((x) => x.id && x.name?.includes(key))
  if (!BASELINE && !t) {
    console.log(`⏭  ไม่เจอ "${key}"`)
    continue
  }

  let docx
  let versionId

  if (BASELINE) {
    // ไฟล์ต้นฉบับ — ยังมี thaiDistribute ตามที่ผู้ใช้ทำไว้ใน Word
    docx = readFileSync(`${BACKUP}/${backupFile ?? sha}`)
    versionId = sha
  } else {
    const dl = await fetch(`${API}/template/${t.versionId}`, { headers: H })
    docx = Buffer.from(await dl.arrayBuffer())
    versionId = t.versionId
  }

  const margins = pageMargins(docx)
  const pdf = await render(versionId)
  const suffix = BASELINE ? '.ก่อนแก้' : '.แก้แล้ว'
  const file = `${OUT}/${key.replace(/[^\w฀-๿]+/g, '_')}${suffix}.pdf`
  writeFileSync(file, pdf)

  manifest.push({ key, name: t?.name ?? `${key} (ต้นฉบับ)`, versionId, file, margins })
  console.log(
    `✅ ${t?.name ?? key} ${BASELINE ? '[ก่อนแก้]' : ''}\n   ${pdf.length.toLocaleString()} bytes · ขอบซ้าย ${margins?.left?.toFixed(2)} ซม. · ขอบขวา ${margins?.right?.toFixed(2)} ซม.\n   → ${file}\n`,
  )
}

const outName = BASELINE ? 'manifest-baseline.json' : 'manifest.json'
writeFileSync(`${OUT}/${outName}`, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
console.log(`บันทึก manifest: ${OUT}/${outName} (${manifest.length} รายการ)`)
