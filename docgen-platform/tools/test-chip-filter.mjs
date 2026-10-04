/**
 * ชิป "หมวด" / "แท็ก" ในรายการแม่แบบ — กดเป็นตัวกรองได้
 *
 *   node --env-file=.env tools/test-chip-filter.mjs
 *
 * ── ต้องผ่าน ───────────────────────────────────────────────────
 * · ชิปหมวด/แท็กเป็น `<button>` จริง (ไม่ใช่ span) + มี aria-pressed/title
 * · กดชิปแท็กแล้วรายการเหลือเฉพาะแม่แบบที่มีแท็กนั้นจริง
 * · มีป้ายบอกว่ากำลังกรองด้วยแท็กอะไร (แท็กไม่มีช่องเลือกให้เห็นค่า)
 * · กดชิปซ้ำ = ยกเลิก · กด ✕ บนป้าย = ล้าง
 * · กดชิปหมวดแล้ว `<select>` หมวดเปลี่ยนตาม (ตัวกรองเดียวกัน ไม่ใช่สองอัน)
 * · หมวด + แท็ก = แบบ AND (ต้องมีทั้งสองอย่าง)
 * · ปุ่ม "ล้างตัวกรอง" ล้างทั้งสองอย่าง
 * · มือถือ 390px ชิปยัง**กดได้จริง** (ชี้เมาส์ตรงปุ่ม ไม่โดนอย่างอื่นบัง)
 */
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Redis } from 'ioredis'

const WEB = 'http://localhost:3000'
const CHROME = process.env.CHROME_PATH ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const PORT = 9396
const STAMP = Date.now()
const OUT = new URL('../tests/nav-status/output-chip-filter/', import.meta.url)
mkdirSync(OUT, { recursive: true })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let pass = 0
let fail = 0
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`)
  ok ? pass++ : fail++
}

const redis = new Redis(process.env.VALKEY_URL)
const SID = `chipfilter-${STAMP}`
await redis.set(
  `session:${SID}`,
  JSON.stringify({ sub: SID, name: 'ผู้ทดสอบชิปตัวกรอง', email: 'chip@test.local', avatar: '' }),
  'EX',
  900,
)

const profile = mkdtempSync(join(tmpdir(), 'cdp-chipfilter-'))
const chrome = spawn(
  CHROME,
  ['--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run', '--window-size=1600,1000',
   `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, 'about:blank'],
  { stdio: 'ignore' },
)
let wsUrl = null
for (let i = 0; i < 40 && !wsUrl; i++) {
  await sleep(500)
  try {
    const l = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
    wsUrl = l.find((x) => x.type === 'page')?.webSocketDebuggerUrl
  } catch {}
}
const ws = new WebSocket(wsUrl)
let seq = 0
const waiting = new Map()
const send = (m, p = {}) =>
  new Promise((resolve, reject) => {
    const id = ++seq
    waiting.set(id, { resolve, reject })
    ws.send(JSON.stringify({ id, method: m, params: p }))
    setTimeout(() => {
      if (waiting.has(id)) { waiting.delete(id); reject(new Error(`timeout: ${m}`)) }
    }, 30000)
  })
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data)
  const s = waiting.get(m.id)
  if (!s) return
  waiting.delete(m.id)
  m.error ? s.reject(new Error(JSON.stringify(m.error))) : s.resolve(m.result)
})
await new Promise((r) => ws.addEventListener('open', r, { once: true }))
const evaluate = async (e) => {
  const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true })
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text)
  return r.result?.value
}
const waitFor = async (e, ms = 30000) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    try { if (await evaluate(e)) return true } catch {}
    await sleep(400)
  }
  return false
}
const shot = async (n) => {
  const { data } = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(new URL(n, OUT), Buffer.from(data, 'base64'))
}

/**
 * กดชิปด้วยเมาส์จริง
 *
 * ⚠️ ห้ามใช้ `element.click()` — มันข้ามการทำงานของ hit-testing ทั้งหมด
 *   ปุ่มที่ถูกอย่างอื่นบังจะยัง "ถูกกด" ได้ แล้วเทสต์ผ่านทั้งที่คนจริงกดไม่โดน
 *   (เจอแล้วกับปุ่มซ่อนบนมือถือ) ต้องยิง `Input.dispatchMouseEvent`
 *   และเช็ค `elementFromPoint` ว่าชี้โดนตัวชิปจริง
 */
