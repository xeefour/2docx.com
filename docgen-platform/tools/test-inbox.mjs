/**
 * กล่องจดหมาย (inbox) — แท็บใหม่ + กระดิ่งในหัวหน้า + แบ่งตามประเภท
 *
 * ผู้ใช้สั่ง:
 *   *"เพิ่มกล่องจดหมาย inbox แบ่งประเภทของจดหมายด้วย
 *     จากระบบที่เตือนต่าง ๆ เวลามีอะไรที่เกี่ยวข้องให้แจ้งเตือนเข้าไปในกล่องนี้
 *     จากเพื่อนที่ส่งมาให้ เช่น แชร์แม่แบบให้"*
 *
 *   node --env-file=.env tools/test-inbox.mjs
 *
 * ── ทำไมบางประเภทต้อง "หว่าน" ใส่ Mongo ตรง ๆ ─────────────────────────
 *   · `share`   ได้จริง — สร้างแม่แบบสองอันแล้วแชร์ไปมาให้ถูกทั้งสองทาง
 *   · `system`  ได้จริง — ส่งแม่แบบเข้าถังขยะ (ระบบแจ้งว่าใกล้ถูกลบถาวร)
 *   · `access`  หว่าน — ต้องมีคนสองคนถือแม่แบบเดียวกันพร้อมกัน ซึ่งช้ากว่าจะตั้ง
 *   · `document` หว่าน — ต้องรอ worker เรนเดอร์จริง ซึ่งผูกกับคิว NATS
 *     (ถ้าไม่หว่าน เทสต์นี้จะตกทั้งชุดเวลาคิวค้าง ทั้งที่ UI ปกติ)
 *   → ฝั่ง API ของสองประเภทหลังนี้ถูกพิสูจน์แยกใน `tools/smoke-inbox.mjs` แล้ว
 *   ที่นี่ทดสอบ**การแสดงผลและการกรอง** ซึ่งคือส่วนที่หน้าเว็บทำ
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
const PORT = 9401
const STAMP = Date.now()
const OUT = new URL('../tests/nav-status/output-inbox/', import.meta.url)
mkdirSync(OUT, { recursive: true })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let pass = 0
let fail = 0
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`)
  ok ? pass++ : fail++
}

const redis = new Redis(process.env.VALKEY_URL)
const mkSession = async (tag) => {
  const sid = `${tag}-${STAMP}`
  await redis.set(
    `session:${sid}`,
    JSON.stringify({ sub: sid, name: tag, email: `${tag}@test.local`, avatar: '' }),
    'EX',
    900,
  )
  return sid
}
const OWNER = await mkSession('inboxowner')
const OTHER = await mkSession('inboxother')
const h = (sid) => ({ cookie: `docgen_session=${sid}` })

const call = async (path, sid, opt = {}) => {
  const r = await fetch(`${API}${path}`, {
    method: opt.method ?? 'GET',
    ...(opt.body ? { body: opt.body } : {}),
    headers: { ...h(sid), ...(opt.headers ?? {}) },
  })
  const text = await r.text()
  let body = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = text
  }
  return { status: r.status, body }
}

let mongo
const db = async () => {
  if (!mongo) {
    mongo = new MongoClient(await resolveMongoUrl(() => {}))
    await mongo.connect()
  }
  return mongo.db(process.env.MONGO_DB ?? 'app')
}

const created = []
/** ยืมไฟล์จากแม่แบบที่มีอยู่แล้ว (POST /api/templates รับเฉพาะ multipart) */
const mkTemplate = async (sid, name) => {
  const list = await call('/api/templates', sid)
  const donor = (list.body?.items ?? []).find((t) => t.id ?? t.versionId)
  if (!donor) throw new Error('ไม่มีแม่แบบเดิมให้ยืมไฟล์')
  const donorId = String(donor.id ?? donor.versionId)
  const bytes = new Uint8Array(
    await (await fetch(`${API}/api/templates/${encodeURIComponent(donorId)}`, { headers: h(sid) })).arrayBuffer(),
  )
  const f = new FormData()
  f.set('versioning', 'true')
  f.set('name', name)
  f.set('template', new Blob([bytes], { type: 'application/octet-stream' }), 'ต้นฉบับ.docx')
  const r = await fetch(`${API}/api/templates`, { method: 'POST', headers: h(sid), body: f })
  const b = await r.json().catch(() => null)
  const key = String(b?.id ?? b?.templateKey ?? '')
  if (key) created.push(key)
  return key
}

