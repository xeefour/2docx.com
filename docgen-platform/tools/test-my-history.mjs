/**
 * ทดสอบประวัติส่วนตัว — เก็บค่า → ค้นหา → กู้ค่า
 *
 *   node --env-file=.env tools/test-my-history.mjs
 *
 * ── สิ่งที่ต้องผ่าน ────────────────────────────────────────────
 * 1. สร้างเอกสารแล้วค่าที่กรอกถูกเก็บ (จุดที่พังบ่อยที่สุด — เดิมไม่เคยเก็บเลย)
 * 2. `/history/:key/mine` คืนเฉพาะของฉัน พร้อม `data`
 * 3. ค้นด้วย**ค่าที่กรอก** (ชื่อผู้รับ) ไม่ใช่แค่ชื่อฉบับ
 * 4. ค้นด้วยชื่อฉบับก็ได้
 * 5. คำค้นที่ไม่มี → ว่าง พร้อม total
 * 6. `/history/:key` (ฝั่งขวา) **ไม่มี** `data` ของคนอื่นหลุดออกมา
 * 7. regex พิเศษในคำค้นไม่ทำให้ 500
 * 8. ผู้ใช้คนอื่นมองประวัติของฉันไม่ได้
 * 9. แบ่งหน้า — หน้า 2 เป็นฉบับคนละชุด · `total` เป็นจำนวนทั้งหมดทุกหน้า
 *    และโหมดค้นต้องแบ่งหน้าได้เหมือนกัน
 */
import { Redis } from 'ioredis'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const API = 'http://127.0.0.1:4001'
let pass = 0
let fail = 0
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`)
  ok ? pass++ : fail++
}

const redis = new Redis(process.env.VALKEY_URL)
const mkSession = async (tag) => {
  const sid = `myhist-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
  await redis.set(
    `session:${sid}`,
    JSON.stringify({ sub: sid, name: `ผู้ทดสอบ ${tag}`, email: `${tag}@test.local`, avatar: '' }),
    'EX',
    900,
  )
  return { cookie: `docgen_session=${sid}` }
}

/** เก็บ `_id` ที่สคริปต์นี้สร้าง เพื่อลบทิ้งตอนจบ (ไม่ทิ้งขยะไว้ในระบบให้คนจริงเจอ) */
const made = []

const H1 = await mkSession('a')
const H2 = await mkSession('b')

const templates = (await (await fetch(`${API}/api/templates`, { headers: H1 })).json()).items ?? []
const tpl = templates.find((t) => (t.name ?? '').includes('หัวกระดาษ')) ?? templates[0]
const key = String(tpl?.id ?? tpl?.versionId ?? '')
console.log(`ใช้แม่แบบ: ${tpl?.name} (key ${key})`)
if (!key) {
  console.log('✗ ไม่มีแม่แบบให้ทดสอบ')
  process.exit(1)
}

