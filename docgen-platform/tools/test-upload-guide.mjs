/**
 * ป็อปอัปอธิบายการอัปโหลดแม่แบบ + ไฟล์ตัวอย่างที่ดาวน์โหลดได้
 *
 *   node --env-file=.env tools/test-upload-guide.mjs
 *
 * ── ต้องผ่าน ───────────────────────────────────────────────────
 * · คลิก "อัปโหลดแม่แบบ" แล้ว popup เปิด (ไม่ใช่กระโดดไปเปิด file picker ทันที)
 * · บอกชัดว่ารองรับเฉพาะ .docx
 * · มีตารางตัวอย่างไวยากรณ์แท็ก พร้อมช่องที่จะได้
 * · ปุ่มดาวน์โหลดชี้ไฟล์ .docx **ที่โหลดได้จริง** และระบบอ่านแท็กออกได้
 * · Escape ปิดได้ · ปุ่ม "เลือกไฟล์" ปิดป็อปอัป
 * · file picker รับเฉพาะ .docx
 * · ลากไฟล์นามสกุลอื่นมา → ต้องถูกปฏิเสธ **ก่อน** อัปโหลด
 * · API ปฏิเสธนามสกุลอื่นด้วย (ฝั่ง client อาจถูกหลอม)
 */
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Redis } from 'ioredis'
import { unzipSync, strFromU8 } from 'fflate'

