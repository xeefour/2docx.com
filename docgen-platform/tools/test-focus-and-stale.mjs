/**
 * โฟกัสหลุดเวลาพิมพ์ + overlay เตือนเรนเดอร์ใหม่
 *
 *   node --env-file=../dokploy-infra/.env --env-file=../dokploy-infra/.env.development tools/test-focus-and-stale.mjs
 *
 * ── เรื่องที่ผู้ใช้รายงาน ──────────────────────────────────────
 *  1. *"พิมพ์ 1 ตัวอักษา แล้วหลุด focus ต้องคลิกใหม่ถึงจะพิมพ์ได้"*
 *  2. *"เมื่อ form หรือ json มีการแก้ไขข้อมูล ให้ส่วนของ preview
 *      มี overlay ขึ้นมาเตือนผู้ใช้ว่าต้องการจะเรนเดอร์ใหม่หรือไม่"*
 *
 * ── สาเหตุข้อ 1 ────────────────────────────────────────────────
 * `key` ของกลุ่มฟิลด์เคยเป็น **ชื่อกลุ่ม** และกลุ่มถูกเรียงตามชื่อ
 *   พิมพ์ช่อง "กลุ่ม" 1 ตัวอักษร → ชื่อกลุ่มเปลี่ยน → ลำดับกลุ่มเปลี่ยน
 *   → React ย้าย DOM node ของทั้งกลุ่ม (ซึ่งกำลังมีโฟกัสอยู่) → โฟกัสหลุด
 *   และ IME ไทยพังหนักกว่านั้น เพราะ input ที่กำลัง "เรียงพิมพ์" ถูกย้ายกลางคัน
 *
 * ⚠️ เทสต์นี้**ไม่แก้ฟอร์มที่บันทึกไว้** — แก้แล้วไม่กดบันทึก จึงไม่ทิ้งขยะ
 *
 * ── สิ่งที่ต้องผ่าน ─────────────────────────────────────────────
 * [1] เปิดแผงแก้ไขของช่องได้
 * [2] พิมพ์ชื่อกลุ่มหลายตัวอักษรแล้วโฟกัสยังอยู่ที่ช่องเดิม (DOM node เดิมด้วย)
 * [3] ค่าในช่องตรงกับที่พิมพ์ครบ (ไม่มีตัวอักษรหาย/ซ้ำ)
 * [4] พิมพ์ชื่อช่อง (key) แล้วโฟกัสยังอยู่
 * [5] เรนเดอร์แล้วยังไม่มี overlay
 * [6] แก้ฟอร์มแล้วมี overlay บนตัวอย่าง + ป้ายเตือนบนแถบเครื่องมือ
 * [7] "ใช้ผลเดิมต่อไป" แล้ว overlay หาย
 * [8] แก้เพิ่มแล้ว overlay กลับมา
 * [9] เรนเดอร์ใหม่จากใน overlay แล้ว overlay หาย
 */
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Redis from 'ioredis'

const API = process.env.API_URL ?? 'http://127.0.0.1:4001'
const WEB = 'http://localhost:3000'
const CHROME = process.env.CHROME_PATH ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const PORT = 9386
const STAMP = Date.now()
/**
 * สองแม่แบบ เพราะต้องการคนละแบบ
 *
 * · FOCUS_KEY — มี 3 กลุ่ม (หนังสือ / เนื้อหา / ทดสอบ) ทดสอบชื่อกลุ่มได้แรง
 * · STALE_KEY — ไม่มีช่อง `required` เลย เรนเดอร์ผ่านแน่ ไม่ติด validation
 */
const FOCUS_KEY = process.env.FOCUS_KEY ?? '1521834214022732219'
const STALE_KEY = process.env.STALE_KEY ?? '1521017978531416614'
const OUT = new URL('../tests/nav-status/output-focus-stale/', import.meta.url)
mkdirSync(OUT, { recursive: true })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let pass = 0
let fail = 0
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`)
  ok ? pass++ : fail++
}

const redis = new Redis(process.env.VALKEY_URL)
/** ⚠️ sid ต้องเป็น ASCII — sid ไปอยู่ใน cookie ซึ่งเป็น HTTP header */
const sid = `focus-${STAMP}`
await redis.set(
  `session:${sid}`,
  JSON.stringify({ sub: sid, name: 'ผู้ทดสอบโฟกัส', email: `focus-${STAMP}@test.local`, avatar: '' }),
  'EX',
  1800,
)
const H = { cookie: `docgen_session=${sid}` }

/**
 * ชำนวณ `id` ของช่องกรอก — ต้องตรงกับ `fieldDomId()` ใน
 * `apps/web/app/studio/lib/fields.ts` (slug มีแค่ \w และ - จึงปลอดภัยกับ CSS selector)
 */
function fieldDomId(key) {
  let h = 5381
  for (let i = 0; i < key.length; i++) h = ((h * 33) ^ key.charCodeAt(i)) >>> 0
  const slug = key.replace(/[^\w-]/g, '_').slice(0, 20) || 'x'
  return `f-${slug}-${h.toString(36)}`
}

const formOf = async (key) =>
  (await (await fetch(`${API}/api/form/${key}`, { headers: H })).json()).fields ?? []
const focusFields = await formOf(FOCUS_KEY)
const staleFields = await formOf(STALE_KEY)

const firstText = (fields) => fields.find((f) => f.type === 'text' || f.type === 'textarea')
const focusField = firstText(focusFields)
const staleField = firstText(staleFields)
if (!focusField || !staleField) {
  console.log('✗ ต้องการที่มีช่องข้อความอย่างน้อย 1 แม่แบบ')
  await redis.del(`session:${sid}`)
  redis.disconnect()
  process.exit(1)
}
const FIELD_SEL = `#${fieldDomId(staleField.key)}`

