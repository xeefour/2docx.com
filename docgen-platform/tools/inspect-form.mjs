/** ตรวจสภาพช่องกรอกของแม่แบบที่ใช้ร่วมกัน — หลังรันเทสต์ไปมา */
import { Redis } from 'ioredis'

const API = 'http://127.0.0.1:4001'
const redis = new Redis(process.env.VALKEY_URL)
const sid = 'inspect-form-' + Date.now()
await redis.set(`session:${sid}`, JSON.stringify({ sub: sid, name: 'ตรวจ', email: 'i@t.local', avatar: '' }), 'EX', 600)
const H = { cookie: `docgen_session=${sid}` }

const items = (await (await fetch(`${API}/api/templates`, { headers: H })).json()).items ?? []
console.log('แม่แบบทั้งหมด:', items.length)
for (const [i, t] of items.slice(0, 5).entries()) {
  const form = await (await fetch(`${API}/api/form/${t.id}`, { headers: H })).json().catch(() => null)
  const f = form?.fields ?? []
  const writable = f.filter((x) => ['text', 'textarea', 'email', 'date', 'number', 'integer'].includes(x.type))
  console.log(
    `  [${i}] ${t.name} (${t.id})\n      ช่องทั้งหมด ${f.length} · ช่องที่พิมพ์ได้ ${writable.length} · ${f.map((x) => x.type).join(',')}`,
  )
  const acc = await (await fetch(`${API}/api/access/${t.id}`, { headers: H })).json().catch(() => null)
  console.log(`      สิทธิ์: relation=${acc?.relation} canEdit=${acc?.canEdit} owner=${acc?.owner ?? '(ไม่มี)'}`)
}

await redis.del(`session:${sid}`)
redis.disconnect()
