/**
 * ตรวจตัวแก้ไขช่องฟอร์ม — โฟกัสต้องไม่หลุด และเพิ่มตัวเลือกเองได้
 *
 *   node --env-file=../dokploy-infra/.env --env-file=../dokploy-infra/.env.development tools/test-field-builder.mjs
 *
 * ── ปัญหาที่เคยเจอ ────────────────────────────────────────────
 * 1. React `key` ของแถวช่องเป็น `${f.key}-${i}` → พิมพ์ในช่อง key ครั้งเดียว
 *    ค่า key เปลี่ยน → React ถอด element แล้วใส่ใหม่ → **โฟกัสหลุดทุกตัวอักษร**
 *    และ IME ไทยพังทันที (input ที่กำลัง "เรียงพิมพ์" ถูกทำลายกลางคัน)
 *
 * 2. ช่อง select เพิ่มตัวเลือกเองไม่ได้ มีแต่ textarea รูปแบบ `ค่า|ป้าย`
 *    ผู้ใช้บอกว่า "ใช้งานแล้วไม่พบตัวเลือก ให้สามารถเพิ่มเพิ่มลงไปได้"
 *
 * ── สิ่งที่ต้องผ่าน ────────────────────────────────────────────
 * 1. พิมพ์ทีละตัวอักษรแล้วโฟกัสยังอยู่ที่ช่องเดิม (จำลอง IME ไทยด้วย composition)
 * 2. พิมพ์ภาษาไทยแบบ composition แล้วได้ข้อความครบ ไม่ถูกตัดกลางคัน
 * 3. เพิ่มตัวเลือกเองได้ ค่า/ป้ายแยกกันได้ และลบตัวเลือกทิ้งได้
 * 4. กล่องเพิ่มหลายบรรทัดต้องไม่เขียนทับสิ่งที่ผู้ใช้พิมพ์กลางคัน
 *    (พิมพ์ "นาย" ต้องได้ "นาย" ไม่ใช่ "นาย|นาย")
 * 5. บันทึกแล้วตัวเลือกที่เพิ่มต้องไปอยู่บนเซิร์ฟเวอร์จริง
 */
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Redis } from 'ioredis'
import { keyOf, pickTemplate, TEST_TEMPLATES } from './lib/pick-template.mjs'
import { importTags, restoreForm, snapshotForm } from './lib/studio-seed.mjs'

const CHROME = process.env.CHROME_PATH ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const PORT = 9391
const WEB = 'http://localhost:3000'
const OUT = new URL('../tests/nav-status/output-field-builder/', import.meta.url)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
mkdirSync(OUT, { recursive: true })