// ── เปิด Chrome ──────────────────────────────────────────────
const profile = mkdtempSync(join(tmpdir(), 'cdp-focus-'))
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
const waitFor = async (expr, ms = 25000) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    try {
      if (await evaluate(expr)) return true
    } catch {}
    await sleep(250)
  }
  return false
}
/** คลิกแบบคนจริง (ห้ามใช้ element.click()) + ยืนยันว่าจุดที่คลิกโดนปุ่มนั้นจริง */
const click = async (selector) => {
  const hit = await evaluate(`(() => {
    const b = document.querySelector(${JSON.stringify(selector)})
    if (!b) return { ok: false, why: 'ไม่เจอปุ่ม' }
    b.scrollIntoView({ block: 'center' })
    const r = b.getBoundingClientRect()
    const x = r.x + r.width / 2, y = r.y + r.height / 2
    const el = document.elementFromPoint(x, y)
    return { ok: !!el && (el === b || b.contains(el)), why: 'จุดคลิกโดนชั้นอื่น', x, y }
  })()`)
  if (!hit?.ok) return { ok: false, why: hit?.why ?? 'ไม่รู้สาเหตุ' }
  for (const type of ['mousePressed', 'mouseReleased'])
    await send('Input.dispatchMouseEvent', { type, x: hit.x, y: hit.y, button: 'left', clickCount: 1 })
  return { ok: true }
}
/** พิมพ์เหมือน IME ไทย (ข้อความเข้ามาทีเดียว) — ถ้าโฟกัสหลุด ข้อความจะหายไป */
const typeThai = (text) => send('Input.insertText', { text })
const shot = async (name) => {
  const { data } = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(new URL(name, OUT), Buffer.from(data, 'base64'))
}

await send('Page.enable')
await send('Runtime.enable')
await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false })
await send('Network.setCacheDisabled', { cacheDisabled: true })
await send('Network.setCookie', { name: 'docgen_session', value: sid, url: WEB })

// ── [1–4] โฟกัสหลุดเวลาพิมพ์ ───────────────────────────────────
console.log(`\n── [1] โฟกัสไม่หลุดเวลาพิมพ์ (แม่แบบ ${FOCUS_KEY}) ─────────\n`)
await send('Page.navigate', { url: `${WEB}/studio/${FOCUS_KEY}?tabs=form&pane=fields` })
await waitFor('!document.querySelector(".bootveil")', 45000)
await waitFor('!!document.querySelector("[data-testid=\'field-edit-0\']")', 25000)

const opened = await click('[data-testid="field-edit-0"]')
check('[1] เปิดแผงแก้ไขของช่องได้', opened.ok && (await waitFor(`!!document.querySelector('[data-testid="field-group-0"]')`, 15000)), opened.why ?? '')

