/**
 * ตรวจไม้บรรทัด (ruler) บนพรีวิวเอกสาร
 *
 *   node --env-file=.env tools/test-ruler-ui.mjs
 *
 * ── สิ่งที่ต้องผ่าน ────────────────────────────────────────────
 * 1. มีปุ่มสลับไม้บรรทัดในแถบเครื่องมือ
 * 2. เปิดแล้วได้ไม้บรรทัดบน + ซ้าย พร้อมกัน
 * 3. **ตำแหน่ง 0 ของไม้บรรทัดตรงขอบกระดาษเป๊ะ** (สำคัญที่สุด — ไม้บรรทัดที่เพี้ยนแล้ววัดผิด)
 * 4. ความยาวไม้บรรทัด = ความกว้าง canvas ไม่เกิน 1px
 * 5. ตัวเลขแรกคือ 0 และตัวสุดท้ายไม่เกินขนาดกระดาษจริง (A4 = 21 ซม.)
 * 6. สลับหน่วย ซม. ↔ นิ้ว ได้ และตัวเลขเปลี่ยนตาม
 * 7. จำค่าไว้ข้ามการรีเฟรช
 * 8. ซ่อนไม้บรรทัดแล้ว canvas ไม่เลื่อน (กลับเป็นกลางจอเหมือนเดิม)
 * 9. ซูมแล้วไม้บรรทัดยังตรงขอบกระดาษ
 */
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Redis } from 'ioredis'

const CHROME = process.env.CHROME_PATH ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const PORT = 9371
const WEB = 'http://localhost:3000'
const OUT = new URL('../tests/nav-status/output-ruler/', import.meta.url)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
mkdirSync(OUT, { recursive: true })

