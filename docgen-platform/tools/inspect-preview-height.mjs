/**
 * วัดความสูงจริงของการ์ดพรีวิว ณ ตอนยังไม่เลื่อน / เลื่อนจนคอลัมน์ sticky เกาะ
 *
 *   node --env-file=.env tools/inspect-preview-height.mjs
 *
 * ── ทำไมต้องมีเครื่องมือนี้ ───────────────────────────────────────
 * การ์ดพรีวิวสูงได้ไม่เกิน `100vh - var(--editor-top) - 8px`
 * และ `--editor-top` ต้องมาจาก JavaScript ที่วัดตำแหน่งคอลัมน์จริง
 *
 * ⚠️ **CSS ตัวแปรที่ JavaScript ไม่ได้ตั้ง จะกลายเป็น fallback เงียบ ๆ**
 *   เคยเจอ: effect ถูกเรียกตอน mount ตอนที่ `.editor-split` ยังไม่อยู่ใน DOM
 *   → `if (!el) return` → ไม่มีวันรันซ้ำ → `--editor-top` ไม่เคยถูกตั้ง
 *   → การ์ดใช้ fallback `160px` มาตลอด แล้วดูเหมือน "CSS พัง" ทั้งที่ไม่ได้พัง
 *
 *   เทสต์ (`test-fit-page.mjs`) บอกได้แค่ว่าผ่าน/ไม่ผ่าน
 *   เครื่องมือนี้พิมพ์ค่าจริงทุกตัว เพื่อดูว่าตัวไหนผิด
 *
 * ตัวอย่างผลที่ถูกต้อง:
 *   ก่อนเลื่อน = { inlineTop: "87px", colH: 905, docpageH: 588 }
 *   หลังเลื่อน = { inlineTop: "87px", colH: 905, docpageH: 588 }   ← เท่ากัน
 *   → ความสูงไม่เปลี่ยนตอนเลื่อน คอลัมน์ `sticky` จึงยังเกาะและแท็บไม่หลุด
 *   (เคยให้โตขึ้นตอนเกาะ แล้วคอลัมน์กินระยะเลื่อนตัวเอง → แท็บหาย 28px)
 */
import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
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

const redis = new Redis(process.env.VALKEY_URL)
const sid = `dbgtop-${Date.now()}`
await redis.set(`session:${sid}`, JSON.stringify({ sub: sid, name: 'วัด top', email: 'dbgtop@test.local', avatar: '' }), 'EX', 1800)
const H = { cookie: `docgen_session=${sid}`, 'content-type': 'application/json' }
const tpl = await pickTemplate(H, [TEST_TEMPLATES.onepage])
const seedKey = keyOf(tpl)
const snap = await snapshotForm(H, seedKey)
await importTags(H, tpl)

const profile = mkdtempSync(join(tmpdir(), 'cdp-dbgtop-'))
const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run', '--window-size=1600,1000', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' })
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
await send('Page.enable')
await send('Runtime.enable')
await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false })
await send('Network.setCookie', { name: 'docgen_session', value: sid, url: WEB })
await send('Network.setCacheDisabled', { cacheDisabled: true })
await send('Page.navigate', { url: `${WEB}/studio` })
await waitFor("!document.querySelector('.bootveil')", 60000)
await waitFor("document.querySelectorAll('table tbody tr').length > 0", 45000)
await click(`[...document.querySelectorAll('table tbody tr')].find(tr => (tr.textContent||'').includes(${JSON.stringify(tpl.name)}))?.querySelector('button.ghost')`)
await waitFor("[...document.querySelectorAll('.tabs__tab')].length >= 6", 25000)
await sleep(600)
await evaluate(FILL_FIELDS_JS)
await sleep(500)
await click(`[...document.querySelectorAll('button')].find(b => b.textContent.includes('เรนเดอร์ตัวอย่าง'))`)
const ok = await waitFor("(() => { const c = document.querySelector('.docstage__page canvas'); return !!c && c.height > 200 })()", 120000)
console.log('rendered =', ok)

const probe = () => evaluate(`(() => {
  const split = document.querySelector('.editor-split')
  const col = document.querySelector('.editor-col--preview')
  const doc = document.querySelector('.docpage')
  return {
    scrollY: Math.round(scrollY),
    docH: Math.round(document.body.scrollHeight),
    splitTop: Math.round(split?.getBoundingClientRect().top ?? NaN),
    inlineTop: split?.style.getPropertyValue('--editor-top') ?? '(ไม่มี inline)',
    computedTop: col ? getComputedStyle(col).getPropertyValue('--editor-top').trim() : '?',
    colH: Math.round(col?.getBoundingClientRect().height ?? NaN),
    colPos: col ? getComputedStyle(col).position : '?',
    docpageH: Math.round(doc?.clientHeight ?? NaN),
  }
})()`)
console.log('ก่อนเลื่อน =', JSON.stringify(await probe()))
await evaluate('scrollTo(0, document.body.scrollHeight)')
await sleep(1200)
console.log('หลังเลื่อน =', JSON.stringify(await probe()))
await evaluate('scrollTo(0, 600)')
await sleep(1200)
console.log('เลื่อน 600 =', JSON.stringify(await probe()))

await restoreForm(H, seedKey, snap)
await fetch(`${API}/api/access/${seedKey}`, { method: 'DELETE', headers: H }).catch(() => {})
await send('Browser.close').catch(() => {})
chrome.kill()
await redis.del(`session:${sid}`)
redis.disconnect()
process.exit(0)
