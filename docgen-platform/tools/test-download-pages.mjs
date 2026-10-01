/**
 * ตรวจการเลือกหน้า + ดาวน์โหลดรวม ZIP
 *
 *   node --env-file=.env tools/test-download-pages.mjs
 *
 * ── สิ่งที่ต้องผ่าน ────────────────────────────────────────────
 * 1. เมนูดาวน์โหลดมีช่องเลือกหน้า และนับหน้ารวมตรงกับตัวอย่างจริง
 * 2. พิมพ์ช่วงหน้า (`2-3`) แล้วจำนวนที่เลือกเปลี่ยนตาม
 * 3. พิมพ์ผิด (`99`) → ขึ้นข้อความบอกเหตุผล และกดดาวน์โหลดไม่ได้
 * 4. ปุ่มลัด ทุกหน้า / หน้าแรก / ไม่เอาปก ทำงาน
 * 5. ชี้ที่ Word → บอกตรง ๆ ว่า Word ตัดหน้าไม่ได้ (ไม่ปล่อยให้เลือกแล้วไม่มีผล)
 * 6. ดาวน์โหลด ZIP → ไฟล์ .zip บนดิสก์ เปิดอ่านได้ และมีรูปครบตามหน้าที่เลือก
 * 7. ดาวน์โหลด PDF + เลือกหน้า → ไฟล์ PDF ที่เหลือ**เฉพาะหน้าที่เลือกจริง**
 *
 * ⚠️ ข้อ 6–7 ต้องการเอกสารหลายหน้า ถ้าแม่แบบที่เปิดมีหน้าเดียว
 *    จะข้ามและ**ไม่นับว่าผ่าน** (ไม่ใช่ผ่านแบบเงียบ ๆ)
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Redis } from 'ioredis'
import { unzipSync } from 'fflate'
import { PDFDocument } from 'pdf-lib'

const CHROME = process.env.CHROME_PATH ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const PORT = 9365
const WEB = 'http://localhost:3000'
const OUT = new URL('../tests/nav-status/output-download-pages/', import.meta.url)
const DL = mkdtempSync(join(tmpdir(), 'dl-pages-'))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
mkdirSync(OUT, { recursive: true })

let pass = 0
let fail = 0
let skip = 0
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`)
  ok ? pass++ : fail++
}
const skipCheck = (name, why) => {
  console.log(`  ~ ข้าม: ${name} — ${why}`)
  skip++
}

const redis = new Redis(process.env.VALKEY_URL)
const sid = `dlpage-${Date.now()}`
await redis.set(
  `session:${sid}`,
  JSON.stringify({ sub: sid, name: 'ผู้ทดสอบเลือกหน้า', email: 'dlpage@test.local', avatar: '' }),
  'EX',
  2400,
)
const H = { cookie: `docgen_session=${sid}`, 'content-type': 'application/json' }
const API = 'http://127.0.0.1:4001'

/**
 * เลือกแม่แบบที่น่าจะหลายหน้า
 *
 * ⚠️ ชื่อแม่แบบไม่ใช่ข้อเท็จจริงที่รับประกัน — แม่แบบจริงอาจเปลี่ยนไป
 *    เทสต์จึงวัดจำนวนหน้าจริงหลังเรนเดอร์ แล้วตัดสินใจว่าจะทดสอบต่อไหม
 */
const templates = (await (await fetch(`${API}/api/templates`, { headers: H })).json()).items ?? []
const prefer = ['หัวกระดาษ', 'สำเนา 1', 'อำเภอเนินมะปราง']
const picked =
  prefer.map((w) => templates.find((t) => (t.name ?? '').includes(w))).find(Boolean) ?? templates[0]
const key = String(picked?.id ?? '')
console.log(`ใช้แม่แบบ: ${picked?.name} (key ${key})`)

