/**
 * วัด sidebar ของทั้ง 3 หน้าเทียบกัน เพื่อหาว่า /studio ต่างจาก /account และ /teams ตรงไหน
 *
 *   node --env-file=.env tools/probe-rail-compare.mjs
 *
 * ── ทำไมต้องวัด ไม่ใช่แก้ตามตา ──────────────────────────────────────
 *   ผู้ใช้สั่ง *"ปรับ sidebar ให้เหมือนหน้าอื่น เหมือนกับหน้านี้ /account /teams เป็นต้น"*
 *   ทั้งสามหน้าใช้คลาสเดียวกัน (.rail · .rail__nav · .tabs--rail) อยู่แล้ว
 *   → ถ้าหน้าตาไม่เหมือนกัน ตัวแปรที่ต่างกันต้องเป็น **ค่า** ไม่ใช่คลาส
 *   การเดาจากภาพแล้วไปแก้ CSS ระดับเดา คือเสี่ยงไปแก้ทั้งแอป
 *
 * วิธีวัด: เปิดแต่ละหน้า อ่าน computed style ของชิ้นส่วนเดียวกันใน sidebar
 *   แล้วเทียบทีละค่า — ค่าไหนต่าง ค่านั้นคือต้นเหตุ
 */
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Redis } from 'ioredis'

const WEB = 'http://localhost:3000'
const CHROME = process.env.CHROME_PATH ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const PORT = 9451
const STAMP = Date.now()
const OUT = 'D:/2docx.com/docgen-platform/tests/nav-status/output-rail-compare/'
mkdirSync(OUT, { recursive: true })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const redis = new Redis(process.env.VALKEY_URL)
const SID = `railcmp-${STAMP}`
await redis.set(
  `session:${SID}`,
  JSON.stringify({
    sub: SID,
    name: 'ผู้วัด sidebar',
    email: `railcmp-${STAMP}@test.local`,
    avatar: '',
    affiliation: 'หน่วยงานทดสอบ',
  }),
  'EX',
  900,
)

const profile = mkdtempSync(join(tmpdir(), 'cdp-railcmp-'))
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
if (!wsUrl) { chrome.kill(); redis.disconnect(); console.log('✗ ต่อ Chrome ไม่ได้'); process.exit(1) }

const ws = new WebSocket(wsUrl)
let seq = 0
const waiting = new Map()
const send = (m, p = {}) =>
  new Promise((resolve, reject) => {
    const id = ++seq
    const t = setTimeout(() => { waiting.delete(id); reject(new Error(`timeout: ${m}`)) }, 30000)
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
await send('Network.setCacheDisabled', { cacheDisabled: true })
await send('Network.setCookie', { name: 'docgen_session', value: SID, url: WEB })

const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text ?? 'evaluate พัง')
  return r.result?.value
}
const waitFor = async (expr, ms = 30000) => {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    if (await evaluate(`!!(${expr})`)) return true
    await sleep(400)
  }
  return false
}

/**
 * อ่านค่าของชิ้นส่วนเดียวกันใน sidebar ทุกหน้า
 * คืน null ถ้าหน้านั้นไม่มีชิ้นส่วนนั้น (เช่น /teams ไม่มีปุ่มหลัก)
 */
const MEASURE = `(() => {
  const rail = document.querySelector('.rail')
  if (!rail) return { miss: 'ไม่เจอ .rail' }
  const q = (s) => document.querySelector(s)
  const cs = (el, ...props) => {
    if (!el) return null
    const c = getComputedStyle(el)
    const o = {}
    for (const p of props) o[p.replace(/-([a-z])/g, (_, c2) => c2.toUpperCase())] = c.getPropertyValue(p)
    return o
  }
  const rect = (el) => {
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.x), y: Math.round(r.y) }
  }
  const tab = q('.tabs--rail .tabs__tab')
  const tabOn = q('.tabs--rail .tabs__tab--on')
  const brand = q('.rail__brand')
  const names = q('.rail__names')
  const small = q('.rail__names small')
  const mark = q('.rail__mark')
  const label = q('.rail__label')
  const nav = q('.rail__nav')
  const foot = q('.rail__foot')
  const list = q('.rail__nav .tabs__list')
  const top = q('.rail__top')
  // ปุ่มหลักใต้แบรนด์ (อัปโหลดแม่แบบ / รูปโปรไฟล์)
  const action = q('.rail__top > label, .rail__top > button, .rail__top > a, .rail__top > form')
  const allTabs = [...document.querySelectorAll('.tabs--rail .tabs__tab')]
  return {
    rail: { ...rect(rail), ...cs(rail, 'padding', 'display', 'flex-direction', 'gap', 'border-right', 'background') },
    top: { ...rect(top), ...cs(top, 'display', 'flex-direction', 'gap') },
    brand: { ...rect(brand), ...cs(brand, 'gap', 'padding', 'align-items') },
    mark: { ...rect(mark), ...cs(mark, 'width', 'height', 'font-size', 'border-radius') },
    names: { ...rect(names), ...cs(names, 'line-height', 'font-size') },
    small: { ...rect(small), ...cs(small, 'font-size', 'color') },
    label: { ...rect(label), ...cs(label, 'font-size', 'margin', 'padding', 'letter-spacing', 'color', 'text-transform') },
    nav: { ...rect(nav), ...cs(nav, 'padding', 'margin') },
    list: { ...rect(list), ...cs(list, 'display', 'flex-direction', 'gap') },
    tab: { ...rect(tab), ...cs(tab, 'padding', 'font-size', 'font-weight', 'color', 'background', 'border-radius', 'gap', 'justify-content', 'min-height', 'border-bottom', 'border-left', 'line-height') },
    tabOn: tabOn ? { ...rect(tabOn), ...cs(tabOn, 'background', 'color', 'font-weight', 'border-radius') } : null,
    action: action ? { tag: action.tagName, ...rect(action), ...cs(action, 'padding', 'font-size', 'border', 'background', 'height', 'display') } : null,
    foot: { ...rect(foot), ...cs(foot, 'padding-top', 'border-top', 'gap', 'flex-direction', 'align-items') },
    tabCount: allTabs.length,
    tabTexts: allTabs.map((t) => (t.textContent || '').trim()),
    railH: Math.round(rail.getBoundingClientRect().height),
    vh: innerHeight,
  }
})()`

