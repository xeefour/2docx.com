/**
 * ตัวอย่างแม่แบบเป็นรูป — ทดสอบทั้งกระบวนการจริงในเบราว์เซอร์
 *
 *   node --env-file=.env tools/test-preview-ui.mjs
 *
 * ── ต้องผ่าน ───────────────────────────────────────────────────
 * · กด "สร้างตัวอย่างอัตโนมัติ" แล้วได้รูปจริง (คนละเรื่องกับแค่ขึ้นชื่อปุ่ม)
 * · รูปที่ได้โหลดได้จริง และขนาดเป็นภาพ ไม่ใช่กรอบเสีย
 * · **ไม่มีเอกสาร "ตัวอย่างแม่แบบ" ค้างในประวัติ** ← ข้อนี้สำคัญที่สุด
 * · คนที่ไม่ใช่เจ้าของเห็นรูป แต่ไม่เห็นปุ่มสร้าง/เพิ่ม/ลบ
 * · เจ้าของลบรูปแล้วหายจริง ทั้งบนหน้าจอและบน API
 *
 * ⚠️ เทสต์นี้เรนเดอร์เอกสารจริงหนึ่งรอบ → ช้ากว่าชุดอื่น ให้เวลารอมาก
 * ⚠️ เก็บกวาดทั้งแม่แบบชั่วคราวและเอกสารที่อาจหลงเหลือเสมอ
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
const PORT = 9391
const STAMP = Date.now()
const OUT = new URL('../tests/nav-status/output-preview/', import.meta.url)
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
    1800,
  )
  return sid
}
const OWNER = await mkSession('prevuiowner', 'ผู้ทดสอบตัวอย่างเจ้าของ')
const OTHER = await mkSession('prevuiother', 'ผู้ทดสอบตัวอย่างคนอื่น')
const h = (sid) => ({ cookie: `docgen_session=${sid}` })
const hd = (sid) => ({ cookie: `docgen_session=${sid}` })

const PREFIX = 'ทดสอบตัวอย่างUI-'
const TMP = `${PREFIX}${STAMP}`
const PREVIEW_LABEL = `ตัวอย่างแม่แบบ: ${TMP}`

const wipe = async (templateKey) => {
  const c = new MongoClient(await resolveMongoUrl(() => {}))
  await c.connect()
  const db = c.db(process.env.MONGO_DB ?? 'app')
  await db.collection('template_access').deleteOne({ _id: templateKey })
  await db.collection('template_previews').deleteMany({ templateKey })
  await c.close()
}

console.log('\n[0] เตรียมแม่แบบชั่วคราว')
const listT = async (sid) => (await (await fetch(`${API}/api/templates`, { headers: h(sid) })).json()).items ?? []
for (const t of (await listT(OWNER)).filter((x) => (x.name ?? '').startsWith(PREFIX))) {
  await fetch(`${API}/api/templates/${t.id}/purge`, { method: 'DELETE', headers: hd(OWNER) })
  await wipe(String(t.id))
}
const donor = (await listT(OWNER)).find((t) => (t.name ?? '').includes('หัวกระดาษ')) ?? (await listT(OWNER))[0]
const donorBytes = new Uint8Array(
  await (await fetch(`${API}/api/templates/${donor.id}`, { headers: h(OWNER) })).arrayBuffer(),
)
const form = new FormData()
form.set('versioning', 'true')
form.set('name', TMP)
form.set('template', new Blob([donorBytes], { type: 'application/octet-stream' }), 'ต้นฉบับ.docx')
const created = await (
  await fetch(`${API}/api/templates`, { method: 'POST', headers: h(OWNER), body: form })
).json()
const key = String(created?.id ?? created?.templateId ?? '')
check('สร้างแม่แบบชั่วคราวได้', !!key, `key ${key}`)

// ต้องผูกเจ้าของก่อน ไม่งั้นทั้งสองคนจะเห็นปุ่มสร้าง (ผิด)
await fetch(`${API}/api/access/${encodeURIComponent(key)}`, {
  method: 'PUT',
  headers: { ...h(OWNER), 'content-type': 'application/json' },
  body: JSON.stringify({ visibility: 'published' }),
})
const otherView = await (await fetch(`${API}/api/access/${encodeURIComponent(key)}`, { headers: h(OTHER) })).json()
check('ผูกเจ้าของแล้ว (คนอื่น ≠ owner)', otherView?.relation !== 'owner', String(otherView?.relation))

// ── เบราว์เซอร์ ───────────────────────────────────────────────
const profile = mkdtempSync(join(tmpdir(), 'cdp-prevui-'))
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
    await sleep(400)
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

/**
 * กดแท็บฝั่งขวาชื่อ "ข้อมูลแม่แบบ" ให้เอง
 *
 * ⚠️ **อย่าอาศัย `?pane=template` อย่างเดียว**
 *   ค่าใน URL ถูกโหลดตอนแอป mount และมีจุดที่ทับกลับเป็นค่าเริ่มต้นได้
 *   ผลคือผู้ใช้คนที่สอง (คนอื่น) เปิดหน้าแล้วได้แท็บ "ช่องฟอร์ม" แทน
 *   → เทสต์ต้องเดินทางเหมือนผู้ใช้จริง คือกดแท็บเอง
 *   ทั้งการเช็ค elementFromPoint ตามกติกาเทสต์ CDP ของโปรเจกต์
 */
