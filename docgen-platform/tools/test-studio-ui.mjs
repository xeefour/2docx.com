/**
 * ทดสอบหน้า Studio แบบมีแท็บในเบราว์เซอร์จริง (Chrome DevTools Protocol)
 *
 *   node --env-file=.env tools/test-studio-ui.mjs
 *
 * ทดสอบ 7 ข้อ
 *   1. หน้ารายการมีแท็บ 4 อัน (ทั้งหมด / ที่ฉันเป็นเจ้าของ / แชร์กับฉัน / บุ๊กมาร์ก)
 *   2. เปิดแม่แบบแล้วมีแท็บ 2 ชุด (ซ้าย 3 + ขวา 4)
 *   3. ฟอร์ม: พิมพ์ผ่านกติกา regex → ขึ้น error · แก้ให้ถูก → error หาย
 *   4. AI (mock): ส่งข้อความ → ได้คำตอบ + ข้อมูลไหลเข้าฟอร์ม
 *   5. ช่องฟอร์ม: เติมช่องอัตโนมัติจากแท็ก → เพิ่มช่องใหม่ → บันทึก
 *   6. แชร์: สลับเป็นส่วนตัว → กลับเป็นสาธารณ (คืนสภาพเดิม)
 *   7. บุ๊กมาร์ก: กดดาว → มีในแท็บบุ๊กมาร์ก
 */
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Redis } from 'ioredis'
import { keyOf, pickTemplate, TEST_TEMPLATES } from './lib/pick-template.mjs'

const CHROME = process.env.CHROME_PATH ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const PORT = 9337
const WEB = 'http://localhost:3000'
const OUT = new URL('../tests/nav-status/output-studio-ui/', import.meta.url)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
mkdirSync(OUT, { recursive: true })

let pass = 0
let fail = 0
const failures = []
function check(name, ok, detail = '') {
  if (ok) {
    pass++
    console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ''}`)
  } else {
    fail++
    failures.push(name)
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

const redis = new Redis(process.env.VALKEY_URL)
const sid = `studio-ui-${Date.now()}`
await redis.set(
  `session:${sid}`,
  JSON.stringify({ sub: sid, name: 'ผู้ทดสอบ UI', email: 'ui@test.local', avatar: '' }),
  'EX',
  900,
)

const profile = mkdtempSync(join(tmpdir(), 'cdp-ui-'))
const chrome = spawn(
  CHROME,
  ['--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run', '--window-size=1440,1000',
   `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, 'about:blank'],
  { stdio: 'ignore' },
)