const PAGES = [
  { path: '/studio', name: 'studio', shot: '01-studio.png' },
  { path: '/account', name: 'account', shot: '02-account.png' },
  { path: '/teams', name: 'teams', shot: '03-teams.png' },
]

/**
 * ขนาดจอที่ต้องวัด
 *
 * ⚠️ ต้องรวมช่วงที่ sidebar เปลี่ยนเป็นลิ้นชัก (จอ < 900px)
 *   เพราะที่จุดพลิก `.rail` กลายเป็น `position: fixed` → `flex: 0 0 244px` เลยไม่มีผล
 *   (กฎ flex ไม่มีผลกับกล่องที่ไม่ใช่ flex item)
 *   กล่อง fixed ที่ไม่กำหนด width จะ **หดตามเนื้อหา** ไม่ใช่ 244px
 *   → หน้าที่เนื้อหากว้างกว่า ลิ้นชักก็จะกว้างกว่าโดยอัตโนมัติ
 */
const WIDTHS = [1600, 1024, 900, 768, 570, 414, 360]

const out = { width: {} }

/** ความกว้าง sidebar ที่ความกว้างจอต่าง ๆ — จุดที่หน้าต่างกันจะโผล่ตรงนี้ */
for (const w of WIDTHS) {
  await send('Emulation.setDeviceMetricsOverride', { width: w, height: 900, deviceScaleFactor: 1, mobile: false })
  await sleep(700)
  const row = {}
  for (const p of PAGES) {
    await send('Page.navigate', { url: `${WEB}${p.path}?_=${STAMP}` })
    const ok = await waitFor(`document.querySelector('.rail')`, 25000)
    if (!ok) { row[p.name] = null; continue }
    await sleep(1500)
    row[p.name] = await evaluate(`(() => {
      const rail = document.querySelector('.rail')
      const r = rail.getBoundingClientRect()
      const cs = getComputedStyle(rail)
      const widest = [...rail.querySelectorAll('*')]
        .map((e) => e.getBoundingClientRect().width)
        .filter((x) => x > 0)
        .reduce((a, b) => Math.max(a, b), 0)
      return {
        w: Math.round(r.width),
        vw: innerWidth,
        pct: Math.round((r.width / innerWidth) * 100),
        position: cs.position,
        widthProp: cs.width,
        flex: cs.flex,
        widestChild: Math.round(widest),
      }
    })()`)
  }
  out.width[w] = row
  console.log(`วัดที่ ${w}px แล้ว`)
}

await send('Emulation.clearDeviceMetricsOverride')
await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 950, deviceScaleFactor: 1, mobile: false })

for (const p of PAGES) {
  await send('Page.navigate', { url: `${WEB}${p.path}?_=${STAMP}` })
  const ok = await waitFor(`document.querySelector('.rail')`, 30000)
  if (!ok) { out[p.name] = { miss: 'โหลดหน้าไม่ได้' }; continue }
  await sleep(2200)
  out[p.name] = await evaluate(MEASURE)
  const { data } = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(join(OUT, p.shot), Buffer.from(data, 'base64'))
  // เก็บเฉพาะตัว sidebar เพื่อเทียบหน้าตา
  const box = await evaluate(`(() => { const r = document.querySelector('.rail').getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.min(Math.round(r.height), 1400) } })()`)
  const clip = { x: box.x, y: box.y, width: box.w, height: box.h, scale: 1 }
  const c = await send('Page.captureScreenshot', { format: 'png', clip })
  writeFileSync(join(OUT, p.shot.replace('.png', '-rail.png')), Buffer.from(c.data, 'base64'))
}

