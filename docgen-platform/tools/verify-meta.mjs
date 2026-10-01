import { PDFDocument } from 'pdf-lib'
import { Redis } from 'ioredis'
import { execSync } from 'node:child_process'
import { writeFileSync, mkdirSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const API = 'http://127.0.0.1:4001'
const redis = new Redis(process.env.VALKEY_URL)
const sid = 'meta2-' + Date.now()
await redis.set(`session:${sid}`, JSON.stringify({ sub: 'meta2' }), 'EX', 300)
const headers = { cookie: `docgen_session=${sid}`, 'content-type': 'application/json' }
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

const list = await (await fetch(`${API}/api/templates`, { headers })).json()
const tpl = list.items.find(t => t.name) ?? list.items[0]

async function run(format) {
  const up = await fetch(`${API}/api/documents`, { method:'POST', headers,
    body: JSON.stringify({ templateId: tpl.versionId, data:{}, outputFormat: format, label:`meta2 ${format}` }) })
  const c = await up.json()
  const id = c.documentId ?? c._id
  if (!up.ok) return { error: `${up.status} ${JSON.stringify(c).slice(0,150)}` }
  let d
  for (let i=0;i<40;i++){ await sleep(1000); const b = await (await fetch(`${API}/api/documents/${id}`,{headers})).json(); d = b.document ?? b; if (d?.status && ['done','failed'].includes(d.status)) break }
  if (d?.status !== 'done') return { error: d?.status ?? '?' }
  const buf = Buffer.from(await (await fetch(d.downloadUrl)).arrayBuffer())
  await fetch(`${API}/api/documents/${id}`, { method:'DELETE', headers })
  return { buf }
}

console.log('=== PDF: อ่านกลับด้วย pdf-lib (เหมือนโปรแกรมอ่าน PDF ทั่วไป) ===')
const p = await run('pdf')
if (p.error) console.log('  ' + p.error)
else {
  // ⚠️ ต้องใส่ updateMetadata: false ตอนอ่าน
  //    pdf-lib จะเขียน /Producer ทับเป็นชื่อตัวเองทันทีที่ load ถ้าไม่ปิด
  //    ทำให้เห็นผิดว่าไฟล์ถูก patch ผิด ทั้งที่จริงไฟล์ถูกต้องแล้ว
  const doc = await PDFDocument.load(p.buf, { updateMetadata: false })
  console.log('  Producer  =', JSON.stringify(doc.getProducer()))
  console.log('  Creator   =', JSON.stringify(doc.getCreator()))
  console.log('  Author    =', JSON.stringify(doc.getAuthor()))
  console.log('  pages     =', doc.getPageCount())
}

console.log('\n=== ODT: ตรวจ mimetype ต้องเป็นตัวแรกและ STORED ===')
const o = await run('odt')
if (o.error) console.log('  ' + o.error)
else {
  const dir = join(tmpdir(), 'odt-' + Date.now())
  mkdirSync(dir, {recursive:true})
  const zp = join(dir,'f.zip'); writeFileSync(zp, o.buf)
  try {
    // -v แสดงวิธีบีบอัดของแต่ละ entry
    const v = execSync(`tar -tvf "${zp}"`, { encoding:'utf8' })
    console.log('  entry แรก:', v.split('\n')[0].trim())
    const meta = execSync(`tar -xOf "${zp}" meta.xml`, { encoding:'utf8' })
    for (const m of meta.matchAll(/<meta:(initial-creator|generator)>([^<]*)</g)) console.log(`  meta.xml·${m[1]} = "${m[2]}"`)
    console.log('  mimetype =', execSync(`tar -xOf "${zp}" mimetype`, { encoding:'utf8' }))
  } finally { rmSync(dir,{recursive:true,force:true}) }
}

await redis.del(`session:${sid}`); redis.disconnect()
