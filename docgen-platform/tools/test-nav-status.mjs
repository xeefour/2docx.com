/**
 * ทดสอบ "สถานะระหว่างเปลี่ยนหน้า + ช่องคัดลอก URL" ในเบราว์เซอร์จริง ผ่าน CDP
 *
 *   node --env-file=.env tools/test-nav-status.mjs
 *
 * ใช้ CDP เพราะสิ่งที่ต้องพิสูจน์คือ "ตอนช้า ๆ คนใช้เห็นอะไร" ซึ่ง
 * `chrome --dump-dom` จับภาพไม่ได้ — เราต้องคุมความเร็วเครือข่ายแล้วดูสถานะ DOM
 * ในจังหวะเวลาที่กำหนด
 *
 * ทดสอบ 6 ข้อ
 *   1. HTML จากเซิร์ฟเวอร์มีผ้าคลุมตอนเปิดหน้าครั้งแรก (ถ้า JS ตาย ยังไม่ค้าง)
 *   2. แถบ URL แสดง URL ปัจจุบันถูกต้อง
 *   3. ปุ่ม "คัดลอก URL" คัดลอกของจริงลง clipboard
 *   4. ปุ่ม "คัดลอกข้อมูลแก้ปัญหา" ได้ข้อความที่มี URL + เบราว์เซอร์
 *   5. เปลี่ยนหน้าช้า ๆ → เห็นแถบโหลด + ผ้าคลุมที่บอกปลายทาง แล้วหายเองเมื่อถึง
 *   6. เปลี่ยนหน้าค้างเกิน 15 วินาที → ปลดผ้าคลุม ขึ้นคำเตือน + กดแถบ URL ได้แม้ผ้าคลุมบัง
 *      (จุดนี้สำคัญที่สุด เพราะผ้าคลุมบังทั้งหน้า — ถ้าบังแถบ URL ผู้ใช้จะกดคัดลอกไม่ได้ตอนที่ต้องการ)
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Redis } from 'ioredis'

const CHROME = process.env.CHROME_PATH ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const PORT = 9334
const WEB = 'http://localhost:3000'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let pass = 0
let fail = 0
const skipped = []

function check(name, ok, detail = '') {
  if (ok) {
    pass++
    console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ''}`)
  } else {
    fail++
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`)
  }
}
function skip(name, why) {
  skipped.push(`${name} — ${why}`)
  console.log(`  ~ ข้าม: ${name} (${why})`)
}

/* ── 1. HTML จากเซิร์ฟเวอร์ ──────────────────────────────────── */
console.log('\n[1] HTML จากเซิร์ฟเวอร์ (ผ้าคลุมตอนเปิดหน้าครั้งแรก)')
const html = await (await fetch(`${WEB}/`)).text()
check('มี bootveil ใน HTML ที่เซิร์ฟเวอร์ส่งมา', html.includes('bootveil'))
check('มีแถบ URL ใน HTML เดียวกัน', html.includes('urlbar'))

/* ── เตรียม session ให้เบราว์เซอร์เข้า /studio ได้ ─────────── */
const redis = new Redis(process.env.VALKEY_URL)
const sid = `navstatus-${Date.now()}`
await redis.set(
  `session:${sid}`,
  JSON.stringify({ sub: 'navstatus', name: 'navstatus' }),
  'EX',
  900,
)

/* ── เปิด Chrome ───────────────────────────────────────────── */
const profile = mkdtempSync(join(tmpdir(), 'cdp-nav-'))
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
  rmSync(profile, { recursive: true, force: true })
  redis.disconnect()
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
  const msg = JSON.parse(ev.data)
  const slot = waiting.get(msg.id)
  if (!slot) return
  waiting.delete(msg.id)
  msg.error ? slot.reject(new Error(JSON.stringify(msg.error))) : slot.resolve(msg.result)
})
await new Promise((r) => ws.addEventListener('open', r, { once: true }))

const evaluate = async (expr) => {
  const r = await send('Runtime.evaluate', {
    expression: expr,
    returnByValue: true,
    awaitPromise: true,
  })
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text ?? 'evaluate ล้มเหลว')
  return r.result?.value
}