/** หว่านจดหมายเข้า Mongo ตรง (ดูหัวไฟล์ว่าทำไม) */
const seed = async (doc) => {
  await (await db()).collection('notifications').insertOne({
    _id: `seed-${STAMP}-${Math.random().toString(36).slice(2, 9)}`,
    read: false,
    at: new Date(Date.now() - Math.random() * 6 * 3600_000),
    ...doc,
  })
}

const cleanup = async () => {
  for (const k of created) {
    await call(`/api/templates/${encodeURIComponent(k)}/purge`, OWNER, { method: 'DELETE' }).catch(() => {})
  }
  try {
    const d = await db()
    await d.collection('notifications').deleteMany({ user: { $in: [OWNER, OTHER] } })
    await d.collection('template_access').deleteMany({ _id: { $in: created } })
    await d.collection('template_tombstones').deleteMany({ _id: { $in: created } })
  } catch {}
  await redis.del(`session:${OWNER}`, `session:${OTHER}`)
  await redis.quit()
  if (mongo) await mongo.close()
}

/* ── เตรียมข้อมูล ────────────────────────────────────────────── */
console.log('\n[0] เตรียมจดหมายให้ผู้ใช้ทดสอบ')
const t1 = await mkTemplate(OWNER, `กล่องจดหมาย A ${STAMP}`)
const t2 = await mkTemplate(OTHER, `กล่องจดหมาย B ${STAMP}`)
check('สร้างแม่แบบ 2 อันได้', !!t1 && !!t2, `${t1} · ${t2}`)

if (!t1 || !t2) {
  await cleanup()
  process.exit(1)
}

// แชร์สองทาง → OWNER ได้จดหมายประเภท share จริง
await call(`/api/access/${encodeURIComponent(t2)}/share`, OTHER, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ sub: OWNER, name: 'เจ้าของ', role: 'editor' }),
})
// ถังขยะ → OWNER ได้จดหมายประเภท system จริง
await call(`/api/templates/${encodeURIComponent(t1)}`, OWNER, { method: 'DELETE' })
// หว่านอีกสองประเภทให้ครบทุกช่องของตัวกรอง
await seed({
  user: OWNER,
  kind: 'access',
  title: 'สิทธิ์ของคุณเปลี่ยนแล้ว',
  body: 'เจ้าของ เปลี่ยนสิทธิ์ของคุณเป็น "ดูอย่างเดียว"',
  link: `/studio/${t2}`,
  templateName: null,
})
await seed({
  user: OWNER,
  kind: 'document',
  title: 'เอกสารเรนเดอร์เสร็จแล้ว',
  body: '"ทดสอบเอกสาร" เรนเดอร์เสร็จแล้ว (.pdf)',
  link: `/studio/${t2}`,
  templateName: null,
})

const inbox = async (sid = OWNER) => (await call('/api/notifications', sid)).body
const before = await inbox()
const total = before?.items?.length ?? 0
const unread = before?.unread ?? 0
check('กล่องมีจดหมายครบ 4 ประเภท', total >= 4, `${total} ฉบับ · ยังไม่อ่าน ${unread}`)
const kinds = new Set((before?.items ?? []).map((n) => n.kind))
check(
  'ครบทุกประเภท (share/access/document/system)',
  ['share', 'access', 'document', 'system'].every((k) => kinds.has(k)),
  [...kinds].join(','),
)

