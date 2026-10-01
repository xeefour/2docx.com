import { Redis } from 'ioredis'
const API='http://127.0.0.1:4001'
const r=new Redis(process.env.VALKEY_URL)
const sid='wu-'+Date.now()
await r.set(`session:${sid}`,JSON.stringify({sub:'wu-demo'}),'EX',300)
const h={cookie:`docgen_session=${sid}`,'content-type':'application/json'}
const sleep=ms=>new Promise(x=>setTimeout(x,ms))
const t=(await (await fetch(`${API}/api/templates`,{headers:h})).json()).items[0]

// สร้าง 2 งาน — 1 ปล่อยให้เสร็จ 1 งานทิ้งไว้ให้ค้าง
const ids=[]
for(const lbl of ['เสร็จ','ค้าง']){
  const c=await (await fetch(`${API}/api/documents`,{method:'POST',headers:h,
    body:JSON.stringify({templateId:t.versionId,data:{},outputFormat:'pdf',label:'withUrl-'+lbl})})).json()
  ids.push({ id:c.documentId??c._id, lbl })
}
console.log('สร้าง:', ids.map(x=>`${x.lbl}=${x.id}`).join(' · '))

// รอให้ตัวแรกเสร็จ
for(let i=0;i<40;i++){ await sleep(1000); const b=await(await fetch(`${API}/api/documents/${ids[0].id}`,{headers:h})).json(); if(b.status==='done')break }
console.log(`เวลาผ่านไปพอให้ "${ids[0].lbl}" เสร็จ\n`)

for (const [label,qs] of [['ไม่ใส่ param (default)','/api/documents'],['?withUrl=true','/api/documents?withUrl=true'],['?withUrl=false','/api/documents?withUrl=false']]) {
  const l=await (await fetch(`${API+qs}`,{headers:h})).json()
  const rows=l.items.map(i=>`${i.status}`.padEnd(9)+(i.downloadUrl?'มีลิงก์':'null'))
  console.log(`${label.padEnd(22)} → ${rows.join(' | ')}`)
}

// ยิงลิงก์จากรายการจริง ๆ
const l=await (await fetch(`${API}/api/documents?withUrl=true`,{headers:h})).json()
const ready=l.items.find(i=>i.status==='done')
const dl=await fetch(ready.downloadUrl)
const buf=await dl.arrayBuffer()
console.log(`\nดาวน์โหลดจากลิงก์ในรายการ: ${dl.status} · ${buf.byteLength} bytes · magic ${Buffer.from(buf).subarray(0,5).toString('latin1')}`)

// ทำความเร็วเทียบ
for (const qs of ['/api/documents','/api/documents?withUrl=true']) {
  const t0=Date.now()
  for(let i=0;i<5;i++) await (await fetch(`${API+qs}`,{headers:h})).json()
  console.log(`${qs.padEnd(28)} 5 ครั้ง ใช้ ${Date.now()-t0}ms`)
}

for(const x of ids) await fetch(`${API}/api/documents/${x.id}`,{method:'DELETE',headers:h})
await r.del(`session:${sid}`); r.disconnect()
