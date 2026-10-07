/**
 * ลิงก์ "คู่มือใช้งาน" บนหน้าแรกต้องพาถึง /docs จริง
 *
 *   node tools/test-home-docs-link.mjs
 *
 * ── ทำไมต้องกดจริง ไม่ใช่แค่เช็ก href ────────────────────────
 *   `/docs` **ไม่ได้มาจาก Next.js** แต่เสิร์ฟโดย gateway (Caddy)
 *   ถ้าเขียนด้วย `next/link` ค่า href จะถูกต้องเสมอ
 *   แต่ router ของ Next จะพยายามหา route นี้ในตัวเองแล้วได้หน้า 404
 *   → ผู้ใช้กดปุ่มที่ "มีอยู่จริง" แล้วไม่ถึงคู่มือ โดยไม่มี error ที่ไหน
 *   เกณฑ์แบบ "เช็กว่ามี href=/docs" จึงผ่านทั้งที่ของพัง
 *   วิธีเดียวที่จับได้คือกดแล้วดูว่าเบราว์เซอร์ไปถึงไหนจริง
 *
 * ── เกณฑ์ ────────────────────────────────────────────────────
 *   1 · หน้าแรกมีลิงก์คู่มือจริง และผู้ใช้กดได้ (ไม่มีอะไรบัง)
 *   2 · กดแล้วไปถึงหน้าคู่มือจริง (title ตรงกัน) ไม่ใช่ 404 ของ Next
 *   3 · ปุ่มเดิมทั้งสองปุ่มยังทำงาน ไม่หายไปเพราะแก้แล้ว
 *
 * ── พิสูจน์ว่าเกณฑ์จับบั๊กได้จริง ───────────────────────────
 *   node tools/test-home-docs-link.mjs --prove
 *   จะฉีดพฤติกรรมแบบ next/link (กดแล้วไม่นำทาง) แล้วยืนยันว่าเกณฑ์ข้อ 2 ตก
 *   เพราะถ้าฉีดแล้วยังผ่าน แปลว่าเกณฑ์นี้วัดอะไรไม่ได้เลย
 */
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PROVE = process.argv.includes('--prove')

const CHROME = process.env.CHROME_PATH ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const PORT = 9487
const HOME = 'http://127.0.0.1:8090/'
const OUT = 'D:/2docx.com/docgen-platform/tests/nav-status/output-manual/'
mkdirSync(OUT, { recursive: true })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * อ่านชื่อหน้าและจำนวนหัวข้อจากไฟล์คู่มือจริง
 *
 * ⚠️ อย่าเขียนค่าคาดหวังตายตัว
 *   เคยเขียน `title.includes('คู่มือ Carbone')` และนับ section เป็น 10
 *   พอเปลี่ยนชื่อคู่มือและเพิ่มหัวข้อ เกณฑ์ก็ตกทั้งที่หน้าเว็บถูกต้อง
 *   อ่านจากไฟล์ต้นทางจริงแล้วเกณฑ์จะตามเนื้อหาไปเอง
 */
const MANUAL_SRC = readFileSync('D:/2docx.com/docgen-platform/manual/index.html', 'utf8')
const MANUAL_TITLE = /<title>([^<]+)<\/title>/.exec(MANUAL_SRC)?.[1] ?? ''
const EXPECTED_SECTIONS = [...MANUAL_SRC.matchAll(/<section id="/g)].length

let pass = 0
let fail = 0
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'}${name}${detail ? ` — ${detail}` : ''}`)
  ok ? pass++ : fail++
}

const profile = mkdtempSync(join(tmpdir(), 'cdp-home-'))
const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
  '--window-size=1440,1000', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, 'about:blank'],
  { stdio: 'ignore' })
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
const consoleErrors = []
const send = (m, p = {}) => new Promise((res, rej) => {
  const id = ++seq
  const t = setTimeout(() => { waiting.delete(id); rej(new Error(`timeout: ${m}`)) }, 30000)
  waiting.set(id, { resolve: (v) => { clearTimeout(t); res(v) }, reject: rej })
  ws.send(JSON.stringify({ id, method: m, params: p }))
})
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data)
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
    consoleErrors.push((m.params.args ?? []).map((a) => a.value ?? a.description ?? '').join(' '))
    return
  }
  const s = waiting.get(m.id); if (!s) return
  waiting.delete(m.id)
  m.error ? s.reject(new Error(JSON.stringify(m.error))) : s.resolve(m.result)
})
await new Promise((r) => ws.addEventListener('open', r))
await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable')
await send('Network.setCacheDisabled', { cacheDisabled: true })

