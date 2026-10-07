/**
 * สมุดที่อยู่ผู้ใช้ + เชิญด้วยอีเมล
 *
 *   node --env-file=../dokploy-infra/.env --env-file=../dokploy-infra/.env.development tools/test-share-people.mjs
 *
 * ── ผู้ใช้สั่ง ─────────────────────────────────────────────────────
 * *"ส่วนนี้ ใช้ระบบ email ได้ไหม พิมพ์ซัก 3 ตัวอักษร แล้วจะมีเมล์ที่ผู้ใช้
 *   login เข้าใช้งานในระบบนี้ แสดงขึ้นมา เอาข้อมูลจากประวัติที่เคยแชร์
 *   ถ้าไม่มีอีเมล์ในระบบ ใช้วิธีการส่งเมล์ไปยังอีเมล์"*
 *
 * ── ทำไมต้องมีเทสต์นี้ ───────────────────────────────────────────────
 * ก่อนหน้านี้ระบบไม่มีที่เก็บอีเมลของผู้ใช้รายอื่นเลย ทำให้แชร์ได้ทางเดียว
 * คือพิมพ์ `sub` ของ Casdoor ซึ่งเป็น id ยาว ๆ ที่หามาไม่ได้
 *
 * จุดที่พังง่ายที่สุดในฟีเจอร์นี้:
 *   1. **คีย์ `pending_shares` ต้องไม่ชนกัน** — เชิญคนเดิมสองครั้งต้องไม่กลายเป็นสองสิทธิ์
 *   2. **ผูกสิทธิ์ตอนล็อกอินต้องไม่ทับสิทธิ์เดิม** — ใช้ $push ไม่ใช่ replace
 *   3. **ส่งเมลไม่สำเร็จต้องไม่กลายเป็น 500** — สิทธิ์ถูกบันทึกไว้แล้ว ถ้าตอบ error
 *      ผู้ใช้จะกดซ้ำจนได้สิทธิ์ซ้ำโดยไม่รู้ตัว
 *   4. **ห้ามคนอื่นเชิญบนแม่แบบที่ไม่ใช่ของตัวเอง**
 *
 * ⚠️ `people` ถูก seed ในเทสต์นี้โดยตรง แทนที่จะล็อกอินผ่าน Casdoor
 *   เพราะ callback ต้องผ่าน browser จริง — แต่ collection ที่เขียนเป็นชุดเดียวกัน
 */
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Redis } from 'ioredis'
import { MongoClient } from 'mongodb'
import { resolveMongoUrl } from '@docgen/shared'

