/**
 * วัดความสูงจริงของการ์ดพรีวิว / กล่องรูปเอกสาร / แถบรูปย่อ
 *
 *   node --env-file=.env tools/inspect-preview-height.mjs
 *
 * ── ทำไมต้องมีเครื่องมือนี้ ───────────────────────────────────────
 * ผู้ใช้สั่ง "ให้รูป preview สูงเท่าความสูงหน้าจอ แถบรูปย่อต้องเลื่อนลงถึงจะเห็น"
 * ซึ่งเป็นข้อตกลงที่วัดด้วยตัวเลขได้ ไม่ใช่เรื่องความรู้สึก:
 *   · กล่องรูปเอกสาร (`.docpage`) ต้องสูงเท่าความสูงหน้าจอ (100vh)
 *   · แถบรูปย่อ (`.docstrip__wrap`) ต้องอยู่**ใต้ขอบจอ** ตอน scroll = 0
 *     และต้อง**เลื่อนแล้วเห็นได้จริง** (คอลัมน์ `sticky` สูงเกินจอจะกินระยะเลื่อน
 *     ของตัวเอง → ข้างล่างการ์ดจะถูกตรึงไว้นอกจอตลอด ผู้ใช้เลื่อนไม่ถึง)
 *
 * เทสต์ (`test-preview-layout.mjs`) บอกได้แค่ว่าผ่าน/ไม่ผ่าน
 * เครื่องมือนี้พิมพ์ค่าจริงทุกตัว พร้อมภาพหน้าจอ เพื่อดูว่าตัวไหนผิด
 */
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Redis } from 'ioredis'
import { keyOf, pickTemplate, TEST_TEMPLATES } from './lib/pick-template.mjs'
import { FILL_FIELDS_JS, importTags, restoreForm, snapshotForm } from './lib/studio-seed.mjs'

const CHROME = process.env.CHROME_PATH ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const PORT = 9362
const WEB = 'http://localhost:3000'
const API = 'http://127.0.0.1:4001'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
/**
 * รับขนาดจอจาก argument — ต้องวัดได้หลายขนาด เพราะอาการ "scrollbar 2 อัน"
 * โผล่เฉพาะจอที่ต่ำ ไม่เจอที่จอสูง (เจอครั้งแรกที่ 579×539 ตอนผู้ใช้รายงาน)
 */
const VW = Number(process.argv[2] ?? 1600)
const VH = Number(process.argv[3] ?? 1000)

const redis = new Redis(process.env.VALKEY_URL)
const sid = `dbgtop-${Date.now()}`
await redis.set(`session:${sid}`, JSON.stringify({ sub: sid, name: 'วัด top', email: 'dbgtop@test.local', avatar: '' }), 'EX', 1800)
const H = { cookie: `docgen_session=${sid}`, 'content-type': 'application/json' }
const tpl = await pickTemplate(H, [TEST_TEMPLATES.multipage])
const seedKey = keyOf(tpl)
const snap = await snapshotForm(H, seedKey)
await importTags(H, tpl)

const profile = mkdtempSync(join(tmpdir(), 'cdp-dbgtop-'))
const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run', `--window-size=${VW},${VH}`, `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' })
let wsUrl = null
for (let i = 0; i < 40 && !wsUrl; i++) {
  await sleep(500)
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
    wsUrl = list.find((x) => x.type === 'page')?.webSocketDebuggerUrl
  } catch {}
}
const ws = new WebSocket(wsUrl)
let seq = 0
const waiting = new Map()
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++seq
  waiting.set(id, { resolve, reject })
  ws.send(JSON.stringify({ id, method, params }))
})
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data)
  if (m.method === 'Runtime.exceptionThrown') console.log('EXC:', m.params?.exceptionDetails?.exception?.description?.slice(0, 300))
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
const waitFor = async (expr, ms = 90000) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    try { if (await evaluate(expr)) return true } catch {}
    await sleep(300)
  }
  return false
}
const click = async (expr) => {
  const b = await evaluate(`(() => { const el = ${expr}; if (!el) return null; el.scrollIntoView({block:'center'}); const r = el.getBoundingClientRect(); return { x: r.x + r.width/2, y: r.y + r.height/2 } })()`)
  if (!b) return false
  for (const type of ['mousePressed', 'mouseReleased'])
    await send('Input.dispatchMouseEvent', { type, x: b.x, y: b.y, button: 'left', clickCount: 1 })
  return true
}
/** เก็บภาพหน้าจอไว้ดูด้วยตา — ตัวเลขบอกว่า "ผิด" แต่ภาพบอกว่า "ผิดยังไง" */
const shot = async (name) => {
  const { data } = await send('Page.captureScreenshot', { format: 'png' })
  mkdirSync(join(process.cwd(), 'logs'), { recursive: true })
  const file = join(process.cwd(), 'logs', `preview-${name}-${VW}x${VH}.png`)
  writeFileSync(file, Buffer.from(data, 'base64'))
  console.log('  ภาพ:', file)
}
await send('Page.enable')
await send('Runtime.enable')
await send('Emulation.setDeviceMetricsOverride', { width: VW, height: VH, deviceScaleFactor: 1, mobile: false })
await send('Network.setCookie', { name: 'docgen_session', value: sid, url: WEB })
await send('Network.setCacheDisabled', { cacheDisabled: true })
await send('Page.navigate', { url: `${WEB}/studio` })
await waitFor("!document.querySelector('.bootveil')", 60000)
await waitFor("document.querySelectorAll('table tbody tr').length > 0", 45000)
/**
 * เปิดแม่แบบที่เลือกไว้จากหน้ารายการ
 *
 * ⚠️ ต้องกดปุ่ม "เปิด" โดยเฉพาะ ไม่ใช่ `button.ghost` ตัวแรกในแถว
 *    เพราะปุ่มแรกในแถวคือปุ่มดาว (ทำเครื่องหมายส็อค) → กดแล้วไม่เปิดหน้าแก้แม่แบบ
 *    เคยเจอ: คลิกแล้วเงียบ ๆ ไม่มีอะไรเกิดขึ้น ทั้งที่สคริปต์รายงานว่า "กดแล้ว"
 *
 * ⚠️ ต้องยืนยันด้วย `elementFromPoint` ว่าจุดนั้นโดนปุ่มจริง ไม่โดนแผงอื่นบัง
 *    เพราะการ์ด/แผนซ้อนที่คร่อมอยู่เหนือปุ่ม ทำให้คลิกเงียบโดยไม่มี error ให้เห็น
 */
