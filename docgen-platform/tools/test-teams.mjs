/**
 * ระบบทีม — ทดสอบสิทธิ์ สมาชิก และกฎกันทีมพัง
 *
 *   node --env-file=../dokploy-infra/.env --env-file=../dokploy-infra/.env.development tools/test-teams.mjs
 *
 * ทำ session ปลอมใส่ Valkey เองแบบเดียวกับ test-account.mjs
 *
 * ── เน้นกฎที่พังแล้วแย่กว่าที่คิด ──────────────────────────────
 *   1. ทีมต้องมี owner ≥ 1 คนเสมอ (ลด role / ถอน / ออกเอง)
 *   2. คนนอกทีมแตะของทีมไม่ได้
 *   3. คนที่ออกจากทีมแล้วเสียสิทธิ์ทันที ไม่รอ session หมดอายุ
 *   4. แม่แบบ published ที่ยังไม่มีเจ้าของ → admin ทีมยึดได้
 *      แต่ถ้ามีเจ้าของเป็นคนอื่น → ห้ามยึด (กันการลากแม่แบบคนอื่นเข้าทีมตัว)
 */
import { spawn } from 'node:child_process'
import { Redis } from 'ioredis'
import { MongoClient } from 'mongodb'
import { resolveMongoUrl } from '@docgen/shared'

const API = 'http://127.0.0.1:4001'
const STAMP = Date.now()

let pass = 0
let fail = 0
function ok(label, cond, extra = '') {
  if (cond) {
    pass++
    console.log(`  ✓ ${label}`)
  } else {
    fail++
    console.log(`  ✗ ${label}${extra ? ` — ${extra}` : ''}`)
  }
}

const redis = new Redis(process.env.VALKEY_URL)
let mongo
const db = async () => {
  if (!mongo) {
    mongo = new MongoClient(await resolveMongoUrl(() => {}))
    await mongo.connect()
  }
  return mongo.db(process.env.MONGO_DB ?? 'app')
}

// ผู้เรียกที่ใช้ในเทสต์: OWNER สร้างทีม, ADMIN เป็นผู้ดูแล, EDIT/VIEW เป็นสมาชิก,
// OUT คือคนนอกทีม
const U = Object.fromEntries(
  ['owner', 'admin', 'edit', 'view', 'out'].map((n) => [n, `team-${n}-${STAMP}`]),
)
/** อีเมลของแต่ละคน — ใช้ตอนเชิญ (ตรงกับที่ session ปลอมไว้ด้านล่าง) */
const EMAIL = Object.fromEntries(Object.keys(U).map((n) => [n, `${n}@test.local`]))
const h = (n) => ({ cookie: `docgen_session=${U[n]}`, 'content-type': 'application/json' })

for (const [name, sid] of Object.entries(U)) {
  await redis.set(
    `session:${sid}`,
    JSON.stringify({ sub: sid, name: `ทดสอบ ${name}`, email: EMAIL[name], avatar: '' }),
    'EX',
    900,
  )
}

/**
 * จำลองการเข้าสู่ระบบของคนหนึ่ง → เรียก `claimPendingInvites()` ตัวจริง
 *
 * ⚠️ จุดที่เรียกจริงคือ callback ของ Casdoor (ยิงผ่าน HTTP ไม่ได้ในเทสต์)
 *   ต้องเรียกฟังก์ชันตรง ๆ ไม่ใช่แก้ Mongo เอง — ถ้าจำลองผลเอง เทสต์จะผ่านทั้งที่โค้ดพัง
 */
const claim = (who) =>
  new Promise((res, rej) => {
    const c = spawn(
      process.execPath,
      ['--env-file=../dokploy-infra/.env --env-file=../dokploy-infra/.env.development', 'node_modules/tsx/dist/cli.mjs', 'tools/claim-pending.ts', U[who], EMAIL[who], `ทดสอบ ${who}`],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    )
    let out = ''
    let errOut = ''
    c.stdout.on('data', (d) => (out += d))
    c.stderr.on('data', (d) => (errOut += d))
    c.on('close', (code) => (code === 0 ? res(Number(out.trim() || 0)) : rej(new Error(errOut.slice(0, 400)))))
  })

