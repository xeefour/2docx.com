/**
 * ตรวจระบบธีมสว่าง/มืดของเว็บ
 *
 *   node tools/probe-theme.mjs            ตรวจปกติ
 *   node tools/probe-theme.mjs --prove    ฉีดบั๊กเพื่อพิสูจน์ว่าเกณฑ์จับได้จริง
 *
 * ── ทำไมต้องมี ────────────────────────────────────────────────
 *   `globals.css` มีโหมดมืด**สองบล็อก** ที่ต้องตรงกันทุกโทเคน:
 *     1. `@media (prefers-color-scheme: dark) :root:not([data-theme='light'])`
 *        → ตามระบบของผู้ใช้
 *     2. `:root[data-theme='dark']`
 *        → ผู้ใช้กดเลือกเองจากปุ่มใน sidebar
 *
 *   ถ้าแก้บล็อกหนึ่งแล้วลืมอีกบล็อก จะไม่มี error ไม่มี warning
 *   อาการคือ "เปิดครั้งแรกได้ธีมหนึ่ง แต่กดสลับแล้วได้อีกธีม"
 *   ซึ่งผู้ใช้จะเจอเฉพาะตอนสลับเองเท่านั้น
 *
 * ── เกณฑ์ ────────────────────────────────────────────────────
 *   1 · บล็อกมืดสองบล็อกต้องตรงกันทุกโทเคนและทุกค่า
 *   2 · โทเคนโหมดสว่างทุกตัวต้องมีค่าในโหมดมืดครบ (ขาด = สลับแล้วสีไม่เปลี่ยน)
 *   3 · คอนทราสต์ในโหมดมืดต้องผ่านเกณฑ์อ่านได้
 *   4 · ปุ่มใน sidebar ต้องสลับธีมได้จริง และจำค่าข้ามการเปิดหน้าใหม่
 *   5 · ทุกหน้าที่มี sidebar ต้องมีปุ่ม (ไม่มีหน้าไหนหลุด)
 */
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const PROVE = process.argv.includes('--prove')
const here = dirname(fileURLToPath(import.meta.url))
const CSS = process.env.THEME_CSS ?? join(here, '..', 'apps', 'web', 'app', 'globals.css')
const OUT = 'D:/2docx.com/docgen-platform/tests/nav-status/output-theme/'
mkdirSync(OUT, { recursive: true })

let pass = 0
let fail = 0
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'}${name}${detail ? ` — ${detail}` : ''}`)
  ok ? pass++ : fail++
}

const css = readFileSync(CSS, 'utf8')

/** อ่านบล็อก CSS หนึ่งชุด โดยนับวงเล็บปีกกาให้ครบ */
function blockAfter (src, marker) {
  const at = src.indexOf(marker)
  if (at === -1) return null
  const open = src.indexOf('{', at)
  if (open === -1) return null
  let depth = 0
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') {
      depth--
      if (depth === 0) return src.slice(open + 1, i)
    }
  }
  return null
}

