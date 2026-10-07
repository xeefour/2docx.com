/**
 * ซูมรูปตัวอย่าง + ปุ่มชุดใหม่ต้องใช้ได้จริงทุกขนาดจอ
 *
 *   node --env-file=../dokploy-infra/.env --env-file=../dokploy-infra/.env.development tools/test-lightbox-zoom.mjs
 *
 * ── ผู้ใช้สั่ง ────────────────────────────────────────────────────
 * *"เพิ่มปุ่ม zoom in out หน้าถัดไปถ้ามีหลายรูป ปรับข้อความ ไปที่ฟอร์ม
 *   แก้ไขใหม่ (แก้ไขหน้าตา เพิ่ม icon) ให้อยู่ใกล้กับปุ่มปิด"*
 *
 * ── ทำไมต้องวัดหลายขนาดจอ ไม่ใช่แค่จอใหญ่ ─────────────────────────
 * ปุ่มชุดใหม่อยู่แถบบนซ้ายปุ่มปิด ซึ่งเดิมปุ่ม ‹ › อยู่บนตัวรูป
 *   เดิมที่จอแคบปุ่มถูกดันออกนอกจอไปแล้ว (วัดได้จากเทสต์เดิม)
 *   ถ้าย้ายมาแถบบนแล้วล้นจออีก = ย้ายบั๊กจากที่หนึ่งไปอีกที่หนึ่ง
 *   จึงต้องไล่ตั้งแต่มือถือแนวตั้งจนถึงจอกว้าง
 *
 * ── ทำไมต้องใช้ภาพทรง A4 ─────────────────────────────────────────
 * เทสต์เดิมใช้ PNG 1×1 ซึ่งเล็กเกินกว่าจะพิสูจน์เรื่องซูมได้
 *   (ซูมเท่าไรก็ยังเล็กอยู่ในจอ) → เกณฑ์จะผ่านทั้งที่ซูมไม่ทำงานจริง
 */
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Redis } from 'ioredis'
import { MongoClient } from 'mongodb'
import { resolveMongoUrl } from '@docgen/shared'
import { makePng, A4 } from './lib/make-png.mjs'

const WEB = 'http://localhost:3000'
const API = process.env.API_URL ?? 'http://127.0.0.1:4001'
const CHROME = process.env.CHROME_PATH ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const PORT = 9433
const STAMP = Date.now()
const PREFIX = 'ทดสอบซูม lightbox '
const OUT = fileURLToPath(new URL('../tests/nav-status/output-lightbox-zoom/', import.meta.url))
mkdirSync(OUT, { recursive: true })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** ขนาดจอที่ต้องไล่วัด — เริ่มจากมือถือแนวตั้งจนถึงจอกว้าง */
const WIDTHS = [360, 414, 563, 768, 1024, 1280, 1600]