let pass = 0
let fail = 0
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`)
  ok ? pass++ : fail++
}

const redis = new Redis(process.env.VALKEY_URL)
const sid = `fb-${Date.now()}`
await redis.set(
  `session:${sid}`,
  JSON.stringify({ sub: sid, name: 'ผู้ทดสอบช่องฟอร์ม', email: 'fb@test.local', avatar: '' }),
  'EX',
  1800,
)
const H = { cookie: `docgen_session=${sid}`, 'content-type': 'application/json' }
const API = 'http://127.0.0.1:4001'

const tpl = await pickTemplate(H, [TEST_TEMPLATES.onepage])
const key = keyOf(tpl)
const formSnap = await snapshotForm(H, key)
await importTags(H, tpl)
console.log(`ใช้แม่แบบ: ${tpl.name} (key ${key})`)

const profile = mkdtempSync(join(tmpdir(), 'cdp-fb-'))
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
    wsUrl = list.find((x) => x.type === 'page')?.webSocketDebuggerUrl
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
const waitFor = async (expr, timeoutMs = 30000, step = 200) => {
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

await send('Page.enable')
await send('Runtime.enable')
await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false })
await send('Network.setCookie', { name: 'docgen_session', value: sid, url: WEB })
await send('Network.setCacheDisabled', { cacheDisabled: true })

await send('Page.navigate', { url: `${WEB}/studio/${key}?tabs=form&pane=fields` })
/**
 * ⚠️ ต้องรอให้หน้าโหลดเสร็จจริง แล้วค่อยเริ่มทดสอบ
 *    ถ้าไม่รอแล้วเดินต่อ เทสต์จะพังทั้งชุดโดยไม่บอกเหตุผลที่แท้จริง
 *
 * ⚠️ อย่ารอด้วย `!!document.querySelector('button')` — หน้าบูตก็มีปุ่มอยู่แล้ว
 *    จะผ่านเงื่อนไขทันทีที่ยังโชว์ "กำลังเชื่อมระบบ…" (เคยเจอ)
 *    ต้องรอปุ่มที่เราจะกดจริง ๆ คือ "แก้ไข" ในรายการช่อง
 */
const loaded = await waitFor(
  "[...document.querySelectorAll('button')].some((b) => b.textContent.trim() === 'แก้ไข')",
  120000,
)
if (!loaded) {
  console.log('✗ หน้าแก้ไขแม่แบบยังโหลดไม่เสร็จ — เทสต์นี้ทำต่อไม่ได้')
  await shot('00-load-failed.png')
  await restoreForm(H, key, formSnap)
  await send('Browser.close').catch(() => {})
  chrome.kill()
  await redis.del(`session:${sid}`)
  redis.disconnect()
  process.exit(1)
}
await sleep(600)

/** คลิกปุ่ม "แก้ไข" ของแถวชองแรก เพื่อเปิดฟอร์มแก้ไข */
const openEditor = async () => {
  const ok = await evaluate(`(() => {
    const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === 'แก้ไข')
    if (!b) return false
    b.scrollIntoView({ block: 'center' })
    const r = b.getBoundingClientRect()
    const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)
    return !!hit && (b === hit || b.contains(hit))
  })()`)
  if (!ok) return false
  const b = await evaluate(`(() => {
    const el = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === 'แก้ไข')
    const r = el.getBoundingClientRect()
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
  })()`)
  for (const type of ['mousePressed', 'mouseReleased'])
    await send('Input.dispatchMouseEvent', { type, x: b.x, y: b.y, button: 'left', clickCount: 1 })
  return waitFor("!!document.querySelector('[data-testid^=\"field-key-\"]')", 15000)
}

console.log('\n[1] พิมพ์ในช่อง key ต้องไม่ทำให้โฟกัสหลุด')
check('เปิดฟอร์มแก้ไขช่องได้', await openEditor())

/**
 * ⚠️ ต้องใช้ `field-key-` **เท่านั้น**
 *    ช่อง `field-group-` (กลุ่ม) เปลี่ยนค่าแล้วฟิลด์จะย้ายไปอยู่กลุ่มอื่น
 *    → React ถอดแล้วใส่ใหม่ทั้งกลุ่ม → โฟกัสหลุด
 *    นั่นไม่ใช่บั๊ก แต่เป็นพฤติกรรมที่ถูกต้อง (ย้ายกลุ่มแล้วควรไปอยู่กลุ่มใหม่)
 */
const KEY_SEL = '[data-testid="field-key-0"]'

const before = await evaluate(`(() => {
  const el = document.querySelector(${JSON.stringify(KEY_SEL)})
  if (!el) return null
  el.focus()
  return { value: el.value, id: el === document.activeElement }
})()`)
check('โฟกัสช่อง key ได้', before?.id === true, before ? `ค่าเดิม="${before.value}"` : 'หา input ไม่เจอ')

/**
 * ⚠️ พิมพ์ทีละตัวอักษรด้วย **การกดปุ่มจริง** ไม่ใช่ `el.value = …`
 *    เพราะการเขียนค่าเรนเดอร์ข้ามเส้นทางของเบราว์เซอร์ไป
 *
 * ⚠️ `keyDown` ห้ามส่ง `text` มาด้วย — ถ้าส่งจะแทรกอักขระตอนกด
 *    แล้วพอยิง `char` อีกครั้งมันจะแทรกซ้ำ (ได้ "นนาายย" จาก "นาย")
 *    ให้ `keyDown`/`keyUp` ไปแค่บอกว่ากดปุ่ม แล้วให้ `char` เป็นตัวแทรกข้อความ
 */
const typeInto = async (sel, text) => {
  for (const ch of text) {
    const box = await evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(sel)})
      if (!el) return null
      el.focus()
      const r = el.getBoundingClientRect()
      return { x: r.x + r.width / 2, y: r.y + r.height / 2, focused: el === document.activeElement }
    })()`)
    if (!box?.focused) return false
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: ch })
    await send('Input.dispatchKeyEvent', { type: 'char', key: ch, text: ch })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch })
    await sleep(60)
  }
  return true
}

const typed = await typeInto(KEY_SEL, 'ทดสอบ')
check('พิมพ์ทีละตัวอักษรได้ครบ', typed)

const afterType = await evaluate(`(() => {
  const el = document.querySelector(${JSON.stringify(KEY_SEL)})
  return { value: el?.value ?? '', focused: el === document.activeElement }
})()`)
check('โฟกัสยังอยู่ที่ช่องเดิมหลังพิมพ์ (ไม่หลุด)', afterType.focused, `activeElement คือช่อง = ${afterType.focused}`)
/**
 * ⚠️ ช่อง key มีค่าเดิมอยู่แล้ว และเคอร์เซอร์อยู่ท้ายข้อความเดิม
 *    การพิมพ์จึง "ต่อท้าย" ไม่ใช่ "แทนที่" — ต้องเทียบปลายประโยค
 *    (เคยเขียนว่าเท่ากับ "ทดสอบ" ตรง ๆ แล้วตก ทั้งที่แอปทำถูก)
 */