/**
 * ไปหน้าที่มีชิปคำนี้อยู่จริง (หน้ารายการแบ่งหน้า 12 แถว)
 *
 * ⚠️ เคยเป็นบั๊กในเทสต์นี้เอง ไม่ใช่บั๊กของระบบ
 *   แถว 12 แถวแรกไม่มีชิปหมวดเลย → `clickChip` หาไม่เจอ → ทั้งชุดตก
 *   แม้ระบบทำงานถูก แก้ได้ทางเดียวคือให้เทสต์รู้จักเดินทุกหน้า
 */
const gotoChip = async (testid, text) => {
  for (let i = 0; i < 20; i++) {
    const has = await evaluate(`[...document.querySelectorAll('[data-testid=' + ${JSON.stringify(testid)} + ']')]
      .some((b) => (b.textContent || '').trim() === ${JSON.stringify(text)})`)
    if (has) return true
    const canNext = await evaluate(`(() => {
      const b = document.querySelector('[data-testid="list-pager-next"]')
      return !!b && !b.disabled
    })()`)
    if (!canNext) return false
    await evaluate(`document.querySelector('[data-testid="list-pager-next"]').click()`)
    await sleep(700)
  }
  return false
}

/**
 * ไปหน้าที่มีชิปตาม testid อย่างน้อยหนึ่งอัน (ไม่ต้องระบุข้อความ)
 *
 * ⚠️ ข้อ [1] เดิมหาแถวที่มีชิปจากหน้าแรก
 *   แต่แถว 12 แถวแรกอาจไม่มีชิปหมวดเลย → `first` ตกไปที่แถวที่ไม่มีชิป
 *   → querySelector ได้ null → ทั้งชุดตก ทั้งที่ระบบปกติ
 */
const gotoAnyChip = async (testid) => {
  for (let i = 0; i < 20; i++) {
    const has = await evaluate(`!!document.querySelector('[data-testid=' + ${JSON.stringify(testid)} + ']')`)
    if (has) return true
    const canNext = await evaluate(`(() => {
      const b = document.querySelector('[data-testid="list-pager-next"]')
      return !!b && !b.disabled
    })()`)
    if (!canNext) return false
    await evaluate(`document.querySelector('[data-testid="list-pager-next"]').click()`)
    await sleep(700)
  }
  return false
}

const clickChip = async (testid, text, nth = 0) => {
  const box = await evaluate(`(() => {
    const els = [...document.querySelectorAll('[data-testid=${JSON.stringify(testid)}]')]
      .filter((b) => (b.textContent || '').trim() === ${JSON.stringify(text)})
    const el = els[${nth}]
    if (!el) return { miss: 'ไม่เจอชิป "' + ${JSON.stringify(text)} + '" (พบ ' + els.length + ' อัน)' }
    el.scrollIntoView({ block: 'center' })
    const r = el.getBoundingClientRect()
    const x = r.x + r.width / 2
    const y = r.y + r.height / 2
    const hit = document.elementFromPoint(x, y)
    return {
      ok: !!hit && (hit === el || el.contains(hit)),
      blockedBy: ok2(hit, el),
      x, y,
      w: Math.round(r.width),
      h: Math.round(r.height),
    }
    function ok2(h, e) { return h && h !== e && !e.contains(h) ? (h.className || h.tagName) : '' }
  })()`)
  if (!box?.ok) return box
  for (const type of ['mousePressed', 'mouseReleased'])
    await send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 })
  return box
}

