/**
 * คิว NATS ของ worker: งานที่เอกสารถูกลบแล้วต้องไม่วนลมพั่น
 *
 *   node --env-file=../dokploy-infra/.env --env-file=../dokploy-infra/.env.development tools/test-nats-queue.mjs
 *
 * ── ทำไมต้องมี ─────────────────────────────────────────────────
 * เคยมี log บวม 22,600 บรรทัด *"ยังไม่เจอเอกสารใน Mongo — ขอ NATS ส่งซ้ำ"*
 * และเทสต์เรนเดอร์ตกเป็นครั้งคราว (งานใหม่ต่อคิวหลังงานตาย) ต้นเหตุมี 2 ชั้น
 *
 *   1. API เขียน Mongo ก่อน publish เสมอ → matchedCount 0 = เอกสารถูกลบจริง
 *      แต่โค้ดเดิม nak(2_000) ให้ NATS ส่งซ้ำ → งานตายวนกลับมาทั้งสตรีม
 *   2. consumer เป็น ephemeral (ใส่แค่ name ไม่ใส่ durable_name)
 *      NATS ลบทิ้งเมื่อ worker หยุด แล้วตอน restart สร้างใหม่ด้วย deliver_policy: all
 *      → ไล่ส่งงานเก่าทั้งสตรีมกลับมาให้เรนเดอร์ซ้ำทุกครั้งที่ restart
 *
 * ── สิ่งที่ต้องผ่าน ─────────────────────────────────────────────
 *  1. consumer มี durable_name (ไม่ใช่ ephemeral)
 *  2. deliver_policy = new (ติดตั้งใหม่ไม่ต้องไล่งานเก่าทั้งสตรีม)
 *  3. worker heartbeat สด
 *  4. งานที่เอกสารถูกลบ → ไม่ถูกส่งซ้ำเลย (num_redelivered ไม่ขยับ)
 *  5. งานที่เอกสารถูกลบ → คิวกลับเป็นศูนย์ ไม่ค้างค้างเป็นหนี้
 *  6. ยิงทิ้ง 30 งาน (จำลองกองเก่า) → drain หมด ไม่มีส่งซ้ำสักครั้ง
 *  7. งานจริงยังเรนเดอร์สำเร็จ (ไม่พังเพราะ ack เร็วเกิน)
 *  8. health รายงานคิวค้าง 0
 */
import { connect } from 'nats'
import Redis from 'ioredis'
import { env, natsServers } from '@docgen/shared'

