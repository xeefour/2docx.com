/**
 * ตรวจลิงก์สาธารณในแท็บ "แม่แบบ & การแชร์"
 *
 *   node --env-file=../dokploy-infra/.env --env-file=../dokploy-infra/.env.development tools/test-share-url.mjs
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
    await fetch(`${API}/api/templates/${g.id}/purge`, { method: 'DELETE', headers: H_NO_BODY })
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
  const r = await fetch(`${API}/api/templates/${key}/purge`, { method: 'DELETE', headers: H_NO_BODY })
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

// ── 1. เปิดแท็บการแชร์และสิทธิ์ ─────────────────────────────────
console.log('\n[1] เปิดแท็บ "การแชร์และสิทธิ์"')
/**
 * ⚠️ ใช้ `pane=history` ไม่ใช่ `pane=template`
 *   ผู้ใช้สั่งย้ายการ์ดการแชร์ออกจากแท็บ "ข้อมูลแม่แบบ" ไปแท็บของตัวเองแล้ว
 *   (เคยเขียนผิดแล้ว ทำให้ทั้งชุดตก 12 ข้อ เพราะรอปุ่มที่ย้ายไปแล้ว)
 */
await send('Page.navigate', { url: `${WEB}/studio/${key}?tabs=form&pane=history` })
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

// ── 4b · ปุ่มต้องบอกผล**บนตัวปุ่มเอง** ไม่ใช่รอ Banner บนสุด ───────────
/**
 * ⚠️ ผู้ใช้สั่ง: *"ผมคลิก copy link แล้ว แต่ไม่รู้ว่ามัน copy ได้
 *   ระบบแจ้งเตือนแต่อยู่บนสุด โดยเฉพาะหน้าจอขนาดเล็ก"*
 *
 *   เดิมยืนยันผลแค่ผ่าน Banner ที่ `Studio.tsx` วางไว้**เหนือ** `TemplateEditor`
 *   ทั้งก้อน ขณะที่ปุ่มที่ผู้ใช้กดอยู่ท้ายแท็บขวา → ห่างกันหลายจอเล็ก
 *   พอเลื่อนไปมองที่ปุ่ม ป้ายเตือนก็หลุดไปแล้ว ผู้ใช้เลยคิดว่ากดไม่ติด
 *
 *   ต้องพิสูจน์สองอย่าง: ปุ่มเปลี่ยนป้าย**ทันที** และคืนป้ายเดิมเอง (ไม่ค้าง)
 *
 * ⚠️ ยิงซ้ำอีกครั้งก่อนอ่านค่า เพราะช่วงเปลี่ยนป้ายสั้นมาก (2 วินาที)
 *    ถ้าใช้ผลจากกดครั้งก่อนหน้า จะขึ้นกับความเร็วของ screenshot ที่ผ่านมา
 *
 * ⚠️ เช็กว่าปุ่มยังอยู่ก่อนกด — `clickTestId` **ไม่มี timeout**
 *    ถ้าปุ่มหาย (เช่นแท็บผิด/แม่แบบถูกลบไปแล้ว) สคริปต์จะค้างตลอดการทำงาน
 *    แล้วทิ้ง Chrome ค้างไว้อีกหลายตัว
 */
const INLINE_OK = 'คัดลอกแล้ว ✓'
const INLINE_ERR = 'คัดลอกไม่สำเร็จ'
const btnNow = async () =>
  evaluate(`(() => {
  const b = document.querySelector('[data-testid="share-copy-url"]')
  if (!b) return null
  return { text: b.textContent.trim(), cls: b.className }
})()`)

const alive = await evaluate(`!!document.querySelector('[data-testid="share-copy-url"]')`)
if (!alive) {
  check('ยังมีปุ่มคัดลอกอยู่ตอนกดซ้ำ', false, 'ไม่เจอปุ่ม — ข้ามข้อตรวจส่วนนี้')
} else {
  check('ยังมีปุ่มคัดลอกอยู่ตอนกดซ้ำ', true)
  const again = await clickTestId('share-copy-url')
  check('กดปุ่มคัดลอกซ้ำได้', !!again?.ok, again?.why ?? '')
  await sleep(400)
  const b1 = await btnNow()
  check(
    'ปุ่มตอบบนตัวปุ่มเอง ไม่ต้องเลื่อนไปดู Banner',
    !!b1 && (b1.text === INLINE_OK || b1.text === INLINE_ERR),
    b1 ? b1.text : 'ไม่เจอปุ่ม'
  )
  check('ปุ่มเปลี่ยนสีตามผล (ok/err)', !!b1 && /\bok\b|\berr\b/.test(b1.cls), b1?.cls ?? '')

  await shot('03b-copied-inline.png')   // ถ่ายตอนปุ่มยังแสดง "คัดลอกแล้ว ✓"
  await sleep(2100)
  const b2 = await btnNow()
  check('รอแล้วป้ายกลับเป็น "คัดลอกลิงก์" (ไม่ค้าง)', b2?.text === 'คัดลอกลิงก์', b2?.text ?? 'ไม่เจอปุ่ม')
  await shot('03c-copied-reset.png')
}


