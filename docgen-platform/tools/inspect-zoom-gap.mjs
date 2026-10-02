/**
 * วัดระยะห่างจริงในแถบซูม (ระหว่างแว่นขยายกับเปอร์เซ็นต์)
 *
 *   node --env-file=.env tools/inspect-zoom-gap.mjs
 *
 * ── ทำไมต้องมีเครื่องมือนี้ ───────────────────────────────────────
 * ผู้ใช้ทำเครื่องหมายที่ "71%" แล้วบอกว่า
 *   "มี padding ทำให้เครื่องหมายแว่นขยายชิดกว่านี้"
 *
 * "ชิด" เป็นคำที่วัดด้วยตัวเลขได้ แต่**ต้องวัดกล่องหมึก** ไม่ใช่กล่องกรอบ
 *   เพราะปุ่มซูมกว้าง 36px แต่ตัวไอคอนกว้าง 17px → ขอบปุ่มกับหัวตัวอักษรห่างกันมาก
 *   ถ้าวัดที่ขอบปุ่มจะได้ตัวเลขปลอมทั้งปลอม
 *
 * เครื่องมือนี้พิมพ์ทั้ง 3 ชั้น (ซ้าย → ขวา):
 *   [ขอบปุ่ม] gap [ซ้ายของ span] เว้นว่างใน span [หัวตัวอักษร] ...71%...
 * พร้อมภาพตัดเฉพาะแถบซูม เพื่อดูด้วยตาว่าตัวเลขตรงกับภาพไหม
 */
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Redis } from 'ioredis'
import { canvasDrawnJs } from './lib/canvas-drawn.mjs'
import { keyOf, pickTemplate, TEST_TEMPLATES } from './lib/pick-template.mjs'
import { FILL_FIELDS_JS, importTags, restoreForm, snapshotForm } from './lib/studio-seed.mjs'

const CHROME = process.env.CHROME_PATH ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const PORT = 9374
const WEB = 'http://localhost:3000'
const WIDTH = Number(process.argv[2] ?? 1600)
const HEIGHT = Number(process.argv[3] ?? 1000)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
mkdirSync(join(process.cwd(), 'logs'), { recursive: true })

const redis = new Redis(process.env.VALKEY_URL)
const sid = `zoomgap-${Date.now()}`
await redis.set(
  `session:${sid}`,
  JSON.stringify({ sub: sid, name: 'วัดระยะซูม', email: 'zoomgap@test.local', avatar: '' }),
  'EX',
  1800,
)
const H = { cookie: `docgen_session=${sid}`, 'content-type': 'application/json' }

const picked = await pickTemplate(H, [TEST_TEMPLATES.multipage, 'สำเนา 1', 'อำเภอเนินมะปราง'])
const key = keyOf(picked)
console.log(`แม่แบบ: ${picked.name} (key ${key}) · จอ ${WIDTH}×${HEIGHT}`)

/**
 * ⚠️ `importTags` เขียนทับแท็กของแม่แบบจริง — ต้อง snapshot ค่าเดิมไว้ก่อน
 *    แล้ว restore ตอนจบทุกครั้ง ไม่งั้นผู้ใช้จะเจอช่องกรอกเปลี่ยนไปเงียบ ๆ
 */
const formSnap = await snapshotForm(H, key)
const seed = await importTags(H, picked)
console.log(`เตรียมช่องกรอก — ${seed.ok ? 'สำเร็จ' : 'ล้มเหลว ' + seed.status}`)

const profile = mkdtempSync(join(tmpdir(), 'cdp-zoomgap-'))
const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--no-first-run',
    `--window-size=${WIDTH},${HEIGHT}`,
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
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
    wsUrl = list.find((x) => x.type === 'page')?.webSocketDebuggerUrl
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
const waitFor = async (expr, ms = 60000) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    try {
      if (await evaluate(expr)) return true
    } catch {}
    await sleep(300)
  }
  return false
}