/* ── เบราว์เซอร์ ────────────────────────────────────────────── */
const profile = mkdtempSync(join(tmpdir(), 'cdp-inbox-'))
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
  await sleep(350)
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
/** คลิกแท็บตามข้อความ (Tabs ไม่มี testid เพราะอยู่นอกไฟล์ที่แก้ได้) */
const clickTab = async (text) => {
  const js = `
    const el = [...document.querySelectorAll('[role="tab"]')]
      .find((t) => t.textContent.trim().startsWith(${JSON.stringify(text)}))
    if (!el) return { miss: 'ไม่เจอแท็บ ' + ${JSON.stringify(text)} }
    el.scrollIntoView({ block: 'center' })
    const r = el.getBoundingClientRect()
    const x = r.x + r.width / 2, y = r.y + r.height / 2
    const hit = document.elementFromPoint(x, y)
    return { ok: !!hit && (hit === el || el.contains(hit)), x, y }
  `
  let box = await clickJs(js)
  /*
   * ⚠️ จอเล็ก: แท็บอยู่ในลิ้นชักที่**ปิดอยู่** จึงกดไม่ติด
   *   ผู้ใช้จริงต้องกดปุ่ม "เมนู" ก่อน — ชุดนี้ต้องทำตามด้วย
   *   ไม่งั้นทุกข้อบน 390px ที่ต้องแตะแท็บจะตก ทั้งที่เมนูไม่ได้เสีย
   *   (เคยตกไป 4 ข้อ: รายการ 0 ฉบับ · ตัวกรอง 0 ปุ่ม · ล้น 0)
   */
  if (!box?.ok) {
    await clickTestId('rail-open')
    await sleep(500)
    box = await clickJs(js)
  }
  return box
}
const VK = { Escape: 27 }
const pressKey = async (name) => {
  for (const type of ['rawKeyDown', 'keyUp'])
    await send('Input.dispatchKeyEvent', {
      type, key: name, code: name,
      windowsVirtualKeyCode: VK[name], nativeVirtualKeyCode: VK[name],
    })
  await sleep(300)
}
const goList = async () => {
  await send('Page.navigate', { url: `${WEB}/studio?_=${STAMP}` })
  await sleep(2500)
  await send('Network.setCacheDisabled', { cacheDisabled: true })
  await waitFor('!!document.querySelector(\'[data-testid="inbox-bell"]\')', 45000)
}