const openTemplate = async (name) => {
  const target = await evaluate(`(() => {
    const row = [...document.querySelectorAll('table tbody tr')]
      .find((tr) => (tr.textContent || '').includes(${JSON.stringify(name)}))
    if (!row) return { miss: 'ไม่เจอแถว' }
    const btn = [...row.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === 'เปิด')
    if (!btn) return { miss: 'ไม่เจอปุ่มเปิด' }
    btn.scrollIntoView({ block: 'center' })
    const r = btn.getBoundingClientRect()
    const x = r.x + r.width / 2
    const y = r.y + r.height / 2
    const hit = document.elementFromPoint(x, y)
    return { x, y, hit: hit ? (hit.tagName + '.' + (hit.className || '')).slice(0, 40) : 'null' }
  })()`)
  if (target.miss) return false
  if (!target.hit?.includes('BUTTON')) {
    console.log('! จุดคลิกโดน', target.hit, 'ไม่ใช่ปุ่ม — ข้ามการคลิก')
    return false
  }
  for (const type of ['mousePressed', 'mouseReleased'])
    await send('Input.dispatchMouseEvent', { type, x: target.x, y: target.y, button: 'left', clickCount: 1 })
  return true
}

/**
 * ⚠️ แถบ URL มุมล่างซ้าย (`.urlbar__panel`) ลอยทับเนื้อหาตอนจอเตี้ย
 *    ที่ 579×539 มันบังปุ่ม "เปิด" ของแถวล่าง ๆ จนกดไม่ได้
 *    เคยเจอ: กดแล้วไม่เปิด เพราะ `elementFromPoint` โดนแผงนี้ ไม่ใช่ปุ่ม
 *    → ยุบมันก่อนวัด (กดปุ่ม**ตัวสุดท้าย**ใน `.urlbar__actions` = ปุ่ม "ซ่อน"
 *       เลี่ยงการค้นด้วยชื่อไทย เพราะพิมพ์ผิดตัวเดียวก็หาไม่เจจากชื่อ)
 */
// ตอนนี้แผงย่อเป็นค่าเริ่มต้นอยู่แล้ว (ไม่บังปุ่มหน้าเว็บ) — ถ้ามันกางอยู่ก็ยุบก่อนวัด
await evaluate(`(() => {
  if (!document.querySelector('.urlbar__panel')) return
  ;[...document.querySelectorAll('.urlbar__actions button')].at(-1)?.click()
})()`)
await sleep(400)

console.log('เปิดแม่แบบ:', tpl.name)
await openTemplate(tpl.name)
const opened = await waitFor("[...document.querySelectorAll('.tabs__tab')].length >= 6", 30000)
if (!opened) {
  console.log('✗ เปิดหน้าแก้แม่แบบไม่ได้ — วัดต่อไม่ได้')
  await shot('00-cannot-open.png')
  await send('Browser.close').catch(() => {})
  chrome.kill()
  await restoreForm(H, seedKey, snap)
  await fetch(`${API}/api/access/${seedKey}`, { method: 'DELETE', headers: H }).catch(() => {})
  await redis.del(`session:${sid}`)
  redis.disconnect()
  process.exit(1)
}
await sleep(600)
await evaluate(FILL_FIELDS_JS)
await sleep(500)
await click(`[...document.querySelectorAll('button')].find(b => b.textContent.includes('เรนเดอร์ตัวอย่าง'))`)
const ok = await waitFor("(() => { const c = document.querySelector('.docstage__page canvas'); return !!c && c.height > 200 })()", 120000)
console.log('rendered =', ok)

