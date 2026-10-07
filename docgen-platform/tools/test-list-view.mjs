/**
 * มุมมีหน้ารายการ รายการ/ชิด + ภาพย่อ
 *
 *   node --env-file=../dokploy-infra/.env --env-file=../dokploy-infra/.env.development tools/test-list-view.mjs
 *
 * ── ต้องผ่าน ───────────────────────────────────────────────────
 * · ค่าเริ่มต้นเป็น "ชิด" (มีรูปให้ดู) และสลับเป็น "รายการ" ได้
 * · ปุ่มสลับมุมมี**ไม่มีข้อความ** (ผู้ใช้สั่ง *"ไม่เข้าใจความหมาย ชิด ไม่ต้องใส่ข้อความ"*)
 *   ต้องมี `aria-label` + `title` แทน และปุ่มสี่เหลี่ยมจับนิ้วได้ (≥36px)
 * · ค่าที่เลือก**จำไว้ข้ามหน้า** (localStorage) — ไม่ใช่แค่เปลี่ยนในหน้าจอนี้
 * · โหมดชิดโชว์ภาพย่อ · โหมดรายการ**ซ่อน**ภาพย่อ (แต่ td ยังอยู่)
 * · คอลัมน์ภาพย่ออยู่**ท้ายสุด** → data-label ของหมวด/แท็ก/ชนิดไฟล์บนมือถือไม่เพี้ยน
 * · แถวยังคงมีปุ่มจัดการครบ (ลบ/สำเนา) ในโหมดชิด
 */
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Redis } from 'ioredis'

