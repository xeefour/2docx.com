/**
 * sidebar ของ /studio ต้องเหมือน /account และ /teams
 *
 *   node --env-file=../dokploy-infra/.env --env-file=../dokploy-infra/.env.development tools/test-rail-consistency.mjs
 *
 * ── ทำไมต้องมีเทสต์นี้ ─────────────────────────────────────────────
 *   ผู้ใช้สั่ง: *"ปรับ sidebar ให้เหมือนหน้าอื่น เหมือนกับหน้านี้ /account /teams เป็นต้น"*
 *
 *   วัดจากหน้าเว็บจริงก่อนแก้ พบว่า CSS ของ sidebar ทั้งสามหน้า**เหมือนกันทุกค่าเป๊ะ**
 *   (244px · padding 20/14/64 · แท็บ 9px 12px / 14px · label 11px · footer 12px + เส้น 1px)
 *   ความต่างที่เหลืออยู่ที่**โครงสร้างเนื้อหา** 4 จุด:
 *     1. เมนู 2 กลุ่มคั่นเส้น (หน้าอื่นมีกลุ่มเดียว)
 *     2. ปุ่มใต้แบรนด์กินเต็มความกว้าง สูง 42px (หน้าอื่นไม่มี หรือเป็นวงกลมเล็ก)
 *     3. ตัวเลขนับในแท็บ (หน้าอื่นไม่มี)
 *     4. กระดิ่ง 🔔 ในส่วนล่าง (หน้าอื่นมีแค่ชื่อผู้ใช้ + ออกจากระบบ)
 *
 *   ⚠️ เกณฑ์สำคัญ — ต้องเทียบกับหน้าจริง ไม่ใช่ค่าที่เขียนไว้
 *     เพราะถ้าเขียน "ความกว้างต้องเป็น 244" แล้วผ่าน แต่ CSS พังจริง
 *     เทสต์นี้จะเทียบค่าที่วัดได้จากทั้งสามหน้าด้วยกัน
 *     → ถ้าวันหนึ่ง CSS เปลี่ยนทั้งแอป ทั้งสามหน้าจะเปลี่ยนพร้อมกัน
 *       เกณฑ์จะยังผ่าน แต่เกณฑ์ "ไม่มีตัวเลข/กระดิ่ง" จะตก ซึ่งเป็นสิ่งที่ผู้ใช้สั่ง
 */
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Redis } from 'ioredis'

const WEB = 'http://localhost:3000'
const CHROME = process.env.CHROME_PATH ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const PORT = 9461
const STAMP = Date.now()
const OUT = 'D:/2docx.com/docgen-platform/tests/nav-status/output-rail-consistency/'
mkdirSync(OUT, { recursive: true })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let pass = 0
let fail = 0
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'}${name}${detail ? ` — ${detail}` : ''}`)
  ok ? pass++ : fail++
}

const redis = new Redis(process.env.VALKEY_URL)
const SID = `railcons-${STAMP}`
const NAME = `ผู้ทดสอบ sidebar ${STAMP}`
await redis.set(
  `session:${SID}`,
  JSON.stringify({
    sub: SID,
    name: NAME,
    email: `railcons-${STAMP}@test.local`,
    avatar: '',
    affiliation: 'หน่วยงานทดสอบ',
  }),
  'EX',
  1200,
)

const profile = mkdtempSync(join(tmpdir(), 'cdp-railcons-'))
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
const waitFor = async (expr, ms = 40000) => {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    if (await evaluate(`!!(${expr})`)) return true
    await sleep(400)
  }
  return false
}

/**
 * วัด sidebar ของหน้าที่กำลังเปิด
 *
 * ⚠️ ต้องกันหลุดโครงสร้าง (element ที่อยู่ใน `.tabs__list` เดียวกัน) ไม่ใช่แค่นับ `.tabs__tab`
 *   เพราะเกณฑ์ที่ผ่านแบบนี้คือเกณฑ์ที่ตาย — นับเจอ 7 อัน
 *   แต่ถ้ามันอยู่คนละกล่องจริง ก็ถือว่า "ยังเป็นสองกลุ่ม" ซึ่งคือบั๊กที่ต้องจับ
 */