const WEB = 'http://localhost:3000'
const API = process.env.API_URL ?? 'http://127.0.0.1:4001'
const CHROME = process.env.CHROME_PATH ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const PORT = 9407
const STAMP = Date.now()
const OUT = new URL('../tests/nav-status/output-share-people/', import.meta.url)
mkdirSync(OUT, { recursive: true })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let pass = 0
let fail = 0
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`)
  ok ? pass++ : fail++
}

const ME = `spp-me-${STAMP}`
const OTHER = `spp-other-${STAMP}`
/** คนที่ "เคยล็อกอิน" — อีเมลขึ้นต้นด้วย som เพื่อให้ทดสอบการเรียงลำดับได้ */
const FRIEND_SUB = `spp-friend-${STAMP}`
const FRIEND_EMAIL = `somchai.friend.${STAMP}@test.local`
const STRANGER_SUB = `spp-stranger-${STAMP}`
const STRANGER_EMAIL = `somchai.stranger.${STAMP}@test.local`
/** คนที่ยังไม่เคยเข้าระบบ — ต้องถูกเชิญด้วยอีเมล */
const NEWCOMER_EMAIL = `newcomer.${STAMP}@test.local`

const redis = new Redis(process.env.VALKEY_URL)
const mkSession = async (sub, name, email) => {
  await redis.set(
    `session:${sub}`,
    JSON.stringify({ sub, name, email, avatar: '' }),
    'EX',
    1800,
  )
  return { cookie: `docgen_session=${sub}` }
}
// ⚠️ `mkSession` คืน `{ cookie }` อยู่แล้ว ห่ออีกชั้นจะได้ cookie เป็น object
//   แล้ว fetch จะส่ง "[object Object]" ไป → 401 ทุกคำขอ (เจอตอนรันครั้งแรก)
const HD = await mkSession(ME, 'ผู้ทดสอบสมุดที่อยู่', `me.${STAMP}@test.local`)
const HD_OTHER = await mkSession(OTHER, 'คนอื่น', `other.${STAMP}@test.local`)

const mongo = new MongoClient(await resolveMongoUrl())
const db = mongo.db(process.env.MONGO_DB ?? 'app')
const people = db.collection('people')
const access = db.collection('template_access')
const pending = db.collection('pending_shares')

// ── เตรียมข้อมูล ──────────────────────────────────────────────────────
// ⚠️ ล้างของที่ค้างจากรอบก่อน ๆ ด้วย ด้วย prefix ของเทสต์ ไม่ใช่แค่ stamp ของรอบนี้
//   รอนที่พังกลางคันข้อมูลจะไม่ถูกลบ แล้วรอนถัดไปเจอของเก่าปน
//   → เกณฑ์ "ได้ 2 คน" ตก ทั้งที่ระบบทำงานถูก (เคยเจอตอนรันรอบแรก)
await people.deleteMany({ _id: { $regex: '^spp-(friend|stranger)-' } })
await people.insertMany([
  { _id: FRIEND_SUB, name: 'สมชาย เพื่อนเก่า', email: FRIEND_EMAIL, lastSeenAt: new Date(Date.now() - 40 * 864e5) },
  { _id: STRANGER_SUB, name: 'สมชาย แปลกหน้า', email: STRANGER_EMAIL, lastSeenAt: new Date() },
])
await access.deleteMany({ _id: ME })
await pending.deleteMany({ _id: { $regex: String(STAMP) } })

/**
 * หาแม่แบบสักตัวเพื่อใช้เป็นเป้าหมายของการแชร์
 *
 * ⚠️ ต้องรอ API พร้อมก่อน ไม่ใช่ยิงครั้งเดียว
 *   ตอนนี้ API รันด้วย tsx --watch → แก้ไฟล์ที่ไหนก็ restart ทันที
 *   ถ้ายิงตอนกำลัง restart จะได้ HTML หรือเชื่อมต่อไม่ขึ้น
 *   แล้วเทสต์จะตกด้วยข้อความ "ไม่มีแม่แบบในระบบ" ทั้งที่ระบบไม่ได้พัง
 */
const findTemplate = async () => {
  for (let i = 0; i < 15; i++) {
    try {
      const res = await fetch(`${API}/api/templates?limit=1`, { headers: HD })
      if (res.ok) {
        const body = await res.json()
        const key = body?.items?.[0]?.templateKey ?? body?.items?.[0]?.id ?? null
        if (key) return key
      }
    } catch {}
    await sleep(2000)
  }
  return null
}
const templateKey = await findTemplate()
check('มีแม่แบบในระบบให้ทดสอบ', !!templateKey, templateKey ?? 'ไม่เจอ')
if (!templateKey) {
  // ไม่มีแม่แบบ = ทำส่วนที่ต้องใช้แม่แบบต่อไปไม่ได้
  // ปล่อยให้รันจนจบแล้ว report แค่ข้อนี้ แทนที่จะพังกลางคันด้วย error ยาว ๆ
  console.log('\n  ⓘ ไม่มีแม่แบบในระบบ — ข้ามการทดสอบส่วนที่ต้องใช้แม่แบบ')
  await redis.del(`session:${ME}`)
  await redis.del(`session:${OTHER}`)
  redis.disconnect()
  await people.deleteMany({ _id: { $in: [FRIEND_SUB, STRANGER_SUB] } })
  await mongo.close()
  console.log(`\n── ผ่าน ${pass} · ไม่ผ่าน ${fail} ─────────────────────`)
  process.exit(1)
}

if (templateKey) {
  const prev = await access.findOne({ _id: templateKey })
  // ⚠️ เก็บไว้ใน logs/ ไม่ใช่โฟลเดอร์ภาพ — เป็นไฟล์ชั่วคราวของรอบทดสอบ ไม่ใช่ผลลัพธ์
  if (prev) writeFileSync(new URL('../logs/spp-prev-access.json', import.meta.url), JSON.stringify(prev))
  else writeFileSync(new URL('../logs/spp-prev-access.json', import.meta.url), '')
  await access.replaceOne(
    { _id: templateKey },
    {
      _id: templateKey,
      templateKey,
      visibility: 'private',
      owner: ME,
      ownerName: 'ผู้ทดสอบสมุดที่อยู่',
      sharedWith: [{ sub: FRIEND_SUB, name: 'สมชาย เพื่อนเก่า', role: 'viewer', at: new Date() }],
      updatedAt: new Date(),
    },
    { upsert: true },
  )
}

const get = async (path, headers = HD) => {
  const r = await fetch(`${API}${path}`, { headers })
  return { status: r.status, body: await r.json().catch(() => null) }
}
const post = async (path, body, headers = HD) => {
  const r = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: r.status, body: await r.json().catch(() => null) }
}
const del = async (path, headers = HD) => {
  const r = await fetch(`${API}${path}`, { method: 'DELETE', headers })
  return { status: r.status, body: await r.json().catch(() => null) }
}

console.log('\n[0] ค้นผู้ใช้จากสมุดที่อยู่')
const short = await get('/api/people?q=so')
check('พิมพ์ไม่ถึง 3 ตัวอักษร → ไม่ค้น', (short.body?.items ?? []).length === 0)
const found = await get('/api/people?q=somchai')
const items = found.body?.items ?? []
check(
  'พิมพ์ 3 ตัวอักษรขึ้นไป → เจออีเมล และเจอแค่ของรอบนี้',
  items.length === 2 && items.every((i) => i.email.includes(String(STAMP))),
  items.map((i) => i.email).join(' , '),
)
check(
  'ผลลัพธ์บอกว่าคนไหนเคยแชร์ด้วยกัน',
  items.filter((i) => i.shared).length === 1 && items[0]?.sub === FRIEND_SUB,
  items.map((i) => `${i.name}:${i.shared ? 'เคยแชร์' : 'ใหม่'}`).join(' , '),
)
check(
  'คนที่เพิ่งเข้าระบบมาก่อนคนเก่า (เมื่อไม่มีประวัติร่วม)',
  (() => {
    const s = items.filter((i) => !i.shared)
    return s.length < 2 || new Date(s[0].lastSeenAt) >= new Date(s[s.length - 1].lastSeenAt)
  })(),
)
check(
  'บอกสถานะว่าตั้งเซิร์ฟเวอร์อีเมลแล้วหรือยัง',
  typeof found.body?.mailReady === 'boolean',
  `mailReady=${found.body?.mailReady}`,
)
check('ไม่มีใครเห็นรายชื่อโดยไม่ล็อกอิน', (await get('/api/people?q=somchai', {})).status === 401)

console.log('\n[1] เชิญคนที่ยังไม่เคยเข้าระบบ')
const inv = await post(`/api/access/${templateKey}/invite`, { email: NEWCOMER_EMAIL, role: 'editor' })
check('ตอบ 200 แม้ส่งเมลไม่สำเร็จ', inv.status === 200, `HTTP ${inv.status} ${JSON.stringify(inv.body)}`)
check('บันทึกคำเชิญไว้แล้ว', inv.body?.pending === true)
check(
  'บอกตรง ๆ ว่าส่งเมลไม่ได้ (ไม่ใช่เงียบ ๆ)',
  inv.body?.emailed === false && typeof inv.body?.reason === 'string' && inv.body.reason.length > 0,
  inv.body?.reason ?? '',
)
const listInv = await get(`/api/access/${templateKey}/invites`)
check(
  'เจ้าของเห็นคำเชิญที่ยังรออยู่',
  (listInv.body?.items ?? []).some((i) => i.email === NEWCOMER_EMAIL),
  (listInv.body?.items ?? []).map((i) => i.email).join(' , '),
)
const dup = await post(`/api/access/${templateKey}/invite`, { email: NEWCOMER_EMAIL, role: 'viewer' })
const dupRows = await pending.countDocuments({ email: NEWCOMER_EMAIL })
check('เชิซ้ำคนเดิม = ยังมีแถวเดียว (ไม่ได้สิทธิ์ซ้ำ)', dup.status === 200 && dupRows === 1, `${dupRows} แถว`)
check('ไม่มีสิทธิ์จริงจนกว่าเขาจะเข้าระบบ', !((await get(`/api/access/${templateKey}`)).body?.sharedWith ?? []).some((s) => s.name === 'คนใหม่'))

console.log('\n[2] คนอื่นห้ามเชิญบนแม่แบบที่ไม่ใช่ของตัวเอง')
const foreign = await post(
  `/api/access/${templateKey}/invite`,
  { email: `hacker.${STAMP}@test.local`, role: 'editor' },
  HD_OTHER,
)
check('คนอื่นเชิญไม่ได้ (403)', foreign.status === 403, `HTTP ${foreign.status}`)
check(
  'ไม่มีคำเชิญค้างหลงเหลือจากคนอื่น',
  (await pending.countDocuments({ email: `hacker.${STAMP}@test.local` })) === 0,
)
const foreignCancel = await del(`/api/access/${templateKey}/invite/${encodeURIComponent(NEWCOMER_EMAIL)}`, HD_OTHER)
check('คนอื่นยกเลิกคำเชิญของคนอื่นไม่ได้ (403)', foreignCancel.status === 403, `HTTP ${foreignCancel.status}`)

console.log('\n[3] ยกเลิกคำเชิญ')
const cancelled = await del(`/api/access/${templateKey}/invite/${encodeURIComponent(NEWCOMER_EMAIL)}`)
check('เจ้าของยกเลิกได้', cancelled.body?.cancelled === true, JSON.stringify(cancelled.body))
check('แถวคำเชิญหายไปจริง', (await pending.countDocuments({ email: NEWCOMER_EMAIL })) === 0)

console.log('\n[4] ผูกสิทธิ์จริงตอนผู้ถูกเชิญเข้าสู่ระบบครั้งแรก')
/** คนที่จะถูกผูก — ยังไม่เคยมีในสมุดที่อยู่ */
const CLAIMER = `spp-newcomer-${STAMP}`
await post(`/api/access/${templateKey}/invite`, { email: NEWCOMER_EMAIL, role: 'editor' })
// เขียนคำเชิญก่อนหน้านี้ (FRIEND) เพื่อพิสูจน์ว่าการผูกไม่ทับสิทธิ์เดิม
const PROBE = new URL('../logs/claim-probe.ts', import.meta.url)
const runClaim = () =>
  new Promise((resolve) => {
    const p = spawn(
      process.execPath,
      ['--env-file=../dokploy-infra/.env --env-file=../dokploy-infra/.env.development', 'node_modules/tsx/dist/cli.mjs', 'logs/claim-probe.ts'],
      { cwd: new URL('..', import.meta.url).pathname.replace(/^\//, ''), encoding: 'utf8' },
    )
    let out = ''
    p.stdout.on('data', (d) => (out += d))
    p.stderr.on('data', (d) => (out += d))
    p.on('close', () => resolve(out))
  })
const writeProbe = () =>
  writeFileSync(
    PROBE,
    [
      `import { MongoClient } from 'mongodb'`,
      `import { resolveMongoUrl } from '@docgen/shared'`,
      // ⚠️ ต้องเข้าผ่านไฟล์จริง ไม่ใช่ mock เพราะ logic การผูกคำเชิญ
      //   อยู่ที่นี่ทั้งหมด ($push ไม่ทับ · ลบแถวคำเชิญ · แจ้งเตือน)
      `import { claimPendingShares } from '../apps/api/src/modules/people/invite.js'`,
      `const c = new MongoClient(await resolveMongoUrl())`,
      `const app = {`,
      `  mongo: c.db(process.env.MONGO_DB ?? 'app'),`,
      `  log: { info() {}, warn() {} },`,
      `}`,
      `const n = await claimPendingShares(app, {`,
      `  sub: ${JSON.stringify(CLAIMER)},`,
      `  name: 'คนใหม่ที่เพิ่งเข้าระบบ',`,
      `  email: ${JSON.stringify(NEWCOMER_EMAIL)},`,
      `  avatar: '',`,
      `})`,
      `console.log('claimed=' + n)`,
      `await c.close()`,
    ].join('\n'),
    'utf8',
  )

writeProbe()
const claimOut = await runClaim()
const claimed = Number(/claimed=(\d+)/.exec(claimOut)?.[1] ?? '-1')
check('ผูกคำเชิญได้ 1 รายการ', claimed === 1, claimOut.trim().split('\n').slice(-1)[0] ?? claimOut.slice(0, 160))
const after = await access.findOne({ _id: templateKey })
const rows = after?.sharedWith ?? []
const newcomerRow = rows.find((r) => r.sub === CLAIMER)
const friendRow = rows.find((r) => r.sub === FRIEND_SUB)
check('ได้สิทธิ์จริงใน sharedWith', !!newcomerRow, newcomerRow ? `role=${newcomerRow.role}` : 'ไม่มีแถว')
check('ได้สิทธิ์ตามที่เชิญไว้ (editor)', newcomerRow?.role === 'editor')
check('สิทธิ์เดิมของคนอื่นไม่หาย', !!friendRow, friendRow ? 'ยังอยู่' : 'หายไป — ถูกทับ!')
check('แถวคำเชิญถูกลบหลังผูกแล้ว', (await pending.countDocuments({ email: NEWCOMER_EMAIL })) === 0)
const notes = await db.collection('notifications').countDocuments({ user: CLAIMER, kind: 'access' })
check('ได้รับแจ้งเตือนว่าได้สิทธิ์', notes >= 1, `${notes} ฉบับ`)

// ผูกซ้ำต้องไม่เพิ่มสิทธิ์ซ้ำ
const again = await runClaim()
const after2 = await access.findOne({ _id: templateKey })
check(
  'ผูกซ้ำไม่ทำให้ได้สิทธิ์สองแถว',
  (after2?.sharedWith ?? []).filter((r) => r.sub === CLAIMER).length === 1,
  /claimed=\d+/.exec(again)?.[0] ?? '',
)

// ── UI ────────────────────────────────────────────────────────────────
const profile = mkdtempSync(join(tmpdir(), 'cdp-spp-'))
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
  if (r.exceptionDetails) {
    throw new Error(JSON.stringify(r.exceptionDetails.exception?.description || r.exceptionDetails.text))
  }
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
const typeInto = async (sel, text) => {
  await evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(sel)})
    el.focus()
    el.setSelectionRange(0, el.value.length)
  })()`)
  for (const ch of text) {
    await send('Input.dispatchKeyEvent', { type: 'keyDown', text: ch, unmodifiedText: ch })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', text: ch, unmodifiedText: ch })
  }
}