/**
 * พิมพ์ตำแหน่ง/ความสูงของทุกชิ้นที่ข้อตกลง "สูงเต็มจอ" พึ่งไว้
 *
 * ⚠️ วัดจาก `getBoundingClientRect()` (พิกัดบนจอจริง) เสมอ
 *    เพราะคำว่า "อยู่ใต้ขอบจอไหม" คือคำถามเรื่อง**พิกัดบนจอ** ไม่ใช่เรื่องลำดับใน DOM
 */
const probe = () =>
  evaluate(`(() => {
  const r = (sel) => {
    const el = document.querySelector(sel)
    if (!el) return null
    const b = el.getBoundingClientRect()
    return { y: Math.round(b.y), bottom: Math.round(b.bottom), h: Math.round(b.height) }
  }
  /**
   * ⚠️ scrollbar **ข้างในกล่อง** — ตัวชี้ขาดของ UX แย่เรื่อง scrollbar 2 อัน
   *    ค่า > 0 แปลว่ากระดาษยังล้นกล่อง ผู้ใช้ต้องเลื่อนข้างในอีกชั้นก่อน
   *    แล้วหน้าเว็บก็ยังต้องเลื่อนอีก (แถบรูปย่ออยู่ใต้กล่อง) = ซ้อนกัน 2 อัน
   *    กล่องต้องยืดตามกระดาษ (min-height: 100vh) ค่านี้จึงต้องเป็น 0 เสมอ
   */
  const innerScroll = (() => {
    const el = document.querySelector('.docpage')
    return el ? el.scrollHeight - el.clientHeight : null
  })()
  const col = document.querySelector('.editor-col--preview')
  const strip = r('.docstrip__wrap')
  return {
    vh: innerHeight,
    scrollY: Math.round(scrollY),
    pageH: Math.round(document.body.scrollHeight),
    colPos: col ? getComputedStyle(col).position : '?',
    colH: Math.round(col?.getBoundingClientRect().height ?? NaN),
    tools: r('.doctools'),
    /**
     * ⚠️ ความสูงปุ่มในแถบเครื่องมือ — ผู้ใช้ต้องการให้**สูงเท่ากันทุกปุ่ม**
     *   (เคยมีปุ่มซูมสูงกว่าปุ่มไม้บรรทัด/หน่วย ทำให้แถบดูไม่เรียบ)
     */
    btnH: [...document.querySelectorAll('.doctools button')].map(
      (b) =>
        (b.getAttribute('aria-label') || b.textContent.trim().slice(0, 8)) +
        '=' + Math.round(b.getBoundingClientRect().height),
    ),
    docpage: r('.docpage'),
    innerScroll,
    strip,
    /** แถบรูปย่อต้องอยู่ใต้ขอบจอ → ต้องเลื่อนถึงจะเห็น */
    stripHiddenAtTop: strip ? strip.y >= innerHeight : null,
    /** และต้อง**เลื่อนแล้วเห็นได้จริง** (ไม่ใช่ถูก sticky ตรึงไว้นอกจอตลอด) */
    stripReachable: strip ? strip.y < innerHeight : null,
  }
})()`)

const show = async (label) => {
  const p = await probe()
  console.log(label, JSON.stringify(p))
  return p
}

const before = await show('scroll = 0 →')
await shot('01-top')
/** ถ่ายตอนเลื่อนมาให้กล่องกระดาษอยู่บนสุด — จอเตี้ยแถวซ้ายโตจนพรีวิวไปอยู่ล่างจอ */
await evaluate("document.querySelector('.docpage')?.scrollIntoView({ block: 'start' })")
await sleep(900)
await show('เลื่อนมาที่กล่องกระดาษ →')
await shot('03-docpage')
await evaluate('scrollTo(0, document.body.scrollHeight)')
await sleep(1200)
const after = await show('เลื่อนสุด →')
await shot('02-bottom')
await evaluate('scrollTo(0, 0)')
await sleep(600)

console.log('\nสรุป')
console.log('  กล่องรูปเอกสารสูงอย่างน้อยหนึ่งหน้าจอ :', before.docpage?.h, '/', before.vh)
console.log('  scrollbar ข้างในกล่อง            :', before.innerScroll, 'px (ต้องเป็น 0)')
console.log('  แถบรูปย่ออยู่ใต้ขอบจอตอนแรก :', before.stripHiddenAtTop)
console.log('  เลื่อนแล้วเห็นแถบรูปย่อ     :', after.stripReachable)

await restoreForm(H, seedKey, snap)
await fetch(`${API}/api/access/${seedKey}`, { method: 'DELETE', headers: H }).catch(() => {})
await send('Browser.close').catch(() => {})
chrome.kill()
await redis.del(`session:${sid}`)
redis.disconnect()
process.exit(0)