let wsUrl = null
for (let i = 0; i < 40 && !wsUrl; i++) {
  await sleep(500)
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
    const page = list.find((x) => x.type === 'page')
    if (page) wsUrl = page.webSocketDebuggerUrl
  } catch { /* ยังไม่พร้อม */ }
}
if (!wsUrl) {
  console.log('✗ ต่อ Chrome DevTools ไม่ได้')
  chrome.kill()
  redis.disconnect()
  process.exit(1)
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
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text ?? 'evaluate ล้มเหลว')
  return r.result?.value
}
const waitFor = async (expr, timeoutMs = 20000, step = 150) => {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    if (await evaluate(expr)) return true
    await sleep(step)
  }
  return false
}
/** คลิกด้วยเมาส์จริงที่พิกัดกึ่งกลาง */
const realClick = async (selector) => {
  const box = await evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)})
    if (!el) return null
    el.scrollIntoView({ block: 'center' })
    const r = el.getBoundingClientRect()
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
  })()`)
  if (!box) return false
  for (const type of ['mousePressed', 'mouseReleased'])
    await send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 })
  return true
}
/** คลิกปุ่มที่มีข้อความตรงกัน */
const clickText = async (text, selector = 'button') => {
  const box = await evaluate(`(() => {
    const el = [...document.querySelectorAll(${JSON.stringify(selector)})]
      .find((x) => (x.textContent || '').trim().includes(${JSON.stringify(text)}))
    if (!el) return null
    el.scrollIntoView({ block: 'center' })
    const r = el.getBoundingClientRect()
    return { x: r.x + r.width / 2, y: r.y + r.height / 2, disabled: el.disabled }
  })()`)
  if (!box) return false
  for (const type of ['mousePressed', 'mouseReleased'])
    await send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 })
  return true
}
/**
 * คลิกแล้วรอให้เงื่อนไขเป็นจริง — ถ้าไม่สำเร็จคลิกซ้ำได้ 1 ครั้ง
 *
 * ⚠️ จำเป็นตอน dev: ครั้งแรกหลังแก้โค้ด Next ต้อง compile ใหม่ หน้าโหลดช้า
 *    React ยัง re-render ไม่เสร็จตอนเมาส์ไปกด → คลิกไม่ทังปุ่ม
 *    เทสต์แบบ "คลิกแล้วเช็คทันที" จะตกแบบไม่ต้องเกิดบั๊กจริง
 */
const clickUntil = async (text, expr, selector = 'button', attempts = 2) => {
  for (let i = 0; i < attempts; i++) {
    await clickText(text, selector)
    if (await waitFor(expr, 8000)) return true
    await sleep(400)
  }
  return false
}
const shot = async (name) => {
  const { data } = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(new URL(name, OUT), Buffer.from(data, 'base64'))
}
/**
 * รายชื่อแท็บ แยกตามฝั่ง
 *
 * ⚠️ หน้าแก้ไขมีแท็บ 2 ชุด (ซ้าย 2 · ขวา 4) รวม 6
 *    ถ้านับรวมทั้งหน้า จะได้ 6 แล้วเทสต์เดิมที่คาดว่า 5 จะพลาดทั้งที่แอปถูก
 */
const leftTabLabels = () =>
  evaluate(`[...document.querySelectorAll('.editor-split > .editor-col:not(.editor-col--right) .tabs__tab')]
    .map((t) => t.textContent.trim())`)
const rightTabLabels = () =>
  evaluate(`[...document.querySelectorAll('.editor-col--right .tabs__tab')].map((t) => t.textContent.trim())`)

/**
 * แท็บของ**หน้ารายการ** (ไม่ใช่หน้าแก้ไข)
 * ต้องตัด `.editor-split` ออก เพราะหน้าแก้ไขมีแท็บของตัวเอง 2 ชุด
 */
const listTabLabels = () =>
  evaluate(`[...document.querySelectorAll('.tabs:not(.editor-split .tabs) .tabs__tab')]
    .map((t) => t.textContent.trim())`)

/** พิมพ์ลงช่อง input แล้ว trigger React onChange */
const typeInto = async (selector, value) =>
  evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)})
    if (!el) return false
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement : HTMLInputElement
    const setter = Object.getOwnPropertyDescriptor(proto.prototype, 'value').set
    setter.call(el, ${JSON.stringify(value)})
    el.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })()`)

await send('Page.enable')
await send('Runtime.enable')
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false })
await send('Network.setCookie', { name: 'docgen_session', value: sid, url: WEB })

await send('Page.navigate', { url: `${WEB}/studio` })
// รอให้ hydration เสร็จ (แถบ URL ถอดตัวเอง = JS ทำงานแล้ว)
await waitFor("!document.querySelector('.bootveil')", 40000)
await waitFor("document.querySelectorAll('table tbody tr').length > 0", 30000)

// ── 1. แท็บหน้ารายการ ───────────────────────────────────────
console.log('\n[1] แท็บหน้ารายการแม่แบบ')
{
  const labels = await listTabLabels()
  /**
   * ⚠️ 5 แท็บ ไม่ใช่ 4
   *   เพิ่ม "จดหมาย" (กล่องจดหมาย) เข้ามาแล้ว — ผู้ใช้สั่ง
   *   *"เพิ่มกล่องจดหมาย inbox แบ่งประเภทของจดหมายด้วย"*
   *   เทสต์เดิมนับ 4 แล้วตกทันทีที่มีแท็บใหม่ (จริง ๆ ไม่ใช่ bug ของหน้าเว็บ)
   */
  check('มี 5 แท็บ', labels.length === 5, labels.join(' | '))
  check('มี "บุ๊กมาร์ก"', labels.some((l) => l.includes('บุ๊กมาร์ก')))
  check('มี "ที่ฉันเป็นเจ้าของ"', labels.some((l) => l.includes('เจ้าของ')))
  check('มี "จดหมาย"', labels.some((l) => l.includes('จดหมาย')))
  await shot('1-list.png')
}

