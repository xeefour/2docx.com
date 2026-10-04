/**
 * โหมดรายการ: ปุ่ม "ดูตัวอย่าง" เปิด popup รูปตัวอย่าง
 *
 * ผู้ใช้สั่ง:
 *   *"แบบ list มีปุ่ม preview กดแล้ว มีรูปตัวอย่างแสดงเป็น popup"*
 *
 *   node --env-file=.env tools/test-row-peek.mjs
 *
 * ── ทำไมต้องมีชุดนี้ แม้ `test-thumb-peek` จะพิสูจน์ lightbox อยู่แล้ว ─────
 *   test-thumb-peek กดที่**รูปย่อ** ซึ่งมีอยู่ในโหมดชิด
 *   ส่วนงานรอบนี้เพิ่มปุ่มข้อความ "ดูตัวอย่าง" ในโหมด**รายการ**
 *   → ต้องพิสูจน์ 3 เรื่องที่ test-thumb-peek ไม่ได้ตรวจเลย:
 *     1. ปุ่มโผล่เฉพาะโหมดรายการ (โหมดชิดคลิกรูปย่อได้อยู่แล้ว)
 *     2. เกิดเฉพาะแถวที่**มีรูปจริง** (ไม่มีรูป = ไม่มีปุ่ม)
 *     3. กดแล้วได้ popup ตัวเดียวกันจริง ไม่ใช่แค่ปุ่มที่กดแล้วไม่เกิดอะไร
 *
 * ── ไม่ต้องสร้างแม่แบบชั่วคราว ────────────────────────────────────────
 *   รอบก่อน (test-thumb-peek) ต้องสร้างเพราะต้องการ**2 รูป** เพื่อทดสอบปุ่ม ‹ ›
 *   รอบนี้แค่ต้องการรูปย่อ 1 ใบ และ Mongo มี `template_previews` 8 รายการอยู่แล้ว
 *   → ใช้ข้อมูลจริง ตรวจสอบได้ตรงกับหน้าจอที่ผู้ใช้เห็นจริง และไม่ต้องล้างข้อมูลทิ้ง
 */
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Redis } from 'ioredis'

