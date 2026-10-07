/**
 * สมัยกรองกล่องจดหมาย — ยิง API จริงด้วย 2 session เพื่อพิสูจน์ว่า
 * "เจ้าของแชร์แม่แบบ → คนอื่นได้รับจดหมาย" เดินทางถึงกล่องจริง
 *
 *   node --env-file=../dokploy-infra/.env --env-file=../dokploy-infra/.env.development tools/smoke-inbox.mjs
 */
import { Redis } from 'ioredis'
import { MongoClient } from 'mongodb'
import { resolveMongoUrl } from '@docgen/shared'

const API = process.env.API_URL ?? 'http://127.0.0.1:4001'
const STAMP = Date.now()
const redis = new Redis(process.env.VALKEY_URL ?? 'redis://127.0.0.1:6379')

const mkSession = async (tag) => {
  const sid = `${tag}-${STAMP}`
  await redis.set(
    `session:${sid}`,
    JSON.stringify({ sub: sid, name: tag, email: `${tag}@test.local`, avatar: '' }),
    'EX',
    900,
  )
  return sid
}
const OWNER = await mkSession('smokeowner')
const OTHER = await mkSession('smokeother')
const h = (sid) => ({ cookie: `docgen_session=${sid}` })

const json = async (path, opt = {}) => {
  const r = await fetch(`${API}${path}`, { ...opt, headers: { ...h(opt.sid ?? OWNER), ...(opt.headers ?? {}) } })
  const text = await r.text()
  let body = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = text
  }
  return { status: r.status, body }
}

let fails = 0
const check = (label, ok, detail = '') => {
  console.log(`${ok ? '  ✓' : '  ✗'} ${label}${detail ? ' — ' + detail : ''}`)
  if (!ok) fails++
}

// ── สร้างแม่แบบชั่วคราว ────────────────────────────────────────
// ⚠️ POST /api/templates รับเฉพาะ multipart (ไม่ใช่ JSON)
//    และต้องมีไฟล์จริง → ยืมไฟล์จากแม่แบบที่มีอยู่แล้วในระบบ
const listRes = await json('/api/templates')
const donor = (listRes.body?.items ?? []).find((t) => t.id ?? t.versionId)
check('มีแม่แบบเดิมให้ยืมไฟล์', !!donor, String(donor?.name ?? 'ไม่มี'))
if (!donor) {
  console.log('จบการทดสอบ — ไม่มีแม่แบบให้ยืมไฟล์')
  process.exit(1)
}
const donorId = String(donor.id ?? donor.versionId)
const donorBytes = new Uint8Array(
  await (await fetch(`${API}/api/templates/${encodeURIComponent(donorId)}`, { headers: h(OWNER) })).arrayBuffer(),
)
const TMP = `กล่องจดหมาย ${STAMP}`
const mk = new FormData()
mk.set('versioning', 'true')
mk.set('name', TMP)
mk.set('template', new Blob([donorBytes], { type: 'application/octet-stream' }), 'ต้นฉบับ.docx')
const up = await fetch(`${API}/api/templates`, { method: 'POST', headers: h(OWNER), body: mk })
const upBody = await up.json().catch(() => null)
const key = String(upBody?.id ?? upBody?.templateKey ?? upBody?.versionId ?? '')
check('สร้างแม่แบบได้', !!key, `key ${key} · HTTP ${up.status} · ${JSON.stringify(upBody)?.slice(0, 160)}`)
if (!key) {
  console.log('จบการทดสอบ — สร้างแม่แบบไม่ได้')
  process.exit(1)
}

/** ⚠️ ต้องส่งต่อ opt ให้ครบ มิฉะนั้นจะกลายเป็น GET เงียบ ๆ (เคยพลาดตอนแชร์แม่แบบ) */
const link = (p, opt) => json(p, opt)
const inboxOther = async () => (await link('/api/notifications', { sid: OTHER })).body
const inboxOwner = async () => (await link('/api/notifications', { sid: OWNER })).body

