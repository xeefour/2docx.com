/**
 * ตรวจความถูกต้องของไฟล์ .docx ที่ระบบส่งออก หลังแก้ภาษาไทย
 *
 *   node --env-file=.env tools/check-xml.mjs
 *
 * ตรวจ 4 อย่างต่อหนึ่งแม่แบบ:
 *   1) w:lang อยู่ตำแหน่งถูกตาม schema CT_RPr ไหม
 *      (ต้องมาก่อน eastAsianLayout / specVanish / oMath / rPrChange
 *       และมาก่อน element ของ namespace อื่น เช่น w14:ligatures)
 *   2) แท็กในไฟล์ XML ที่แก้ ยัง balance อยู่ไหม (กันไฟล์เสีย)
 *   3) ทุก run ที่เป็นภาษาไทย ได้ w:lang ไหม
 *   4) LibreOffice เปิดแล้วแปลงเป็น PDF ได้ไหม ← หลักฐานแรงที่สุด
 */
import { Redis } from 'ioredis'
import { strFromU8, unzipSync } from 'fflate'

const API = 'http://127.0.0.1:4001'
const DOCSERVER = process.env.DOCSERVER_URL
const DOCSERVER_KEY = process.env.DOCSERVER_API_KEY
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * ตาม CT_RPr — ตัวเหล่านี้ต้องอยู่หลัง w:lang
 * (w:lang จึงต้องไม่มีอะไร "ผิดประเภท" มาแทรกอยู่ข้างหน้า)
 * ส่วน namespace อื่นอย่าง w14:ligatures ไม่ใช่สมาชิกของ CT_RPr
 * Word คาดว่ามันอยู่ท้ายสุด → w:lang ต้องมาก่อนเสมอ
 */
const AFTER_LANG = new Set(['w:eastAsianLayout', 'w:specVanish', 'w:oMath', 'w:rPrChange'])
const THAI = /[฀-๿]/
const LATIN = /[A-Za-z]/
const PATCHED = [
  /^word\/document\.xml$/,
  /^word\/header\d*\.xml$/,
  /^word\/footer\d*\.xml$/,
  /^word\/footnotes\.xml$/,
  /^word\/endnotes\.xml$/,
]

/** นับแท็กเปิด-ปิดแบบ stack — คืนชื่อแท็กที่ไม่เข้าคู่ ถ้าสมดุลคืน null */
function tagBalance(xml) {
  const stack = []
  const re = /<(\/?)([A-Za-z0-9:._-]+)((?:"[^"]*"|'[^']*'|[^>])*?)(\/?)>/g
  for (const m of xml.matchAll(re)) {
    const [, close, name, attrs, selfClose] = m
    if (close) {
      if (stack.pop() !== name) return name
    } else if (!selfClose && !attrs.trim().endsWith('/')) {
      stack.push(name)
    }
  }
  return stack.length ? `เหลือ ${stack.length} แท็ก: ${stack.slice(-3).join(', ')}` : null
}

const redis = new Redis(process.env.VALKEY_URL)
const sid = `xml-${Date.now()}`
await redis.set(
  `session:${sid}`,
  JSON.stringify({ sub: sid, name: 'ตรวจ xml', email: 'x@t.local', avatar: '' }),
  'EX',
  3600,
)
const H = { cookie: `docgen_session=${sid}`, 'content-type': 'application/json' }

const list = await (await fetch(`${API}/api/templates`, { headers: H })).json()

/** ตรวจทุกอย่างในไฟล์ docx ที่คลายออกมาแล้ว */
function inspect(files) {
  const issues = []
  let runs = 0
  let langs = 0
  let thaiRuns = 0
  let thaiWithoutLang = 0

  for (const [name, data] of Object.entries(files)) {
    const raw = strFromU8(data)

    if (PATCHED.some((re) => re.test(name))) {
      const unbalanced = tagBalance(raw)
      if (unbalanced) issues.push(`${name}: แท็กไม่สมดุล (${unbalanced})`)

      for (const m of raw.matchAll(/<w:r(?:\s[^>]*)?>[\s\S]*?<\/w:r>/g)) {
        const run = m[0]
        if (!/<w:t[ >]/.test(run)) continue
        runs++

        const text = [...run.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)].map((x) => x[1]).join('')
        const thai = (text.match(new RegExp(THAI, 'g')) ?? []).length
        const latin = (text.match(new RegExp(LATIN, 'g')) ?? []).length
        if (thai === 0) continue
        thaiRuns++

        // run ที่ไทยมากกว่าอังกฤษ ต้องมี w:lang th-TH
        if (thai >= latin) {
          const has = /<w:lang\b[^>]*w:val="th-TH"/.test(run)
          if (!has) thaiWithoutLang++
        }

        // ตำแหน่งตาม schema — ตัวที่ต้องอยู่ "หลัง" w:lang จะอยู่ข้างหลัง
        // ส่วน namespace อื่น (w14:*) ต้องอยู่หลังสุด ไม่งั้น w:lang ต้องมาก่อนมัน
        const rpr = run.match(/<w:rPr(?:\s[^>]*)?>([\s\S]*?)<\/w:rPr>/)
        if (rpr) {
          const kids = [...rpr[1].matchAll(/<([A-Za-z0-9]+:[A-Za-z0-9]+|[A-Za-z0-9]+)[\s/>]/g)].map((c) => c[1])
          const i = kids.indexOf('w:lang')
          if (i !== -1) {
            langs++
            // ตัวที่ห้ามอยู่ก่อน w:lang
            const before = kids.slice(0, i).find((k) => AFTER_LANG.has(k) || !k.startsWith('w:'))
            if (before) issues.push(`${name}: ${before} อยู่ก่อน w:lang (ผิดลำดับ schema)`)
          }
        }
      }
    }
  }

  if (thaiWithoutLang) issues.push(`run ไทยที่ยังไม่ได้ตั้งภาษา: ${thaiWithoutLang}`)
  return { issues, runs, langs, thaiRuns }
}

