/**
 * prove-manual-version — พิสูจน์ว่าเกณฑ์ตรวจเลขรุ่นจับความไม่ตรงกันได้จริง
 * ==================================================================
 *
 * กติกาที่ใช้ตลอดงานนี้: เกณฑ์ที่เขียนเองต้องพิสูจน์ว่าจับบั๊กได้
 * ไม่ใช่แค่ "ดูเหมือนจะผ่าน" — เพราะถ้าเกณฑ์ตรวจไม่ทำงาน
 * เราจะเชื่อมันทั้งที่มันไม่ได้ตรวจอะไร
 *
 * วิธีพิสูจน์: ทำสำเนาคู่มือไปไฟล์ชั่วคราว แก้เลขรุ่นให้เหลื่อมกัน
 * แล้วสั่งให้ตัวตรวจอ่านสำเนานั้น ต้องรายงานตก
 * ไฟล์คู่มือจริงไม่ถูกแตะเลย
 *
 * ทำงานคู่กับ tools/check-manual-tags.mjs ที่รับพาธไฟล์เป็นอาร์กิวเมนต์
 */

import { readFileSync, writeFileSync, rmSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

const REAL = 'D:/2docx.com/docgen-platform/manual/index.html'
const CHECK = 'D:/2docx.com/docgen-platform/tools/check-manual-tags.mjs'
const dir = mkdtempSync(join(tmpdir(), 'manual-ver-'))

let broken = 0
const report = (name, caught, detail) => {
  console.log(`${caught ? 'ผ่าน' : 'ตก  '}  ${name}${detail ? ' — ' + detail : ''}`)
  if (!caught) broken++
}

/** รันตัวตรวจกับไฟล์ที่ระบุ แล้วคืน exit code */
function runCheck(file) {
  try {
    execFileSync(process.execPath, [CHECK, file], { stdio: 'pipe' })
    return 0
  } catch (err) {
    return err.status ?? 1
  }
}

// ── สถานะปกติ ต้องผ่าน ──────────────────────────────────────────
const realCode = runCheck(REAL)
report('ไฟล์คู่มือจริงผ่านเกณฑ์', realCode === 0, `exit ${realCode}`)

// ── ฉีดบั๊ก 1 · เลขรุ่นไม่ตรงกัน ───────────────────────────────
{
  const f = join(dir, 'mismatch.html')
  const html = readFileSync(REAL, 'utf8')
  // เปลี่ยนเฉพาะจุดที่สอง ให้ขัดกับจุดแรก
  const bumped = html.replace(/(data-manual-ver[^>]*>)0\.1\.0/, '$10.9.9')
  writeFileSync(f, bumped, 'utf8')
  const code = runCheck(f)
  report('จับได้เมื่อเลขรุ่นไม่ตรงกัน', code !== 0, `exit ${code}`)
}

// ── ฉีดบั๊ก 2 · เลขรุ่นผิดรูปแบบ ─────────────────────────────
{
  const f = join(dir, 'badshape.html')
  const html = readFileSync(REAL, 'utf8').replace(/0\.1\.0/g, 'ศูนย์')
  writeFileSync(f, html, 'utf8')
  const code = runCheck(f)
  report('จับได้เมื่อเลขรุ่นผิดรูปแบบ', code !== 0, `exit ${code}`)
}

// ── ฉีดบั๊ก 3 · ใส่ tag ที่ไม่มีที่มา ───────────────────────────
{
  const f = join(dir, 'orphan-tag.html')
  const html = readFileSync(REAL, 'utf8').replace(
    '</main>',
    '<p><code>{d.ข้อมูลที่ไม่เคยทดสอบ:หลอดๆ}</code></p></main>',
  )
  writeFileSync(f, html, 'utf8')
  const code = runCheck(f)
  report('จับได้เมื่อมี tag ที่ไม่มีที่มา', code !== 0, `exit ${code}`)
}

// ── กันการตกทุกข้อ ────────────────────────────────────────────
report('ไฟล์จริงยังผ่านอยู่หลังฉีดบั๊ก (กันเกณฑ์ที่ตกทุกข้อ)', runCheck(REAL) === 0)

rmSync(dir, { recursive: true, force: true })

console.log(`\n${broken === 0 ? 'ผ่านทั้งหมด — เกณฑ์จับบั๊กได้จริง' : 'ตก ' + broken + ' ข้อ'}`)
process.exit(broken === 0 ? 0 : 1)