let pass = 0
let fail = 0
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`)
  ok ? pass++ : fail++
}

const redis = new Redis(process.env.VALKEY_URL)
const SID = `lbzoom-${STAMP}`
await redis.set(
  `session:${SID}`,
  JSON.stringify({ sub: SID, name: 'ทดสอบซูม', email: `lbzoom-${STAMP}@test.local`, avatar: '' }),
  'EX',
  1800,
)
const h = { cookie: `docgen_session=${SID}` }
const hd = { cookie: `docgen_session=${SID}` }

const list = async () => (await (await fetch(`${API}/api/templates`, { headers: h })).json()).items ?? []

const wipeAccess = async (templateKey) => {
  const c = new MongoClient(await resolveMongoUrl(() => {}))
  await c.connect()
  const db = c.db(process.env.MONGO_DB ?? 'app')
  await db.collection('template_access').deleteOne({ _id: templateKey })
  await db.collection('template_previews').deleteMany({ templateKey })
  await c.close()
}

let key = ''
console.log(`\n── ซูมรูปตัวอย่าง + ปุ่มชุดใหม่ ────────────────────\n`)

/* ── เตรียมแม่แบบชั่วคราว พร้อมรูป A4 สองใบ ─────────────────────── */
for (const t of (await list()).filter((x) => (x.name ?? '').startsWith(PREFIX))) {
  await fetch(`${API}/api/templates/${t.id}/purge`, { method: 'DELETE', headers: hd })
  await wipeAccess(String(t.id))
}
const donor = (await list()).find((t) => (t.name ?? '').includes('หัวกระดาษ')) ?? (await list())[0]
if (!donor) {
  check('มีแม่แบบให้ใช้เป็นต้นฉบับ', false, 'ไม่พบแม่แบบเลย')
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
key = String(created?.id ?? created?.templateId ?? '')
check('สร้างแม่แบบชั่วคราวได้', !!key, `key ${key}`)

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
const pngA = makePng(A4.w, A4.h, [252, 252, 255], 7)
const pngB = makePng(A4.w, A4.h, [255, 248, 240], 7)
const r1 = await postImage(pngA, 'a.png')
const r2 = await postImage(pngB, 'b.png')
check('เพิ่มรูป A4 ได้ 2 ใบ', r1.status === 201 && r2.status === 201, `HTTP ${r1.status}/${r2.status}`)

/* ── เบราว์เซอร์ ────────────────────────────────────────────── */
const profile = mkdtempSync(join(tmpdir(), 'cdp-lbzoom-'))
const chrome = spawn(
  CHROME,
  ['--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run', '--window-size=1280,950',
   `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, 'about:blank'],
  { stdio: 'ignore' },
)
let wsUrl = null
for (let i = 0; i < 40 && !wsUrl; i++) {
  await sleep(500)
  try {
    const l = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
    wsUrl = l.find((x) => x.type === 'page')?.webSocketDebuggerUrl
  } catch { /* ยังไม่พร้อม */ }
}
if (!wsUrl) { chrome.kill(); console.log('✗ ต่อ Chrome ไม่ได้'); process.exit(1) }

const ws = new WebSocket(wsUrl)
let seq = 0
const waiting = new Map()
const send = (m, p = {}) =>
  new Promise((resolve, reject) => {
    const id = ++seq
    const t = setTimeout(() => { waiting.delete(id); reject(new Error(`timeout: ${m}`)) }, 30000)
    waiting.set(id, { resolve: (v) => { clearTimeout(t); resolve(v) }, reject: (e) => { clearTimeout(t); reject(e) } })
    ws.send(JSON.stringify({ id, method: m, params: p }))
  })
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data)
  const s = waiting.get(m.id)
  if (!s) return
  waiting.delete(m.id)
  m.error ? s.reject(new Error(JSON.stringify(m.error))) : s.resolve(m.result)
})
await new Promise((r) => ws.addEventListener('open', r))
await send('Page.enable')
await send('Runtime.enable')
await send('Network.setCacheDisabled', { cacheDisabled: true })
await send('Network.setCookie', { name: 'docgen_session', value: SID, url: WEB })

const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  return r.result?.value
}
const waitFor = async (expr, ms = 15000) => {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    if (await evaluate(`!!(${expr})`)) return true
    await sleep(400)
  }
  return false
}

/** กดด้วยพิกัดจริง + ยืนยันว่าพิกัดชี้ถูกปุ่ม (ไม่ใช่ถูกอย่างอื่นบัง) */
const clickTestId = async (testid) => {
  const box = await evaluate(`(() => {
    const el = document.querySelector('[data-testid="${testid}"]')
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height }
  })()`)
  if (!box || box.w === 0) return { ok: false, why: 'ไม่เจอปุ่ม' }
  /**
   * ⚠️ ยอมรับกรณีที่พิกัดชี้**ลูก**ของปุ่ม (เช่น <span> ไอคอน หรือ <img> ในปุ่มภาพย่อ)
   *    เพราะ event ของลูกฟองขึ้นมาถึงปุ่ม → กดแล้วทำงานจริง
   *    ถ้าบังคับให้ชี้ปุ่มพอดี เทสต์จะตกทั้งที่ UI ใช้งานได้ปกติ
   */
  const hit = await evaluate(`(() => {
    const el = document.querySelector('[data-testid="${testid}"]')
    const t = document.elementFromPoint(${box.x}, ${box.y})
    if (!el || !t) return null
    if (t === el || el.contains(t)) return '${testid}'
    return t.closest('[data-testid]')?.getAttribute('data-testid') ?? 'อย่างอื่น'
  })()`)
  if (hit !== testid) return { ok: false, why: `พิกัดถูก "${hit ?? 'อย่างอื่น'}" บัง` }
  for (const type of ['mousePressed', 'mouseReleased']) {
    await send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 })
  }
  return { ok: true }
}

