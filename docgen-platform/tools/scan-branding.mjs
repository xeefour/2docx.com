/**
 * สแกนไฟล์เอกสารทั้งโฟลเดอร์ว่ามีคำว่า "carbone" หลงอยู่ตรงไหน
 *
 *   node tools/scan-branding.mjs <โฟลเดอร์>
 *
 * 3 ชั้น เพราะแต่ละชั้นซ่อนคนละที่:
 *   1. byte ดิบ            — metadata ที่ไม่ถูกบีบอัด
 *   2. PDF stream (inflate) — ข้อความที่บีบอัดอยู่
 *   3. ข้างใน zip          — docx/odt/xlsx = zip เก็บ XML อยู่ข้างใน
 */
import { readFileSync, readdirSync, statSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { join, extname, basename } from 'node:path'
import { execSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import zlib from 'node:zlib'

const root = process.argv[2] ?? '.'
const EXTS = new Set(['.pdf', '.docx', '.odt', '.xlsx', '.pptx', '.doc', '.png', '.jpg', '.jpeg'])

/** ไฟล์ทั้งหมดแบบเรียงชั้น */
function walk(dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...walk(p))
    else if (EXTS.has(extname(p).toLowerCase())) out.push(p)
  }
  return out
}

// ── ค้นใน PDF: byte ดิบ + inflate ทุก stream ──────────────────
function scanPdf(buf) {
  const hits = []
  const raw = buf.toString('latin1')

  // metadata ที่โปรแกรมอ่านเห็นใน Properties dialog
  for (const key of ['Producer', 'Creator', 'CreatorTool', 'Author', 'Title', 'Subject']) {
    const m = raw.match(new RegExp(`/${key}\\s*(\\([^)]*\\)|<[0-9A-Fa-f\\s]*>)`))
    if (m) hits.push({ where: `metadata /${key}`, snippet: m[1].replace(/[^\x20-\x7e]/g, '') })
  }

  // XMP
  const xmp = raw.match(/<x:xmpmeta[\s\S]{0,4000}?<\/x:xmpmeta>/)?.[0] ?? ''
  for (const m of xmp.matchAll(/<(?:dc|x|xmp|pdf):?(?:creator|creatorTool|producer)>([^<]+)</gi)) {
    hits.push({ where: 'XMP metadata', snippet: m[1] })
  }

  // inflate ทุก stream
  let idx = 0
  let chunks = 0
  while (true) {
    const s = buf.indexOf('stream', idx)
    if (s === -1) break
    if (s >= 3 && buf.subarray(s - 3, s).toString('latin1') === 'end') {
      idx = s + 6
      continue
    }
    let start = s + 6
    if (buf[start] === 0x0d) start += 1
    if (buf[start] === 0x0a) start += 1
    const e = buf.indexOf('endstream', start)
    if (e === -1) break
    idx = e + 9

    const rawChunk = buf.subarray(start, e)
    let text
    try {
      text = zlib.inflateSync(rawChunk).toString('latin1')
    } catch {
      text = rawChunk.toString('latin1')
    }
    chunks++
    for (const m of text.matchAll(/.{0,70}carbone.{0,70}/gi)) {
      hits.push({ where: 'content stream', snippet: m[0].replace(/[^\x20-\x7e]/g, '.') })
    }
  }
  if (hits.length === 0) hits.push({ where: `_byte ดิบ + ${chunks} stream (inflate แล้ว) — ไม่มีคำว่า carbone_`, snippet: '' })
  return hits
}

// ── ค้นใน zip-based (docx/odt/xlsx/pptx) ──────────────────────
function scanZip(buf) {
  const dir = join(tmpdir(), `scan-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(dir, { recursive: true })
  const zp = join(dir, 'f.zip')
  writeFileSync(zp, buf)
  const hits = []
  try {
    execSync(`tar -xf "${zp}" -C "${dir}"`, { stdio: 'ignore' })
    const files = execSync(`tar -tf "${zp}"`, { encoding: 'utf8' })
      .split('\n')
      .map((s) => s.trim())
      .filter((s) => /\.(xml|rels|txt)$/.test(s))

    // พิมพ์ metadata ที่อ่านเข้าใจได้ ไม่ว่าจะมี carbone หรือไม่
    const core = ['meta.xml', 'docProps/core.xml', 'docProps/app.xml'].filter((f) =>
      files.includes(f),
    )
    for (const f of core) {
      const c = readFileSync(join(dir, f), 'utf8')
      for (const m of c.matchAll(
        /<(?:dc:creator|cp:lastModifiedBy|dc:title|meta:initial-creator|Application|Company|Manager)>([^<]*)<\//gi,
      )) {
        hits.push({ where: `${f} · ${m[1].split('>')[0]}`, snippet: m[2] })
      }
    }

    for (const f of files) {
      let c
      try {
        c = readFileSync(join(dir, f), 'utf8')
      } catch {
        continue
      }
      if (/carbone/i.test(c)) {
        hits.push({
          where: f,
          snippet: c.match(/.{0,60}carbone.{0,60}/i)?.[0]?.replace(/\s+/g, ' ') ?? '',
        })
      }
    }
    if (!hits.some((h) => /carbone/i.test(h.snippet))) {
      hits.push({ where: `_${files.length} ไฟล์ข้างใน — ไม่มีคำว่า carbone_`, snippet: '' })
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
  return hits
}

const files = walk(root)
console.log(`สแกน ${files.length} ไฟล์ใน ${root}\n${'═'.repeat(78)}\n`)

let anyHit = 0
for (const f of files) {
  const buf = readFileSync(f)
  const ext = extname(f).toLowerCase()
  let hits
  if (ext === '.pdf') hits = scanPdf(buf)
  else if (ext === '.docx' || ext === '.odt' || ext === '.xlsx' || ext === '.pptx')
    hits = scanZip(buf)
  else {
    // รูปภาพ — ค้นใน metadata ได้อย่างเดียว
    const t = buf.toString('latin1')
    const m = t.match(/.{0,50}carbone.{0,50}/gi)
    hits = m
      ? m.map((s) => ({ where: 'raw bytes', snippet: s.replace(/[^\x20-\x7e]/g, '.') }))
      : [{ where: '_byte ดิบ — ไม่มีคำว่า carbone_', snippet: '' }]
  }

  // เฉพาะอันที่ snippet มีคำว่า carbone จริง ๆ — ไม่งั้น metadata ปกติจะถูกนับเป็น hit
  const real = hits.filter((h) => /carbone/i.test(h.snippet))
  const flag = real.length ? '⚠️ ' : '✓ '
  console.log(`${flag}${basename(f)}  (${buf.length.toLocaleString()} bytes)`)
  for (const h of hits) {
    const isHit = h.snippet && /carbone/i.test(h.snippet)
    console.log(`      ${isHit ? '•' : '·'} ${h.where}${h.snippet ? ` → "${h.snippet}"` : ''}`)
  }
  if (real.length) anyHit++
  console.log()
}

console.log('═'.repeat(78))
console.log(
  anyHit === 0
    ? `ไม่พบคำว่า "carbone" ในไฟล์ใดเลย ✓  (ตรวจ ${files.length} ไฟล์)`
    : `พบคำว่า "carbone" ใน ${anyHit} ไฟล์`,
)