let pass = 0
let fail = 0
let skip = 0
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`)
  ok ? pass++ : fail++
}

const redis = new Redis(process.env.VALKEY_URL)
const sid = `ruler-${Date.now()}`
await redis.set(
  `session:${sid}`,
  JSON.stringify({ sub: sid, name: 'ผู้ทดสอบไม้บรรทัด', email: 'ruler@test.local', avatar: '' }),
  'EX',
  1800,
)
const H = { cookie: `docgen_session=${sid}`, 'content-type': 'application/json' }
const API = 'http://127.0.0.1:4001'

const templates = (await (await fetch(`${API}/api/templates`, { headers: H })).json()).items ?? []
const prefer = ['หัวกระดาษ', 'สำเนา 1', 'อำเภอเนินมะปราง']
const picked = prefer.map((w) => templates.find((t) => (t.name ?? '').includes(w))).find(Boolean) ?? templates[0]
const key = String(picked?.id ?? '')
console.log(`ใช้แม่แบบ: ${picked?.name}`)

const profile = mkdtempSync(join(tmpdir(), 'cdp-ruler-'))
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
const clickTestId = async (id) => {
  const box = await evaluate(`(() => {
    const el = document.querySelector('[data-testid=${JSON.stringify(id)}]')
    if (!el) return null
    el.scrollIntoView({ block: 'center' })
    const r = el.getBoundingClientRect()
    const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)
    return { ok: !!hit && (el.contains(hit) || hit === el), x: r.x + r.width / 2, y: r.y + r.height / 2 }
  })()`)
  if (!box?.ok) return false
  for (const type of ['mousePressed', 'mouseReleased'])
    await send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 })
  return true
}

/** วัดตำแหน่งไม้บรรทัดเทียบกับ canvas — คืนค่า px ที่ต่างกัน */
const geom = () =>
  evaluate(`(() => {
    const c = document.querySelector('.docstage__page canvas')
    const h = document.querySelector('.rul--h')
    const v = document.querySelector('.rul--v')
    if (!c || !h || !v) return null
    const cr = c.getBoundingClientRect()
    const hr = h.getBoundingClientRect()
    const vr = v.getBoundingClientRect()
    return {
      page: { x: cr.x, y: cr.y, w: cr.width, h: cr.height },
      rh: { x: hr.x, y: hr.y, w: hr.width, h: hr.height },
      rv: { x: vr.x, y: vr.y, w: vr.width, h: vr.height },
      // ตัวเลขบนไม้บรรทัดแนวนอน เรียงจากซ้ายไปขวา
      nums: [...h.querySelectorAll('text')].map((t) => ({
        v: t.textContent,
        x: t.getBoundingClientRect().x + t.getBoundingClientRect().width / 2,
      })),
      unit: document.querySelector('[data-testid="ruler-unit"]')?.textContent?.trim(),
      on: document.querySelector('[data-testid="ruler-toggle"]')?.getAttribute('aria-pressed'),
    }
  })()`)

await send('Page.enable')
await send('Runtime.enable')
await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false })
await send('Network.setCookie', { name: 'docgen_session', value: sid, url: WEB })
await send('Network.setCacheDisabled', { cacheDisabled: true })

// ── เรนเดอร์ก่อน ไม้บรรทัดวัดจากกระดาษจริง ──────────────────────────
console.log('\n[0] เปิดแม่แบบแล้วเรนเดอร์')
await send('Page.navigate', { url: `${WEB}/studio/${key}?tabs=form&pane=preview` })
await waitFor("!!document.querySelector('.dl__btn')", 45000)
await sleep(600)
const btn = await evaluate(`(() => {
  const el = [...document.querySelectorAll('button')].find((b) => b.textContent.includes('เรนเดอร์ตัวอย่าง'))
  if (!el) return null
  const r = el.getBoundingClientRect()
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
})()`)
if (btn) {
  for (const type of ['mousePressed', 'mouseReleased'])
    await send('Input.dispatchMouseEvent', { type, x: btn.x, y: btn.y, button: 'left', clickCount: 1 })
}
const rendered = await waitFor(
  // ⚠️ เช็คจาก `attrH` (พิกเซลจริงที่ pdf.js ตั้ง) ไม่ใช่ความกว้างที่เห็น
  //    `<canvas>` ที่ยังไม่เคยวาดมีค่าเริ่มต้น 300×150
  //    ถ้าเช็คผิดจะผ่านทั้งที่หน้าว่าง (เคยเจอ)
  "(() => { const c = document.querySelector('.docstage__page canvas'); return !!c && c.width > 400 && c.height > 400 })()",
  120000,
)
check('เรนเดอร์ตัวอย่างสำเร็จ (canvas ไม่ใช่ค่าเริ่มต้น 300×150)', rendered)
if (!rendered) {
  await shot('99-failed.png')
  console.log(`\n── ผ่าน ${pass} · ไม่ผ่าน ${fail} ─────────────────────\n`)
  process.exit(1)
}

// ── 1–2. ปุ่มสลับ + เปิดไม้บรรทัด ──────────────────────────────────
console.log('\n[1] ปุ่มสลับไม้บรรทัด')
check('มีปุ่มสลับไม้บรรทัด', await evaluate("!!document.querySelector('[data-testid=\"ruler-toggle\"]')"))
check('มีปุ่มหน่วย', await evaluate("!!document.querySelector('[data-testid=\"ruler-unit\"]')"))
check('เริ่มต้นเป็นซม.', (await evaluate("document.querySelector('[data-testid=\"ruler-unit\"]').textContent.trim()")) === 'ซม.')
check('เริ่มต้นซ่อนอยู่ (ไม่บังหน้าเอกสารทันที)', !(await evaluate("!!document.querySelector('.rul--h')")))

console.log('\n[2] เปิดไม้บรรทัด')
check('กดปุ่มได้', await clickTestId('ruler-toggle'))
const hShown = await waitFor("!!document.querySelector('.rul--h')", 8000)
check('ไม้บรรทัดบนปรากฏ', hShown)
if (!hShown) {
  // ระบุให้ชัดว่าขาดอะไร — ไม่งั้นจะเดาว่าเป็น state, effect หรือเงื่อนไข render
  console.log('    stage:', await evaluate(`(() => {
    const st = document.querySelector('.docstage')
    const c = document.querySelector('.docstage__page canvas')
    return JSON.stringify({
      hasStage: !!st,
      grid: st ? getComputedStyle(st).gridTemplateColumns + ' | ' + getComputedStyle(st).gridTemplateRows : null,
      canvas: c ? { clientW: c.clientWidth, clientH: c.clientHeight, attrW: c.width, attrH: c.height } : null,
      children: st ? st.children.length : 0,
      html: st ? st.innerHTML.slice(0, 160) : null,
    })
  })()`))
}
check('ไม้บรรทัดซ้ายปรากฏ', await evaluate("!!document.querySelector('.rul--v')"))
check('ปุ่มถูกทำเครื่องหมายว่าเปิดอยู่', (await evaluate("document.querySelector('[data-testid=\"ruler-toggle\"]').getAttribute('aria-pressed')")) === 'true')
// ตรวจว่าค่าถูกเขียนลง localStorage จริง ไม่ใช่แค่ state ในหน่วยความจำ
check(
  'บันทึกสถานะลง localStorage',
  (await evaluate("window.localStorage.getItem('docgen.preview.ruler')")) === '1',
  `ค่า=${await evaluate("window.localStorage.getItem('docgen.preview.ruler')")}`,
)
await sleep(500)
await shot('01-cm.png')

// ── 3–5. ตำแหน่งและตัวเลข ────────────────────────────────────────
console.log('\n[3] ตำแหน่งไม้บรรทัดตรงขอบกระดาษ (สำคัญที่สุด)')
{
  const g = await geom()
  check('วัดได้ครบทุกชิ้น', !!g)
  if (g) {
    const dLeft = Math.abs(g.rh.x - g.page.x)
    const dTop = Math.abs(g.rv.y - g.page.y)
    const dRight = Math.abs(g.rh.x + g.rh.w - (g.page.x + g.page.w))
    const dBottom = Math.abs(g.rv.y + g.rv.h - (g.page.y + g.page.h))
    check('ขอบซ้ายตรงกัน', dLeft <= 1, `ต่าง ${dLeft.toFixed(1)}px`)
    check('ขอบขวาตรงกัน', dRight <= 1, `ต่าง ${dRight.toFixed(1)}px`)
    check('ขอบบนตรงกัน', dTop <= 1, `ต่าง ${dTop.toFixed(1)}px`)
    check('ขอบล่างตรงกัน', dBottom <= 1, `ต่าง ${dBottom.toFixed(1)}px`)
    check('ไม้บรรทัดซ้ายอยู่ซ้ายกระดาษจริง', g.rv.x + g.rv.w <= g.page.x + 1, `ขวาของไม้=${(g.rv.x + g.rv.w).toFixed(1)}`)
    check('ไม้บรรทัดบนอยู่เหนือกระดาษจริง', g.rh.y + g.rh.h <= g.page.y + 1, `ล่างของไม้=${(g.rh.y + g.rh.h).toFixed(1)}`)
  }
}
console.log('\n[4] ความยาวไม้บรรทัด = ความกว้างกระดาษ')
{
  const g = await geom()
  check('ยาวเท่ากัน', Math.abs(g.rh.w - g.page.w) <= 1, `ไม้ ${g.rh.w} · หน้า ${g.page.w}`)
  check('สูงเท่ากัน', Math.abs(g.rv.h - g.page.h) <= 1, `ไม้ ${g.rv.h} · หน้า ${g.page.h}`)
}
console.log('\n[5] ตัวเลขบนไม้บรรทัด')
{
  const g = await geom()
  check('ขึ้นต้นด้วย 0', g.nums[0]?.v === '0', `เริ่มด้วย "${g.nums[0]?.v}"`)
  check('มีตัวเลขมากกว่า 2 ตัว', g.nums.length > 2, `${g.nums.length} ตัว`)
  const last = Number(g.nums[g.nums.length - 1].v)
  // A4 กว้าง 21 ซม. · Letter 21.59 — ตัวเลขสุดท้ายต้องไม่เกินนั้น
  check('ตัวสุดท้ายไม่เกินความกว้างกระดาษ (A4 = 21)', last <= 21.6, `สูงสุด ${last}`)
  check('ตัวเลขเรียงจากซ้ายไปขวา', g.nums.every((n, i) => i === 0 || n.x > g.nums[i - 1].x))
  // ตำแหน่ง 0 ต้องตรงขอบซ้ายของกระดาษ
  const zero = g.nums.find((n) => n.v === '0')
  check('ตัวเลข 0 อยู่ตรงขอบซ้ายกระดาษ', !!zero && Math.abs(zero.x - g.page.x) <= 2, `ต่าง ${Math.abs((zero?.x ?? 0) - g.page.x).toFixed(1)}px`)
  // ตัวสุดท้ายต้องไม่ล้นออกมา
  const lastX = g.nums[g.nums.length - 1].x
  check('ตัวสุดท้ายไม่ล้นออกขอบขวา', lastX <= g.page.x + g.page.w + 2, `ต่าง ${(lastX - (g.page.x + g.page.w)).toFixed(1)}px`)
}

// ── 6. สลับหน่วย ────────────────────────────────────────────────
console.log('\n[6] สลับหน่วย ซม. ↔ นิ้ว')
{
  const before = await geom()
  check('กดสลับหน่วยได้', await clickTestId('ruler-unit'))
  await sleep(600)
  const after = await geom()
  check('ปุ่มเปลี่ยนเป็น "นิ้ว"', after.unit === 'นิ้ว', after.unit)
  check('ตัวเลขเปลี่ยนไปจริง', after.nums.at(-1)?.v !== before.nums.at(-1)?.v, `${before.nums.at(-1)?.v} → ${after.nums.at(-1)?.v}`)
  const lastIn = Number(after.nums.at(-1).v)
  // A4 กว้าง 8.27 นิ้ว — ขั้นปกติคือ 1 นิ้ว จึงได้เลขสูงสุด 8
  check('ตัวสุดท้ายสมเหตุสมผลกับหน่วยนิ้ว (≤ 8.3)', lastIn <= 8.3, `สูงสุด ${lastIn}`)
  check('ยังขึ้นต้นด้วย 0', after.nums[0]?.v === '0')
  check('ยังตรงขอบกระดาษหลังสลับหน่วย', Math.abs(after.rh.x - after.page.x) <= 1 && Math.abs(after.rh.w - after.page.w) <= 1)
  await shot('02-inch.png')
  await clickTestId('ruler-unit') // กลับเป็น ซม.
  await sleep(500)
}

// ── 7. จำค่าไว้ข้ามการรีเฟรช ─────────────────────────────────────
console.log('\n[7] จำค่าไว้ข้ามการรีเฟรช')
{
  await send('Page.reload')
  await waitFor("!!document.querySelector('.dl__btn')", 60000)
  await sleep(800)
  /**
   * ⚠️ หลังรีเฟรช พรีวิวยังไม่มีรูป — ผู้ใช้ต้องกด "เรนเดอร์ตัวอย่าง" ใหม่
   *    แถบเครื่องมือ (ปุ่มไม้บรรทัด) จึงยังไม่มี ต้องเรนเดอร์ก่อนจึงจะเช็คได้
   *    ถ้าเช็คตรนี้เลย เทสต์จะตกทั้งที่ localStorage ทำงานถูก
   */
  const again = await evaluate(`(() => {
    const el = [...document.querySelectorAll('button')].find((b) => b.textContent.includes('เรนเดอร์ตัวอย่าง'))
    if (!el) return null
    el.scrollIntoView({ block: 'center' })
    const r = el.getBoundingClientRect()
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
  })()`)
  check('หลังรีเฟรชต้องกดเรนเดอร์ใหม่ (พรีวิวยังไม่มีรูป)', again !== null)
  if (again) {
    for (const type of ['mousePressed', 'mouseReleased'])
      await send('Input.dispatchMouseEvent', { type, x: again.x, y: again.y, button: 'left', clickCount: 1 })
  }
  const ok = await waitFor(
    "(() => { const c = document.querySelector('.docstage__page canvas'); return !!c && c.width > 400 })()",
    120000,
  )
  check('เรนเดอร์หลังรีเฟรชสำเร็จ', ok)
  if (ok) {
    /**
     * ⚠️ ต้องรอไม้บรรทัดจริง ห้ามเช็คทันทีที่ canvas โผล่
     *    pdf.js ตั้ง `canvas.width` ตั้งแต่ต้นก่อนที่ `setStage` จะ commit
     *    ถ้าเช็คตรนี้เลย เทสต์จะแพ้เสมอแม้แอปทำถูก
     */
    const rulBack = await waitFor("!!document.querySelector('.rul--h')", 10000)
    const stored = await evaluate("window.localStorage.getItem('docgen.preview.ruler')")
    console.log('    localStorage หลังรีเฟรช:', JSON.stringify(stored))
    check(
      'ไม้บรรทัดยังเปิดอยู่ตามที่เลือกไว้ก่อนรีเฟรช',
      rulBack,
      rulBack ? '' : 'รอ 10 วินาทีแล้วยังไม่ปรากฏ',
    )
    check('หน่วยยังเป็น ซม. ตามที่เลือกไว้', (await evaluate("document.querySelector('[data-testid=\"ruler-unit\"]')?.textContent?.trim()")) === 'ซม.')
  }
}

// ── 8. ซ่อนแล้วกระดาษกลับเป็นกลางจอ ─────────────────────────────
console.log('\n[8] ซ่อนไม้บรรทัด')
{
  // ถ้ารีเฟรชแล้วไม้บรรทัดยังไม่กลับมา ให้กดเปิดให้ครบก่อนจะได้วัดเทียบก่อน–หลัง
  if (!(await evaluate("!!document.querySelector('.rul--h')"))) {
    const clicked = await clickTestId('ruler-toggle')
    const shown = clicked ? await waitFor("!!document.querySelector('.rul--h')", 10000) : false
    check('เปิดไม้บรรทัดกลับได้ก่อนวัด', shown, shown ? '' : 'กดแล้วรอ 10 วินาทียังไม่ปรากฏ')
  }
  const before = await geom()
  if (!before) {
    check('วัดไม้บรรทัดก่อนซ่อนได้', false, 'ยังไม่มี .rul--h — ข้าส่วนที่วัดเทียบไม่ได้')
  }
  check('กดซ่อนได้', await clickTestId('ruler-toggle'))
  await sleep(800)
  check('ไม้บรรทัดหายไป', !(await evaluate("!!document.querySelector('.rul--h')")))
  const after = await evaluate(`(() => {
    const c = document.querySelector('.docstage__page canvas')
    const host = document.querySelector('.docpage')
    if (!c || !host) return null
    const cr = c.getBoundingClientRect(), hr = host.getBoundingClientRect()
    return { left: Math.abs(cr.x - hr.x), right: Math.abs(cr.right - hr.right), w: cr.width, pw: hr.width }
  })()`)
  check('กระดาษกลับมาเต็มความกว้างที่มี', !!before && after.w > before.page.w - 1, before ? `${before.page.w} → ${after.w}` : '(ไม่มีข้อมูลก่อน)')
  check('กระดาษอยู่กลางพื้นที่พรีวิว', after.left < 40 && after.right < 40, `ซ้าย${after.left.toFixed(0)} ขวา${after.right.toFixed(0)}`)
  await shot('03-hidden.png')
}

// ── 9. ซูมแล้วยังตรง ────────────────────────────────────────────
console.log('\n[9] ซูมแล้วไม้บรรทัดยังตรงขอบกระดาษ')
{
  await clickTestId('ruler-toggle')
  await sleep(500)
  await waitFor("!!document.querySelector('.rul--h')", 10000)

  /**
   * ⚠️ ต้องวัดตำแหน่งปุ่มใหม่ทุกครั้ง และต้องยืนยันว่าซูมขึ้นจริง
   *    ตอนซูมออกจาก 100% ปุ่ม "รีเซ็ต 100%" จะโผล่ข้าง `+` ทำให้แถบเครื่องมือยาวขึ้น
   *    ถ้าใช้พิกัดเดิมซ้ำ จะคลิกผิดปุ่ม และถ้าไม่เช็คค่าซูม
   *    ข้อ "หลังซูมยังตรง" จะผ่านมั่วทั้งที่ยังอยู่ที่ 100% (เคยเจอ)
   */
  const zoomNow = () => evaluate("document.querySelector('.doctools .mono')?.textContent?.trim() ?? ''")
  const before = await zoomNow()
  for (let i = 0; i < 2; i++) {
    const box = await evaluate(`(() => {
      const b = [...document.querySelectorAll('.doctools button')].find((x) => x.textContent.trim() === '+')
      if (!b || b.disabled) return null
      b.scrollIntoView({ block: 'nearest' })
      const r = b.getBoundingClientRect()
      const x = r.x + r.width / 2, y = r.y + r.height / 2
      const hit = document.elementFromPoint(x, y)
      return { ok: !!hit && (b.contains(hit) || hit === b), x, y }
    })()`)
    if (!box?.ok) {
      check('กดปุ่มซูมได้', false, box ? 'มีอะไรบังปุ่ม +' : 'หาปุ่ม + ไม่เจอ')
      break
    }
    for (const type of ['mousePressed', 'mouseReleased'])
      await send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 })
    await sleep(1200)
  }
  const after = await zoomNow()
  check('ซูมได้จริงก่อนวัดว่าไม้ยังตรง', after !== before && Number.parseInt(after) > 100, `${before} → ${after}`)

  const g = await geom()
  // ⚠️ ถ้า `g` เป็น null แปลว่าไม้บรรทัดไม่ขึ้น — รายงานเป็นข้อ ไม่ใช่ปล่อยให้สคริปต์พัง
  if (!g) {
    check('หลังซูมไม้บรรทัดยังอยู่', false, 'วัดไม่ได้ ไม่มี .rul--h')
    await shot('04-zoomed.png')
  } else {
    check('หลังซูม ขอบซ้ายยังตรง', Math.abs(g.rh.x - g.page.x) <= 1, `ต่าง ${Math.abs(g.rh.x - g.page.x).toFixed(1)}px`)
    check('หลังซูม ขอบขวายังตรง', Math.abs(g.rh.x + g.rh.w - (g.page.x + g.page.w)) <= 1, `ต่าง ${Math.abs(g.rh.x + g.rh.w - (g.page.x + g.page.w)).toFixed(1)}px`)
    check('หลังซูม ขอบล่างยังตรง', Math.abs(g.rv.y + g.rv.h - (g.page.y + g.page.h)) <= 1, `ต่าง ${Math.abs(g.rv.y + g.rv.h - (g.page.y + g.page.h)).toFixed(1)}px`)
    check('หลังซูม ตัวเลข 0 ยังที่ขอบซ้าย', Math.abs((g.nums.find((n) => n.v === '0')?.x ?? 0) - g.page.x) <= 2)
    const last = Number(g.nums.at(-1).v)
    check('หลังซูม ตัวเลขยังไม่เกินกระดาษ', last <= 21.6, `สูงสุด ${last}`)
  }
  await shot('04-zoomed.png')
}

await send('Browser.close').catch(() => {})
chrome.kill()
await redis.del(`session:${sid}`)
redis.disconnect()

console.log(`\n── ผ่าน ${pass} · ไม่ผ่าน ${fail} · ข้าม ${skip} ─────────────────────`)
console.log(`ภาพ: ${OUT.pathname}\n`)
process.exit(fail ? 1 : 0)