const profile = mkdtempSync(join(tmpdir(), 'cdp-dlpage-'))
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
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
    wsUrl = list.find((x) => x.type === 'page')?.webSocketDebuggerUrl
  } catch { /* ยังไม่พร้อม */ }
}
if (!wsUrl) {
  console.log('✗ ต่อ Chrome DevTools ไม่ได้')
  chrome.kill()
  process.exit(1)
}

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
  const m = JSON.parse(ev.data)
  // จับ error ที่หน้าเว็บโยนออกมา — ดาวน์โหลด PDF เป็นงาน async
  // ถ้าโค้ดพังจะไม่มีวันเห็นผลใน DOM เลย ต้องดูตรงนี้
  if (m.method === 'Runtime.exceptionThrown') {
    console.log('  [หน้าเว็บโยน error]', String(m.params.exceptionDetails?.exception?.description ?? m.params.exceptionDetails?.text ?? '').slice(0, 400))
  }
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
    console.log('  [หน้าเว็บ console.error]', (m.params.args ?? []).map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 400))
  }
  const s = waiting.get(m.id)
  if (!s) return
  waiting.delete(m.id)
  m.error ? s.reject(new Error(JSON.stringify(m.error))) : s.resolve(m.result)
})
await new Promise((r) => ws.addEventListener('open', r, { once: true }))

const evaluate = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text ?? 'evaluate ล้มเหลว')
  return r.result?.value
}
const waitFor = async (expr, timeoutMs = 30000, step = 200) => {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    try {
      if (await evaluate(expr)) return true
    } catch { /* กำลัง navigate */ }
    await sleep(step)
  }
  return false
}
const shot = async (name) => {
  const { data } = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(new URL(name, OUT), Buffer.from(data, 'base64'))
}
/** คลิกด้วยเมาส์จริง (ตรวจ `elementFromPoint` ด้วย — ถ้ามีอย่างอื่นบังก็ไม่กด) */
const realClick = async (selector, nth = 0) => {
  const box = await evaluate(`(() => {
    const el = document.querySelectorAll(${JSON.stringify(selector)})[${nth}]
    if (!el) return null
    const pop = el.closest('.dl__pop')
    ;(pop ?? el).scrollIntoView({ block: 'center', inline: 'center' })
    const r = el.getBoundingClientRect()
    const x = r.x + r.width / 2, y = r.y + r.height / 2
    const hit = document.elementFromPoint(x, y)
    return { ok: !!hit && (el.contains(hit) || hit === el), x, y }
  })()`)
  if (!box?.ok) return false
  for (const type of ['mousePressed', 'mouseReleased'])
    await send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 })
  return true
}
/** คลิกด้วยเมาส์จริงที่หาจากข้อความบนปุ่ม */
const clickText = async (text, sel = 'button') => {
  const box = await evaluate(`(() => {
    const el = [...document.querySelectorAll(${JSON.stringify(sel)})]
      .find((x) => (x.textContent || '').includes(${JSON.stringify(text)}))
    if (!el) return null
    el.scrollIntoView({ block: 'center' })
    const r = el.getBoundingClientRect()
    const x = r.x + r.width / 2, y = r.y + r.height / 2
    const hit = document.elementFromPoint(x, y)
    return { ok: !!hit && (el.contains(hit) || hit === el), x, y }
  })()`)
  if (!box?.ok) return false
  for (const type of ['mousePressed', 'mouseReleased'])
    await send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 })
  return true
}
const setRange = async (text) =>
  evaluate(`(() => {
    const el = document.querySelector('.dl__rangeinput')
    if (!el) return false
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    setter.call(el, ${JSON.stringify(text)})
    el.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })()`)
/**
 * เลื่อนเมาส์ไปวางเหนือปุ่ม (ไม่กด)
 *
 * ⚠️ React ผูก `onMouseEnter` ผ่านการฟัง `mouseover`/`mouseout` ที่ document
 *    การยิง `dispatchEvent(new MouseEvent('mouseenter'))` แบบสังเคราะห์จะไม่มีผล
 *    ต้องใช้เมาส์จริงผ่าน CDP เหมือนการกด
 *
 * ⚠️ ห้ามใช้ `realClick` ตรงนี้ — มันจะกดปุ่มจริงแล้วเริ่มดาวน์โหลดทันที
 */