const WEB = 'http://localhost:3000'
const CHROME = process.env.CHROME_PATH ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const PORT = 9409
const STAMP = Date.now()
const OUT = new URL('../tests/nav-status/output-row-peek/', import.meta.url)
mkdirSync(OUT, { recursive: true })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let pass = 0
let fail = 0
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`)
  ok ? pass++ : fail++
}

const redis = new Redis(process.env.VALKEY_URL)
const SID = `rowpeek-${STAMP}`
await redis.set(
  `session:${SID}`,
  JSON.stringify({ sub: SID, name: 'ผู้ทดสอบปุ่มดูตัวอย่าง', email: 'rowpeek@test.local', avatar: '' }),
  'EX',
  900,
)

/* ── เบราว์เซอร์ ────────────────────────────────────────────── */
const profile = mkdtempSync(join(tmpdir(), 'cdp-rowpeek-'))
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
    const l = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
    wsUrl = l.find((x) => x.type === 'page')?.webSocketDebuggerUrl
  } catch {}
}
const ws = new WebSocket(wsUrl)
let seq = 0
const waiting = new Map()
const send = (m, p = {}) =>
  new Promise((resolve, reject) => {
    const id = ++seq
    waiting.set(id, { resolve, reject })
    ws.send(JSON.stringify({ id, method: m, params: p }))
    setTimeout(() => {
      if (waiting.has(id)) { waiting.delete(id); reject(new Error(`timeout: ${m}`)) }
    }, 30000)
  })
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data)
  const s = waiting.get(m.id)
  if (!s) return
  waiting.delete(m.id)
  m.error ? s.reject(new Error(JSON.stringify(m.error))) : s.resolve(m.result)
})
await new Promise((r) => ws.addEventListener('open', r, { once: true }))
const evaluate = async (e) => {
  const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true })
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text)
  return r.result?.value
}
const waitFor = async (e, ms = 30000) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    try { if (await evaluate(e)) return true } catch {}
    await sleep(400)
  }
  return false
}
const shot = async (n) => {
  const { data } = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(new URL(n, OUT), Buffer.from(data, 'base64'))
}
/** กดด้วยเมาส์จริง + ยืนยันว่าไม่มีอะไรบัง (ห้ามใช้ element.click()) */
const clickJs = async (js) => {
  const box = await evaluate(`(() => { ${js} })()`)
  if (!box?.ok) return box
  for (const type of ['mousePressed', 'mouseReleased'])
    await send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 })
  return box
}
const clickTestId = (id) =>
  clickJs(`
    const el = document.querySelector('[data-testid=${JSON.stringify(id)}]')
    if (!el) return { miss: 'ไม่เจอ ${id}' }
    el.scrollIntoView({ block: 'center' })
    const r = el.getBoundingClientRect()
    const x = r.x + r.width / 2, y = r.y + r.height / 2
    const hit = document.elementFromPoint(x, y)
    return { ok: !!hit && (hit === el || el.contains(hit)), x, y }
  `)

/**
 * กดคีย์ผ่าน CDP
 *
 * ⚠️ ต้องเป็น rawKeyDown สำหรับปุ่มที่ไม่ผลิตอักขระ (Escape)
 *    ถ้าใช้ keyDown ตรง ๆ บางครั้งไม่ถึง window listener ของ React
 */
const pressKey = async (name, vk) => {
  for (const type of ['rawKeyDown', 'keyUp'])
    await send('Input.dispatchKeyEvent', {
      type, key: name, code: name, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk,
    })
  await sleep(350)
}

/** นับแถว/ปุ่มที่**มองเห็นจริง** — ตัวแปร display:none ไม่ถือว่ามี */
const survey = `(() => {
  const vis = (el) => {
    if (!el) return false
    const r = el.getBoundingClientRect()
    if (r.width < 1 || r.height < 1) return false
    const s = getComputedStyle(el)
    return s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0.01
  }
  const rows = [...document.querySelectorAll('.tpllist tbody tr')]
  let withThumb = 0, peekVisible = 0, strayPeek = 0
  for (const tr of rows) {
    const thumb = !!tr.querySelector('[data-testid="row-thumb"],[data-testid="row-thumb-btn"]')
    const peek = tr.querySelector('[data-testid="row-peek"]')
    const pv = vis(peek)
    if (thumb) withThumb++
    if (pv) peekVisible++
    // ปุ่มที่โผล่แต่แถวไม่มีรูป = บั๊ก เพราะเงื่อนไขคือ thumb && เท่านั้น
    if (pv && !thumb) strayPeek++
  }
  return { rows: rows.length, withThumb, peekVisible, strayPeek, grid: !!document.querySelector('.tpllist--grid') }
})()`

try {
  await send('Page.enable')
  await send('Runtime.enable')
  await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false })
  await send('Network.setCacheDisabled', { cacheDisabled: true })
  await send('Network.setCookie', { name: 'docgen_session', value: SID, url: WEB })
  await send('Page.navigate', { url: `${WEB}/studio?_=${STAMP}` })
  await waitFor("!!document.querySelector('.tpllist tbody tr')", 45000)
  await sleep(1200)

  /**
   * ⚠️ ค่าเริ่มต้นของหน้าคือโหมด**ชิด** (`readStoredView` คืน 'grid' เมื่อ storage ว่าง)
   *   ชุดนี้วัดโหมดรายการ → ต้องกดสลับเอง ไม่งั้นข้อ [1] จะวัดผิดโหมดตั้งแต่แรก
   */
  await clickTestId('view-list')
  await waitFor("!document.querySelector('.tpllist--grid')", 10000)
  await sleep(700)

  console.log('\n[1] โหมดรายการ: ปุ่ม "ดูตัวอย่าง" โผล่ในแถวที่มีรูป')
  const list1 = await evaluate(survey)
  check('หน้าเป็นโหมดรายการ', !list1.grid)
  check('มีแถวให้ทดสอบ', list1.rows > 0, `${list1.rows} แถว`)
  check('มีแม่แบบที่มีรูปย่อจริง', list1.withThumb > 0, `${list1.withThumb} แถว`)
  check('ปุ่ม "ดูตัวอย่าง" โผล่ครบทุกแถวที่มีรูป', list1.peekVisible === list1.withThumb, `ปุ่ม ${list1.peekVisible} / มีรูป ${list1.withThumb}`)
  check('ไม่มีปุ่มลอยฝากแถวที่ไม่มีรูป', list1.strayPeek === 0, `ลอย ${list1.strayPeek}`)
  await shot('00-list-with-button.png')

  console.log('\n[2] ลำดับปุ่ม: เปิด → ดูตัวอย่าง → ดาวน์โหลด')
  const order = await evaluate(`(() => {
    const tr = [...document.querySelectorAll('.tpllist tbody tr')]
      .find((r) => r.querySelector('[data-testid="row-peek"]'))
    if (!tr) return { miss: 'ไม่เจอแถวที่มีปุ่มดูตัวอย่าง' }
    const acts = tr.querySelector('td.tplrow__acts')
    const at = (sel) => [...acts.children].findIndex((n) => n.matches(sel) || n.querySelector?.(sel))
    return {
      open: at('.tplrow__i-open'),
      peek: at('.tplrow__i-peek'),
      dl: at('.tplrow__i-dl'),
      label: acts.querySelector('[data-testid="row-peek"]')?.textContent?.trim() ?? '',
      title: acts.querySelector('[data-testid="row-peek"]')?.getAttribute('title') ?? '',
    }
  })()`)
  check('ปุ่มอยู่หลัง "เปิด"', order.open >= 0 && order.peek > order.open, `เปิด ${order.open} · ดูตัวอย่าง ${order.peek}`)
  check('ปุ่มอยู่ก่อน "ดาวน์โหลด"', order.dl > order.peek, `ดูตัวอย่าง ${order.peek} · ดาวน์โหลด ${order.dl}`)
  check('ข้อความปุ่มอ่านออก', order.label === 'ดูตัวอย่าง', JSON.stringify(order.label))
  check('มี title อธิบาย', order.title.length > 0, order.title)

  console.log('\n[3] กดแล้ว popup รูปตัวอย่างโผล่')
  const c1 = await clickJs(`
    const el = document.querySelector('.tpllist td.tplrow__acts [data-testid="row-peek"]')
    if (!el) return { miss: 'ไม่เจอปุ่มดูตัวอย่าง' }
    el.scrollIntoView({ block: 'center' })
    const r = el.getBoundingClientRect()
    const x = r.x + r.width / 2, y = r.y + r.height / 2
    const hit = document.elementFromPoint(x, y)
    return { ok: !!hit && (hit === el || el.contains(hit)), x, y }
  `)
  check('กดปุ่ม "ดูตัวอย่าง" ได้จริง', !!c1?.ok, c1?.miss ?? '')
  check('popup โผล่ขึ้น', await waitFor("!!document.querySelector('[data-testid=\"thumb-lightbox\"]')", 10000))
  check('รูปใน popup โหลดเสร็จ', await waitFor("(() => { const i = document.querySelector('[data-testid=\"lightbox-img\"]'); return !!i && i.naturalWidth > 0 })()", 15000))
  const lb = await evaluate(`(() => {
    const box = document.querySelector('[data-testid="thumb-lightbox"]')
    const img = document.querySelector('[data-testid="lightbox-img"]')
    return {
      z: Number(getComputedStyle(box).zIndex),
      role: box.getAttribute('role'),
      src: (img?.getAttribute('src') ?? '').slice(0, 12),
      count: document.querySelector('[data-testid="lightbox-count"]')?.textContent?.trim() ?? null,
    }
  })()`)
  check('เป็น dialog แบบ modal เหมือนกดที่รูปย่อ', lb.role === 'dialog' && lb.z > 2147482500, `${lb.role} z=${lb.z}`)
  /**
   * ⚠️ ป้ายตัวนับโผล่**เฉพาะตอนมีมากกว่า 1 รูป** และแม่แบบจริงของผู้ใช้มีรูปเดียว
   *   → ไม่มีป้ายถือว่าถูกต้อง (ไม่ใช่บั๊ก) ถ้ามีก็ต้องเป็น "1 / N"
   */
  check(
    'ป้ายนับรูปถูกต้อง (ไม่มีก็ได้ถ้ามีรูปเดียว)',
    lb.count === null || /^1 \/ \d+$/.test(lb.count),
    lb.count ?? '(ไม่มีป้าย — รูปเดียว)',
  )
  check('popup แสดงรูปจริง (src เป็น data/blob)', lb.src.length > 4, lb.src)
  await shot('01-list-peek-open.png')
  await pressKey('Escape', 27)
  check('Escape ปิด popup', await waitFor("!document.querySelector('[data-testid=\"thumb-lightbox\"]')", 8000))

  console.log('\n[4] โหมดชิด: ซ่อนปุ่ม เพราะคลิกรูปย่อได้อยู่แล้ว')
  await clickTestId('view-grid')
  await waitFor("!!document.querySelector('.tpllist--grid')", 10000)
  await sleep(700)
  const grid = await evaluate(survey)
  check('หน้าเปลี่ยนเป็นโหมดชิด', grid.grid)
  check('ปุ่ม "ดูตัวอย่าง" ถูกซ่อนในโหมดชิด', grid.peekVisible === 0, `ยังเห็น ${grid.peekVisible}`)
  check('รูปย่อยังกดได้ในโหมดชิด', grid.withThumb > 0, `${grid.withThumb} แถว`)
  await shot('02-grid-no-peek.png')

  console.log('\n[5] กลับโหมดรายการ: ปุ่มกลับมา')
  await clickTestId('view-list')
  await waitFor("!document.querySelector('.tpllist--grid')", 10000)
  await sleep(700)
  const list2 = await evaluate(survey)
  check('กลับเป็นโหมดรายการ', !list2.grid)
  check('ปุ่ม "ดูตัวอย่าง" กลับมา', list2.peekVisible === list2.withThumb && list2.withThumb > 0, `ปุ่ม ${list2.peekVisible} / มีรูป ${list2.withThumb}`)

  console.log('\n[6] จอมือถือ 390px')
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: false })
  await sleep(800)
  const narrow = await evaluate(survey)
  check('ปุ่มยังเห็นบนจอมือถือ', narrow.peekVisible === narrow.withThumb && narrow.withThumb > 0, `ปุ่ม ${narrow.peekVisible} / มีรูป ${narrow.withThumb}`)
  const fit = await evaluate(`(() => {
    const el = document.querySelector('.tpllist td.tplrow__acts [data-testid="row-peek"]')
    if (!el) return { miss: 'ไม่เจอปุ่ม' }
    el.scrollIntoView({ block: 'center' })
    const r = el.getBoundingClientRect()
    return {
      w: Math.round(r.width),
      h: Math.round(r.height),
      outRight: Math.round(Math.max(0, r.right - document.documentElement.clientWidth)),
      outLeft: Math.round(Math.max(0, -r.left)),
      touch: r.height >= 36,
    }
  })()`)
  check('ปุ่มกดได้จริง ไม่โดนตัด', fit.outRight === 0 && fit.outLeft === 0, `เกินขวา ${fit.outRight} · เกินซ้าย ${fit.outLeft}`)
  check('พื้นที่นิ้วแตะ ≥ 36px', fit.touch, `${fit.w}×${fit.h}px`)
  const cN = await clickJs(`
    const el = document.querySelector('.tpllist td.tplrow__acts [data-testid="row-peek"]')
    if (!el) return { miss: 'ไม่เจอปุ่มดูตัวอย่าง' }
    el.scrollIntoView({ block: 'center' })
    const r = el.getBoundingClientRect()
    const x = r.x + r.width / 2, y = r.y + r.height / 2
    const hit = document.elementFromPoint(x, y)
    return { ok: !!hit && (hit === el || el.contains(hit)), x, y }
  `)
  check('กดเปิด popup บนจอมือถือได้', !!cN?.ok, cN?.miss ?? '')
  check('popup โผล่บนจอมือถือ', await waitFor("!!document.querySelector('[data-testid=\"thumb-lightbox\"]')", 8000))
  await shot('03-narrow-peek-open.png')
} catch (e) {
  check('รันชุดทดสอบไม่สะดุด error', false, String(e?.message ?? e))
} finally {
  try { await send('Browser.close') } catch {}
  try { chrome.kill() } catch {}
  try { ws.close() } catch {}
  await redis.del(`session:${SID}`)
  redis.disconnect()
}

console.log(`\nผ่าน ${pass} · ตก ${fail}`)
process.exit(fail ? 1 : 0)