/** ภาพรวมรายการ + สถานะตัวกรอง ณ ตอนนั้น */
const SNAP = `(() => {
  const rows = [...document.querySelectorAll('.tpllist tbody tr')]
  return {
    n: rows.length,
    rows: rows.map((tr) => ({
      cats: [...tr.querySelectorAll('[data-testid="row-cat"]')].map((b) => b.textContent.trim()),
      tags: [...tr.querySelectorAll('[data-testid="row-tag"]')].map((b) => b.textContent.trim()),
      // แถวที่มีแท็กเกิน 3 อัน จะแสดงแค่ "+N" — ชิปที่เห็นอาจไม่ใช่แท็กที่กรอง
      overflow: [...tr.querySelectorAll('td')].some((td) => /^\\+\\d+$/.test(td.textContent.trim())),
    })),
    onChips: [...document.querySelectorAll('.pill--btn.is-on')].map((b) => b.textContent.trim()),
    badge: document.querySelector('[data-testid="clear-tag"]')?.textContent.trim() || '',
    select: document.querySelector('.filters__cat')?.value || '',
    count: document.querySelector('.filters__count')?.textContent.trim() || '',
    range: document.querySelector('[data-testid="list-pager-range"]')?.innerText.trim() || '',
    // จำนวนทั้งหมดหลังกรอง (ไม่ใช่จำนวนแถวที่เห็น) — ดูรายละเอียดใน tools/lib/list-pages.mjs
    total: (() => {
      const s = document.querySelector('[data-testid="list-pager-range"]')?.innerText || ''
      const m = s.match(/[\d,]+/g)
      return m ? Number(m[m.length - 1].replace(/,/g, '')) : document.querySelectorAll('.tpllist tbody tr').length
    })(),
    hasClear: !![...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'ล้างตัวกรอง'),
  }
})()`

await send('Page.enable')
await send('Runtime.enable')
await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false })
await send('Network.setCacheDisabled', { cacheDisabled: true })
await send('Network.setCookie', { name: 'docgen_session', value: SID, url: WEB })
await send('Page.navigate', { url: `${WEB}/studio?_=${STAMP}` })
check('หน้ารายการโหลดได้', !!(await waitFor(`!!document.querySelector('.tpllist tbody tr')`, 45000)))

console.log('\n[1] ชิปต้องเป็นปุ่มจริง ไม่ใช่ป้ายตา')
await gotoAnyChip('row-cat')
const shape = await evaluate(`(() => {
  // ⚠️ ห้ามเอาแถวแรกตรง ๆ — แถวแรกอาจไม่มีหมวด/แท็กเลย
  //   แล้ว querySelector ได้ null เทสต์จะตกทั้งชุดทั้งที่ชิปปกติดี
  const rows = [...document.querySelectorAll('.tpllist tbody tr')]
  const first = rows.find((tr) => tr.querySelector('[data-testid="row-cat"]')) || rows[0]
  if (!first) return null
  const g = (id) => {
    const el = first.querySelector('[data-testid="' + id + '"]')
    if (!el) return null
    return { tag: el.tagName, pressed: el.getAttribute('aria-pressed'), title: el.getAttribute('title') || '' }
  }
  return { cat: g('row-cat'), tag: g('row-tag') }
})()`)
check('ชิปหมวดเป็น BUTTON', shape?.cat?.tag === 'BUTTON', JSON.stringify(shape?.cat))
check('ชิปแท็กเป็น BUTTON', shape?.tag?.tag === 'BUTTON', JSON.stringify(shape?.tag))
check(
  'ชิปมี aria-pressed (โปรแกรมอ่านหน้าจอต้องรู้ว่าถูกเลือกอยู่หรือยัง)',
  shape?.cat?.pressed === 'false' && shape?.tag?.pressed === 'false',
  `cat=${shape?.cat?.pressed} tag=${shape?.tag?.pressed}`,
)
check(
  'ชิปมี title บอกว่ากดแล้วเกิดอะไร',
  !!shape?.cat?.title && !!shape?.tag?.title,
  `${shape?.cat?.title} / ${shape?.tag?.title}`,
)

console.log('\n[2] กดชิปแท็กแล้วกรองจริง')
const before = await evaluate(SNAP)

/**
 * เก็บชิปข้อมูลจาก**ทุกหน้า** แล้วกลับมาหน้าแรก
 *
 * ⚠️ ต้องนับทั้งรายการ ไม่ใช่แค่หน้าปัจจุบัน
 *   เดิมนับแค่ 12 แถวแรก → เลือกแท็ก/หมวดที่เจอในหน้านั้น
 *   แต่ตอนกดแล้วอาจเป็นหน้าที่ 2 ที่มีชิปนั้น → กดไม่โดน
 *   และแท็กที่เลือกอาจมีแค่ 1 แถว → พิสูจน์ว่าตัวกรองทำงานไม่ได้
 */