await send('Page.enable')
await send('Runtime.enable')
await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 950, deviceScaleFactor: 1, mobile: false })
await send('Network.setCacheDisabled', { cacheDisabled: true })
await send('Network.setCookie', { name: 'docgen_session', value: ME, url: WEB })

console.log('\n[5] หน้าเว็บ: พิมพ์อีเมลแล้วมีรายชื่อขึ้น')
await send('Page.navigate', { url: `${WEB}/studio/${templateKey}?tabs=form&pane=history&_=${STAMP}` })
check('หน้าแม่แบบโหลดได้', !!(await waitFor(`!!document.querySelector('[data-testid="share-email-input"]')`, 45000)))
const label = await evaluate(`document.querySelector('label[for$="-q"]')?.textContent ?? ''`)
check('ป้ายบอกว่าเป็นอีเมล ไม่ใช่ subject', /อีเมล/.test(label), label)
const hint = await evaluate(`document.body.innerText.includes('พิมพ์อีเมลของผู้ใช้ที่เคยเข้าระบบ')`)
check('มีคำอธิบายว่าคนที่ยังไม่เคยเข้าจะถูกเชิญให้อัตโนมัติ', hint === true)

await typeInto('[data-testid="share-email-input"]', 'som')
check('พิมพ์ 3 ตัวอักษร → รายชื่อตกลงมา', !!(await waitFor(`!!document.querySelector('[data-testid="ppick-list"]')`, 15000)))
const opt = await evaluate(`(() => {
  const list = document.querySelector('[data-testid="ppick-list"]')
  if (!list) return { miss: 1 }
  const first = list.querySelector('[data-testid="ppick-option"]')
  const r = first.getBoundingClientRect()
  const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)
  return {
    n: list.children.length,
    text: list.innerText.replace(/\\n/g, ' | '),
    firstIsFriend: first.innerText.includes('สมชาย เพื่อนเก่า'),
    // ⚠️ hit === null = พิกัดนอกจอ = ล้มเหลว ไม่ใช่ผ่าน
    ok: !!hit && (hit === first || first.contains(hit)),
    blocker: hit && hit !== first && !first.contains(hit) ? hit.tagName + '.' + String(hit.className || '') : '',
    rect: { t: Math.round(r.top), b: Math.round(r.bottom), w: Math.round(r.width) },
    inView: r.top >= 0 && r.bottom <= innerHeight,
  }
})()`)
check('รายชื่อที่เคยแชร์ด้วยกันมาก่อน', opt?.firstIsFriend === true, opt?.text ?? '')
check('รายการไม่ถูกอย่างอื่นบัง (กดเลือกได้)', opt?.ok === true, opt?.blocker ? 'โดน ' + opt.blocker : '')
check('รายการอยู่ในจอ (ไม่ล้นล่างจนเลื่อนไม่ทัน)', opt?.inView === true, JSON.stringify(opt?.rect))
await shot('1-autocomplete.png')