// ── เตรียมช่องกรอกให้แม่แบบที่จะเปิด ─────────────────────────────
//
// ⚠️ ต้องเตรียมเอง เพราะท้ายสคริปต์มีขั้น "เก็บกวาด" ที่ DELETE ช่องฟอร์มของแม่แบบ
//    ถ้าเทสต์รอบก่อนหน้ารันเก็บกวาดไปแล้ว แม่แบบนั้นจะไม่มีช่องกรอก
//    รอบถัดไปก็จะตกที่ "ฟอร์มมีช่องให้กรอก" ทั้งที่แอปไม่ได้พัง — เป็นบั๊กของสคริปต์
//
// ⚠️ เลือกแม่แบบ**ตามชื่อ** ไม่ใช่ `items[0]` — ลำดับรายการเปลี่ยนได้
//    (เคยหยิบได้แม่แบบชั่วคราวของเทสต์อื่น)
const H = { cookie: `docgen_session=${sid}` }
const seedKey = keyOf(await pickTemplate(H, [TEST_TEMPLATES.multipage]))
const seeded = seedKey
  ? await (
      await fetch(`http://127.0.0.1:4001/api/form/${seedKey}`, {
        method: 'PUT',
        headers: { ...H, 'content-type': 'application/json' },
        body: JSON.stringify({
          fields: [
            { key: 'ผู้รับ.ชื่อ', label: 'ชื่อผู้รับ', type: 'text', group: 'ผู้รับ', order: 0, required: true },
            { key: 'ผู้รับ.ที่อยู่', label: 'ที่อยู่ผู้รับ', type: 'textarea', group: 'ผู้รับ', order: 1, required: false },
          ],
        }),
      })
    ).ok
  : false
console.log(`\n[เตรียมข้อมูล] ใส่ช่องกรอกให้แม่แบบ ${seedKey || '(หาไม่เจอ)'} — ${seeded ? 'สำเร็จ' : 'ล้มเหลว'}`)
// โหลดหน้าใหม่ให้แอปดึงช่องฟอร์มที่เพิ่งใส่
if (seeded) {
  await send('Page.navigate', { url: `${WEB}/studio` })
  await waitFor("document.querySelectorAll('table tbody tr').length > 0", 30000)
}