const MEASURE = `(() => {
  const rail = document.querySelector('.rail')
  if (!rail) return { miss: true }
  const list = rail.querySelector('.rail__nav .tabs__list')
  const items = list ? [...list.children] : []
  const rect = (el) => el ? el.getBoundingClientRect() : null
  const tab = rail.querySelector('.tabs__tab')
  const tabOn = rail.querySelector('.tabs__tab--on')
  const label = rail.querySelector('.rail__label')
  const foot = rail.querySelector('.rail__foot')
  const brand = rail.querySelector('.rail__brand')
  const action = rail.querySelector('.rail__top > label, .rail__top > button')
  const cs = (el, p) => (el ? getComputedStyle(el).getPropertyValue(p) : null)
  return {
    railW: Math.round(rail.getBoundingClientRect().width),
    itemCount: items.length,
    /** ทุกชิ้นอยู่ใน .tabs__list กล่องเดียวกัน = กลุ่มเดียว */
    oneGroup: items.length > 0 && items.every((el) => el.parentElement === list),
    /** ระยะห่างแนวตั้งระหว่างชิ้นต้องเท่ากัน (gap เดียว ไม่มีกลุ่มที่สองห่างออกไป) */
    gaps: items.map((el, i) => {
      if (i === 0) return null
      const a = items[i - 1].getBoundingClientRect()
      const b = el.getBoundingClientRect()
      return Math.round(b.top - a.bottom)
    }).filter((x) => x !== null),
    /**
     * ⚠️ ช่องว่างระหว่าง**ทุก**รายการใน sidebar ไม่ใช่แค่ในกลุ่มแรก
     *   เวอร์ชันแรกวัดแค่ใน '.tabs__list' แรก พอเมนูกลับไปเป็น 2 กลุ่ม
     *   ช่องว่างตรงรอยต่อกลุ่ม (10px จาก gap ของ .rail) จึงไม่ถูกวัดเลย
     *   → เกณฑ์ผ่านทั้งที่ยังเป็นสองกลุ่มจริง
     *   เรียงตามตำแหน่งแนวตั้งก่อน แล้วเทียบระยะของแต่ละคู่
     */
    allGaps: (() => {
      const all = [...rail.querySelectorAll('.tabs__tab')]
        .map((el) => el.getBoundingClientRect())
        .sort((a, b) => a.top - b.top)
      return all.slice(1).map((r, i) => Math.round(r.top - all[i].bottom))
    })(),
    counts: rail.querySelectorAll('.tabs__count').length,
    bell: rail.querySelectorAll('[data-testid="inbox-bell"]').length,
    groups: rail.querySelectorAll('.rail__nav').length,
    actionW: action ? Math.round(rect(action).width) : 0,
    actionH: action ? Math.round(rect(action).height) : 0,
    actionFS: cs(action, 'font-size'),
    railW2: Math.round(rect(rail).width),
    tabPad: cs(tab, 'padding'),
    tabFS: cs(tab, 'font-size'),
    tabRadius: cs(tab, 'border-radius'),
    labelFS: cs(label, 'font-size'),
    labelLS: cs(label, 'letter-spacing'),
    footPadTop: cs(foot, 'padding-top'),
    footBorder: cs(foot, 'border-top-width'),
    onBg: tabOn ? cs(tabOn, 'background-color') : null,
    brandGap: cs(brand, 'gap'),
    footText: (foot?.textContent ?? '').replace(/\\s+/g, ' ').trim(),
    footLinks: foot ? [...foot.querySelectorAll('a')].map((a) => a.textContent.trim()) : [],
    /**
     * วัดว่าชื่อผู้ใช้กับลิงก์ "ออกจากระบบ" ชนกันไหม
     * ⚠️ ชื่อยาวได้มาก แต่พื้นที่ใต้แบรนด์กว้างแค่ 216px
     *   ถ้าไม่ตัดด้วย … ชื่อจะไหลไปชนลิงก์ (เจอตอนวัดรอบแรก)
     */
    footName: (() => {
      if (!foot) return null
      const name = foot.querySelector('span')
      const link = foot.querySelector('a')
      if (!name || !link) return null
      const ns = getComputedStyle(name)
      return {
        overflowX: Math.max(0, name.scrollWidth - name.clientWidth),
        linkW: Math.round(link.getBoundingClientRect().width),
        overlap: Math.round(Math.max(0, name.getBoundingClientRect().right - link.getBoundingClientRect().left)),
        ellipsis: ns.textOverflow,
      }
    })(),
  }
})()`

const PAGES = [
  { path: '/studio', name: 'studio' },
  { path: '/account', name: 'account' },
  { path: '/teams', name: 'teams' },
]

const out = {}

/**
 * ⚠️ ต้องอุ่นหน้าเว็บก่อนวัดเสมอ
 *
 *   Next dev คอมไพล์ route ครั้งแรกที่ถูกเรียก แล้วช้ามาก (เคยวัดได้เกิน 40 วินาที)
 *   ถ้าไปวัดทันทีหลังแก้ไฟล์ หน้าที่ยังไม่เคยถูกคอมไพล์จะ timeout
 *   แล้วได้ผลเหมือน "หน้านั้นไม่มี sidebar" — ซึ่งไม่จริง
 *   (เจอตอนรันครั้งแรก: /account ได้ undefined ทั้งหมด ทั้งที่ curl แล้ว 200)
 */
