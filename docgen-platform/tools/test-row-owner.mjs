/**
 * ปุ่มช่องสุดท้ายของแถว — ลบเฉพาะเจ้าของ · คนอื่นได้ปุ่มสำเนา
 *
 *   node --env-file=.env tools/test-row-owner.mjs
 *
 * ผู้ใช้สั่ง: *"ปุ่มลบแม่แบบ จะแสดงเฉพาะผู้ที่เป็นเจ้าของเท่านั้น
 *   แทนที่ด้วยปุ่มสำเนาแม่แบบ แทน"*
 *
 * ── ที่ต้องผ่าน ────────────────────────────────────────────────
 * 1. เจ้าของเห็นปุ่ม "ลบ" และ**ไม่เห็น**ปุ่ม "สำเนา"
 * 2. คนที่ไม่ใช่เจ้าของเห็นปุ่ม "สำเนา" และ**ไม่เห็น**ปุ่ม "ลบ"
 * 3. กด "สำเนา" แล้วได้แม่แบบใหม่จริง (เช็คทั้ง API และหน้าจอ)
 * 4. ต้นฉบับไม่หาย — คนอื่นยังใช้ต้นฉบับได้
 * 5. ปุ่ม "ลบ" ยังกดสองจังหวะ (กดครั้งเดียวไม่ลบ)
 *
 * ── กันดักที่ต้องรู้ ─────────────────────────────────────────────
 * · กติกา "ใครเห็นอะไร" **ไม่ใช่** `relation === 'owner'` อย่างเดียว
 *   ฝั่ง API (`trashTemplate`) ยังให้ลบได้เมื่อแม่แบบ**ยังไม่มีเจ้าของ**
 *   (กติกา "คนแรกที่กดเป็นเจ้าของ") → เทสต์นี้ต้องทำให้แม่แบบ**มีเจ้าของจริง**
 *   เสมอ ไม่งั้นสองฝั่งจะเห็นปุ่มเดียวกันและข้อตรวจจะผ่านทั้งที่ผิด
 * · ต้องสร้าง**สองคน** (สอง session) ไม่ใช่คนเดียว
 *   คนเดียวเป็นเจ้าของทุกอย่างที่สร้าง → ทดสอบฝั่ง "ไม่ใช่เจ้าของ"ไม่ได้เลย
 * · แม่แบบชั่วคราวที่สร้างไว้เป็นของเจ้าของ → ต้อง `purge` ทิ้งเสมอ
 *   ไม่งั้นค้างในรายการแล้วไปเป็น `items[0]` ของเทสต์อื่น (เคยเกิดจริง)
 *
 * ⚠️ เทสต์นี้ไม่ลบแม่แบบจริงของผู้ใช้ ใช้เฉพาะแม่แบบที่สร้างเอง
 */
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Redis } from 'ioredis'
import { resolveMongoUrl } from '@docgen/shared'
import { MongoClient } from 'mongodb'

