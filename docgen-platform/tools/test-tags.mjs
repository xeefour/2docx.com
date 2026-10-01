import { Redis } from 'ioredis'
const API='http://127.0.0.1:4001'
const r=new Redis(process.env.VALKEY_URL)
const sid='tags-'+Date.now()
await r.set(`session:${sid}`,JSON.stringify({sub:'tags'}),'EX',180)
const h={cookie:`docgen_session=${sid}`}
const list=await (await fetch(`${API}/api/templates`,{headers:h})).json()
console.log('แม่แบบ', list.items.length, 'ตัว\n')
for (const t of list.items.slice(0,3)) {
  const res=await fetch(`${API}/api/templates/${t.versionId}/tags`,{headers:h})
  if (!res.ok) { console.log(`✗ ${t.name} → ${res.status} ${(await res.text()).slice(0,120)}`); continue }
  const j=await res.json()
  console.log(`✓ ${t.name}`)
  console.log(`   แท็ก ${j.items.length} ตัว: ${j.items.slice(0,6).map(x=>x.path).join(', ')}${j.items.length>6?' …':''}`)
  console.log(`   sample: ${JSON.stringify(j.sample).slice(0,150)}`)
}
await r.del(`session:${sid}`); r.disconnect()