// ── 4c · popup เล็ก ๆ บอกว่าคัดลอกสำเร็จ ──────────────────────────
/**
 * ⚠️ ผู้ใช้สั่ง: *"เมื่อคลิกที่ปุ่มนี้แล้ว มี toats หรือ popup หรืออื่นๆ เล็กๆ
 *   ทำให้รู้ว่า copy สำเร็จ"* — เดิมยืนยันผลแค่เปลี่ยนป้ายบนตัวปุ่ม
 *   ซึ่งผู้ใช้บอกว่ายังไม่พอ (และตอนจอแคบป้ายสั้นมากจนแทบมองไม่ทัน)
 *
 *   ภาพที่ผู้ใช้ส่งมาถูกถ่ายที่จอ **579×539** → ต้องวัดตอนจอแคบจริงด้วย
 *   ถ้าทดสอบแค่ที่ 1600px จะผ่านมั่วตลอด แล้วซีเมล่อจริงโดน popup ล้นขอบจอ
 */
const popGeo = () =>
  evaluate(`(() => {
    const p = document.querySelector('[data-testid="copy-popup"]')
    const b = document.querySelector('[data-testid="share-copy-url"]')
    if (!p || !b) return null
    const pr = p.getBoundingClientRect()
    const br = b.getBoundingClientRect()
    const cs = getComputedStyle(p)
    return {
      text: p.textContent.trim(),
      pos: cs.position,
      below: p.getAttribute('data-below'),
      z: Number(cs.zIndex),
      outLeft: Math.round(pr.left),
      outRight: Math.round(window.innerWidth - pr.right),
      outTop: Math.round(pr.top),
      w: Math.round(pr.width),
      h: Math.round(pr.height),
      /** ห่างจากกึ่งกลางปุ่มแนวนอน — ต้องติดปุ่ม ไม่ใช่ลอยไว้มุมอื่นของจอ */
      dx: Math.round(Math.abs((pr.left + pr.width / 2) - (br.left + br.width / 2))),
      /** popup ทับตัวปุ่มหรือเปล่า (ถ้าทับ กดซ้ำไม่ได้) */
      coversBtn: pr.bottom > br.top && pr.top < br.bottom && pr.right > br.left && pr.left < br.right,
      pe: cs.pointerEvents,
      painted: pr.width > 0 && pr.height > 0,
    }
  })()`)

/**
 * ⚠️ กันดักหลักของ `position: fixed`
 *   ถ้าบรรพบุรุษมี transform / filter / will-change / contain:paint
 *   ตำแหน่ง fixed จะถูกผูกกับ**การ์ดนั้น**แทนหน้าจอ
 *   → overflow ของการ์ดจะตัด popup ทิ้งทันที แล้วผู้ใช้ไม่เห็นอะไรเลย
 *   (ตอนนี้ยังไม่เจอ แต่เป็นกับดักที่จะเงียบ ๆ พังวันหน้า CSS เปลี่ยน)
 */
const popClipRisk = () =>
  evaluate(`(() => {
    const p = document.querySelector('[data-testid="copy-popup"]')
    if (!p) return null
    const bad = []
    for (let el = p.parentElement; el; el = el.parentElement) {
      const cs = getComputedStyle(el)
      if (
        cs.transform !== 'none' ||
        cs.filter !== 'none' ||
        (cs.backdropFilter && cs.backdropFilter !== 'none') ||
        cs.willChange !== 'auto' ||
        cs.perspective !== 'none' ||
        (cs.contain && cs.contain.includes('paint'))
      ) {
        bad.push(el.tagName + '.' + (el.className || ''))
      }
    }
    return bad
  })()`)