const WEB = 'http://localhost:3000'
const CHROME = process.env.CHROME_PATH ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const PORT = 9393
const STAMP = Date.now()
const OUT = new URL('../tests/nav-status/output-listview/', import.meta.url)
mkdirSync(OUT, { recursive: true })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let pass = 0
let fail = 0
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`)
  ok ? pass++ : fail++
}

const redis = new Redis(process.env.VALKEY_URL)
const SID = `listview-${STAMP}`
await redis.set(
  `session:${SID}`,
  JSON.stringify({ sub: SID, name: 'ผู้ทดสอบมุมมีรายการ', email: 'lv@test.local', avatar: '' }),
  'EX',
  900,
)

const profile = mkdtempSync(join(tmpdir(), 'cdp-listview-'))
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
const clickTestId = async (id) => {
  const box = await evaluate(`(() => {
    const el = document.querySelector('[data-testid=${JSON.stringify(id)}]')
    if (!el) return { miss: 'ไม่เจอปุ่ม' }
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
await send('Network.setCookie', { name: 'docgen_session', value: SID, url: WEB })
await send('Page.navigate', { url: `${WEB}/studio` })
check('หน้ารายการโหลดได้', !!(await waitFor(`!!document.querySelector('.tpllist tbody tr')`, 45000)))

console.log('\n[1] ค่าเริ่มต้นและการสลับ')
const initial = await evaluate(`(() => {
  const t = document.querySelector('.tpllist')
  const gridBtn = document.querySelector('[data-testid="view-grid"]')
  const listBtn = document.querySelector('[data-testid="view-list"]')
  return {
    isGrid: !!t && t.classList.contains('tpllist--grid'),
    stored: localStorage.getItem('studio.listView'),
    gridOn: gridBtn?.getAttribute('aria-pressed'),
    listOn: listBtn?.getAttribute('aria-pressed'),
  }
})()`)
check('ค่าเริ่มต้นเป็นมุมมีชิด', initial?.isGrid === true, JSON.stringify(initial))
check('ปุ่มชิดถูกกดอยู่', initial?.gridOn === 'true')
check('ปุ่มรายการไม่ถูกกด', initial?.listOn === 'false')
await shot('01-grid.png')

console.log('\n[1b] ปุ่มสลับมุมมี — ต้องไม่มีข้อความ (เหลือไอคอนอย่างเดียว)')
/**
 * ผู้ใช้สั่ง: *"ไม่เข้าใจความหมาย ชิด ไม่ต้องใส่ข้อความ"*
 *
 * ⚠️ ตัดข้อความแล้วปุ่มจะ**ไร้ชื่อ** ถ้าไม่ย้ายความหมายไป `title`/`aria-label`
 *    โปรแกรมอ่านหน้าจอจะอ่านได้แค่ "ปุ่ม" และคนวางเมาส์ก็ไม่รู้ว่ากดได้อะไร
 */
const toggle = await evaluate(`(() => {
  const btns = [...document.querySelectorAll('.viewtoggle__btn')]
  return btns.map((b) => {
    const r = b.getBoundingClientRect()
    return {
      // ไอคอนเป็นอักขระเดียว (▦ / ☰) จึงยอมให้เหลือยาว 1
      text: b.textContent.trim(),
      label: b.getAttribute('aria-label') || '',
      title: b.getAttribute('title') || '',
      w: Math.round(r.width),
      h: Math.round(r.height),
    }
  })
})()`)
check('มีปุ่มสลับครบ 2 ปุ่ม', toggle?.length === 2, JSON.stringify(toggle))
check(
  'ปุ่มสวิตช์ไม่มีข้อความให้อ่าน (เหลือไอคอน)',
  Array.isArray(toggle) && toggle.every((b) => [...b.text].length <= 1),
  toggle?.map((b) => JSON.stringify(b.text)).join(' ')
)
check(
  'ทุกปุ่มมี aria-label (โปรแกรมอ่านหน้าจอต้องรู้ชื่อ)',
  Array.isArray(toggle) && toggle.every((b) => b.label.length > 0),
  toggle?.map((b) => b.label).join(' · ')
)
check(
  'ทุกปุ่มมี title (คนวางเมาส์เห็นคำอธิบาย)',
  Array.isArray(toggle) && toggle.every((b) => b.title.length > 0),
  toggle?.map((b) => b.title).join(' · ')
)
check(
  'ปุ่มสี่เหลี่ยมจับนิ้วได้ (≥36px)',
  Array.isArray(toggle) && toggle.every((b) => b.w >= 36 && b.h >= 36),
  toggle?.map((b) => `${b.w}×${b.h}`).join(' · ')
)

const toList = await clickTestId('view-list')
check('กดสลับเป็นรายการได้', !!toList?.ok, toList?.why ?? toList?.miss ?? '')
const asList = await evaluate(`(() => {
  const t = document.querySelector('.tpllist')
  const cell = document.querySelector('.tpllist tbody tr .tplrow__thumb')
  return {
    isGrid: t.classList.contains('tpllist--grid'),
    thumbDisplay: cell ? getComputedStyle(cell).display : 'ไม่มี td',
    stored: localStorage.getItem('studio.listView'),
  }
})()`)
check('กลายเป็นมุมมีรายการ', asList?.isGrid === false)
check('โหมดรายการซ่อนภาพย่อ', asList?.thumbDisplay === 'none', asList?.thumbDisplay)
check('บันทึกค่าลง localStorage', asList?.stored === 'list', String(asList?.stored))
check('td ภาพย่อยังอยู่ใน DOM (ไม่ได้ลบ)', asList?.thumbDisplay !== 'ไม่มี td')
await shot('02-list.png')

console.log('\n[2] จำค่าข้ามหน้า')
await send('Page.navigate', { url: `${WEB}/studio?_=${STAMP}` })
check('เปิดหน้าใหม่แล้วแถวมา', !!(await waitFor(`!!document.querySelector('.tpllist tbody tr')`, 45000)))
const afterReload = await evaluate(`!!document.querySelector('.tpllist').classList.contains('tpllist--grid')`)
check('ยังเป็นมุมมีรายการหลังเปิดหน้าใหม่', afterReload === false)

const backGrid = await clickTestId('view-grid')
check('กดกลับเป็นชิดได้', !!backGrid?.ok, backGrid?.why ?? '')
check('กลับเป็นชิดแล้ว', await waitFor(`!!document.querySelector('.tpllist').classList.contains('tpllist--grid')`, 10000))

console.log('\n[3] คอลัมน์ภาพย่ออยู่ท้ายสุด (กันป้าย data-label เพี้ยน)')
const order = await evaluate(`(() => {
  const tr = document.querySelector('.tpllist tbody tr')
  return [...tr.querySelectorAll('td')].map((td) => td.className || '(ไม่มี class)')
})()`)
check('ภาพย่อเป็น td ตัวสุดท้าย', String(order?.[order.length - 1]).includes('tplrow__thumb'), JSON.stringify(order))
check('มี 6 คอลัมน์ (เดิม 5 + ภาพย่อ)', order?.length === 6, `${order?.length} คอลัมน์`)

console.log('\n[4] ปุ่มจัดการยังอยู่ครบในโหมดชิด')
const acts = await evaluate(`(() => {
  const cell = document.querySelector('.tpllist tbody tr .tplrow__acts')
  if (!cell) return null
  return {
    n: cell.querySelectorAll('button').length,
    last: [...cell.querySelectorAll('button')].map((b) => b.textContent.trim()).slice(-1)[0],
  }
})()`)
check('มีปุ่มจัดการในโหมดชิด', (acts?.n ?? 0) >= 3, JSON.stringify(acts))
check('ปุ่มสุดท้ายคือ ลบ หรือ สำเนา', ['ลบ', 'สำเนา'].includes(acts?.last), String(acts?.last))

await redis.del(`session:${SID}`)
redis.disconnect()
console.log(`\n── ผ่าน ${pass} · ไม่ผ่าน ${fail} ─────────────────────`)
await send('Browser.close').catch(() => {})
chrome.kill()
ws.close()
process.exit(fail === 0 ? 0 : 1)