check(
  'ข้อความที่พิมพ์ต่อท้ายของเดิม ไม่ถูกเขียนทับ',
  afterType.value.endsWith('ทดสอบ') && afterType.value.length > 'ทดสอบ'.length,
  `"${before?.value}" → "${afterType.value}"`,
)
await shot('01-typed.png')

console.log('\n[2] จำลอง IME ไทย — ต้องไม่ถูกตัดกลางคัน')
const imeOk = await evaluate(`(() => {
  const el = document.querySelector(${JSON.stringify(KEY_SEL)})
  if (!el) return null
  const before = el.value
  el.focus()
  el.setSelectionRange(el.value.length, el.value.length)
  const fire = (type, data) =>
    el.dispatchEvent(new InputEvent(type, { bubbles: true, cancelable: true, data, inputType: 'insertCompositionText' }))
  const ce = (type, data) => el.dispatchEvent(new CompositionEvent(type, { bubbles: true, data }))
  ce('compositionstart', '')
  fire('beforeinput', 'ไ')
  fire('input', 'ไ')
  fire('beforeinput', 'ใ')
  fire('input', 'ใ')
  ce('compositionend', 'ไ')
  fire('input', 'ไ')
  return { before, after: el.value, focused: el === document.activeElement }
})()`)
check('IME ไม่ทำให้ element ถูกสร้างใหม่', imeOk?.focused === true, `โฟกัสยังอยู่ = ${imeOk?.focused}`)
check(
  'ข้อความจากการเรียงพิมพ์ไม่หายและไม่ถูกทับ',
  typeof imeOk?.after === 'string' && imeOk.after.startsWith(imeOk.before),
  `"${imeOk?.before}" → "${imeOk?.after}"`,
)

console.log('\n[3] เพิ่มตัวเลือกเองได้')
// เปลี่ยนช่องแรกให้เป็น select ก่อน
await evaluate(`(() => {
  const sel = document.querySelector('[data-testid="field-type-0"]')
  if (!sel) return false
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set
  setter.call(sel, 'select')
  sel.dispatchEvent(new Event('change', { bubbles: true }))
  return true
})()`)
const hasAdd = await waitFor("!!document.querySelector('[data-testid^=\"add-option-\"]')", 10000)
check('มีปุ่ม "+ เพิ่มตัวเลือก"', hasAdd)

const clickTestId = async (id) => {
  const b = await evaluate(`(() => {
    const el = document.querySelector('[data-testid=${JSON.stringify(id)}]')
    if (!el) return null
    el.scrollIntoView({ block: 'center' })
    const r = el.getBoundingClientRect()
    const x = r.x + r.width / 2, y = r.y + r.height / 2
    const hit = document.elementFromPoint(x, y)
    return { ok: !!hit && (el === hit || el.contains(hit)), x, y }
  })()`)
  if (!b?.ok) return false
  for (const type of ['mousePressed', 'mouseReleased'])
    await send('Input.dispatchMouseEvent', { type, x: b.x, y: b.y, button: 'left', clickCount: 1 })
  return true
}

const idx = await evaluate(`(() => (document.querySelector('[data-testid^="add-option-"]')?.dataset.testid ?? '').match(/(\d+)$/)?.[1] ?? '0')()`)
const idxN = Number(idx)
check('กด "+ เพิ่มตัวเลือก" ได้', await clickTestId(`add-option-${idxN}`))
await sleep(200)
check('มีช่องให้กรอกค่าของตัวเลือกใหม่', await evaluate(`!!document.querySelector('[data-testid="option-value-${idxN}-0"]')`))

/** พิมพ์ค่าและป้ายของตัวเลือกใหม่ — ใช้ keyDown ไม่ส่ง text + char ส่ง text (ดู typeInto) */
const fillOption = async (id, text) => {
  const box = await evaluate(`(() => {
    const el = document.querySelector('[data-testid=${JSON.stringify(id)}]')
    if (!el) return null
    el.focus()
    const r = el.getBoundingClientRect()
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
  })()`)
  if (!box) return false
  for (const ch of text) {
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: ch })
    await send('Input.dispatchKeyEvent', { type: 'char', key: ch, text: ch })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch })
    await sleep(50)
  }
  return true
}
await fillOption(`option-value-${idxN}-0`, 'นาย')
await fillOption(`option-label-${idxN}-0`, 'นาย (เต็มชื่อ)')
await sleep(250)