const popCheck = async (label, shotName) => {
  const g = await popGeo()
  check(`${label}: popup โผล่ขึ้นมา`, !!g, g ? '' : 'ไม่เจอ [data-testid="copy-popup"]')
  if (!g) return null
  check(`${label}: มีข้อความบอกผล`, g.text.length > 0, g.text)
  check(`${label}: ใช้ position:fixed (ไม่โดน overflow ตัด)`, g.pos === 'fixed', g.pos)
  check(`${label}: ติดปุ่ม ไม่ลอยผิดมุม`, g.dx <= 2, `ห่างแนวนอน ${g.dx}px`)
  check(
    `${label}: ไม่ล้นออกนอกจอซ้าย/ขวา`,
    g.outLeft >= 0 && g.outRight >= 0,
    `ซ้ายล้น ${g.outLeft}px · ขวาล้น ${g.outRight}px`
  )
  check(
    `${label}: ไม่ทับปุ่มจนกดซ้ำไม่ได้`,
    !g.coversBtn,
    g.coversBtn ? 'popup ทับตัวปุ่ม' : ''
  )
  check(`${label}: ไม่กินคลิกทั้งยวง`, g.pe === 'none', `pointer-events: ${g.pe}`)
  check(`${label}: ทับแถบ URL ได้ (z-index สูงพอ)`, g.z >= 2147482600, String(g.z))
  check(`${label}: มีขนาดจริง (ไม่โดนตัดจนหาย)`, g.painted, `${g.w}×${g.h}px`)
  const risky = await popClipRisk()
  check(
    `${label}: ไม่มีบรรพบุรุษที่ดัก position:fixed`,
    Array.isArray(risky) && risky.length === 0,
    Array.isArray(risky) ? risky.join(', ') : 'ไม่ได้อ่านได้'
  )
  await shot(shotName)
  return g
}

console.log('\n[4c] popup เล็ก ๆ บอกว่าคัดลอกสำเร็จ')
if (!(await evaluate('!!document.querySelector("[data-testid=\'share-copy-url\']")'))) {
  check('ยังมีปุ่มคัดลอกอยู่ตอนทดสอบ popup', false, 'ไม่เจอปุ่ม — ข้ามชุดตรวจ popup')
} else {
  // ── จอกว้าง ──
  const p1 = await clickTestId('share-copy-url')
  check('กดปุ่มคัดลอกเพื่อทดสอบ popup ได้', !!p1?.ok, p1?.why ?? '')
  await waitFor('!!document.querySelector("[data-testid=\'copy-popup\']")', 3000)
  const wide = await popCheck('จอกว้าง', '03d-copypop-wide.png')
  check('จอกว้าง: popup ลอยเหนือปุ่ม', wide?.below === '0', `data-below=${wide?.below}`)

  // ── จอแคบตามที่ผู้ใช้ใช้จริง (579×539) ──
  await send('Emulation.setDeviceMetricsOverride', { width: 579, height: 539, deviceScaleFactor: 1, mobile: false })
  await sleep(700)
  const p2 = await clickTestId('share-copy-url')
  check('กดปุ่มคัดลอกที่จอ 579px ได้', !!p2?.ok, p2?.why ?? '')
  await waitFor('!!document.querySelector("[data-testid=\'copy-popup\']")', 3000)
  const narrow = await popCheck('จอแคบ 579px', '03e-copypop-narrow.png')
  check('จอแคบ: popup ยังลอยเหนือปุ่ม ไม่ตกไปใต้ปุ่ม', narrow?.below === '0', `data-below=${narrow?.below}`)

  /**
   * ⚠️ ต้องพิสูจน์ว่ามัน "ตามปุ่ม" จริง ไม่ใช่แค่โผล่ครั้งเดียวแล้วลอยค้าง
   *   popup ใช้ position:fixed ถ้าไม่ผูกกับ scroll ผู้ใช้เลื่อนหน้า
   *   แล้วมันจะค้างอยู่กลางจอทั้งที่ปุ่มหายไปได้แล้ว
   */
  await evaluate('window.scrollBy(0, 60)')
  await sleep(250)
  const scrolled = await popGeo()
  check('เลื่อนหน้าแล้ว popup ยังติดปุ่ม (ไม่ลอยค้าง)', !!scrolled && scrolled.dx <= 2, `ห่าง ${scrolled?.dx}px`)
  await evaluate('window.scrollBy(0, -60)')
  await sleep(200)

  // ── ต้องหายเอง ไม่ค้างบังหน้า ──
  const gone = await waitFor('!document.querySelector("[data-testid=\'copy-popup\']")', 5000)
  check('popup หายเองภายใน 2 วินาที (ไม่ค้างบังหน้า)', gone)
  await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false })
  await sleep(400)
}

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

// ── 6. กล่องเตือน "จะแทนไฟล์": มุมต้องไม่โค้งจนเป็นถุง และต้องไม่ล้นการ์ด ──
console.log('\n[6] กล่องเตือนการอัปโหลดแทน — มุมโค้งและการล้นการ์ด')
/**
 * ⚠️ ต้องสลับไปแท็บ "ข้อมูลแม่แบบ" ก่อน
 *   ช่องเลือกไฟล์อยู่ในการ์ด metadata ซึ่งย้ายแยกจากการ์ดการแชร์แล้ว
 */
