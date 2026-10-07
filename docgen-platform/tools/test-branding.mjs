/**
 * ทดสอบว่า patch metadata หลัง render ทำงานจริง
 *
 *   node --env-file=../dokploy-infra/.env --env-file=../dokploy-infra/.env.development tools/test-branding.mjs
 *
 * ยิงผ่านสายงานจริงทั้งหมด (API → NATS → worker → docserver → RustFS)
 * แล้วดาวน์โหลดไฟล์กลับมาแกะ metadata เทียบก่อน/หลัง
 */
import { Redis } from 'ioredis'
import { execSync } from 'node:child_process'
import { writeFileSync, mkdirSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const API = 'http://127.0.0.1:4001'
const redis = new Redis(process.env.VALKEY_URL)
const sid = `branding-${Date.now()}`
await redis.set(`session:${sid}`, JSON.stringify({ sub: 'branding-test' }), 'EX', 600)
const headers = { cookie: `docgen_session=${sid}`, 'content-type': 'application/json' }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const brand = process.env.OUTPUT_BRAND

// ── อ่าน metadata ออกมาให้เป็นบรรทัดอ่านง่าย ────────────────────
function readMeta(buf, ext) {
  const out = []
  if (ext === 'pdf') {
    const raw = buf.toString('latin1')
    for (const k of ['Producer', 'Creator', 'Author', 'Title']) {
      const m = raw.match(new RegExp(`/${k}\\s*(\\([^)]*\\)|<([0-9A-Fa-f\\s]*)>)`))
      if (!m) continue
      let v = m[1]
      if (m[2]) {
        // hex string แบบ UTF-16BE — decode ให้เป็นข้อความ
        v = Buffer.from(m[2].replace(/\s/g, ''), 'hex').swap16().toString('utf16le').replace(/\0/g, '')
      }
      out.push({ key: `/${k}`, value: v })
    }
  } else {
    const dir = join(tmpdir(), `meta-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    mkdirSync(dir, { recursive: true })
    const zp = join(dir, 'f.zip')
    writeFileSync(zp, buf)
    try {
      execSync(`tar -xf "${zp}" -C "${dir}"`, { stdio: 'ignore' })
      for (const f of ['docProps/core.xml', 'docProps/app.xml', 'meta.xml']) {
        let c
        try {
          c = readFileSync(join(dir, f), 'utf8')
        } catch {
          continue
        }
        for (const m of c.matchAll(
          /<((?:dc|cp|meta):(?:creator|lastModifiedBy|publisher|initial-creator|generator)|Application|Company)>([^<]*)</gi,
        )) {
          out.push({ key: `${f}·${m[1]}`, value: m[2] })
        }
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
  return out
}

// ── หาแม่แบบที่จะทดสอบ ────────────────────────────────────────
// ชื่ออาจว่างได้ถ้า Carborne ยังไม่ได้ลงทะเบียน metadata — ใช้ versionId ตัวแรกพอ
const list = await (await fetch(`${API}/api/templates`, { headers })).json()
const tpl = list.items.find((t) => t.name) ?? list.items[0]
console.log(`แม่แบบ: ${tpl.name || '(ไม่มีชื่อ)'} · versionId ${tpl.versionId.slice(0, 16)}…`)
console.log(`แบรนด์ที่ตั้งไว้: ${brand}\n${'═'.repeat(78)}\n`)

const DATA = {
  ที่: 'ที่ ชม.0511.01/1234',
  เลขที่หนังสือ: '1234',
  เรื่อง: 'ทดสอบ metadata',
  อำเภอ: 'เนินมะปราง',
  ชื่อเจ้าหน้าที่: 'สมชาย ใจดี',
  ตำแหน่ง: 'นายอำเภอ',
  เนื้อหา: 'ตรวจว่า metadata ถูกเขียนทับแล้วหรือยัง',
}

let pass = 0
let fail = 0

for (const format of ['pdf', 'docx']) {
  const up = await fetch(`${API}/api/documents`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ templateId: tpl.versionId, data: DATA, outputFormat: format, label: `branding: ${format}` }),
  })
  const created = await up.json()
  const id = created.documentId ?? created._id
  if (!up.ok) {
    console.log(`── ${format}: สร้างงานไม่สำเร็จ ${up.status} ${JSON.stringify(created).slice(0, 150)}`)
    fail++
    continue
  }

  let doc = null
  for (let i = 0; i < 40; i++) {
    await sleep(1000)
    const body = await (await fetch(`${API}/api/documents/${id}`, { headers })).json()
    doc = body.document ?? body
    if (doc?.status && ['done', 'failed'].includes(doc.status)) break
  }

  if (!doc?.status) {
    console.log(`── ${format}: ตอบกลับมาไม่มี status — ${JSON.stringify(doc).slice(0, 200)}`)
    fail++
    continue
  }

  if (doc.status !== 'done') {
    console.log(`── ${format}: สถานะ ${doc.status} ${doc.error ?? ''}`)
    fail++
    continue
  }

  const buf = Buffer.from(await (await fetch(doc.downloadUrl)).arrayBuffer())
  const magic = format === 'pdf' ? buf.subarray(0, 5).toString('latin1') : `PK:${buf[0] === 0x50 && buf[1] === 0x4b}`

  console.log(`── ${format.toUpperCase()}  ${buf.length.toLocaleString()} bytes  magic=${magic}`)

  const meta = readMeta(buf, format)
  let ok = true
  for (const m of meta) {
    const isBrand = m.value.includes(brand)
    if (!isBrand) ok = false
    console.log(`   ${isBrand ? '✓' : '✗'} ${m.key.padEnd(32)} = "${m.value}"`)
  }
  if (!meta.length) {
    console.log('   (อ่าน metadata ไม่ได้เลย)')
    ok = false
  }
  if (ok) pass++
  else fail++
  console.log()

  await fetch(`${API}/api/documents/${id}`, { method: 'DELETE', headers })
}

console.log('═'.repeat(78))
console.log(`ผ่าน ${pass} · ไม่ผ่าน ${fail}  ·  คาดว่าทุกช่องจะเป็น "${brand}"`)

await redis.del(`session:${sid}`)
redis.disconnect()
process.exit(fail > 0 ? 1 : 0)
