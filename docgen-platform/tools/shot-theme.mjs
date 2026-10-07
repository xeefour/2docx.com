/** ถ่ายภาพหน้าที่ deploy อยู่จริง เทียบโหมดสว่าง/มืด */
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CHROME = process.env.CHROME_PATH ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const PORT = 9488
const OUT = 'D:/2docx.com/docgen-platform/tests/nav-status/output-theme/'
mkdirSync(OUT, { recursive: true })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const profile = mkdtempSync(join(tmpdir(), 'cdp-theme-'))
const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
  '--force-color-profile=srgb', '--window-size=1280,900',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' })
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
const send = (m, p = {}) => new Promise((res, rej) => {
  const id = ++seq
  const t = setTimeout(() => { waiting.delete(id); rej(new Error('timeout ' + m)) }, 30000)
  waiting.set(id, { resolve: (v) => { clearTimeout(t); res(v) }, reject: rej })
  ws.send(JSON.stringify({ id, method: m, params: p }))
})
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data)
  const s = waiting.get(m.id); if (!s) return
  waiting.delete(m.id)
  m.error ? s.reject(new Error(JSON.stringify(m.error))) : s.resolve(m.result)
})
await new Promise((r) => ws.addEventListener('open', r))
await send('Page.enable'); await send('Runtime.enable'); await send('DOM.enable')
const ev = async (e) => {
  const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true })
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text)
  return r.result?.value
}

const URL_ = process.env.TARGET ?? 'http://127.0.0.1:8090/studio'

// ── สภาพปัจจุบัน: ไม่แตะ localStorage เลย ──────────────────────
for (const scheme of ['light', 'dark']) {
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] })
  await send('Page.navigate', { url: URL_ })
  await sleep(3500)

  const state = await ev(`(() => {
    const el = document.documentElement
    const btn = [...document.querySelectorAll('button')].find((b) => /theme|โหมด|สว่าง|มืด/i.test(b.getAttribute('aria-label') || b.className || ''))
    const cs = getComputedStyle(document.body)
    return {
      dataTheme: el.dataset.theme ?? '(ไม่ได้ตั้ง)',
      colorScheme: el.style.colorScheme || '(ว่าง)',
      bg: cs.backgroundColor,
      color: cs.color,
      hasBtn: !!btn,
      btnLabel: btn ? (btn.getAttribute('aria-label') || btn.title || btn.textContent.trim()) : null,
      btnBox: btn ? (() => { const r = btn.getBoundingClientRect(); return { x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2), w: Math.round(r.width), h: Math.round(r.height) } })() : null,
    }
  })()`)

  console.log(`\n[ระบบ ${scheme}] data-theme=${state.dataTheme} color-scheme=${state.colorScheme}`)
  console.log(`  พื้นหลัง=${state.bg}  ข้อความ=${state.color}`)
  console.log(`  ปุ่มสลับ: ${state.hasBtn ? state.btnLabel + ` @ (${state.btnBox.x},${state.btnBox.y}) ${state.btnBox.w}×${state.btnBox.h}` : 'ไม่มี'}`)

  const { data } = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(join(OUT, `sys-${scheme}.png`), Buffer.from(data, 'base64'))
}

// ── ทดสอบกดสลับจริง ────────────────────────────────────────────
await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] })
await send('Page.navigate', { url: URL_ })
await sleep(3000)

const before = await ev(`(() => {
  const b = [...document.querySelectorAll('button')].find((x) => /theme|โหมด|สว่าง|มืด/i.test(x.getAttribute('aria-label') || x.className || ''))
  if (!b) return null
  const r = b.getBoundingClientRect()
  return { x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2), bg: getComputedStyle(document.body).backgroundColor }
})()`)

if (!before) {
  console.log('\n✗ ไม่พบปุ่มสลับโหมดในหน้านี้')
} else {
  console.log(`\n[ทดสอบกด] ก่อนกด พื้นหลัง=${before.bg}`)
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: before.x, y: before.y, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: before.x, y: before.y, button: 'left', clickCount: 1 })
  await sleep(1200)
  const after = await ev(`(() => ({
    dataTheme: document.documentElement.dataset.theme ?? '(ไม่ได้ตั้ง)',
    colorScheme: document.documentElement.style.colorScheme || '(ว่าง)',
    bg: getComputedStyle(document.body).backgroundColor,
    saved: localStorage.getItem('docgen-theme'),
  }))()`)
  console.log(`[ทดสอบกด] หลังกด พื้นหลัง=${after.bg} data-theme=${after.dataTheme} color-scheme=${after.colorScheme} localStorage=${after.saved}`)

  const { data } = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(join(OUT, 'after-click.png'), Buffer.from(data, 'base64'))
}

await send('Browser.close').catch(() => undefined)
chrome.kill(); ws.close()