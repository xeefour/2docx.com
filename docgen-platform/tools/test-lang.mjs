const H={Authorization:'Bearer '+process.env.DOCSERVER_API_KEY,'carbone-version':'5','Content-Type':'application/json'}
const tpl=(b)=>Buffer.from(`<html><body>${b}</body></html>`).toString('base64')
const data={ วันที่:'2026-09-30T00:00:00.000Z' }
const cases=[
  ['แยกสองแท็ก', `{d.วันที่:formatD('D MMMM')} {d.วันที่:formatD('YYYY'):add(543)}`],
  ['alias', `{#w = d.วันที่}{d.w:formatD('D MMMM')} {d.w:formatD('YYYY'):add(543)}`],
  ['วันย่อ+พ.ศ.', `{d.วันที่:formatD('D MMM')} {d.วันที่:formatD('YYYY'):add(543)}`],
  ['numeric พ.ศ.เต็ม', `{d.วันที่:formatD('YYYY'):add(543)}`],
]
for(const lang of ['en-us','th-th']){
  console.log(`\n───── ${lang} ─────`)
  for(const [label,tag] of cases){
    const r=await fetch('http://127.0.0.1:4000/render/template',{method:'POST',headers:H,
      body:JSON.stringify({template:tpl(`<p>${tag}</p>`),data,lang,timezone:'Asia/Bangkok',convertTo:'html'})})
    const j=await r.json(); if(!j.success){console.log(`  ${label.padEnd(16)} → ERROR`);continue}
    const res=await fetch(`http://127.0.0.1:4000/render/${j.data.renderId}`,{headers:H})
    console.log(`  ${label.padEnd(16)} → ${(await res.text()).replace(/<[^>]+>/g,'').trim()}`)
  }
}
