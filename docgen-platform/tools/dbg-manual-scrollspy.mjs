/** วินิจฉัย scrollspy: วัด rect + สัดส่วนการทับกันหลังเลื่อนไปที่ #fmt */
import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CHROME = process.env.CHROME_PATH ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const PORT = 9484
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const profile = mkdtempSync(join(tmpdir(), 'cdp-dbg-'))
const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
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
const ev = async (e) => {
  const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true })
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text)
  return r.result?.value
}

await send('Page.navigate', { url: 'http://127.0.0.1:8090/docs' })
await sleep(2500)

await ev(`(() => {
  document.documentElement.style.scrollBehavior = 'auto'
  document.querySelector('#fmt').scrollIntoView({ block: 'start' })
})()`)
await sleep(1800)

const dump = await ev(`(() => {
  const vh = innerHeight
  const top = 70, bottom = vh * 0.45
  return {
    vh, scrollY: Math.round(scrollY),
    scrollPadding: getComputedStyle(document.documentElement).scrollPaddingTop,
    active: document.querySelector('.sidenav a.active')?.getAttribute('href') ?? null,
    sections: [...document.querySelectorAll('.content section')].map((s) => {
      const r = s.getBoundingClientRect()
      const overlap = Math.max(0, Math.min(r.bottom, bottom) - Math.max(r.top, top))
      return {
        id: s.id,
        top: Math.round(r.top),
        h: Math.round(r.height),
        overlapPx: Math.round(overlap),
        ratioIfRoot: +(overlap / r.height).toFixed(4),
      }
    }),
  }
})()`)

console.log('viewport h      :', dump.vh)
console.log('scrollY         :', dump.scrollY)
console.log('scroll-padding  :', dump.scrollPadding)
console.log('band            : 70px .. ' + Math.round(dump.vh * 0.45) + 'px')
console.log('active link     :', dump.active)
console.log('')
console.log('id      top     height   overlap  ratio')
for (const s of dump.sections) {
  console.log(
    s.id.padEnd(8),
    String(s.top).padStart(6),
    String(s.h).padStart(8),
    String(s.overlapPx).padStart(8),
    String(s.ratioIfRoot).padStart(8),
    s.id === dump.active?.slice(1) ? '  <-- active' : '',
  )
}

await send('Browser.close').catch(() => undefined)
chrome.kill(); ws.close()