const allRows = []
for (let i = 0; i < 20; i++) {
  const s = await evaluate(SNAP)
  allRows.push(...s.rows)
  const canNext = await evaluate(`(() => {
    const b = document.querySelector('[data-testid="list-pager-next"]')
    return !!b && !b.disabled
  })()`)
  if (!canNext) break
  await evaluate(`document.querySelector('[data-testid="list-pager-next"]').click()`)
  await sleep(700)
}
check('เดินครบทุกหน้าแล้ว', allRows.length >= before.n, `${allRows.length} แถวทั้งหมด`)
// กลับหน้าแรก เพื่อให้ผลลัพธ์ถัดไปอ้างอิงกับหน้าแรกเหมือนเดิม
while (await evaluate(`(() => {
  const b = document.querySelector('[data-testid="list-pager-prev"]')
  return !!b && !b.disabled
})()`)) {
  await evaluate(`document.querySelector('[data-testid="list-pager-prev"]').click()`)
  await sleep(500)
}
/** เลือกแท็กที่อยู่มากกว่า 1 แถว เพราะถ้าอยู่แถวเดียว จะพิสูจน์ไม่ได้ว่าตัวกรองทำงาน */
const tally = {}
for (const r of allRows) for (const t of r.tags) tally[t] = (tally[t] || 0) + 1
const sharedTag = Object.keys(tally).sort((a, b) => tally[b] - tally[a])[0] ?? ''
check('มีแท็กให้ทดสอบอยู่บ้าง', sharedTag.length > 0, Object.keys(tally).slice(0, 5).join(' · '))
await gotoChip('row-tag', sharedTag)
const clickTag1 = await clickChip('row-tag', sharedTag)
check(`กดชิปแท็ก "${sharedTag}" ได้`, !!clickTag1?.ok, clickTag1?.miss ?? clickTag1?.blockedBy ?? '')
check('ป้ายบอกค่าที่กรอง (แท็กไม่มีช่องเลือกให้เห็นค่า)', !!(await waitFor(`!!document.querySelector('[data-testid="clear-tag"]')`, 8000)))
const afterTag = await evaluate(SNAP)
check('จำนวนแถวลดลงจริง', afterTag.total < before.total, `${before.n} → ${afterTag.n} (${afterTag.count})`)
/**
 * ⚠️ ยกเว้นแถวที่มี "+N" — ชิปที่เห็นมีแค่ 3 อันแรก
 *   แถวนั้นอาจมีแท็กที่กรองอยู่แต่ไม่ได้แสดง ไม่ใช่บั๊ก
 */
const wrongTag = afterTag.rows.filter((r) => !r.tags.includes(sharedTag) && !r.overflow)
check('ทุกแถวที่เหลือมีแท็กนั้นจริง', wrongTag.length === 0, `${wrongTag.length} แถวไม่ตรง`)
check('ชิปที่กดถูกไฮไลต์ว่ากำลังใช้', afterTag.onChips.some((c) => c.includes(sharedTag)), afterTag.onChips.join(' | '))
check('ป้ายบอกว่ากรองด้วยแท็กนี้', afterTag.badge.includes(sharedTag), afterTag.badge)
check('ปุ่ม "ล้างตัวกรอง" โผล่มา', afterTag.hasClear === true)
await shot('01-tag-filter.png')

console.log('\n[3] กดชิปซ้ำ = ยกเลิกตัวกรอง')
await gotoChip('row-tag', sharedTag)
const clickTag2 = await clickChip('row-tag', sharedTag)
check('กดชิปเดิมซ้ำได้', !!clickTag2?.ok, clickTag2?.miss ?? clickTag2?.blockedBy ?? '')
check('กลับมาเป็นตัวกรองเดิม (กดซ้ำต้อง "ตัด" ไม่ใช่ "ซ้ำ")', !!(await waitFor(`!document.querySelector('[data-testid="clear-tag"]')`, 8000)))
const afterToggle = await evaluate(SNAP)
check('จำนวนแถวกลับมาเท่าเดิม', afterToggle.total === before.total, `${before.n} → ${afterToggle.n}`)

