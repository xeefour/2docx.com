/**
 * สำรวจหน้าที่ผู้ใช้ชี้ว่า "ไม่มี pagination" — เปิดจริงแล้วรายงานสิ่งที่เห็น
 *
 *   node --env-file=../dokploy-infra/.env --env-file=../dokploy-infra/.env.development tools/probe-history-paging.mjs [url]
 *
 * ⚠️ เป็นเครื่องมือสำรวจ ไม่ใช่เทสต์ (ไม่มี pass/fail)
 *   ใช้เมื่อเห็นภาพหน้าจอแล้วเดาว่าเป็นการ์ดไหน — เดาผิดเสียเวลาเป็นชั่วโมง
 */
import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Redis } from 'ioredis'
import { MongoClient } from 'mongodb'
import { resolveMongoUrl } from '@docgen/shared'

const WEB = 'http://localhost:3000'
const API = process.env.API_URL ?? 'http://127.0.0.1:4001'
const CHROME = process.env.CHROME_PATH ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const PORT = 9411
const STAMP = Date.now()
const TARGET = process.argv[2] ?? `${WEB}/studio/dcc3c219244dceeec9df4d6c52e076aeec5316a0af3940da435c39f42c0f96f3`
const KEY = TARGET.replace(`${WEB}/studio/`, '').split('?')[0]
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const redis = new Redis(process.env.VALKEY_URL)
const SID = `probe-page-${STAMP}`
await redis.set(
  `session:${SID}`,
  JSON.stringify({ sub: SID, name: 'ผู้สำรวจหน้า', email: `probe.${STAMP}@test.local`, avatar: '' }),
  'EX',
  900,
)

const mongo = new MongoClient(await resolveMongoUrl())
const db = mongo.db(process.env.MONGO_DB ?? 'app')
const access = db.collection('template_access')

// เจ้าของเดิมของแม่แบบนี้คือใคร — ต้องรู้ก่อนจะแอบสวมสิทธิ์ไปเปิดหน้า
const acc = await access.findOne({ _id: KEY })
console.log('key      =', KEY)
console.log('เจ้าของ  =', acc?.owner ?? '(ไม่มีใน template_access)')

// สวมสิทธิ์ชั่วคราว (จำค่าเดิมไว้คืนท้ายสุด) เพราะหน้านี้เป็นของส่วนตัว
const prevRaw = acc ? JSON.stringify(acc) : ''
await access.replaceOne(
  { _id: KEY },
  { _id: KEY, templateKey: KEY, visibility: 'private', owner: SID, ownerName: 'ผู้สำรวจหน้า', sharedWith: [], updatedAt: new Date() },
  { upsert: true },
)

const profile = mkdtempSync(join(tmpdir(), 'cdp-probe-'))
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
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails.exception?.description))
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

await send('Page.enable')
await send('Runtime.enable')
await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 950, deviceScaleFactor: 1, mobile: false })
await send('Network.setCacheDisabled', { cacheDisabled: true })
await send('Network.setCookie', { name: 'docgen_session', value: SID, url: WEB })
await send('Page.navigate', { url: `${TARGET}${TARGET.includes('?') ? '&' : '?'}_=${STAMP}` })
await sleep(4000)
await waitFor(`!!document.querySelector('main, .tpl, .card')`, 30000)
await sleep(2500)

const dump = await evaluate(`(() => {
  const q = (s) => [...document.querySelectorAll(s)]
  return {
    url: location.href,
    // หัวข้อทั้งหมดที่มีตัวเลขในวงเล็บ = บอกว่าเป็นรายการแบบไหน
    headings: q('h1,h2,h3,h4').map((h) => h.tagName + ': ' + (h.innerText || '').trim().replace(/\\s+/g, ' ').slice(0, 90)),
    // กล่องที่มีการ์ด/รายการอยู่ข้างใน พร้อมเลขชิ้นที่มี
    cards: q('.card, .myhist, .tpllist, .inboxlist, .who-list, .tabpane > div').slice(0, 40).map((c) => ({
      cls: c.className || c.tagName,
      items: c.querySelectorAll(':scope > li, :scope > div').length,
      testid: c.getAttribute('data-testid') || '',
    })),
    pagers: q('[data-testid*="pager"], .pager').map((p) => p.getAttribute('data-testid') || p.className),
    testids: [...new Set(q('[data-testid]').map((e) => e.getAttribute('data-testid')))],
    counts: q('*').filter((e) => /^\\s*(ผู้ได้รับ|รายการ)/.test(e.textContent || '') && (e.textContent || '').length < 60)
      .map((e) => e.textContent.trim().replace(/\\s+/g, ' ')),
  }
})()`)
console.log('\nurl      =', dump.url)
console.log('\nหัวข้อ:')
for (const h of dump.headings) console.log('  ' + h)
console.log('\nกล่อง:')
for (const c of dump.cards) console.log(`  ${c.cls} — ${c.items} ชิ้น${c.testid ? ' · ' + c.testid : ''}`)
console.log('\nตัวแบ่งหน้าที่เจอ:', dump.pagers.length ? dump.pagers.join(', ') : '(ไม่มีเลย)')
console.log('\ndata-testid ที่มี:', dump.testids.join(', '))
console.log('\nข้อความที่ขึ้นต้นด้วย ผู้ได้รับ/รายการ:', dump.counts.length ? dump.counts.join(' | ') : '(ไม่มี)')

// ── เก็บกวาด ────────────────────────────────────────────────────────
if (prevRaw) await access.replaceOne({ _id: KEY }, JSON.parse(prevRaw))
else await access.deleteOne({ _id: KEY })
await redis.del(`session:${SID}`)
redis.disconnect()
await mongo.close()
await send('Browser.close').catch(() => {})
chrome.kill()
ws.close()
process.exit(0)