try {
  // ── ก่อนแชร์: กล่องว่าง ────────────────────────────────────
  const before = await inboxOther()
  check('ก่อนแชร์ กล่องของคนอื่นยังว่าง', before.unread === 0, `unread=${before.unread}`)

  // ── แชร์แม่แบบให้ OTHER ────────────────────────────────────
  const sh = await link(`/api/access/${encodeURIComponent(key)}/share`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sub: OTHER, name: 'คนอื่น', role: 'editor' }),
  })
  check('แชร์แม่แบบได้', sh.status === 200, `HTTP ${sh.status} · ${JSON.stringify(sh.body)?.slice(0, 200)}`)

  const afterShare = await inboxOther()
  check('คนอื่นได้รับจดหมาย 1 ฉบับ', afterShare.unread === 1, `unread=${afterShare.unread}`)
  check('เป็นประเภท "การแชร์"', afterShare.items?.[0]?.kind === 'share', afterShare.items?.[0]?.kind)
  check('ยังไม่อ่าน', afterShare.items?.[0]?.read === false)
  check(
    'ลิงก์ชี้ไปที่แม่แบบที่ถูกแชร์',
    afterShare.items?.[0]?.link === `/studio/${key}`,
    afterShare.items?.[0]?.link,
  )
  const ntfId = afterShare.items?.[0]?._id

  // ── กรองตามประเภท ────────────────────────────────────────────
  const onlyShare = await link('/api/notifications?kind=share', { sid: OTHER })
  check('กรองประเภท share ได้', onlyShare.body.items?.length === 1, `${onlyShare.body.items?.length} รายการ`)
  const onlyDoc = await link('/api/notifications?kind=document', { sid: OTHER })
  check('กรองประเภท document ได้ว่าง', onlyDoc.body.items?.length === 0, `${onlyDoc.body.items?.length} รายการ`)

  // ── อ่านแล้ว ─────────────────────────────────────────────────
  const rd = await link(`/api/notifications/${ntfId}/read`, { method: 'POST', sid: OTHER })
  check('ทำเครื่องหมายว่าอ่านแล้วได้', rd.status === 204, `HTTP ${rd.status}`)
  const afterRead = await inboxOther()
  check('จำนวนที่ยังไม่อ่านลดลงเป็น 0', afterRead.unread === 0, `unread=${afterRead.unread}`)
  check('รายการยังอยู่ (ไม่หายไป)', afterRead.total === 1, `total=${afterRead.total}`)

  // ── อ่านกล่องคนอื่นไม่ได้ ────────────────────────────────────
  const peek = await link(`/api/notifications/${ntfId}/read`, { method: 'POST', sid: OWNER })
  check('อ่านจดหมายของคนอื่นไม่ได้ (404)', peek.status === 404, `HTTP ${peek.status}`)

  // ── เปลี่ยนสิทธิ์ ────────────────────────────────────────────
  await link(`/api/access/${encodeURIComponent(key)}/share`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sub: OTHER, name: 'คนอื่น', role: 'viewer' }),
  })
  const afterRole = await inboxOther()
  check('เปลี่ยนสิทธิ์แล้วได้จดหมายประเภท "สิทธิ์"', afterRole.items?.[0]?.kind === 'access', afterRole.items?.[0]?.kind)

  // ── ถอนสิทธิ์ ────────────────────────────────────────────────
  await link(`/api/access/${encodeURIComponent(key)}/share/${encodeURIComponent(OTHER)}`, { method: 'DELETE' })
  const afterRevoke = await inboxOther()
  check('ถูกถอนสิทธิ์แล้วได้อีกฉบับ', afterRevoke.total === 3, `total=${afterRevoke.total}`)

  // ── unreadByKind ตรงกับของจริง ──────────────────────────────
  const sum = Object.values(afterRevoke.unreadByKind ?? {}).reduce((a, b) => a + b, 0)
  check('unreadByKind รวมกันตรงกับ unread', sum === afterRevoke.unread, `${sum} vs ${afterRevoke.unread}`)

  // ── ถังขยะ → แจ้งเจ้าของ ───────────────────────────────────
  // ⚠️ GET /templates/:id/trash เป็นแค่ "เช็คสถานะ" ไม่ใช่การลบ
  //    การส่งเข้าถังขยะคือ DELETE /api/templates/:id
  const tr = await link(`/api/templates/${encodeURIComponent(key)}`, { method: 'DELETE', sid: OWNER })
  check('ส่งแม่แบบเข้าถังขยะได้', tr.status === 200, `HTTP ${tr.status}`)
  const ownerInbox = await inboxOwner()
  check('เจ้าของได้รับจดหมาย "ใกล้ถูกลบถาวร"', ownerInbox.items?.some((n) => n.title.includes('ถูกลบถาวร')))

  // ── ล้างกล่อง ───────────────────────────────────────────────
  const clr = await link('/api/notifications', { method: 'DELETE', sid: OTHER })
  check('ล้างกล่องได้', clr.status === 200 && clr.body.deleted === 3, JSON.stringify(clr.body))
  const empty = await inboxOther()
  check('กล่องว่างหลังล้าง', empty.total === 0, `total=${empty.total}`)
} finally {
  // ── เก็บกวาด ────────────────────────────────────────────────
  await link(`/api/templates/${encodeURIComponent(key)}/purge`, { method: 'DELETE' }).catch(() => {})
  const c = new MongoClient(await resolveMongoUrl(() => {}))
  await c.connect()
  const db = c.db(process.env.MONGO_DB ?? 'app')
  await Promise.all([
    db.collection('notifications').deleteMany({ user: { $in: [OWNER, OTHER] } }),
    db.collection('template_access').deleteOne({ _id: key }),
    db.collection('template_tombstones').deleteOne({ _id: key }),
  ])
  await c.close()
  await redis.del(`session:${OWNER}`, `session:${OTHER}`)
  await redis.quit()
}

console.log(`\n${fails === 0 ? 'ผ่านทั้งหมด' : 'มี ' + fails + ' ข้อที่ตก'}`)
process.exit(fails === 0 ? 0 : 1)