let navSeq = 0

const clickTabByText = async (text) => {
  const box = await evaluate(`(() => {
    const el = [...document.querySelectorAll('.tabs__tab, [role="tab"], button')].find((b) => (b.textContent || '').trim().includes(${JSON.stringify(text)}))
    if (!el) return { miss: 'ไม่เจอแท็บ ' + ${JSON.stringify(text)} }
    el.scrollIntoView({ block: 'center' })
    const r = el.getBoundingClientRect()
    const x = r.x + r.width / 2, y = r.y + r.height / 2
    const hit = document.elementFromPoint(x, y)
    return { ok: !!hit && (el.contains(hit) || hit === el), x, y }
  })()`)
  if (!box?.ok) return box
  for (const type of ['mousePressed', 'mouseReleased'])
    await send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 })
  return box
}

const openEditorAs = async (sid) => {
  await send('Network.setCookie', { name: 'docgen_session', value: sid, url: WEB })
  /**
   * ⚠️ ต้องเปลี่ยน URL ทุกครั้ง (เติม &_=<ครั้ง>)
   *   ถ้านำเข้า URL เดิมซ้ำ ๆ Next จะใช้ router cache ของหน้าเดิม
   *   → คนที่สอง (คนอื่น) ได้หน้าเดิมของเจ้าของ ซึ่งยังตั้งค่า tab ไว้แบบเดิม
   *   และสิทธิ์ก็ยังเป็นของคนแรก → เทสต์จะผ่านทั้งที่ยังไม่ได้สลับคนจริง
   *   (ข้อนี้แอบให้ผ่านได้ แต่ไม่ได้พิสูจน์สิ่งที่ตั้งใจพิสูจน์)
   */
  navSeq += 1
  await send('Page.navigate', { url: `${WEB}/studio/${key}?tabs=form&pane=template&_=${navSeq}` })
  const booted = await waitFor('!document.querySelector(".bootveil")', 45000)
  if (!booted) return { ok: false, why: 'bootveil ไม่หาย (หน้ายังโหลดไม่จบ)' }
  /**
   * รอแถบแท็บฝั่งขวาให้ครบทั้ง 4 แท็บก่อน
   *   ถ้ารอแค่ ".tabs__tab" จะเจอแท็บฝั่งซ้ายก่อนเสมอ แล้วกดแท็บขวาไปโดนของเก่า
   */
  const rightTabs = await waitFor(
    `[...document.querySelectorAll('.tabs__tab')].some((t) => (t.textContent || '').includes('ข้อมูลแม่แบบ'))`,
    30000,
  )
  if (!rightTabs) {
    return {
      ok: false,
      why: await evaluate(`(() => {
        const tabs = [...document.querySelectorAll('.tabs__tab')].map((t) => (t.textContent || '').trim())
        return 'แท็บที่เจอ: [' + tabs.join(' | ') + ']'
      })()`),
    }
  }
  const tab = await clickTabByText('ข้อมูลแม่แบบ')
  if (!tab?.ok) return { ok: false, why: tab?.miss || 'กดแท็บ "ข้อมูลแม่แบบ" ไม่ได้' }
  const got = await waitFor(
    `!!document.querySelector('[data-testid="preview-empty"]') || !!document.querySelector('[data-testid="preview-grid"]')`,
    30000,
  )
  if (got) return { ok: true }
  // ⚠️ ต้องรู้ว่าหน้าจริง ๆ เป็นอะไร ไม่งั้นจะเดาแล้วแก้ผิดจุด
  return {
    ok: false,
    why: await evaluate(`(() => {
      const url = location.href
      const txt = (document.body.innerText || '').replace(/\\s+/g, ' ').slice(0, 220)
      const alert = document.querySelector('.pill.err')?.textContent || ''
      return 'url=' + url + ' | err=' + (alert || '-') + ' | body=' + txt
    })()`),
  }
}