const API = process.env.API_URL ?? 'http://127.0.0.1:4001'
const WEB = 'http://localhost:3000'
const CHROME = process.env.CHROME_PATH ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const PORT = 9388
const STAMP = Date.now()
const OUT = new URL('../tests/nav-status/output-row-owner/', import.meta.url)
mkdirSync(OUT, { recursive: true })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let pass = 0
let fail = 0
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`)
  ok ? pass++ : fail++
}

const redis = new Redis(process.env.VALKEY_URL)
const mkSession = async (tag, label) => {
  const sid = `${tag}-${STAMP}`
  await redis.set(
    `session:${sid}`,
    JSON.stringify({ sub: sid, name: label, email: `${tag}@test.local`, avatar: '' }),
    'EX',
    900,
  )
  return sid
}
const OWNER = await mkSession('rowowner', 'ผู้ทดสอบเจ้าของ')
const OTHER = await mkSession('rowother', 'ผู้ทดสอบคนอื่น')
const HO = { cookie: `docgen_session=${OWNER}`, 'content-type': 'application/json' }
const HN = { cookie: `docgen_session=${OTHER}`, 'content-type': 'application/json' }
/** ⚠️ ห้ามส่ง content-type ไปกับ DELETE ที่ไม่มี body (Fastify ตอบ 500) */
const hd = (h) => ({ cookie: h.cookie })

/** ลบเอกสารสิทธิ์ตรง ๆ — เจ้าของอาจเป็น session ที่หมดอายุแล้ว */
const wipeAccess = async (templateKey) => {
  const url = await resolveMongoUrl((m) => console.log('   ', m))
  const c = new MongoClient(url)
  await c.connect()
  await c.db(process.env.MONGO_DB ?? 'app').collection('template_access').deleteOne({ _id: templateKey })
  await c.close()
}

// ── 0. เตรียมแม่แบบชั่วคราว ───────────────────────────────────────
console.log('\n[0] เตรียมแม่แบบชั่วคราว (ไม่แตะแม่แบบจริงของผู้ใช้)')
const TMP_PREFIX = 'ทดสอบสิทธิ์แถว-'
const TMP = `${TMP_PREFIX}${STAMP}`
const CLONE = `${TMP} (สำเนา)`
const gone = []
{
  const ghosts = (await (await fetch(`${API}/api/templates`, { headers: HO })).json()).items ?? []
  for (const g of ghosts.filter((t) => (t.name ?? '').startsWith(TMP_PREFIX))) {
    await fetch(`${API}/api/templates/${g.id}/purge`, { method: 'DELETE', headers: hd(HO) })
    await wipeAccess(g.id)
    gone.push(String(g.id))
  }
  if (gone.length) console.log(`   ลบค้างจากรอบก่อน ${gone.length} ตัว`)
}
const list = (await (await fetch(`${API}/api/templates`, { headers: HO })).json()).items ?? []
const donor = list.find((t) => (t.name ?? '').includes('หัวกระดาษ')) ?? list[0]
if (!donor) {
  console.log('✗ ไม่มีแม่แบบในระบบให้ใช้เป็นต้นแบบ')
  process.exit(1)
}
const donorBytes = new Uint8Array(
  await (await fetch(`${API}/api/templates/${donor.id}`, { headers: HO })).arrayBuffer(),
)
const createForm = new FormData()
createForm.set('versioning', 'true')
createForm.set('name', TMP)
createForm.set('category', 'ทดสอบ')
createForm.set('template', new Blob([donorBytes], { type: 'application/octet-stream' }), 'ต้นฉบับ.docx')
const created = await (
  await fetch(`${API}/api/templates`, { method: 'POST', headers: { cookie: HO.cookie }, body: createForm })
).json()
const key = String(created?.id ?? created?.templateId ?? '')
check('สร้างแม่แบบชั่วคราวได้', !!key, `key ${key}`)

/**
 * ⚠️ ขั้นนี้สำคัญที่สุดของเทสต์
 *   แม่แบบใหม่**ยังไม่มีเอกสารสิทธิ์** → `owner === null`
 *   ตามกติกา "คนแรกที่กดตั้งค่าเป็นเจ้าของ" ทุกคนจะเห็นปุ่ม **ลบ**
 *   ถ้าไม่ตั้งค่าที่นี่ ข้อ 1 และข้อ 2 จะผ่านพร้อมกันทั้งที่โค้ดผิด
 */
const claim = await fetch(`${API}/api/access/${encodeURIComponent(key)}`, {
  method: 'PUT',
  headers: HO,
  body: JSON.stringify({ visibility: 'published' }),
})
check('ตั้งค่าให้เจ้าของเป็นผู้ใช้คนแรก', claim.ok, `HTTP ${claim.status}`)
const view = await (await fetch(`${API}/api/access/${encodeURIComponent(key)}`, { headers: HN })).json()
check('ยืนยันว่ามีเจ้าของจริงแล้ว (ไม่ใช่ owner = null)', !!view?.owner, view?.ownerName ?? 'ไม่มีเจ้าของ')
check('คนอื่นมองเห็นเป็นสิทธิ์แชร์ ไม่ใช่เจ้าของ', view?.relation !== 'owner', String(view?.relation))

const purge = async (k, h) => {
  const r = await fetch(`${API}/api/templates/${k}/purge`, { method: 'DELETE', headers: hd(h) })
  await wipeAccess(k)
  return r.status
}
const cleanup = async () => {
  console.log('\n[เก็บกวาด] ลบแม่แบบชั่วคราวทั้งหมด')
  const left = []
  if (key) left.push([key, await purge(key, HO)])
  // กันกรณีกดสำเนาสำเร็จแล้วค้างแม่แบบที่ชื่อไม่ตรงที่คาด
  const now = (await (await fetch(`${API}/api/templates`, { headers: HO })).json()).items ?? []
  for (const t of now.filter((x) => (x.name ?? '').startsWith(TMP_PREFIX))) {
    left.push([String(t.id), await purge(String(t.id), HO)])
  }
  const after = (await (await fetch(`${API}/api/templates`, { headers: HO })).json()).items ?? []
  const still = after.filter((t) => (t.name ?? '').startsWith(TMP_PREFIX))
  check('ไม่เหลือแม่แบบชั่วคราวค้างให้เทสต์อื่น', still.length === 0, still.map((t) => t.name).join(', '))
  await redis.del(`session:${OWNER}`, `session:${OTHER}`)
  redis.disconnect()
  return left
}

// ── เบราว์เซอร์ ────────────────────────────────────────────────
const profile = mkdtempSync(join(tmpdir(), 'cdp-rowowner-'))
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
    setTimeout(() => {
      if (waiting.has(id)) {
        waiting.delete(id)
        reject(new Error(`timeout: ${method}`))
      }
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
const evaluate = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text)
  return r.result?.value
}
const waitFor = async (expr, ms = 20000) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    try {
      if (await evaluate(expr)) return true
    } catch {}
    await sleep(250)
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
    const x = r.x + r.width / 2, y = r.y + r.height / 2
    const hit = document.elementFromPoint(x, y)
    return { ok: !!hit && (el.contains(hit) || hit === el), x, y, disabled: el.disabled }
  })()`)
  if (!box?.ok) return box
  if (box.disabled) return { ...box, ok: false, why: 'ปุ่มถูก disable' }
  for (const type of ['mousePressed', 'mouseReleased'])
    await send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 })
  return box
}

