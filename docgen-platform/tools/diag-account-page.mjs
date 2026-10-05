/**
 * สืบว่าทำไม /account ไม่มี .rail ตอนเทสต์รัน แต่ curl แล้วได้ 200
 *
 * ทำ session ปลอมใส่ Valkey แล้วเปิดด้วย CDP จริง ดูว่าได้อะไรกลับมา
 */
import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Redis } from 'ioredis'

const WEB = 'http://localhost:3000'
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const PORT = 9471
const STAMP = Date.now()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const redis = new Redis(process.env.VALKEY_URL)
const SID = `accdiag-${STAMP}`
await redis.set(
  `session:${SID}`,
  JSON.stringify({
    sub: SID,
    name: `ผู้ทดสอบ sidebar ${STAMP}`,
    email: `accdiag-${STAMP}@test.local`,
    avatar: '',
    affiliation: 'หน่วยงานทดสอบ',
  }),
  'EX',
  600,
)

const profile = mkdtempSync(join(tmpdir(), 'cdp-accdiag-'))
const chrome = spawn(
  CHROME,
  ['--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run', '--window-size=1600,950',
   `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, 'about:blank'],
  { stdio: 'ignore' },
)
let wsUrl = null
for (let i = 0; i < 40 && !wsUrl; i++) {
  await sleep(500)
  try {
    const l = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
    wsUrl = l.find((x) => x.type === 'page')?.webSocketDebuggerUrl
  } catch { /* ยังไม่พร้อม */ }
}
if (!wsUrl) { chrome.kill(); redis.disconnect(); console.log('ต่อ Chrome ไม่ได้'); process.exit(1) }

const ws = new WebSocket(wsUrl)
let seq = 0
const waiting = new Map()
const send = (m, p = {}) =>
  new Promise((resolve, reject) => {
    const id = ++seq
    const t = setTimeout(() => { waiting.delete(id); reject(new Error('timeout: ' + m)) }, 30000)
    waiting.set(id, { resolve: (v) => { clearTimeout(t); resolve(v) }, reject: (e) => { clearTimeout(t); reject(e) } })
    ws.send(JSON.stringify({ id, method: m, params: p }))
  })
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data)
  const s = waiting.get(m.id)
  if (!s) return
  waiting.delete(m.id)
  m.error ? s.reject(new Error(JSON.stringify(m.error))) : s.resolve(m.result)
})
await new Promise((r) => ws.addEventListener('open', r))
await send('Page.enable')
await send('Runtime.enable')
await send('Network.setCookie', { name: 'docgen_session', value: SID, url: WEB })

const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (r.exceptionDetails) return { __err: r.exceptionDetails.text ?? 'evaluate พัง' }
  return r.result?.value
}

await send('Page.navigate', { url: `${WEB}/account?_=${STAMP}` })
for (const t of [2000, 4000, 8000, 15000, 25000]) {
  await sleep(t === 2000 ? 2000 : t - 0)
  const s = await evaluate(`({
    path: location.pathname + location.search,
    title: document.title,
    hasRail: !!document.querySelector('.rail'),
    hasShell: !!document.querySelector('.shell'),
    bodyStart: (document.body?.innerText || '').slice(0, 160).replace(/\\s+/g, ' '),
    hasBoot: !!document.querySelector('.bootveil'),
  })`)
  console.log(`[${t}ms]`, JSON.stringify(s, null, 0))
  if (s?.hasRail) break
}

await send('Browser.close').catch(() => undefined)
chrome.kill()
ws.close()
await redis.del(`session:${SID}`)
redis.disconnect()
process.exit(0)