console.log('\n[4] กด ✕ บนป้าย = ล้างตัวกรองแท็ก')
await gotoChip('row-tag', sharedTag)
await clickChip('row-tag', sharedTag)
await waitFor(`!!document.querySelector('[data-testid="clear-tag"]')`, 8000)
const clickX = await clickChip('clear-tag', `แท็ก: ${sharedTag} ✕`)
check('กด ✕ บนป้ายได้', !!clickX?.ok, clickX?.miss ?? clickX?.blockedBy ?? '')
check('ป้ายหายและรายการกลับครบ', !!(await waitFor(
  `!document.querySelector('[data-testid="clear-tag"]') && document.querySelectorAll('.tpllist tbody tr').length === ${before.n}`,
  8000,
)))

console.log('\n[5] กดชิปหมวด → ช่องเลือกหมวดต้องเปลี่ยนตาม')
const catTally = {}
for (const r of allRows) for (const c of r.cats) catTally[c] = (catTally[c] || 0) + 1
const sharedCat = Object.keys(catTally).sort((a, b) => catTally[b] - catTally[a])[0] ?? ''
check('มีหมวดให้ทดสอบอยู่บ้าง', sharedCat.length > 0, Object.keys(catTally).slice(0, 5).join(' · '))
await gotoChip('row-cat', sharedCat)
const clickCat = await clickChip('row-cat', sharedCat)
check(`กดชิปหมวด "${sharedCat}" ได้`, !!clickCat?.ok, clickCat?.miss ?? clickCat?.blockedBy ?? '')
check('ช่องเลือกหมวดในแถบตัวกรองเปลี่ยนตาม (เป็นตัวกรองเดียวกัน)', !!(await waitFor(
  `document.querySelector('.filters__cat')?.value === ${JSON.stringify(sharedCat)}`,
  8000,
)))
const afterCat = await evaluate(SNAP)
check('จำนวนแถวลดลงจริง', afterCat.total < before.total, `${before.n} → ${afterCat.n} (${afterCat.count})`)
const wrongCat = afterCat.rows.filter((r) => !r.cats.includes(sharedCat))
check('ทุกแถวที่เหลืออยู่ในหมวดนั้นจริง', wrongCat.length === 0, `${wrongCat.length} แถวไม่ตรง`)
await shot('02-cat-filter.png')

console.log('\n[6] หมวด + แท็ก = ต้องมีทั้งสองอย่าง (AND)')
// เลือกแท็กของแถวในหมวดนั้น **แถวแรกที่มีแท็ก** ไม่ใช่แท็กที่พบมากที่สุดทั้งหน้า
// เพราะแท็กที่พบมากที่สุดอาจไม่อยู่ในหมวดนี้เลย → ไม่มีแถวไหนผ่าน → ทดสอบไม่ได้
const both = afterCat.rows.find((r) => r.tags.length > 0)
const pairTag = both ? both.tags[0] : ''
if (pairTag) {
  await gotoChip('row-tag', pairTag)
  await clickChip('row-tag', pairTag)
  await waitFor(`document.querySelectorAll('.pill--btn.is-on').length >= 2`, 8000)
  const afterBoth = await evaluate(SNAP)
  const nOk = afterBoth.rows.filter((r) => r.cats.includes(sharedCat) && (r.tags.includes(pairTag) || r.overflow))
  check('กรองสองชั้นพร้อมกันได้', afterBoth.total <= afterCat.total, `${afterCat.n} → ${afterBoth.n}`)
  check('ทุกแถวที่เหลือมีทั้งหมวดและแท็ก', nOk.length === afterBoth.rows.length, `${nOk.length}/${afterBoth.rows.length}`)
  check('ชิปที่ใช้งานอยู่ไฮไลต์ครบ 2 อัน', afterBoth.onChips.length >= 2, afterBoth.onChips.join(' | '))
} else {
  check('กรองสองชั้นพร้อมกันได้ (ข้าม — ไม่มีแถวไหนมีทั้งหมวดและแท็กที่เลือก)', true, 'ไม่มีข้อมูลให้ทดสอบ')
}

