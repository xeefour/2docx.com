/**
 * นำเข้าแม่แบบเดิมเข้าฐานข้อมูล Carbone
 *
 * ปัญหาที่แก้: แม่แบบที่อัปโหลดตอนแรกโดยไม่เปิด versioning จะมีแค่ไฟล์บนดิสก์
 * ไม่มี record ใน DB → GET /templates ไม่เห็น, PATCH/DELETE ได้ 404
 * วิธีแก้คืออัปโหลดไฟล์เดิมซ้ำแบบเปิด versioning
 *
 * ⚠️ อันตรายที่ต้องรู้
 *   Carbone ลบไฟล์จริง **แบบ synchronous** เมื่อ DELETE ไม่ใช่แค่ตั้ง expireAt
 *   ถ้าสั่ง DELETE ด้วย versionId ของไฟล์ที่ไม่ได้เปิด versioning
 *   → ไฟล์ต้นฉบับจะหายจาก /app/template ทันที
 *   สคริปต์นี้จึง "ไม่ลบอะไรเด็ดขาด" และข้ามไฟล์ที่คำนวณ sha256 แล้วไม่ตรงกับชื่อ
 *
 * วิธีใช้:
 *   node --env-file=.env tools/import-templates.mjs
 *   node --env-file=.env tools/import-templates.mjs --dry-run
 *   node --env-file=.env tools/import-templates.mjs --force
 *   node --env-file=.env tools/import-templates.mjs --from D:\backup\template
 *
 * ── ตัวเลือก ────────────────────────────────────────────────────
 *   --from <โฟลเดอร์>  อ่านไฟล์แม่แบบจากโฟลเดอร์ในเครื่อง แทนการดึงจาก container
 *                     ใช้เมื่อต้องนำเข้าไฟล์**ต้นฉบับที่ยังไม่เคยผ่านการแก้ไขอะไร**
 *   --only <h1,h2,…>   นำเข้าเฉพาะไฟล์ที่ระบุ (sha256 นำหน้า 8 ตัวพอ)
 *   --force            นำเข้าซ้ำแม้ว่าเคยนำเข้าแล้ว (Carbone เก็บเป็น version ใหม่
 *                     ของแม่แบบเดิม ไม่ต้องลบอะไร — ใช้หลังแก้โค้ดที่แปลงไฟล์ก่อนอัปโหลด)
 *
 * ⚠️ PowerShell: ค่าที่มีลูกน้ำต้องครอบ quote เสมอ ไม่งั้นมันจะแปลงเป็นตัวเลข
 *      --only 555288e5,9aa9bbcd   →  555288e5 กลายเป็น 55528800000 (scientific notation)
 *      --only "555288e5,9aa9bbcd" → ถูกต้อง
 *
 * ตั้งชื่อ/หมวด/แท็ก ใน MANIFEST ด้านล่าง
 */
import { execSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// ใช้ตัวแก้จาก shared โดยตรง (Node 22.18+ ถอด type จาก .ts ได้เอง)
// → กติกาการแปลงไฟล์มีจุดกำเนิดเดียว ไม่ต้องคัดลอก regex ไปแก้สองที่
//
// ⚠️ สคริปต์นี้ "ไม่" แก้ w:jc ตอนนำเข้า
//    แม่แบบต้องคง thaiDistribute ไว้ เพราะนั่นคือค่าที่ Word ใช้ "กระจายทั้งบรรทัด"
//    การแก้เป็น both ทำที่ worker ตอนส่งออก PDF เท่านั้น (ดู apps/worker/src/docserver.ts)
import { normalizeThaiAlignment } from '../packages/shared/src/normalize.ts'

const API = process.env.DOCSERVER_URL
const KEY = process.env.DOCSERVER_API_KEY
const H = { Authorization: `Bearer ${KEY}`, 'carbone-version': '5' }
const DRY = process.argv.includes('--dry-run')
const FORCE = process.argv.includes('--force')

/**
 * หาค่า `deployedAt` ที่ Carbone ยอมรับ
 *
 * ⚠️ Carbone เทียบค่านี้**ระดับปี** ไม่ใช่ระดับวินาที
 *    ส่ง ISO เต็ม (`2026-09-30T16:53:23.077Z`) ก็ถูกปฏิเสธเหมือนกัน
 *    และค่าที่อ่านกลับมาก็เหลือแค่ปี (`"2026"`)
 *
 * ⚠️ และ Carbone เลือก deploy เวอร์ชันที่ `deployedAt` **มากที่สุด**
 *    การส่งปีย้อนหลังจะ "สร้าง version สำเร็จ" แต่ไม่กลายเป็นตัวที่ deploy
 *    (อาการคืออัปโหลดผ่าน แต่ /templates ยังชี้ version เดิมอยู่)
 *
 * → ต้องไล่ขึ้นไปข้างหน้าเสมอ เพื่อให้มากกว่าเวอร์ชันที่ deploy อยู่เสมอ
 *
 * ค่านี้เป็น metadata ล้วน ๆ ระบบเราไม่ได้ใช้แสดงผลอะไร
 * (เอกสารที่ผลิตแล้วเก็บ versionId ไว้แล้ว ไม่ได้อ้างอิงวันที่)
 */
function deployedAtCandidates(fromYear) {
  return Array.from({ length: 5 }, (_, i) => `${fromYear + 1 + i}-01-01`)
}

/** อัปโหลดไฟล์เป็นแม่แบบเวอร์ชัน (คืน { id, versionId }) — ลองปีละรอบจนกว่า Carbone ยอมรับ */
async function upload(buf, meta, existingId) {
  if (!existingId) return uploadOnce(buf, meta, null, '')

  let lastErr
  for (const deployedAt of deployedAtCandidates(new Date().getUTCFullYear())) {
    try {
      return await uploadOnce(buf, meta, existingId, deployedAt)
    } catch (err) {
      lastErr = err
      if (!/deployedAt/.test(String(err.message))) throw err
    }
  }
  throw lastErr
}

/** อัปโหลดหนึ่งครั้ง */
async function uploadOnce(buf, meta, existingId, deployedAt) {
  // ⚠️ ห้ามใส่ header `Expect` — undici (fetch ของ Node) ไม่รองรับ
  // ⚠️ field ข้อความต้องมาก่อนไฟล์ — Carbone บังคับลำดับนี้ (code w131)
  const form = new FormData()
  form.set('versioning', 'true')

  // ส่ง id ของแม่แบบเดิม → Carbone **เพิ่ม version ใหม่ให้ตัวเดิม** ไม่ใช่สร้างแม่แบบใหม่
  // (ถ้าไม่ส่ง Carbone จะเดาจากชื่อ ซึ่งเสี่ยงได้แม่แบบซ้ำอีกชุด)
  if (existingId) {
    form.set('id', existingId)
    // ⚠️ บังคับ! Carbone ปฏิเสธการเพิ่ม version ถ้า deployedAt ซ้ำกับเวอร์ชันที่ deploy อยู่
    //    ข้อความจริง: "deployedAt must be different from the currently deployed template version"
    form.set('deployedAt', deployedAt)
  }

  form.set('name', meta.name)
  form.set('category', meta.category)
  if (meta.tags?.length) form.set('tags', JSON.stringify(meta.tags))
  form.set(
    'template',
    new Blob([new Uint8Array(buf)], {
      type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    }),
    `${meta.name}.docx`,
  )

  const up = await fetch(`${API}/template`, { method: 'POST', headers: H, body: form })
  const json = await up.json()
  if (!up.ok || !json.success) throw new Error(JSON.stringify(json).slice(0, 200))
  return { id: json.data.id, versionId: json.data.versionId }
}

/**
 * templateId ที่บันทึกไว้ใน state อาจไม่มีอยู่แล้ว
 *
 * Carbone ลบ record ใน DB ให้อัตโนมัติเมื่อ version สุดท้ายของแม่แบบถูกลบ
 * (ไฟล์ใน /app/template ยังอยู่ เพราะเก็บแยกกัน) ถ้าเอา id ที่ตายแล้วไปส่ง
 * จะได้ error ที่อ่านยากมาก — เช็กก่อนดีกว่า
 */
async function liveTemplateIds() {
  const res = await fetch(`${API}/templates`, { headers: H })
  const json = await res.json()
  const list = json?.data ?? []
  return new Set(list.map((t) => t.id).filter(Boolean))
}

/**
 * แม่แบบ → ข้อมูลที่จะลงทะเบียน (key คือ sha256 ใน /app/template)
 *
 * ⚠️ ชื่อด้านล่างอ่านมาจากเนื้อหาจริงใน word/document.xml ของแต่ละไฟล์
 *    ไม่ใช่ชื่อที่เดาขึ้นมา — แก้ได้ตามต้องการแล้วรันสคริปต์ใหม่ได้เลย
 *    (ชื่อเดิมลง DB แล้วต้องแก้ผ่าน PATCH /api/templates/:id เพราะสคริปต์นี้ข้ามที่ลงทะเบียนแล้ว)
 */
const MANIFEST = {
  // ── หนังสือรับรอง ──────────────────────────────────────────
  '3d318fde610a003cd0593e253697682642b8f2438443b59812913fa3855b2ec7': {
    name: 'หนังสือรับรอง (มีเลขที่หนังสือ + ตำแหน่งผู้ลงนาม)',
    category: 'หนังสือรับรอง',
    tags: ['ราชการ', 'หนังสือรับรอง'],
  },
  // ⚠️ ไฟล์นี้ใน /app/template ชื่อว่า c7b138d5… แต่เนื้อหาจริง hash คือ 6011892a…
  //    (ชื่อผิดมาตั้งแต่ backup เดิม — ไฟล์ใน backup กับใน container เป็นไฟล์เดียวกัน byte-for-byte)
  '6011892addbd4545daef654524a4a4b0d48e2c06c0830705ceb51839b28d9c3e': {
    name: 'หนังสือรับรอง (ส่งสำเนาให้อัยการ มีช่องสิ่งที่ส่งมาด้วย)',
    category: 'หนังสือรับรอง',
    tags: ['ราชการ', 'หนังสือรับรอง', 'อัยการ'],
  },
  '555288e5fc99572e131039402d4d79c09ee06fedf7d232f0363b4f88439780f8': {
    name: 'หนังสือรับรอง (อำเภอเนินมะปราง) สำเนา 1',
    category: 'หนังสือรับรอง',
    tags: ['ราชการ', 'หนังสือรับรอง'],
  },
  '9aa9bbcdca69b2a2b7ea28702b9bc4d6f736872f1b0f17f587957ad4e98e8172': {
    name: 'หนังสือรับรอง (อำเภอเนินมะปราง) สำเนา 2',
    category: 'หนังสือรับรอง',
    tags: ['ราชการ', 'หนังสือรับรอง'],
  },
  '9caa0c73d29b473cb6d2585dd3cb6719125d5694e94da7f4410ac313b4f9afcc': {
    name: 'หนังสือรับรอง (อำเภอเนินมะปราง) สำเนา 3',
    category: 'หนังสือรับรอง',
    tags: ['ราชการ', 'หนังสือรับรอง'],
  },

  // ── หนังสือราชการ ───────────────────────────────────────────
  '80f43fa635fde043edead06788c66bd3b6b4dce1e7f7757ce729261505301059': {
    name: 'หนังสือราชการ (มีส่วนหัวราชการ กอง/โทรศัพท์)',
    category: 'หนังสือราชการ',
    tags: ['ราชการ', 'หนังสือราชการ'],
  },

  // ── แม่แบบทดสอบ ────────────────────────────────────────────
  '1423f677d6a92a5e4430115828bf321e47ef7d50c9404ee499e91a7ac644d1e6': {
    name: 'ทดสอบข้อความ (แท็ก, สระวรรณยุกต์, ตัวเลขไทย, ค่าบูล)',
    category: 'ทดสอบ',
    tags: ['ทดสอบ', 'ข้อความ'],
  },
  '30005fc1f943d06bd32a2688087f3290b4f6751eb8d12b28e4c0e037c8d50c8d': {
    name: 'ทดสอบรูปภาพ (รูปเดี่ยว, หลายรูป, รูปในตาราง)',
    category: 'ทดสอบ',
    tags: ['ทดสอบ', 'รูปภาพ'],
  },
  '677e6119cde26d875099de7fbb94b740763151f2fdc02ef6e4609f1538ac6f91': {
    name: 'ทดสอบตาราง (ตารางซ้ำ, ตารางว่าง, เงื่อนไข)',
    category: 'ทดสอบ',
    tags: ['ทดสอบ', 'ตาราง'],
  },
  '3ade49a3975cd46375f2ca0df1cfe3943abd2b83a1dec112d81e8a1209a34a80': {
    name: 'ทดสอบหัวกระดาษ (หน้าแรก/หน้าสอง/เลขหน้า)',
    category: 'ทดสอบ',
    tags: ['ทดสอบ', 'หัวกระดาษ'],
  },
}

// ── 1. เลือกแหล่งไฟล์ ─────────────────────────────────────────
/**
 * `--from <โฟลเดอร์>` = อ่านไฟล์จากโฟลเดอร์ในเครื่อง แทนที่จะดึงจาก container
 *
 * จำเป็นเมื่อต้องนำเข้าไฟล์**ที่ยังไม่เคยผ่านการแก้ไขอะไร**
 * เช่น หลังเพิ่มการ normalize การจัดย่อหน้าไทย ถ้าอ่านจาก container
 * จะได้ไฟล์ที่ผ่านการแก้ไขไปแล้วรอบเก่า
 */
const fromArg = process.argv.indexOf('--from')
const LOCAL_DIR = fromArg !== -1 ? process.argv[fromArg + 1] : null

/** `--only <hash1,hash2,…>` = นำเข้าเฉพาะบางไฟล์ (ใช้ sha256 นำหน้า 8 ตัวก็ได้) */
const onlyArg = process.argv.indexOf('--only')
const ONLY = onlyArg !== -1 ? new Set(process.argv[onlyArg + 1].split(',').map((s) => s.trim().toLowerCase())) : null

/** แตะเฉพาะที่ระบุ ถ้าไม่ระบุ = ทั้งหมด */
function wanted(realHash) {
  if (!ONLY) return true
  return ONLY.has(realHash) || ONLY.has(realHash.slice(0, 8))
}

/** อ่านไฟล์แม่แบบ — คืน { file, realHash, mismatch, buf? } */
function collectFiles() {
  // ── จากโฟลเดอร์ในเครื่อง ──
  if (LOCAL_DIR) {
    const names = readdirSync(LOCAL_DIR)
      .filter((n) => /^[0-9a-f]{64}$/.test(n))
      .sort()
    console.log(`อ่านจากโฟลเดอร์: ${LOCAL_DIR} (${names.length} ไฟล์)\n`)
    return names.map((file) => {
      const buf = readFileSync(`${LOCAL_DIR}/${file}`)
      const realHash = createHash('sha256').update(buf).digest('hex')
      return { file, realHash, mismatch: realHash !== file, buf }
    })
  }

  // ── จาก container (ค่า default) ──
  const listing = execSync('docker exec docserver ls /app/template', { encoding: 'utf8' })
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => /^[0-9a-f]{64}$/.test(s)) // ชื่อไฟล์แม่แบบคือ hash 64 ตัว (ตัด _sample.json.gz ออก)

  console.log(`พบ ${listing.length} ไฟล์ใน /app/template\n`)

  // ห้าม pipe ผ่าน shell — Windows ไม่มีคำสั่ง `cut` ให้แยกช่องใน JS แทน
  // ชื่อไฟล์อาจไม่ตรงกับเนื้อหา (มีอยู่แล้ว 1 ไฟล์ใน backup เดิม) จึงต้องเชื่อ hash จริง
  return listing.map((file) => {
    const realHash = execSync(`docker exec docserver sha256sum /app/template/${file}`, {
      encoding: 'utf8',
    })
      .trim()
      .split(/\s+/)[0]
    return { file, realHash, mismatch: realHash !== file }
  })
}

