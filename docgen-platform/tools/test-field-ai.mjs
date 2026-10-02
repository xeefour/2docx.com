/**
 * ตรวจผู้ช่วย AI ประจำช่องกรอก (ไอคอนขวาสุดของ input/textarea)
 *
 *   node --env-file=.env tools/test-field-ai.mjs
 *
 * ── สิ่งที่ต้องผ่าน ────────────────────────────────────────────
 * 1. ไอคอน AI อยู่ขวาสุดของทุกช่อง input/textarea
 * 2. ช่องที่ไม่ใช่การพิมพ์ (select · checkbox) ไม่มีไอคอน
 * 3. กดไอคอน → popover เปิด พร้อมปุ่มลัด (ร่างให้ / แก้ / สั้น / คำแนะนำ)
 * 4. ถาม AI → ได้คำตอบ แต่ **ช่องยังไม่ถูกเขียนทับ**
 * 5. กด "ใส่ในช่องนี้" → ค่าถึงเข้าช่องจริง
 * 6. ถามต่อได้หลายรอบ (ประวัติอยู่ใน popover)
 * 7. Esc / คลิกที่อื่น → popover ปิด
 * 8. ช่องตัวเลข: AI ตอบมาไม่ใช่ตัวเลข → ไม่ทำให้ช่องเพี้ยนเป็น NaN
 */
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Redis } from 'ioredis'
import { keyOf, pickTemplate, TEST_TEMPLATES } from './lib/pick-template.mjs'

const CHROME = process.env.CHROME_PATH ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const PORT = 9357
const WEB = 'http://localhost:3000'
const OUT = new URL('../tests/nav-status/output-field-ai/', import.meta.url)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
mkdirSync(OUT, { recursive: true })

