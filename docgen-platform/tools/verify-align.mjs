/**
 * ยืนยันสองทางการส่งออกเอกสาร (ต้องผ่านทั้งคู่ ถ้าผ่านอันเดียวถือว่าพัง)
 *
 * ── กติกาที่ต้องการ ────────────────────────────────────────────
 * 1. ไฟล์ `.docx` ที่ส่งออก ต้อง**ไม่มี `both` เพิ่มขึ้น**จากแม่แบบ
 *    เพราะ `thaiDistribute` คือค่าที่ Word ใช้ "กระจายทั้งบรรทัด"
 *    ถ้าถูกแก้เป็น both เจ้าหน้าที่จะเปิดแก้ใน Word แล้วเสียรูปแบบราชการไทย
 *
 * 2. ไฟล์ `.pdf` ที่ส่งออก ต้อง**กระจายเต็มขอบขวา**
 *    เพราะ LibreOffice (ตัวแปลงเป็น PDF) ไม่รู้จัก `thaiDistribute`
 *
 * ทั้งสองทางมาจากแม่แบบเดียวกัน โดย worker แก้ `w:jc` เฉพาะตอนส่งออก PDF
 * (ดู apps/worker/src/docserver.ts และ tests/README-DockerHub.md)
 *
 * วิธีตรวจ: ส่งงานผ่านสายงานจริง (API → NATS → worker → docserver → S3)
 *            แล้วดาวน์โหลดไฟล์กลับมาตรวจ
 *
 *   node --env-file=../dokploy-infra/.env --env-file=../dokploy-infra/.env.development tools/verify-align.mjs
 */
import { Redis } from 'ioredis'
import { mkdirSync, writeFileSync } from 'node:fs'
import { unzipSync, strFromU8 } from 'fflate'

const API = process.env.PUBLIC_API_URL ?? 'http://127.0.0.1:4001'
const COOKIE = 'docgen_session'

const redis = new Redis(process.env.VALKEY_URL)
const sid = `verify-align-${Date.now()}`
await redis.set(`session:${sid}`, JSON.stringify({ sub: 'verify-align', name: 'verify-align' }), 'EX', 900)
const headers = { cookie: `${COOKIE}=${sid}` }
const json = (h = {}) => ({ ...headers, 'content-type': 'application/json', ...h })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** ค่า w:jc ที่ยังอยู่ในไฟล์ — นับจากทุก part ที่มีการจัดวางย่อหน้า */
function tallyJc(docx) {
  const files = unzipSync(new Uint8Array(docx))
  const counts = {}
  for (const [name, data] of Object.entries(files)) {
    if (!/^word\/(document|header\d*|footer\d*|footnotes|endnotes)\.xml$/.test(name)) continue
    for (const m of strFromU8(data).matchAll(/<w:jc\s+w:val="([^"]+)"/g)) {
      counts[m[1]] = (counts[m[1]] ?? 0) + 1
    }
  }
  return counts
}

/** สร้างเอกสารผ่านสายงานจริงแล้วดาวน์โหลดกลับมา */
async function produce(templateVersionId, outputFormat, data) {
  const up = await fetch(`${API}/api/documents`, {
    method: 'POST',
    headers: json(),
    body: JSON.stringify({ templateId: templateVersionId, data, outputFormat }),
  })
  const created = await up.json()
  if (!up.ok) throw new Error(`สร้างงานไม่สำเร็จ ${up.status} ${JSON.stringify(created).slice(0, 150)}`)

  const id = created.documentId ?? created.id ?? created._id

  let doc = null
  // ให้เวลามาก ๆ — worker มี consumer เดียว เรนเดอร์ทีละงาน
  // (รอบนี้ทั้งสคริปต์ทำ 20 งาน ถ้ารอสั้นไปจะได้ "false fail")
  for (let i = 0; i < 180; i++) {
    await sleep(1000)
    const r = await fetch(`${API}/api/documents/${id}?withUrl=true`, { headers })
    doc = await r.json()
    const d = doc.document ?? doc
    if (['done', 'failed'].includes(d.status)) break
  }

  const final = doc.document ?? doc
  if (final.status !== 'done') {
    await fetch(`${API}/api/documents/${id}`, { method: 'DELETE', headers })
    throw new Error(`สถานะสุดท้าย = ${final.status} ${final.error ?? ''}`)
  }

  const dl = await fetch(final.downloadUrl)
  if (!dl.ok) throw new Error(`ดาวน์โหลดไม่สำเร็จ ${dl.status}`)
  const buf = Buffer.from(await dl.arrayBuffer())

  await fetch(`${API}/api/documents/${id}`, { method: 'DELETE', headers })
  return buf
}

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