const setWidth = async (w) => {
  await send('Emulation.setDeviceMetricsOverride', { width: w, height: 950, deviceScaleFactor: 1, mobile: false })
  await sleep(500)
}

/**
 * เปิด popup ของแม่แบบชั่วคราว
 *
 * ⚠️ แถวในหน้ารายการไม่มี testid ผูกกับ key แต่ละอัน (testid ซ้ำกันทั้งตาราง)
 *    → ต้องหาแถวจาก**ชื่อ**แม่แบบก่อน แล้วค่อยกดปุ่มในแถวนั้น
 *
 * ⚠️ ใช้พิกัดจริงผ่าน Input ไม่ใช่ element.click()
 *    เพราะ .click() ไม่ผ่าน hit-testing → กดแล้วผ่านแม้ปุ่มถูกอย่างอื่นบัง
 *    (เจอมาแล้วในเทสต์ชุดก่อน ๆ)
 */
const openPeek = async () => {
  await waitFor(`!!document.querySelector('.tpllist')`, 45000)
  await sleep(900)
  const box = await evaluate(`(() => {
    const tr = [...document.querySelectorAll('.tpllist tbody tr')]
      .find((r) => r.textContent.includes(${JSON.stringify(TMP)}))
    if (!tr) return { miss: 'ไม่เจอแถวของแม่แบบชั่วคราว' }
    const el = tr.querySelector('[data-testid="row-thumb-btn"]')
    if (!el) return { miss: 'ไม่เจอปุ่มภาพย่อ' }
    el.scrollIntoView({ block: 'center' })
    const r = el.getBoundingClientRect()
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), w: r.width, h: r.height }
  })()`)
  if (!box || box.miss) return { ok: false, why: box?.miss ?? 'ไม่เจอปุ่ม' }
  if (box.w === 0) return { ok: false, why: 'ปุ่มกว้าง 0 (ซ่อนอยู่ในโหมดอื่น)' }
  const hit = await evaluate(`(() => {
    const el = document.querySelector('[data-testid="row-thumb-btn"]')
    const t = document.elementFromPoint(${box.x}, ${box.y})
    if (!el || !t) return null
    if (t === el || el.contains(t)) return 'row-thumb-btn'
    return t.closest('[data-testid]')?.getAttribute('data-testid') ?? 'อย่างอื่น'
  })()`)
  if (hit !== 'row-thumb-btn') return { ok: false, why: `พิกัดถูก "${hit ?? 'อย่างอื่น'}" บัง` }
  for (const type of ['mousePressed', 'mouseReleased']) {
    await send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 })
  }
  return { ok: true }
}

await send('Page.navigate', { url: `${WEB}/studio?_=${STAMP}` })
const openedRow = await openPeek()
check('เปิดปุ่มภาพย่อของแม่แบบชั่วคราว', openedRow.ok, openedRow.why ?? '')
const opened = await waitFor(`!!document.querySelector('[data-testid="thumb-lightbox"]')`, 12000)
check('เปิด popup ได้', opened)
const imgOk = await waitFor(`(() => { const i = document.querySelector('[data-testid="lightbox-img"]'); return !!i && i.naturalWidth > 100 })()`, 15000)
check('โหลดรูปใน popup สำเร็จ', imgOk)

/**
 * ถ้า popup ไม่เปิดหรือไม่มีรูป ขั้นต่อไปทั้งหมดจะได้ undefined ทั้งดุ้น
 *   แล้วพังกลางคันด้วยข้อความ TypeError ที่ไม่เกี่ยวกับงานจริง
 *   → จบที่นี่ แล้วคลีนอัพให้เรียบร้อย
 */