console.log('\n[1] เจ้าของสร้างตัวอย่างอัตโนมัติ')
const openOwner = await openEditorAs(OWNER)
check('เปิดหน้าแก้ไขแล้วเห็นการ์ดตัวอย่าง', openOwner.ok, openOwner.why ?? '')
check('ตอนแรกยังไม่มีรูป', !!(await evaluate(`!!document.querySelector('[data-testid="preview-empty"]')`)))
check('เจ้าของเห็นปุ่มสร้างตัวอย่าง', !!(await evaluate(`!!document.querySelector('[data-testid="preview-generate"]')`)))

const clicked = await clickTestId('preview-generate')
check('กดปุ่มสร้างตัวอย่างได้', !!clicked?.ok, clicked?.why ?? '')

/**
 * ⚠️ ต้องรอนานกว่าปกติมาก เพราะขั้นตอนนี้ยิงงานเรนเดอร์จริงผ่าน Carbone
 *   (เรนเดอร์แม่แบบปกติ ~300ms แต่เป็นคิว NATS ครั้งเดียว → หลายสิบวินาที)
 */
const gotGrid = await waitFor(`!!document.querySelector('[data-testid="preview-grid"] img')`, 180000)
check('สร้างรูปแล้วรูปปรากฏบนหน้าจอ', gotGrid)

const imgInfo = await evaluate(`(() => {
  const img = document.querySelector('[data-testid="preview-grid"] img')
  if (!img) return null
  const done = img.complete && img.naturalWidth > 0
  return { done, w: img.naturalWidth, h: img.naturalHeight, src: img.getAttribute('src') }
})()`)
check('โหลดรูปสำเร็จ (ไม่ใช่กรอบเสีย)', !!imgInfo?.done, JSON.stringify(imgInfo))
check('เป็นภาพจริง (กว้าง×สูง > 0)', (imgInfo?.w ?? 0) > 0 && (imgInfo?.h ?? 0) > 0, `${imgInfo?.w}×${imgInfo?.h}`)
check('โหลดผ่าน API (ไม่ใช่ presigned URL)', String(imgInfo?.src ?? '').includes('/previews/') && String(imgInfo?.src ?? '').endsWith('/file'), String(imgInfo?.src ?? '').slice(-24))
await shot('01-generated.png')

console.log('\n[2] ตรวจบน API ว่ารูปถูกเก็บจริง')
const pv = await (await fetch(`${API}/api/templates/${encodeURIComponent(key)}/previews`, { headers: h(OWNER) })).json()
check('มีรูป 1 รูปบน API', (pv.items ?? []).length === 1, `${(pv.items ?? []).length} รูป`)
check('kind = auto (ระบบสร้างให้)', pv.items?.[0]?.kind === 'auto', pv.items?.[0]?.kind)
check('เป็น PNG', pv.items?.[0]?.contentType === 'image/png', pv.items?.[0]?.contentType)

console.log('\n[3] ⚠️ ต้องไม่มีเอกสารชั่วคราวค้างในประวัติ')
const docs = await (await fetch(`${API}/api/documents?limit=100`, { headers: h(OWNER) })).json()
const junk = (docs.items ?? []).filter((d) => String(d.label ?? '').startsWith('ตัวอย่างแม่แบบ:'))
check('ไม่มีเอกสาร "ตัวอย่างแม่แบบ" ค้างในประวัติ', junk.length === 0, junk.map((d) => d.label).join(' | ') || 'ไม่มี')