try {
  await send('Page.enable')
  await send('Runtime.enable')
  await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false })
  await send('Network.setCacheDisabled', { cacheDisabled: true })
  /**
   * ⚠️ cookie ของ session ต้อง set ใน**เบราว์เซอร์**ด้วย ไม่ใช่แค่ fetch จาก Node
   *    (fetch จาก Node ไม่มี cookie jar — มันคนละทางกับหน้าเว็บ)
   *    ถ้าลืม หน้าเว็บจะ redirect ไป /login/oauth/authorize
   *    แล้วเทสต์จะตกทั้งชุดโดยไม่มีอะไรชี้ว่าเป็นเรื่อง session
   */
  await send('Network.setCookie', { name: 'docgen_session', value: OWNER, url: WEB })
  await goList()
  await waitFor('!!document.querySelector(\'[data-testid="inbox-bell"]\')', 45000)

  /* ── 1 · กระดิ่งในหัวหน้า ─────────────────────────────────── */
  console.log('\n[1] กระดิ่ง 🔔 ในหัวหน้า')
  const bell = await evaluate(`
    (() => {
      const el = document.querySelector('[data-testid="inbox-bell"]')
      if (!el) return null
      const r = el.getBoundingClientRect()
      return {
        h: Math.round(r.height), w: Math.round(r.width),
        inView: r.top >= 0 && r.bottom <= innerHeight + 1 && r.right <= innerWidth + 1,
        label: el.getAttribute('aria-label') ?? el.title ?? '',
      }
    })()
  `)
  check('มีกระดิ่งในหัวหน้า', !!bell)
  check('กระดิ่งอยู่ในจอ', !!bell?.inView)
  check('พื้นที่แตะพอสำหรับนิ้ว (≥36px)', (bell?.h ?? 0) >= 36, `${bell?.w}×${bell?.h}px`)
  check('กระดิ่งมีชื่อให้ screen reader อ่าน', !!bell?.label, bell?.label)

  const bellCount = await evaluate(
    'document.querySelector(\'[data-testid="inbox-bell-count"]\')?.textContent?.trim() ?? null',
  )
  check('ป้ายบอกจำนวนที่ยังไม่อ่านตรงกับของจริง', bellCount === String(unread), `โชว์ "${bellCount}" · จริง ${unread}`)

  const open1 = await clickTestId('inbox-bell')
  check('กดกระดิ่งแล้วเปิดกล่องเล็ก', !!open1?.ok, open1?.miss ?? open1?.why ?? '')
  const pop = await evaluate(`
    (() => {
      const el = document.querySelector('[data-testid="inbox-bell-pop"]')
      if (!el) return null
      const r = el.getBoundingClientRect()
      const cs = getComputedStyle(el)
      return {
        pos: cs.position, z: Number(cs.zIndex),
        w: Math.round(r.width), h: Math.round(r.height),
        outRight: Math.round(r.right - innerWidth), outLeft: Math.round(-r.left),
        outBottom: Math.round(r.bottom - innerHeight),
      }
    })()
  `)
  check('กล่องเล็กมีขนาดจริง', (pop?.w ?? 0) > 100 && (pop?.h ?? 0) > 40, `${pop?.w}×${pop?.h}px`)
  check('กล่องเล็กไม่ล้นออกนอกจอ', (pop?.outRight ?? 1) <= 0 && (pop?.outLeft ?? 1) <= 0 && (pop?.outBottom ?? 1) <= 0,
    `ขวา ${pop?.outRight} · ซ้าย ${pop?.outLeft} · ล่าง ${pop?.outBottom}`)
  check('ทับ lightbox ได้ (z-index สูงพอ)', (pop?.z ?? 0) > 2147482601, String(pop?.z))
  await shot('01-bell-open.png')

  await pressKey('Escape')
  check('Escape ปิดกล่องเล็ก', !(await evaluate('!!document.querySelector(\'[data-testid="inbox-bell-pop"]\')')))

  /* ── 2 · แท็บจดหมาย ──────────────────────────────────────── */
  console.log('\n[2] แท็บจดหมายในแถบแท็บ')
  const tabHit = await clickTab('จดหมาย')
  check('มีแท็บ "จดหมาย"', !!tabHit?.ok, tabHit?.miss ?? '')
  const panelShown = await waitFor('!!document.querySelector(\'[data-testid="inbox-panel"]\')', 15000)
  check('คลิกแล้วเห็นกล่องจดหมาย', panelShown)
  await sleep(1200)

  const items = await evaluate(`
    [...document.querySelectorAll('[data-testid="inbox-item"]')].map((el) => ({
      title: el.querySelector('[data-testid="inbox-item-title"]')?.textContent?.trim() ?? '',
      body: el.querySelector('[data-testid="inbox-item-body"]')?.textContent?.trim() ?? '',
      unread: !!el.querySelector('[data-testid="inbox-item-unread"]'),
      outRight: Math.round(el.getBoundingClientRect().right - innerWidth),
    }))
  `)
  check('รายการจดหมายแสดงครบ', (items?.length ?? 0) === total, `โชว์ ${items?.length} · มีจริง ${total}`)
  check('ทุกฉบับมีชื่อเรื่องและข้อความ', (items ?? []).every((i) => i.title && i.body))
  check('ฉบับที่ยังไม่อ่านถูกทำเครื่องหมายไว้', (items ?? []).filter((i) => i.unread).length === unread,
    `มีป้าย ${items?.filter((i) => i.unread).length} · ยังไม่อ่าน ${unread}`)
  check('รายการไม่ล้นออกนอกจอ', (items ?? []).every((i) => i.outRight <= 0))
  await shot('02-inbox-tab.png')

  /* ── 3 · แบ่งตามประเภท ────────────────────────────────────── */
  console.log('\n[3] ตัวกรองตามประเภท')
  for (const [kind, label] of [
    ['share', 'การแชร์'],
    ['access', 'สิทธิ์'],
    ['document', 'งานเอกสาร'],
    ['system', 'ระบบ'],
  ]) {
    const c = await clickTestId(`inbox-filter-${kind}`)
    if (!c?.ok) {
      check(`กดตัวกรอง "${label}" ได้`, false, c?.miss ?? '')
      continue
    }
    await sleep(900)
    /**
     * ⚠️ เทียบ**ชื่อเรื่อง**กับข้อมูลจาก API แทนการอ่าน data-kind จาก DOM
     *   เพราะไม่ได้กำหนดให้ component ติด attribute นั้น
     *   และถ้าฝั่ง UI ทำผิด เราจะได้ "ชื่อเรื่องไม่ตรงกับประเภทที่เลือก"
     *   ซึ่งบอกปัญหาได้ชัดกว่าแค่ "จำนวนไม่ตรง"
     */
    const got = await evaluate(`
      [...document.querySelectorAll('[data-testid="inbox-item"]')]
        .map((el) => el.querySelector('[data-testid="inbox-item-title"]')?.textContent?.trim() ?? '')
    `)
    const wantTitles = (before.items ?? []).filter((n) => n.kind === kind).map((n) => n.title)
    const sameCount = (got?.length ?? 0) === wantTitles.length
    const allMatch = (got ?? []).every((t) => wantTitles.includes(t))
    check(`กรอง "${label}" แล้วเหลือเฉพาะประเภทนี้`, sameCount && allMatch,
      `โชว์ ${got?.length} · ควรเป็น ${wantTitles.length} · ${allMatch ? 'ตรงทั้งหมด' : 'มีชื่อไม่ตรงประเภท'}`)
  }
  const backAll = await clickTestId('inbox-filter-all')
  check('กด "ทั้งหมด" กลับมาได้', !!backAll?.ok, backAll?.miss ?? '')
  await sleep(900)
  const allBack = await evaluate('document.querySelectorAll(\'[data-testid="inbox-item"]\').length')
  check('กลับมาแล้วเห็นครบทุกฉบับ', allBack === total, `โชว์ ${allBack} · มีจริง ${total}`)

  /* ── 4 · คลิกอ่าน → นำทางไปแม่แบบ ─────────────────────────── */
  console.log('\n[4] คลิกจดหมายแล้วนำทางไปแม่แบบ')
  const target = (before.items ?? []).find((n) => n.link && !n.read)
  check('มีจดหมายที่ยังไม่อ่านและมีลิงก์', !!target, target?.link)
  const go = await clickJs(`
    const el = [...document.querySelectorAll('[data-testid="inbox-item"]')]
      .find((x) => x.querySelector('[data-testid="inbox-item-title"]')?.textContent?.trim() === ${JSON.stringify(target?.title ?? '')})
    if (!el) return { miss: 'ไม่เจอฉบับที่จะคลิก' }
    const r = el.getBoundingClientRect()
    const x = r.x + Math.min(120, r.width / 2), y = r.y + 20
    const hit = document.elementFromPoint(x, y)
    return { ok: !!hit && (hit === el || el.contains(hit)), x, y }
  `)
  check('คลิกจดหมายได้', !!go?.ok, go?.miss ?? '')
  const navigated = await waitFor(`location.pathname === ${JSON.stringify(target?.link ?? '/x')}`, 15000)
  check('คลิกแล้วไปที่แม่แบบที่เกี่ยวข้อง', navigated, await evaluate('location.pathname'))

  const afterOpen = await inbox()
  check('เปิดแล้วจดหมายนั้นถือว่าอ่านแล้ว', (afterOpen?.unread ?? 0) < unread, `${unread} → ${afterOpen?.unread}`)

  /* ── 5 · อ่านทั้งหมด + ล้างกล่อง ───────────────────────────── */
  console.log('\n[5] อ่านทั้งหมด / ล้างกล่อง')
  await goList()
  await clickTab('จดหมาย')
  await waitFor('!!document.querySelector(\'[data-testid="inbox-panel"]\')', 15000)
  await sleep(1000)

  const readAll = await clickTestId('inbox-mark-all-read')
  check('มีปุ่ม "อ่านทั้งหมด" และกดได้', !!readAll?.ok, readAll?.miss ?? '')
  await sleep(1200)
  const afterReadAll = await inbox()
  check('ทุกฉบับถือว่าอ่านแล้ว', afterReadAll?.unread === 0, `unread=${afterReadAll?.unread}`)
  const bellGone = await evaluate(
    'document.querySelector(\'[data-testid="inbox-bell-count"]\')?.textContent?.trim() ?? null',
  )
  check('ป้ายบนกระดิ่งหายไปเมื่ออ่านหมดแล้ว', bellGone === null || bellGone === '0', String(bellGone))

  const clr = await clickTestId('inbox-clear')
  check('มีปุ่ม "ล้างกล่อง" และกดได้', !!clr?.ok, clr?.miss ?? '')
  // ต้องมีการยืนยันก่อนล้างจริง (ลบถาวร)
  const asked = await waitFor(
    '!!document.querySelector("button, [role=dialog]") && /ล้าง|ยืนยัน|แน่ใจ|ลบทั้งหมด/.test(document.body.innerText)',
    6000,
  )
  check('ล้างกล่องต้องถามยืนยันก่อน', asked)
  await shot('03-confirm-clear.png')
  const stillThere = await inbox()
  check('ยังไม่ลบจนกว่าจะกดยืนยัน', (stillThere?.total ?? 0) > 0, `ยังมี ${stillThere?.total} ฉบับ`)

  /* ── 6 · จอเล็ก ──────────────────────────────────────────── */
  console.log('\n[6] จอเล็ก 390px')
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 780, deviceScaleFactor: 1, mobile: false })
  await goList()
  await clickTab('จดหมาย')
  await waitFor('!!document.querySelector(\'[data-testid="inbox-panel"]\')', 15000)
  await sleep(1200)
  const narrow = await evaluate(`
    (() => {
      const doc = document.documentElement
      const items = [...document.querySelectorAll('[data-testid="inbox-item"]')]
      const filters = [...document.querySelectorAll('[data-testid^="inbox-filter-"]')]
      const btns = filters.map((b) => {
        const r = b.getBoundingClientRect()
        return { w: r.right <= innerWidth + 0.5, l: r.left >= -0.5, h: r.height }
      })
      return {
        overflow: Math.max(doc.scrollWidth, document.body.scrollWidth) - innerWidth,
        items: items.length,
        itemOut: items.filter((e) => e.getBoundingClientRect().right > innerWidth + 0.5).length,
        filters: filters.length,
        badFilter: btns.filter((b) => !b.w || !b.l).length,
        minFilterH: btns.length ? Math.min(...btns.map((b) => b.h)) : 0,
      }
    })()
  `)
  check('จอเล็ก: หน้าไม่ล้นแนวนอน', (narrow?.overflow ?? 1) <= 0, `ล้น ${narrow?.overflow}px`)
  check('จอเล็ก: รายการจดหมายยังเห็นครบ', (narrow?.items ?? 0) > 0, `${narrow?.items} ฉบับ`)
  check('จอเล็ก: รายการไม่ล้นออกนอกจอ', narrow?.itemOut === 0, `ล้น ${narrow?.itemOut} ฉบับ`)
  check('จอเล็ก: มีตัวกรองครบ 5 ปุ่ม', (narrow?.filters ?? 0) === 5, `${narrow?.filters} ปุ่ม`)
  check('จอเล็ก: ปุ่มกรองไม่ล้นและแตะได้', narrow?.badFilter === 0 && (narrow?.minFilterH ?? 0) >= 24,
    `ล้น ${narrow?.badFilter} · สูงสุดยาว ${Math.round(narrow?.minFilterH ?? 0)}px`)
  await shot('04-narrow.png')
} catch (err) {
  check('เทสต์รันจบโดยไม่พัง', false, String(err?.message ?? err))
} finally {
  await cleanup()
  await send('Browser.close').catch(() => {})
  chrome.kill()
  ws.close()
  console.log(`\n── ผ่าน ${pass} · ไม่ผ่าน ${fail} ─────────────────────`)
  console.log(`ภาพ: ${OUT}`)
  process.exit(fail ? 1 : 0)
}