const picked = await evaluate(`(() => {
  const first = document.querySelector('[data-testid="ppick-option"]')
  const r = first.getBoundingClientRect()
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
})()`)
for (const type of ['mousePressed', 'mouseReleased']) {
  await send('Input.dispatchMouseEvent', { type, x: picked.x, y: picked.y, button: 'left', clickCount: 1 })
}
const afterPick = await evaluate(`(() => ({
  val: document.querySelector('[data-testid="share-email-input"]').value,
  list: !!document.querySelector('[data-testid="ppick-list"]'),
  btn: document.querySelector('[data-testid="share-add"]')?.textContent ?? document.querySelector('[data-testid="share-invite"]')?.textContent ?? '',
}))()`)
check('คลิกแล้วอีเมลเติมในช่อง', afterPick?.val === FRIEND_EMAIL, afterPick?.val ?? '')
check('รายชื่อปิดหลังเลือก', afterPick?.list === false)
check('ปุ่มเปลี่ยนเป็น "เพิ่ม" (เป็นคนในระบบ)', (afterPick?.btn ?? '').trim() === 'เพิ่ม', afterPick?.btn ?? '')

await typeInto('[data-testid="share-email-input"]', 'nonexistent.person@example.com')
const inviteBtn = await evaluate(`(() => {
  const b = document.querySelector('[data-testid="share-invite"]')
  return { text: b?.textContent ?? '', warn: !!document.querySelector('[data-testid="ppick-mail-warn"]') }
})()`)
check('พิมพ์อีเมลที่ไม่มีในระบบ → ปุ่มเป็น "เชิญด้วยอีเมล"', (inviteBtn?.text ?? '').trim() === 'เชิญด้วยอีเมล', inviteBtn?.text ?? '')
check(
  'เตือนว่ายังส่งอีเมลไม่ได้ (แต่สิทธิ์ยังได้)',
  inviteBtn?.warn === (found.body?.mailReady === false),
  `mailReady=${found.body?.mailReady}`,
)
await shot('2-invite.png')