const files = collectFiles()

for (const f of files.filter((f) => f.mismatch)) {
  console.log(`⚠️  ชื่อไฟล์ไม่ตรงกับเนื้อหา: ${f.file}`)
  console.log(`    คำนวณได้จริง = ${f.realHash} (จะใช้ตัวนี้ลงทะเบียน)`)
}

// ── 3. โหลดสถานะที่นำเข้าไปแล้ว จากไฟล์ local ────────────────
// ใช้ versionId ของ Carbone เป็น key ไม่ได้ เพราะเปิด versioning แล้วได้ค่าใหม่ทุกครั้ง
// แม้ไฟล์เดิม → ถ้าใช้เป็น key สคริปต์นี้จะอัปโหลดซ้ำทุกรอบ
const STATE_FILE = new URL('./.imported-templates.json', import.meta.url)
let state = {}
try {
  state = JSON.parse(readFileSync(STATE_FILE, 'utf8'))
} catch {
  /* ยังไม่เคยนำเข้า — เริ่มจากศูนย์ */
}

// ── 4. นำเข้า ────────────────────────────────────────────────
let ok = 0
let skip = 0
let fail = 0

/** แม่แบบที่ยังมี record ใน DB จริง (ไม่รวมไฟล์ดิบที่ id=null) — เป็น GET อย่างเดียว อ่านได้แม้ตอน dry-run */
const live = await liveTemplateIds()

