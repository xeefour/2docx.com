/**
 * ทดสอบการพรีวิวด้วย pdf.js ในเบราว์เซอร์จริง ผ่าน Chrome DevTools Protocol
 *
 * ทำไมต้องใช้ CDP แทน `chrome --headless --dump-dom`
 *   `--virtual-time-budget` เร่งเวลาแบบปลอม ซึ่งไม่ดันงานที่ pdf.js worker
 *   ทำอยู่อีกเธรด → ค้างที่ `getDocument()` ไม่ว่าจะรอนานแค่ไหน
 *   CDP ต่อกับเบราว์เซอร์จริง จึงเป็นวิธีเดียวที่วัด "มันทำงานจริงไหม" ได้
 *
 *   node --env-file=.env tools/test-preview-browser.mjs
 */
import { spawn } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Redis } from 'ioredis'

const CHROME = process.env.CHROME_PATH ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const PORT = 9333
const WEB = 'http://localhost:3000'
const API = 'http://127.0.0.1:4001'

/**
 * หน้าทดสอบที่ Next จะเสิร์ฟ
 *
 * ⚠️ ต้องอยู่ใน `public/` เพราะ pdf.js เป็น ESM ที่ต้องโหลดจาก URL
 *    (นำเข้าผ่าน `import()` ในเบราว์เซอร์ ซึ่งแก้ bare specifier ไม่ได้)
 *    → เขียนตอนรันแล้วลบทิ้ง เพื่อไม่ให้หน้าทดสอบหลุดขึ้น production
 */
/** path ที่ Next เสิร์ฟ (อยู่ใต้ public/) */
const FIXTURE_HTML = '__pdftest.html'
const FIXTURE_PDFJS = 'public/__pdfjs'

const PAGE = `<!doctype html>
<html lang="th"><head><meta charset="utf-8"><title>pdf.js test</title></head>
<body style="font-family:monospace;white-space:pre-wrap;padding:16px">
<pre id="out">กำลังทดสอบ…</pre><div id="strip"></div>
<script type="module">
const q = new URLSearchParams(location.search)
const out = document.getElementById('out')
const log = []
const say = (s) => { log.push(s); out.textContent = log.join('\\n') }
try {
  document.cookie = 'docgen_session=' + q.get('sid') + '; path=/'
  say('cookie: ' + document.cookie)

  const res = await fetch('/api/documents/' + q.get('doc') + '/file', { credentials: 'same-origin' })
  say('GET /file → ' + res.status + ' ' + res.headers.get('content-type'))
  if (!res.ok) throw new Error('ดึงไฟล์ไม่สำเร็จ')
  const buf = await res.arrayBuffer()
  say('ไฟล์ ' + buf.byteLength + ' bytes · magic "' + new TextDecoder().decode(new Uint8Array(buf.slice(0,5))) + '"')

  const pdfjs = await import('/__pdfjs/pdf.min.mjs')
  pdfjs.GlobalWorkerOptions.workerSrc = '/__pdfjs/pdf.worker.min.mjs'
  say('โหลด pdf.js สำเร็จ')

  const d = await pdfjs.getDocument({ data: new Uint8Array(buf) }).promise
  say('เปิดเอกสารได้ · ' + d.numPages + ' หน้า')

  for (let n = 1; n <= d.numPages; n++) {
    const page = await d.getPage(n)
    const vp = page.getViewport({ scale: 1 })
    const c = document.createElement('canvas')
    c.style.width = '104px'
    // ⚠️ pdf.js ไม่ขยาย canvas ให้เอง ต้องกำหนดขนาดเองเสมอ
    c.width = Math.floor(vp.width); c.height = Math.floor(vp.height)
    document.getElementById('strip').appendChild(c)
    await page.render({ canvas: c, canvasContext: c.getContext('2d'), viewport: vp }).promise
    say('  วาดหน้า ' + n + ': canvas ' + c.width + '×' + c.height)
  }

  const p1 = await d.getPage(1)
  const vp2 = p1.getViewport({ scale: 2 })
  const c2 = document.createElement('canvas')
  c2.width = Math.floor(vp2.width); c2.height = Math.floor(vp2.height)
  await p1.render({ canvas: c2, canvasContext: c2.getContext('2d'), viewport: vp2 }).promise
  const blob = await new Promise((r) => c2.toBlob(r, 'image/png'))
  say('ตัด PNG สำเร็จ: ' + blob.size + ' bytes')
  say('ผล: ผ่านทั้งหมด ✓')
} catch (e) {
  say('ผล: ล้มเหลว ✗ — ' + (e && e.message ? e.message : String(e)))
}
</script></body></html>`

/** วาง fixture ลง public/ — คืนฟังก์ชันสำหรับถอดออก */
function installFixture() {
  const repo = new URL('../', import.meta.url)
  // ⚠️ Next เสิร์ฟไฟล์ใน public/ เท่านั้น — เขียนนอก public/ แล้วจะ 404
  const publicDir = new URL('apps/web/public/', repo)

  writeFileSync(new URL(FIXTURE_HTML, publicDir), PAGE, 'utf8')

  // ⚠️ ต้องมี slash ท้าย base URL ไม่งั้น URL เอา `__pdfjs` ทิ้งไป
  const dest = new URL(`${FIXTURE_PDFJS}/`, new URL('apps/web/', repo))
  mkdirSync(dest, { recursive: true })
  for (const f of ['pdf.min.mjs', 'pdf.worker.min.mjs']) {
    copyFileSync(new URL(`node_modules/pdfjs-dist/build/${f}`, repo), new URL(f, dest))
  }

  return () => {
    for (const p of [
      new URL(FIXTURE_HTML, publicDir),
      new URL('pdf.min.mjs', dest),
      new URL('pdf.worker.min.mjs', dest),
    ]) {
      try {
        rmSync(p, { force: true })
      } catch {
        /* ลบไม่ได้ก็ปล่อย */
      }
    }
  }
}