/** ผูกตัวอ้างไว้ก่อนพิมพ์ เพื่อจับการ remount (node เดิม vs node ใหม่) */
const arm = (sel, varName) =>
  evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(sel)})
    if (!el) return false
    window[${JSON.stringify(varName)}] = el
    el.focus()
    return document.activeElement === el
  })()`)

const armed = await evaluate(`(() => {
  const el = document.querySelector('[data-testid="field-group-0"]')
  if (!el) return null
  window.__probe = el
  window.__before = el.value
  el.focus()
  return document.activeElement === el ? el.value : null
})()`)
check('โฟกัสช่อง "กลุ่ม" ได้', armed !== null, `ค่าเดิม = "${armed}"`)

const GROUP_TYPED = 'ทดสอบโฟกัส'
await typeThai(GROUP_TYPED)
await sleep(500)

const afterType = await evaluate(`(() => {
  const el = document.querySelector('[data-testid="field-group-0"]')
  return {
    sameNode: window.__probe === el,
    stillFocused: document.activeElement === el,
    activeTag: document.activeElement ? document.activeElement.tagName : '?',
    before: window.__before,
    value: el ? el.value : null,
  }
})()`)
check(
  '[2] พิมพ์ชื่อกลุ่มแล้วโฟกัสยังอยู่ที่ช่องเดิม (DOM node เดิมด้วย)',
  afterType.sameNode && afterType.stillFocused,
  `sameNode=${afterType.sameNode} focused=${afterType.stillFocused} activeElement=<${afterType.activeTag.toLowerCase()}>`,
)
/**
 * ⚠️ ช่องอาจมีค่าเดิมอยู่แล้ว (ชื่อกลุ่มเดิมของแม่แบบ) → ต้องเทียบ "เดิม + ที่พิมพ์"
 *    ไม่ใช่เทียบกับข้อความที่พิมพ์อย่างเดียว
 */
check(
  '[3] ค่าในช่องตรงกับที่พิมพ์ครบ (ต่อท้ายค่าเดิม ไม่มีตัวอักษรหาย/ซ้ำ)',
  afterType.value === `${afterType.before}${GROUP_TYPED}`,
  `"${afterType.before}" + "${GROUP_TYPED}" = "${afterType.value}"`,
)
await shot('01-group-typed.png')

const armedKey = await arm('[data-testid="field-key-0"]', '__probe2')
if (armedKey) {
  await typeThai('ทดสอบ')
  await sleep(400)
  const k = await evaluate(`(() => {
    const el = document.querySelector('[data-testid="field-key-0"]')
    return { same: window.__probe2 === el, focused: document.activeElement === el }
  })()`)
  check('[4] พิมพ์ชื่อช่อง (key) แล้วโฟกัสยังอยู่', k.same && k.focused, `same=${k.same} focused=${k.focused}`)
} else {
  check('[4] พิมพ์ชื่อช่อง (key) แล้วโฟกัสยังอยู่', false, 'หา field-key-0 ไม่เจอ')
}

// ── [5–9] overlay เตือนเรนเดอร์ใหม่ ───────────────────────────
console.log('\n[2] แก้ข้อมูลแล้วขึ้น overlay บอกให้เรนเดอร์ใหม่')
await send('Page.navigate', { url: `${WEB}/studio/${STALE_KEY}?tabs=form&pane=preview` })
await waitFor('!document.querySelector(".bootveil")', 45000)
await waitFor(`!!document.querySelector('${FIELD_SEL}')`, 25000)

const renderClick = await click('[data-testid="render-preview"]')
check('กดเรนเดอร์ตัวอย่างได้', renderClick.ok, renderClick.why ?? '')
check('เรนเดอร์เสร็จ (มี canvas)', await waitFor('!!document.querySelector("canvas")', 90000))
check('[5] ยังไม่มี overlay ตอนยังไม่ได้แก้ข้อมูล', !(await evaluate(`!!document.querySelector('[data-testid="preview-stale"]')`)))
await shot('02-rendered.png')

/** แก้ช่องข้อความในฟอร์ม (ฝั่งซ้าย) ให้ค่าต่างจากเดิม */
const typeIntoField = async (text) => {
  const ok = await evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(FIELD_SEL)}) || document.querySelector('.editor-col input:not([type=checkbox])')
    if (!el) return false
    el.scrollIntoView({ block: 'center' })
    el.focus()
    return document.activeElement === el
  })()`)
  if (!ok) return false
  await typeThai(text)
  await sleep(600)
  return true
}

check('พิมพ์แก้ค่าในฟอร์มได้', await typeIntoField(' ทดสอบแก้ค่า'))
check('[6] overlay ขึ้นหลังแก้ค่าในฟอร์ม', await waitFor(`!!document.querySelector('[data-testid="preview-stale"]')`, 8000))
check('ป้ายเตือนบนแถบเครื่องมือขึ้นด้วย', await evaluate(`!!document.querySelector('[data-testid="preview-stale-badge"]')`))
check(
  'overlay บอกให้เลือกว่าจะเรนเดอร์ใหม่ไหม',
  /ต้องการเรนเดอร์ใหม่/.test(await evaluate(`document.querySelector('[data-testid="preview-stale"]')?.textContent ?? ''`)),
)
await shot('03-stale-overlay.png')

const dismiss = await click('[data-testid="preview-stale-dismiss"]')
await sleep(500)
check('[7] กด "ใช้ผลเดิมต่อไป" แล้ว overlay หาย', dismiss.ok && !(await evaluate(`!!document.querySelector('[data-testid="preview-stale"]')`)), dismiss.why ?? '')

check('พิมพ์แก้ค่าเพิ่มได้', await typeIntoField(' เพิ่ม'))
check('[8] แก้เพิ่มแล้ว overlay กลับมา', await waitFor(`!!document.querySelector('[data-testid="preview-stale"]')`, 8000))

const rerender = await click('[data-testid="preview-stale-render"]')
check('กด "เรนเดอร์ใหม่" ใน overlay ได้', rerender.ok, rerender.why ?? '')
check('[9] เรนเดอร์ใหม่แล้ว overlay หาย', await waitFor(`!document.querySelector('[data-testid="preview-stale"]')`, 90000))
check('ป้ายเตือนบนแถบเครื่องมือหายด้วย', !(await evaluate(`!!document.querySelector('[data-testid="preview-stale-badge"]')`)))
await shot('04-after-rerender.png')

await send('Browser.close').catch(() => {})
chrome.kill()
await redis.del(`session:${sid}`)
redis.disconnect()
console.log(`\n── ผ่าน ${pass} · ไม่ผ่าน ${fail} ─────────────────────`)
console.log(`ภาพ: ${OUT.pathname}\n`)
process.exit(fail ? 1 : 0)