if (!opened || !imgOk) {
  console.log('\n── ขัดข้องก่อนเข้าเกณฑ์ถัดไป ไม่ทำต่อ ────────────\n')
  await send('Browser.close').catch(() => undefined)
  chrome.kill()
  ws.close()
  if (key) {
    await fetch(`${API}/api/templates/${encodeURIComponent(key)}/purge`, { method: 'DELETE', headers: hd }).catch(() => {})
    await wipeAccess(key).catch(() => {})
  }
  await redis.del(`session:${SID}`)
  redis.disconnect()
  process.exit(1)
}

/* ── [1] ปุ่มชุดใหม่อยู่ตรงไหน ───────────────────────────────── */
console.log('\n[1] ตำแหน่งปุ่ม')
{
  const geo = await evaluate(`(() => {
    const box = (sel) => {
      const el = document.querySelector(sel)
      if (!el) return null
      const r = el.getBoundingClientRect()
      // ⚠️ ต้องเช็ค "มองเห็น" ไม่ใช่แค่ "มีใน DOM"
      //    ปุ่มที่ถูก display:none ยัง query เจอ และ rect เป็น 0×0
      //    → ถ้าเช็คแค่ว่ามี element เกณฑ์จะผ่านทั้งที่ปุ่มหายไปจากจอ
      const shown = r.width > 0 && r.height > 0 && getComputedStyle(el).display !== 'none'
      return { left: Math.round(r.left), right: Math.round(r.right), top: Math.round(r.top), w: Math.round(r.width), shown }
    }
    return {
      close: box('[data-testid="lightbox-close"]'),
      tools: box('.lightbox__tools'),
      zoomIn: box('[data-testid="lightbox-zoom-in"]'),
      zoomOut: box('[data-testid="lightbox-zoom-out"]'),
      level: box('[data-testid="lightbox-zoom-level"]'),
      prev: box('[data-testid="lightbox-prev"]'),
      next: box('[data-testid="lightbox-next"]'),
      toForm: box('[data-testid="lightbox-to-form"]'),
      title: box('.lightbox__title'),
    }
  })()`)
  const vis = (b) => !!b && b.shown
  check('มีปุ่มซูมเข้า/ออก + ระดับซูม (มองเห็นจริง)', vis(geo.zoomIn) && vis(geo.zoomOut) && vis(geo.level), `ซูม ${geo.zoomOut?.w}px / ${geo.level?.w}px / ${geo.zoomIn?.w}px`)
  check('มีปุ่มเลื่อนรูป ‹ › ที่มองเห็นได้', vis(geo.prev) && vis(geo.next))
  check('ปุ่มไปฟอร์มอยู่ในชุดเดียวกันและมองเห็น', vis(geo.toForm) && vis(geo.tools))
  /**
   * ⚠️ ปุ่มปิดเป็น**ลูกของ** .lightbox__tools ไม่ใช่พี่น้อง
   *   → ต้องเช็คว่าปุ่มปิดอยู่ที่**ปลายขวา**ของชุด ไม่ใช่ว่าอยู่นอกชุด
   *   ถ้าเช็คผิดทาง (`tools.right <= close.left`) จะได้ false เสมอ
   *   เพราะปุ่มปิดอยู่ข้างในชุด → ชุดย่อมกว้างกว่าปุ่มปิดเสมอ
   */
  check('ปุ่มปิดอยู่ปลายขวาสุดของชุดปุ่ม', geo.tools && geo.close && geo.close.right <= geo.tools.right + 1, `ชุดจบ ${geo.tools?.right} · ปิดจบ ${geo.close?.right}`)
  check('ระดับซูมอยู่ระหว่างซูมออกกับซูมเข้า', geo.zoomOut && geo.level && geo.zoomIn && geo.zoomOut.right <= geo.level.left + 1 && geo.level.right <= geo.zoomIn.left + 1, `${geo.zoomOut?.right} / ${geo.level?.left}-${geo.level?.right} / ${geo.zoomIn?.left}`)
  check('ปุ่มไปฟอร์มอยู่ระหว่างชุดเลื่อนรูปกับปุ่มปิด', geo.next && geo.toForm && geo.close && geo.next.right <= geo.toForm.left + 1 && geo.toForm.right <= geo.close.left + 1)
}