/** อ่านไฟล์จากแหล่งที่เลือก — local ใช้ buffer ที่อ่านมาแล้ว, container ต้องดึงใหม่ */
async function readTemplate(f) {
  if (f.buf) return f.buf
  // ดาวน์โหลดด้วย "ชื่อไฟล์" ไม่ใช่ hash เพราะ Carbone เสิร์ฟตามชื่อที่บันทึกไว้
  const dl = await fetch(`${API}/template/${f.file}`, { headers: H })
  if (!dl.ok) throw new Error(`ดาวน์โหลดไม่สำเร็จ: ${dl.status}`)
  return Buffer.from(await dl.arrayBuffer())
}

for (const { file, realHash, mismatch, buf } of files) {
  const meta = MANIFEST[realHash]

  if (!wanted(realHash)) {
    skip++
    continue
  }

  if (!meta) {
    console.log(`⚠️  ข้าม ${file.slice(0, 12)}… — ไม่มีใน MANIFEST (เพิ่มชื่อเองก่อนถึงจะนำเข้าได้)`)
    skip++
    continue
  }

  if (state[realHash] && !FORCE) {
    console.log(`⏭  ข้าม ${realHash.slice(0, 12)}… "${meta.name}" (นำเข้าแล้ว ${state[realHash].importedAt})`)
    skip++
    continue
  }

  if (DRY) {
    const flag = mismatch ? ' (ชื่อไฟล์ไม่ตรง แต่ hash ตรง MANIFEST)' : ''
    const prev = state[realHash]
    const mode = !prev
      ? ''
      : live.has(prev.id)
        ? ' · จะเพิ่มเป็น version ใหม่ของแม่แบบเดิม'
        : ` · id เดิม ${prev.id} ไม่อยู่ใน DB แล้ว → จะสร้างแม่แบบใหม่`
    console.log(
      `🔍 [dry-run] จะนำเข้า ${realHash.slice(0, 12)}…  "${meta.name}" [${meta.category}]${flag}${mode}`,
    )
    continue
  }

  try {
    const source = buf ?? (await readTemplate({ file }))

    // รายงานสถานะการจัดย่อหน้า แต่ **ไม่แก้ไฟล์**
    // แม่แบบต้องคง thaiDistribute ไว้ — worker จะแก้เป็น both ตอนส่งออก PDF
    let note = '— ไม่ได้แก้ (อ่านจาก container)'
    if (buf) {
      const { result } = normalizeThaiAlignment(source)
      note = result.replaced
        ? `w:jc: ${Object.entries(result.replaced)
            .map(([k, v]) => `${k}×${v}`)
            .join(' ')} (จะถูกแก้เป็น both ตอนส่งออก PDF)`
        : `w:jc: ไม่มีค่าที่ LibreOffice ไม่รองรับ (ตรวจ ${result.scanned} ย่อหน้า)`
    }

    const prev = state[realHash]
    const reuseId = prev?.id && live.has(prev.id) ? prev.id : null
    const orphan = prev?.id && !reuseId

    const up = await upload(source, meta, reuseId)
    live.add(up.id)
    state[realHash] = { id: up.id, versionId: up.versionId, importedAt: new Date().toISOString() }

    const kind = reuseId
      ? `version ใหม่ของ id=${up.id}`
      : orphan
        ? `สร้างแม่แบบใหม่ id=${up.id} (id เดิม ${prev.id} ไม่อยู่ใน DB แล้ว)`
        : `id=${up.id}`
    console.log(
      `✅ ${realHash.slice(0, 12)}… → ${kind}  "${meta.name}"\n     ${note}`,
    )
    ok++
  } catch (e) {
    console.log(`❌ ${realHash.slice(0, 12)}… ${e.message}`)
    fail++
  }
}

if (!DRY) {
  writeFileSync(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
  console.log(`\nบันทึกสถานะไว้ที่ ${fileURLToPath(STATE_FILE)}`)
}

console.log(`\nสรุป: สำเร็จ ${ok} · ข้าม ${skip} · ล้มเหลว ${fail}`)
if (DRY) console.log('(โหมด dry-run — ไม่ได้แก้อะไร)')
process.exit(fail > 0 ? 1 : 0)
