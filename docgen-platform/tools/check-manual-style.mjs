/**
 * ตรวจว่า STYLE.md ตรงกับ manual.css จริงหรือไม่
 *
 *   node tools/check-manual-style.mjs
 *
 * ── ทำไมต้องมี ────────────────────────────────────────────────
 *   STYLE.md ระบุเองว่า "ถ้าแก้สีใน CSS ต้องแก้ตารางในไฟล์นี้ด้วย ไม่งั้นเอกสารจะโกหกผู้อ่าน"
 *   แต่การฝากความรับผิดชอบไว้กับความจำคน แล้วเอกสารจะเพี้ยนชัก ๆ เงียบ ๆ
 *   เหตุผลจริงที่ทำได้: เอกสารสีเป็นตัวแปรอยู่แล้ว → เทียบอัตโนมัติได้
 *
 * ── เกณฑ์ ────────────────────────────────────────────────────
 *   1 · ชุดตัวแปรในบล็อก CSS ของ STYLE.md ต้องตรงกับ manual.css ทุกตัว
 *   2 · คอนทราสต์ที่เอกสารอ้างว่า "AA" ต้องผ่านจริง
 *      (ถ้าแก้สีจนตกต่ำกว่าเกณฑ์ เอกสารจะยังเขียนว่า AA = ผิด)
 *   3 · ตัวแปรที่ประกาศในโหมดสว่างต้องมีค่าในโหมดมืดครบ
 *      (ขาดตัวเดียว = สลับโหมดแล้วสีคนละชุด ไม่มี error)
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const CSS_PATH = join(here, '..', 'manual', 'assets', 'manual.css')
const MD_PATH = join(here, '..', 'manual', 'STYLE.md')

let pass = 0
let fail = 0
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'}${name}${detail ? ` — ${detail}` : ''}`)
  ok ? pass++ : fail++
}

/** ดึงค่าตัวแปรสีจากบล็อก CSS หนึ่งชุด (ตัดตามเครื่องหมาย { }) */
function readBlock(src, openIndex) {
  const start = src.indexOf('{', openIndex)
  if (start === -1) return ''
  let depth = 0
  for (let i = start; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') {
      depth--
      if (depth === 0) return src.slice(start + 1, i)
    }
  }
  return ''
}

const varsIn = (block) => {
  const out = {}
  // เฉพาะค่าที่เป็นสี — ไม่เอา --radius/--topbar-h ที่คำนวณคอนทราสต์ไม่ได้
  for (const m of block.matchAll(/(--[a-z0-9-]+)\s*:\s*(#[0-9a-fA-F]{3,8})\s*;/g)) {
    out[m[1]] = m[2].toLowerCase()
  }
  return out
}

const css = readFileSync(CSS_PATH, 'utf8')
const md = readFileSync(MD_PATH, 'utf8')

// โหมดสว่าง = :root แรก · โหมดมืด = :root ใน media query
const lightRootIdx = css.indexOf(':root')
const lightCss = varsIn(readBlock(css, lightRootIdx))
const darkIdx = css.indexOf('prefers-color-scheme')
const darkCss = darkIdx === -1 ? {} : varsIn(readBlock(css, darkIdx))

console.log(`\n── STYLE.md ↔ manual.css ────────────────────────────────\n`)
console.log(`  พบใน CSS : โหมดสว่าง ${Object.keys(lightCss).length} ตัว · โหมดมืด ${Object.keys(darkCss).length} ตัว`)

// ── เกณฑ์ 1 · บล็อก CSS ในเอกสารตรงกับไฟล์จริง ─────────────────
const fences = [...md.matchAll(/```css\n([\s\S]*?)```/g)].map((m) => m[1])
check('ใน STYLE.md มีบล็อก CSS พร้อมคัดลอกอยู่', fences.length > 0, `${fences.length} บล็อก`)
const docCss = fences.length ? fences[fences.length - 1] : ''

const docLight = varsIn(readBlock(docCss, docCss.indexOf(':root')))
const docDark = varsIn(readBlock(docCss, docCss.indexOf('prefers-color-scheme')))

const diff = (label, a, b) => {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)])
  const bad = []
  for (const k of keys) {
    if (a[k] !== b[k]) bad.push(`${k}: css=${a[k] ?? 'ไม่มี'} md=${b[k] ?? 'ไม่มี'}`)
  }
  check(label, bad.length === 0, bad.length ? bad.join(' · ') : `${Object.keys(a).length} ตัวตรงกัน`)
}
diff('โทเคนโหมดสว่างในเอกสารตรงกับ CSS', lightCss, docLight)
diff('โทเคนโหมดมืดในเอกสารตรงกับ CSS', darkCss, docDark)

// ── เกณฑ์ 3 · โหมดมืดต้องครบทุกตัว ───────────────────────────
const missingInDark = Object.keys(lightCss).filter((k) => !darkCss[k])
check('โทเคนโหมดสว่างมีค่าในโหมดมืดครบ', missingInDark.length === 0,
  missingInDark.length ? `ขาด: ${missingInDark.join(', ')}` : 'ครบทุกตัว')

// ── เกณฑ์ 2 · คอนทราสต์ต้องตรงกับที่เอกสารอ้าง ───────────────
const lin = (c) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4) }
const lum = (hex) => {
  const h = hex.replace('#', '')
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16))
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}
const ratio = (a, b) => {
  const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m)
  return (x + 0.05) / (y + 0.05)
}

const PAIRS = [
  ['ข้อความหลัก บนพื้นหน้า', 'text', 'bg', 4.5],
  ['ข้อความหลัก บนพื้นการ์ด', 'text', 'surface', 4.5],
  ['ข้อความหลัก บนพื้นโค้ด', 'code-text', 'code-bg', 4.5],
  ['ข้อความรอง บนการ์ด', 'text-dim', 'surface', 4.5],
  ['ลิงก์/เน้น บนพื้นหน้า', 'accent', 'bg', 4.5],
  ['ลิงก์/เน้น บนการ์ด', 'accent', 'surface', 4.5],
  ['เน้น บนพื้นเน้น', 'accent', 'accent-soft', 4.5],
  ['สถานะผ่าน บนการ์ด', 'ok', 'surface', 4.5],
  ['สถานะเตือน บนการ์ด', 'warn', 'surface', 4.5],
  ['สถานะผิด บนการ์ด', 'danger', 'surface', 4.5],
  ['ผิด บนพื้นผิด', 'danger', 'danger-soft', 4.5],
]

for (const [mode, V] of [['สว่าง', lightCss], ['มืด', darkCss]]) {
  console.log(`\n  คอนทราสต์โหมด${mode}:`)
  for (const [label, fg, bg, min] of PAIRS) {
    const r = ratio(V[`--${fg}`], V[`--${bg}`])
    check(`${label} ≥ ${min}:1`, r >= min, `${r.toFixed(2)}:1`)
  }
  // --text-faint ต่ำกว่าเกณฑ์โดยที่แจ้งไว้ในเอกสาร → ต้องยังเป็นจริง
  const faint = ratio(V['--text-faint'], V['--surface'])
  check('ข้อความจางยังคงต่ำกว่าเกณฑ์ตามที่เอกสารเตือนไว้', faint < 4.5, `${faint.toFixed(2)}:1`)
}

console.log(`\n── ผ่าน ${pass} · ไม่ผ่าน ${fail} ─────────────────────\n`)
process.exit(fail ? 1 : 0)