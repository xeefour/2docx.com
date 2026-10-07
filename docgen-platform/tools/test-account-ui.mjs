/**
 * หน้าบัญชีผู้ใช้ (`/account`) — ทดสอบการแสดงผล + การบันทึกค่าตั้งค่าจริง
 *
 *   node --env-file=../dokploy-infra/.env --env-file=../dokploy-infra/.env.development tools/test-account-ui.mjs
 *
 * คู่กับ `tools/test-account.mjs` (ทดสอบ API) — ไฟล์นี้ทดสอบ**หน้าเว็บ**
 *   ที่ต้องมีเบราว์เซอร์: React render, redirect ตอนยังไม่ล็อกอิน, การกดสวิตช์
 *
 * ทำ session ปลอมใส่ Valkey เองแบบเดียวกับ test-inbox.mjs — ล็อกอินผ่าน Casdoor
 * ต้องเปิดเบราว์เซอร์จริง ไม่คุ้มกับการทดสอบอัตโนมัติ
 */
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateSync } from 'node:zlib'
import { Redis } from 'ioredis'

const WEB = 'http://localhost:3000'
const API = process.env.API_URL ?? 'http://127.0.0.1:4001'
const CHROME = process.env.CHROME_PATH ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const PORT = 9411
const STAMP = Date.now()
const OUT = new URL('../tests/nav-status/output-account/', import.meta.url)
mkdirSync(OUT, { recursive: true })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let pass = 0
let fail = 0
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`)
  ok ? pass++ : fail++
}

const NAME = `ผู้ใช้ทดสอบ ${STAMP}`
const SID = `acctui-${STAMP}`
const redis = new Redis(process.env.VALKEY_URL)
await redis.set(
  `session:${SID}`,
  JSON.stringify({
    sub: SID,
    name: NAME,
    email: 'account-ui@test.local',
    avatar: '',
    affiliation: 'หน่วยงานทดสอบ',
  }),
  'EX',
  900,
)
const H = { cookie: `docgen_session=${SID}` }

// ── สร้าง PNG จริงไว้ในไฟล์ชั่วคราว เพื่อทดสอบอัปโหลดผ่าน file input ──
const CRC_TABLE = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c
  }
  return t
})()
const crc32 = (buf) => {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
function makePng(w = 12, h = 12, rgb = [200, 60, 60]) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length, 0)
    const t = Buffer.from(type, 'ascii')
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0)
    return Buffer.concat([len, t, data, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  const raw = Buffer.alloc(h * (1 + w * 3))
  for (let y = 0; y < h; y++) {
    const off = y * (1 + w * 3)
    raw[off] = 0
    for (let x = 0; x < w; x++) {
      raw[off + 1 + x * 3] = rgb[0]
      raw[off + 2 + x * 3] = rgb[1]
      raw[off + 3 + x * 3] = rgb[2]
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}
const PNG_PATH = join(mkdtempSync(join(tmpdir(), 'cdp-avatar-')), 'avatar.png')
writeFileSync(PNG_PATH, makePng())

// ── CDP ─────────────────────────────────────────────────────────
const profile = mkdtempSync(join(tmpdir(), 'cdp-account-'))
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
if (!wsUrl) {
  chrome.kill()
  await redis.quit()
  throw new Error('เปิด Chrome ไม่ได้')
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
 * กดด้วยเมาส์จริงที่พิกัดที่ JS คำนวณมา
 *
 * ⚠️ ห้ามใช้ `element.click()` — มันเรียก handler โดยไม่ผ่านการชนสิ่งอื่น
 *   คืน `ok: false` ถ้ามีอะไรมาบังปุ่ม ซึ่งคือบั๊กที่ต้องจับได้ (ปุ่มที่ผู้ใช้กดไม่ได้)
 *   `element.click()` จะ "ผ่าน" เสมอ → ทดสอบผ่านทั้งที่หน้าเว็บพัง
 */
const clickJs = async (js) => {
  const box = await evaluate(`(() => { ${js} })()`)
  if (!box?.ok) return box
  for (const type of ['mousePressed', 'mouseReleased'])
    await send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 })
  await sleep(400)
  return box
}
const clickTestId = (id) =>
  clickJs(`
    const el = document.querySelector('[data-testid=${JSON.stringify(id)}]')
    if (!el) return { miss: 'ไม่เจอ ${id}' }
    el.scrollIntoView({ block: 'center' })
    const r = el.getBoundingClientRect()
    const x = r.x + r.width / 2, y = r.y + r.height / 2
    const hit = document.elementFromPoint(x, y)
    return { ok: !!hit && (hit === el || el.contains(hit)), x, y }
  `)
/** คลิกแท็บใน sidebar ตามข้อความ (ปุ่มมี role=tab ไม่มี testid) */
const clickRailTab = (text) =>
  clickJs(`
    const el = [...document.querySelectorAll('[data-testid="account-rail"] [role="tab"]')]
      .find((t) => t.textContent.includes(${JSON.stringify(text)}))
    if (!el) return { miss: 'ไม่เจอแท็บ ' + ${JSON.stringify(text)} }
    el.scrollIntoView({ block: 'center' })
    const r = el.getBoundingClientRect()
    const x = r.x + r.width / 2, y = r.y + r.height / 2
    const hit = document.elementFromPoint(x, y)
    return { ok: !!hit && (hit === el || el.contains(hit)), x, y }
  `)
const goto = async (url) => {
  await send('Page.navigate', { url })
  await sleep(1200)
}

/**
 * เลือกไฟล์ผ่าน file input
 *
 * ⚠️ ห้าม `input.value = ...` เอง — เบราว์เซอร์ไม่ยอมให้ตั้งค่าไฟล์จากสคริปต์
 *   และถ้าฝืนยังไม่เกิด event `change` หน้าเว็บจะไม่รู้ว่าผู้ใช้เลือกไฟล์แล้ว
 *   ต้องใช้ `DOM.setFileInputFiles` ของ CDP ซึ่งเป็นวิธีเดียวที่สร้าง event จริง
 */
const setFileInput = async (testId, path) => {
  const { root } = await send('DOM.getDocument', { depth: 1 })
  const { nodeId } = await send('DOM.querySelector', {
    nodeId: root.nodeId,
    selector: `[data-testid=${JSON.stringify(testId)}]`,
  })
  if (!nodeId) return { miss: `ไม่เจอ ${testId}` }
  await send('DOM.setFileInputFiles', { files: [path], nodeId })
  return { ok: true }
}

/** อ่าน `src` ของรูปโปรไฟล์ — คืน '' ถ้ายังไม่มีรูป (เป็นตัวอักษรแทน) */
const avatarSrc = () =>
  evaluate(`document.querySelector('[data-testid="account-avatar"]')?.getAttribute('src') ?? ''`)

await send('Page.enable')
await send('Runtime.enable')
await send('Network.enable')
await send('DOM.enable')
await send('Network.setCookie', { name: 'docgen_session', value: SID, url: WEB })

try {
  // ── 1. ยังไม่ล็อกอิน ต้องพาไปให้ล็อกอิน ─────────────────────────
  console.log('\n[1] ยังไม่ล็อกอิน')
  {
    await send('Network.clearBrowserCookies')
    await goto(`${WEB}/account`)
    /*
     * ⚠️ ไม่ได้ค้างที่ `/auth/login` — route นั้นตอบ 302 ต่อไป Casdoor ทันที
     *   (`route.ts:64`) → สุดท้ายเบราว์เซอร์ไปอยู่บน host ของ Casdoor
     *   ต้องเช็คปลายทางจริง ไม่ใช่ path กลางทาง
     */
    await waitFor(`location.hostname !== 'localhost'`, 20000)
    const url = await evaluate(`location.href`)
    check('พาไปให้ล็อกอินที่ Casdoor', !url.includes('localhost:3000'), url)
    /**
     * `returnTo` ไม่ได้ส่งตรง ๆ แต่ถูกฝังใน `state` เป็น base64url
     * (`route.ts:57-62`) → ต้องถอดกลับเพื่อยืนยันว่าปลายทางคือ /account
     */
    const back = await evaluate(`
      (() => {
        const s = new URL(location.href).searchParams.get('state') ?? ''
        const tail = s.includes('.') ? s.split('.').slice(1).join('.') : ''
        try { return atob(tail.replace(/-/g, '+').replace(/_/g, '/')) } catch { return '(ถอดไม่ได้: ' + s + ')' }
      })()
    `)
    check('ปลายทางหลังล็อกอินคือ /account', back === '/account', `ได้ ${back}`)
  }

  // ── 2. ล็อกอินแล้ว ต้องเห็นโปรไฟล์ ────────────────────────────
  console.log('\n[2] ล็อกอินแล้ว')
  await send('Network.setCookie', { name: 'docgen_session', value: SID, url: WEB })
  await goto(`${WEB}/account`)
  {
    const got = await waitFor(`!!document.querySelector('[data-testid="account-profile"]')`)
    check('เห็นการ์ดโปรไฟล์', got)
    check('เห็นชื่อผู้ใช้', (await evaluate(`document.body.innerText`)).includes(NAME))
    check('เห็นอีเมล', (await evaluate(`document.body.innerText`)).includes('account-ui@test.local'))
    check('เห็นหน่วยงาน', (await evaluate(`document.body.innerText`)).includes('หน่วยงานทดสอบ'))
    check('เห็น sub (รหัสผู้ใช้)', (await evaluate(`document.body.innerText`)).includes(SID))
    check('ไม่เห็นหน้า error', (await evaluate(`document.body.innerText`)).includes('โหลดข้อมูลไม่สำเร็จ') === false)
    await shot('01-profile.png')
  }

  // ── 3. สถิติครบ 5 ช่อง ────────────────────────────────────────
  console.log('\n[3] สถิติ')
  {
    const labels = await evaluate(`
      [...document.querySelectorAll('[data-testid="account-stats"] > div')].map((d) => d.children[0]?.textContent?.trim())
    `)
    check('มีการ์ดสถิติ 5 ใบ', labels?.length === 5, `ได้ ${labels?.length}: ${JSON.stringify(labels)}`)
    check(
      'มีทั้ง 5 หัวข้อ',
      ['บุ๊กมาร์ก', 'ของตัวเอง', 'เอกสาร', 'แชท', 'จดหมายค้าง'].every((k) =>
        labels.some((l) => l.includes(k)),
      ),
      JSON.stringify(labels),
    )
  }

  // ── 4. สวิตช์ต้องบันทึกจริง ────────────────────────────────────
  console.log('\n[4] บันทึกค่าตั้งค่า')
  {
    const before = (await (await fetch(`${API}/api/account`, { headers: H })).json()).settings
    check('ค่าเริ่มต้นเปิดทั้งสอง', before.notifyOnShare === true && before.notifyOnDocument === true)

    const box = await clickTestId('account-toggle-share')
    check('คลิกสวิตช์ได้ (ไม่มีอะไรบัง)', !!box?.ok, box?.miss ?? '')
    const saved = await waitFor(`!!document.querySelector('[data-testid="account-saved"]')`, 10000)
    check('ขึ้นว่า "บันทึกแล้ว"', saved)
    await shot('02-saved.png')

    const after = (await (await fetch(`${API}/api/account`, { headers: H })).json()).settings
    check('ปิดการแจ้งเตือนการแชร์ได้จริงใน Mongo', after.notifyOnShare === false, JSON.stringify(after))
    check('อีกค่าไม่หายไป', after.notifyOnDocument === true, JSON.stringify(after))
    check('สวิตช์บนหน้าจอตรงกับที่บันทึก', (await evaluate(`document.querySelector('[data-testid="account-toggle-share"]').checked`)) === false)
  }

  // ── 5. ค่าต้องอยู่ข้ามการโหลดหน้าใหม่ ──────────────────────────
  console.log('\n[5] ค่าอยู่ข้ามการรีโหลด')
  {
    await goto(`${WEB}/account`)
    await waitFor(`!!document.querySelector('[data-testid="account-toggle-share"]')`)
    check(
      'สวิตช์ยังเป็นปิดหลังรีโหลด',
      (await evaluate(`document.querySelector('[data-testid="account-toggle-share"]').checked`)) === false,
    )
    // เก็บกวาด: คืนค่าเริ่มต้นไว้ที่เดิม
    await clickTestId('account-toggle-share')
    await sleep(600)
    const back = (await (await fetch(`${API}/api/account`, { headers: H })).json()).settings
    check('คืนค่าเริ่มต้นแล้ว', back.notifyOnShare === true, JSON.stringify(back))
  }

  // ── 6. ลิงก์จากหน้าแรกและ Studio ─────────────────────────────
  // (เดิมมีการตรวจจอเล็กที่นี่ แต่ตอนนี้ sidebar เป็นลิ้นชัก → รวมไว้ที่ [9] แล้ว
  //  ถ้าแยกสองที่ จะได้ตรวจจอเล็กซ้ำและตกคนละจุด)
  console.log('\n[6] ลิงก์เข้า /account')
  {
    await goto(WEB)
    const home = await waitFor(`[...document.querySelectorAll('a')].some((a) => a.getAttribute('href') === '/account')`)
    check('หน้าแรกมีลิงก์ไป /account', home)

    await goto(`${WEB}/studio`)
    const inStudio = await waitFor(`[...document.querySelectorAll('a')].some((a) => a.getAttribute('href') === '/account')`, 20000)
    check('Studio มีลิงก์ไป /account', inStudio)
    await shot('04-studio.png')
  }

  // ── 7. sidebar เหมือน Studio ─────────────────────────────────
  console.log('\n[7] sidebar')
  await goto(`${WEB}/account`)
  await waitFor(`!!document.querySelector('[data-testid="account-rail"]')`)
  {
    check('มี sidebar', await waitFor(`!!document.querySelector('[data-testid="account-rail"]')`))
    check('เขียนชื่อแอปในหัวแถบ', (await evaluate(`document.body.innerText`)).includes('2docx'))

    const items = await evaluate(`
      [...document.querySelectorAll('[data-testid="account-rail"] [role="tab"]')].map((t) => t.textContent.trim())
    `)
    check('มีรายการในเมนู 4 รายการ', items?.length === 4, `ได้ ${items?.length}: ${JSON.stringify(items)}`)
    check(
      'รายการครบ (โปรไฟล์/สถิติ/แจ้งเตือน/บัญชี)',
      ['โปรไฟล์', 'สรุปการใช้งาน', 'การแจ้งเตือน', 'บัญชี'].every((k) => items.some((i) => i.includes(k))),
      JSON.stringify(items),
    )

    // ต้องใช้คลาสของ Studio เดียวกัน ไม่ใช่เขียน CSS ใหม่
    const cls = await evaluate(`document.querySelector('[data-testid="account-rail"]').className`)
    check('ใช้คลาส rail เดียวกับ Studio', cls.includes('rail'), cls)
    check('มี rail__nav (โครงสร้างเดียวกัน)', await waitFor(`!!document.querySelector('.rail__nav')`))
    await shot('05-rail.png')
  }

  // ── 8. กดเมนูแล้วเลื่อนไปถึงส่วนนั้น ──────────────────────────
  console.log('\n[8] กดเมนูใน sidebar แล้วเลื่อน')
  {
    const box = await clickRailTab('การแจ้งเตือน')
    check('คลิกรายการได้', !!box?.ok, box?.miss ?? '')
    await sleep(900)
    check('เลื่อนไปถึงส่วนการแจ้งเตือนแล้ว', await waitFor(`document.querySelector('#sec-notify')?.getBoundingClientRect().top < 200`))
    check('รายการที่เลือกถูกทำเครื่องหมายไว้', await waitFor(`!!document.querySelector('[data-testid="account-rail"] .tabs__tab--on')`))
    await shot('06-section.png')
  }

  // ── 9. เปลี่ยนรูปโปรไฟล์ ─────────────────────────────────────
  console.log('\n[9] เปลี่ยนรูปโปรไฟล์')
  {
    check('เริ่มต้นยังไม่มีรูปที่อัปโหลด', await avatarSrc() === '', `ได้ "${await avatarSrc()}"`)

    const picked = await setFileInput('account-avatar-input', PNG_PATH)
    check('เลือกไฟล์ผ่าน file input ได้', !!picked?.ok, picked?.miss ?? '')

    const changed = await waitFor(`document.querySelector('[data-testid="account-avatar"]')?.getAttribute('src')?.includes('/api/account/avatar')`, 15000)
    check('รูปเปลี่ยนเป็นของที่อัปโหลด', changed, `src="${await avatarSrc()}"`)

    // ต้องตรงกับที่เก็บจริงใน S3 — ยืนยันว่าหน้าเว็บไม่ได้แค่โชว์ภาพทันทีโดยไม่บันทึก
    const r = await fetch(`${API}/api/account/avatar`, { headers: H })
    check('รูปถูกบันทึกไว้จริง', r.status === 200, `ได้ ${r.status}`)
    check('content-type เป็น image/png', r.headers.get('content-type') === 'image/png', r.headers.get('content-type'))
    check('รูปบนหน้าโหลดได้จริง (ไม่ใช่รูปเสีย)', await evaluate(`
      (() => {
        const img = document.querySelector('[data-testid="account-avatar"]')
        return !!img && img.complete && img.naturalWidth > 0
      })()
    `))
    check('รูปใน sidebar เปลี่ยนตามด้วย', await evaluate(`
      !!document.querySelector('[data-testid="account-avatar-rail"]')?.getAttribute('src')?.includes('/api/account/avatar')
    `))
    await shot('07-avatar.png')

    // ค่าต้องอยู่ข้ามการรีโหลด
    await goto(`${WEB}/account`)
    await waitFor(`!!document.querySelector('[data-testid="account-avatar"]')`)
    check('รูปยังอยู่หลังรีโหลด', (await avatarSrc()).includes('/api/account/avatar'), `src="${await avatarSrc()}"`)
    check('มีปุ่มลบรูป', await waitFor(`!!document.querySelector('[data-testid="account-avatar-remove"]')`))

    // ลบแล้วกลับไปเป็นตัวอักษรแทน
    const del = await clickTestId('account-avatar-remove')
    check('คลิกลบรูปได้', !!del?.ok, del?.miss ?? '')
    const gone = await waitFor(`!document.querySelector('[data-testid="account-avatar"]')`, 15000)
    check('รูปหายไป กลับเป็นตัวอักษรแทน', gone, `src="${await avatarSrc()}"`)

    const after = await fetch(`${API}/api/account/avatar`, { headers: H })
    check('รูปถูกลบจากที่เก็บจริง', after.status === 404, `ได้ ${after.status}`)
  }

  // ── 10. sidebar บนจอเล็กต้องเป็นลิ้นชัก ───────────────────────
  console.log('\n[10] จอเล็ก 390px — sidebar เป็นลิ้นชัก')
  {
    await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true })
    await goto(`${WEB}/account`)
    await waitFor(`!!document.querySelector('[data-testid="account-rail"]')`)
    {
      const hiddenAtFirst = await evaluate(`
        (() => {
          const r = document.querySelector('[data-testid="account-rail"]')
          return r.getBoundingClientRect().left < 0
        })()
      `)
      check('จอเล็ก: sidebar ซ่อนอยู่', hiddenAtFirst)

      const open = await clickTestId('rail-open')
      check('จอเล็ก: กดปุ่ม "เมนู" เปิดลิ้นชักได้', !!open?.ok, open?.miss ?? '')
      const opened = await waitFor(`
        document.querySelector('[data-testid="account-rail"]').getBoundingClientRect().left >= -1
      `, 5000)
      check('จอเล็ก: ลิ้นชักเปิดออกมา', opened)
      await shot('08-mobile-rail.png')

      // กดรายการในเมนูแล้วลิ้นชักต้องปิดเอง (ไม่งั้นบังเนื้อหาที่จะไปอ่าน)
      const box = await clickRailTab('บัญชี')
      check('จอเล็ก: กดรายการในลิ้นชักได้', !!box?.ok, box?.miss ?? '')
      await sleep(900)
      check(
        'จอเล็ก: ลิ้นชักปิดเองหลังเลือก',
        await waitFor(`document.querySelector('[data-testid="account-rail"]').getBoundingClientRect().left < 0`, 5000),
      )

      const over = await evaluate(`document.documentElement.scrollWidth - document.documentElement.clientWidth`)
      check('จอเล็ก: หน้าไม่ล้นแนวนอน', over <= 1, `ล้น ${over}px`)
    }
    await send('Emulation.clearDeviceMetricsOverride')
  }
} finally {
  // เก็บกวาด: session ปลอม + ค่าตั้งค่า + รูปที่ทดสอบอัปโหลดไว้
  await fetch(`${API}/api/account/settings`, {
    method: 'PUT',
    headers: { ...H, 'content-type': 'application/json' },
    body: JSON.stringify({ notifyOnShare: true, notifyOnDocument: true }),
  }).catch(() => {})
  // ⚠️ ห้ามใส่ content-type — ไม่มี body (Fastify จะตอบ 500)
  await fetch(`${API}/api/account/avatar`, { method: 'DELETE', headers: H }).catch(() => {})
  await redis.del(`session:${SID}`)
  await redis.quit()
  try { await send('Browser.close') } catch {}
  chrome.kill()
}

console.log(`\n── ผ่าน ${pass} · ไม่ผ่าน ${fail} ─────────────────────`)
process.exit(fail ? 1 : 0)