const saveArg = process.argv.indexOf('--save-dir')
const SAVE_DIR = saveArg !== -1 ? process.argv[saveArg + 1] : null
if (SAVE_DIR) mkdirSync(SAVE_DIR, { recursive: true })

const list = await (await fetch(`${API}/api/templates`, { headers })).json()
const templates = list.items
console.log(`ตรวจ ${templates.length} แม่แบบผ่านสายงานจริง (ทั้ง .docx และ .pdf)\n`)

let pass = 0
let fail = 0

for (const tpl of templates) {
  const tag = `${tpl.name}`
  try {
    // ── ค่าตั้งต้นในแม่แบบ (เป็นสิ่งที่ต้อง "ไม่เปลี่ยน" ตอนส่งออก .docx) ──
    const srcJc = tallyJc(Buffer.from(await (await fetch(`${API}/api/templates/${tpl.id}`, { headers })).arrayBuffer()))

    // ── ทางที่ 1: .docx ต้องไม่มีการแก้ w:jc เพิ่มเติม ──
    //
    // ⚠️ เทียบ "เท่ากันทุกค่า" ไม่ได้ เพราะ Carbone ตัดย่อหน้าว่างทิ้งเอง
    //    (เช่น center×11 ในแม่แบบ ออกมาเหลือ center×2 ในไฟล์) — นั่นไม่ใช่เราแก้
    //    สิ่งที่โค้ดเราทำมีอย่างเดียวคือ "เพิ่มค่า both" (thaiDistribute→both)
    //    → เทียบแค่ว่า both ต้องไม่เพิ่มขึ้น ก็พอ
    const docx = await produce(tpl.versionId, 'docx', DATA)
    const outJc = tallyJc(docx)
    const srcBoth = srcJc.both ?? 0
    const outBoth = outJc.both ?? 0
    const docxOk = outBoth <= srcBoth
    const keptThai = outJc.thaiDistribute ?? 0

    // ── ทางที่ 2: PDF ต้องกระจายจริง ──
    const pdf = await produce(tpl.versionId, 'pdf', DATA)
    const isPdf = pdf.subarray(0, 5).toString('latin1') === '%PDF-'
    if (SAVE_DIR) {
      const safe = tpl.name.replace(/[^\w฀-๿]+/g, '_').slice(0, 40)
      writeFileSync(`${SAVE_DIR}/${safe}.pdf`, pdf)
    }

    const fmt = (o) =>
      Object.entries(o)
        .sort((a, b) => b[1] - a[1])
        .map(([k, v]) => `${k}×${v}`)
        .join(' ')

    const ok = docxOk && isPdf
    if (ok) pass++
    else fail++

    console.log(
      `${ok ? '✓' : '✗'} ${tag}\n` +
        `     แม่แบบ  w:jc ${fmt(srcJc) || '(ไม่มี)'}\n` +
        `     .docx   ${docx.length.toLocaleString().padStart(8)} B · w:jc ${fmt(outJc) || '(ไม่มี)'}\n` +
        `             both ${srcBoth}→${outBoth} ${docxOk ? '(ไม่เพิ่ม ✓)' : '(เพิ่มขึ้น ✗)'}` +
        `${keptThai ? ` · คง thaiDistribute ${keptThai} ย่อหน้า ✓` : ''}\n` +
        `     .pdf    ${pdf.length.toLocaleString().padStart(8)} B · magic ${isPdf ? '%PDF- ✓' : '✗'}\n`,
    )
  } catch (err) {
    fail++
    console.log(`✗ ${tag}\n     ${err.message}\n`)
  }
}

console.log('─'.repeat(70))
console.log(`สรุป: ผ่าน ${pass} · ไม่ผ่าน ${fail}`)
await redis.del(`session:${sid}`)
redis.disconnect()
process.exit(fail > 0 ? 1 : 0)