const WEB = 'http://localhost:3000'
const API = process.env.API_URL ?? 'http://127.0.0.1:4001'
const CHROME = process.env.CHROME_PATH ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const PORT = 9405
const STAMP = Date.now()
const OUT = new URL('../tests/nav-status/output-upload-guide/', import.meta.url)
mkdirSync(OUT, { recursive: true })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let pass = 0
let fail = 0
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`)
  ok ? pass++ : fail++
}

const redis = new Redis(process.env.VALKEY_URL)
const SID = `uguide-${STAMP}`
const HD = { cookie: `docgen_session=${SID}` }
await redis.set(
  `session:${SID}`,
  JSON.stringify({ sub: SID, name: 'ผู้ทดสอบป็อปอัป', email: 'ug@test.local', avatar: '' }),
  'EX',
  900,
)

const profile = mkdtempSync(join(tmpdir(), 'cdp-uguide-'))
const chrome = spawn(
  CHROME,
  ['--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run', '--window-size=1280,950',
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
  if (r.exceptionDetails) {
    throw new Error(JSON.stringify(r.exceptionDetails.exception?.description || r.exceptionDetails.text))
  }
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
  const { writeFileSync } = await import('node:fs')
  writeFileSync(new URL(n, OUT), Buffer.from(data, 'base64'))
}

/** คลิกด้วยเมาส์จริง — ห้ามใช้ element.click() (ข้าม hit-testing) */
const clickSel = async (sel, nth = 0) => {
  const box = await evaluate(`(() => {
    const el = [...document.querySelectorAll(${JSON.stringify(sel)})][${nth}]
    if (!el) return { miss: 'ไม่เจอ ${sel}' }
    el.scrollIntoView({ block: 'center' })
    const r = el.getBoundingClientRect()
    const x = r.x + r.width / 2, y = r.y + r.height / 2
    const hit = document.elementFromPoint(x, y)
    // ⚠️ ต้องรายงานว่า**อะไร**บังอยู่ ไม่ใช่แค่ ok=false
    //   ตอน ok=false เปล่า ๆ ไม่รู้ว่าต้องแก้อะไร → เดาผิดไปหลายรอบ
    // ⚠️ hit === null แปลว่าพิกัดอยู่**นอกจอ** (เช่นกดตอนลิ้นชักยัง
    //   ทรานซิชันไม่เสร็จ) → ต้องนับเป็นล้มเหลว
    //   ถ้าให้ blocker = '' แล้วเอา !blocker เป็น ok จะกลายเป็นผ่านลวง
    const blocker = !hit
      ? 'พิกัดอยู่นอกจอ (' + Math.round(x) + ',' + Math.round(y) + ')'
      : hit !== el && !el.contains(hit)
        ? hit.tagName + (hit.getAttribute('data-testid') ? '[' + hit.getAttribute('data-testid') + ']' : '') +
          (hit.className ? '.' + String(hit.className).split(' ').join('.') : '')
        : ''
    return {
      ok: !blocker, blocker,
      text: (el.textContent || '').trim().slice(0, 24),
      x: Math.round(x), y: Math.round(y), w: Math.round(r.width), h: Math.round(r.height),
    }
  })()`)
  if (!box?.ok) return box
  for (const type of ['mousePressed', 'mouseReleased'])
    await send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 })
  return box
}

// ── ไฟล์ตัวอย่างที่เสิร์ฟจริง ──────────────────────────────────────
console.log('\n[0] ไฟล์ตัวอย่างที่ปุ่มดาวน์โหลดชี้ไป')
const dl = await fetch(`${WEB}/sample-template.docx`)
check('ไฟล์ตัวอย่างตอบ 200', dl.ok, `HTTP ${dl.status}`)
const sample = Buffer.from(await dl.arrayBuffer())
check('เป็นไฟล์ .docx (เริ่มด้วย PK ของ zip)', sample[0] === 0x50 && sample[1] === 0x4b, `${sample.length} ไบต์`)
let sampleTags = []
try {
  const z = unzipSync(new Uint8Array(sample))
  check('แกะ zip ได้', !!z['word/document.xml'], Object.keys(z).join(', '))
  const xml = strFromU8(z['word/document.xml'])
  const text = [...xml.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)].map((m) => m[1]).join('')
  sampleTags = [...new Set([...text.matchAll(/\{([^}]*)\}/g)].map((m) => m[1].trim()))]
    .filter((t) => t.startsWith('d.'))
} catch (e) {
  check('แกะ zip ได้', false, String(e))
}
check(
  'ไฟล์ตัวอย่างมีแท็กที่ระบบอ่านได้จริง',
  sampleTags.length >= 5,
  sampleTags.join(' , '),
)
check(
  'ทุกแท็กอยู่ใน run เดียว (ไม่ถูก Word แบ่งกลางคำ)',
  (() => {
    const z = unzipSync(new Uint8Array(sample))
    const xml = strFromU8(z['word/document.xml'])
    const runs = [...xml.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)].map((m) => m[1])
    return runs.every((r) => !/\{\s*$/.test(r) || /^\s*\}?\s*$/.test(r) === false ? true : true)
      && !runs.some((r) => /\{\s*$/.test(r) || /^\s*d\./.test(r))
  })(),
  'ไม่มี run ที่เปิดวงเล็บแต่ไม่ปิด',
)

await send('Page.enable')
/**
 * ⚠️ ต้องเปิดการดัก file chooser ก่อนกดปุ่มที่เรียก `input.click()`
 *   ไม่งั้น Chrome เปิดกล่องเลือกไฟล์ค้างไว้ แล้วหน้าเว็บรับอินพุตต่อไปไม่ได้เลย
 *   อาการที่เห็น: ขั้นตอนก่อนหน้าผ่านหมด แต่ขั้นตอนหลังคลิกอะไรก็ไม่มีผล
 */
await send('Page.setInterceptFileChooserDialog', { enabled: true })
await send('Runtime.enable')
await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 950, deviceScaleFactor: 1, mobile: false })
await send('Network.setCacheDisabled', { cacheDisabled: true })
await send('Network.setCookie', { name: 'docgen_session', value: SID, url: WEB })
await send('Page.navigate', { url: `${WEB}/studio?_=${STAMP}` })
check('หนารายการโหลดได้', !!(await waitFor(`!!document.querySelector('.tpllist')`, 45000)))

console.log('\n[1] คลิกปุ่มแล้วต้องเปิดป็อปอัป ไม่ใช่ file picker')
const fileInput = await evaluate(`(() => {
  const i = document.querySelector('input[type="file"]')
  return { accept: i?.getAttribute('accept') ?? '(ไม่มี input)' }
})()`)
check('file picker รับเฉพาะ .docx', fileInput?.accept === '.docx', fileInput?.accept)
const clicked = await clickSel('label', 0)
check('คลิกปุ่ม "อัปโหลดแม่แบบ" ได้', !!clicked?.ok, clicked?.miss ?? '')
check('ป็อปอัปเปิด', !!(await waitFor(`!!document.querySelector('[data-testid="upload-guide"]')`, 8000)))
check('กล่องเลือกไฟล์ยังไม่โผล่ (ไม่กระโดดไปเปิด file picker)', !(await evaluate(`!!document.querySelector('input[type="file"]:focus')`)))
await shot('1-guide.png')

console.log('\n[2] เนื้อหาในป็อปอัป')
const body = await evaluate(`(() => {
  const el = document.querySelector('[data-testid="upload-guide"]')
  if (!el) return { miss: 'ไม่เจอ' }
  const t = el.innerText
  return {
    dialog: el.getAttribute('role') === 'dialog' && el.getAttribute('aria-modal') === 'true',
    text: t,
    // จับข้อความจากกล่องแจ้งเรื่องนามสกุลโดยเฉพาะ ไม่ใช่ค้นทั้งป็อปอัป
    // (ถ้าใช้ innerText รวม คำว่า "เฉพาะ" จะไปตรงประโยคอื่นแล้วผ่านลวง)
    fmt: document.querySelector('[data-testid="uguide-format"]')?.innerText ?? '',
    rows: el.querySelectorAll('.uguide__table tbody tr').length,
    dl: el.querySelector('[data-testid="uguide-download"]')?.getAttribute('href') ?? '',
    dlName: el.querySelector('[data-testid="uguide-download"]')?.getAttribute('download') ?? '',
  }
})()`)
check('เป็น dialog แบบ modal (โปรแกรมอ่านหน้าจอต้องรู้)', body?.dialog === true)
check('บอกชัดว่ารองรับเฉพาะ .docx', /รองรับเฉพาะไฟล์ \.docx/.test(body?.fmt ?? '') && /เฉพาะ/.test(body?.fmt ?? ''), '')
check('มีตารางตัวอย่างไวยากรณ์แท็ก', (body?.rows ?? 0) >= 4, `${body?.rows} แถว`)
check('ตารางมีช่อง {d.ผู้รับ} อยู่จริง', (body?.text ?? '').includes('{d.ผู้รับ}'))
check('ตารางมีช่องรายการซ้ำ [i]', (body?.text ?? '').includes('[i]'))
check('ปุ่มดาวน์โหลดชี้ไฟล์ .docx', body?.dl === '/sample-template.docx', body?.dl)
check('ชื่อไฟล์ตอนดาวน์โหลดเป็นชื่อไทย', /แม่แบบตัวอย่าง\.docx$/.test(body?.dlName ?? ''), body?.dlName)

console.log('\n[3] Escape ปิดได้')
await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
check('Escape ปิดป็อปอัป', !!(await waitFor(`!document.querySelector('[data-testid="upload-guide"]')`, 8000)))

console.log('\n[4] ปุ่ม "เลือกไฟล์ .docx" ปิดป็อปอัปก่อนเปิด file picker')
await clickSel('label', 0)
await waitFor(`!!document.querySelector('[data-testid="upload-guide"]')`, 8000)
const pick = await clickSel('[data-testid="uguide-pick"]')
check('กดปุ่มเลือกไฟล์ได้', !!pick?.ok, pick?.miss ?? '')
check('ป็อปอัปปิดแล้ว', !!(await waitFor(`!document.querySelector('[data-testid="upload-guide"]')`, 8000)))
/**
 * ⚠️ ต้อง**ปิด**การดัก file chooser ทิ้งหลังจากนี้
 *   ถ้าค้างไว้ Chrome จะถือว่ายังมีกล่องเลือกไฟล์เปิดอยู่
 *   แล้วคลิกทุกอย่างหลังจากนี้จะไม่มีผล
 *   (เจอตอน [7]: ลิ้นชักเปิดได้ แต่กดปุ่มอัปโหลดแล้วป็อปอัปไม่ขึ้น)
 */
await send('Page.setInterceptFileChooserDialog', { enabled: false })
await sleep(400)

console.log('\n[5] ลากไฟล์นามสกุลอื่นเข้ามา → ต้องถูกปฏิเสธก่อนอัปโหลด')
const beforeDrop = await evaluate(`document.querySelectorAll('.tpllist tbody tr').length`)
const dropRes = await evaluate(`(() => {
  const label = [...document.querySelectorAll('label')].find((l) => l.textContent.includes('อัปโหลดแม่แบบ'))
  if (!label) return { miss: 'ไม่เจอปุ่มอัปโหลด' }
  const dt = new DataTransfer()
  dt.items.add(new File([new Uint8Array([80, 75, 3, 4])], 'ตารางทดสอบ.xlsx', {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  }))
  label.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }))
  return { ok: true }
})()`)
check('ส่ง drop event พร้อมไฟล์ .xlsx ได้', !!dropRes?.ok, dropRes?.miss ?? '')
const warned = await waitFor(
  `[...document.querySelectorAll('.pill.err, .pill--msg')].some((e) => /รองรับเฉพาะไฟล์ \\.docx/.test(e.textContent))`,
  8000,
)
const warnText = await evaluate(
  `([...document.querySelectorAll('.pill.err, .pill--msg')].map((e) => e.textContent).join(' | ') || '').slice(0, 120)`,
)
check('ขึ้นข้อความบอกว่ารองรับเฉพาะ .docx', warned, warnText)
const afterDrop = await evaluate(`document.querySelectorAll('.tpllist tbody tr').length`)
check('ไม่มีแม่แบบใหม่โผล่ขึ้นมา', afterDrop === beforeDrop, `${beforeDrop} → ${afterDrop}`)

console.log('\n[6] API ต้องปฏิเสธด้วย (ฝั่ง client อาจถูกหลอมได้)')
const fd = new FormData()
fd.append('versioning', 'create')
fd.append('file', new Blob([new Uint8Array([80, 75, 3, 4])], { type: 'application/octet-stream' }), 'ตารางทดสอบ.xlsx')
const apiRes = await fetch(`${API}/api/templates`, { method: 'POST', headers: HD, body: fd })
const apiJson = await apiRes.json().catch(() => ({}))
check('API ตอบ 400', apiRes.status === 400, `HTTP ${apiRes.status}`)
check('รหัสบอกว่าไม่รองรับไฟล์', apiJson?.code === 'UNSUPPORTED_FILE', JSON.stringify(apiJson))
check(
  'ข้อความบอกผู้ใช้ว่ารองรับอะไร',
  /รองรับเฉพาะ/.test(apiJson?.message ?? ''),
  apiJson?.message ?? '',
)

console.log('\n[7] จอมือถือ 390px — ป็อปอัพต้องอ่านออกและกดได้')
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: false })
await sleep(600)
// ⚠️ โหลดหน้าใหม่ก่อน — ขั้นตอน [4] เปิด file chooser จริง
//   แม้ดักด้วย Page.setInterceptFileChooserDialog แล้ว Chrome ก็ยังค้างสถานะ
//   ทำให้คลิกทุกอย่างหลังจากนั้นไม่มีผล
await send('Page.navigate', { url: `${WEB}/studio?_m=${STAMP}` })
check('โหลดหน้าใหม่ที่ความกว้างมือถือได้', !!(await waitFor(`!!document.querySelector('[data-testid=\"rail-open\"]')`, 45000)))
check('ผ้าคลุมตอนบูตหายแล้ว (ปุ่มกดได้จริง)',
  !!(await waitFor(`!document.querySelector('.bootveil')`, 45000)),
)
check('รายการมาแล้ว', !!(await waitFor(`document.querySelectorAll('.tpllist tbody tr').length > 0`, 45000)))
await sleep(500)
const openRail = await clickSel('[data-testid="rail-open"]')
check('เปิดลิ้นชักได้บนมือถือ', !!openRail?.ok, openRail?.miss ?? '')
check('ปุ่มอัปโหลดโผล่ในลิ้นชัก', !!(await waitFor("!!document.querySelector('[data-testid=\"studio-rail\"].is-open')", 8000)))
/*
 * ⚠️ เคยมีเช็ค `rect.x >= 0` รอทรานซิชันของลิ้นชักอยู่ตรงนี้
 *   แต่ตกทั้งที่ทุกอย่างถูก (คลิกได้ที่ x=122 และป็อปอัปก็เปิด)
 *   คือเช็คที่ซ้ำกับผลของ clickSel และตัวมันเองไม่น่าเชื่อถือ
 *   → ตัดออก ใช้พิกัดจริงจาก clickSel แทน
 */
/** รอให้ลิ้นชักเลื่อนเข้าที่สุด (CSS: `transition: transform 0.2s`) — ก่อนกดปุ่มข้างใน */
await sleep(500)
if (false) check(
  'ปุ่มอัปโหลดเลื่อนเข้าจอแล้ว (รอทรานซิชันของลิ้นชัก)',
  !!(await waitFor(
    `(() => { const l = [...document.querySelectorAll('label')].find((x) => (x.textContent || '').includes('\u0e2d\u0e1b\u0e42\u0e2b\u0e25\u0e14\u0e41\u0e21\u0e48\u0e2d\u0e1a')); if (!l) return false; const r = l.getBoundingClientRect(); return r.x >= 0 && r.right > 0 })()`,
    8000,
  )),
)
const mobClick = await clickSel('label', 0)
check(
  'กดปุ่มอัปโหลดบนมือถือได้',
  !!mobClick?.ok,
  mobClick?.miss ?? (mobClick?.blocker || 'กดที่ "' + (mobClick?.text ?? '?') + '" @' + mobClick?.x + ',' + mobClick?.y),
)
check('เปิดป็อปอัปบนมือถือได้', !!(await waitFor(`!!document.querySelector('[data-testid="upload-guide"]')`, 8000)))
const innerW = await evaluate('innerWidth')
const mob = await evaluate(`(() => {
  const box = document.querySelector('.uguide__box')
  const btn = document.querySelector('[data-testid="uguide-pick"]')
  if (!box || !btn) return { miss: 'ไม่เจอกล่อง/ปุ่ม' }
  const b = box.getBoundingClientRect(), r = btn.getBoundingClientRect()
  const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)
  return {
    w: Math.round(b.width), h: Math.round(b.height),
    scrollH: box.scrollHeight,
    btnInView: r.bottom <= innerHeight + 1 && r.top >= 0,
    btnOk: !!hit && (hit === btn || btn.contains(hit)),
    btnBlocker: hit && hit !== btn && !btn.contains(hit)
      ? hit.tagName + '.' + String(hit.className || '').split(' ').slice(0, 2).join('.')
      : '',
    btnRect: { t: Math.round(r.top), b: Math.round(r.bottom), l: Math.round(r.left), w: Math.round(r.width), h: Math.round(r.height) },
    overflowX: document.documentElement.scrollWidth - innerWidth,
  }
})()`)
check(
  'กล่องกว้างจนแทบเต็มจอ (เหลือรอบเพียงแถบเลื่อน)',
  (mob?.w ?? 0) >= innerW - 24,
  `${mob?.w}px จากจอ ${innerW}px`,
)
check('ปุ่ม "เลือกไฟล์" ยังอยู่ในจอ (ไม่หลุดล่างจนกดไม่ได้)', mob?.btnInView === true, `สูง ${mob?.h}px / เนื้อหา ${mob?.scrollH}px`)
check(
  'จุดกดปุ่มไม่ถูกอย่างอื่นบัง',
  mob?.btnOk === true,
  mob?.btnBlocker ? 'โดน ' + mob.btnBlocker + ' · ปุ่มที่ ' + JSON.stringify(mob.btnRect) : '',
)
check('หน้าไม่ล้นแนวนอน', (mob?.overflowX ?? 99) <= 0, `ล้น ${mob?.overflowX}px`)
await shot('2-guide-mobile.png')

await redis.del(`session:${SID}`)
redis.disconnect()
console.log(`\n── ผ่าน ${pass} · ไม่ผ่าน ${fail} ─────────────────────`)
await send('Browser.close').catch(() => {})
chrome.kill()
ws.close()
process.exit(fail === 0 ? 0 : 1)
