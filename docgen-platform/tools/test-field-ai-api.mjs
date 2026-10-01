/**
 * ทดสอบ API "ช่วยช่องเดียว" โดยตรง (ไม่ผ่านหน้าเว็บ)
 *   node --env-file=.env tools/test-field-ai-api.mjs
 */
import { Redis } from 'ioredis'

const redis = new Redis(process.env.VALKEY_URL)
const sid = `field-${Date.now()}`
await redis.set(
  `session:${sid}`,
  JSON.stringify({ sub: sid, name: 'ผู้ทดสอบช่องเดียว', email: 'field@test.local', avatar: '' }),
  'EX',
  300,
)
const H = { cookie: `docgen_session=${sid}`, 'content-type': 'application/json' }
const API = 'http://127.0.0.1:4001'

/**
 * รอให้โควตา rate limit ว่างก่อนยิงจริง
 *
 * ⚠️ `test-rate-limit.mjs` ยิงจนล้นขีดจำกัด (600 req/นาที) ตามที่ตั้งใจทดสอบ
 *    ถ้ารันสคริปต์นั้นมาก่อนสคริปต์นี้ในหน้าต่างเดียวกัน
 *    ทุก request จะได้ 429 แล้วเทสต์รายงานว่า "AI เสีย" ทั้งที่ไม่ได้แตะ AI เลย
 *    → ต้องรอขอบต่างหน้าต่าง (window) หมดก่อน ไม่ใช่ตีความว่าพัง
 */
async function waitRateLimit(timeoutMs = 75_000) {
  const end = Date.now() + timeoutMs
  let waited = false
  while (Date.now() < end) {
    const r = await fetch(`${API}/api/health`).catch(() => null)
    if (r?.status === 200) {
      if (waited) console.log('  (รอโควตา rate limit หมดแล้ว)')
      return true
    }
    waited = true
    await new Promise((r) => setTimeout(r, 3000))
  }
  console.log('  ! ยังได้ 429 อยู่ — ผลข้างล่างอาจไม่น่าเชื่อถือ')
  return false
}
await waitRateLimit()

let pass = 0
let fail = 0
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`)
  ok ? pass++ : fail++
}

const key = String((await (await fetch(`${API}/api/templates`, { headers: H })).json()).items?.[0]?.id)
await fetch(`${API}/api/form/${key}`, {
  method: 'PUT',
  headers: H,
  body: JSON.stringify({
    fields: [
      { key: 'เรื่อง', label: 'เรื่อง', type: 'text', group: 'หนังสือ', order: 0, required: true },
      { key: 'สิ่งที่ขอ', label: 'สิ่งที่ขอ', type: 'textarea', group: 'เนื้อหา', order: 0 },
      { key: 'จำนวนเงิน', label: 'จำนวนเงิน', type: 'number', group: 'เนื้อหา', order: 1 },
    ],
  }),
})

const ask = (field, message) =>
  fetch(`${API}/api/chat`, {
    method: 'POST',
    headers: H,
    body: JSON.stringify({ templateKey: key, message, field, provider: 'mock', templateName: 'ทดสอบ' }),
  }).then(async (r) => ({ status: r.status, body: await r.json() }))

console.log('\n[1] ขอร่างข้อความให้ช่องที่ยังว่าง')
{
  const r = await ask({ key: 'เรื่อง', label: 'เรื่อง', type: 'text' }, 'ขออนุญาตเปลี่ยนประจำรถ')
  check('ตอบ 200', r.status === 200, `status=${r.status}`)
  check('เสนอค่าให้ช่องเดียว', typeof r.body?.data?.['เรื่อง'] === 'string', JSON.stringify(r.body?.data))
  check('ไม่แตะช่องอื่น', Object.keys(r.body?.data ?? {}).length === 1, Object.keys(r.body?.data ?? {}).join(','))
  check('มีคำแนะนำกลับมา', String(r.body?.reply ?? '').length > 0)
  check('ระบุ provider', r.body?.provider === 'mock', r.body?.provider)
}

console.log('\n[2] ช่องที่มีของเดิม — ต้องไม่ทับจนกว่าผู้ใช้กดยืนยัน')
{
  const r = await ask(
    { key: 'สิ่งที่ขอ', label: 'สิ่งที่ขอ', type: 'textarea', value: 'ขออนุญาตเปลี่ยนประจำรถคัน กข-1234' },
    'ช่วยแก้ให้สุภาพขึ้น',
  )
  check('ตอบ 200', r.status === 200, `status=${r.status}`)
  check('คืนข้อเสนอให้เลือกใส่', typeof r.body?.data?.['สิ่งที่ขอ'] === 'string')
  check('ระบุ key ที่เปลี่ยนได้ 1 ตัว', r.body?.changed?.length === 1, JSON.stringify(r.body?.changed))
}

console.log('\n[3] key ที่ไม่มีจริง — ต้องไม่ให้ AI แตะช่องอื่น')
{
  const r = await ask({ key: 'ไม่มีช่องนี้', label: 'ไม่มีช่องนี้', type: 'text' }, 'ร่างให้หน่อย')
  check('ตอบ 200', r.status === 200, `status=${r.status}`)
  check('ข้อมูลที่คืนมามีแค่ key ที่ถาม', Object.keys(r.body?.data ?? {}).every((k) => k === 'ไม่มีช่องนี้'))
}

console.log('\n[4] โหมดเติมฟอร์มปกติ ยังทำงานเหมือนเดิม (ไม่ใช่ field)')
{
  const r = await fetch(`${API}/api/chat`, {
    method: 'POST',
    headers: H,
    body: JSON.stringify({
      templateKey: key,
      message: 'ออกหนังสือรับรองให้นายสมชาย เรื่องขอเปลี่ยนประจำรถ',
      data: { เรื่อง: 'ค่าที่ผู้ใช้พิมพ์เอง' },
      provider: 'mock',
    }),
  }).then(async (r) => ({ status: r.status, body: await r.json() }))
  check('ตอบ 200', r.status === 200, `status=${r.status}`)
  check('ได้ sessionId จริง (ของเดิม)', String(r.body?.sessionId ?? '').startsWith('chat'), r.body?.sessionId)
  check('ไม่ทับค่าที่ผู้ใช้กรอกเอง', r.body?.data?.['เรื่อง'] === 'ค่าที่ผู้ใช้พิมพ์เอง', r.body?.data?.['เรื่อง'])
}

console.log('\n[5] ไม่บันทึกประวัติแชทของโหมดช่องเดียว')
{
  const before = (await (await fetch(`${API}/api/chat/sessions?templateKey=${key}`, { headers: H })).json()).items.length
  await ask({ key: 'เรื่อง', label: 'เรื่อง', type: 'text' }, 'ทดสอบว่าไม่บันทึกประวัติ')
  const after = (await (await fetch(`${API}/api/chat/sessions?templateKey=${key}`, { headers: H })).json()).items.length
  check('จำนวนแชทไม่เพิ่ม', before === after, `${before} → ${after}`)
}

await fetch(`${API}/api/form/${key}`, { method: 'DELETE', headers: H })
await redis.del(`session:${sid}`)
redis.disconnect()
console.log(`\n── ผ่าน ${pass} · ไม่ผ่าน ${fail} ─────────────────────\n`)
process.exit(fail ? 1 : 0)