await send('Page.enable')
await send('Runtime.enable')
await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false })
await send('Network.setCacheDisabled', { cacheDisabled: true })

/** เปิดหน้ารายการในชื่อแม่แบบที่ระบุ + รอจนแถวนั้นขึ้นจริง */
const openListAs = async (sid, name) => {
  await send('Network.setCookie', { name: 'docgen_session', value: sid, url: WEB })
  await send('Page.navigate', { url: `${WEB}/studio` })
  await waitFor('!document.querySelector(".bootveil")', 45000)
  return waitFor(
    `[...document.querySelectorAll('.tpllist tbody tr')].some(tr => {
      const b = tr.querySelector('td:first-child > button')
      return b && b.textContent.trim() === ${JSON.stringify(name)}
    })`,
    45000,
  )
}

/** ปุ่มช่องสุดท้ายของแถวที่ระบุ — คืนป้ายจริงที่ผู้ใช้เห็น */
const lastBtn = (name) =>
  evaluate(`(() => {
  const tr = [...document.querySelectorAll('.tpllist tbody tr')].find((x) => {
    const b = x.querySelector('td:first-child > button')
    return b && b.textContent.trim() === ${JSON.stringify(name)}
  })
  if (!tr) return { miss: 'ไม่เจอแถว' }
  const cell = tr.querySelector('td.tplrow__acts')
  const all = cell ? [...cell.querySelectorAll('button')].map((b) => b.textContent.trim()) : []
  return {
    all,
    last: all[all.length - 1] ?? '',
    hasDelete: !!tr.querySelector('[data-testid="row-delete"]'),
    hasClone: !!tr.querySelector('[data-testid="row-clone"]'),
  }
})()`)

// ── 1. เจ้าของเห็นปุ่มลบ ────────────────────────────────────────
console.log('\n[1] เจ้าของต้องเห็นปุ่ม "ลบ" และไม่เห็นปุ่ม "สำเนา"')
check('เจ้าของเปิดหน้ารายการแล้วเจอแถวของตัวเอง', await openListAs(OWNER, TMP))
const asOwner = await lastBtn(TMP)
check('เจ้าของเห็นปุ่ม "ลบ"', asOwner.last === 'ลบ', `ปุ่มสุดท้าย = "${asOwner.last}"`)
check('เจ้าของมีปุ่มลบจริง (data-testid)', asOwner.hasDelete === true)
check('เจ้าของไม่เห็นปุ่มสำเนา', asOwner.hasClone === false)
await shot('01-owner-delete.png')

// ── 2. ปุ่มลบยังกดสองจังหวะ ─────────────────────────────────────
console.log('\n[2] ปุ่ม "ลบ" ของเจ้าของยังต้องกดสองจังหวะ')
const first = await clickTestId('row-delete')
check('กดปุ่มลบครั้งแรกได้', !!first?.ok, first?.why ?? '')
check(
  'กดครั้งเดียวเปลี่ยนเป็น "ยืนยันลบ?"',
  await waitFor(
    "[...document.querySelectorAll('[data-testid=\\\"row-delete\\\"]')].some(b => b.textContent.includes('ยืนยันลบ'))",
    6000,
  ),
)
const stillThere = (await (await fetch(`${API}/api/templates`, { headers: HO })).json()).items ?? []
check('ยังไม่ลบจนกว่าจะกดยืนยัน', stillThere.some((t) => String(t.id ?? t.versionId) === key))