const API = process.env.API_URL ?? 'http://127.0.0.1:4001'
const STAMP = Date.now()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let pass = 0
let fail = 0
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`)
  ok ? pass++ : fail++
}

const redis = new Redis(process.env.VALKEY_URL)
/**
 * ⚠️ sid ต้องเป็น ASCII เท่านั้น — sid ไปอยู่ใน cookie ซึ่งเป็น HTTP header
 *    ถ้ามีอักษรไทย undici จะโยน "Cannot convert argument to a ByteString"
 */
const sid = `natsq-${STAMP}`
await redis.set(
  `session:${sid}`,
  JSON.stringify({ sub: sid, name: 'ผู้ทดสอบคิว', email: `natsq-${STAMP}@test.local`, avatar: '' }),
  'EX',
  1800,
)
const H = { cookie: `docgen_session=${sid}` }

const nc = await connect({ ...natsServers(), name: 'test-nats-queue' })
const js = await nc.jetstream()
const jsm = await nc.jetstreamManager()
const CONSUMER = 'render-worker'

const info = async () => jsm.consumers.info(env.NATS_STREAM, CONSUMER)
const waitIdle = async (ms = 8000) => {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    const i = await info()
    if (i.num_pending === 0 && i.num_ack_pending === 0) return i
    await sleep(300)
  }
  return info()
}

/** ยิงงานที่ "เอกสารไม่มีอยู่จริง" — เหมือนคนกดลบเอกสารทิ้งก่อน worker มาหยิบ */
const publishGhost = (n = 1) => {
  for (let k = 0; k < n; k++) {
    void js.publish(env.NATS_SUBJECT, JSON.stringify({
      documentId: `doc_ghost_${STAMP}_${k}`,
      templateId: 'ไม่มีอยู่จริง',
      outputFormat: 'pdf',
      data: {},
    }))
  }
}

console.log(`\n── คิว NATS (stream ${env.NATS_STREAM} · ${env.NATS_SUBJECT}) ────────\n`)

// ── 1–2 รูปแบบ consumer ───────────────────────────────────────
const start = await info()
check('consumer เป็น durable (ไม่ใช่ ephemeral)', !!start.config.durable_name, `durable_name = "${start.config.durable_name}"`)
check('deliver_policy = new', start.config.deliver_policy === 'new', start.config.deliver_policy)

// ── 3 worker ยังหายใจ ─────────────────────────────────────────
const health = await (await fetch(`${API}/api/health`)).json()
const workerCheck = health.checks.find((c) => c.id === 'worker')
check('worker heartbeat สด', workerCheck?.status === 'up', workerCheck?.detail ?? 'ไม่มีข้อมูล')

// ── 4–5 งานที่เอกสารถูกลบ → ทิ้งทันที ไม่วน ────────────────────
const redeliverBefore = start.num_redelivered
publishGhost(1)
await sleep(2500)
const mid = await info()
check('งานที่เอกสารถูกลบไม่ถูกส่งซ้ำ', mid.num_redelivered === redeliverBefore, `num_redelivered ${redeliverBefore} → ${mid.num_redelivered}`)
const afterOne = await waitIdle()
check('คิวกลับเป็นศูนย์เอง', afterOne.num_pending === 0 && afterOne.num_ack_pending === 0, `pending ${afterOne.num_pending} · รอ ack ${afterOne.num_ack_pending}`)

// ── 6 กองเก่า 30 งาน ต้อง drain เร็วและไม่ส่งซ้ำ ────────────────
const bulkStart = await info()
publishGhost(30)
const t0 = Date.now()
const drained = await waitIdle(15000)
const drainMs = Date.now() - t0
check('ยิงทิ้ง 30 งาน drain หมด', drained.num_pending === 0, `${drainMs} มิลลิวินาที`)
check('30 งานไม่มีส่งซ้ำสักครั้ง', drained.num_redelivered === bulkStart.num_redelivered, `num_redelivered = ${drained.num_redelivered}`)

// ── 7 งานจริงยังเรนเดอร์ได้ ────────────────────────────────────
const list = await (await fetch(`${API}/api/templates`, { headers: H })).json()
const tpl = list.items?.[0]
if (!tpl) {
  check('มีแม่แบบให้ทดสอบ', false, 'ไม่พบแม่แบบเลย')
} else {
  const created = await (
    await fetch(`${API}/api/documents`, {
      method: 'POST',
      headers: { ...H, 'content-type': 'application/json' },
      body: JSON.stringify({
        templateId: tpl.versionId,
        data: { 'ชื่อ-นามสกุล': 'สมชาย ใจดี' },
        outputFormat: 'docx',
        label: 'ทดสอบคิว NATS',
      }),
    })
  ).json()
  const id = created._id ?? created.documentId

  let doc = null
  for (let i = 0; i < 45; i++) {
    await sleep(700)
    const body = await (await fetch(`${API}/api/documents/${id}`, { headers: H })).json()
    doc = body.document ?? body
    if (doc?.status && ['done', 'failed'].includes(doc.status)) break
  }
  check('งานจริงยังเรนเดอร์สำเร็จ', doc?.status === 'done', `สถานะ = ${doc?.status ?? 'ไม่ทราบ'}`)
  if (doc?.status === 'done') {
    const file = await fetch(`${API}/api/documents/${id}/file`, { headers: H })
    const buf = Buffer.from(await file.arrayBuffer())
    check('ไฟล์ดาวน์โหลดได้และไม่ว่าง', file.ok && buf.length > 1000, `${(buf.length / 1024).toFixed(1)} KB`)
  }
  await fetch(`${API}/api/documents/${id}`, { method: 'DELETE', headers: H }).catch(() => {})
}

// ── 8 health รายงานคิวว่าง ─────────────────────────────────────
await sleep(500)
const health2 = await (await fetch(`${API}/api/health`)).json()
const worker2 = health2.checks.find((c) => c.id === 'worker')
check('health รายงานคิวค้าง 0', /คิวค้าง 0/.test(worker2?.detail ?? ''), worker2?.detail ?? 'ไม่มีข้อมูล')

console.log(`\n── ผ่าน ${pass} · ไม่ผ่าน ${fail} ─────────────────────\n`)

await nc.drain()
await redis.del(`session:${sid}`)
redis.disconnect()
process.exit(fail ? 1 : 0)