console.log('\n[6] คำเชิญที่ยังรออยู่ต้องเห็นและยกเลิกได้จากหน้าเว็บ')
const WAITING_EMAIL = `waiting.${STAMP}@test.local`
await post(`/api/access/${templateKey}/invite`, { email: WAITING_EMAIL, role: 'viewer' })
await send('Page.reload')
check('โหลดหน้าใหม่แล้วเห็นรายการคำเชิญค้าง', !!(await waitFor(`!!document.querySelector('[data-testid="ppick-pending"]')`, 20000)))
const pend = await evaluate(`(() => {
  const box = document.querySelector('[data-testid="ppick-pending"]')
  const btn = document.querySelector('[data-testid="ppick-cancel"]')
  if (!box || !btn) return { miss: 1 }
  const r = btn.getBoundingClientRect()
  const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)
  return {
    text: box.innerText.replace(/\\n/g, ' | '),
    has: box.innerText.includes(${JSON.stringify(WAITING_EMAIL)}),
    ok: !!hit && (hit === btn || btn.contains(hit)),
    inView: r.top >= 0 && r.bottom <= innerHeight,
  }
})()`)
check('รายการแสดงอีเมลที่รออยู่', pend?.has === true, pend?.text ?? '')
check('ปุ่มยกเลิกกดได้ (ไม่ถูกอย่างอื่นบัง)', pend?.ok === true)
const cancelBox = await evaluate(`(() => {
  const b = document.querySelector('[data-testid="ppick-cancel"]')
  b.scrollIntoView({ block: 'center' })
  const r = b.getBoundingClientRect()
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
})()`)
for (const type of ['mousePressed', 'mouseReleased']) {
  await send('Input.dispatchMouseEvent', { type, x: cancelBox.x, y: cancelBox.y, button: 'left', clickCount: 1 })
}
check('กดยกเลิกแล้วรายการหาย', !!(await waitFor(`!document.querySelector('[data-testid="ppick-pending"]')`, 15000)))
check(
  'แถวคำเชิญหายจากฐานข้อมูลจริงด้วย',
  (await pending.countDocuments({ email: WAITING_EMAIL })) === 0,
)
await shot('3-pending-cancelled.png')

// ── เก็บกวาด ─────────────────────────────────────────────────────────
await redis.del(`session:${ME}`)
await redis.del(`session:${OTHER}`)
redis.disconnect()
await people.deleteMany({ _id: { $regex: '^spp-(friend|stranger)-' } })
await pending.deleteMany({ _id: { $regex: String(STAMP) } })
if (templateKey) {
  const raw = readFileSync(new URL('../logs/spp-prev-access.json', import.meta.url), 'utf8').trim()
  if (raw) await access.replaceOne({ _id: templateKey }, JSON.parse(raw))
  else await access.deleteOne({ _id: templateKey })
}
await mongo.close()
console.log(`\n── ผ่าน ${pass} · ไม่ผ่าน ${fail} ─────────────────────`)
await send('Browser.close').catch(() => {})
chrome.kill()
ws.close()
process.exit(fail === 0 ? 0 : 1)