// ── 3. คนอื่นเห็นปุ่มสำเนา ──────────────────────────────────────
console.log('\n[3] คนที่ไม่ใช่เจ้าของต้องเห็นปุ่ม "สำเนา" และไม่เห็นปุ่ม "ลบ"')
check('คนอื่นเปิดหน้ารายการแล้วเจอแถวเดียวกัน', await openListAs(OTHER, TMP))
const asOther = await lastBtn(TMP)
check('คนอื่นเห็นปุ่ม "สำเนา"', asOther.last === 'สำเนา', `ปุ่มสุดท้าย = "${asOther.last}"`)
check('คนอื่นมีปุ่มสำเนาจริง (data-testid)', asOther.hasClone === true)
check('คนอื่นไม่เห็นปุ่มลบเลย', asOther.hasDelete === false)
await shot('02-other-clone.png')

// ── 4. กดสำเนาแล้วได้แม่แบบใหม่จริง ─────────────────────────────
console.log('\n[4] กด "สำเนา" แล้วต้องได้แม่แบบใหม่จริง')
const before = ((await (await fetch(`${API}/api/templates`, { headers: HN })).json()).items ?? []).length
const cloneClick = await clickTestId('row-clone')
check('กดปุ่มสำเนาได้', !!cloneClick?.ok, cloneClick?.why ?? '')
const madeClone = await waitFor(
  `(async () => {
    const r = await fetch('/api/templates', { credentials: 'same-origin' }).then((x) => x.json())
    return (r.items || []).some((t) => t.name === ${JSON.stringify(CLONE)})
  })()`,
  45000,
)
check('มีแม่แบบชื่อใหม่เกิดขึ้นจริง', madeClone, `คาดว่าจะได้ "${CLONE}"`)
const after = ((await (await fetch(`${API}/api/templates`, { headers: HN })).json()).items ?? []) ?? []
check('จำนวนแม่แบบเพิ่มขึ้น 1', after.length === before + 1, `${before} → ${after.length}`)
check('ต้นฉบับยังอยู่ (คนอื่นยังใช้ต่อได้)', after.some((t) => String(t.id ?? t.versionId) === key))
await shot('03-after-clone.png')

/**
 * ⚠️ กดสำเนาซ้ำต้องได้ชื่อเดิม ไม่ใช่ "(สำเนา) (สำเนา)"
 *   กันด้วย `cloneName()` — ถ้ามีคนไปแก้กลับเป็นการต่อท้ายตรง ๆ ข้อนี้จะตก
 */
const cloneKey = String(
  after.find((t) => t.name === CLONE)?.id ?? after.find((t) => t.name === CLONE)?.versionId ?? '',
)
if (cloneKey) {
  console.log('\n[5] กดสำเนาซ้ำ — ชื่อต้องไม่ซ้อน')
  await openListAs(OTHER, CLONE)
  const againClone = await clickTestId('row-clone')
  check('กดสำเนาบนแม่แบบที่เพิ่งสำเนามาได้', !!againClone?.ok, againClone?.why ?? '')
  const doubled = await waitFor(
    `(async () => {
      const r = await fetch('/api/templates', { credentials: 'same-origin' }).then((x) => x.json())
      return (r.items || []).some((t) => /\\(สำเนา\\)\\s*\\(สำเนา\\)/.test(t.name || ''))
    })()`,
    45000,
  )
  check('ชื่อไม่กลายเป็น "(สำเนา) (สำเนา)"', !doubled)
} else {
  console.log('\n[5] ข้าม — หาแม่แบบสำเนาไม่เจอ')
}

const ok = (await cleanup()) && fail === 0

console.log(`\n── ผ่าน ${pass} · ไม่ผ่าน ${fail} ─────────────────────`)
/**
 * ⚠️ ลำดับการปิดสำคัญ
 *   ปิด `ws` ก่อน → คำสั่งที่ยังรออยู่ไม่มีวันได้คำตอบ → สคริปต์ค้างถาวร
 *   แล้วทิ้ง Chrome ค้างหลายตัว (เคยเจอ ~45 ตัว)
 */
await send('Browser.close').catch(() => {})
chrome.kill()
ws.close()

process.exit(ok ? 0 : 1)