console.log('อุ่นหน้าเว็บให้คอมไพล์เสร็จก่อน…')
for (const p of PAGES) {
  await send('Page.navigate', { url: `${WEB}${p.path}?_warm=${STAMP}` })
  const ok = await waitFor(`document.querySelector('.rail')`, 90000)
  console.log(`  ${ok ? '✓' : '✗'}${p.path}${ok ? '' : ' — คอมไพล์ไม่เสร็จใน 90 วินาที'}`)
}
await sleep(800)

for (const p of PAGES) {
  await send('Page.navigate', { url: `${WEB}${p.path}?_=${STAMP}` })
  const ok = await waitFor(`document.querySelector('.rail')`, 60000)
  if (!ok) { out[p.name] = { miss: true }; console.log(`วัด ${p.path} ไม่ได้`); continue }
  await sleep(2500)
  out[p.name] = await evaluate(MEASURE)
  const { data } = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(join(OUT, `${p.name}.png`), Buffer.from(data, 'base64'))
  const box = await evaluate(`(() => { const r = document.querySelector('.rail').getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.min(Math.round(r.height), 1500) } })()`)
  const clip = await send('Page.captureScreenshot', { format: 'png', clip: { x: box.x, y: box.y, width: box.w, height: box.h, scale: 1 } })
  writeFileSync(join(OUT, `${p.name}-rail.png`), Buffer.from(clip.data, 'base64'))
  console.log(`วัด ${p.path} แล้ว`)
}

const S = out.studio ?? {}
const A = out.account ?? {}
const T = out.teams ?? {}

console.log('\n── วัด sidebar ทั้งสามหน้า ────────────────────────────────────\n')
const pad = (s) => String(s).padEnd(28, ' ')
console.log(pad('ส่วน') + pad('/studio') + pad('/account') + pad('/teams'))
console.log('-'.repeat(92))
const row = (label, get) => {
  const v = [get(S), get(A), get(T)]
  const same = v[0] === v[1] && v[1] === v[2]
  console.log(pad(label) + pad(v[0]) + pad(v[1]) + pad(v[2]) + (same ? '' : '  ← ต่าง'))
}
row('ความกว้าง sidebar', (o) => `${o.railW}px`)
row('กล่องรายการเมนู', (o) => `${o.groups} กล่อง`)
row('รายการในกล่องเดียว', (o) => `${o.itemCount} รายการ`)
row('padding แท็บ', (o) => o.tabPad)
row('ขนาดตัวอักษรแท็บ', (o) => o.tabFS)
row('มุมโค้งแท็บ', (o) => o.tabRadius)
row('ขนาดตัวอักษร label', (o) => o.labelFS)
row('padding บนส่วนล่าง', (o) => o.footPadTop)
row('เส้นบนส่วนล่าง', (o) => o.footBorder)

console.log('\n[1] สไตล์ต้องเหมือนกันทุกหน้า')
for (const [name, get] of [
  ['ความกว้าง sidebar', (o) => o.railW],
  ['padding ของแท็บ', (o) => o.tabPad],
  ['ขนาดตัวอักษรแท็บ', (o) => o.tabFS],
  ['มุมโค้งของแท็บ', (o) => o.tabRadius],
  ['ขนาดตัวอักษร label', (o) => o.labelFS],
  ['ระยะห่างตัวอักษร label', (o) => o.labelLS],
  ['padding บนส่วนล่าง', (o) => o.footPadTop],
  ['ความหนาเส้นบนส่วนล่าง', (o) => o.footBorder],
]) {
  const v = [get(S), get(A), get(T)]
  check(`${name} เท่ากันทั้งสามหน้า`, v[0] === v[1] && v[1] === v[2], v.join(' / '))
}

console.log('\n[2] เมนูต้องเป็นกลุ่มเดียว (ผู้ใช้สั่งตัดเส้นคั่นออก)')
check('/studio ไม่มีกล่องรายการเมนูที่สอง', S.groups === 1, `${S.groups} กล่อง`)
check('หน้าอื่นมีกล่องเดียวเหมือนกัน', A.groups === 1 && T.groups === 1, `${A.groups} / ${T.groups}`)
check('/studio ทุกรายการอยู่ใน .tabs__list กล่องเดียว', S.oneGroup === true)
{
  const all = S.allGaps ?? []
  const uniq = [...new Set(all)]
  check('รายการทั้งหมดเรียงชิดกัน ไม่มีช่องว่างของกลุ่มที่สอง', all.length > 0 && uniq.length === 1 && uniq[0] <= 4, `ระยะที่พบ ${uniq.join(', ')}px (ต้องเป็นช่องเดียว ไม่เกิน 4px)`)
  check('/studio มีรายการครบ 7 (5 แท็บ + ทีม + บัญชี)', S.itemCount === 7, `${S.itemCount} รายการ`)
}

