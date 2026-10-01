import { Redis } from 'ioredis'
const r = new Redis(process.env.VALKEY_URL)
const sid = 'verify-templates-' + Date.now()
await r.set(`session:${sid}`, JSON.stringify({ sub: 'verify-script', name: 'verify' }), 'EX', 300)
const h = { cookie: `docgen_session=${sid}` }
const res = await fetch('http://127.0.0.1:4001/api/templates', { headers: h })
const j = await res.json()
console.log(`สถานะ ${res.status} · ทั้งหมด ${j.items.length} รายการ\n`)
for (const t of j.items.sort((a,b)=>a.name.localeCompare(b.name,'th'))) {
  console.log(`  ${t.category.padEnd(18)} ${t.name}`)
}
const cats = await (await fetch('http://127.0.0.1:4001/api/templates/categories', { headers: h })).json()
const tags = await (await fetch('http://127.0.0.1:4001/api/templates/tags', { headers: h })).json()
console.log(`\nหมวด: ${cats.items.join(', ')}`)
console.log(`แท็ก: ${tags.items.join(', ')}`)
await r.del(`session:${sid}`)
r.disconnect()
