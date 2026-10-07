/**
 * พิสูจน์ว่าเกณฑ์ใน test-manual-page.mjs จับบั๊กได้จริง
 *
 *   node tools/prove-manual-criteria.mjs
 *
 * ── ทำไมต้องฉีดบั๊ก ────────────────────────────────────────
 *   เกณฑ์ที่เขียนเองอาจผ่านเสมอโดยไม่ได้ตรวจอะไรเลย
 *   ต้องย้อนกลับบั๊กที่เจอจริงกลับเข้าไป แล้วยืนยันว่าเกณฑ์ตก
 *   แล้วคืนค่ากลับเสมอ (finally) ไม่งั้นจะเหลือของเสียในไฟล์จริง
 *
 *   บั๊กที่ฉีดคือของจริงทั้งสองข้อที่เจอรอบแรก:
 *     1 · ไม่ประกาศ favicon  → เบราว์เซอร์ขอ /favicon.ico → 404
 *     2 · scroll-padding + scroll-margin ซ้อนกัน 148px → เมนูไฮไลต์ผิดหัวข้อ
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CHROME = process.env.CHROME_PATH ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const PORT = 9485
const URL = 'http://127.0.0.1:8090/docs'

/**
 * หัวข้อที่ใช้ทดสอบ scrollspy — อ่านจากไฟล์คู่มือจริง
 *
 * ⚠️ อย่าเขียน id ตายตัว
 *   เคยเขียน `#fmt` ไว้ แล้วพอเปลี่ยนชื่อหัวข้อ สคริปต์นี้พังทันที
 *   แบบที่พังตอนชื่อเปลี่ยนยังดีกว่าแบบที่พังเงียบแล้วให้ผ่าน
 */
const SECTION_IDS = [...readFileSync('D:/2docx.com/docgen-platform/manual/index.html', 'utf8')
  .matchAll(/<section id="([^"]+)"/g)].map((m) => m[1])
const SPY = SECTION_IDS[5] ?? SECTION_IDS[0]
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const profile = mkdtempSync(join(tmpdir(), 'cdp-prove-'))
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
const ws = new WebSocket(wsUrl)
let seq = 0
const waiting = new Map()
const responses = []
const send = (m, p = {}) => new Promise((res, rej) => {
  const id = ++seq
  const t = setTimeout(() => { waiting.delete(id); rej(new Error('timeout ' + m)) }, 30000)
  waiting.set(id, { resolve: (v) => { clearTimeout(t); res(v) }, reject: rej })
  ws.send(JSON.stringify({ id, method: m, params: p }))
})
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data)
  if (m.method === 'Network.responseReceived') {
    responses.push({ url: m.params.response.url, status: m.params.response.status }); return
  }
  const s = waiting.get(m.id); if (!s) return
  waiting.delete(m.id)
  m.error ? s.reject(new Error(JSON.stringify(m.error))) : s.resolve(m.result)
})
await new Promise((r) => ws.addEventListener('open', r))
await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable')
await send('Network.setCacheDisabled', { cacheDisabled: true })
const ev = async (e) => {
  const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true })
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text)
  return r.result?.value
}

/** เกณฑ์เดียวกับที่ test-manual-page.mjs ใช้ */
async function readActive () {
  await ev(`(() => {
    document.documentElement.style.scrollBehavior = 'auto'
    document.querySelector('#${SPY}').scrollIntoView({ block: 'start' })
    window.dispatchEvent(new Event('scroll'))
  })()`)
  let lastY = -1
  for (let i = 0; i < 30; i++) {
    const y = await ev(`Math.round(window.scrollY)`)
    if (y === lastY) break
    lastY = y
    await sleep(150)
  }
  await sleep(700)
  return ev(`document.querySelector('.sidenav a.active')?.getAttribute('href') ?? null`)
}

const results = []
/**
 * ⚠️ ต้องประกาศนอก try
 *   ถ้าประกาศด้วย `let` ใน try จะมองไม่เห็นใน finally → พังตอนคืนค่า
 *   และบล็อก finally ที่ตั้งใจไว้กันเหลือของเสียจะไม่ทำงาน
 */
