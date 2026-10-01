/**
 * ตรวจ rate limit — ต้องเห็นว่าโควตาเพิ่มขึ้น และ /api/health ไม่กินโควตา
 *
 *   node --env-file=.env tools/test-rate-limit.mjs
 *
 * เคยเจอ: ค่าเดิม 100/นาที น้อยเกินไปสำหรับ Studio
 * → ระหว่างรันชุดทดสอบ API ตอบ 429 ทำให้เทสต์พังโดยไม่ได้ทำอะไรผิด
 */
import { Redis } from 'ioredis'

const API = 'http://127.0.0.1:4001'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let pass = 0
let fail = 0
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`)
  ok ? pass++ : fail++
}

const redis = new Redis(process.env.VALKEY_URL)
const sid = `rl-${Date.now()}`
await redis.set(
  `session:${sid}`,
  JSON.stringify({ sub: sid, name: 'ทดสอบ rate limit', email: 'rl@test.local', avatar: '' }),
  'EX',
  600,
)
const H = { cookie: `docgen_session=${sid}` }

const one = async (path) => {
  const res = await fetch(`${API}${path}`, { headers: H })
  return { status: res.status, limit: res.headers.get('x-ratelimit-limit'), left: res.headers.get('x-ratelimit-remaining') }
}

/**
 * รอให้หน้าต่างเวลาใหม่ก่อนเริ่ม
 *
 * ⚠️ เทสต์นี้เผาโควตาหมดโดยตั้งใจ ถ้าไม่รอ แล้วรันซ้ำตอนหน้าต่างเวลาเดิมยังไม่หมด
 *   ค่าที่เหลือจะเป็น 0 ตั้งแต่ต้น → เทสต์ "โควตาลดลง" พังทั้งที่ตัวระบบถูกต้อง
 */
const waitFreshWindow = async (limitMs = 70_000) => {
  const end = Date.now() + limitMs
  while (Date.now() < end) {
    const r = await one('/api/templates')
    if (r.limit && Number(r.left) >= Number(r.limit) - 5) return r
    await sleep(2_000)
  }
  return null
}

console.log('  … รอหน้าต่างเวลา rate limit หมดรอบใหม่')
const fresh = await waitFreshWindow()
check('เริ่มต้นด้วยหน้าต่างเวลาที่สะอาด (ยังไม่เคยยิงเต็ม)', fresh !== null, fresh ? `เหลือ ${fresh.left}/${fresh.limit}` : 'รอไม่สำเร็จ')

const first = fresh ?? (await one('/api/templates'))
check('มี header rate limit', first.limit !== null, `limit=${first.limit} · เหลือ=${first.left}`)
check('โควตาไม่ใช่ 100/นาที (ค่าเดิมที่แคบเกินไป)', first.limit === '600', `ได้ ${first.limit}`)

const before = Number(first.left)
for (let i = 0; i < 20; i++) await one('/api/templates')
const after = await one('/api/templates')
check('ยิง 21 ครั้งแล้วโควตาลดลงจริง', Number(after.left) === before - 21, `${before} → ${after.left}`)

// /api/health ต้องไม่กินโควตา
const h1 = await one('/api/health')
for (let i = 0; i < 30; i++) await one('/api/health')
const h2 = await one('/api/health')
check(
  '/api/health ไม่กินโควตาของผู้ใช้ (allowList)',
  h1.left === h2.left,
  `ก่อน ${h1.left} · หลังยิง health 30 ครั้ง ${h2.left}`,
)

// ยิงจนโควตาหมด ต้องได้ 429 พร้อมบอกว่ารอนานเท่าไร
let got429 = null
for (let i = 0; i < 700; i++) {
  const r = await one('/api/templates')
  if (r.status === 429) {
    got429 = r
    break
  }
  if (i % 100 === 0) await sleep(50)
}
check('ยิงจนเต็มโควตาแล้วได้ 429', got429 !== null, got429 ? `โดนตอนคำขอที่ ~${600}` : 'ไม่โดน 429 เลย')

if (got429) {
  const res = await fetch(`${API}/api/templates`, { headers: H })
  const retry = res.headers.get('retry-after')
  const body = await res.text()
  check('429 มี retry-after', retry !== null, `${retry} วินาที`)
  check('429 ตอบเป็น JSON (หน้าเว็บแสดงข้อความได้)', body.trim().startsWith('{'), body.slice(0, 80))

  // หัวใจของ allowList — ตอนที่โควตาหมดจริง health ยังต้องตอบ 200
  const health = await one('/api/health')
  check(
    'โควตาหมดแล้ว /api/health ยังตอบ 200 (ประวัติภาพต้องไม่ถูกล็อกตามผู้ใช้)',
    health.status === 200,
    `ได้ ${health.status}`,
  )
}

await redis.del(`session:${sid}`)
redis.disconnect()
console.log(`\n── ผ่าน ${pass} · ไม่ผ่าน ${fail} ─────────────────────\n`)
process.exit(fail ? 1 : 0)
