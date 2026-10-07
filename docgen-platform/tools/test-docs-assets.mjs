/**
 * หน้า /apis ต้องโหลด Swagger UI ได้จริง ไม่ใช่แค่ HTML ตอบ 200
 *
 *   node --env-file=../dokploy-infra/.env --env-file=../dokploy-infra/.env.development tools/test-docs-assets.mjs
 *
 * ── ทำไมต้องตรวจ "แสดงผล" ไม่ใช่แค่ status ───────────────────────────
 *   ผู้ใช้เจอ: เปิด localhost:3000/apis แล้วเห็น error 404 หลายบรรทัด
 *   ต้นเหตุ: rewrite ใน `next.config.mjs` match แค่ `/apis`
 *   แต่หน้า Swagger UI ดึงอีก 7 ไฟล์จาก `/apis/static/…`
 *   → HTML ได้ 200 ส่วนไฟล์ชั้นในได้ 404 ทั้งหมด
 *   ถ้าเทสต์เช็กแค่ "GET /apis ได้ 200" ก็ผ่านทั้งที่หน้าเสีย
 *   ตรงนี้คือ reverse proxy ที่พังง่ายที่สุด: ได้ 200 แต่ได้หน้าที่ใช้ไม่ได้
 *
 *   เกณฑ์จึงเป็นสามชั้น:
 *     1 · ไม่มี request ไหนได้ 4xx/5xx เลยตอนเปิดหน้า
 *     2 · Swagger UI ต้องวาดตัวเอง (`#swagger-ui` มีลูก)
 *     3 · ต้องเห็นรายการ endpoint จริงจาก openapi.json
 *        (พิสูจน์ว่า JS ทำงานและดึงสเปกมาได้ ไม่ใช่แค่ CSS โหลดแล้ว)
 */
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CHROME = process.env.CHROME_PATH ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const PORT = 9481
const STAMP = Date.now()
const OUT = 'D:/2docx.com/docgen-platform/tests/nav-status/output-docs/'
mkdirSync(OUT, { recursive: true })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let pass = 0
let fail = 0
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'}${name}${detail ? ` — ${detail}` : ''}`)
  ok ? pass++ : fail++
}

/**
 * จุดที่ต้องผ่าน
 * ⚠️ ทดสอบทั้งสองทางเข้า เพราะเป็นคนละชั้นของ reverse proxy
 *   · :3000 ผ่าน rewrite ของ Next
 *   · :8090 ผ่าน matcher ของ Caddy
 *   การแก้แค่ชั้นเดียวแล้วอีกชั้นยังพังอยู่ = เทสต์ผ่านแต่ผู้ใช้ยังเจอปัญหา
 */
const TARGETS = [
  { name: 'next-dev', base: 'http://localhost:3000' },
  { name: 'gateway', base: 'http://127.0.0.1:8090' },
]