await send('Page.enable')
await send('Runtime.enable')
await send('Emulation.setDeviceMetricsOverride', {
  width: WIDTH,
  height: HEIGHT,
  deviceScaleFactor: 1,
  mobile: false,
})
await send('Network.setCookie', { name: 'docgen_session', value: sid, url: WEB })
await send('Network.setCacheDisabled', { cacheDisabled: true })
await send('Page.navigate', { url: `${WEB}/studio/${key}?tabs=form&pane=preview` })
await waitFor("!!document.querySelector('.dl__btn')", 45000)
await sleep(600)
/**
 * ⚠️ ต้อง**กรอกฟอร์มให้ครบ**ก่อนกดเรนเดอร์ — แอปบล็อกเมื่อช่องบังคับยังว่าง
 *    แม่แบบ `ทดสอบหัวกระดาษ` มีช่องบังคับ "เรื่อง" ค้างอยู่ 1 ช่อง
 *    ถ้าไม่กรอก จะไม่มี canvas ให้วัด แล้วเทสต์ตกตั้งแต่ข้อแรก
 */
const filled = await evaluate(FILL_FIELDS_JS)
console.log(`  กรอกข้อมูล ${filled} ช่อง`)
await sleep(400)
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
  /**
   * ⚠️ เช็คจากพิกเซลจริงที่ pdf.js ตั้ง ไม่ใช่ความกว้างที่เห็น
   *    `<canvas>` ที่ยังไม่เคยวาดมีค่าเริ่มต้น 300×150
   *    และกระดาษตอนนี้ถูกย่อให้พอดีกล่อง → `width > 400` ผ่านไม่ได้แม้วาดเสร็จแล้ว
   *    (เคยทำให้สคริปต์นี้ตกทั้งชุด) เกณฑ์จริงอยู่ที่ `tools/lib/canvas-drawn.mjs`
   */
  canvasDrawnJs(),
  120000,
)
if (!rendered) console.log('  ✗ เรนเดอร์ไม่สำเร็จ — วัดต่อไม่ได้ (มักเป็นคิว NATS ค้าง ไม่ใช่โค้ดพัง)')

/**
 * วัด 3 ชั้นความกว้างระหว่างไอคอนแว่นขยาย (ซ้าย) กับหัวตัวอักษรเปอร์เซ็นต์
 *
 * ⚠️ ใช้ `Range` ของ text node เพื่อหา**กล่องหมึก** ของตัวอักษร
 *    `getBoundingClientRect()` ของ span จะกว้างเต็ม min-width (52px) เสมอ
 *    ถ้าใช้ค่านั้นจะได้ช่องว่างปลอมข้างข้างตัวเลข ไม่ใช่ระยะจริง
 */
const probe = () =>
  evaluate(`(() => {
  /**
   * ⚠️ ห้ามเลือกด้วย aria-label ภาษาไทย
   *    เคยล้มเหลวเพราะสระ/วรรณยุกต์ไทยในไฟล์นี้กับใน DocumentPreview.tsx
   *    ไม่ใช่ byte เดียวกัน → querySelector ไม่เจอ
   *    คลาส zoombtn มีแค่ 2 จุดในทั้งโปรเจกต์ = ปุ่มซูมออก/ซูมเข้า พอดี
   */
  const btns = document.querySelectorAll('button.zoombtn')
  if (btns.length < 2) return { error: 'ไม่พบปุ่มซูม (เจอ ' + btns.length + ')' }
  const out = btns[0]
  const inn = btns[1]
  const span = out.parentElement.querySelector('span.mono')
  if (!span) return { error: 'ไม่พบเปอร์เซ็นต์' }

  // กล่องหมึกของไอคอน = ตัว svg เอง (ไม่ใช่กล่องปุ่ม 36px)
  const iconOut = out.querySelector('svg').getBoundingClientRect()
  const iconIn = inn.querySelector('svg').getBoundingClientRect()
  // กล่องหมึกของตัวเลข = Range ครอบ text node
  const node = span.firstChild
  const range = document.createRange()
  range.selectNodeContents(span)
  const ink = range.getBoundingClientRect()

  const spanBox = span.getBoundingClientRect()
  const btnBox = out.getBoundingClientRect()
  const rowStyle = getComputedStyle(out.parentElement)
  return {
    value: span.textContent.trim(),
    rowGap: rowStyle.gap,
    spanMinWidth: getComputedStyle(span).minWidth,
    spanPadL: +(ink.left - spanBox.left).toFixed(1),
    spanPadR: +(spanBox.right - ink.right).toFixed(1),
    btnToSpan: +(spanBox.left - btnBox.right).toFixed(1),
    iconToInk: +(ink.left - iconOut.right).toFixed(1),
    iconW: +iconOut.width.toFixed(1),
    inkW: +ink.width.toFixed(1),
    /** ระยะเดียวกันฝั่งขวา เพื่อเทียบว่าสมมาตรหรือไม่ */
    iconInToInkR: +(ink.right - iconIn.left).toFixed(1),
    barW: +out.parentElement.getBoundingClientRect().width.toFixed(1),
  }
})()`)