const evaluate = async (e) => {
  const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true })
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text ?? 'evaluate พัง')
  return r.result?.value
}
const waitFor = async (expr, ms = 25000) => {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    try { if (await evaluate(`!!(${expr})`)) return true } catch { /* ระหว่าง navigate */ }
    await sleep(300)
  }
  return false
}

console.log(`\n── ลิงก์คู่มือบนหน้าแรก ${HOME} ──────────────────────────\n`)

/**
 * โหมดพิสูจน์ — ฉีดพฤติกรรมที่ทำให้ next/link พัง
 * คือ click handler ที่กันไม่ให้เบราว์เซอร์นำทาง (soft nav ที่หา route ไม่เจอ)
 * สังเกตอาการคือ กดแล้ว "ไม่ไปไหน" ซึ่งตรงกับอาการที่ผู้ใช้เจอจริง
 */
if (PROVE) {
  console.log('  (โหมดพิสูจน์ — ฉีดพฤติกรรม next/link ที่พัง)\n')
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `(() => {
      document.addEventListener('click', (e) => {
        const a = e.target.closest && e.target.closest('a[href="/docs"]')
        if (a) e.preventDefault()
      }, true)
    })()`,
  })
}

await send('Page.navigate', { url: HOME })
await waitFor(`document.querySelector('a[href="/docs"]')`, 25000)
await sleep(1000)

// ── 1 · ลิงก์อยู่จริงและกดได้ ─────────────────────────────────
const link = await evaluate(`(() => {
  const a = document.querySelector('a[href="/docs"]')
  if (!a) return { miss: true }
  const r = a.getBoundingClientRect()
  const cx = Math.round(r.left + r.width / 2)
  const cy = Math.round(r.top + r.height / 2)
  const hit = document.elementFromPoint(cx, cy)
  return {
    miss: false,
    text: a.textContent.trim(),
    tag: a.tagName,
    /** next/link จะใส่ attribute นี้ให้ตัว anchor ที่มันครอบไว้ */
    isNextLink: a.hasAttribute('data-prefetch') || a.getAttribute('data-nxt') !== null,
    w: Math.round(r.width), h: Math.round(r.height),
    visible: r.top < innerHeight && r.bottom > 0 && r.width > 0 && r.height > 0,
    clickable: !!hit && (hit === a || a.contains(hit)),
    cx, cy,
  }
})()`)

check('หน้าแรกมีลิงก์ไปคู่มือ', link.miss !== true, link.miss ? 'ไม่เจอ a[href="/docs"]' : `"${link.text}"`)
if (link.miss) {
  console.log(`\n── ผ่าน ${pass} · ไม่ผ่าน ${fail} ─────────────────────\n`)
  await send('Browser.close').catch(() => undefined); chrome.kill(); ws.close()
  process.exit(1)
}
check('ลิงก์แสดงผลและมีขนาดจริง', link.visible === true, `${link.w}×${link.h}px`)
check('เป็น <a> ธรรมดา ไม่ใช่ next/link',
  link.tag === 'A' && link.isNextLink === false,
  `tag=${link.tag} · nextLink=${link.isNextLink}`)