const varsIn = (block) => {
  const out = {}
  for (const m of (block ?? '').matchAll(/(--[a-z0-9-]+)\s*:\s*(#[0-9a-fA-F]{3,8}|(?:rgb|rgba)\([^)]*\))\s*;/g)) {
    out[m[1]] = m[2].toLowerCase().replace(/\s+/g, '')
  }
  return out
}

const light = varsIn(blockAfter(css, ':root {'))
const darkMedia = varsIn(blockAfter(css, ":root:not([data-theme='light'])"))
const darkAttr = varsIn(blockAfter(css, ":root[data-theme='dark']"))

console.log(`\n── ธีมสว่าง/มืด ────────────────────────────────\n`)
console.log(`  โทเคน: สว่าง ${Object.keys(light).length} · มืด(ตามระบบ) ${Object.keys(darkMedia).length} · มืด(ผู้เลือก) ${Object.keys(darkAttr).length}\n`)

// ── เกณฑ์ 1 · บล็อกมืดสองบล็อกต้องตรงกัน ────────────────────────
{
  const keys = new Set([...Object.keys(darkMedia), ...Object.keys(darkAttr)])
  const diff = [...keys].filter((k) => darkMedia[k] !== darkAttr[k])
  check('บล็อกมืดสองบล็อกตรงกันทุกโทเคน', diff.length === 0,
    diff.length ? diff.map((k) => `${k}: media=${darkMedia[k]} attr=${darkAttr[k]}`).join(' · ') : `${keys.size} ตัวตรงกัน`)
}
check('พบทั้งสองบล็อกมืดในไฟล์', darkMedia && darkAttr,
  `media=${!!darkMedia} attr=${!!darkAttr}`)

// ── เกณฑ์ 2 · โทเคนสว่างต้องมีค่าในโหมดมืดครบ ─────────────────
{
  const missing = Object.keys(light).filter((k) => !darkMedia[k] || !darkAttr[k])
  check('โทเคนโหมดสว่างมีค่าในโหมดมืดครบทุกตัว', missing.length === 0,
    missing.length ? `ขาด ${missing.length} ตัว: ${missing.slice(0, 6).join(', ')}${missing.length > 6 ? ' …' : ''}` : 'ครบทุกตัว')
}

// ── เกณฑ์ 3 · คอนทราสต์โหมดมืด ───────────────────────────────
const lin = (c) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4) }
const lum = (hex) => {
  const h = hex.replace('#', '')
  if (h.length < 6) return null
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16))
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}
const ratio = (a, b) => {
  const x = lum(a), y = lum(b)
  if (x === null || y === null) return null
  const [hi, lo] = [x, y].sort((m, n) => n - m)
  return (hi + 0.05) / (lo + 0.05)
}
const PAIRS = [
  ['ข้อความหลัก บนพื้นหน้า', '--ink', '--bg'],
  ['ข้อความหลัก บนพื้นการ์ด', '--ink', '--surface'],
  ['ข้อความรอง บนพื้นการ์ด', '--ink-2', '--surface'],
  ['ข้อความจาง บนพื้นการ์ด', '--ink-3', '--surface'],
  ['เน้น บนพื้นหน้า', '--brand', '--bg'],
  ['เน้น บนพื้นเน้น', '--brand', '--brand-soft'],
  ['ผ่าน บนพื้นผ่าน', '--ok', '--ok-bg'],
  ['ผิด บนพื้นผิด', '--err', '--err-bg'],
  ['เตือน บนพื้นเตือน', '--warn', '--warn-bg'],
]
for (const [mode, V] of [['สว่าง', light], ['มืด', darkMedia]]) {
  console.log(`  คอนทราสต์โหมด${mode}:`)
  for (const [label, fg, bg] of PAIRS) {
    if (!V[fg] || !V[bg]) { check(`${label} (ไม่มีตัวแปร)`, false, `${fg}/${bg} ว่าง`); continue }
    const r = ratio(V[fg], V[bg])
    check(`${label} ≥ 4.5:1`, r >= 4.5, `${r.toFixed(2)}:1`)
  }
}