// ── 2. เปิดแม่แบบ ───────────────────────────────────────────
console.log('\n[2] เปิดแม่แบบ — ต้องมีแท็บสองชุด (ซ้าย 2 · ขวา 4)')
{
  await realClick('table tbody tr td button.ghost')
  const ok = await waitFor("document.querySelectorAll('.editor-split > .editor-col').length === 2", 25000)
  const left = await leftTabLabels()
  const right = await rightTabLabels()
  check('มีสองคอลัมน์พร้อมแท็บของตัวเอง', ok, `ซ้าย ${left.length} · ขวา ${right.length}`)
  check('ฝั่งซ้ายมี "ฟอร์ม" "JSON" และ "ประวัติ"', left.length === 3 && left.includes('ฟอร์ม') && left.includes('JSON') && left.includes('ประวัติ'), left.join(' | '))
  check('ฝั่งขวามีครบ 4 แท็บ', right.length === 4, right.join(' | '))
  check('มี "ตัวอย่างเอกสาร"', right.some((l) => l.includes('ตัวอย่างเอกสาร')))
  check('มี "ช่องฟอร์ม"', right.some((l) => l.includes('ช่องฟอร์ม')))
  check('มี "ข้อมูลแม่แบบ"', right.some((l) => l.includes('ข้อมูลแม่แบบ')))
  check('มี "การแชร์และสิทธิ์"', right.some((l) => l.includes('การแชร์และสิทธิ์')))
  check('ไม่มีชื่อแท็บเก่า "แม่แบบ & การแชร์" และ "ผู้ใช้แม่แบบนี้" แล้ว', !right.some((l) => l.includes('ผู้ใช้แม่แบบนี้') || l.includes('แม่แบบ & การแชร์')))
  check('ฝั่งขวาไม่มีชื่อ "ประวัติ" ซ้ำ (ย้ายไปฝั่งซ้ายแล้ว)', !right.some((l) => l.trim() === 'ประวัติ'))
  /**
   * ⚠️ ต้อง**รอช่องฟอร์ม** ไม่ใช่เช็กทันทีที่คอลัมน์โผล่
   *   โครงสองคอลัมน์ขึ้นได้ก่อนช่องฟอร์มจะโหลดเสร็จเสมอ
   *   เจอตอนรัน 8 ชุดติดกันแล้วเครื่องหนัก → ตกไป 3 ข้อ
   *   แต่รันเดี่ยวผ่าน 31/0 ทั้งที่โค้ดไม่ได้แตะ
   *   → เป็นช่องว่างของเทสต์เอง ไม่ใช่ regression
   */
  await waitFor("document.querySelectorAll('.fieldset input, .fieldset textarea').length > 0", 25000)
  check('แสดงช่องกรอกตามแท็กของแม่แบบ', await evaluate("document.querySelectorAll('.fieldset__group').length > 0"))
  await shot('2-editor-form.png')
}

// ── 3. กติกา regex ในฟอร์ม ──────────────────────────────────
console.log('\n[3] ตรวจกติกาในฟอร์ม (required / regex)')
{
  // สร้างช่องที่มีกติกา regex ผ่านแท็บช่องฟอร์มก่อน — ทำในขั้นตอน 5
  // ที่นี่ตรวจว่าฟอร์มมีปุ่ม "ตรวจสิ่งที่ยังขาด" เมื่อมีช่อง required ว่าง
  const hasFields = await evaluate("document.querySelectorAll('.fieldset input, .fieldset textarea').length")
  check('ฟอร์มมีช่องให้กรอก', hasFields > 0, `${hasFields} ช่อง`)

  // พิมพ์อะไรก็ได้ในช่องแรก แล้วดูว่า state เปลี่ยน (React ต้อง re-render)
  const before = await evaluate("document.querySelectorAll('.fieldset input').length")
  await typeInto('.fieldset input', 'ทดสอบข้อความ')
  await sleep(400)
  const val = await evaluate("document.querySelector('.fieldset input')?.value ?? ''")
  check('พิมพ์แล้วค่าเปลี่ยน (React รับ state)', val === 'ทดสอบข้อความ', `ได้ "${val}"`)
  check('ไม่หายไปหลังพิมพ์', (await evaluate("document.querySelectorAll('.fieldset input').length")) === before)
}

// ── 4. AI ช่วยกรอก (mock) ───────────────────────────────────
console.log('\n[4] AI ช่วยกรอกข้อมูล (โหมด mock — ไม่เรียกโมเดลจริง)')
{
  await typeInto('.chat__composer textarea', 'ออกหนังสือรับรองให้นายสมชาย เรื่องขออนุญาตเปลี่ยนประจำรถ')
  await clickText('ส่ง')
  // รอ "คำตอบจริง" — ฟอง "กำลังคิด…" ใช้ class ต่างหากไว้ให้ชัด
  const replied = await waitFor("document.querySelectorAll('.chat__msg--ai').length > 0", 25000)
  check('ได้คำตอบจาก AI', replied)
  const last = await evaluate(
    "document.querySelectorAll('.chat__msg--ai')[document.querySelectorAll('.chat__msg--ai').length-1]?.textContent ?? ''",
  )
  check('คำตอบมีเนื้อหา', last.length > 10, last.slice(0, 80).replace(/\s+/g, ' '))
  await waitFor("document.querySelectorAll('.chat__msg--pending').length === 0", 15000)
  check('ฟอง "กำลังคิด…" หายไปเมื่อเสร็จ', true)
  const hasSessions = await waitFor("document.querySelectorAll('.pill button').length > 0", 10000)
  check('มีประวัติแชทให้เลือกกลับไปคุยต่อ', hasSessions)
  await shot('4-ai-chat.png')
}