/** ให้ LibreOffice ลองเปิดแล้วแปลงเป็น PDF — พิสูจน์ว่าไฟล์ไม่เสีย */
async function canConvertToPdf(buf) {
  const res = await fetch(`${DOCSERVER}/render/template?download=true`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${DOCSERVER_KEY}`,
      'carbone-version': '5',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ template: buf.toString('base64'), data: {}, convertTo: 'pdf' }),
    signal: AbortSignal.timeout(90_000),
  }).catch((e) => ({ ok: false, statusText: String(e) }))

  if (!res.ok) return `แปลงไม่สำเร็จ (${res.statusText || res.status})`
  const out = Buffer.from(await res.arrayBuffer())
  return out.subarray(0, 4).toString('latin1') === '%PDF' ? null : 'ได้ไม่ใช่ PDF'
}

let bad = 0
let tested = 0

for (const tpl of list.items) {
  const created = await (
    await fetch(`${API}/api/documents`, {
      method: 'POST',
      headers: H,
      body: JSON.stringify({
        templateId: tpl.versionId,
        data: { 'ชื่อ-นามสกุล': 'สมชาย ใจดี', 'ชั้น': 'นายอำเภอเมืองชะบวง' },
        outputFormat: 'docx',
        label: 'xml-check',
      }),
    })
  ).json()
  if (!created?._id) {
    console.log(`✗ ${tpl.name} — สร้างเอกสารไม่ได้`)
    bad++
    continue
  }

  let doc
  for (let i = 0; i < 60; i++) {
    await sleep(700)
    doc = await (await fetch(`${API}/api/documents/${created._id}`, { headers: H })).json()
    if (doc.status === 'done' || doc.status === 'failed') break
  }
  if (doc.status !== 'done') {
    console.log(`✗ ${tpl.name} — เรนเดอร์ไม่สำเร็จ (${doc.status})`)
    bad++
    await fetch(`${API}/api/documents/${created._id}`, { method: 'DELETE', headers: { cookie: `docgen_session=${sid}` } })
    continue
  }

  const res = await fetch(`${API}/api/documents/${created._id}/file`, { headers: { cookie: `docgen_session=${sid}` } })
  const buf = Buffer.from(await res.arrayBuffer())
  const { issues, runs, langs, thaiRuns } = inspect(unzipSync(new Uint8Array(buf)))

  const conv = await canConvertToPdf(buf)
  if (conv) issues.push(`LibreOffice: ${conv}`)

  tested++
  if (issues.length) bad++

  const ok = issues.length === 0
  console.log(
    `${ok ? '✓' : '✗'} ${tpl.name.slice(0, 40).padEnd(40)} run ${String(runs).padStart(4)} · ไทย ${String(thaiRuns).padStart(3)} · lang ${String(langs).padStart(3)} · แปลง PDF ${conv ? 'ไม่ผ่าน' : 'ผ่าน'}`,
  )
  for (const i of [...new Set(issues)].slice(0, 4)) console.log(`     ↳ ${i}`)

  await fetch(`${API}/api/documents/${created._id}`, { method: 'DELETE', headers: { cookie: `docgen_session=${sid}` } })
}

console.log(`\n── รวม ${tested} แม่แบบ · ผ่าน ${tested - bad} · ไม่ผ่าน ${bad} ─────────────`)

await redis.del(`session:${sid}`)
redis.disconnect()
process.exit(bad ? 1 : 0)
