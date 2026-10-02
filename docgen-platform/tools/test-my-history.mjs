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
const dir = mkdtempSync(join(tmpdir(), 'myhist-'))
rmSync(dir, { recursive: true, force: true })
await redis.del(`session:${H1.cookie.split('=')[1]}`, `session:${H2.cookie.split('=')[1]}`)
redis.disconnect()

console.log(`\n── ผ่าน ${pass} · ไม่ผ่าน ${fail} ─────────────────────\n`)
process.exit(fail ? 1 : 0)