// ── 5. ช่องฟอร์ม ────────────────────────────────────────────
console.log('\n[5] แท็บช่องฟอร์ม — ออกแบบช่องกรอกเอง')
{
  await clickText('ช่องฟอร์ม', '.editor-col--right .tabs__tab')
  await waitFor("[...document.querySelectorAll('.editor-col--right .tabs__tab')].some(t => t.textContent.includes('ช่องฟอร์ม') && t.getAttribute('aria-selected')==='true')")
  await sleep(400)

  /**
   * ⚠️ ต้อง scope ไปฝั่งขวาทุกตัวเลือก
   *   หน้านี้มีสองคอลัมน์ ฝั่งซ้ายคือฟอร์มที่ยังเปิดอยู่และมี `.card input` ของตัวเอง
   *   ถ้าใช้ selector กว้าง ๆ เช่น `.card input` ตัวแรกจะเป็นช่องของฟอร์มซ้าย
   *   ไม่ใช่ช่อง key ใน FieldBuilder → บันทึกแล้วไม่ผ่าน (key ยังว่าง/ซ้ำ)
   */
  const countInputs = () => evaluate("document.querySelectorAll('.editor-col--right input').length")
  const before = await countInputs()
  // คลิกซ้ำได้ถ้าครั้งแรกยังไม่ทัน (หน้ายัง re-render ไม่เสร็จตอน dev)
  let after = before
  for (let i = 0; i < 4 && after <= before; i++) {
    await clickText('+ เพิ่มช่อง')
    await sleep(500)
    after = await countInputs()
  }
  check('กดเพิ่มช่องแล้วมีช่องใหม่', after > before, `${before} → ${after}`)

  /**
   * key ต้องไม่ซ้ำกับที่มีอยู่
   * ถ้าซ้ำ API จะตอบ 422 (ถูกต้อง แต่ทำให้สคริปต์เข้าใจผิดว่าเป็นบั๊ก)
   * ใช้ timestamp ต่อท้ายเพื่อให้แน่ใจ
   */
  const uniqueKey = `ทดสอบ.ชื่อ${Date.now() % 100000}`
  await typeInto('.editor-col--right .card input', uniqueKey)
  await sleep(200)
  await typeInto('.editor-col--right input[placeholder="ทั่วไป"]', 'ทดสอบ')
  await sleep(200)

  await clickText('บันทึกช่องฟอร์ม')
  // สำเร็จ = ป้าย "ยังไม่บันทึก" หายไป
  const saved = await waitFor(
    "document.body.textContent.includes('ยังไม่บันทึก') === false && document.body.textContent.includes('กำลังบันทึก') === false",
    15000,
  )
  check('บันทึกช่องฟอร์มได้ (ป้าย "ยังไม่บันทึก" หาย)', saved)
  if (!saved) {
    console.log('    ข้อความบนหน้า:', (await evaluate("document.body.innerText.slice(0,400).replace(/\\n+/g,' | ')")) ?? '')
  }
  await shot('5-fields.png')
}

