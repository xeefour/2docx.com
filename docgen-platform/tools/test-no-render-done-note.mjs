/**
 * เรนเดอร์สำเร็จแล้วต้องไม่มีจดหมายโผล่ในกล่อง
 *
 *   node --env-file=../dokploy-infra/.env --env-file=../dokploy-infra/.env.development tools/test-no-render-done-note.mjs
 *
 * ── ผู้ใช้สั่ง ──────────────────────────────────────────────────────
 * *"แจ้งเตือนเอกสารเรนเดอร์เสร็จแล้ว แต่เปิดเข้าไปไม่พบ key
 *   อันนี้ไม่ต้องแจ้งเตือนก็ได้ เนื่องจากเรนเดอร์เร็วมากไม่ต้องรอ"*
 *
 * ── ทำไมต้องรันเอกสารจริง ไม่ใช่แค่ดูโค้ด ─────────────────────────────
 * จุดที่ตัดออกอยู่ใน worker ซึ่งเป็นโปรเซสแยกจาก API
 *   ดูแค่โค้ดแล้วผ่าน แต่พิสูจน์ไม่ได้ว่า "จดหมายไม่โผล่จริง"
 * เทสต์นี้จึงสร้างเอกสารจริงผ่าน API แล้วเดินเส้นทางเดียวกับผู้ใช้:
 *   POST /api/documents → NATS → worker → Carbone → กล่องจดหมาย
 *
 * ⚠️ ต้องรันหลัง worker restart แล้วเท่านั้น (tsx --watch จัดการให้)
 */
import Redis from 'ioredis'
import { readFileSync } from 'node:fs'
import { natsServers, env } from '@docgen/shared'

const API = process.env.API_URL ?? 'http://127.0.0.1:4001'
const STAMP = Date.now()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let pass = 0
let fail = 0
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`)
  ok ? pass++ : fail++
}

/** หัวข้อที่ตัดไปแล้ว — ถ้าหลุดกลับมาแปลว่าโค้ดถูกเพิ่มคืนโดยไม่ตั้งใจ */
const REMOVED_TITLE = 'เอกสารเรนเดอร์เสร็จแล้ว'
const KEPT_TITLE = 'เอกสารเรนเดอร์ไม่สำเร็จ'

const redis = new Redis(process.env.VALKEY_URL)
/** sid ต้องเป็น ASCII — sid ไปอยู่ใน cookie ซึ่งเป็น HTTP header */
const sid = `notedone-${STAMP}`
await redis.set(
  `session:${sid}`,
  JSON.stringify({ sub: sid, name: 'ผู้ทดสอบจดหมาย', email: `notedone-${STAMP}@test.local`, avatar: '' }),
  'EX',
  1800,
)
const H = { cookie: `docgen_session=${sid}` }

const inbox = async () => {
  const r = await fetch(`${API}/api/notifications?kind=document&limit=100`, { headers: H })
  const b = await r.json()
  return b.items ?? b.notifications ?? []
}

console.log(`\n── เรนเดอร์สำเร็จแล้วต้องไม่มีจดหมาย ────────\n`)

const before = await inbox()
check('อ่านกล่องจดหมายก่อนเริ่มได้', Array.isArray(before), `${before.length} ฉบับ`)

const list = await (await fetch(`${API}/api/templates`, { headers: H })).json()
const tpl = list.items?.[0]
if (!tpl) {
  check('มีแม่แบบให้ทดสอบ', false, 'ไม่พบแม่แบบเลย')
} else {
  const created = await (
    await fetch(`${API}/api/documents`, {
      method: 'POST',
      headers: { ...H, 'content-type': 'application/json' },
      body: JSON.stringify({
        templateId: tpl.versionId,
        data: { 'ชื่อ-นามสกุล': 'สมชาย ใจดี' },
        outputFormat: 'docx',
        label: 'ทดสอบไม่ต้องแจ้งเตือน',
      }),
    })
  ).json()
  const id = created._id ?? created.documentId
  check('สร้างเอกสารผ่าน API ได้', !!id, String(id))

  let doc = null
  for (let i = 0; i < 60; i++) {
    await sleep(700)
    const body = await (await fetch(`${API}/api/documents/${id}`, { headers: H })).json()
    doc = body.document ?? body
    if (doc?.status && ['done', 'failed'].includes(doc.status)) break
  }
  // ให้ worker มีเวลาเขียนจดหมายถ้ายังจะเขียน (ตอนนี้ไม่ควรเขียน)
  await sleep(2500)

  check('เอกสารเรนเดอร์สำเร็จจริง', doc?.status === 'done', `สถานะ = ${doc?.status ?? 'ไม่ทราบ'}`)

  const after = await inbox()
  const fresh = after.filter((n) => !before.some((b) => b._id === n._id))
  console.log('    จดหมายใหม่:', fresh.length ? fresh.map((n) => n.title).join(' | ') : '(ไม่มี)')

  check('ไม่มีจดหมายใหม่โผล่หลังเรนเดอร์เสร็จ', fresh.length === 0, `${fresh.length} ฉบับ`)
  check(
    `ไม่มีจดหมายหัวข้อ "${REMOVED_TITLE}"`,
    !after.some((n) => n.title === REMOVED_TITLE),
  )

  await fetch(`${API}/api/documents/${id}`, { method: 'DELETE', headers: H }).catch(() => {})
}

// ── โค้ด: ตัดเฉพาะตัวที่ผู้ใช้สั่ง ตัวแจ้งล้มเหลวต้องยังอยู่ ───────────
console.log('\n[2] โค้ด worker — ตัดตัวสำเร็จอย่างเดียว ตัวล้มเหลวต้องไม่หายไปด้วย')
{
  const src = readFileSync('D:/2docx.com/docgen-platform/apps/worker/src/index.ts', 'utf8')
  // ⚠️ ต้องเจาะฟิลด์ `title:` ไม่ใช่ค้นทั้งไฟล์ — คอมเมนต์ที่อ้างคำสั่งผู้ใช้
  //    มีชื่อหัวข้อนี้อยู่แล้ว การค้นสตริงดิบจะผ่านทั้งที่โค้ดยังส่งจดหมายอยู่
  check(
    `ไม่มีฟิลด์ title: "${REMOVED_TITLE}" ในโค้ดแล้ว`,
    !src.includes(`title: '${REMOVED_TITLE}'`),
  )
  check(
    `ยังมีฟิลด์ title: "${KEPT_TITLE}" (ล้มเหลวต้องแจ้ง)`,
    src.includes(`title: '${KEPT_TITLE}'`),
  )
  check('ลิงก์ไม่ชี้ไป /studio/<templateId> ที่ตายแล้ว', !src.includes('/studio/${templateId}'))
}

console.log(`\n── ผ่าน ${pass} · ไม่ผ่าน ${fail} ─────────────────────\n`)

await redis.del(`session:${sid}`)
redis.disconnect()
process.exit(fail ? 1 : 0)