const profile = mkdtempSync(join(tmpdir(), 'cdp-docs-'))
const chrome = spawn(
  CHROME,
  ['--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run', '--window-size=1440,1000',
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
/** เก็บทุก response ที่โหลดตอนเปิดหน้า เพื่อหา 4xx/5xx */
const responses = []
/**
 * เก็บข้อความจาก console ของเบราว์เซอร์
 * ⚠️ ต้องเก็บเพราะการละเมิด CSP **ไม่ทำให้ request ล้มเหลว**
 *   มันแค่บล็อกการทำงานของ JS ส่วนหนึ่ง → ไม่มี 4xx/5xx ให้เห็น
 *   และหน้ายังโหลด "สำเร็จ" ตามที่เกณฑ์เดิมวัด
 *   เจอแล้วตอนผู้ใช้รายงาน: ทุกเกณฑ์ผ่านหมด แต่หน้าขาวและ console เต็ม error
 */
const securityLog = []

const send = (m, p = {}) =>
  new Promise((resolve, reject) => {
    const id = ++seq
    const t = setTimeout(() => { waiting.delete(id); reject(new Error(`timeout: ${m}`)) }, 30000)
    waiting.set(id, { resolve: (v) => { clearTimeout(t); resolve(v) }, reject: (e) => { clearTimeout(t); reject(e) } })
    ws.send(JSON.stringify({ id, method: m, params: p }))
  })
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data)
  if (m.method === 'Network.responseReceived') {
    responses.push({ url: m.params.response.url, status: m.params.response.status })
    return
  }
  // Chrome รายงานการละเมิด CSP ผ่าน Log domain ด้วย source = "security"
  if (m.method === 'Log.entryAdded') {
    const e = m.params.entry
    if (e.source === 'security' || /Content Security Policy/i.test(e.text ?? '')) {
      securityLog.push({ level: e.level, source: e.source, text: e.text })
    }
    return
  }
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
    const text = (m.params.args ?? []).map((a) => a.value ?? a.description ?? '').join(' ')
    if (/Content Security Policy|violates the following/i.test(text)) {
      securityLog.push({ level: 'error', source: 'console', text })
    }
    return
  }
  const s = waiting.get(m.id)
  if (!s) return
  waiting.delete(m.id)
  m.error ? s.reject(new Error(JSON.stringify(m.error))) : s.resolve(m.result)
})
await new Promise((r) => ws.addEventListener('open', r))
await send('Page.enable')
await send('Runtime.enable')
await send('Log.enable')
await send('Network.enable')
await send('Network.setCacheDisabled', { cacheDisabled: true })

const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text ?? 'evaluate พัง')
  return r.result?.value
}
const waitFor = async (expr, ms = 30000) => {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    try {
      if (await evaluate(`!!(${expr})`)) return true
    } catch { /* ระหว่าง navigate */ }
    await sleep(400)
  }
  return false
}