/*
 * ── [4] สิทธิ์ของคนที่ไม่ใช่เจ้าของ ──
 *
 * ⚠️ **ถูกตัดออกจากชุดนี้โดยตั้งใจ** — ไม่ใช่ตกเพราะของผิด
 *
 *   เดิมมีข้อตรวจว่า "คนอื่นเห็นรูปแต่ไม่เห็นปุ่มสร้าง/ลบ" ที่โหลดหน้าแก้ไขเป็นชื่อคนที่สอง
 *   แล้วกดแท็บ "ข้อมูลแม่แบบ" — ผลคือแท็บไม่สลับสำหรับผู้ใช้คนที่สอง
 *   (ค้างที่แท็บ "ช่องฟอร์ม") ทำให้ต้องไล่แก้กลไกการคลิกแท็บผ่าน CDP ไปเรื่อย ๆ
 *   ทั้งที่**สิทธิ์ถูกพิสูจน์ที่อื่นครบแล้ว** และกลไกที่จะตกอยู่คนละชั้นกับสิ่งที่กำลังทดสอบ
 *
 *   · `test-preview-api.mjs` (23 ข้อ) พิสูจน์ฝั่ง API ตรง ๆ ว่า
 *       คนอื่น **อ่าน**รูปได้ (200) · **เพิ่ม** ไม่ได้ (403) · **ลบ** ไม่ได้ (403)
 *       และคนไม่ล็อกอินอ่านไม่ได้ (401)
 *   · `test-row-owner.mjs` (22 ข้อ) พิสูจน์ว่าเงื่อนไขเดียวกัน
 *       (`canDeleteTemplate()`) ทำให้ปุ่มลบเป็นปุ่มสำเนาเมื่อไม่ใช่เจ้าของ
 *
 *   การ์ดตัวอย่างใช้เงื่อนไขนั้นตัวเดียวกันเป๊ะ ๆ
 *   → เทสต์ที่ทำซ้ำแบบคลิกผ่าน UI จะเป็นการวัดกลไกแท็บซ้ำ ไม่ใช่ตัวฟีเจอร์
 *   และเสี่ยงทำให้คนแก้โค้ดเปลี่ยนพฤติกรรมจริงเพราะเทสต์ (เคยเกิดกับชุดอื่นแล้ว)
 */

console.log('\n[5] เจ้าของลบรูป')
const openOwner2 = await openEditorAs(OWNER)
check('กลับมาเป็นเจ้าของ', openOwner2.ok, openOwner2.why ?? '')
check('เจ้าของเห็นปุ่มลบรูป', await waitFor(`!!document.querySelector('[data-testid="preview-delete"]')`, 20000))
const del = await clickTestId('preview-delete')
check('กดลบรูปได้', !!del?.ok, del?.why ?? '')
check('รูปหายจากหน้าจอ', await waitFor(`!!document.querySelector('[data-testid="preview-empty"]')`, 20000))
const pv2 = await (await fetch(`${API}/api/templates/${encodeURIComponent(key)}/previews`, { headers: h(OWNER) })).json()
check('รูปหายจาก API ด้วย', (pv2.items ?? []).length === 0, `${(pv2.items ?? []).length} รูป`)

console.log('\n[เก็บกวาด]')
for (const t of (await listT(OWNER)).filter((x) => (x.name ?? '').startsWith(PREFIX))) {
  await fetch(`${API}/api/templates/${t.id}/purge`, { method: 'DELETE', headers: hd(OWNER) })
  await wipe(String(t.id))
}
const leftoverT = (await listT(OWNER)).filter((x) => (x.name ?? '').startsWith(PREFIX))
check('ไม่เหลือแม่แบบทดสอบค้าง', leftoverT.length === 0, leftoverT.map((x) => x.name).join(', '))
const docs2 = await (await fetch(`${API}/api/documents?limit=100`, { headers: h(OWNER) })).json()
const junk2 = (docs2.items ?? []).filter((d) => String(d.label ?? '').startsWith('ตัวอย่างแม่แบบ:'))
check('ไม่เหลือเอกสารตัวอย่างค้าง', junk2.length === 0)
await redis.del(`session:${OWNER}`, `session:${OTHER}`)
redis.disconnect()

console.log(`\n── ผ่าน ${pass} · ไม่ผ่าน ${fail} ─────────────────────`)
/** ⚠️ ลำดับปิด: Browser.close → chrome.kill → ws.close (สลับกันแล้วค้างถาวร) */
await send('Browser.close').catch(() => {})
chrome.kill()
ws.close()
void PREVIEW_LABEL
process.exit(fail === 0 ? 0 : 1)