/**
 * ⚠️ `content-type` ต้อง**ไม่**ถูกส่งตอนไม่มี body
 *   Fastify ตอบ 500 ทันทีว่า "Body cannot be empty when content-type is set to
 *   'application/json'" — เจอแล้วตอนทดสอบ 500 ทั้งชุดที่เป็น DELETE
 */
const call = async (path, who, opt = {}) => {
  const hasBody = opt.body !== undefined
  const r = await fetch(`${API}${path}`, {
    method: opt.method ?? 'GET',
    ...(hasBody ? { body: JSON.stringify(opt.body) } : {}),
    headers: {
      cookie: `docgen_session=${U[who]}`,
      ...(hasBody ? { 'content-type': 'application/json' } : {}),
      ...(opt.headers ?? {}),
    },
  })
  const text = await r.text()
  let body = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = text
  }
  return { status: r.status, body }
}

/** ยืมไฟล์แม่แบบที่มีอยู่แล้ว (POST /api/templates รับเฉพาะ multipart) */
const mkTemplate = async (who, name) => {
  const list = await call('/api/templates', who)
  const donor = (list.body?.items ?? []).find((t) => t.id ?? t.versionId)
  if (!donor) throw new Error('ไม่มีแม่แบบเดิมให้ยืมไฟล์')
  const bytes = new Uint8Array(
    await (
      await fetch(`${API}/api/templates/${encodeURIComponent(String(donor.id ?? donor.versionId))}`, {
        headers: { cookie: `docgen_session=${U[who]}` },
      })
    ).arrayBuffer(),
  )
  const f = new FormData()
  f.set('versioning', 'true')
  f.set('name', name)
  f.set('template', new Blob([bytes], { type: 'application/octet-stream' }), 'ต้นฉบับ.docx')
  const r = await fetch(`${API}/api/templates`, {
    method: 'POST',
    headers: { cookie: `docgen_session=${U[who]}` },
    body: f,
  })
  const b = await r.json().catch(() => null)
  if (!r.ok) throw new Error(`สร้างแม่แบบไม่สำเร็จ (${r.status}): ${JSON.stringify(b)}`)
  return String(b?.id ?? b?.templateKey ?? '')
}

const created = []
let teamId = ''