/**
 * เลื่อนเมาส์ไปวางเหนือปุ่ม (ไม่กด) แล้วยืนยันว่าเบราว์เซอร์มองว่าเมาส์ทับจริง
 *
 * ⚠️ React ผูก `onMouseEnter` ผ่านการฟัง `mouseover`/`mouseout` ที่ document
 *    การยิง `dispatchEvent(new MouseEvent('mouseenter'))` แบบสังเคราะห์จะไม่มีผล
 *    ต้องใช้เมาส์จริงผ่าน CDP เหมือนการกด
 *
 * ⚠️ ต้องย้ายออกก่อนแล้วค่อยกลับเข้า ไม่งั้นถ้าตำแหน่งเดิมทับกัน
 *    เบราว์เซอร์จะไม่ยิง `mouseover` ซ้ำ → React ไม่อัปเดต state
 *
 * ⚠️ ต้องยืนยัน `:hover` และลองใหม่ได้ — ถ้าป๊อปโอเวอร์เพิ่งย้ายตำแหน่ง
 *    (เช่นหลังสลับหน่วย) พิกัดที่วัดไว้อาจเก่าไปแล้ว
 *    เคยตกเพราะเรื่องนี้ แต่เมาส์จริง hover ได้ปกติ
 *
 * ⚠️ ห้ามใช้ `realClick` ตรงนี้ — มันจะกดปุ่มจริงแล้วเริ่มดาวน์โหลดทันที
 */
const hoverText = async (text, sel = '.dl__opt') => {
  for (let attempt = 0; attempt < 3; attempt++) {
    const box = await evaluate(`(() => {
      const el = [...document.querySelectorAll(${JSON.stringify(sel)})]
        .find((x) => (x.textContent || '').includes(${JSON.stringify(text)}))
      if (!el) return null
      el.scrollIntoView({ block: 'center' })
      const r = el.getBoundingClientRect()
      return {
        x: r.x + r.width / 2, y: r.y + r.height / 2,
        ok: el.matches(':hover'),
      }
    })()`)
    if (!box) return false
    if (box.ok) return true // ทับอยู่แล้ว
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 4, y: 4 })
    await sleep(150)
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y })
    await sleep(350)
    if (await evaluate(`[...document.querySelectorAll(${JSON.stringify(sel)})]
        .find((x) => (x.textContent || '').includes(${JSON.stringify(text)}))?.matches(':hover') ?? false`)) {
      return true
    }
  }
  return false
}
/**
 * ไฟล์ที่ดาวน์โหลดจริง
 *
 * ⚠️ ต้องตัด `.crdownload` (ไฟล์กำลังเขียน) และ `downloads.htm` ทิ้ง
 *    Chrome สร้างไฟล์ .htm ของหน้า chrome://downloads ไว้ในโฟลเดอร์เดียวกัน
 *    ถ้านับรวมจะไปรวมกับของจริง
 */
const listDownloads = () =>
  readdirSync(DL).filter((f) => !f.endsWith('.crdownload') && !f.endsWith('.htm'))

/** รอให้ไฟล์ดาวน์โหลดครบ (นับจากตอนกด) */
const waitFile = async (ext, timeoutMs = 180_000) => {
  const end = Date.now() + timeoutMs
  const seen = new Set()
  while (Date.now() < end) {
    const files = readdirSync(DL).filter((f) => f.toLowerCase().endsWith(ext) && !f.endsWith('.crdownload'))
    for (const f of files) if (!seen.has(f) && statSync(join(DL, f)).size > 0) seen.add(f)
    if (files.length > 0 && files.every((f) => !f.endsWith('.crdownload'))) {
      await sleep(700) // ให้ไฟล์สุดท้ายเขียนเสร็จ
      return files
    }
    await sleep(400)
  }
  return []
}

await send('Page.enable')
await send('Runtime.enable')
await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false })
await send('Network.setCookie', { name: 'docgen_session', value: sid, url: WEB })
await send('Network.setCacheDisabled', { cacheDisabled: true })
await send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: DL })