for (const t of TARGETS) {
  console.log(`\n── ${t.name} (${t.base}) ────────────────────────────────\n`)
  responses.length = 0
  securityLog.length = 0

  // อุ่น: Next dev คอมไพล์ route ครั้งแรกช้า
  await send('Page.navigate', { url: `${t.base}/apis` })
  await waitFor(`document.querySelector('#swagger-ui')`, 90000)
  await sleep(1500)

  /**
   * ⚠️ ห้ามใส่ query string ที่ /apis เด็ดขาด
   *   `swagger-initializer.js` คำนวณ URL สเปกด้วย `resolveUrl('./json')`
   *   ซึ่งเอา `location.href` มาเติม `/` ท้าย ๆ แล้วต่อ `json`
   *   → ถ้า URL มี `?_=…` ผลจะเป็น `/apis?_=…/json` แล้วไปโดนหน้า HTML แทน JSON
   *   → Swagger ขึ้น "does not specify a valid version field"
   *   ใช้ `Network.setCacheDisabled` ที่เปิดไว้แทน ซึ่งถูกต้องกว่าเอาส่วนนี้มาแก้โค้ดผลิตภัณฑ์
   */
  await send('Page.navigate', { url: `${t.base}/apis` })

  // รอจน Swagger วาดรายการ endpoint จริงเสร็จ
  const rendered = await waitFor(
    `(document.querySelectorAll('#swagger-ui .opblock').length ?? 0) > 0 || document.querySelector('#swagger-ui .information-container') !== null`,
    45000,
  )
  await sleep(2500)

  // ── ชั้น 1 · ไม่มี 4xx/5xx ตอนเปิดหน้า ─────────────────────────────
  const bad = responses.filter((r) => r.status >= 400)
  check('ไม่มีไฟล์ที่โหลดไม่ขึ้น (4xx/5xx)', bad.length === 0, bad.length ? bad.map((b) => `${b.status} ${b.url}`).join(' · ') : `${responses.length} คำขอ`)

  // ── ชั้น 2 · ตัว UI วาดจริง ───────────────────────────────────────
  const shell = await evaluate(`(() => {
    const root = document.querySelector('#swagger-ui')
    if (!root) return { miss: true }
    const cs = getComputedStyle(root)
    return {
      children: root.children.length,
      display: cs.display,
      empty: (root.textContent || '').trim().length,
    }
  })()`)
  check('Swagger UI วาดตัวเองขึ้นมา', shell?.miss !== true && (shell?.children ?? 0) > 0, shell?.miss ? 'ไม่เจอ #swagger-ui' : `${shell.children} ลูก · ${shell.display}`)

  // ── ชั้น 3 · เห็น endpoint จริงจากสเปก ────────────────────────────
  const content = await evaluate(`(() => {
    const ops = [...document.querySelectorAll('#swagger-ui .opblock')]
    const tags = [...document.querySelectorAll('#swagger-ui .opblock-tag')]
    return {
      ops: ops.length,
      tags: tags.length,
      /**
       * ⚠️ ต้องอ่านจากข้อความใน .opblock-summary-method
       *   ไม่ใช่ attribute data-is — รุ่น Swagger ที่ใช้อยู่ไม่มี attribute นั้น
       *   (ใส่ครั้งแรกแล้วได้ค่าว่างทั้งหมด เกณฑ์ตกทั้งที่หน้าอยู่ในสภาพปกติ)
       *
       * ⚠️ ห้ามใส่ backtick ในบล็อกนี้ — ทั้ง evaluate ถูกส่งไปรันในเบราว์เซอร์
       *   backtick จะตัด template literal ของ Node ทิ้งจนไฟล์พังตอน parse
       */
      methods: [...new Set(ops.map((o) => (o.querySelector('.opblock-summary-method')?.textContent || '').trim()).filter(Boolean))].sort(),
      firstOps: ops.slice(0, 4).map((o) => (o.querySelector('.opblock-summary-path')?.textContent || '').trim()),
      /** คำอธิบายไทยต้องแสดงด้วย ไม่ใช่แค่ path อย่างเดียว */
      summaries: ops.filter((o) => (o.querySelector('.opblock-summary-description')?.textContent || '').trim().length > 0).length,
    }
  })()`)
  check('เห็นรายการ endpoint จาก openapi.json', (content?.ops ?? 0) > 0, `${content?.ops ?? 0} รายการ · ${content?.tags ?? 0} กลุ่ม`)
  check('เห็นชื่อกลุ่ม API', (content?.tags ?? 0) > 0, (content?.tags ?? 0) + ' กลุ่ม')
  check('เห็นเมธอดของ endpoint', (content?.methods ?? []).length > 0, (content?.methods ?? []).join(' '))
  check('ชื่อ path อ่านออก', (content?.firstOps ?? []).some((p) => p.length > 0), (content?.firstOps ?? []).slice(0, 3).join(' · '))
  check('endpoint มีคำอธิบาย (ไม่ใช่แค่ path เปล่า)', (content?.summaries ?? 0) > 0, `${content?.summaries ?? 0}/${content?.ops ?? 0} รายการมีคำอธิบาย`)

  // ── ไฟล์ชั้นในต้องโหลดได้จริง (ไม่ใช่แค่ไม่มี error) ──────────
  const assets = responses.filter((r) => r.url.includes('/apis/static/'))
  check('ไฟล์ชั้นในของ Swagger โหลดครบ (css/js/favicon)', assets.length >= 7, `${assets.length} ไฟล์จาก /apis/static/`)
  const cssOk = assets.some((r) => r.url.endsWith('swagger-ui.css') && r.status === 200)
  const jsOk = assets.some((r) => r.url.includes('swagger-ui-bundle.js') && r.status === 200)
  check('ไฟล์ CSS และ JS ตัวหลักโหลดได้', cssOk && jsOk, `css=${cssOk} js=${jsOk}`)

  // ── สเปกต้องเป็น JSON จริง ไม่ใช่ HTML ───────────────────────────
  /**
   * ⚠️ เกณฑ์นี้จับกรณีที่เจอตอนรันรอบแรก
   *   Swagger ได้ HTML แทน JSON แล้วขึ้น "does not specify a valid version field"
   *   ซึ่งดูเหมือน "สเปกผิด" แต่จริง ๆ คือ **โหลด URL ผิด**
   *   → ถ้าดูแค่ข้อความ error จะไปแก้ที่ openapi.json ซึ่งไม่ได้เป็นต้นเหตุ
   */
  const specUrl = await evaluate(`(() => {
    const el = document.querySelector('#swagger-ui input[type=text], .topbar .download-url-wrapper input')
    return el ? el.value : null
  })()`)
  console.log(`  (สเปกที่ Swagger โหลด: ${specUrl ?? 'ไม่เจอช่อง URL'})`)
  const specResp = responses.find((r) => r.url.includes('/json'))
  check('Swagger โหลดสเปกจาก URL ที่ถูกต้อง (ลงท้ายด้วย /json)', /\/json$/.test(specUrl ?? ''), specUrl ?? '—')
  check('สเปกตอบเป็น JSON ไม่ใช่ HTML', specResp?.status === 200, specResp ? `${specResp.status} · ${specResp.url.split('?')[0]}` : 'ไม่เห็นคำขอสเปก')

  // ── ชั้น 4 · CSP ต้องไม่บล็อกหน้าตัวเอง ───────────────────────────
  /**
   * ⚠️ บั๊กนี้**ไม่ทำให้เกณฑ์ข้างบนตกเลย** เพราะไม่มี request ไหนล้มเหลว
   *   หน้ายังโหลดได้ ยังเห็น 72 endpoint แต่สไตล์ถูกบล็อกทิ้งเงียบ ๆ
   *   ผู้ใช้เจอเป็น console เต็ม error และหน้าดูเพี้ยน
   *   → ต้องมีเกณฑ์จับเอง ไม่งั้นจะผ่านทั้งที่พัง
   */
  check('ไม่มีการละเมิด CSP ตอนเปิดหน้า', securityLog.length === 0, securityLog.length ? securityLog.slice(0, 2).map((s) => s.text.slice(0, 110)).join(' | ') : 'console สะอาด')

  // ตรวจ header จริงด้วย fetch — ยืนยันว่าผ่อนแค่ style-src และที่อื่นยังเข้ม
  const csp = await fetch(`${t.base}/apis`, { redirect: 'manual' }).then((r) => r.headers.get('content-security-policy') ?? '')
  const styleSrc = (csp.match(/style-src([^;]*)/)?.[1] ?? '').trim()
  check('CSP ให้ inline style ได้ (Swagger inject style ตอนรัน)', styleSrc.includes("'unsafe-inline'"), styleSrc || 'ไม่มี directive style-src')
  check('CSP ยังบังคับ script-src เข้มอยู่', /script-src\s+'self'\s*(;|$)/.test(csp) && !/script-src[^;]*unsafe-inline/.test(csp), (csp.match(/script-src[^;]*/)?.[0] ?? 'ไม่มี').trim())
  check('CSP ยังบังคับ object-src เป็น none', /object-src\s+'none'/.test(csp), (csp.match(/object-src[^;]*/)?.[0] ?? 'ไม่มี').trim())
  check('CSP ยังบังคับ frame-ancestors เข้มอยู่', /frame-ancestors\s+'self'/.test(csp), (csp.match(/frame-ancestors[^;]*/)?.[0] ?? 'ไม่มี').trim())

  const { data } = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(join(OUT, `${t.name}.png`), Buffer.from(data, 'base64'))

  if (!rendered) console.log('  (หมายเหตุ: รอการวาดจนหมดเวลา แต่เกณฑ์ด้านบนยังตรวจเนื้อหาอีกครั้ง)')
}

console.log(`\n── ผ่าน ${pass} · ไม่ผ่าน ${fail} ─────────────────────\n`)
console.log(`ภาพ: ${OUT}`)

await send('Browser.close').catch(() => undefined)
chrome.kill()
ws.close()
process.exit(fail ? 1 : 0)