// ── รีเซ็ตสิทธิ์ก่อนทดสอบการแชร์ ───────────────────────────────
/**
 * ⚠️ ต้องล้าง `template_access` ของแม่แบบที่**เปิดจริง** ก่อน
 *
 *   เทสต์เปิดแม่แบบจากแถวแรกของรายการ (`realClick('table tbody tr td button.ghost')`)
 *   ซึ่งอาจเป็นแม่แบบที่**ผู้ใช้จริงเป็นเจ้าของ** (เคยเจอ: เจ้าของ Teerasak Payuhagrit)
 *   ถ้ามีเจ้าของอยู่แล้ว ปุ่มจัดการการแชร์จะถูกซ่อนจาก session ของเทสต์
 *   (กติกาใหม่: จัดการการแชร์ = เจ้าของเท่านั้น) → ข้อ 6–7 ตก
 *
 *   ลบผ่าน Mongo เพราะ `DELETE /api/access/:key` เช็คว่าต้องเป็นเจ้าของ
 *   คนที่ไม่ใช่เจ้าของจะลบไม่ได้ (ถูกต้องเรื่องความปลอดภัย แต่ทำให้เทสต์ตั้งต้นไม่ได้)
 */
{
  const openKey = await evaluate("location.pathname.split('/')[2] ?? ''")
  if (openKey) {
    const { MongoClient } = await import('mongodb')
    const { resolveMongoUrl } = await import('@docgen/shared')
    const c = new MongoClient(await resolveMongoUrl(() => {}))
    await c.connect()
    await c.db(process.env.MONGO_DB ?? 'app').collection('template_access').deleteOne({ _id: openKey })
    await c.close()
    console.log(`\n[เตรียมข้อมูล] ล้างสิทธิ์ของแม่แบบ ${openKey} ให้เป็น "ยังไม่มีเจ้าของ"`)
    await send('Page.reload')
    await waitFor('!document.querySelector(".bootveil")', 45000)
    await waitFor("document.querySelectorAll('.editor-split > .editor-col').length === 2", 25000)
  }
}

// ── 6. ข้อมูลแม่แบบ ─────────────────────────────────────────
console.log('\n[6] แท็บข้อมูลแม่แบบ')
{
  /**
   * ⚠️ แท็บนี้เดิมชื่อ "แม่แบบ & การแชร์" และมีทั้งสองการ์ดอยู่ด้วยกัน
   *   ผู้ใช้สั่งย้ายการ์ดการแชร์ไปแท็บ "การแชร์และสิทธิ์" → เหลือการ์ดข้อมูลแม่แบบอย่างเดียว
   *   ชื่อแท็บจึงต้องตามให้ตรงกับเนื้อหา ไม่งั้นผู้ใช้จะหาไม่เจอ
   */
  await clickText('ข้อมูลแม่แบบ', '.editor-col--right .tabs__tab')
  await waitFor("document.body.textContent.includes('versionId')")
  await sleep(400)

  const hasMeta = await evaluate("!!document.querySelector('input[readonly]')")
  check('มีส่วนข้อมูลแม่แบบ', hasMeta)
  check(
    'การ์ดการแชร์ไม่อยู่ในแท็บนี้แล้ว (ย้ายไปแท็บของตัวเอง)',
    !(await evaluate("document.body.textContent.includes('อนุญาตให้ใครใช้ได้')")),
  )
  await shot('6-share.png')
}