// ── เปิดแม่แบบ + เรนเดอร์ ─────────────────────────────────────────
console.log('\n[0] เปิดแม่แบบแล้วเรนเดอร์ตัวอย่าง')
await send('Page.navigate', { url: `${WEB}/studio/${key}?tabs=form&pane=preview` })
await waitFor("!!document.querySelector('.dl__btn')", 45000)
await sleep(600)
await clickText('เรนเดอร์ตัวอย่าง')
/**
 * ⚠️ ต้องเช็คทั้ง width และ height ที่มากกว่า 400
 *    `<canvas>` ที่ยังไม่เคยวาดมีขนาดเริ่มต้น 300×150 → เช็คแค่ `width > 200` ผ่านมั่ว
 */
const rendered = await waitFor(
  "(() => { const c = document.querySelector('.docpage canvas'); return !!c && c.width > 400 && c.height > 400 })()",
  120000,
)
check('เรนเดอร์ตัวอย่างสำเร็จ', rendered)
if (!rendered) {
  await shot('99-failed.png')
  console.log(`\n── ผ่าน ${pass} · ไม่ผ่าน ${fail} ─────────────────────\n`)
  process.exit(1)
}

// ── 1. ช่องเลือกหน้า ─────────────────────────────────────────────
console.log('\n[1] ช่องเลือกหน้าในเมนูดาวน์โหลด')
await realClick('.dl__btn')
check('เปิดเมนูได้', await waitFor("!!document.querySelector('.dl__pop')", 8000))
check('มีช่องพิมพ์ช่วงหน้า', await evaluate("!!document.querySelector('.dl__rangeinput')"))
const countText = await evaluate("document.querySelector('.dl__count')?.textContent ?? ''")
const total = Number(countText.match(/(\d+)/)?.[1] ?? 0)
check('บอกจำนวนหน้ารวม', total > 0, countText)
/**
 * ⚠️ พรีวิวแสดง**ทีละหน้า** มีตัวบอก "หน้า 1 / 3" และแถบรูปย่อด้านล่าง
 *    ดังนั้น `document.querySelectorAll('.docpage canvas').length` จะเป็น 1 เสมอ
 *    นับ canvas แล้วเทียบกับเมนู = เทสต์ผิด ไม่ใช่แอปผิด
 *    ต้องอ่านตัวเลขจากตัวบอกตำแหน่งของพรีวิวเอง
 */
const previewLabel = await evaluate(
  "document.querySelector('.doctools .muted')?.textContent?.trim() ?? ''",
)
const previewTotal = Number(previewLabel.match(/\/\s*(\d+)/)?.[1] ?? 0)
check('จำนวนหน้าตรงกับตัวบอกหน้าในพรีวิว', total === previewTotal, `เมนูบอก ${total} · พรีวิว "${previewLabel}"`)
check('พรีวิววาดครบทีละหน้า (ไม่ใช่ทุกหน้าพร้อมกัน)', previewTotal > 0 && (await evaluate("document.querySelectorAll('.docpage canvas').length")) === 1)
check('เริ่มต้นเป็นทุกหน้า', countText.includes('ทั้งหมด'), countText)
const opts = await evaluate("[...document.querySelectorAll('.dl__opt')].map((b) => b.innerText.replace(/\\n+/g, ' ').trim())")
check('มีตัวเลือก ZIP', opts.some((o) => o.includes('ZIP')), opts.join(' | '))
check('มี 4 รูปแบบ (PDF · Word · รูป · ZIP)', opts.length === 4, `${opts.length}`)
await shot('01-menu.png')

// ── 2. พิมพ์ช่วงหน้า ────────────────────────────────────────────
console.log('\n[2] พิมพ์ช่วงหน้า — จำนวนที่เลือกต้องเปลี่ยน')
if (total >= 3) {
  await setRange('2-3')
  await sleep(400)
  const c2 = await evaluate("document.querySelector('.dl__count')?.textContent ?? ''")
  check('เลือก 2 หน้า', c2 === '2 จาก ' + total + ' หน้า', c2)
  const hint = await evaluate("document.querySelector('.dl__hint')?.textContent ?? ''")
  check('ใบ้ว่าจะได้กี่หน้า', hint.includes('จะได้ 2 หน้า'), hint)
  const pngOpt = await evaluate("[...document.querySelectorAll('.dl__opt')].find(b => b.innerText.includes('รูปภาพ'))?.innerText.replace(/\\n+/g,' ').trim()")
  check('ป้ายกำกับบอกว่าเหลือหน้าที่เลือก', /2 หน้าที่เลือก/.test(pngOpt ?? ''), pngOpt)
} else {
  skipCheck('เลือกช่วงหน้า', `เอกสารมี ${total} หน้า`)
}
await shot('02-range.png')