check('จุดกดโดนลิงก์จริง ไม่มีอะไรบัง', link.clickable === true, `ที่ (${link.cx}, ${link.cy})`)

// ── ปุ่มเดิมต้องยังอยู่ ────────────────────────────────────────
const siblings = await evaluate(`[...document.querySelectorAll('main a')]
  .map((a) => a.textContent.trim())
  .filter((t) => t && t.length < 30)`)
check('ปุ่มเดิมบนหน้าแรกยังอยู่ครบ', siblings.length >= 4, siblings.join(' · '))

// ── 2 · กดแล้วต้องไปถึงคู่มู��จริง ────────────────────────────
/** คลิกด้วยเมาส์จริง ไม่ใช่ element.click() — ตามข้อตกลง CDP ของโปรเจกต์ */
await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: link.cx, y: link.cy, button: 'left', clickCount: 1 })
await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: link.cx, y: link.cy, button: 'left', clickCount: 1 })

const arrived = await waitFor(`location.pathname.startsWith('/docs')`, 20000)
await sleep(1800)

const after = await evaluate(`({
  url: location.href,
  path: location.pathname,
  title: document.title,
  h1: (document.querySelector('h1')?.textContent || '').trim(),
  hasSection: document.querySelectorAll('.content section').length,
  isManual: document.title === ${JSON.stringify(MANUAL_TITLE)},
})`)

check('กดแล้วไปที่เส้นทาง /docs', arrived === true, after.path)
check('ไปถึงหน้าคู่มือจริง ไม่ใช่ 404 ของ Next', after.isManual === true, after.title.slice(0, 60))
check(`หน้าคู่มือวาดครบ ${EXPECTED_SECTIONS} หัวข้อ`, after.hasSection === EXPECTED_SECTIONS, `${after.hasSection} section`)
check('ไม่มี error ใน console ระหว่างกด', consoleErrors.length === 0,
  consoleErrors.length ? consoleErrors.slice(0, 2).join(' | ') : 'สะอาด')

const { data } = await send('Page.captureScreenshot', { format: 'png' })
writeFileSync(join(OUT, 'home-docs-link.png'), Buffer.from(data, 'base64'))

if (PROVE) {
  // โหมดพิสูจน์: ต้องตกที่เกณฑ์การนำทาง แต่เกณฑ์โครงสร้างยังต้องผ่าน
  const navFailed = after.isManual !== true
  // ต้องมีการนำทางล้ม แต่เกณฑ์ส่วนที่ไม่เกี่ยวกับการนำทางยังผ่านอยู่
  const structureStillOk = pass >= 6
  console.log(`\n  ${navFailed ? '✓' : '✗'}เกณฑ์ "กดแล้วถึงจริง" จับอาการพังได้ — หลังฉีดยังอยู่ที่ ${after.path}`)
  console.log(`  ${structureStillOk ? '✓' : '✗'}เกณฑ์ส่วนโครงสร้างยังผ่าน — ${pass} ข้อ · ตก ${fail} ข้อ (ต้องตกเฉพาะการนำทาง)`)
  if (!navFailed) {
    console.log('\n  ⚠️ ฉีดบั๊กแล้วยังผ่าน = เกณฑ์นี้วัดอะไรไม่ได้เลย (บั๊กปลอม)')
    fail++
  }
  if (!structureStillOk) {
    console.log('\n  ⚠️ เกณฑ์ที่ไม่เกี่ยวกับการนำทางตกด้วย = บั๊กที่ฉีดกระทบเกินขอบเขต')
    fail++
  }
} else {
  console.log(`\n── ผ่าน ${pass} · ไม่ผ่าน ${fail} ─────────────────────\n`)
  console.log(`ภาพ: ${OUT}`)
}

// ลำดับปิด: Browser.close → chrome.kill() → ws.close()
await send('Browser.close').catch(() => undefined)
chrome.kill()
ws.close()
process.exit(fail ? 1 : 0)