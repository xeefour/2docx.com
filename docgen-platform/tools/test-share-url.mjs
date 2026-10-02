/**
 * ตรวจลิงก์สาธารณในแท็บ "แม่แบบ & การแชร์"
 *
 *   node --env-file=.env tools/test-share-url.mjs
 *
 * ── ทำไมต้องมี ─────────────────────────────────────────────────
 * ผู้ใช้สั่ง: *"เลือกเปิดสาธารณแล้ว ให้แสดง url ด้วย"*
 *
 *   เดิมกด "เปิดสาธารณ" ได้แค่ข้อความว่าเปิดแล้ว แต่ผู้ใช้ยังหา**ลิงก์ที่จะส่ง**
 *   ไม่เจอ ต้องไปเดาเองจากแถบ URL มุมล่าง
 *
 * ── สิ่งที่ต้องผ่าน ─────────────────────────────────────────────
 * 1. แม่แบบที่ยังไม่มีเจ้าของ → ต้องเห็นปุ่ม "เปิดสาธารณ" (คนแรกที่ตั้งค่าคือเจ้าของ)
 * 2. เปิดสาธารณแล้ว → ลิงก์ต้องโผล่
 * 3. ลิงก์ต้อง**ไม่มี query string** (`?tabs=…&pane=…` ติดมาตอนผู้ใช้เปิดอยู่ในแท็บ)
 *    และต้องชี้ไปที่ key ของแม่แบบนี้จริง ไม่ใช่แม่แบบอื่น
 * 4. ลิงก์ต้องไม่ล้นการ์ดตอนจอแคบ (`scrollWidth - clientWidth` = 0)
 * 5. ปุ่มคัดลอกต้องกดได้จริง และกดแล้วมีข้อความตอบกลับ
 * 6. กลับเป็นแบบส่วนตัว → ลิงก์ต้องหาย (ไม่ค้างให้ส่งลิงก์คนอื่นต่อ)
 * 7. เก็บกวาด: ลบแม่แบบชั่วคราว + ลบเอกสารสิทธิ์ที่ค้าง
 *
 * ⚠️ สคริปต์นี้**สร้างแม่แบบชั่วคราวเอง** แล้วลบทิ้งตอนจบ
 *    เคยใช้แม่แบบจริงของผู้ใช้ตอนทดสอบ → เปลี่ยนสิทธิ์ของคนอื่นโดยไม่ตั้งใจ
 *    (ตาราง "คุณเป็นเจ้าของแม่แบบนี้" ของผู้ใช้จะเพี้ยนทันที)
 *
 * ⚠️ ชุดนี้**ไม่ต้องเรนเดอร์เอกสาร** → ไม่ตกกับคิว NATS ต่างจากชุดอื่น
 */
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Redis } from 'ioredis'
import { resolveMongoUrl } from '@docgen/shared'
import { MongoClient } from 'mongodb'