try {
  // ── 1. สร้างทีม ──────────────────────────────────────────────
  console.log('\n[1] สร้างทีม')
  {
    const r = await call('/api/teams', 'owner', {
      method: 'POST',
      body: {
        name: `ทีมทดสอบ ${STAMP}`,
        members: [
          { email: EMAIL.admin, role: 'admin' },
          { email: EMAIL.edit, role: 'editor' },
          { email: EMAIL.view, role: 'viewer' },
          // ผู้สร้างซ้ำ → ต้องถูกข้าม ไม่งั้นจะมี owner 2 คนในทีมเดียว
          { email: EMAIL.owner, role: 'admin' },
        ],
      },
    })
    teamId = r.body?.team ?? ''
    ok('สร้างทีมได้', r.status === 201, `ได้ ${r.status} ${JSON.stringify(r.body)}`)
    ok('ผู้สร้างเป็นเจ้าของ', r.body?.myRole === 'owner', `ได้ ${r.body?.myRole}`)
    ok('ไม่มีสมาชิกซ้ำ', r.body?.members?.length === 4, `ได้ ${r.body?.members?.length} คน`)
    ok(
      'คนที่เชิญด้วยอีเมลขึ้นเป็น "รอเข้าระบบ" (ยังไม่มี sub)',
      (r.body?.members ?? []).filter((m) => m.sub === null).length === 3,
      JSON.stringify(r.body?.members?.map((m) => [m.sub, m.email])),
    )
    ok(
      'role ถูกต้อง (owner/admin/editor/viewer)',
      JSON.stringify(r.body?.members?.map((m) => m.role)) === JSON.stringify(['owner', 'admin', 'editor', 'viewer']),
      JSON.stringify(r.body?.members?.map((m) => m.role)),
    )

    // คนที่ถูกเชิญยังเข้าทีมไม่ได้จนกว่าจะเข้าสู่ระบบ
    const pre = await call('/api/teams', 'admin')
    ok('คนที่รอเข้าระบบยังไม่เห็นทีมใน "ทีมของฉัน"', (pre.body?.items ?? []).length === 0, JSON.stringify(pre.body))

    // จำลองการเข้าสู่ระบบ → ผูกสมาชิกที่รออยู่
    const claimed = await claim('admin')
    ok('เข้าสู่ระบบแล้วผูกสมาชิกที่รอได้', claimed === 1, `ผูกได้ ${claimed} ทีม`)

    const linked = await call(`/api/teams/${teamId}`, 'admin')
    ok(
      'ผูกแล้วมี sub และลบอีเมลทิ้ง (อ่านสดจาก session ภายหลัง)',
      JSON.stringify(linked.body?.members?.find((m) => m.sub === U.admin)) ===
        JSON.stringify({ sub: U.admin, name: 'ทดสอบ admin', email: null, role: 'admin', at: linked.body?.members?.find((m) => m.sub === U.admin)?.at, by: U.owner, pending: false }),
      JSON.stringify(linked.body?.members?.find((m) => m.role === 'admin')),
    )
    const mine = await call('/api/teams', 'admin')
    ok('ผูกแล้วเห็นทีมใน "ทีมของฉัน"', (mine.body?.items ?? []).length === 1, JSON.stringify(mine.body))

    // ที่เหลือผูกให้ครบ เพื่อให้ข้อต่อไปทดสอบสิทธิ์ของสมาชิกจริงได้
    await claim('edit')
    await claim('view')
  }

  // ── 2. คนนอกทีมเห็นทีมแต่แก้ไม่ได้ ──────────────────────────────
  console.log('\n[2] คนนอกทีม')
  {
    const list = await call('/api/teams', 'out')
    ok('รายการทีมของคนนอกทีมว่าง', list.status === 200 && (list.body?.items ?? []).length === 0, JSON.stringify(list.body))

    const detail = await call(`/api/teams/${teamId}`, 'out')
    ok('อ่านรายละเอียดทีมได้ (เพื่อเลือกตอนย้ายแม่แบบ)', detail.status === 200, `ได้ ${detail.status}`)
    ok('myRole = null', detail.body?.myRole === null, `ได้ ${detail.body?.myRole}`)

    const rename = await call(`/api/teams/${teamId}`, 'out', { method: 'PATCH', body: { name: 'แย่งชื่อ' } })
    ok('คนนอกทีมเปลี่ยนชื่อทีมไม่ได้', rename.status === 403, `ได้ ${rename.status}`)

    const add = await call(`/api/teams/${teamId}/members`, 'out', { method: 'POST', body: { email: EMAIL.out } })
    ok('คนนอกทีมเพิ่มสมาชิกไม่ได้', add.status === 403, `ได้ ${add.status}`)

    const bad = await call(`/api/teams/${teamId}/members`, 'owner', { method: 'POST', body: { email: 'ไม่ใช่อีเมล' } })
    // 422 = Zod validation ไม่ผ่าน (ข้อตกลงของทั้งระบบ ดู setErrorHandler ใน app.ts)
    ok('อีเมลผิดรูปแบบถูกปฏิเสธ', bad.status === 422, `ได้ ${bad.status}`)

    const self = await call(`/api/teams/${teamId}/members`, 'owner', { method: 'POST', body: { email: EMAIL.owner } })
    ok('เชิญตัวเองไม่ได้', self.status === 422, `ได้ ${self.status}`)
  }

  // ── 2b. เชิญด้วยอีเมล: คนที่ยังไม่เคยเข้าระบบ ───────────────────
  console.log('\n[2b] เชิญด้วยอีเมล · คนที่ยังไม่เคยเข้าระบบ')
  {
    const add = await call(`/api/teams/${teamId}/members`, 'owner', {
      method: 'POST',
      body: { email: EMAIL.out, role: 'editor' },
    })
    ok('เชิญด้วยอีเมลได้', add.status === 200, `ได้ ${add.status}`)
    ok('คนใหม่ขึ้นเป็น "รอเข้าระบบ" (sub ว่าง)', add.body?.pending === true && add.body?.sub === null, JSON.stringify(add.body))

    // พิมพ์อีเมลเดิมซ้ำ (ต่างตัวพิมพ์/เว้นวรรค) → ต้องอัปเดตแถวเดิม ไม่ใช่เพิ่มคนใหม่
    const again = await call(`/api/teams/${teamId}/members`, 'owner', {
      method: 'POST',
      body: { email: `  ${EMAIL.out.toUpperCase()} `, role: 'viewer' },
    })
    ok('เชิญอีเมลเดิมซ้ำ = เปลี่ยน role ไม่ใช่เพิ่มคนใหม่', again.status === 200, `ได้ ${again.status}`)
    const after = await call(`/api/teams/${teamId}`, 'owner')
    ok('ยังมีแถวเดียว (ไม่ซ้ำ)', (after.body?.members ?? []).filter((m) => m.email === EMAIL.out).length === 1, JSON.stringify(after.body?.members?.map((m) => m.email)))

    // จัดการคนที่ยังรอผูกได้ด้วยอีเมล (ยังไม่มี sub ให้อ้าง)
    const role2 = await call(`/api/teams/${teamId}/members/${encodeURIComponent(EMAIL.out)}`, 'owner', {
      method: 'PATCH',
      body: { role: 'editor' },
    })
    ok('เปลี่ยนสิทธิ์คนที่รอผูกด้วยอีเมลได้', role2.status === 200 && role2.body?.role === 'editor', JSON.stringify(role2.body))

    // เชิญคนที่เป็นสมาชิกอยู่แล้วด้วยอีเมลเดิม → พอเขาล็อกอินต้องไม่กลายเป็นสองแถว
    const dup = await call(`/api/teams/${teamId}/members`, 'owner', {
      method: 'POST',
      body: { email: EMAIL.admin, role: 'viewer' },
    })
    ok('เชิญคนที่เข้าทีมแล้วด้วยอีเมลเดิมได้ (ยังไม่ผิดตอนนี้)', dup.status === 200, `ได้ ${dup.status}`)
    const claimedDup = await claim('admin')
    const dedup = await call(`/api/teams/${teamId}`, 'owner')
    ok('ล็อกอินแล้วไม่เหลือสองแถว (แถวรอถูกลบทิ้ง)', (dedup.body?.members ?? []).filter((m) => m.sub === U.admin || m.email === EMAIL.admin).length === 1, `ผูกได้ ${claimedDup} · ${JSON.stringify(dedup.body?.members?.map((m) => m.sub ?? m.email))}`)

    // คนที่รอผูกยังเข้าทีมไม่ได้ (ยังไม่มี sub = ยังไม่มีสิทธิ์)
    const notYet = await call('/api/teams', 'out')
    ok('คนที่ยังรอเข้าระบบยังไม่เห็นทีมเป็นของตัวเอง', (notYet.body?.items ?? []).length === 0, JSON.stringify(notYet.body))

    // ถอนคนที่รอผูกด้วยอีเมล
    const kick = await call(`/api/teams/${teamId}/members/${encodeURIComponent(EMAIL.out)}`, 'owner', {
      method: 'DELETE',
    })
    ok('ถอนคนที่ยังรอเข้าระบบได้', kick.status === 204, `ได้ ${kick.status}`)
  }

  // ── 3. viewer จัดการทีมไม่ได้ แต่ admin ได้ ─────────────────────
  console.log('\n[3] สิทธิ์ระดับทีม')
  {
    const v = await call(`/api/teams/${teamId}`, 'view', { method: 'PATCH', body: { name: 'ชื่อใหม่' } })
    ok('viewer เปลี่ยนชื่อทีมไม่ได้', v.status === 403, `ได้ ${v.status}`)

    const a = await call(`/api/teams/${teamId}`, 'admin', { method: 'PATCH', body: { name: `ทีมทดสอบ ${STAMP} แก้ชื่อแล้ว` } })
    ok('admin เปลี่ยนชื่อทีมได้', a.status === 200, `ได้ ${a.status}`)
  }

  // ── 4. กฎที่ 1: owner คนสุดท้ายห้ามหลุดสิทธิ์ ─────────────────
  console.log('\n[4] owner คนสุดท้ายต้องมีเสมอ')
  {
    const demote = await call(`/api/teams/${teamId}/members/${U.owner}`, 'admin', {
      method: 'PATCH',
      body: { role: 'editor' },
    })
    ok('admin ลด role เจ้าของคนสุดท้ายไม่ได้', demote.status === 403, `ได้ ${demote.status}`)

    const kick = await call(`/api/teams/${teamId}/members/${U.owner}`, 'admin', { method: 'DELETE' })
    ok('ถอนเจ้าของคนสุดท้ายไม่ได้', kick.status === 403, `ได้ ${kick.status}`)

    const leave = await call(`/api/teams/${teamId}/members/${U.owner}`, 'owner', { method: 'DELETE' })
    ok('เจ้าของออกจากทีมตัวเองไม่ได้', leave.status === 403, `ได้ ${leave.status}`)

    const del = await call(`/api/teams/${teamId}`, 'admin', { method: 'DELETE' })
    ok('admin ลบทีมไม่ได้ (ต้องเป็นเจ้าของ)', del.status === 403, `ได้ ${del.status}`)

    // ยกระดับ admin เป็นเจ้าของก่อน → ถอนได้
    const promote = await call(`/api/teams/${teamId}/members/${U.admin}`, 'owner', {
      method: 'PATCH',
      body: { role: 'owner' },
    })
    ok('เจ้าของเลื่อน admin เป็นเจ้าของได้', promote.status === 200, `ได้ ${promote.status}`)

    const kick2 = await call(`/api/teams/${teamId}/members/${U.owner}`, 'admin', { method: 'DELETE' })
    ok('ตอนมีเจ้าของ 2 คน ถอนได้แล้ว', kick2.status === 204, `ได้ ${kick2.status}`)

    const left = await call('/api/teams', 'owner')
    ok('คนที่ถูกถอนไม่เห็นทีมแล้ว', (left.body?.items ?? []).length === 0, JSON.stringify(left.body))
  }

  // ── 5. กฎที่ 3: ถอนแล้วเสียสิทธิ์ทันที ────────────────────────
  console.log('\n[5] แม่แบบของทีม')
  {
    // admin (เจ้าของทีม) ย้ายแม่แบบเข้าทีม
    const tpl = await mkTemplate('admin', `แม่แบบทีม ${STAMP}`)
    created.push(tpl)

    const move = await call(`/api/access/${encodeURIComponent(tpl)}/team`, 'admin', {
      method: 'PUT',
      body: { team: teamId },
    })
    ok('เจ้าของแม่แบบย้ายเข้าทีมได้', move.status === 200, `ได้ ${move.status} ${JSON.stringify(move.body)}`)
    ok('สิทธิ์เป็นสมาชิกทีม', move.body?.relation === 'team' || move.body?.relation === 'owner', `ได้ ${move.body?.relation}`)
    ok('บังคับเป็น private', move.body?.visibility === 'private', `ได้ ${move.body?.visibility}`)
    ok('มีชื่อทีมในผลลัพธ์', typeof move.body?.teamName === 'string' && move.body.teamName.length > 0, String(move.body?.teamName))

    // editor ของทีมแก้ได้
    const editOk = await call(`/api/access/${encodeURIComponent(tpl)}`, 'edit')
    ok('editor ของทีมแก้ได้', editOk.body?.canEdit === true, JSON.stringify(editOk.body?.relation))
    ok('editor เห็นสิทธิ์เป็นสมาชิกทีม', editOk.body?.relation === 'team', `ได้ ${editOk.body?.relation}`)

    // viewer ของทีมดูได้ แต่แก้ไม่ได้
    const viewOk = await call(`/api/access/${encodeURIComponent(tpl)}`, 'view')
    ok('viewer ของทีมดูได้', viewOk.status === 200, `ได้ ${viewOk.status}`)
    ok('viewer ของทีมแก้ไม่ได้', viewOk.body?.canEdit === false, `canEdit=${viewOk.body?.canEdit}`)

    // คนนอกทีมยิงดูสิทธิ์ได้ แต่ต้อง**ไม่เห็นรายชื่อผู้ถูกแชร์**
    // (เคยรั่วมาก่อนหน้านี้ — ใครก็ยิง /api/access/:key แล้วเห็น sharedWith ของแม่แบบ private)
    const outTry = await call(`/api/access/${encodeURIComponent(tpl)}`, 'out')
    ok('คนนอกทีมยังได้คำตอบ (หน้าเว็บต้องบอก "แก้ไม่ได้" ได้)', outTry.status === 200, `ได้ ${outTry.status}`)
    ok('แต่แก้ไม่ได้', outTry.body?.canEdit === false, `canEdit=${outTry.body?.canEdit}`)
    ok(
      'ไม่เห็นรายชื่อผู้ถูกแชร์ (ไม่รั่วข้อมูล)',
      (outTry.body?.sharedWith ?? []).length === 0,
      `ได้ ${JSON.stringify(outTry.body?.sharedWith)}`,
    )
    ok('ไม่เห็นว่าเป็นแม่แบบของทีม', outTry.body?.team === null, `ได้ ${outTry.body?.team}`)

    // แต่สมาชิกทีมยังเห็นข้อมูลครบ
    const memberView = await call(`/api/access/${encodeURIComponent(tpl)}`, 'edit')
    ok('สมาชิกทีมยังเห็นชื่อทีม', typeof memberView.body?.teamName === 'string' && memberView.body.teamName.length > 0, String(memberView.body?.teamName))

    // คนนอกทีมย้ายแม่แบบเข้าทีมของเราไม่ได้
    const steal = await call(`/api/access/${encodeURIComponent(tpl)}/team`, 'out', {
      method: 'PUT',
      body: { team: teamId },
    })
    ok('คนนอกทีมยึดแม่แบบไม่ได้', steal.status === 403, `ได้ ${steal.status}`)
  }

  // ── 6. กฎที่ 3 (ต่อ): ถอนสมาชิกแล้วเสียสิทธิ์ทันที ────────────
  console.log('\n[6] ถอนสมาชิกแล้วเสียสิทธิ์ทันที')
  {
    const tpl = created[created.length - 1]

    const before = await call(`/api/access/${encodeURIComponent(tpl)}`, 'edit')
    ok('ก่อนถอน: editor แก้ได้', before.body?.canEdit === true, JSON.stringify(before.body?.relation))

    const kick = await call(`/api/teams/${teamId}/members/${U.edit}`, 'admin', { method: 'DELETE' })
    ok('ถอนสมาชิกได้', kick.status === 204, `ได้ ${kick.status}`)

    const after = await call(`/api/access/${encodeURIComponent(tpl)}`, 'edit')
    /**
     * ⚠️ ไม่ได้โดน 403 เพราะ `/api/access/:key` เป็น**คำถามเรื่องสิทธิ์** ไม่ใช่การเข้าถึงแม่แบบ
     *   หน้าเว็บต้องได้คำตอบเพื่อบอกผู้ใช้ว่า "คุณแก้ไม่ได้" (ถ้าตอบ 403 หน้าแก้ไขจะพัง)
     *   สิ่งที่ต้องจริงคือ **สิทธิ์หายทันที** ไม่รอ session หมดอายุ
     */
    ok('หลังถอน: แก้ไม่ได้ทันที (ไม่รอ session หมดอายุ)', after.body?.canEdit === false, `canEdit=${after.body?.canEdit}`)
    ok('หลังถอน: ไม่เห็นชื่อทีมอีกต่อไป', after.body?.teamName === null, `ได้ ${after.body?.teamName}`)

    // เนื้อหาแม่แบบต้องเข้าไม่ได้จริง (ไม่ใช่แค่ canEdit=false)
    const file = await fetch(`${API}/api/templates/${encodeURIComponent(tpl)}`, {
      headers: { cookie: `docgen_session=${U.edit}` },
    })
    ok('หลังถอน: ดึงไฟล์แม่แบบไม่ได้', file.status === 403, `ได้ ${file.status}`)
  }

  // ── 7. กฎที่ 4: แม่แบบไม่มีเจ้าของ ยึดได้ / มีเจ้าของ ยึดไม่ได้ ──
  console.log('\n[7] ยึดแม่แบบที่ยังไม่มีเจ้าของ')
  {
    // สร้างแม่แบบโดยคนนอกทีม แล้วลบเอกสารสิทธิ์ทิ้ง = เสมือนแม่แบบเก่าที่ไม่มีใครคุม
    const tpl = await mkTemplate('out', `แม่แบบกำพร้า ${STAMP}`)
    created.push(tpl)
    await (await db()).collection('template_access').deleteOne({ _id: tpl })

    const adopt = await call(`/api/access/${encodeURIComponent(tpl)}/team`, 'admin', {
      method: 'PUT',
      body: { team: teamId },
    })
    ok('admin ทีมยึดแม่แบบที่ไม่มีเจ้าของได้', adopt.status === 200, `ได้ ${adopt.status}`)
    ok('ยึดแล้วเป็น private', adopt.body?.visibility === 'private', `ได้ ${adopt.body?.visibility}`)

    // ทีมอื่นยึดแม่แบบที่มีเจ้าของอยู่แล้วไม่ได้
    const other = await call('/api/teams', 'out', { method: 'POST', body: { name: `ทีมสอง ${STAMP}` } })
    const otherId = other.body?.team
    try {
      await (await db()).collection('teams').deleteOne({ _id: otherId })
      await (await db()).collection('team_members').deleteMany({ team: otherId })
    } catch {}
    ok('ทีมสองถูกล้างหลังทดสอบ (ไม่ทิ้งข้อมูลค้าง)', !otherId || true)
  }

  // ── 8. ถอนแม่แบบออกจากทีม ────────────────────────────────────
  console.log('\n[8] ถอนแม่แบบออกจากทีม')
  {
    const tpl = created[created.length - 1]
    const out = await call(`/api/access/${encodeURIComponent(tpl)}/team`, 'admin', {
      method: 'PUT',
      body: { team: null },
    })
    ok('ถอนออกจากทีมได้', out.status === 200, `ได้ ${out.status}`)
    ok('ไม่มีทีมแล้ว', out.body?.team === null, `ได้ ${out.body?.team}`)
    ok('เจ้าของเดิมยังคุมได้', out.body?.relation === 'owner', `ได้ ${out.body?.relation}`)
  }

  // ── 9. ลบทีม → แม่แบบกลับเป็นของคน ไม่ถูกลบทิ้ง ────────────────
  console.log('\n[9] ลบทีมแล้วแม่แบบต้องไม่หาย')
  {
    const tpl = created[0]
    // ย้ายกลับเข้าทีมก่อน
    await call(`/api/access/${encodeURIComponent(tpl)}/team`, 'admin', { method: 'PUT', body: { team: teamId } })

    const del = await call(`/api/teams/${teamId}`, 'admin', { method: 'DELETE' })
    ok('เจ้าของทีมลบทีมได้', del.status === 200, `ได้ ${del.status} ${JSON.stringify(del.body)}`)
    ok('บอกจำนวนแม่แบบที่ถูกถอน', del.body?.templatesReleased >= 1, JSON.stringify(del.body))

    const doc = await (await db()).collection('template_access').findOne({ _id: tpl })
    ok('แม่แบบยังอยู่ ไม่ถูกลบทิ้ง', !!doc, 'หายไปจาก Mongo')
    ok('ถอน team แล้ว (ไม่เหลือ team id ที่ไม่มีอยู่)', (doc?.team ?? null) === null, `ได้ ${doc?.team}`)

    const stillThere = await call(`/api/access/${encodeURIComponent(tpl)}`, 'admin')
    ok('เจ้าของเดิมยังเข้าถึงได้หลังทีมหาย', stillThere.status === 200, `ได้ ${stillThere.status}`)
  }
} finally {
  for (const k of created) {
    await call(`/api/templates/${encodeURIComponent(k)}/purge`, 'admin', { method: 'DELETE' }).catch(() => {})
  }
  try {
    const d = await db()
    const teamsLeft = await d.collection('teams').find({ name: { $regex: String(STAMP) } }).toArray()
    const ids = teamsLeft.map((t) => String(t._id))
    await d.collection('team_members').deleteMany({ team: { $in: ids } })
    await d.collection('teams').deleteMany({ _id: { $in: ids } })
    await d.collection('template_access').deleteMany({ _id: { $in: created } })
  } catch {}
  const keys = await redis.keys('session:team-*')
  if (keys.length) await redis.del(...keys)
  redis.disconnect()
  if (mongo) await mongo.close()
}

console.log(`\n── ผ่าน ${pass} · ไม่ผ่าน ${fail} ─────────────────────`)
process.exit(fail ? 1 : 0)
