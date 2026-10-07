/**
 * วิเคราะห์: ถ้าจะเติม `w:jc="both"` ให้ย่อหน้าที่ "ไม่ได้ตั้งค่าไว้เลย" จะกระทบอะไรบ้าง
 *
 * ปัญหาจริง: แม่แบบ "สำเนา 3" ย่อหน้าเนื้อหาหลักไม่มี `w:jc` เลย
 *   (ส่วนสำเนา 1/2 มี) → จึงไม่ถูกกระจาย ไม่ว่าระบบจะแก้ตอนส่งออกหรือไม่ก็ตาม
 *
 * การเติมค่าให้ย่อหน้าที่ไม่ได้ตั้งไว้มีความเสี่ยง เพราะบางย่อหน้า
 * "ไม่ได้ตั้งค่า" โดยตั้งใจ เช่น ที่อยู่ที่จัดด้วย tab หรือช่องลงนามที่ตัดบรรทัดเอง
 *
 * สคริปต์นี้จึงเป็นตัวช่วยตัดสินใจ — แสดงว่ากฎแต่ละแบบจะไปแตะย่อหน้าไหนบ้าง
 * โดยยังไม่แก้อะไรจริง
 *
 *   node --env-file=../dokploy-infra/.env --env-file=../dokploy-infra/.env.development tools/analyze-unset-align.mjs
 */
import { unzipSync, strFromU8 } from 'fflate'

const H = { Authorization: `Bearer ${process.env.DOCSERVER_API_KEY}`, 'carbone-version': '5' }
const list = (await (await fetch(`${process.env.DOCSERVER_URL}/templates`, { headers: H })).json()).data ?? []

/** เอกลักษณ์ที่บอกว่าย่อหน้านี้ "ตั้งใจไม่ให้กระจาย" */
const SKIP = {
  hasBreak: (p) => (p.match(/<w:br\b/g) ?? []).length > 0,
  hasTab: (p) => /<w:tab\b/.test(p),
  inTable: (p, xml, at) => xml.lastIndexOf('<w:tbl>', at) > xml.lastIndexOf('</w:tbl>', at),
}

function analyse(t) {
  return fetch(`${process.env.DOCSERVER_URL}/template/${t.versionId}`, { headers: H })
    .then((r) => r.arrayBuffer())
    .then((b) => strFromU8(unzipSync(new Uint8Array(b))['word/document.xml']))
    .then((xml) => {
      const out = []
      // จับ <w:p> แบบไม่ซ้อน (ไม่รวม p ที่อยู่ในตาราง เพราะ regex จะจับผิดช่วง)
      for (const m of xml.matchAll(/<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g)) {
        const p = m[0]
        if (p.includes('<w:jc')) continue
        const text = [...p.matchAll(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g)].map((x) => x[1]).join('')
        const clean = text.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        if (clean.trim().length < 40) continue // สั้นเกินกว่าจะตัดบรรทัด → justify ไม่มีผลอยู่แล้ว
        out.push({
          len: clean.trim().length,
          text: clean.trim().slice(0, 46),
          ...Object.fromEntries(Object.entries(SKIP).map(([k, fn]) => [k, fn(p, xml, m.index)])),
        })
      }
      return out
    })
}

/** กฎที่เสนอ: ยาวพอจะตัดบรรทัด + ไม่มีขึ้นบรรทัดตายตัว + ไม่ใช้ tab + ไม่อยู่ในตาราง */
const rule = (c) => !c.hasBreak && !c.hasTab && !c.inTable

console.log('ย่อหน้าที่ "ไม่ได้ตั้ง w:jc" และยาวพอจะตัดบรรทัด\n')
console.log('กฎ: ยาว ≥40 ตัวอักษร · ไม่มี <w:br/> · ไม่ใช้ <w:tab/> · ไม่อยู่ในตาราง\n')

let wouldFix = 0
let wouldSkip = 0

for (const t of list.filter((x) => x.id)) {
  const rows = await analyse(t)
  if (rows.length === 0) continue

  const hit = rows.filter(rule)
  const skip = rows.filter((c) => !rule(c))

  console.log(`▸ ${t.name}`)
  for (const c of hit) {
    wouldFix++
    console.log(`   ✅ จะเติม both — ${c.len} ตัวอักษร · "${c.text}…"`)
  }
  for (const c of skip) {
    wouldSkip++
    const why = [c.hasBreak && 'มี <w:br/>', c.hasTab && 'ใช้ <w:tab/>', c.inTable && 'อยู่ในตาราง']
      .filter(Boolean)
      .join(' + ')
    console.log(`   ⏭  ข้าม (${why}) — "${c.text}…"`)
  }
  console.log()
}

console.log('─'.repeat(70))
console.log(`สรุป: จะเติม both ให้ ${wouldFix} ย่อหน้า · ข้าม ${wouldSkip} ย่อหน้า`)
console.log('ยังไม่ได้แก้อะไร — ใช้สคริปต์นี้ตัดสินใจก่อน')