const API = process.env.API_URL ?? 'http://127.0.0.1:4001'
const WEB = 'http://localhost:3000'
const CHROME = process.env.CHROME_PATH ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const PORT = 9378
const STAMP = Date.now()
const OUT = new URL('../tests/nav-status/output-share/', import.meta.url)
mkdirSync(OUT, { recursive: true })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let pass = 0
let fail = 0
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`)
  ok ? pass++ : fail++
}

const redis = new Redis(process.env.VALKEY_URL)
const sid = `shareurl-${STAMP}`
await redis.set(
  `session:${sid}`,
  JSON.stringify({ sub: sid, name: 'ผู้ทดสอบลิงก์', email: 'shareurl@test.local', avatar: '' }),
  'EX',
  900,
)
const H = { cookie: `docgen_session=${sid}`, 'content-type': 'application/json' }
/**
 * ⚠️ ห้ามส่ง `content-type: application/json` ไปกับ DELETE ที่ไม่มี body
 *    Fastify ตอบ 500 ว่า *"Body cannot be empty when content-type is set to
 *    'application/json'"* → ลบไม่ออก → แม่แบบชั่วคราวค้างในรายการ
 *    แล้วไปเป็น `items[0]` ของเทสต์อื่น (เคยเจจริง)
 *    ตัวแอปเองมีกฎนี้อยู่แล้วที่ `lib/api.ts` (`hasBody` ตรวจก่อนตั้ง header)
 */
const H_NO_BODY = { cookie: `docgen_session=${sid}` }

/** ลบเอกสารสิทธิ์ตรง ๆ — เจ้าของอาจเป็น session ที่หมดอายุแล้ว */
const wipeAccess = async (templateKey) => {
  const url = await resolveMongoUrl((m) => console.log('   ', m))
  const c = new MongoClient(url)
  await c.connect()
  await c.db(process.env.MONGO_DB ?? 'app').collection('template_access').deleteOne({ _id: templateKey })
  await c.close()
}

// ── 0. แม่แบบชั่วคราว ───────────────────────────────────────────
console.log('\n[0] เตรียมแม่แบบชั่วคราว (ไม่แตะแม่แบบจริงของผู้ใช้)')
const TMP_PREFIX = 'ทดสอบลิงก์สาธารณ-'
{
  const ghosts = (await (await fetch(`${API}/api/templates`, { headers: H })).json()).items ?? []
  for (const g of ghosts.filter((t) => (t.name ?? '').startsWith(TMP_PREFIX))) {
    await fetch(`${API}/api/templates/${g.id}`, { method: 'DELETE', headers: H_NO_BODY })
    await wipeAccess(g.id)
  }
}
const list = (await (await fetch(`${API}/api/templates`, { headers: H })).json()).items ?? []
const donor = list.find((t) => (t.name ?? '').includes('หัวกระดาษ')) ?? list[0]
if (!donor) {
  console.log('✗ ไม่มีแม่แบบในระบบให้ใช้เป็นต้นแบบ')
  process.exit(1)
}
const donorBytes = new Uint8Array(
  await (await fetch(`${API}/api/templates/${donor.id}`, { headers: H })).arrayBuffer(),
)
const createForm = new FormData()
createForm.set('versioning', 'true')
createForm.set('name', `${TMP_PREFIX}${STAMP}`)
createForm.set('category', 'ทดสอบ')
createForm.set('template', new Blob([donorBytes], { type: 'application/octet-stream' }), 'ต้นฉบับ.docx')
const created = await (
  await fetch(`${API}/api/templates`, { method: 'POST', headers: { cookie: H.cookie }, body: createForm })
).json()
const key = String(created?.id ?? created?.templateId ?? '')
check('สร้างแม่แบบชั่วคราวได้', !!key, `key ${key}`)

const cleanup = async (why) => {
  console.log(`\n[เก็บกวาด] ${why}`)
  const r = await fetch(`${API}/api/templates/${key}`, { method: 'DELETE', headers: H_NO_BODY })
  console.log(`   ลบแม่แบบ → HTTP ${r.status}`)
  /**
   * ⚠️ ต้อง**ยืนยันว่าลบสำเร็จจริง** ไม่ใช่แค่ดูสถานะแล้วเดินต่อ
   *   ถ้าลบไม่ได้ แม่แบบชั่วคราวจะค้างในรายการ แล้วไปเป็น `items[0]`
   *   ของเทสต์อื่น → เทสต์อื่นตกเพราะเลย์เอาต์ไม่ตรง (เคยเกิดจริงกับการ์ดฟาร์ม)
   */
  const after = (await (await fetch(`${API}/api/templates`, { headers: H_NO_BODY })).json()).items ?? []
  const still = after.some((t) => String(t.id ?? t.versionId) === key)
  check('ลบแม่แบบชั่วคราวสำเร็จ (ไม่ค้างให้เทสต์อื่น)', !still, still ? 'ยังอยู่ในรายการ!' : `HTTP ${r.status}`)
  await wipeAccess(key)
  await redis.del(`session:${sid}`)
  redis.disconnect()
  return !still
}

// ── เบราว์เซอร์ ────────────────────────────────────────────────
const profile = mkdtempSync(join(tmpdir(), 'cdp-shareurl-'))
const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--no-first-run',
    '--window-size=1600,1000',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    'about:blank',
  ],
  { stdio: 'ignore' },
)
let wsUrl = null
for (let i = 0; i < 40 && !wsUrl; i++) {
  await sleep(500)
  try {
    const l = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
    wsUrl = l.find((x) => x.type === 'page')?.webSocketDebuggerUrl
  } catch {}
}
const ws = new WebSocket(wsUrl)
let seq = 0
const waiting = new Map()
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++seq
    waiting.set(id, { resolve, reject })
    ws.send(JSON.stringify({ id, method, params }))
  })
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data)
  const s = waiting.get(m.id)
  if (!s) return
  waiting.delete(m.id)
  m.error ? s.reject(new Error(JSON.stringify(m.error))) : s.resolve(m.result)
})
await new Promise((r) => ws.addEventListener('open', r, { once: true }))
const evaluate = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text)
  return r.result?.value
}
const waitFor = async (expr, ms = 20000) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    try {
      if (await evaluate(expr)) return true
    } catch {}
    await sleep(250)
  }
  return false
}
const shot = async (name) => {
  const { data } = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(new URL(name, OUT), Buffer.from(data, 'base64'))
}
/** กดด้วยเมาส์จริง + ยืนยันว่ามีอะไรมาบังปุ่มที่จุดนั้นหรือไม่ */
const clickTestId = async (id) => {
  const box = await evaluate(`(() => {
    const el = document.querySelector('[data-testid=${JSON.stringify(id)}]')
    if (!el) return null
    el.scrollIntoView({ block: 'center' })
    const r = el.getBoundingClientRect()
    const x = r.x + r.width / 2, y = r.y + r.height / 2
    const hit = document.elementFromPoint(x, y)
    return { ok: !!hit && (el.contains(hit) || hit === el), x, y, disabled: el.disabled }
  })()`)
  if (!box?.ok) return box
  if (box.disabled) return { ...box, ok: false, why: 'ปุ่มถูก disable' }
  for (const type of ['mousePressed', 'mouseReleased'])
    await send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 })
  return box
}

await send('Page.enable')
await send('Runtime.enable')
await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false })
await send('Network.setCookie', { name: 'docgen_session', value: sid, url: WEB })
await send('Network.setCacheDisabled', { cacheDisabled: true })

// ── 1. เปิดแท็บแม่แบบ ──────────────────────────────────────────
console.log('\n[1] เปิดแท็บ "แม่แบบ & การแชร์"')
await send('Page.navigate', { url: `${WEB}/studio/${key}?tabs=form&pane=template` })
await waitFor('!document.querySelector(".bootveil")', 45000)
const opened = await waitFor('!!document.querySelector("[data-testid=\\"share-publish\\"]")', 30000)
check('เปิดแท็บได้และเห็นปุ่ม "เปิดสาธารณ"', opened)
/**
 * ⚠️ แม่แบบที่ยังไม่เคยตั้งค่าสิทธิ์ = **เปิดสาธารณเป็นค่าเริ่มต้น**
 *   (ไม่ใช่ส่วนตัว) ตรงกับคำอธิบายปุ่ม "ล้างการตั้งค่า" ในหน้าเว็บ
 *
 *   เคยใช้ผิดตรงนี้ตอนเขียนเทสต์รอบแรก โดยคาดว่าตอนแรกต้องเป็นส่วนตัว
 *   ผลคือข้อ "ยังไม่มีลิงก์ตอนยังไม่เปิดสาธารณ" ตกทันที
 *
 *   แต่จริง ๆ นี่คือ**หลักฐานว่าปัญหาของผู้ใช้หนักกว่าที่คิด**:
 *   แม่แบบใหม่ทุกตัวเปิดสาธารณอยู่แล้ว แต่เดิมไม่มีที่ไหนให้ดูลิงก์เลย
 *   → ต้องทดสอบทั้งสองทางของสวิตช์ ไม่ใช่แค่ทางเดียว
 */
check(
  'แม่แบบที่ยังไม่ตั้งค่าสิทธิ์ = เปิดสาธารณ (ค่าเริ่มต้น) และต้องเห็นลิงก์',
  await evaluate("!!document.querySelector('[data-testid=\"share-public-url\"]')"),
)
await shot('01-default-public.png')

// ── 2. สลับเป็นแบบส่วนตัว → ลิงก์ต้องหาย ──────────────────────
console.log('\n[2] กด "แบบส่วนตัว" แล้วลิงก์ต้องหาย (ไม่ให้ส่งลิงก์คนอื่นต่อ)')
const toPriv = await clickTestId('share-private')
check('กดปุ่มแบบส่วนตัวได้', !!toPriv?.ok, toPriv?.why ?? '')
await sleep(1200)
check(
  'ลิงก์หายเมื่อเป็นแบบส่วนตัว',
  !(await evaluate("!!document.querySelector('[data-testid=\"share-public-url\"]')")),
)
await shot('02-private.png')

// ── 3. กดเปิดสาธารณ → ลิงก์ต้องโผล่ ────────────────────────────
console.log('\n[3] กด "เปิดสาธารณ" แล้วต้องเห็นลิงก์')
const clicked = await clickTestId('share-publish')
check('กดปุ่มได้', !!clicked?.ok, clicked?.why ?? `จุด (${clicked?.x?.toFixed(0)}, ${clicked?.y?.toFixed(0)})`)
const shown = await waitFor("!!document.querySelector('[data-testid=\"share-public-url\"]')", 15000)
check('ลิงก์สาธารณโผล่หลังเปิดสาธารณ', shown)

const info = shown
  ? await evaluate(`(() => {
      const box = document.querySelector('[data-testid="share-public-url"]')
      const code = box.querySelector('code')
      return {
        text: code.textContent.trim(),
        clipped: code.scrollWidth - code.clientWidth,
        copyBtn: !!box.querySelector('[data-testid="share-copy-url"]'),
      }
    })()`)
  : null
const origin = await evaluate('location.origin')
const expect = `${origin}/studio/${key}`
check('ลิงก์ชี้ไปที่แม่แบบตัวนี้ถูกต้อง', info?.text === expect, `ได้ ${info?.text} · ต้องเป็น ${expect}`)
check(
  'ลิงก์ไม่มี query string (ไม่ติดสถานะแท็บของผู้ใช้)',
  !!info && !info.text.includes('?'),
  info?.text ?? '',
)
check('ข้อความลิงก์ไม่ล้นกล่อง', info?.clipped === 0, `ล้น ${info?.clipped}px`)
check('มีปุ่มคัดลอก', !!info?.copyBtn)
await shot('02-public.png')

// ── 4. ปุ่มคัดลอก ─────────────────────────────────────────────
console.log('\n[4] ปุ่มคัดลอกลิงก์')
const copied = await clickTestId('share-copy-url')
check('กดปุ่มคัดลอกได้', !!copied?.ok, copied?.why ?? '')
await sleep(700)
const toast = await evaluate(`(() => {
  const el = document.querySelector('.pill.ok')
  return el ? el.textContent.trim() : ''
})()`)
check('กดแล้วมีข้อความตอบกลับ', toast.length > 0, toast || 'ไม่มี Banner')
await shot('03-copied.png')

// ── 5. กลับเป็นแบบส่วนตัวอีกครั้ง (ยืนยันว่าเป็นวงจร ทั้งสองทาง) ──
console.log('\n[5] สลับกลับไปเป็นแบบส่วนตัวอีกครั้ง')
const back = await clickTestId('share-private')
check('กดปุ่มแบบส่วนตัวได้', !!back?.ok, back?.why ?? '')
await sleep(1200)
check(
  'ลิงก์หายอีกครั้ง (สวิตช์ทำงานทั้งสองทาง ไม่ใช่ติดสถานะ)',
  !(await evaluate("!!document.querySelector('[data-testid=\"share-public-url\"]')")),
)
await shot('04-back-private.png')

// ── เก็บกวาด ──────────────────────────────────────────────────
await send('Browser.close').catch(() => {})
chrome.kill()
await cleanup('ลบแม่แบบชั่วคราว + สิทธิ์')
console.log(`\n── ผ่าน ${pass} · ไม่ผ่าน ${fail} ─────────────────────`)
console.log(`ภาพ: ${OUT.pathname}\n`)
process.exit(fail ? 1 : 0)
