/**
 * พิสูจน์ว่า probe-theme.mjs จับบั๊กได้จริง
 *
 *   node tools/prove-theme-criteria.mjs
 *
 * ── ทำไมต้องฉีดบั๊ก ────────────────────────────────────────────
 *   เกณฑ์ที่เขียนเองอาจผ่านเสมอโดยไม่ได้ตรวจอะไรเลย
 *   ต้องย้อนกลับบั๊กที่เจอจริงกลับเข้าไป แล้วยืนยันว่าเกณฑ์ตก
 *
 * ── ทำไมแก้ไฟล์สำเนา ไม่แก้ไฟล์จริง ──────────────────────────
 *   บั๊กที่จะฉีดคือ "บล็อกมืดสองบล็อกไม่ตรงกัน" ซึ่งต้องแก้ CSS จริง
 *   ถ้าแก้ตัวจริงแล้ว process ถูกหยุดกลางคัน (หรือสคริปต์นี้พัง)
 *   จะเหลือธีมมืดพังค้างไว้ในซอร์ส → เว็บทั้งเว็บผิดธีม
 *   จึงคัดลอกไฟล์มาแก้ แล้วชี้ probe ไปที่สำเนานั้น
 *   ครั้งนี้จึงพิสูจน์ได้โดยที่**ไฟล์จริงไม่ถูกแตะเลย**
 */
import { copyFileSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const REAL = join(here, '..', 'apps', 'web', 'app', 'globals.css')
const COPY = join(here, '..', 'logs', 'globals-theme-bug.css')

let pass = 0
let fail = 0
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'}${name}${detail ? ` — ${detail}` : ''}`)
  ok ? pass++ : fail++
}

const run = (cssPath) =>
  spawnSync(process.execPath, [join(here, 'probe-theme.mjs'), '--prove'], {
    encoding: 'utf8',
    env: { ...process.env, THEME_CSS: cssPath },
  })

const fp = (p) => createHash('sha256').update(readFileSync(p)).digest('hex').slice(0, 12)

/**
 * เกณฑ์ข้อนี้เขียนผิดครั้งแรก — เขียนว่า after === readFileSync(REAL)
 *   ซึ่งเป็นการเทียบไฟล์กับตัวเอง → ผ่านเสมอ ไม่มีความหมาย
 *   ต้องเก็บค่าก่อนฉีด แล้วเทียบทีหลัง
 */
const beforeFp = fp(REAL)

try {
  // ── บั๊ก 1 · บล็อก [data-theme='dark'] ตั้ง --bg ไม่ตรงกับบล็อก media ──
  copyFileSync(REAL, COPY)
  const src = readFileSync(REAL, 'utf8')
  const marker = ":root[data-theme='dark']"
  const at = src.indexOf(marker)
  if (at === -1) throw new Error('ไม่เจอบล็อก data-theme=dark ในไฟล์จริง')

  // เปลี่ยนเฉพาะ --bg ในบล็อกนี้ ให้ต่างจากบล็อก media
  const head = src.slice(0, at)
  const tail = src.slice(at)
  const patched = tail.replace('--bg: #1a1714;', '--bg: #2b2622;', 1)
  if (patched === tail) throw new Error('ไม่เจอ --bg ในบล็อก data-theme=dark — ค่าอาจเปลี่ยนไปแล้ว')
  writeFileSync(COPY, head + patched, 'utf8')

  const r = run(COPY)
  const out = `${r.stdout}${r.stderr}`
  const caughtBlocks = out.includes('✗บล็อกมืดสองบล็อกตรงกันทุกโทเคน')
  check('บั๊ก "สองบล็อกมืดไม่ตรงกัน" ถูกจับ', caughtBlocks && r.status !== 0,
    caughtBlocks ? `exit=${r.status}` : 'ไม่จับ = เกณฑ์ศักย์')
  const line = out.split('\n').find((l) => l.includes('บล็อกมืดสองบล็อก'))
  if (line) console.log(`      ${line.trim().slice(0, 150)}`)

  // ── บั๊ก 2 · บล็อกมืดขาดโทเคนที่โหมดสว่างมี ──────────────────
  copyFileSync(REAL, COPY)
  const s2 = readFileSync(REAL, 'utf8')
  const patched2 = s2.replace(":root[data-theme='dark'] {\n  /*", ":root[data-theme='dark'] {\n  /*", 1)
  // ตัดตัวแปรสีหนึ่งตัวออกจากบล็อกนี้ โดยลบทั้งบรรทัดค่าของ --line-strong
  const lines = patched2.split('\n')
  const start = lines.findIndex((l) => l.includes(":root[data-theme='dark']"))
  if (start === -1) throw new Error('ไม่เจอบล็อก')
  let removedAt = -1
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\s*--line-strong\s*:/.test(lines[i])) { removedAt = i; break }
    if (/^\s*--line\s*:/.test(lines[i])) { removedAt = i; break }
  }
  if (removedAt === -1) throw new Error('ไม่เจอตัวแปรสีในบล็อก data-theme=dark')
  const removed = lines[removedAt].trim()
  lines.splice(removedAt, 1)
  writeFileSync(COPY, lines.join('\n'), 'utf8')

  const r2 = run(COPY)
  const out2 = `${r2.stdout}${r2.stderr}`
  const caughtMissing = out2.includes('✗โทเคนโหมดสว่างมีค่าในโหมดมืดครบทุกตัว') && r2.status !== 0
  check(`บั๊ก "โหมดมืดขาดตัวแปร (${removed})" ถูกจับ`, caughtMissing,
    caughtMissing ? `exit=${r2.status}` : 'ไม่จับ = เกณฑ์ศักย์')
  const line2 = out2.split('\n').find((l) => l.includes('มีค่าในโหมดมืดครบทุกตัว'))
  if (line2) console.log(`      ${line2.trim().slice(0, 150)}`)

  // ── ไฟล์จริงต้องไม่ถูกแตะ ──────────────────────────────────
  const afterFp = fp(REAL)
  check('ไฟล์จริงไม่ถูกแก้ระหว่างพิสูจน์', afterFp === beforeFp,
    `${beforeFp} → ${afterFp}`)
} finally {
  // ── คืนค่าเสมอ ─────────────────────────────────────────────
  try { rmSync(COPY, { force: true }) } catch { /* ไม่มีไฟล์ก็ถือว่าเก็บแล้ว */ }
  console.log(`\n  (ลบไฟล์สำเนาเรียบร้อย · ไฟล์จริงไม่ถูกแตะ)`)
}

console.log(`\n── ผ่าน ${pass} · ไม่ผ่าน ${fail} ─────────────────────\n`)
process.exit(fail ? 1 : 0)