const optVals = await evaluate(`(() => {
  const v = document.querySelector('[data-testid="option-value-${idxN}-0"]')?.value ?? ''
  const l = document.querySelector('[data-testid="option-label-${idxN}-0"]')?.value ?? ''
  return { v, l }
})()`)
check('กรอกค่าตัวเลือกได้', optVals.v === 'นาย', `"${optVals.v}"`)
check('กรอกป้ายตัวเลือกได้ (แยกจากค่า)', optVals.l === 'นาย (เต็มชื่อ)', `"${optVals.l}"`)

await clickTestId(`add-option-${idxN}`)
await sleep(200)
const two = await evaluate(`document.querySelectorAll('[data-testid^="option-value-${idxN}-"]').length`)
check('เพิ่มตัวเลือกที่สองได้', two === 2, `มี ${two} แถว`)
await shot('02-options.png')

check('กด "ลบ" แล้วตัวเลือกหาย', await clickTestId(`option-remove-${idxN}-1`))
await sleep(200)
check('เหลือตัวเลือกเดียว', (await evaluate(`document.querySelectorAll('[data-testid^="option-value-${idxN}-"]').length`)) === 1)

console.log('\n[4] กล่องเพิ่มหลายบรรทัดต้องไม่เขียนทับสิ่งที่พิมพ์')
const bulk = await evaluate(`(() => {
  const ta = document.querySelector('[data-testid^="bulk-options-"]')
  if (!ta) return null
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
  // พิมพ์ทีละคำแบบไม่มี "|" — ถ้าโค้ดเขียนทับกลางคันจะกลายเป็น "นาย|นาย"
  setter.call(ta, '')
  ta.dispatchEvent(new Event('input', { bubbles: true }))
  const step1 = ta.value
  setter.call(ta, 'นาย')
  ta.dispatchEvent(new Event('input', { bubbles: true }))
  return { step1, step2: ta.value, caret: ta.selectionStart }
})()`)
check('พิมพ์บรรทัดเดียวแล้วข้อความตรงตามที่พิมพ์', bulk?.step2 === 'นาย', `"${bulk?.step2}"`)

console.log('\n[5] บันทึกแล้วตัวเลือกต้องไปอยู่บนเซิร์ฟเวอร์จริง')
const saved = await evaluate(`(() => {
  const b = [...document.querySelectorAll('button')].find((x) => x.textContent.includes('บันทึกช่องฟอร์ม'))
  if (!b) return { ok: false, why: 'ไม่พบปุ่มบันทึก' }
  if (b.disabled) return { ok: false, why: 'ปุ่มบันทึกถูก disable (ไม่มีอะไรเปลี่ยน?)' }
  b.scrollIntoView({ block: 'center' })
  const r = b.getBoundingClientRect()
  const x = r.x + r.width / 2, y = r.y + r.height / 2
  const hit = document.elementFromPoint(x, y)
  return { ok: !!hit && (b === hit || b.contains(hit)), x, y, why: ok => 'ถูกอย่างอื่นบัง' }
})()`)
if (!saved.ok) console.log('    [ดีบัก] กดบันทึกไม่ได้:', saved.why)
if (saved.ok) {
  for (const type of ['mousePressed', 'mouseReleased'])
    await send('Input.dispatchMouseEvent', { type, x: saved.x, y: saved.y, button: 'left', clickCount: 1 })
}

// อ่านกลับแบบลองซ้ำ — เซิร์ฟเวอร์อาจยังไม่ตอบจบตอนกดเสร็จ
let server = { fields: [] }
for (let i = 0; i < 12; i++) {
  await sleep(500)
  server = await (await fetch(`${API}/api/form/${key}`, { headers: H })).json()
  if ((server.fields ?? []).some((f) => (f.options ?? []).some((o) => o.value === 'นาย'))) break
}
const anyOpts = (server.fields ?? []).find((f) => (f.options ?? []).some((o) => o.value === 'นาย'))
check('ตัวเลือกที่เพิ่มถูกบันทึกขึ้นเซิร์ฟเวอร์', !!anyOpts, anyOpts ? `ฟิลด์ ${anyOpts.key} มี ${anyOpts.options.length} ตัวเลือก` : `บันทึกได้=${!!saved.ok} · ช่องบนเซิร์ฟเวอร์=${(server.fields ?? []).map((f) => `${f.key}:${(f.options ?? []).length}`).join(', ') || 'ไม่มีช่อง'}`)

// เก็บกวาด
await restoreForm(H, key, formSnap)
await send('Browser.close').catch(() => {})
chrome.kill()
await redis.del(`session:${sid}`)
redis.disconnect()

console.log(`\n── ผ่าน ${pass} · ไม่ผ่าน ${fail} ─────────────────────`)
console.log(`ภาพ: ${OUT.pathname}\n`)
process.exit(fail ? 1 : 0)