// ── เกณฑ์ 4-5 · ปุ่มในเบราว์เซอร์ ─────────────────────────────
if (!PROVE) {
  const CHROME = process.env.CHROME_PATH ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
  const PORT = 9491
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const profile = mkdtempSync(join(tmpdir(), 'cdp-probe-theme-'))
  const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
    '--window-size=1280,900', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' })
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
  const send = (m, p = {}) => new Promise((res, rej) => {
    const id = ++seq
    const t = setTimeout(() => { waiting.delete(id); rej(new Error(`timeout ${m}`)) }, 30000)
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
  await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable')
  await send('Network.setCacheDisabled', { cacheDisabled: true })
  const ev = async (e) => {
    const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text ?? 'evaluate พัง')
    return r.result?.value
  }

  console.log('\n  ในเบราว์เซอร์:')
  const FIND_BTN = `[...document.querySelectorAll('button')].find((b) => /สลับเป็นโหมด|theme/i.test(b.getAttribute('aria-label') || ''))`

  // ── ตามระบบ ───────────────────────────────────────────────────
  for (const scheme of ['light', 'dark']) {
    await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] })
    await send('Page.navigate', { url: 'http://127.0.0.1:8090/teams' })
    await sleep(3500)
    const s = await ev(`(() => {
      const b = ${FIND_BTN}
      const cs = getComputedStyle(document.body)
      return {
        bg: cs.backgroundColor,
        dataTheme: document.documentElement.dataset.theme ?? '(ไม่ได้ตั้ง)',
        btn: b ? (b.getAttribute('aria-label') || '').trim() : null,
      }
    })()`)
    const isDarkBg = /rgb\(2[0-9], 2[0-9], 2[0-9]|rgb\(1[0-9]/.test(s.bg ?? '')
    check(`ระบบ${scheme === 'light' ? 'สว่าง' : 'มืด'} → พื้นหลังตรงธีม`,
      scheme === 'light' ? !isDarkBg : isDarkBg, s.bg)
    check(`ระบบ${scheme === 'light' ? 'สว่าง' : 'มืด'} → ยังไม่ถูกบังคับด้วย data-theme`,
      s.dataTheme === '(ไม่ได้ตั้ง)', s.dataTheme)
    check(`ระบบ${scheme === 'light' ? 'สว่าง' : 'มืด'} → ป้ายบนปุ่มตรงธีมปัจจุบัน`,
      !!s.btn && s.btn.includes(scheme === 'light' ? 'โหมดสว่าง' : 'โหมดมืด'), s.btn)
  }

  // ── กดสลับเอง ───────────────────────────────────────────────
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] })
  await send('Page.navigate', { url: 'http://127.0.0.1:8090/teams' })
  await sleep(3500)

  const btn = await ev(`(() => {
    const b = ${FIND_BTN}
    if (!b) return null
    const r = b.getBoundingClientRect()
    return {
      x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2),
      w: Math.round(r.width), h: Math.round(r.height),
      bg: getComputedStyle(document.body).backgroundColor,
    }
  })()`)
  check('หน้าที่มี sidebar มีปุ่มสลับธีม', !!btn, btn ? `${btn.w}×${btn.h}px` : 'ไม่เจอปุ่ม')

  if (btn) {
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: btn.x, y: btn.y, button: 'left', clickCount: 1 })
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: btn.x, y: btn.y, button: 'left', clickCount: 1 })
    await sleep(1200)
    const after = await ev(`({
      dataTheme: document.documentElement.dataset.theme ?? '(ไม่ได้ตั้ง)',
      colorScheme: document.documentElement.style.colorScheme || '(ว่าง)',
      bg: getComputedStyle(document.body).backgroundColor,
      saved: localStorage.getItem('docgen-theme'),
    })`)
    check('กดแล้วธีมเปลี่ยนจริง', /rgb\(2[0-9]|rgb\(1[0-9]/.test(after.bg) && after.bg !== btn.bg,
      `${btn.bg} → ${after.bg}`)
    check('กดแล้วบันทึกเป็น data-theme', after.dataTheme === 'dark' || after.dataTheme === 'light', after.dataTheme)
    check('กดแล้วตั้ง color-scheme ตามธีม', ['light', 'dark'].includes(after.colorScheme), after.colorScheme)
    check('กดแล้วจำค่าไว้ใน localStorage', after.saved === 'dark' || after.saved === 'light', after.saved)

    // ── เกณฑ์ 5 · ค่าต้องอยู่ข้ามการเปิดหน้าใหม่ ──────────────
    await send('Page.navigate', { url: 'http://127.0.0.1:8090/teams' })
    await sleep(3000)
    const reload = await ev(`({
      dataTheme: document.documentElement.dataset.theme ?? '(ไม่ได้ตั้ง)',
      bg: getComputedStyle(document.body).backgroundColor,
    })`)
    check('ค่าที่เลือกอยู่ข้ามการเปิดหน้าใหม่', reload.dataTheme === after.dataTheme,
      `${after.dataTheme} → ${reload.dataTheme}`)

    const { data } = await send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(join(OUT, 'theme-toggled.png'), Buffer.from(data, 'base64'))

    // ล้างค่าที่ทดสอบทิ้ง ไม่ให้เหลือรอยในเครื่อง
    await ev(`(() => { localStorage.removeItem('docgen-theme'); document.documentElement.removeAttribute('data-theme'); document.documentElement.style.colorScheme = '' })()`)
  }

  await send('Browser.close').catch(() => undefined)
  chrome.kill(); ws.close()
} else {
  console.log('\n  (โหมดพิสูจน์ — ข้ามการตรวจในเบราว์เซอร์ เหลือแต่การเทียบไฟล์)')
}

console.log(`\n── ผ่าน ${pass} · ไม่ผ่าน ${fail} ─────────────────────\n`)
process.exit(fail ? 1 : 0)