console.log('\n[3] ไม่มีตัวเลขนับในแท็บ (ผู้ใช้สั่งเอาออก)')
check('/studio ไม่มีป้ายตัวเลขในแท็บ', S.counts === 0, `พบ ${S.counts} ป้าย`)
check('หน้าอื่นก็ไม่มีป้ายตัวเลข', A.counts === 0 && T.counts === 0, `${A.counts} / ${T.counts}`)

console.log('\n[4] ไม่มีกระดิ่งในส่วนล่าง (ผู้ใช้สั่งเอาออก)')
check('/studio ไม่มีกระดิ่ง', S.bell === 0, `พบ ${S.bell} ตัว`)

console.log('\n[5] ปุ่มใต้แบรนด์เล็กลง ไม่กินเต็มความกว้าง')
/**
 * ⚠️ เกณฑ์นี้ต้อง "จับบั๊กได้" ไม่ใช่แค่ผ่าน
 *
 *   ของเดิม: กินเต็มพื้นที่ใต้แบรนด์ (216px จาก 216px = 100%) และสูง 42px
 *   ของใหม่: 120px (56%) สูง 33px
 *
 *   ตั้งเพดานที่ 70% — ผ่านของใหม่ (56%) แต่ตกของเดิม (100%) แน่นอน
 *   ⚠️ ห้ามตั้งที่ 50% เพราะจะบังคับให้ต้องตัดคำว่า "อัปโหลดแม่แบบ" ทิ้ง
 *      ซึ่งทำให้ผู้ใช้หาไม่เจอปุ่มหลักของแอป
 */
{
  const railInner = (S.railW ?? 244) - 28
  const maxW = Math.round(railInner * 0.7)
  const tabH = Math.round(9 * 2 + 22.4) // padding บน+ล่าง + line-height ของแท็บ
  check('ปุ่มอัปโหลดไม่กินเต็มพื้นที่ใต้แบรนด์', (S.actionW ?? 999) <= maxW, `${S.actionW}px (เพดาน ${maxW}px จาก ${railInner}px)`)
  check('ปุ่มอัปโหลดสูงไม่เกินแท็บปกติ', (S.actionH ?? 999) <= tabH, `${S.actionH}px (แท็บ ≈${tabH}px)`)
  check('ปุ่มอัปโหลดยังมองเห็นได้ (ไม่ถูกซ่อน)', (S.actionW ?? 0) > 40 && (S.actionH ?? 0) > 20, `${S.actionW}×${S.actionH}px`)
  check('ปุ่มอัปโหลดยังบอกชื่อฟังก์ชันได้', (S.actionW ?? 0) >= 90, `${S.actionW}px`)
}

console.log('\n[6] ส่วนล่างเหลือชื่อผู้ใช้ + ออกจากระบบ')
check('มีลิงก์ "ออกจากระบบ"', (S.footLinks ?? []).some((t) => t.includes('ออกจากระบบ')), (S.footLinks ?? []).join(' · '))
check('ไม่มีกระดิ่งปนในส่วนล่าง', !(S.footText ?? '').includes('🔔'), S.footText)
check('มีชื่อผู้ใช้ในส่วนล่าง', (S.footText ?? '').includes(NAME), S.footText)
/**
 * ⚠️ ชื่อผู้ใช้ยาวได้ แต่พื้นที่ใต้แบรนด์กว้างแค่ 216px
 *   ถ้าไม่ตัดด้วย … ชื่อจะไหลไปชนกับ "ออกจางระบบ" แล้วอ่านยาก
 *   (เจอตอนวัดรอบแรก — ชื่อกับลิงก์ติดกันจนเป็นบรรทัดเดียว)
 */
{
  const fo = S.footName ?? {}
  check('ชื่อผู้ใช้ยาวเกินจึงถูกย่อด้วย …', (fo.overflowX ?? 0) > 0 && fo.ellipsis === 'ellipsis', `ล้น ${fo.overflowX}px · text-overflow=${fo.ellipsis}`)
  check('ลิงก์ "ออกจางระบบ" ไม่ถูกบีบจนอ่านไม่ออก', (fo.linkW ?? 0) >= 60, `${fo.linkW}px`)
  check('ชื่อกับลิงก์ไม่ซ้อนทับกัน', (fo.overlap ?? 1) === 0, `ซ้อน ${fo.overlap}px`)
}

console.log(`\n── ผ่าน ${pass} · ไม่ผ่าน ${fail} ─────────────────────\n`)
console.log(`ภาพ: ${OUT}`)

writeFileSync(join(OUT, 'measure.json'), JSON.stringify(out, null, 2), 'utf8')

await send('Browser.close').catch(() => undefined)
chrome.kill()
ws.close()
await redis.del(`session:${SID}`)
redis.disconnect()
process.exit(fail ? 1 : 0)