console.log('\n── ความกว้าง sidebar เทียบตามขนาดจอ ────────────────────────\n')
const ww = (s) => String(s).padEnd(34, ' ')
console.log(ww('ขนาดจอ') + ww('/studio') + ww('/account') + ww('/teams'))
console.log('-'.repeat(110))
for (const w of WIDTHS) {
  const r = out.width[w] ?? {}
  const cell = (n) => {
    const v = r[n]
    return v ? `${v.w}px (${v.pct}% จอ)` : '—'
  }
  const vals = [cell('studio'), cell('account'), cell('teams')]
  const diff = vals[0] !== vals[1] || vals[1] !== vals[2]
  console.log(ww(w + 'px') + ww(vals[0]) + ww(vals[1]) + ww(vals[2]) + (diff ? '  ← ต่างกัน' : ''))
}
console.log('\nรายละเอียดต่อหน้า (ที่ 570px):')
for (const n of ['studio', 'account', 'teams']) {
  const v = out.width[570]?.[n]
  if (!v) continue
  console.log(`  ${ww(n)} position=${v.position} width=${v.widthProp} flex=${v.flex} ลูกกว้างสุด=${v.widestChild}px`)
}


// ── พิมพ์ตารางเทียบ ────────────────────────────────────────────────
const rows = []
const push = (label, get) => {
  rows.push({ ส่วน: label, studio: get(out.studio), account: get(out.account), teams: get(out.teams) })
}
const S = (v) => (v === null || v === undefined ? '—' : String(v))
push('ความกว้าง sidebar (px)', (o) => S(o?.rail?.w))
push('ความสูง sidebar (px)', (o) => S(o?.railH))
push('sidebar padding', (o) => S(o?.rail?.padding))
push('sidebar gap', (o) => S(o?.rail?.gap))
push('ระยะห่าง .rail__top', (o) => S(o?.top?.gap))
push('ความสูง .rail__top (px)', (o) => S(o?.top?.h))
push('โลโก้ (px)', (o) => `${S(o?.mark?.w)}×${S(o?.mark?.h)}`)
push('โลโก้ font-size', (o) => S(o?.mark?.fontSize))

console.log('\n── ตารางเทียบ sidebar ──────────────────────────────────\n')
const w = (s) => String(s).padEnd(30, ' ')
console.log(w('ส่วน') + w('/studio') + w('/account') + w('/teams'))
console.log('-'.repeat(96))
for (const r of rows) {
  const a = S(r.studio), b = S(r.account), c = S(r.teams)
  const same = a === b && b === c
  console.log(w(r.ส่วน) + w(a) + w(b) + w(c) + (same ? '' : '  ← ต่าง'))
}

console.log('\n── รายละเอียดที่ต่างกัน ───────────────────────────────────\n')
for (const p of PAGES) {
  const o = out[p.name]
  console.log(`${p.path}  แท็บ ${o?.tabCount ?? '?'} อัน: ${JSON.stringify(o?.tabTexts ?? [])}`)
  console.log(`   tab: padding=${S(o?.tab?.padding)} font=${S(o?.tab?.fontSize)} weight=${S(o?.tab?.fontWeight)} radius=${S(o?.tab?.borderRadius)} line=${S(o?.tab?.lineHeight)} minH=${S(o?.tab?.minHeight)} justify=${S(o?.tab?.justifyContent)}`)
  console.log(`   tab--on: bg=${S(o?.tabOn?.background)} color=${S(o?.tabOn?.color)} weight=${S(o?.tabOn?.fontWeight)}`)
  console.log(`   label: ${S(o?.label?.fontSize)} ls=${S(o?.label?.letterSpacing)} m=${S(o?.label?.margin)} p=${S(o?.label?.padding)}`)
  console.log(`   action: ${o?.action ? `${o.action.tag} ${S(o.action.w)}×${S(o.action.h)} pad=${S(o.action.padding)} fs=${S(o.action.fontSize)} border=${S(o.action.border)}` : 'ไม่มี'}`)
  console.log(`   foot: padTop=${S(o?.foot?.paddingTop)} border=${S(o?.foot?.borderTop)} dir=${S(o?.foot?.flexDirection)}`)
  console.log(`   list: display=${S(o?.list?.display)} dir=${S(o?.list?.flexDirection)} gap=${S(o?.list?.gap)}`)
  console.log('')
}
console.log(`ภาพ: ${OUT}`)

writeFileSync(join(OUT, 'measure.json'), JSON.stringify(out, null, 2), 'utf8')

await send('Browser.close').catch(() => undefined)
chrome.kill()
ws.close()
await redis.del(`session:${SID}`)
redis.disconnect()
process.exit(0)