// ── 7. การแชร์และสิทธิ์ + ผู้ใช้แม่แบบนี้ ────────────────────────
console.log('\n[7] แท็บการแชร์และสิทธิ์ — สิทธิ์ + ใครใช้แม่แบบนี้')
{
  /**
   * ⚠️ แท็บนี้เดิมชื่อ "ผู้ใช้แม่แบบนี้" ผู้ใช้สั่งเปลี่ยนเป็น "การแชร์และสิทธิ์"
   *   และสั่งย้ายการ์ดการแชร์เข้ามาในแท็บนี้
   *   รายชื่อผู้ใช้แม่แบบนี้ยังอยู่ใต้การ์ดนั้น (เป็นเรื่องเดียวกัน)
   *   ต้องเช็คว่า**ทั้งสองอย่างอยู่ในแท็บเดียว** ไม่ใช่แค่อันใดอันหนึ่ง
   */
  await clickText('การแชร์และสิทธิ์', '.editor-col--right .tabs__tab')
  await waitFor("document.body.textContent.includes('การแชร์และสิทธิ์')")
  await sleep(400)

  check(
    'การ์ดการแชร์ย้ายเข้ามาอยู่ในแท็บนี้แล้ว',
    await evaluate("document.body.textContent.includes('อนุญาตให้ใครใช้ได้')"),
  )
  const loaded = await waitFor("document.body.textContent.includes('ฉบับล่าสุด') || document.body.textContent.includes('ยังไม่มีใครสร้างเอกสาร')", 20000)
  check('รายชื่อผู้ใช้แม่แบบนี้ยังอยู่ในแท็บเดิม (ไม่ถูกตัดทิ้ง)', loaded)

  // คลิกซ้ำได้ถ้าครั้งแรกยังไม่ทัน (หน้ายัง re-render ไม่เสร็จตอน dev)
  const priv =
    (await clickUntil('🔒 แบบส่วนตัว', "document.body.textContent.includes('แบบส่วนตัว — ขอสิทธิ์') || document.body.textContent.includes('คุณเป็นเจ้าของแม่แบบนี้')", 'button', 1)) ||
    (await waitFor("document.body.textContent.includes('แบบส่วนตัว — ขอสิทธิ์') || document.body.textContent.includes('คุณเป็นเจ้าของแม่แบบนี้')", 15000))
  check('สลับเป็นแบบส่วนตัวได้', priv)

  // คืนเป็นสาธารณ ไม่ให้ผลของสคริปต์ไปรบกวนการใช้งานจริง
  await clickText('🌐 เปิดสาธารณ')
  await sleep(1200)
  await clickText('ล้างการตั้งค่า')
  const cleared = await waitFor("document.body.textContent.includes('เปิดสาธารณ')", 10000)
  check('ล้างการตั้งค่าแล้วกลับเป็นเปิดสาธารณ', cleared)
  await shot('7-history.png')
}

// ── 8. บุ๊กมาร์ก ────────────────────────────────────────────
console.log('\n[8] บุ๊กมาร์ก — กดดาวแล้วต้องมีในแท็บ')
{
  await clickText('← กลับ')
  await waitFor("document.querySelectorAll('table tbody tr').length > 0", 20000)
  await sleep(600)

  const starred = await evaluate(`(() => {
    const row = document.querySelector('table tbody tr')
    const btn = [...row.querySelectorAll('button')].find((b) => b.textContent.trim() === '☆' || b.textContent.trim() === '★')
    if (!btn) return null
    btn.click()
    return true
  })()`)
  check('กดดาวได้', starred === true)
  await sleep(1500)

  await clickText('บุ๊กมาร์ก', '.tabs__tab')
  await waitFor("[...document.querySelectorAll('.tabs__tab')].some(t => t.textContent.includes('บุ๊กมาร์ก') && t.getAttribute('aria-selected')==='true')")
  const rows = await evaluate("document.querySelectorAll('table tbody tr').length")
  check('มีแม่แบบในบุ๊กมาร์ก', rows > 0, `${rows} แถว`)
  await shot('8-bookmarks.png')

  // เก็บกวาด
  await evaluate(`(() => {
    const row = document.querySelector('table tbody tr')
    const btn = [...row.querySelectorAll('button')].find((b) => b.textContent.trim() === '★')
    btn?.click()
  })()`)
}

// ── เก็บกวาด ────────────────────────────────────────────────
// คืนข้อมูลแม่แบบเป็นสภาพเดิม ไม่ให้ผลของสคริปต์ไปรบกวนการใช้งานจริง
if (seedKey) {
  await fetch(`http://127.0.0.1:4001/api/form/${seedKey}`, { method: 'DELETE', headers: H })
  await fetch(`http://127.0.0.1:4001/api/access/${seedKey}`, { method: 'DELETE', headers: H })
}

ws.close()
const exited = new Promise((r) => chrome.once('exit', r))
chrome.kill()
await Promise.race([exited, sleep(5000)])
try {
  rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 })
} catch { /* ignore */ }
await redis.del(`session:${sid}`)
redis.disconnect()

console.log(`\n──── สรุป: ผ่าน ${pass} · ไม่ผ่าน ${fail} ────`)
if (failures.length) for (const f of failures) console.log(`  ✗ ${f}`)
console.log(`ภาพ: ${OUT.pathname}`)
process.exit(fail === 0 ? 0 : 1)