// ── 3. พิมพ์ผิด ─────────────────────────────────────────────────
console.log('\n[3] พิมพ์ผิด — ต้องบอกเหตุผล ไม่ใช่เงียบ')
await setRange('99')
await sleep(400)
const err = await evaluate("document.querySelector('.dl__hint--err')?.textContent ?? ''")
check('ขึ้นข้อความบอกว่าเอกสารมีกี่หน้า', err.includes(`เอกสารมีแค่ ${total} หน้า`), err)
await shot('03-bad-range.png')
await setRange('')
await sleep(300)

// ── 4. ปุ่มลัด ─────────────────────────────────────────────────
console.log('\n[4] ปุ่มลัดเลือกหน้า')
await clickText('หน้าแรก', '.dl__quick button')
await sleep(300)
check('ปุ่ม "หน้าแรก" ได้ 1 หน้า', (await evaluate("document.querySelector('.dl__count')?.textContent ?? ''")).includes('1 จาก'))
await clickText('ทุกหน้า', '.dl__quick button')
await sleep(300)
check('ปุ่ม "ทุกหน้า" กลับเป็นทั้งหมด', (await evaluate("document.querySelector('.dl__count')?.textContent ?? ''")).includes('ทั้งหมด'))
if (total > 1) {
  await clickText('ไม่เอาปก', '.dl__quick button')
  await sleep(300)
  check('ปุ่ม "ไม่เอาปก" ตัดหน้าแรกออก', (await evaluate("document.querySelector('.dl__count')?.textContent ?? ''")).includes(`${total - 1} จาก`))
  await clickText('ทุกหน้า', '.dl__quick button')
  await sleep(200)
}

// ── 5. Word ตัดหน้าไม่ได้ ───────────────────────────────────────
console.log('\n[5] ชี้ที่ Word — ต้องบอกว่าเลือกหน้าไม่ได้')
await hoverText('Word')
// แยกให้ออกว่า "เมาส์ไม่ได้ hover" หรือ "hover แล้วแต่ React ไม่อัปเดต"
// ถ้าสองอย่างนี้ต่างกัน แปลว่าเป็นบั๊กที่ผู้ใช้เมาส์จะเจอด้วย
const hovered = await evaluate(
  "!!document.querySelector('.dl__opt:nth-of-type(2)')?.matches(':hover')",
)
const wordHint = await evaluate("document.querySelector('.dl__hint')?.textContent ?? ''")
check('เมาส์จริง hover ทับปุ่ม Word', hovered === true, `:hover=${hovered}`)
if (!wordHint.includes('จัดหน้าใหม่')) {
  // hover ไม่ติด แต่ปุ่มเป็น <button> จริง → ใช้ Tab เดินได้ ทดสอบเส้นทางนี้แทน
  await evaluate("document.querySelectorAll('.dl__opt')[1]?.focus()")
  await sleep(300)
}
const wordHint2 = await evaluate("document.querySelector('.dl__hint')?.textContent ?? ''")
check('บอกว่า Word ไม่ใช้การเลือกหน้า', wordHint2.includes('Word') && wordHint2.includes('จัดหน้าใหม่'), wordHint2)
check(
  'ยังไม่เริ่มดาวน์โหลดอะไร (แค่ชี้ ไม่ใช่กด)',
  listDownloads().length === 0,
  listDownloads().join(', '),
)
await shot('04-word-hint.png')
await hoverText('PDF')