// ── 1. สร้างเอกสารพร้อมค่าที่กรอก ─────────────────────────────
console.log('\n[1] เก็บค่าที่กรอกไว้พร้อมเอกสาร')
/** ค่าที่มีเอกลักษณ์เฉพาะ เพื่อยืนยันว่าเป็นของเราเอกสารนี้จริง */
const stamp = `ทดสอบ-${Date.now()}`
const payload = {
  templateId: tpl.versionId,
  data: { 'ผู้รับ.ชื่อ': `นาย${stamp}`, 'ผู้รับ.ที่อยู่': '123 ถนนหลัก', 'เรื่อง': `หนังสือ${stamp}` },
  outputFormat: 'pdf',
  label: `ประวัติฉบับทดสอบ ${stamp}`,
}
const created = await (
  await fetch(`${API}/api/documents`, {
    method: 'POST',
    headers: { ...H1, 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
).json()
check('สร้างเอกสารได้', !!created._id, created._id ?? JSON.stringify(created).slice(0, 160))

made.push(created._id)
const got = await (await fetch(`${API}/api/documents/${created._id}`, { headers: H1 })).json()
check(
  'เอกสารที่อ่านกลับมามี data ครบ',
  got?.data?.['ผู้รับ.ชื่อ'] === payload.data['ผู้รับ.ชื่อ'],
  JSON.stringify(got?.data ?? null).slice(0, 120),
)

const mineAll = await (await fetch(`${API}/api/history/${key}/mine`, { headers: H1 })).json()
check('ประวัติส่วนตัวมีฉบับที่เพิ่งสร้าง', (mineAll.items ?? []).some((i) => i._id === created._id), `${mineAll.total} ฉบับ`)

// ── 2. ค้นด้วยค่าที่กรอก ───────────────────────────────────────
console.log('\n[2] ค้นหา — คนทำงานจำชื่อผู้รับ ไม่ได้จำชื่อฉบับ')
const byValue = await (
  await fetch(`${API}/api/history/${key}/mine?q=${encodeURIComponent(`นาย${stamp}`)}`, { headers: H1 })
).json()
check('ค้นด้วยชื่อผู้รับเจอ', (byValue.items ?? []).some((i) => i._id === created._id), `${byValue.total} ฉบับ`)
check('ผลที่เจอมี data ให้กู้', (byValue.items ?? []).find((i) => i._id === created._id)?.data?.['เรื่อง'] === `หนังสือ${stamp}`)

const byLabel = await (
  await fetch(`${API}/api/history/${key}/mine?q=${encodeURIComponent(`ประวัติฉบับทดสอบ ${stamp}`)}`, { headers: H1 })
).json()
check('ค้นด้วยชื่อฉบับก็เจอ', (byLabel.items ?? []).some((i) => i._id === created._id), `${byLabel.total} ฉบับ`)

const none = await (
  await fetch(`${API}/api/history/${key}/mine?q=${encodeURIComponent(`ไม่มีคำนี้แน่นอน${stamp}`)}`, { headers: H1 })
).json()
check('ค้นไม่เจอ → items ว่าง', (none.items ?? []).length === 0)
check('total บอกจำนวนที่**เจอ** ไม่ใช่ทั้งหมด', none.total === 0, `total=${none.total}`)

// ── 3. regex พิเศษต้องไม่ทำให้พัง ─────────────────────────────
console.log('\n[3] คำค้นที่มีอักขระ regex ต้องไม่ล้ม')
for (const bad of ['(', '[a-z', '*', 'a|b', '\\']) {
  const r = await fetch(`${API}/api/history/${key}/mine?q=${encodeURIComponent(bad)}`, { headers: H1 })
  check(`ค้น "${bad}" ไม่พัง`, r.status === 200, `HTTP ${r.status}`)
}

// ── 4. ฝั่งขวาห้ามมี data ของคนอื่นหลุด ─────────────────────────
console.log('\n[4] ฝั่งขวา "ผู้ใช้แม่แบบนี้" — ห้ามคืนค่าที่กรอกของคนอื่น')
const allUsers = await (await fetch(`${API}/api/history/${key}`, { headers: H1 })).json()
const leak = (allUsers.items ?? []).find((i) => 'data' in i)
check('ไม่มี field data หลุดมาเลย', !leak, leak ? `เจอที่ ${leak._id}` : `${(allUsers.items ?? []).length} แถว`)
check('ยังนับผู้ใช้รวมได้ตามเดิม', Array.isArray(allUsers.users), `${(allUsers.users ?? []).length} คน`)

// ── 5. ผู้ใช้คนอื่นมองประวัติของเราไม่ได้ ───────────────────────
console.log('\n[5] คนอื่นต้องมองประวัติส่วนตัวของเราไม่ได้')
const otherAll = await (await fetch(`${API}/api/history/${key}/mine`, { headers: H2 })).json()
check('ผู้ใช้คนอื่นไม่เห็นฉบับของเรา', !(otherAll.items ?? []).some((i) => i._id === created._id), `${otherAll.total} ฉบับ`)
const otherDoc = await fetch(`${API}/api/documents/${created._id}`, { headers: H2 })
check('คนอื่นเปิดเอกสารของเราไม่ได้', otherDoc.status === 404, `HTTP ${otherDoc.status}`)

// ── 6. ไม่ล็อกอิน → 401 ───────────────────────────────────────
const noAuth = await fetch(`${API}/api/history/${key}/mine`)
check('ไม่ล็อกอินได้ 401', noAuth.status === 401, `HTTP ${noAuth.status}`)

// ── เก็บกวาด ────────────────────────────────────────────────
// ── 7. แบ่งหน้า ──────────────────────────────────────────────────────
console.log('\n[7] แบ่งหน้า — server ตัดให้ ไม่ยิงมาทั้งหมด')
/**
 * ผู้ใช้สั่ง: *"ถ้ามีมากๆ ทำเป็น pageination"*
 *
 * ต้องพิสูจน์สามอย่าง ไม่ใช่แค่คืน `items` น้อยลง
 *   1. หน้า 2 ต้องเป็น**ฉบับคนละชุด**กับหน้า 1 (ถ้าซ้ำ = server ไม่ได้ใช้ skip)
 *   2. `total` ต้องเป็นจำนวน**ทั้งหมด**ทุกหน้า (ถ้าเป็นของหน้านี้ หน้าจอจะนับหน้าผิด)
 *   3. โหมดค้นต้องแบ่งหน้าได้เหมือนกัน และ `total` คือจำนวนที่เจอ
 */
const tag = `หน้า-${Date.now()}`
for (let i = 0; i < 5; i++) {
  const d = await (
    await fetch(`${API}/api/documents`, {
      method: 'POST',
      headers: { ...H1, 'content-type': 'application/json' },
      body: JSON.stringify({
        templateId: tpl.versionId,
        data: { 'ผู้รับ.ชื่อ': `นาย${tag}-${i}` },
        outputFormat: 'pdf',
        label: `แบ่งหน้า ${tag} #${i}`,
      }),
    })
  ).json()
  made.push(d._id)
}
const TOTAL = 6 // 1 ฉบับตอนต้น + 5 ฉบับที่เพิ่งสร้าง

const p1 = await (await fetch(`${API}/api/history/${key}/mine?limit=4&skip=0`, { headers: H1 })).json()
const p2 = await (await fetch(`${API}/api/history/${key}/mine?limit=4&skip=4`, { headers: H1 })).json()
check('หน้า 1 ได้ 4 ฉบับ', (p1.items ?? []).length === 4, `${(p1.items ?? []).length} ฉบับ`)
check('หน้า 2 ได้ 2 ฉบับ (ไม่ครบเต็ม 4)', (p2.items ?? []).length === 2, `${(p2.items ?? []).length} ฉบับ`)
check('total เป็นจำนวนทั้งหมดทุกหน้า', p1.total === TOTAL && p2.total === TOTAL, `${p1.total} / ${p2.total} (คาด ${TOTAL})`)
const id1 = new Set((p1.items ?? []).map((i) => i._id))
const dup = (p2.items ?? []).filter((i) => id1.has(i._id))
check('สองหน้าไม่ซ้ำกัน', dup.length === 0, dup.length ? `ซ้ำ ${dup.length} ฉบับ` : '')
check('รวมสองหน้าแล้วครบทุกฉบับของฉัน', id1.size + (p2.items ?? []).length === TOTAL)

const q1 = await (
  await fetch(`${API}/api/history/${key}/mine?limit=4&skip=0&q=${encodeURIComponent(tag)}`, { headers: H1 })
).json()
const q2 = await (
  await fetch(`${API}/api/history/${key}/mine?limit=4&skip=4&q=${encodeURIComponent(tag)}`, { headers: H1 })
).json()
check('ค้นแล้วแบ่งหน้าได้เหมือนกัน', (q1.items ?? []).length === 4 && (q2.items ?? []).length === 1, `${(q1.items ?? []).length} + ${(q2.items ?? []).length}`)
check('total ตอนค้นคือจำนวนที่เจอ ไม่ใช่ของหน้านี้', q1.total === 5 && q2.total === 5, `${q1.total} / ${q2.total}`)

const beyond = await fetch(`${API}/api/history/${key}/mine?limit=4&skip=99999`, { headers: H1 })
// error handler ของโปรเจกต์ตอบ 422 (Fastify ดิบตอบ 400) — สำคัญแค่ว่าต้องไม่ 200/500
check('skip เกินเพดาน → ถูกปฏิเสธ ไม่ใช่ค้าง', beyond.status === 400 || beyond.status === 422, `HTTP ${beyond.status}`)

for (const id of made) {
  await fetch(`${API}/api/documents/${id}`, { method: 'DELETE', headers: H1 }).catch(() => {})
}

const dir = mkdtempSync(join(tmpdir(), 'myhist-'))
rmSync(dir, { recursive: true, force: true })
await redis.del(`session:${H1.cookie.split('=')[1]}`, `session:${H2.cookie.split('=')[1]}`)
redis.disconnect()

console.log(`\n── ผ่าน ${pass} · ไม่ผ่าน ${fail} ─────────────────────\n`)
process.exit(fail ? 1 : 0)
