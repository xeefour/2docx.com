/** ถ่ายภาพหน้าคู่มือขนาดจอจริง (ไม่ใช่ทั้งหน้า) เพื่อดูหน้าตา */
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CHROME = process.env.CHROME_PATH ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const PORT = 9486
const OUT = 'D:/2docx.com/docgen-platform/tests/nav-status/output-manual/'
mkdirSync(OUT, { recursive: true })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const profile = mkdtempSync(join(tmpdir(), 'cdp-shot-'))
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
await send('Page.enable'); await send('Runtime.enable')

/**
 * ภาพที่ถ่าย — เลื่อนไปหัวข้อที่ต้องการดู
 *
 * อ่าน id หัวข้อจากไฟล์แม่แบบจริงทุกครั้ง
 * ถ้าเขียน id ตายตัวไว้ พอเปลี่ยนชื่อหัวข้อ ภาพจะเลื่อนไปที่หัวข้อแรกแทน
 * โดยไม่มีข้อผิดพลาดให้เห็น (เจอแล้วตอนเปลี่ยน #tags เป็น #text)
 */
const SRC = 'D:/2docx.com/docgen-platform/manual/index.html'
const SECTION_IDS = [...readFileSync(SRC, 'utf8').matchAll(/<section id="([^"]+)"/g)].map((m) => m[1])

/** เลื่อนไปหัวข้อนี้ แล้วเลื่อนต่ออีก n พิกเซล */
const scrollTo = (id, extra = 520) =>
  `document.documentElement.style.scrollBehavior='auto';document.querySelector('#${id}').scrollIntoView({block:'start'});window.scrollBy(0,${extra})`

const shots = [
  { name: 'view-top.png', setup: '' },
  { name: 'view-tags.png', setup: scrollTo(SECTION_IDS[3] ?? SECTION_IDS[0]) },
  { name: 'view-date.png', setup: scrollTo(SECTION_IDS[6] ?? SECTION_IDS[0], 360) },
  { name: 'view-limit.png', setup: scrollTo(SECTION_IDS[12] ?? SECTION_IDS[0], 300) },
  { name: 'view-version.png', setup: scrollTo(SECTION_IDS.find((id) => id === 'version') ?? SECTION_IDS.at(-1), 0) },
  { name: 'view-home.png', setup: '', url: 'http://127.0.0.1:8090/' },
  { name: 'view-mobile.png', setup: '', mobile: true },
]

for (const s of shots) {
  await send('Emulation.setDeviceMetricsOverride', {
    width: s.mobile ? 414 : 1280, height: s.mobile ? 820 : 900,
    deviceScaleFactor: 1, mobile: !!s.mobile,
  })
  await send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-color-scheme', value: 'light' }],
  })
  await send('Page.navigate', { url: s.url ?? 'http://127.0.0.1:8090/docs' })
  await sleep(3000)
  if (s.setup) {
    await send('Runtime.evaluate', { expression: s.setup })
    await sleep(1200)
  }
  const { data } = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(join(OUT, s.name), Buffer.from(data, 'base64'))
  console.log('เขียน ' + s.name)
}

await send('Browser.close').catch(() => undefined)
chrome.kill(); ws.close()