const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ── เตรียมเอกสารจริงหนึ่งฉบับ ─────────────────────────────────
const redis = new Redis(process.env.VALKEY_URL)
const sid = `preview-${Date.now()}`
const H = { cookie: `docgen_session=${sid}`, 'content-type': 'application/json' }
await redis.set(`session:${sid}`, JSON.stringify({ sub: 'preview', name: 'preview' }), 'EX', 900)

const t = await (await fetch(`${API}/api/templates`, { headers: H })).json()
const tpl = t.items.find((x) => x.name.includes('สำเนา 1')) ?? t.items[0]

const created = await (
  await fetch(`${API}/api/documents`, {
    method: 'POST',
    headers: H,
    body: JSON.stringify({
      templateId: tpl.versionId,
      data: {
        เนื้อหา:
          'ทดสอบพรีวิวเป็นรูปในเบราว์เซอร์ด้วย pdf.js เนื้อหาต้องยาวพอจะตัดหลายบรรทัด ' +
          'เพื่อทดสอบทั้งการจัดย่อหน้า การซูม และการดาวน์โหลดเป็น PNG',
      },
      outputFormat: 'pdf',
      label: 'browser-preview-test',
    }),
  })
).json()

process.stdout.write('กำลังเรนเดอร์')
let doc
for (let i = 0; i < 90; i++) {
  await sleep(1000)
  doc = await (await fetch(`${API}/api/documents/${created._id}`, { headers: H })).json()
  if (doc.status === 'done' || doc.status === 'failed') break
  if (i % 5 === 0) process.stdout.write('.')
}
console.log(`\nเอกสาร ${created._id} → ${doc.status}`)

if (doc.status !== 'done') {
  console.log('✗ เรนเดอร์ไม่สำเร็จ')
  process.exit(1)
}

// ติดตั้ง fixture ก่อนเปิดเบราว์เซอร์ เพื่อให้ถอดออกได้ทุกทางออก
const removeFixture = installFixture()

// ── เปิด Chrome แบบ headless พร้อมพอร์ต debug ───────────────────
const profile = mkdtempSync(join(tmpdir(), 'cdp-'))
const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--no-first-run',
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
    const page = list.find((x) => x.type === 'page')
    if (page) wsUrl = page.webSocketDebuggerUrl
  } catch {
    /* ยังไม่พร้อม */
  }
}

if (!wsUrl) {
  console.log('✗ ต่อ Chrome DevTools ไม่ได้')
  chrome.kill()
  removeFixture()
  process.exit(1)
}

// ── คุยผ่าน CDP ────────────────────────────────────────────────
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
  const msg = JSON.parse(ev.data)
  const slot = waiting.get(msg.id)
  if (!slot) return
  waiting.delete(msg.id)
  msg.error ? slot.reject(new Error(JSON.stringify(msg.error))) : slot.resolve(msg.result)
})

await new Promise((r) => ws.addEventListener('open', r, { once: true }))

const evaluate = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
  return r.result?.value
}

await send('Page.enable')
await send('Runtime.enable')
await send('Page.navigate', { url: `${WEB}/${FIXTURE_HTML}?sid=${sid}&doc=${created._id}` })

// รอให้สคริปต์ในหน้าเขียนผลลัพธ์จบ
let out = ''
let diag = ''
for (let i = 0; i < 60; i++) {
  await sleep(1000)
  out = (await evaluate("document.getElementById('out')?.textContent ?? ''")) ?? ''
  if (i === 3) {
    // เก็บบริบทไว้เผื่อว่าหน้าไม่มี <pre> เลย — จะได้รู้ว่าติดที่ navigation หรือที่สคริปต์
    diag = JSON.stringify(
      await evaluate("({ href: location.href, ready: document.readyState, pre: !!document.getElementById('out'), body: document.body?.innerText?.slice(0, 200) ?? null })"),
    )
  }
  if (out.includes('ผล:')) break
}

if (!out) {
  console.log('\n⚠ หน้าไม่ได้เขียนผลลัพธ์เลย — บริบท:', diag)
}

console.log('\n──── ผลจากเบราว์เซอร์จริง ────')
console.log(out.trim())

const ok = out.includes('ผ่านทั้งหมด')

// เก็บกวาด
ws.close()
const exited = new Promise((r) => chrome.once('exit', r))
chrome.kill()
// ⚠️ ต้องรอให้ Chrome ปิดจริงก่อนลบ profile
//    ถ้าไม่รอจะได้ EBUSY เพราะไฟล์ยังถูกเปิดอยู่
await Promise.race([exited, sleep(5000)])
try {
  rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 })
} catch {
  /* เก็บกวาดไม่สำเร็จไม่ใช่ผลทดสอบ — ปล่อยทิ้งไว้ใน temp */
}

await fetch(`${API}/api/documents/${created._id}`, { method: 'DELETE', headers: H })
removeFixture()
await redis.del(`session:${sid}`)
redis.disconnect()

process.exit(ok ? 0 : 1)