let active = null
const record = (name, ok, detail) => {
  results.push({ name, ok, detail })
  console.log(`  ${ok ? '✓' : '✗'}${name}${detail ? ` — ${detail}` : ''}`)
}

try {
  // ── สภาวะปกติ ต้องผ่าน ────────────────────────────────────
  await send('Page.navigate', { url: URL })
  await sleep(3000)
  let active = await readActive()
  record('ปกติ · เมนูไฮไลต์หัวข้อที่เลื่อนไป', active === `#${SPY}`, `active=${active} · คาด #${SPY}`)

  const bad0 = responses.filter((r) => r.status >= 400)
  record('ปกติ · ไม่มี 4xx/5xx', bad0.length === 0, bad0.map((b) => `${b.status} ${b.url}`).join(' · ') || 'สะอาด')

  // ── ฉีดบั๊ก 1 · scroll-margin ซ้อนกับ scroll-padding ────────
  await ev(`(() => {
    const s = document.createElement('style')
    s.id = 'inject-margin'
    s.textContent = '.content section { scroll-margin-top: calc(58px + 16px); }'
    document.head.appendChild(s)
  })()`)
  await send('Page.navigate', { url: URL })
  await sleep(2500)
  await ev(`(() => {
    const s = document.createElement('style')
    s.textContent = '.content section { scroll-margin-top: calc(58px + 16px); }'
    document.head.appendChild(s)
  })()`)
  active = await readActive()
  record('ฉีดบั๊ก · scroll-margin ซ้อน → ต้องตก', active !== `#${SPY}`, `active=${active} · คาดไม่ใช่ #${SPY}`)

  // ── ฉีดบั๊ก 2 · ถอด favicon ออก ─────────────────────────────
  /**
   * ⚠️ ต้องฉีดด้วย `addScriptToEvaluateOnNewDocument` ไม่ใช่แก้ DOM ตอน runtime
   *   เพราะการแก้ DOM จะหายไปตอน reload (หน้าถูกโหลดใหม่จาก HTML เดิม)
   *   → ที่ผ่านมาไม่จับ เพราะเกณฑ์ตรวจหลัง reload เสมอ
   *   การฉีดก่อนหน้าเว็บรัน = สภาวะเสียยั่งยืนตลอดการโหลด
   */
  const injected = await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `(() => {
      // จำลองบั๊กของจริง: ไม่ประกาศไอคอนเลย → เบราว์เซอร์ไปขอ /favicon.ico เอง
      // ⚠️ ห้ามใส่ <link rel=icon> ทับ เพราะ Chrome จะเลือกตัวหลังสุด
      //   แล้วขอไฟล์ที่มีอยู่จริง → ได้ 200 → ไม่จับบั๊ก (ผ่านมาแล้วรอบหนึ่ง)
      const kill = () => {
        document.querySelectorAll('link[rel=icon]').forEach((l) => l.remove());
      };
      kill();
      document.addEventListener('DOMContentLoaded', kill);
    })()`,
  })
  responses.length = 0
  await send('Page.navigate', { url: URL })
  await sleep(3500)
  const bad1 = responses.filter((r) => r.status >= 400)
  record('ฉีดบั๊ก · ไม่ประกาศไอคอน → ต้องตก', bad1.length > 0,
    bad1.length ? bad1.map((b) => `${b.status} ${b.url.split('/').pop()}`).join(' · ') : 'ไม่จับได้ = เกณฑ์ไม่ศักย์')

  // ── ถอดบั๊กออกทันที ──────────────────────────────────────────
  await send('Page.removeScriptToEvaluateOnNewDocument', { identifier: injected.identifier })
} finally {
  // ── คืนค่าเสมอ ─────────────────────────────────────────────
  await send('Page.navigate', { url: URL })
  await sleep(2500)
  active = await readActive()
  console.log(`\n  (คืนค่าแล้ว: active=${active})`)
  await send('Browser.close').catch(() => undefined)
  chrome.kill()
  ws.close()
}

const failed = results.filter((r) => !r.ok)
console.log(`\n── ผ่าน ${results.length - failed.length} · ไม่ผ่าน ${failed.length} ─────────────────────\n`)
process.exit(failed.length ? 1 : 0)