const p = await probe()
console.log('\n=== แถบซูม ===')
if (p.error) {
  console.log('  ผิดพลาด:', p.error)
  /**
   * พิมพ์สิ่งที่อยู่จริงในหน้า ไม่งั้นเดาว่าทำไม
   * เคยเจอ: `.doctools` มีอยู่แต่ว่างเปล่า เพราะการ์ดพรีวิวยังไม่ได้ mount
   */
  const diag = await evaluate(`(() => {
    const t = document.querySelector('.doctools')
    const all = [...document.querySelectorAll('button')].map((b) => ({
      cls: b.className, t: (b.getAttribute('aria-label') || b.textContent || '').trim().slice(0, 18),
    }))
    return {
      hasTools: !!t,
      toolsChildren: t ? t.children.length : -1,
      toolsHTML: t ? t.innerHTML.slice(0, 400) : '',
      docpage: !!document.querySelector('.docpage'),
      canvas: !!document.querySelector('canvas'),
      bodySnippet: document.body.innerText.replace(/\\s+/g, ' ').slice(0, 200),
      buttons: all.slice(0, 12),
    }
  })()`)
  console.log('  -- สิ่งที่เจอในหน้า --')
  console.log('  มี .doctools      :', diag.hasTools, '· ลูก', diag.toolsChildren)
  console.log('  มี .docpage       :', diag.docpage, '· มี canvas:', diag.canvas)
  console.log('  ปุ่มทั้งหมดในหน้า :', JSON.stringify(diag.buttons))
  console.log('  ข้อความบนหน้า    :', diag.bodySnippet)
  console.log('  doctools.innerHTML:', diag.toolsHTML)
} else {
  console.log(`  ค่าในแถบ          : ${p.value}`)
  console.log(`  gap ของแถว         : ${p.rowGap}`)
  console.log(`  min-width ของเปอร์เซ็นต์ : ${p.spanMinWidth}`)
  console.log(`  ความกว้างไอคอน      : ${p.iconW}px  ·  ความกว้างตัวเลข ${p.inkW}px`)
  console.log(`  ช่องว่างใน span    : ซ้าย ${p.spanPadL}px · ขวา ${p.spanPadR}px`)
  console.log(`  ขอบปุ่ม → ซ้าย span : ${p.btnToSpan}px`)
  console.log(`  ★ หัวตัวอักษร → ไอคอนแว่นขยาย : ${p.iconToInk}px (ฝั่งซ้าย) · ${p.iconInToInkR}px (ฝั่งขวา)`)
}

/** ภาพตัดเฉพาะแถบซูม ขยาย 3 เท่าให้เห็นช่องว่างชัด */
const clip = p.error
  ? null
  : await evaluate(`(() => {
  const el = document.querySelectorAll('button.zoombtn')[0].closest('.doctools')
  if (!el) return null
  const r = el.getBoundingClientRect()
  return { x: r.x, y: r.y, width: r.width, height: r.height }
})()`)
if (clip) {
  const { data } = await send('Page.captureScreenshot', {
    format: 'png',
    /**
     * ⚠️ ต้องเปิด `captureBeyondViewport` ไม่งั้นจอสั้น (เช่น 579×539) จะได้ภาพเปล่า
     *    เพราะแถบเครื่องมือพรีวิวอยู่**ใต้ขอบจอ** ไม่ใช่ใน viewport
     */
    captureBeyondViewport: true,
    clip: { x: clip.x - 6, y: clip.y - 6, width: clip.width + 12, height: clip.height + 12, scale: 3 },
  })
  const file = join(process.cwd(), 'logs', 'zoomgap.png')
  writeFileSync(file, Buffer.from(data, 'base64'))
  console.log('  ภาพ (ขยาย 3 เท่า):', file)
}

await send('Browser.close').catch(() => {})
chrome.kill()
await restoreForm(H, key, formSnap)
await redis.del(`session:${sid}`)
redis.disconnect()
process.exit(0)