await send('Page.navigate', { url: `${WEB}/studio/${key}?tabs=form&pane=template` })
await waitFor('!document.querySelector(".bootveil")', 45000)
await waitFor('!!document.querySelector("[data-testid=\"template-file\"]")', 25000)
/**
 * ผู้ใช้รายงาน: *"มันโค้งมากไปไหม Rounded Corners"*
 *
 * กล่องนี้ใช้ `className="pill warn"` ซึ่งเป็นป้ายเล็ก ๆ บรรทัดเดียว
 * มี 2 ค่าที่เอามาใช้กับกล่องข้อความไม่ได้ และเจอทั้งคู่พร้อมกัน:
 *   · `border-radius: 999px` → กล่องสูงหลายบรรทัดเป็นรูปครึ่งวงกลม
 *   · `white-space: nowrap` → ข้อความยาวไม่ตัดบรรทัด ล้นออกนอกการ์ด
 *     (เห็นชัดตอนจอ 579px ในภาพที่ผู้ใช้ส่งมา — ขอบขวาของกล่องโดนการ์ดซ้ำน)
 *
 * ⚠️ ต้องวัดตอนจอแคบจริง ที่ 1600px กล่องกว้างพอ จะได้ผ่านมั่วตลอด
 */
/**
 * ใส่ไฟล์ปลอมเข้า `<input type="file">` ที่ซ่อนอยู่
 * ⚠️ `input.files` ต้องผูกผ่าน `DataTransfer` แล้วยิง event `change` เอง
 *    เพราะ React ผูก onChange ผ่านระบบ delegation ของมัน
 *    การกำหนด `.files` อย่างเดียวจะไม่ทำให้ React รู้จักการเปลี่ยน
 */
const put = await evaluate(`(() => {
  const input = document.querySelector('[data-testid="template-file"]')
  if (!input) return { ok: false, why: 'ไม่พบช่องเลือกไฟล์ (canEdit อาจเป็น false)' }
  const dt = new DataTransfer()
  dt.items.add(new File([new Uint8Array([1, 2, 3])], 'ทดสอบ-มุมโค้ง.docx', {
    type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  }))
  input.files = dt.files
  input.dispatchEvent(new Event('change', { bubbles: true }))
  return { ok: true, count: input.files.length }
})()`)
check('ใส่ไฟล์ปลอมเข้าช่องได้', !!put?.ok, put?.why ?? `${put?.count} ไฟล์`)

await send('Emulation.setDeviceMetricsOverride', { width: 579, height: 539, deviceScaleFactor: 1, mobile: false })
await sleep(800)
const warnBox = await waitFor(
  `(() => {
    const el = [...document.querySelectorAll('.pill--msg')].find((x) => /จะแทนไฟล์/.test(x.textContent))
    if (!el) return false
    el.scrollIntoView({ block: 'center' })
    return true
  })()`,
  10000,
)
check('กล่องเตือนแสดงหลังเลือกไฟล์', warnBox)
if (warnBox) {
  await sleep(300)
  const geo = await evaluate(`(() => {
    const el = [...document.querySelectorAll('.pill--msg')].find((x) => /จะแทนไฟล์/.test(x.textContent))
    const card = el.closest('.card')
    const cs = getComputedStyle(el)
    const r = el.getBoundingClientRect()
    const c = card ? card.getBoundingClientRect() : null
    return {
      radius: cs.borderRadius,
      /** เกิน 40px = ยังเป็นรูปครึ่งวงกลม (999px) */
      round: Math.max(...cs.borderRadius.split(' ').map((v) => parseFloat(v) || 0)),
      whiteSpace: cs.whiteSpace,
      /** ข้อความล้นกรอบตัวเอง */
      selfOverflow: el.scrollWidth - el.clientWidth,
      /** ล้นออกนอกการ์ด */
      pastCard: c ? Math.round(r.right - c.right) : null,
      lines: Math.round(r.height / parseFloat(cs.lineHeight || 20)),
    }
  })()`)
  check(
    'มุมไม่โค้งเป็นรูปครึ่งวงกลม',
    geo.round <= 40,
    `border-radius ${geo.radius} (เดิม 999px)`,
  )
  check('ข้อความตัดบรรทัดได้', geo.whiteSpace === 'normal', `white-space: ${geo.whiteSpace}`)
  check('ข้อความไม่ล้นกล่องตัวเอง', geo.selfOverflow === 0, `ล้น ${geo.selfOverflow}px`)
  check(
    'กล่องไม่ล้นออกนอกการ์ด',
    geo.pastCard !== null && geo.pastCard <= 0,
    `ขอบขวาล้นการ์ด ${geo.pastCard}px · สูง ${geo.lines} บรรทัด`,
  )
  await shot('05-warn-box.png')
}
// ── เก็บกวาด ──────────────────────────────────────────────────
await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false })
await send('Browser.close').catch(() => {})
chrome.kill()
await cleanup('ลบแม่แบบชั่วคราว + สิทธิ์')
console.log(`\n── ผ่าน ${pass} · ไม่ผ่าน ${fail} ─────────────────────`)
console.log(`ภาพ: ${OUT.pathname}\n`)
process.exit(fail ? 1 : 0)