/* ── [2] ไล่ทุกขนาดจอ: ปุ่มต้องไม่ล้น และรูปต้องพอดีพื้นที่ ────── */
console.log('\n[2] ไล่ขนาดจอ 360 → 1600')
{
  const rows = []
  for (const w of WIDTHS) {
    await setWidth(w)
    await sleep(700)
    const m = await evaluate(`(() => {
      const ids = ['lightbox-zoom-out','lightbox-zoom-level','lightbox-zoom-in','lightbox-prev','lightbox-next','lightbox-to-form','lightbox-close']
      const all = ids.map((id) => document.querySelector('[data-testid="'+id+'"]'))
      // ⚠️ นับเฉพาะที่**มองเห็น** ไม่ใช่แค่ query เจอ
      //    (ปุ่ม display:none ยัง query เจอ และผ่านเกณฑ์ "ไม่ล้นจอ" ง่าย ๆ)
      //    ที่ตั้งใจซ่อนจริงมีแค่ระดับซูมบนจอ < 420px (media query) → ยกเว้นไว้ให้
      const hiddenByDesign = w => w <= 420 ? ['lightbox-zoom-level'] : []
      const skip = hiddenByDesign(innerWidth)
      const els = all.filter(Boolean).filter((el) => {
        if (skip.includes(el.getAttribute('data-testid'))) return false
        const r = el.getBoundingClientRect()
        return r.width > 0 && r.height > 0 && getComputedStyle(el).display !== 'none'
      })
      const out = els.filter((el) => { const r = el.getBoundingClientRect(); return r.left < -0.5 || r.right > innerWidth + 0.5 })
      const stage = document.querySelector('.lightbox__stage')
      const img = document.querySelector('[data-testid="lightbox-img"]')
      const sr = stage.getBoundingClientRect()
      const ir = img.getBoundingClientRect()
      const title = document.querySelector('.lightbox__title').getBoundingClientRect()
      const tools = document.querySelector('.lightbox__tools').getBoundingClientRect()
      return {
        vw: innerWidth,
        n: els.length,
        out: out.length,
        outIds: out.map((e) => e.getAttribute('data-testid')).join(','),
        imgH: Math.round(ir.height), stageH: Math.round(sr.height),
        overlapTitle: tools.left < title.right - 1,
      }
    })()`)
    rows.push({ w, ...m })
  }
  console.log('    ความกว้าง | ปุ่มที่มองเห็น | ล้นจอ | รูปสูง/พื้นที่ | ชนชื่อเรื่อง')
  for (const r of rows) {
    console.log(`    ${String(r.w).padStart(6)} | ${String(r.n).padStart(11)} | ${String(r.out).padStart(6)} | ${String(r.imgH).padStart(6)}/${String(r.stageH).padEnd(6)} | ${r.overlapTitle ? 'ชน!' : 'ไม่ชน'}`)
  }
  check('ทุกขนาดจอเห็นปุ่มครบ (จอ ≤420px ซ่อนระดับซูมตามที่ออกแบบ)', rows.every((r) => r.n === (r.w <= 420 ? 6 : 7)), rows.map((r) => `${r.w}:${r.n}`).join(' '))
  check('ไม่มีปุ่มไหนล้นออกจอเลยทุกขนาด', rows.every((r) => r.out === 0), rows.filter((r) => r.out).map((r) => `${r.w}px:${r.outIds}`).join(' ') || 'สะอาด')
  check('รูปสูงไม่เกินพื้นที่วางที่ซูมปกติ (100%)', rows.every((r) => r.imgH <= r.stageH), rows.map((r) => `${r.w}:${r.imgH}/${r.stageH}`).join(' '))
  check('ชุดปุ่มไม่ทับชื่อแม่แบบ', rows.every((r) => !r.overlapTitle), rows.filter((r) => r.overlapTitle).map((r) => `${r.w}px`).join(' ') || 'ไม่ชนเลย')

  // เก็บภาพที่จอแคบที่สุด ซึ่งเป็นเคสที่พังง่ายที่สุด
  await setWidth(360)
  await sleep(600)
  const png = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(join(OUT, 'w360.png'), Buffer.from(png.data, 'base64'))
  await setWidth(1280)
  await sleep(600)
  const png2 = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(join(OUT, 'w1280.png'), Buffer.from(png2.data, 'base64'))
}

