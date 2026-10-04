/**
 * คลิกภาพย่อบนหน้ารายการ → popup ดูรูปเต็ม
 *
 * ผู้ใช้สั่ง:
 *   *"คลิกที่รูปก็ได้ บางทีผู้ใช้ต้องการคลิกที่นี้"*
 *   *"ให้ popup รูปขึ้นมาแสดง เพื่อให้ผู้ใช้ตัดสินใจว่าจะเลือกแบบนี้หรือไม่
 *     ถ้ามีหลายรู้ก็เลื่อนไปข้างหน้า ถอยหลังได้ ถ้าผู้ใช้ตกลง ก็มีปุ่มไปที่ form ต่อ"*
 *
 *   node --env-file=.env tools/test-thumb-peek.mjs
 *
 * ── ทำไมต้องสร้างแม่แบบชั่วคราว ─────────────────────────────────────
 *   แม่แบบจริงของผู้ใช้มีรูปเดียวทั้งหมด → ทดสอบปุ่ม "เลื่อนรูป" ไม่ได้เลย
 *   และแก้ของจริงถือเป็นการทำลายข้อมูลผู้ใช้
 *   จึงสร้างแม่แบบทิ้งแล้วใส่รูป 2 ใบ → ทดสอบครบทุกกรณี แล้วลบทิ้ง
 *
 * ── สิ่งที่ต้องผ่าน ──────────────────────────────────────────────────
 * 1. ภาพย่อบนแถวเป็นปุ่มที่กดได้จริง (เดิมเป็น <img> กดไม่ได้)
 * 2. กดแล้ว popup โผล่ พร้อมโหลดรูปจริง
 * 3. มี 2 รูป → มีตัวนับ "1 / 2" และปุ่ม ‹ ›
 * 4. กด › ไปรูปถัดไป · กด ‹ ย้อนกลับ · ลูกศรซ้าย/ขวาก็ได้
 * 5. ปุ่ม "ไปที่ฟอร์ม" พาไป ?tabs=form
 * 6. Escape ปิด · คลิกพื้นหลังปิด
 * 7. ป๊ายกล่องทับแถบ URL (จอแคบ) และรูปกับปุ่มเลื่อนอยู่ในจอ
 */
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MongoClient } from 'mongodb'
import { Redis } from 'ioredis'
import { resolveMongoUrl } from '@docgen/shared'