let pass = 0
let fail = 0
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`)
  ok ? pass++ : fail++
}

const redis = new Redis(process.env.VALKEY_URL)
const sid = `fieldai-${Date.now()}`
await redis.set(
  `session:${sid}`,
  JSON.stringify({ sub: sid, name: 'ผู้ทดสอบ AI ประจำช่อง', email: 'fieldai@test.local', avatar: '' }),
  'EX',
  1800,
)
const H = { cookie: `docgen_session=${sid}`, 'content-type': 'application/json' }
const API = 'http://127.0.0.1:4001'

// ── เตรียมแม่แบบที่มีช่องครบทุกชนิด ────────────────────────────
// ⚠️ ต้องใส่เองทุกครั้ง เพราะท้ายสคริปต์เก็บกวาดช่องของแม่แบบแรก (เหมือน test-studio-ui)
const SEED = [
  { key: 'เรื่อง', label: 'เรื่อง', type: 'text', group: 'หัวหนังสือ', order: 0, required: true },
  { key: 'ผู้รับ.ชื่อ', label: 'ชื่อผู้รับ', type: 'text', group: 'ผู้รับ', order: 0 },
  { key: 'สิ่งที่ขอ', label: 'สิ่งที่ขอ', type: 'textarea', group: 'เนื้อหา', order: 0 },
  { key: 'จำนวนเงิน', label: 'จำนวนเงิน', type: 'number', group: 'เนื้อหา', order: 1 },
  { key: 'ประเภท', label: 'ประเภท', type: 'select', group: 'เนื้อหา', order: 2, options: [{ value: 'ขอ', label: 'ขอ' }] },
  { key: 'มีเอกสารแนบ', label: 'มีเอกสารแนบ', type: 'checkbox', group: 'เนื้อหา', order: 3 },
]
const key = keyOf(await pickTemplate(H, [TEST_TEMPLATES.multipage]))
await fetch(`${API}/api/form/${key}`, { method: 'PUT', headers: H, body: JSON.stringify({ fields: SEED }) })
console.log(`เตรียมแม่แบบ ${key} พร้อมช่อง ${SEED.length} ช่อง`)

const profile = mkdtempSync(join(tmpdir(), 'cdp-fieldai-'))
const chrome = spawn(
  CHROME,
  ['--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run', '--window-size=1600,1000',
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
const waitFor = async (expr, timeoutMs = 25000, step = 150) => {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    try {
      if (await evaluate(expr)) return true
    } catch { /* กำลัง navigate */ }
    await sleep(step)
  }
  return false
}
const shot = async (name) => {
  const { data } = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(new URL(name, OUT), Buffer.from(data, 'base64'))
}

/**
 * คลิกด้วยเมาส์จริงที่พิกัดกึ่งกลาง — `element.click()` ยิงแค่ event ไม่ยิง mousedown
 *
 * ⚠️ ถ้าอยู่ใน popover ให้เลื่อน **popover** เข้ากลางจอ ไม่ใช่ปุ่ม
 *    popover สูงกว่าจอ ถ้าเลื่อนปุ่มเข้ากลาง ปุ่มจะอยู่ใต้ขอบจอ
 *    แล้วพิกัดที่คำนวณได้จะไปตกในที่อื่น → กดไม่ติด แต่เทสต์จะโทษตัวเอง
 */
const realClick = async (selector, nth = 0) => {
  const box = await evaluate(`(() => {
    const el = document.querySelectorAll(${JSON.stringify(selector)})[${nth}]
    if (!el) return null
    const pop = el.closest('.fieldai__pop')
    ;(pop ?? el).scrollIntoView({ block: 'center', inline: 'center' })
    const r = el.getBoundingClientRect()
    const x = r.x + r.width / 2, y = r.y + r.height / 2
    const inView = x >= 0 && y >= 0 && x <= innerWidth && y <= innerHeight
    // อะไรอยู่ทับจุดนี้จริง — ถ้าไม่ใช่ตัวที่จะกด ก็กดไม่ติดแน่นอน
    const hit = inView ? document.elementFromPoint(x, y) : null
    return {
      x, y, inView,
      hit: hit ? (hit.className || hit.tagName) : null,
      mine: hit ? el.contains(hit) || hit === el : false,
    }
  })()`)
  if (process.env.FAI_DEBUG) console.log('  click', selector, '→', JSON.stringify(box))
  if (!box?.inView) return false
  // จุดนี้ถูกอย่างอื่นบัง (เช่น คอลัมน์ขวาที่ sticky) — คลิกทะลุไปก็ไม่ถูกต้อง
  if (!box.mine) return false
  for (const type of ['mousePressed', 'mouseReleased'])
    await send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 })
  return true
}

/** พิมพ์ลง textarea/input แล้ว trigger React onChange */
const typeInto = async (selector, value, nth = 0) =>
  evaluate(`(() => {
    const el = document.querySelectorAll(${JSON.stringify(selector)})[${nth}]
    if (!el) return false
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement : HTMLInputElement
    Object.getOwnPropertyDescriptor(proto.prototype, 'value').set.call(el, ${JSON.stringify(value)})
    el.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })()`)

/**
 * ไอคอน AI ของช่องที่ระบุด้วย aria-label
 *
 * ⚠️ ต้องกด **ปุ่มไอคอน** ไม่ใช่ตัว input
 *    ถ้ากดที่ input จะได้แค่โฟกัสช่อง — popover ไม่มีทางเปิด
 *    แล้วเทสต์จะรายงานว่า "ปุ่มไม่ทำงาน" ทั้งที่ปุ่มดี
 */
const clickAi = async (label) => realClick(`.fieldai__btn[aria-label*=${JSON.stringify(label)}]`)

/**
 * id ของ `<input>`/`<textarea>` ที่อยู่ในช่องซึ่งมีปุ่มไอคอนของช่องนั้น
 *
 * ⚠️ ห้ามเดา id เอง — id สร้างจาก `key.replace(/[^\w-]/g, '_')`
 *    แต่ `\w` ของ JavaScript **ไม่ครอบคลุมอักษรไทย** ทำให้ id เป็น `_` เต็ม ๆ
 *    นับเองแล้วผิด (เคยเขียนไป 6 ขีด จริง ๆ แค่ 5) → `getElementById` คืน null
 *    แล้ว `?.value ?? ''` ให้ค่าว่างเสมอ เทสต์ผ่านทั้งที่ฟีเจอร์ไม่ทำงาน
 *
 * ทางที่ถูกคือไปหา input จาก**ปุ่มไอคอนตัวเดียวกับที่กด**เสมอ
 */
const inputIdOf = (label) =>
  evaluate(`(() => {
    const btn = document.querySelector('.fieldai__btn[aria-label*=${JSON.stringify(label)}]')
    return btn?.closest('.fieldbox')?.querySelector('input, textarea')?.id ?? ''
  })()`)

/** อ่านทุกช่องในฟอร์มพร้อมป้าย — ใช้ตอน assert ไม่ผ่าน เพื่อดูว่าค่าไปตกที่ไหน */
const formSnapshot = () =>
  evaluate(`[...document.querySelectorAll('.fieldset__group')].flatMap((g) =>
    [...g.querySelectorAll('input, textarea, select')].map((e) => ({
      label: g.querySelector('legend')?.textContent ?? '',
      id: e.id,
      v: e.type === 'checkbox' ? String(e.checked) : e.value,
    })))`)

await send('Page.enable')
await send('Runtime.enable')
await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false })
await send('Network.setCookie', { name: 'docgen_session', value: sid, url: WEB })
// ⚠️ ปิด cache เสมอ ไม่งั้นรันซ้ำแล้วจะวัดโค้ดเก่า
await send('Network.setCacheDisabled', { cacheDisabled: true })

// ── เปิดหน้าแก้ไขของแม่แบบที่เตรียมไว้ ──────────────────────────
await send('Page.navigate', { url: `${WEB}/studio/${key}?tabs=form&pane=preview` })
const ready = await waitFor("document.querySelectorAll('.fieldai__btn').length > 0", 45000)
check('หน้าแก้ไขโหลดและมีไอคอน AI', ready)
await sleep(600)
const fieldId = await inputIdOf('เรื่อง')
check('หาช่อง "เรื่อง" ได้จากปุ่มไอคอนของมันเอง', /^f-[\w-]+$/.test(fieldId), `id=${fieldId}`)

// ── 1. ไอคอนอยู่ครบเฉพาะช่องที่พิมพ์ข้อความได้ ───────────────────
console.log('\n[1] ไอคอน AI อยู่ตรงช่องที่พิมพ์ได้')
{
  const stats = await evaluate(`(() => {
    const boxes = [...document.querySelectorAll('.fieldbox')]
    return {
      total: boxes.length,
      withBtn: boxes.filter((b) => b.querySelector('.fieldai__btn')).length,
      // ไอคอนต้องอยู่ขวาสุดของกล่องช่อง
      atRight: boxes.every((b) => {
        const btn = b.querySelector('.fieldai__btn')
        if (!btn) return true
        const field = b.querySelector('input, textarea')
        if (!field) return false
        const br = btn.getBoundingClientRect(), fr = field.getBoundingClientRect()
        return br.right <= fr.right + 1 && br.right > fr.left + fr.width / 2
      }),
      // ช่อง select/checkbox ต้องไม่มีไอคอน
      clean: [...document.querySelectorAll('select, input[type=checkbox]')].every(
        (el) => !el.closest('.fieldbox')),
    }
  })()`)
  /**
   * ⚠️ เช็ค "ทุกช่องที่พิมพ์ได้มีไอคอน" ไม่ใช่ "มี 4 ช่องพอดี"
   *
   * แอปเติมช่องอัตโนมัติจากแท็กของแม่แบบที่ไม่ได้อยู่ในฟอร์มให้ด้วย
   * เช่น `หน่วยงาน` / `เนื้อหา` ของแม่แบบทดสอบหัวกระดาษ
   * ถ้าเทสต์นับตายตัว จะตกทั้งที่พฤติกรรมถูก (เคยเจอ: ได้ 6/6 แต่คาดไว้ 4)
   */
  check(
    'ทุกช่องที่พิมพ์ได้มีไอคอนครบ',
    stats.total >= 4 && stats.withBtn === stats.total,
    `${stats.withBtn}/${stats.total} ช่อง`,
  )
  check('ไอคอนอยู่ขวาสุดของช่องจริง', stats.atRight)
  check('select / checkbox ไม่มีไอคอน', stats.clean)
  await shot('01-icons.png')
}

// ── 2. กดไอคอน → popover เปิด ────────────────────────────────────
console.log('\n[2] กดไอคอน — popover ต้องเปิด')
{
  const clicked = await clickAi('เรื่อง')
  check('คลิกปุ่มไอคอนได้', clicked)
  const open = await waitFor("!!document.querySelector('.fieldai__pop')", 8000)
  check('popover เปิด', open)
  const quick = await evaluate(
    "[...document.querySelectorAll('.fieldai__tools .pill')].map(b => b.textContent.trim())",
  )
  check('มีปุ่มลัดครบ 4 ปุ่ม', quick.length === 4, quick.join(' | '))
  check('มีปุ่ม "ร่างให้" กับ "แก้ให้สุภาพ"', quick.includes('ร่างให้') && quick.includes('แก้ให้สุภาพ'))
  const name = await evaluate("document.querySelector('.fieldai__head strong')?.textContent ?? ''")
  check('หัว popover บอกชื่อช่อง', name.includes('เรื่อง'), name)
  await shot('02-open.png')
}

// ── 1b. id ของทุกช่องต้องไม่ซ้ำกัน ───────────────────────────────
console.log('\n[1b] id ของช่องต้องไม่ซ้ำ (ไม่งั้น label ชี้ผิดช่อง)')
{
  const rows = await evaluate(
    `// ตัด popover ของ AI ออก — select/textarea ของตัวผู้ช่วยอยู่ใน fieldset เดียวกัน
     // แต่ไม่ใช่ "ช่องฟอร์ม" จึงไม่มี id และนับแล้วดูเหมือนชนกัน
    [...document.querySelectorAll('.fieldset__group input, .fieldset__group textarea, .fieldset__group select')]
      .filter((e) => !e.closest('.fieldai__pop'))
      .map((e) => ({ id: e.id, tag: e.tagName, t: e.type ?? '', g: e.closest('.fieldset__group')?.querySelector('legend')?.textContent ?? '' }))`,
  )
  const seen = new Map()
  const dups = []
  for (const r of rows) {
    if (!r.id) {
      dups.push(`ไม่มี id เลย (${r.tag}/${r.t})`)
    } else if (seen.has(r.id)) {
      dups.push(`"${r.id}" (${seen.get(r.id)} ↔ ${r.tag}/${r.t} ${r.g})`)
    } else {
      seen.set(r.id, `${r.tag}/${r.t} ${r.g}`)
    }
  }
  check('ทุกช่องฟอร์มมี id ที่ไม่ซ้ำ', dups.length === 0, dups.join(' · ') || `${seen.size}/${rows.length} ช่อง`)
  if (dups.length) console.log('    id ทั้งหมด:', JSON.stringify(rows))
  // กดชื่อช่องแล้วต้องโฟกัสถูกช่อง
  const focusOk = await evaluate(`(() => {
    const lab = [...document.querySelectorAll('label')].find((l) => l.textContent.includes('เรื่อง'))
    if (!lab) return null
    lab.click()
    return document.activeElement?.id === lab.getAttribute('for')
  })()`)
  check('กดชื่อช่องแล้วโฟกัสถูกช่อง', focusOk === true, `focusOk=${focusOk}`)
}

// ── 3. ถาม AI → ได้คำตอบ แต่ช่องยังไม่ถูกทับ ─────────────────────
console.log('\n[3] ถาม AI — ต้องไม่เขียนทับช่องเอง')
{
  const before = await evaluate(`document.getElementById(${JSON.stringify(fieldId)})?.value ?? ''`)
  await typeInto('.fieldai__composer textarea', 'ช่วยร่างเรื่องหนังสือขออนุญาตเปลี่ยนประจำรถ')
  await realClick('.fieldai__composer button')
  const replied = await waitFor("document.querySelectorAll('.fieldai__msg--ai').length > 0", 25000)
  check('ได้คำตอบจาก AI', replied)
  const after = await evaluate(`document.getElementById(${JSON.stringify(fieldId)})?.value ?? ''`)
  check('ช่องยังว่างเหมือนเดิม (AI ไม่ทับเอง)', after === before, `"${after}"`)
  const hasApply = await waitFor("!!document.querySelector('.fieldai__apply')", 8000)
  check('มีปุ่ม "ใส่ในช่องนี้" ให้ผู้ใช้กดเอง', hasApply)
  await shot('03-replied.png')
}

// ── 4. กด "ใส่ในช่องนี้" → ค่าเข้าช่องจริง ────────────────────────
console.log('\n[4] กดยืนยัน — ค่าต้องเข้าช่อง')
{
  const clicked = await realClick('.fieldai__apply')
  check('คลิกปุ่ม "ใส่ในช่องนี้" ได้', clicked)
  await sleep(700)
  const val = await evaluate(`document.getElementById(${JSON.stringify(fieldId)})?.value ?? '(ไม่เจอช่อง)'`)
  check('ค่าถูกเขียนลงช่อง', val.includes('ขออนุญาตเปลี่ยนประจำรถ'), `id=${fieldId} · "${val}"`)
  check('popover ปิดหลังใส่ค่า', !(await evaluate("!!document.querySelector('.fieldai__pop')")))
  if (!val.includes('ขออนุญาตเปลี่ยนประจำรถ')) {
    console.log('    ทุกช่องในฟอร์มตอนนี้:', JSON.stringify(await formSnapshot()))
  }
  // ยืนยันซ้ำจากฝั่ง data — เผื่อ input ค้างค่าเก่าแต่ state เปลี่ยนจริง
  await evaluate(`(() => {
    const btn = [...document.querySelectorAll('.editor-split > .editor-col:not(.editor-col--right) .tabs__tab')]
      .find((t) => t.textContent.trim() === 'JSON')
    btn?.click()
    return true
  })()`)
  await sleep(1000)
  const json = await evaluate(
    "document.querySelector('.editor-split > .editor-col:not(.editor-col--right) textarea')?.value ?? ''",
  )
  check('ข้อมูลในแท็บ JSON มีค่าใหม่ด้วย', json.includes('ขออนุญาตเปลี่ยนประจำรถ'), json.replace(/\s+/g, ' ').slice(0, 100))
  await evaluate(`(() => {
    const btn = [...document.querySelectorAll('.editor-split > .editor-col:not(.editor-col--right) .tabs__tab')]
      .find((t) => t.textContent.trim() === 'ฟอร์ม')
    btn?.click()
    return true
  })()`)
  await sleep(600)
}

// ── 5. ถามต่อได้หลายรอบ ─────────────────────────────────────────
console.log('\n[5] ถามต่อได้ — ประวัติอยู่ใน popover')
{
  await clickAi('เรื่อง')
  await waitFor("!!document.querySelector('.fieldai__pop')", 8000)
  await realClick('.fieldai__tools .pill', 0) // ปุ่ม "ร่างให้"
  const replied = await waitFor("document.querySelectorAll('.fieldai__msg--ai').length >= 1", 25000)
  check('คุยรอบที่สองได้', replied)
  const turns = await evaluate("document.querySelectorAll('.fieldai__msg').length")
  check('มีทั้งคำถามและคำตอบเก็บไว้', turns >= 2, `${turns} ข้อความ`)
}

// ── 6. Esc / คลิกที่อื่น → ปิด ───────────────────────────────────
console.log('\n[6] ปิด popover')
{
  check('เปิดอยู่ก่อนทดสอบ', await evaluate("!!document.querySelector('.fieldai__pop')"))
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await sleep(400)
  check('กด Esc แล้วปิด', !(await evaluate("!!document.querySelector('.fieldai__pop')")))

  await clickAi('เรื่อง')
  await waitFor("!!document.querySelector('.fieldai__pop')", 8000)
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 20, y: 20, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 20, y: 20, button: 'left', clickCount: 1 })
  await sleep(400)
  check('คลิกที่อื่นแล้วปิด', !(await evaluate("!!document.querySelector('.fieldai__pop')")))
}

// ── 7. ช่องตัวเลข: AI ตอบมาไม่ใช่ตัวเลข → ห้ามทำให้ช่องเพี้ยน ───────
console.log('\n[7] ช่องตัวเลข — กัน AI ใส่ค่าที่พังช่อง')
{
  const moneyId = await inputIdOf('จำนวนเงิน')
  await clickAi('จำนวนเงิน')
  const open = await waitFor("!!document.querySelector('.fieldai__pop')", 8000)
  check('เปิดผู้ช่วยของช่องตัวเลขได้', open, `id=${moneyId}`)
  // โหมด mock คืนข้อความดิบกลับมา ซึ่งตั้งใจให้เป็นคำที่ไม่ใช่ตัวเลข
  await typeInto('.fieldai__composer textarea', 'ประมาณห้าพันบาท')
  const sent = await realClick('.fieldai__composer button')
  check('กดส่งได้', sent)
  const got = await waitFor("!!document.querySelector('.fieldai__apply')", 25000)
  check('ได้ข้อเสนอกลับมา', got, (await evaluate("document.querySelector('.fieldai__log')?.innerText ?? ''"))?.slice(0, 120).replace(/\n/g, ' '))
  await realClick('.fieldai__apply')
  await sleep(600)
  const v = await evaluate(`document.getElementById(${JSON.stringify(moneyId)})?.value ?? ''`)
  check('ช่องตัวเลขไม่ถูกใส่คำที่พัง', v === '' || !Number.isNaN(Number(v)), `ค่า="${v}"`)
  const warned = await evaluate(
    // Banner ใช้ class `pill ok` (ดู Banner ใน Studio.tsx) — ไม่ใช่ `banner`
    "[...document.querySelectorAll('.pill')].some((b) => b.textContent.includes('ไม่ใช่ตัวเลข'))",
  )
  check('แจ้งเตือนว่า AI ตอบมาไม่ใช่ตัวเลข', warned, (await evaluate("document.body.innerText"))?.match(/[^\n]*ไม่ใช่ตัวเลข[^\n]*/)?.[0] ?? '(ไม่มีข้อความ)')
  await shot('04-number-guard.png')
}

// ── เก็บกวาด ───────────────────────────────────────────────────
await fetch(`${API}/api/form/${key}`, { method: 'DELETE', headers: H })
await send('Browser.close').catch(() => {})
chrome.kill()
await redis.del(`session:${sid}`)
redis.disconnect()

console.log(`\n── ผ่าน ${pass} · ไม่ผ่าน ${fail} ─────────────────────`)
console.log(`ภาพ: ${OUT.pathname}\n`)
process.exit(fail ? 1 : 0)