/* ── [3] ซูมต้องมีผลจริง และเลื่อนดูส่วนที่เกินได้ ────────────────── */
console.log('\n[3] ซูมแล้วต้องใหญ่ขึ้นจริง และเลื่อนดูส่วนที่เกินได้')
{
  const measure = () => evaluate(`(() => {
    const stage = document.querySelector('.lightbox__stage')
    const img = document.querySelector('[data-testid="lightbox-img"]')
    const ir = img.getBoundingClientRect()
    return {
      zoom: img.getAttribute('data-zoom'),
      label: document.querySelector('[data-testid="lightbox-zoom-level"]')?.textContent?.trim() ?? null,
      imgH: Math.round(ir.height),
      imgW: Math.round(ir.width),
      stageH: Math.round(stage.getBoundingClientRect().height),
      canScrollY: stage.scrollHeight > stage.clientHeight + 1,
      canScrollX: stage.scrollWidth > stage.clientWidth + 1,
      scrollH: stage.scrollHeight, clientH: stage.clientHeight,
      zoomOutDisabled: document.querySelector('[data-testid="lightbox-zoom-out"]')?.disabled,
      zoomInDisabled: document.querySelector('[data-testid="lightbox-zoom-in"]')?.disabled,
    }
  })()`)

  const before = await measure()
  check('เริ่มต้นซูม 100% (พอดีจอ)', before.zoom === '1' && before.label === '100%', `${before.zoom} · ป้าย "${before.label}"`)
  /**
   * ⚠️ ที่ 100% ยังย่อต่อได้อีก (75%, 50%) → ปุ่มซูมออกต้อง**ไม่ถูกปิด**
   *   ปิดเฉพาะตอนถึงขอบสุดของรายการ (50% ปิดซูมออก · สูงสุดปิดซูมเข้า)
   */
  check('ที่ 100% ยังซูมเข้า-ออกได้ทั้งสองทาง', before.zoomOutDisabled === false && before.zoomInDisabled === false, `ซูมออกปิด=${before.zoomOutDisabled} · ซูมเข้าปิด=${before.zoomInDisabled}`)

  const zin = await clickTestId('lightbox-zoom-in')
  check('กดซูมเข้าได้', zin.ok, zin.why ?? '')
  await sleep(600)
  const z1 = await measure()
  check('รูปใหญ่ขึ้นจริงเมื่อซูมเข้า', z1.imgH > before.imgH, `${before.imgH}px → ${z1.imgH}px (×${z1.zoom})`)
  check('ป้ายระดับซูมเปลี่ยนตาม', z1.label === '150%', `"${z1.label}"`)

  for (let n = 0; n < 3; n++) { await clickTestId('lightbox-zoom-in'); await sleep(500) }
  const zmax = await measure()
  check('ซูมสูงสุดแล้วเลื่อนดูส่วนที่เกินได้', zmax.canScrollY || zmax.canScrollX, `ซูม ×${zmax.zoom} · เลื่อนลงได้ ${zmax.canScrollY} · เลื่อนข้างได้ ${zmax.canScrollX}`)
  check('ปุ่มซูมเข้าถูกปิดที่สูงสุด', zmax.zoomInDisabled === true, `ปิด = ${zmax.zoomInDisabled}`)
  const pngZ = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(join(OUT, 'zoomed.png'), Buffer.from(pngZ.data, 'base64'))

  // กดตัวเลขเพื่อกลับพอดีจอ
  const reset = await clickTestId('lightbox-zoom-level')
  check('กดตัวเลขเพื่อกลับพอดีจอได้', reset.ok, reset.why ?? '')
  await sleep(600)
  const back = await measure()
  check('กลับมาพอดีจอแล้วไม่ล้นพื้นที่', back.zoom === '1' && back.imgH <= back.stageH, `×${back.zoom} · ${back.imgH}/${back.stageH}`)

  // ย่อต่ำกว่าพอดีจอ
  for (let n = 0; n < 2; n++) { await clickTestId('lightbox-zoom-out'); await sleep(500) }
  const small = await measure()
  check('ย่อต่ำกว่าพอดีจอได้ (เห็นทั้งฉบับพร้อมกัน)', small.imgH < back.imgH, `${back.imgH}px → ${small.imgH}px (×${small.zoom})`)
  check('ย่อจนต่ำสุดแล้วปุ่มซูมออกถูกปิด', small.zoomOutDisabled === true && small.zoomInDisabled === false, `ซูมออกปิด=${small.zoomOutDisabled} · ซูมเข้าปิด=${small.zoomInDisabled} (×${small.zoom})`)
  await evaluate(`(() => { const s = document.querySelector('.lightbox__stage'); s.scrollTop = 0; s.scrollLeft = 0 })()`)
  await clickTestId('lightbox-zoom-level')
  await sleep(500)
}