const WEB = 'http://localhost:3000'
const API = process.env.API_URL ?? 'http://127.0.0.1:4001'
const CHROME = process.env.CHROME_PATH ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const PORT = 9397
const STAMP = Date.now()
const PREFIX = 'ทดสอบคลิกรูป '
const OUT = new URL('../tests/nav-status/output-thumb-peek/', import.meta.url)
mkdirSync(OUT, { recursive: true })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let pass = 0
let fail = 0
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`)
  ok ? pass++ : fail++
}

const redis = new Redis(process.env.VALKEY_URL)
const SID = `peek-${STAMP}`
await redis.set(
  `session:${SID}`,
  JSON.stringify({ sub: SID, name: 'ผู้ทดสอบคลิกรูป', email: 'peek@test.local', avatar: '' }),
  'EX',
  900,
)
const h = { cookie: `docgen_session=${SID}` }
/** ⚠️ ห้ามส่ง content-type กับ DELETE ที่ไม่มี body (Fastify ตอบ 500) */
const hd = { cookie: `docgen_session=${SID}` }

/** PNG 1×1 จริง (magic bytes ถูกต้อง) — ใช้สองไบต์คนละชุดเพื่อให้รูปคนละใบ */
const PNG_A = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)
const PNG_B = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42u3BAQ0AAADCoPdPbQ8HFAAAAAAAAAAAAAAAAAAAAAAAAP7d4YQAAAABJRU5ErkJggg==',
  'base64',
)

const list = async () => (await (await fetch(`${API}/api/templates`, { headers: h })).json()).items ?? []

const wipeAccess = async (templateKey) => {
  const c = new MongoClient(await resolveMongoUrl(() => {}))
  await c.connect()
  const db = c.db(process.env.MONGO_DB ?? 'app')
  await db.collection('template_access').deleteOne({ _id: templateKey })
  await db.collection('template_previews').deleteMany({ templateKey })
  await c.close()
}

/* ── เตรียมแม่แบบชั่วคราว พร้อมรูป 2 ใบ ─────────────────────────── */
console.log('\n[0] เตรียมแม่แบบชั่วคราวพร้อมรูป 2 ใบ')
for (const t of (await list()).filter((x) => (x.name ?? '').startsWith(PREFIX))) {
  await fetch(`${API}/api/templates/${t.id}/purge`, { method: 'DELETE', headers: hd })
  await wipeAccess(String(t.id))
}
const donor = (await list()).find((t) => (t.name ?? '').includes('หัวกระดาษ')) ?? (await list())[0]
if (!donor) {
  console.log('✗ ไม่มีแม่แบบให้ใช้เป็นต้นฉบับ')
  process.exit(1)
}
const donorBytes = new Uint8Array(
  await (await fetch(`${API}/api/templates/${donor.id}`, { headers: h })).arrayBuffer(),
)
const TMP = `${PREFIX}${STAMP}`
const mk = new FormData()
mk.set('versioning', 'true')
mk.set('name', TMP)
mk.set('template', new Blob([donorBytes], { type: 'application/octet-stream' }), 'ต้นฉบับ.docx')
const created = await (await fetch(`${API}/api/templates`, { method: 'POST', headers: h, body: mk })).json()
const key = String(created?.id ?? created?.templateId ?? '')
check('สร้างแม่แบบชั่วคราวได้', !!key, `key ${key}`)
// เผยแพร่ให้เห็นและผูกเจ้าของจริง ไม่งั้นเพิ่มรูปไม่ได้
await fetch(`${API}/api/access/${encodeURIComponent(key)}`, {
  method: 'PUT',
  headers: { ...h, 'content-type': 'application/json' },
  body: JSON.stringify({ visibility: 'published' }),
})
const pbase = `${API}/api/templates/${encodeURIComponent(key)}/previews`
const postImage = async (buf, name) => {
  const f = new FormData()
  f.set('kind', 'upload')
  f.set('file', new Blob([buf], { type: 'image/png' }), name)
  return fetch(pbase, { method: 'POST', headers: h, body: f })
}
const r1 = await postImage(PNG_A, 'a.png')
const r2 = await postImage(PNG_B, 'b.png')
check('เพิ่มรูปได้ 2 ใบ', r1.status === 201 && r2.status === 201, `HTTP ${r1.status}/${r2.status}`)

/* ── เบราว์เซอร์ ────────────────────────────────────────────── */
const profile = mkdtempSync(join(tmpdir(), 'cdp-peek-'))
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
 * ⚠️ ต้องเป็น rawKeyDown สำหรับปุ่มที่ไม่ผลิตอักขระ (ลูกศร/Escape)
 *    ถ้าใช้ keyDown ตรง ๆ บางครั้งไม่ถึง window listener ของ React
 *    แล้วเทสต์จะตกทั้งที่ฟีเจอร์ใช้ได้จริง
 */
const VK = { ArrowRight: 39, ArrowLeft: 37, Escape: 27 }
const pressKey = async (name) => {
  for (const type of ['rawKeyDown', 'keyUp'])
    await send('Input.dispatchKeyEvent', {
      type,
      key: name,
      code: name,
      windowsVirtualKeyCode: VK[name],
      nativeVirtualKeyCode: VK[name],
    })
  await sleep(300)
}
const count = () =>
  evaluate("document.querySelector('[data-testid=\"lightbox-count\"]')?.textContent?.trim() ?? null")

const cleanup = async () => {
  try { await fetch(`${API}/api/templates/${key}/purge`, { method: 'DELETE', headers: hd }) } catch {}
  await wipeAccess(key)
  await redis.del(`session:${SID}`)
  redis.disconnect()
}

try {
  await send('Page.enable')
  await send('Runtime.enable')
  await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false })
  await send('Network.setCacheDisabled', { cacheDisabled: true })
  await send('Network.setCookie', { name: 'docgen_session', value: SID, url: WEB })
  await send('Page.navigate', { url: `${WEB}/studio?_=${STAMP}` })
  await waitFor("!!document.querySelector('.tpllist')", 45000)
  await sleep(900)

  console.log('\n[1] ภาพย่อต้องเป็นปุ่มที่กดได้')
  const row = await evaluate(`(() => {
    const tr = [...document.querySelectorAll('.tpllist tbody tr')]
      .find((r) => r.textContent.includes(${JSON.stringify(TMP)}))
    if (!tr) return { miss: 'ไม่เจอแถวของแม่แบบชั่วคราว' }
    const img = tr.querySelector('[data-testid="row-thumb"]')
    const btn = tr.querySelector('[data-testid="row-thumb-btn"]')
    if (!img) return { miss: 'ไม่เจอรูปย่อ' }
    const cell = img.closest('td')
    const I = img.getBoundingClientRect()
    const C = cell.getBoundingClientRect()
    const B = btn ? btn.getBoundingClientRect() : null
    return {
      hasBtn: !!btn,
      label: btn?.getAttribute('aria-label') || '',
      w: Math.round(I.width),
      h: Math.round(I.height),
      // ⚠️ รูปต้องอยู่ในกล่องเสมอ — ล้นออกมาแล้วจะไปทับชื่อแม่แบบ
      spillY: Math.round(Math.max(0, I.bottom - C.bottom)),
      cellH: Math.round(C.height),
      btnH: B ? Math.round(B.height) : 0,
      btnCssH: btn ? getComputedStyle(btn).height : '',
    }
  })()`)
  check('เจอแถวของแม่แบบชั่วคราว', !row?.miss, row?.miss ?? '')
  check('ภาพย่อโชว์จริง', !!row?.w, `${row?.w}×${row?.h}px`)
  check('ภาพย่ออยู่ในปุ่ม (กดได้)', !!row?.hasBtn)
  check('ปุ่มมี aria-label บอกว่าดูรูปอะไร', (row?.label ?? '').includes(TMP), row?.label ?? '')

  /**
   * ⚠️ เกณฑ์นี้จับบั๊กที่ทำให้ "ชื่อแม่แบบทับรูป preview" ได้จริง
   *
   *   เดิม `<img>` มี `height: 100%` แต่แม่ของมันคือ `<button>` ที่**ไม่มี height**
   *   → % ของรูปจึงอ้างกับกล่องที่สูง auto แล้วกลายเป็น auto
   *   → รูปขยายตามสัดส่วนจริง (A4 สูง 700+ px) แล้วล้นกล่อง 190px
   *   → รูปไปทับชื่อ/ชิปของการ์ด (ผู้ใช้ส่งภาพมาแก้ได้)
   *
   *   วัดได้ `spill` = 719px ก่อนแก้ → 0 หลังใส่ `height: 100%` ให้ปุ่ม
   */
  check(
    'รูปย่อไม่ล้นออกจากกล่อง (ไม่ทับชื่อแม่แบบ)',
    (row?.spillY ?? 999) <= 1,
    `ล้น ${row?.spillY}px · กล่อง ${row?.cellH}px · รูป ${row?.h}px · ปุ่ม ${row?.btnCssH}`,
  )
  check(
    'ปุ่มภาพย่อสูงเท่ากล่อง (คือ % ของรูปมีที่อิงแล้ว)',
    row?.btnH === row?.cellH,
    `ปุ่ม ${row?.btnH}px · กล่อง ${row?.cellH}px`,
  )

  console.log('\n[2] กดแล้ว popup โผล่พร้อมรูป')
  const c1 = await clickJs(`
    const tr = [...document.querySelectorAll('.tpllist tbody tr')]
      .find((r) => r.textContent.includes(${JSON.stringify(TMP)}))
    const el = tr?.querySelector('[data-testid="row-thumb-btn"]')
    if (!el) return { miss: 'ไม่เจอปุ่มภาพย่อ' }
    el.scrollIntoView({ block: 'center' })
    const r = el.getBoundingClientRect()
    const x = r.x + r.width / 2, y = r.y + r.height / 2
    const hit = document.elementFromPoint(x, y)
    return { ok: !!hit && (hit === el || el.contains(hit)), x, y }
  `)
  check('กดภาพย่อได้จริง', !!c1?.ok, c1?.miss ?? c1?.why ?? '')
  check('popup โผล่ขึ้น', await waitFor("!!document.querySelector('[data-testid=\"thumb-lightbox\"]')", 10000))
  check('โหลดรูปใน popup สำเร็จ', await waitFor("(() => { const i = document.querySelector('[data-testid=\"lightbox-img\"]'); return !!i && i.naturalWidth > 0 })()", 15000))
  const geo = await evaluate(`(() => {
    const box = document.querySelector('[data-testid="thumb-lightbox"]')
    const img = document.querySelector('[data-testid="lightbox-img"]')
    const nav = [...document.querySelectorAll('[data-testid="lightbox-prev"],[data-testid="lightbox-next"]')]
    return {
      z: Number(getComputedStyle(box).zIndex),
      role: box.getAttribute('role'),
      modal: box.getAttribute('aria-modal'),
      count: document.querySelector('[data-testid="lightbox-count"]')?.textContent?.trim() ?? null,
      navs: nav.length,
      navOut: nav.filter((n) => n.getBoundingClientRect().right > innerWidth + 0.5).length,
      toForm: document.querySelector('[data-testid="lightbox-to-form"]')?.getAttribute('href') ?? '',
      imgW: Math.round(img.getBoundingClientRect().width),
    }
  })()`)
  check('เป็น dialog แบบ modal', geo.role === 'dialog' && geo.modal === 'true', `${geo.role}/${geo.modal}`)
  check('ทับแถบ URL (จอแคบ) — z-index สูงพอ', geo.z > 2147482500, String(geo.z))
  check('มีตัวนับรูป "1 / 2"', geo.count === '1 / 2', String(geo.count))
  check('มีปุ่มเลื่อน ‹ › ครบสองข้าง', geo.navs === 2, `${geo.navs} ปุ่ม`)
  check('ปุ่มเลื่อนอยู่ในจอ', geo.navOut === 0, `ล้น ${geo.navOut}`)
  check('ปุ่ม "ไปที่ฟอร์ม" พาไปแท็บฟอร์ม', geo.toForm.includes('tabs=form'), geo.toForm)
  await shot('01-open.png')

  console.log('\n[3] เลื่อนไปข้างหน้า / ถอยหลัง')
  await clickTestId('lightbox-next')
  await sleep(350)
  check('กด › แล้วไปรูปที่ 2', (await evaluate("document.querySelector('[data-testid=\"lightbox-count\"]')?.textContent?.trim()")) === '2 / 2')
  await clickTestId('lightbox-prev')
  await sleep(350)
  check('กด ‹ แล้วย้อนกลับรูปที่ 1', (await evaluate("document.querySelector('[data-testid=\"lightbox-count\"]')?.textContent?.trim()")) === '1 / 2')
  /**
   * ⚠️ ทดสอบทีละทาง ไม่ใช่กดรวดแล้วเดาผลรวม
   *   รอบแร่งกดขวา 2 ครั้ง + ซ้าย 1 ครั้ง แล้วคาดว่าได้ 1/2
   *   แต่มีแค่ 2 รูป → 1 -> 2 -> 1 -> 2 = **2/2** → เทสต์ตกทั้งที่โค้ดถูก
   */
  await pressKey('ArrowRight')
  check('ลูกศรขวาเลื่อนไปรูปที่ 2', (await count()) === '2 / 2', String(await count()))
  await pressKey('ArrowLeft')
  check('ลูกศรซ้ายย้อนกลับรูปที่ 1', (await count()) === '1 / 2', String(await count()))

  console.log('\n[4] ปิดได้สองทาง')
  await pressKey('Escape')
  check('Escape ปิด popup', await waitFor("!document.querySelector('[data-testid=\"thumb-lightbox\"]')", 8000))
  await clickJs(`
    const tr = [...document.querySelectorAll('.tpllist tbody tr')]
      .find((r) => r.textContent.includes(${JSON.stringify(TMP)}))
    const el = tr?.querySelector('[data-testid="row-thumb-btn"]')
    if (!el) return { miss: 'ไม่เจอปุ่มภาพย่อ' }
    el.scrollIntoView({ block: 'center' })
    const r = el.getBoundingClientRect()
    const x = r.x + r.width / 2, y = r.y + r.height / 2
    return { ok: !!el, x, y }
  `)
  check('เปิดซ้ำได้', await waitFor("!!document.querySelector('[data-testid=\"thumb-lightbox\"]')", 8000))
  await clickJs(`
    const stage = document.querySelector('.lightbox__stage')
    if (!stage) return { miss: 'ไม่เจอพื้นที่วางรูป' }
    const r = stage.getBoundingClientRect()
    // ชิดขอบซ้ายของพื้นที่วางรูป = ที่ว่างข้างรูป (ไม่ใช่ตัวรูป ไม่ใช่ปุ่มเลื่อน)
    const x = r.x + 6, y = r.y + r.height / 2
    const hit = document.elementFromPoint(x, y)
    return { ok: hit === stage, x, y }
  `)
  check('คลิกพื้นหลังข้างรูปปิด popup', await waitFor("!document.querySelector('[data-testid=\"thumb-lightbox\"]')", 8000))

  console.log('\n[5] จอมือถือ 390px')
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: false })
  await sleep(700)
  const openNarrow = await clickJs(`
    const tr = [...document.querySelectorAll('.tpllist tbody tr')]
      .find((r) => r.textContent.includes(${JSON.stringify(TMP)}))
    const el = tr?.querySelector('[data-testid="row-thumb-btn"]')
    if (!el) return { miss: 'ไม่เจอปุ่มภาพย่อ' }
    el.scrollIntoView({ block: 'center' })
    const r = el.getBoundingClientRect()
    const x = r.x + r.width / 2, y = r.y + r.height / 2
    const hit = document.elementFromPoint(x, y)
    return { ok: !!hit && (hit === el || el.contains(hit)), x, y }
  `)
  check('เปิด popup บนจอมือถือได้', !!openNarrow?.ok, openNarrow?.miss ?? '')
  await waitFor("!!document.querySelector('[data-testid=\"thumb-lightbox\"]')", 8000)
  await waitFor("(() => { const i = document.querySelector('[data-testid=\"lightbox-img\"]'); return !!i && i.naturalWidth > 0 })()", 15000)
  const narrow = await evaluate(`(() => {
    const box = document.querySelector('[data-testid="thumb-lightbox"]').getBoundingClientRect()
    const img = document.querySelector('[data-testid="lightbox-img"]')
    const toForm = document.querySelector('[data-testid="lightbox-to-form"]')?.getBoundingClientRect()
    const navs = [...document.querySelectorAll('[data-testid="lightbox-prev"],[data-testid="lightbox-next"]')]
    return {
      vw: innerWidth,
      boxW: Math.round(box.width),
      boxH: Math.round(box.height),
      vh: innerHeight,
      imgOut: Math.round(Math.max(0, img.getBoundingClientRect().width - innerWidth)),
      navOut: navs.filter((n) => {
        const r = n.getBoundingClientRect()
        return r.left < -0.5 || r.right > innerWidth + 0.5
      }).length,
      toFormVisible: !!toForm && toForm.top >= 0 && toForm.bottom <= innerHeight + 1,
    }
  })()`)
  /**
   * ⚠️ เกณฑ์นี้เผื่อ scrollbar ไว้ 20px เพราะ `inset: 0` ของ position:fixed
   *    คำนวณจาก viewport ที่**ไม่รวม**แถบเลื่อนแนวตั้ง
   *    การเทียบกับ innerWidth แบบตรง ๆ จะตกเสมอแม้หน้าตาถูกต้อง
   *    (รอบแรกเขียนแบบนั้นแล้วตก ทั้งที่จอกว้างเท่ากับจอจริง)
   */
  check(
    'popup คลุมพื้นที่ที่ผู้ใช้เห็นทั้งหมด',
    narrow.boxW >= narrow.vw - 20 && narrow.boxH >= narrow.vh - 20,
    `กล่อง ${narrow.boxW}×${narrow.boxH} / จอ ${narrow.vw}×${narrow.vh}`,
  )
  check('รูปไม่ล้นออกนอกจอ', narrow.imgOut === 0, `ล้น ${narrow.imgOut}px`)
  check('ปุ่มเลื่อนยังอยู่ในจอ', narrow.navOut === 0, `ล้น ${narrow.navOut}`)
  check('ปุ่ม "ไปที่ฟอร์ม" เห็นได้ในจอ', narrow.toFormVisible)
  await shot('02-narrow.png')
} finally {
  await cleanup()
  await send('Browser.close').catch(() => {})
  chrome.kill()
  ws.close()
  console.log(`\n── ผ่าน ${pass} · ไม่ผ่าน ${fail} ─────────────────────`)
  console.log(`ภาพ: ${OUT}`)
  process.exit(fail ? 1 : 0)
}