console.log('\n[7] ปุ่ม "ล้างตัวกรอง" ต้องล้างทั้งหมวดและแท็ก')
const clearBtn = await evaluate(`(() => {
  const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === 'ล้างตัวกรอง')
  if (!b) return { miss: 'ไม่เจอปุ่มล้างตัวกรอง' }
  b.scrollIntoView({ block: 'center' })
  const r = b.getBoundingClientRect()
  const x = r.x + r.width / 2, y = r.y + r.height / 2
  const hit = document.elementFromPoint(x, y)
  return { ok: !!hit && (hit === b || b.contains(hit)), x, y }
})()`)
check('กดปุ่ม "ล้างตัวกรอง" ได้', !!clearBtn?.ok, clearBtn?.miss ?? '')
if (clearBtn?.ok) {
  for (const type of ['mousePressed', 'mouseReleased'])
    await send('Input.dispatchMouseEvent', { type, x: clearBtn.x, y: clearBtn.y, button: 'left', clickCount: 1 })
}
const cleared = await waitFor(
  `!document.querySelector('.filters__cat')?.value && !document.querySelector('[data-testid="clear-tag"]') && document.querySelectorAll('.tpllist tbody tr').length === ${before.n}`,
  8000,
)
check('ล้างหมดทั้งหมวดและแท็กในครั้งเดียว', cleared)
const afterClear = await evaluate(SNAP)
check('ชิปไฮไลต์หายหมด', afterClear.onChips.length === 0, afterClear.onChips.join(' | '))

console.log('\n[8] มือถือ 390px — ชิปต้องยังกดได้จริง')
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true })
await sleep(700)
await gotoChip('row-tag', sharedTag)
const mobSize = await evaluate(`(() => {
  const el = document.querySelector('[data-testid="row-tag"]')
  if (!el) return null
  const r = el.getBoundingClientRect()
  return { w: Math.round(r.width), h: Math.round(r.height), fs: getComputedStyle(el).fontSize }
})()`)
check('ชิปยังมีขนาดจับได้บนมือถือ', (mobSize?.h ?? 0) >= 20, JSON.stringify(mobSize))
check('ขนาดชิปไม่ใช่ปุ่มใหญ่เต็มบรรทัด', (mobSize?.w ?? 999) <= 260, `${mobSize?.w}px`)
await gotoChip('row-tag', sharedTag)
const mobClick = await clickChip('row-tag', sharedTag)
check('กดชิปแท็กบนมือถือได้จริง (ไม่โดนอย่างอื่นบัง)', !!mobClick?.ok, mobClick?.miss ?? `ถูกบังด้วย ${mobClick?.blockedBy}`)
check('ตัวกรองทำงานบนมือถือด้วย', !!(await waitFor(`!!document.querySelector('[data-testid="clear-tag"]')`, 8000)))
await shot('03-mobile-tag-filter.png')
await clickChip('clear-tag', `แท็ก: ${sharedTag} ✕`)
await waitFor(`!document.querySelector('[data-testid="clear-tag"]')`, 8000)

console.log('\n[9] โหมดรายการ — ชิปต้องกดได้เหมือนกัน')
await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false })
await sleep(500)
const listBtn = await evaluate(`(() => {
  const b = document.querySelector('[data-testid="view-list"]')
  if (!b) return { miss: 'ไม่เจอปุ่มมุมมีรายการ' }
  b.scrollIntoView({ block: 'center' })
  const r = b.getBoundingClientRect()
  return { ok: true, x: r.x + r.width / 2, y: r.y + r.height / 2 }
})()`)
if (listBtn?.ok) {
  for (const type of ['mousePressed', 'mouseReleased'])
    await send('Input.dispatchMouseEvent', { type, x: listBtn.x, y: listBtn.y, button: 'left', clickCount: 1 })
}
check('สลับเป็นมุมมีรายการได้', !!(await waitFor(`!document.querySelector('.tpllist').classList.contains('tpllist--grid')`, 8000)))
await gotoChip('row-tag', sharedTag)
const listClick = await clickChip('row-tag', sharedTag)
check('กดชิปแท็กในโหมดรายการได้', !!listClick?.ok, listClick?.miss ?? listClick?.blockedBy ?? '')
check('ตัวกรองทำงานในโหมดรายการ', !!(await waitFor(`!!document.querySelector('[data-testid="clear-tag"]')`, 8000)))
await shot('04-list-tag-filter.png')

await redis.del(`session:${SID}`)
redis.disconnect()
console.log(`\n── ผ่าน ${pass} · ไม่ผ่าน ${fail} ─────────────────────`)
await send('Browser.close').catch(() => {})
chrome.kill()
ws.close()
process.exit(fail === 0 ? 0 : 1)