/* ── [4] เลื่อนรูป ──────────────────────────────────────────────── */
console.log('\n[4] เลื่อนรูปไปข้างหน้า/ถอยหลัง')
{
  const cnt = () => evaluate(`document.querySelector('[data-testid="lightbox-count"]')?.textContent?.trim() ?? ''`)
  check('เริ่มที่รูปที่ 1', (await cnt()) === '1 / 2', await cnt())
  await clickTestId('lightbox-next')
  await sleep(1200)
  check('กด › ไปรูปที่ 2', (await cnt()) === '2 / 2', await cnt())
  await clickTestId('lightbox-prev')
  await sleep(1200)
  check('กด ‹ ย้อนกลับรูปที่ 1', (await cnt()) === '1 / 2', await cnt())

  // คีย์บอร์ด
  for (const type of ['rawKeyDown', 'keyUp']) {
    await send('Input.dispatchKeyEvent', { type, key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 })
  }
  await sleep(1200)
  check('ปุ่มลูกศรขวาเลื่อนรูปได้', (await cnt()) === '2 / 2', await cnt())

  for (const type of ['rawKeyDown', 'keyUp']) {
    await send('Input.dispatchKeyEvent', { type, key: '0', code: 'Digit0', text: '0' })
  }
  await sleep(500)
  const z = await evaluate(`document.querySelector('[data-testid="lightbox-img"]')?.getAttribute('data-zoom')`)
  check('กด 0 กลับซูมพอดีจอ', z === '1', `ซูม = ${z}`)
}

/* ── [5] ปุ่มไปฟอร์ม ───────────────────────────────────────────── */
console.log('\n[5] ปุ่มไปฟอร์ม (ข้อความใหม่ + ไอคอน)')
{
  const info = await evaluate(`(() => {
    const a = document.querySelector('[data-testid="lightbox-to-form"]')
    return {
      href: a?.getAttribute('href') ?? '',
      text: (a?.textContent ?? '').trim(),
      ic: (a?.querySelector('.lightbox__toform-ic')?.textContent ?? '').trim(),
      visible: a ? a.getBoundingClientRect().width > 0 : false,
    }
  })()`)
  check('ลิงก์ชี้แท็บฟอร์มของแม่แบบนี้', info.href === `/studio/${encodeURIComponent(key)}?tabs=form`, info.href)
  check('ข้อความบอกกริยาว่า "แก้ไขฟอร์ม" ไม่ใช่แค่ "ไปที่ฟอร์ม"', info.text.includes('แก้ไขฟอร์ม'), `"${info.text}"`)
  check('มีไอคอนนำหน้าข้อความ', info.ic.length > 0, `ไอคอน "${info.ic}"`)
  check('ปุ่มแสดงผลบนจอ', info.visible)
}

/* ── เก็บกวาด ─────────────────────────────────────────────────── */
const pngEnd = await send('Page.captureScreenshot', { format: 'png' })
writeFileSync(join(OUT, 'final.png'), Buffer.from(pngEnd.data, 'base64'))

console.log(`\n── ผ่าน ${pass} · ไม่ผ่าน ${fail} ─────────────────────\n`)
console.log(`ภาพ: ${OUT}`)

await send('Browser.close').catch(() => undefined)
chrome.kill()
ws.close()
if (key) {
  await fetch(`${API}/api/templates/${encodeURIComponent(key)}/purge`, { method: 'DELETE', headers: hd }).catch(() => {})
  await wipeAccess(key).catch(() => {})
}
await redis.del(`session:${SID}`)
redis.disconnect()
process.exit(fail ? 1 : 0)