/** คลิกด้วยเมาส์จริงที่พิกัดกึ่งกลางของ element */
const realClick = async (selector) => {
  const box = await evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)})
    if (!el) return null
    el.scrollIntoView({ block: 'center' })
    const r = el.getBoundingClientRect()
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
  })()`)
  if (!box) return false
  for (const type of ['mousePressed', 'mouseReleased']) {
    await send('Input.dispatchMouseEvent', {
      type,
      x: box.x,
      y: box.y,
      button: 'left',
      clickCount: 1,
    })
  }
  return true
}

await send('Page.enable')
await send('Runtime.enable')
await send('Network.enable')
await send('Page.bringToFront')
await send('Emulation.setFocusEmulationEnabled', { enabled: true })
await send('Browser.grantPermissions', {
  origin: WEB,
  permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'],
})
await send('Network.setCookie', {
  name: 'docgen_session',
  value: sid,
  url: WEB,
})

const setLatency = (ms) =>
  send('Network.emulateNetworkConditions', {
    offline: false,
    latency: ms,
    downloadThroughput: 5_000_000,
    uploadThroughput: 2_000_000,
  })

const waitFor = async (expr, timeoutMs, step = 100) => {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    if (await evaluate(expr)) return true
    await sleep(step)
  }
  return false
}

const goHome = async () => {
  await send('Page.navigate', { url: `${WEB}/` })
  // ⚠️ ต้องรอให้ JS ทำงานเสร็จจริง ไม่ใช่รอแค่ DOM
  //    (`.urlbar__toggle` มีอยู่ใน HTML ที่เซิร์ฟเวอร์ส่งมาตั้งแต่แรก
  //     ถ้ารอแค่นั้น เราจะอ่านค่าก่อน hydration เสร็จ แล้วเห็นผ้าคลุมค้าง + ค่าว่าง)
  const ready = await waitFor("!document.querySelector('.bootveil')", 40000, 150)
  if (!ready) throw new Error('หน้าไม่ hydrate — แถบ URL จะเป็นตัวบอกว่า dev server เสีย')
  await waitFor("!!document.querySelector('.urlbar__panel')", 5000, 100)
}

/* ── เปิดหน้าแรก ───────────────────────────────────────────── */
await goHome()

console.log('\n[2] แถบ URL บอกตำแหน่งที่กำลังอยู่')
{
  const s = await evaluate(`({
    path: document.querySelector('.urlbar__path')?.textContent ?? null,
    name: document.querySelector('.urlbar__name')?.textContent ?? null,
    url:  document.querySelector('.urlbar__url')?.textContent ?? null,
    href: location.href,
    boot: !!document.querySelector('.bootveil'),
  })`)
  check('บอก path ว่า /', s.path === '/', `ได้ "${s.path}"`)
  check('บอกชื่อหน้าไทยว่า หน้าแรก', s.name === 'หน้าแรก', `ได้ "${s.name}"`)
  check('แสดง URL เต็มตรงกับ address bar', s.url === s.href, s.url ?? 'ไม่มี')
  check('ผ้าคลุมตอนเปิดหน้าถูกถอดหลัง JS ทำงาน', s.boot === false)
}

console.log('\n[3] ปุ่มคัดลอก URL')
{
  const ok = await evaluate(`(async () => {
    const btns = [...document.querySelectorAll('.urlbar__actions button')]
    const b = btns.find((x) => x.textContent.includes('คัดลอก URL'))
    if (!b) return 'ไม่เจอปุ่ม'
    b.click()
    await new Promise((r) => setTimeout(r, 400))
    return 'กดแล้ว'
  })()`)
  check('เจอปุ่ม "คัดดลอก URL"', ok === 'กดแล้ว', ok)
  try {
    const clip = await evaluate('navigator.clipboard.readText()')
    const href = await evaluate('location.href')
    check('clipboard ได้ URL ตรงกับหน้าปัจจุบัน', clip === href, clip || '(ว่าง)')
  } catch (e) {
    skip('อ่าน clipboard กลับมา', e.message)
  }
}

console.log('\n[4] ปุ่มคัดลอกข้อมูลแก้ปัญหา')
{
  await evaluate(`(async () => {
    const btns = [...document.querySelectorAll('.urlbar__actions button')]
    btns.find((x) => x.textContent.includes('ข้อมูลแก้ปัญหา'))?.click()
    await new Promise((r) => setTimeout(r, 400))
  })()`)
  try {
    const clip = await evaluate('navigator.clipboard.readText()')
    const href = await evaluate('location.href')
    check('มีบรรทัด URL', clip.includes(`URL: ${href}`))
    check('มีข้อมูลเบราว์เซอร์', clip.includes('เบราว์เซอร์:'))
    check('มีเวลาที่กด', clip.includes('เวลา:'))
  } catch (e) {
    skip('อ่าน clipboard กลับมา', e.message)
  }
}

console.log('\n[5] เปลี่ยนหน้าช้า ๆ → เห็นปลายทาง แล้วหายเองเมื่อถึง')
{
  await setLatency(700) // ทำให้ RSC ช้าพอที่ผ้าคลุมจะกาง (>180ms)
  const clicked = await realClick('a[href="/studio"]')
  check('คลิกลิงก์ด้วยเมาส์จริง', clicked)

  let sawBar = false
  let sawVeil = false
  let veilText = ''
  for (let i = 0; i < 40; i++) {
    await sleep(60)
    const s = await evaluate(`({
      bar: !!document.querySelector('.topbar'),
      veil: !!document.querySelector('.veil'),
      text: document.querySelector('.veil__text')?.textContent ?? '',
      path: location.pathname,
    })`)
    sawBar ||= s.bar
    if (s.veil) {
      sawVeil = true
      veilText = s.text
      if (s.path === '/studio') break
    }
    if (s.path === '/studio' && !s.veil) break
  }
  check('เห็นแถบโหลดบนสุดระหว่างเปลี่ยนหน้า', sawBar)
  check('เห็นผ้าคลุมหน้าจอ', sawVeil)
  check('ผ้าคลุมบอกปลายทางว่า Studio', veilText.includes('Studio'), veilText.replace(/\s+/g, ' ').trim())

  // ปลดความหน่วงแล้วรอให้ถึงปลายทาง
  await setLatency(0)
  const arrived = await waitFor("location.pathname === '/studio'", 20000)
  check('ถึงหน้า /studio', arrived)
  const cleared = await waitFor("!document.querySelector('.topbar') && !document.querySelector('.veil')", 3000)
  check('ผ้าคลุมหายเองเมื่อถึงหน้า (ไม่ค้าง)', cleared)
  const after = await evaluate(`({
    path: document.querySelector('.urlbar__path')?.textContent ?? null,
    name: document.querySelector('.urlbar__name')?.textContent ?? null,
  })`)
  check('แถบ URL อัปเดตตามหน้าใหม่', after.path === '/studio' && after.name === 'Studio', `${after.name} ${after.path}`)
}

console.log('\n[6] เปลี่ยนหน้าค้างเกิน 15 วินาที → ต้องปลดผ้าคลุมและยังกดคัดลอก URL ได้')
{
  await goHome()
  await setLatency(18_000) // ช้ากว่า watchdog (15s) ตั้งใจ
  const clicked = await realClick('a[href="/studio"]')
  check('คลิกลิงก์ด้วยเมาส์จริง', clicked)

  const veilUp = await waitFor("!!document.querySelector('.veil')", 3000)
  check('ผ้าคลุมกางระหว่างค้าง', veilUp)

  // รอจน watchdog ทำงาน (15s) — ผ้าคลุมต้องถอดแล้วขึ้นคำเตือนแทน
  const slowShown = await waitFor("!!document.querySelector('.urlbar__slow')", 20000, 250)
  check('หลัง 15 วินาที ผ้าคลุมถอดและขึ้นคำเตือน', slowShown)
  const stillThere = await evaluate("!!document.querySelector('.veil')")
  check('ไม่เหลือผ้าคลุมบังหน้า', stillThere === false)

  // ⚠️ จุดสำคัญ: แถบ URL ต้องไม่ถูกผ้าคลุมบัง มิฉะนั้นกดคัดลอกไม่ได้ตอนที่หน้าค้าง
  const reachable = await evaluate(`(() => {
    const el = document.querySelector('.urlbar__toggle')
    if (!el) return 'ไม่เจอแถบ URL'
    const r = el.getBoundingClientRect()
    const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)
    return top && (top === el || el.contains(top)) ? 'กดได้' : 'ถูกบังโดย ' + (top?.className || top?.tagName)
  })()`)
  check('ผ้าคลุมไม่บังแถบ URL (กดคัดลอกได้ตอนหน้าค้าง)', reachable === 'กดได้', String(reachable))
  const reloadBtn = await evaluate(`[...document.querySelectorAll('.urlbar__panel button')]
    .some((b) => b.textContent.includes('รีเฟรชหน้านี้'))`)
  check('มีปุ่ม "รีเฟรชหน้านี้" ให้ทางออก', reloadBtn === true)

  // ปลดความหน่วง → ต้องถึงปลายทางและปิดสถานะเอง
  await setLatency(0)
  const arrived = await waitFor("location.pathname === '/studio'", 25000)
  check('ปลดช้าแล้วถึง /studio', arrived)
  const cleaned = await waitFor("!document.querySelector('.topbar') && !document.querySelector('.veil')", 3000)
  check('ปิดสถานะเองหลังถึงหน้า', cleaned)
}

/* ── เก็บกวาด ──────────────────────────────────────────────── */
ws.close()
const exited = new Promise((r) => chrome.once('exit', r))
chrome.kill()
await Promise.race([exited, sleep(5000)])
try {
  rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 })
} catch {
  /* เก็บกวาดไม่สำเร็จไม่ใช่ผลทดสอบ */
}
await redis.del(`session:${sid}`)
redis.disconnect()

console.log(`\n──── สรุป: ผ่าน ${pass} · ไม่ผ่าน ${fail} · ข้าม ${skipped.length} ────`)
if (skipped.length) for (const s of skipped) console.log(`  ~ ${s}`)
process.exit(fail === 0 ? 0 : 1)
