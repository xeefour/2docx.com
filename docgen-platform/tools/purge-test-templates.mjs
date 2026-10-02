/**
 * เก็บกวาดแม่แบบที่หลงเหลือจากการทดสอบ (Carbone ลบแบบ soft-delete — รายการยังโชว์)
 *
 *   node --env-file=.env tools/purge-test-templates.mjs
 *
 * ⚠️ ลบเฉพาะชื่อที่ขึ้นต้นด้วยคำนำหน้าของสคริปต์ทดสอบเท่านั้น เพื่อไม่ไปแตะแม่แบบจริง
 */
import { Redis } from 'ioredis'
import { resolveMongoUrl } from '@docgen/shared'
import { MongoClient } from 'mongodb'

const API = 'http://127.0.0.1:4001'

/** ชื่อแม่แบบที่สคริปต์ทดสอบสร้าง — ห้ามลบอย่างอื่นนอกจากนี้ */
const TEST_PREFIXES = [
  'ทดสอบดาวน์โหลด-แทนที่-',
  'probe-list-',
  'probe-dep-',
  'probe-single-',
  'leak-probe-',
]

const redis = new Redis(process.env.VALKEY_URL)
const sid = `purge-${Date.now()}`
await redis.set(`session:${sid}`, JSON.stringify({ sub: sid, name: 'purge', email: 'p@t.local', avatar: '' }), 'EX', 900)
const H = { cookie: `docgen_session=${sid}` }

const items = (await (await fetch(`${API}/api/templates`, { headers: H })).json()).items ?? []
console.log(`แม่แบบทั้งหมด ${items.length} รายการ`)

const victims = items.filter((t) => TEST_PREFIXES.some((p) => (t.name ?? '').startsWith(p)))
if (victims.length === 0) {
  console.log('ไม่มีแม่แบบทดสอบค้าง — ไม่ต้องลบอะไร')
} else {
  for (const v of victims) {
    const r = await fetch(`${API}/api/templates/${v.id}/purge`, { method: 'DELETE', headers: H })
    console.log(`  ลบ "${v.name}" (${v.id}) → HTTP ${r.status}`)
  }
}

/** ล้างสิทธิ์ที่ค้างจาก session ที่ตายแล้ว ป้องกันแม่แบบถูกล็อก */
const url = await resolveMongoUrl(() => {})
const c = new MongoClient(url)
await c.connect()
const db = c.db(process.env.MONGO_DB ?? 'app')
const res = await db.collection('template_access').deleteMany({
  owner: /^(tplfile-|myhistui-|myhist-|dbg-|probe|leak|purge|shot-|edit-)/,
})
console.log(`ล้างสิทธิ์เจ้าของที่ค้างจาก session ทดสอบ: ${res.deletedCount} รายการ`)
await c.close()

const after = (await (await fetch(`${API}/api/templates`, { headers: H })).json()).items ?? []
console.log(`\nเหลือ ${after.length} รายการ:`)
for (const t of after.slice(0, 25)) console.log('  -', t.name, `(${t.id})`)

await redis.del(`session:${sid}`)
redis.disconnect()