// ── 6. ดาวน์โหลด ZIP ────────────────────────────────────────────
console.log('\n[6] ดาวน์โหลด ZIP — ต้องได้ไฟล์เดียวที่เปิดได้')
if (total >= 2) {
  const want = Math.min(2, total)
  await setRange(`1-${want}`)
  await sleep(400)
  const zipOpt = await evaluate(`(() => {
    const el = [...document.querySelectorAll('.dl__opt')].find((b) => b.innerText.includes('ZIP'))
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
  })()`)
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: zipOpt.x, y: zipOpt.y, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: zipOpt.x, y: zipOpt.y, button: 'left', clickCount: 1 })

  const files = await waitFile('.zip')
  check('ได้ไฟล์ .zip บนดิสก์', files.length === 1, files.join(', '))
  if (files.length) {
    const path = join(DL, files[0])
    const bytes = new Uint8Array(readFileSync(path))
    check('ไฟล์ไม่ว่าง', bytes.length > 0, `${bytes.length} ไบต์`)
    const entries = unzipSync(bytes)
    const names = Object.keys(entries)
    check('เปิด ZIP ได้', names.length > 0, names.join(', '))
    check(`มีรูปครบ ${want} หน้า`, names.length === want, `${names.length} ไฟล์`)
    check('ชื่อไฟล์บอกเลขหน้า', names.every((n) => /หน้า\d+\.png$/.test(n)), names.join(', '))
    const allPng = Object.values(entries).every((d) => d[0] === 0x89 && d[1] === 0x50)
    check('ข้างในเป็น PNG จริง (magic %PNG)', allPng)
    const onePng = Object.values(entries)[0]
    check('รูปไม่ใช่ไฟล์ว่าง', onePng && onePng.length > 2000, `${onePng?.length ?? 0} ไบต์`)
  }
  await shot('05-after-zip.png')
} else {
  skipCheck('ดาวน์โหลด ZIP', `เอกสารมี ${total} หน้า`)
}

// ── 7. ดาวน์โหลด PDF เฉพาะหน้าที่เลือก ───────────────────────────
console.log('\n[7] ดาวน์โหลด PDF + เลือกหน้า — ต้องเหลือเฉพาะหน้าที่เลือก')
if (total >= 2) {
  await realClick('.dl__btn')
  await waitFor("!!document.querySelector('.dl__pop')", 8000)
  await setRange('1')
  await sleep(300)
  const pdfOpt = await evaluate(`(() => {
    const el = [...document.querySelectorAll('.dl__opt')].find((b) => b.innerText.includes('PDF'))
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
  })()`)
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pdfOpt.x, y: pdfOpt.y, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pdfOpt.x, y: pdfOpt.y, button: 'left', clickCount: 1 })

  const files = await waitFile('.pdf')
  if (!files.length) {
    // เปิดเมนูดูข้อความสถานะ/ข้อผิดพลาดที่ UI รายงานไว้
    await realClick('.dl__btn').catch(() => {})
    await sleep(500)
    const msg = await evaluate("document.querySelector('.dl__status')?.textContent ?? '(ไม่มีข้อความ)'")
    check('ได้ไฟล์ .pdf', false, `UI บอก: ${msg}`)
  } else {
    check('ได้ไฟล์ .pdf', true, files.join(', '))
  }
  if (files.length) {
    const path = join(DL, files[0])
    const bytes = new Uint8Array(readFileSync(path))
    check('ไฟล์เป็น PDF จริง (magic %PDF-)', String.fromCharCode(...bytes.slice(0, 5)) === '%PDF-')
    const doc = await PDFDocument.load(bytes)
    check('เหลือ 1 หน้า ตามที่เลือก', doc.getPageCount() === 1, `ได้ ${doc.getPageCount()} หน้า`)
    check('ชื่อไฟล์บอกหน้าที่ตัด', /หน้า1\.pdf$/.test(files[0]), files[0])
  }
  await shot('06-after-pdf.png')
} else {
  skipCheck('ดาวน์โหลด PDF เฉพาะหน้า', `เอกสารมี ${total} หน้า`)
}

await send('Browser.close').catch(() => {})
chrome.kill()
await redis.del(`session:${sid}`)
redis.disconnect()

console.log(`\n── ผ่าน ${pass} · ไม่ผ่าน ${fail} · ข้าม ${skip} ─────────────────────`)
console.log(`ไฟล์ที่ดาวน์โหลด: ${DL}`)
console.log(`ภาพ: ${OUT.pathname}\n`)
process.exit(fail ? 1 : 0)
