/**
 * ตรวจว่าหน้ารายการแม่แบบ (`/studio`) ใช้งานบนมือถือได้จริง
 *
 *   node --env-file=.env tools/test-list-mobile.mjs
 *
 * ── ที่ต้องผ่าน ────────────────────────────────────────────────
 * 1. จอ ≤ 720px → หน้าไม่ล้นแนวนอน และ**ปุ่มจัดการทุกปุ่มอยู่ในจอ** ทุกแถว
 * 2. จอ ≤ 720px → หัวตารางหายไป (กลายเป็นการ์ด) และมีป้ายกำกับแทนคอลัมน์
 * 3. จอ ≤ 720px → ปุ่มสูง ≥ 36px (แตะนิ้วได้)
 * 4. ช่องที่ไม่มีข้อมูล (ไม่มีหมวด/ไม่มีแท็ก) ต้อง**ถูกซ่อน** ไม่ใช่โชว์ "—" เปล่า ๆ
 * 5. จอกว้าง (1440px) → **ทั้งสองมุมมี** (ชิด/รายการ) ต้องไม่ล้น และจอแคบของมุมรายการ
 *    ต้องกลายเป็นการ์ดพร้อมป้ายกำกับคอลัมน์เหมือนกัน
 * 6. กฎมือถือต้องไม่รั่วไปกระทบตารางอื่น (ตารางที่ไม่มี `.tpllist`)
 * 7. ที่จอแคบ ปุ่ม "เปิด" ต้อง**กดได้จริง** ไม่ใช่แค่มองเห็น
 * 8. จอมือถือ (390px) → แถบแท็บ**เห็นครบ 2 แถว ไม่มี scrollbar แนวนอน** และกดสลับได้จริง
 *
 * ── บั๊กที่เคยเจอและกฎกันไว้ ───────────────────────────────────
 * · การ์ดรอบตารางมี `overflow: hidden` ปุ่มที่ล้นออกไปจะ**ถูกตัดจนกดไม่ได้**
 *   ไม่ใช่แค่ "ต้องเลื่อนไปดู" (ก่อนแก้: ปุ่มขอบขวาอยู่ที่ 757px บนจอ 579px = ล้น 178px ทั้ง 11 แถว)
 * · กฎ `td.is-empty` ต้องอยู่**หลัง** `td:nth-child(2..4)` สองกฎ specificity เท่ากัน
 *   ถ้าย้ายไปก่อน `display: none` จะถูก `display: inline-flex` ทับ
 * · ต้องเช็ค**ทุกแถว** ไม่ใช่แถวแรว — ชื่อแม่แบบยาว ๆ บังคับให้ตารางกว้าง
 * · กฎต้อง scope ด้วย `.tpllist` เสมอ ตารางประวัติใน `HistoryPanel`
 *   (หน้าแก้ไข แท็บประวัติ) เป็น `<table>` ธรรมดาที่ยังต้องเป็นตาราง
 *
 * ⚠️ เทสต์นี้ไม่ยิง API เรนเดอร์เอกสาร ไม่แก้ข้อมูลจริง เป็นแค่การวัด layout
 *    ข้อ 6 ฉีด `<table>` เปล่าเข้าไปในหน้าแล้ววัด computed display
 *    เพราะ `HistoryPanel` จะเรนเดอร์ตารางเฉพาะเมื่อ `total > 0`
 *    (ต้องเรนเดอร์เอกสารจริงถึงจะมีประวัติ = เทสต์ช้าและเปราะเกินจำเป็น)
 *    เรื่องที่ต้องพิสูจน์คือ "CSS รั่วหรือไม่" ซึ่งฉีดตารางพิสูจน์ได้ตรงกว่า
 */
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Redis } from 'ioredis'

const CHROME = process.env.CHROME_PATH ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const PORT = 9364
const WEB = 'http://localhost:3000'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
mkdirSync(join(process.cwd(), 'logs'), { recursive: true })

let pass = 0
let fail = 0
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`)
  ok ? pass++ : fail++
}

const redis = new Redis(process.env.VALKEY_URL)
const sid = `listmob-${Date.now()}`
await redis.set(
  `session:${sid}`,
  JSON.stringify({ sub: sid, name: 'ทดสอบมือถือ', email: 'listmob@test.local', avatar: '' }),
  'EX',
  1800,
)

const profile = mkdtempSync(join(tmpdir(), 'cdp-listmob-'))
const chrome = spawn(
  CHROME,
  ['--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run', '--window-size=1440,900',
   `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, 'about:blank'],
  { stdio: 'ignore' },
)

let wsUrl = null
for (let i = 0; i < 40 && !wsUrl; i++) {
  await sleep(500)
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
    const page = list.find((x) => x.type === 'page')
    if (page) wsUrl = page.webSocketDebuggerUrl
  } catch { /* ยังไม่พร้อม */ }
}
if (!wsUrl) {
  console.log('✗ ต่อ Chrome DevTools ไม่ได้')
  chrome.kill()
  await redis.del(`session:${sid}`)
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
  const m = JSON.parse(ev.data)
  const s = waiting.get(m.id)
  if (!s) return
  waiting.delete(m.id)
  m.error ? s.reject(new Error(JSON.stringify(m.error))) : s.resolve(m.result)
})
await new Promise((r) => ws.addEventListener('open', r, { once: true }))

const evaluate = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text)
  return r.result?.value
}

/** รอเงื่อนไขที่จะใช้จริงถัดไปเสมอ ห้ามรอแค่ "มีปุ่มโผล่" (เคยตกเพราะรอผิดอย่าง) */
const waitFor = async (expr, ms = 60000) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    try {
      if (await evaluate(expr)) return true
    } catch { /* ยังไม่พร้อม */ }
    await sleep(300)
  }
  return false
}
const setWidth = async (width, height = 900) => {
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false })
  await sleep(600) // รอ reflow + media query มีผลจริง
}
const shot = async (name) => {
  const { data } = await send('Page.captureScreenshot', { format: 'png' })
  const file = join(process.cwd(), 'logs', `listmob-${name}.png`)
  writeFileSync(file, Buffer.from(data, 'base64'))
  return file
}

await send('Page.enable')
await send('Runtime.enable')
await setWidth(1440)
await send('Network.setCookie', { name: 'docgen_session', value: sid, url: WEB })
await send('Network.setCacheDisabled', { cacheDisabled: true })
await send('Page.navigate', { url: `${WEB}/studio` })
await waitFor('!document.querySelector(".bootveil")')
// รอปุ่มที่จะใช้จริง ไม่ใช่รอแค่มีแถว
const gotRows = await waitFor(
  "[...document.querySelectorAll('.tpllist tbody tr')].filter(tr => [...tr.querySelectorAll('button')].some(b => b.textContent.trim() === 'เปิด')).length > 0",
  45000,
)
if (!gotRows) {
  console.log('✗ โหลดตารางรายการแม่แบบไม่ได้ — ทดสอบต่อไม่ได้')
  console.log('  ภาพ:', await shot('cannot-load'))
  await send('Browser.close').catch(() => {})
  chrome.kill()
  await redis.del(`session:${sid}`)
  redis.disconnect()
  process.exit(1)
}

/**
 * วัดทุกอย่างที่ต้องผ่านในจอหนึ่งความกว้าง
 * ⚠️ เช็คทุกแถว ไม่ใช่แถวแรก — ชื่อแม่แบบยาว ๆ บังคับให้ตารางกว้างเกินจอ
 */
const probe = () =>
  evaluate(`(() => {
  const de = document.documentElement
  const rows = [...document.querySelectorAll('.tpllist tbody tr')]
  const info = rows.map((tr) => {
    /**
     * ⚠️ เก็บปุ่มจาก**ช่องจัดการ** ไม่ใช่เซลล์สุดท้าย และไม่ใช่ทั้งแถว
     *   · เดิมอ่าน tr.lastElementChild → หลังเพิ่มคอลัมน์ภาพย่อท้ายสุด
     *     กลายเป็นช่องรูปที่ไม่มีปุ่มอยู่เลย → minH = 0 → ตกทุกครั้ง
     *   · ถ้าเก็บทั้งแถวจะไปติด**ปุ่มชื่อแม่แบบ** ด้วย ซึ่งทำเป็นลิงก์ข้อความ
     *     (padding: 0 สูงราว 21px) นั่นไม่ใช่ปุ่มจัดการ และไม่ต้อง 36px
     *     เกณฑ์ ≥36px เป็นของปุ่มจัดการที่ต้องแตะนิ้ว
     */
    const acts = tr.querySelector('td.tplrow__acts')
    const btns = acts
      ? [...acts.querySelectorAll('button, a')].filter((b) => b.getClientRects().length)
      : []
    return {
      right: Math.round(tr.getBoundingClientRect().right),
      /** ปุ่มที่โดนจอขอาง — นี่คือ "ถูกตัดจนกดไม่ได้" */
      out: btns.filter((x) => x.getBoundingClientRect().right > innerWidth + 0.5).length,
      h: btns.length ? Math.min(...btns.map((x) => Math.round(x.getBoundingClientRect().height))) : 0,
    }
  })
  const thead = document.querySelector('.tpllist thead')
  const cells = [...document.querySelectorAll('.tpllist tbody td')]
  return {
    w: innerWidth,
    overflow: Math.max(de.scrollWidth, document.body.scrollWidth) - innerWidth,
    rows: rows.length,
    outRows: info.filter((r) => r.out > 0).length,
    minH: info.length ? Math.min(...info.map((r) => r.h)) : 0,
    theadShown: !!thead?.getClientRects().length,
    rowDisplay: rows[0] ? getComputedStyle(rows[0]).display : '?',
    cols: rows[0] ? rows[0].children.length : 0,
    emptyHidden: cells.filter((td) => td.classList.contains('is-empty')).every((td) => getComputedStyle(td).display === 'none'),
    emptyTotal: cells.filter((td) => td.classList.contains('is-empty')).length,
    /** display ของช่องภาพย่อ — ต้องเห็นรูปเฉพาะโหมดชิด */
    thumbShown: (() => {
      const td = document.querySelector('.tpllist tbody tr td.tplrow__thumb')
      return td ? getComputedStyle(td).display : 'ไม่มี td'
    })(),

    /**
     * ⚠️ แถวตัวกรอง: ปุ่มสวิตช์ (ชิด/รายการ) ต้องอยู่บรรทัดเดียวกับช่องค้นหา
     *   ผู้ใช้สั่ง: *"หน้าจอเล็กให้อยู่บรรทัดเดียวกับค้นหา"*
     *   เคยพังเพราะ .filters__q มี flex-basis: 100% ใน media query
     *   แล้วดันปุ่มลงบรรทัดใหม่ — เทสต์เดิมตรวจแถวนี้ไม่ได้เลย ผ่านมาตลอด
     */
    filters: (() => {
      const q = document.querySelector('.filters__q')
      const t = document.querySelector('.viewtoggle')
      if (!q || !t) return null
      const qr = q.getBoundingClientRect()
      const tr = t.getBoundingClientRect()
      const bs = [...t.querySelectorAll('.viewtoggle__btn')].map((b) =>
        Math.round(b.getBoundingClientRect().width)
      )
      return {
        /** ต่างกันกี่ px ในแนวตั้ง = อยู่คนละบรรทัดกัน */
        dy: Math.round(Math.abs(qr.top - tr.top)),
        minBtnW: bs.length ? Math.min(...bs) : 0,
      }
    })(),
    labels: [...new Set([...document.querySelectorAll('.tpllist tbody td[data-label]')].map((td) => getComputedStyle(td, '::before').content).filter((c) => c && c !== 'none' && c !== 'normal'))],
  }
})()`)

// ── 1–4 · จอมือถือ ────────────────────────────────────────────────
for (const w of [360, 414, 579]) {
  console.log(`\nจอ ${w}px`)
  await setWidth(w)
  const p = await probe()
  check('หน้าไม่ล้นแนวนอน', p.overflow <= 0, `ล้น ${p.overflow}px`)
  check('ปุ่มจัดการอยู่ในจอทุกแถว', p.outRows === 0, `ล้น ${p.outRows}/${p.rows} แถว`)
  check('หัวตารางซ่อน (กลายเป็นการ์ด)', !p.theadShown && p.rowDisplay === 'flex', `thead=${p.theadShown} tr=${p.rowDisplay}`)
  check('ปุ่มสูงพอแตะนิ้ว (≥36px)', p.minH >= 36, `${p.minH}px`)
  check('ช่องว่างถูกซ่อน', p.emptyHidden, `มี ${p.emptyTotal} ช่องว่าง`)

  /**
   * ⚠️ ปุ่มสวิตช์ (ชิด/รายการ) ต้องอยู่บรรทัดเดียวกับช่องค้นหา
   *   ผู้ใช้สั่ง: *"หน้าจอเล็กให้อยู่บรรทัดเดียวกับค้นหา"*
   *   เคยใส่ flex-basis:100% ที่ช่องค้นหาเพื่อให้กว้าง
   *   แต่ผลคือมันดันปุ่มลงบรรทัดใหม่ แล้วแถวนี้ดูเหมือนจัดวางไม่เสร็จ
   */
  check(
    'ช่องค้นหากับปุ่มสวิตช์อยู่บรรทัดเดียวกัน',
    !!p.filters && p.filters.dy <= 2,
    p.filters ? `ต่างกัน ${p.filters.dy}px` : 'ไม่เจอช่องค้นหา/ปุ่มสวิตช์'
  )
  check(
    'ปุ่มสวิตช์ไม่ถูกบีบจนเล็กกว่า 36px',
    (p.filters?.minBtnW ?? 0) >= 36,
    `${p.filters?.minBtnW ?? 0}px`
  )
  /**
   * ⚠️ ภาพย่อโชว์**เฉพาะโหมดชิด** — ผู้ใช้สั่ง:
   *    *"ผมเลือกแบบรายการ ไม่ควรจะมีรูป"*
   *    เคยหลุดเพราะกฎ `.tpllist td { display: block }` ใน media query
   *    มี specificity สูงกว่า `.tplrow__thumb { display: none }` → รูปโผล่ท้ายการ์ด
   */
  check('ชิด: มีภาพย่อให้ดู', p.thumbShown === 'block', p.thumbShown)
  check('มีป้ายกำกับแทนคอลัมน์', p.labels.length >= 2, p.labels.join(' '))
  if (w === 579) console.log('  ภาพ:', await shot('w579'))
}

// ── 5 · จอกว้าง: ทั้งสองมุมมีต้องไม่พัง ───────────────────────────
/**
 * ⚠️ เขียนไว้ก่อนมีสวิตช์ "รายการ/ชิด"
 *   เดิมคาดว่าหน้ารายการเป็นตารางเสมอ แต่ตอนนี้**ค่าเริ่มต้นคือ "ชิด"**
 *   (`.tpllist--grid` = การ์ดเรียงตามกริด) ซึ่งตั้งใจให้
 *   · `thead` ถูกซ่อน
 *   · `tr` เป็น `flex`
 *   · มีคอลัมน์ภาพย่อต่อท้ายสุด → 6 ช่อง
 *   เกณฑ์เดิมจึงตก 4 ข้อ ทั้งที่ CSS ถูกอยู่แล้ว
 *   (เจอตอนรันซ้ำหลังเพิ่มฟีเจอร์นี้ ไม่ใช่จากงาน popup)
 *
 *   แก้โดย**เช็กทั้งสองมุมมี** ไม่ใช่แค่แก้ตัวเลขให้ผ่าน
 *   เพราะกติกาจอแควของสองโหมดต่างกันจริง: โหมดรายการใช้ `td[data-label]::before`
 *   ส่วนโหมดชิดไม่ต้องป้ายกำกับเลย (การ์ดต่อการ์ดอยู่แล้ว)
 *
 * ⚠️ ไม่วัดความสูงปุ่มที่ 1440px
 *   เกณฑ์ ≥36px เป็นกติกา**จอแคบ** (ข้อ 3) ปุ่มจอกว้างหดตามเนื้อหา
 *   วัดที่จอกว้างแล้วได้ค่าที่ไม่ผ่าน ทั้งที่หน้าจอถูกต้อง (เคยเจะเป็นกับ `fill`)
 */
const clickSel = async (sel) => {
  const box = await evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(sel)})
    if (!el) return null
    el.scrollIntoView({ block: 'center' })
    const r = el.getBoundingClientRect()
    const x = r.x + r.width / 2, y = r.y + r.height / 2
    const hit = document.elementFromPoint(x, y)
    return { ok: !!hit && (hit === el || el.contains(hit)), x, y, disabled: !!el.disabled }
  })()`)
  if (!box?.ok)
    return { ...(box ?? {}), ok: false, why: box?.disabled ? 'ปุ่มถูก disable' : 'มีอย่างอื่นบังจุดกด' }
  for (const type of ['mousePressed', 'mouseReleased'])
    await send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 })
  return box
}

console.log('\nจอ 1440px · มุม "ชิด" (ค่าเริ่มต้น)')
await setWidth(1440)
const g = await probe()
check('ชิด: เป็นการ์ดเรียงกริด (tr=flex)', g.rowDisplay === 'flex', g.rowDisplay)
check('ชิด: หัวตารางถูกซ่อนตั้งใจ', g.theadShown === false, `thead โชว์=${g.theadShown}`)
check('ชิด: มีคอลัมน์ภาพย่อต่อท้าย (6 ช่อง)', g.cols === 6, `${g.cols} ช่อง`)
check('ชิด: หน้าไม่ล้นแนวนอน', g.overflow <= 0, `ล้น ${g.overflow}px`)
check(
  'ช่องว่างกลับมาโชว์ที่จอกว้าง (กฎซ่อนช่องว่างใช้เฉพาะจอแคบ)',
  g.emptyHidden === false || g.emptyTotal === 0,
  `มี ${g.emptyTotal} ช่องว่าง · ซ่อน=${g.emptyHidden}`
)
await shot('w1440-grid')

console.log('\nจอ 1440px · มุม "รายการ" (ต้องยังเป็นตารางเหมือนเดิม)')
const sw = await clickSel('[data-testid="view-list"]')
check('กดสวิตช์สลับเป็นมุมรายการได้', !!sw.ok, sw.why ?? '')
await sleep(500)
const l = await probe()
check('รายการ: กลับมาเป็นตาราง (tr=table-row)', l.rowDisplay === 'table-row', l.rowDisplay)
check('รายการ: หัวตารางยังอยู่', l.theadShown === true)
check('รายการ: คอลัมน์ครบ 6 ช่อง (รวมภาพย่อท้ายสุด)', l.cols === 6, `${l.cols} ช่อง`)
check('รายการ: หน้าไม่ล้นแนวนอน', l.overflow <= 0, `ล้น ${l.overflow}px`)
check('รายการ: ซ่อนภาพย่อ', l.thumbShown === 'none', l.thumbShown)
await shot('w1440-list')

/**
 * ⚠️ ต้องเช็กจอแคบของโหมดรายการด้วย
 *   กติกา `td:nth-child(2..4)` + `data-label::before` ที่ทำให้ตาราง
 *   กลายเป็นการ์ดตอนจอแคบ ผูกอยู่กับโหมดรายการ
 *   เดิมชุดนี้วัดแค่โหมดชิดตอนจอแคบ → กติกานี้ไม่เคยถูกตรวจเลย
 */
console.log('\nจอ 579px · มุม "รายการ" (กติกาป้ายกำกับคอลัมน์อยู่โหมดนี้)')
await setWidth(579)
const n = await probe()
check('รายการจอแคบ: หน้าไม่ล้นแนวนอน', n.overflow <= 0, `ล้น ${n.overflow}px`)
check('รายการจอแคบ: ปุ่มอยู่ในจอทุกแถว', n.outRows === 0, `ล้น ${n.outRows}/${n.rows} แถว`)
check(
  'รายการจอแคบ: หัวตารางซ่อน กลายเป็นการ์ด',
  !n.theadShown && n.rowDisplay === 'flex',
  `thead=${n.theadShown} tr=${n.rowDisplay}`
)
check('รายการจอแคบ: ปุ่มสูงพอแตะนิ้ว (≥36px)', n.minH >= 36, `${n.minH}px`)
check('รายการจอแคบ: ช่องว่างถูกซ่อน', n.emptyHidden, `มี ${n.emptyTotal} ช่องว่าง`)
/**
 * ⚠️ ข้อนี้คือบั๊กที่ผู้ใช้เจอ และเทสต์เดิมตรวจไม่ได้เลย
 *   เพราะกตรวจแค่ที่จอกว้าง ซึ่งกฎจอแคบไม่ทำงาน → ผ่านมาตลอด
 *   ตอนจอแคบ กฎ td { display: block } ชนะ display:none ของช่องรูป
 */
check('รายการจอแคบ: ไม่มีภาพย่อโผล่ท้ายการ์ด', n.thumbShown === 'none', n.thumbShown)
check('รายการจอแคบ: มีป้ายกำกับแทนคอลัมน์', n.labels.length >= 2, n.labels.join(' '))
await shot('w579-list')

// กลับเป็น "ชิด" ก่อนจบ ให้ผู้ใช้เจอค่าเริ่มต้นเหมือนเดิม (ค่านี้จำใน localStorage)
const backGrid = await clickSel('[data-testid="view-grid"]')
check('กดสวิตช์กลับเป็นชิดได้', !!backGrid.ok, backGrid.why ?? '')
await sleep(300)
await setWidth(390)
// ── 6 · กฎต้องไม่รั่วไปตารางอื่น ───────────────────────────────────
console.log('\nไม่กระทบตารางอื่น')
await setWidth(390)
const leak = await evaluate(`(() => {
  const t = document.createElement('table')
  t.id = 'probe-plain'
  t.innerHTML = '<thead><tr><th>a</th></tr></thead><tbody><tr><td>b</td></tr></tbody>'
  document.body.appendChild(t)
  const row = t.querySelector('tbody tr')
  const th = t.querySelector('th')
  const out = {
    tr: getComputedStyle(row).display,
    td: getComputedStyle(row.querySelector('td')).display,
    th: getComputedStyle(th).display,
    thead: getComputedStyle(t.querySelector('thead')).display,
  }
  t.remove()
  return out
})()`)
check('ตารางธรรมดายังเป็นตาราง', leak.tr === 'table-row' && leak.td === 'table-cell', JSON.stringify(leak))
/**
 * ⚠️ ค่า `thead` ของเบราว์เซอร์คือ `table-header-group` (ไม่ใช่ `table-group`)
 *    เคยเขียนเกณฑ์ผิดตัวนี้ เทสต์ตกทั้งที่ CSS ถูกอยู่แล้ว
 *    → ถ้าเทสต์ตก ต้องแยกให้ออกก่อนว่า "โค้ดผิด" หรือ "เกณฑ์ผิด"
 */
check('หัวตารางธรรมดายังโชว์', leak.th === 'table-cell' && leak.thead === 'table-header-group', JSON.stringify(leak))

// ── 7 · กดปุ่ม "เปิด" ที่จอแคบต้องได้จริง ────────────────────────────
console.log('\nกดปุ่มที่จอแคบ')
const target = await evaluate(`(() => {
  const row = [...document.querySelectorAll('.tpllist tbody tr')]
    .find((tr) => [...tr.querySelectorAll('button')].some((b) => b.textContent.trim() === 'เปิด'))
  if (!row) return { miss: 'ไม่เจอแถว' }
  const btn = [...row.querySelectorAll('button')].find((b) => b.textContent.trim() === 'เปิด')
  btn.scrollIntoView({ block: 'center' })
  const r = btn.getBoundingClientRect()
  const x = r.x + r.width / 2
  const y = r.y + r.height / 2
  const hit = document.elementFromPoint(x, y)
  return { x, y, hit: hit ? hit.tagName + '.' + (hit.className || '') : 'null' }
})()`)
if (target.miss) {
  check('หาปุ่มเปิดได้', false, target.miss)
} else {
  check('จุดกดโดนปุ่มจริง (ไม่โดนอย่างอื่นบัง)', target.hit?.includes('BUTTON'), target.hit)
  for (const type of ['mousePressed', 'mouseReleased'])
    await send('Input.dispatchMouseEvent', { type, x: target.x, y: target.y, button: 'left', clickCount: 1 })
  const opened = await waitFor("location.pathname !== '/studio' && document.querySelectorAll('.tabs__tab').length > 0", 30000)
  check('กดแล้วเปิดหน้าแก้ไขได้จริง', opened, await evaluate('location.pathname'))
}


// ── 8 · ปุ่มจัดการเล็กลงและมีไอคอน ───────────────────────────────
/**
 * ⚠️ ผู้ใช้สั่ง: *"ทำให้ปุ่ม bookmark และปุ่มอื่นๆ เล็กลง เพิ่ม icon ให้ด้วย"*
 *   (ภาพที่ผู้ใช้ถ่าย: จอ 579px ปุ่ม 4 ปุ่มยืดเต็มความกว้างจอเป็นแถวเดียว)
 *
 *   เดิมกฎจอแคบใช้ `flex: 1 1 0; min-width: 84px` → ปุ่มพอกันเต็มบรรทัด
 *   แก้เป็น `flex: 0 0 auto` แล้วต้อง**วัดพื้นที่ที่ปุ่มกินจริง**
 *   ไม่ใช่แค่เปลี่ยน CSS แล้วเชื่อว่าเล็กลง (เคยเจอกรณีแบบนี้มาแล้ว)
 *
 * ⚠️ ข้อสำคัญ: `textContent` ของปุ่มต้องยังเป็นคำเดียวเป๊ะ ๆ ("เปิด")
 *   เพราะเทสต์หลายชุดเลือกปุ่มในแถวด้วยเงื่อนไขนี้ (รวมทั้งไฟล์นี้เอง
 *   บรรทัด 138 / 240 / 242) → ทำให้ไอคอนเป็น `::before` ไม่ใช่ node ใน DOM
 *   ข้อนี้คือ**กันดัก** ไม่ใช่แค่บันทึกว่าเลือกแบบนี้
 *
 * ⚠️ ความสูงขั้นต่ำ 36px ยังไม่ลด (ข้อ 3 ของชุดนี้)
 *    "เล็กลง" จึงหมายถึงเล็กลงใน**แนวกว้าง**
 *    ถ้าจะลดความสูงด้วย ต้องแก้ข้อ 3 ให้ตรงกันด้วย ไม่ใช่ปล่อยให้ตกเงียบ
 */
console.log('\nปุ่มจัดการเล็กลง + มีไอคอน')
await send('Page.navigate', { url: `${WEB}/studio` })
await waitFor('!document.querySelector(".bootveil")', 45000)
const rowsBack = await waitFor(
  "[...document.querySelectorAll('.tpllist tbody tr')].filter(tr => [...tr.querySelectorAll('button')].some(b => b.textContent.trim() === 'เปิด')).length > 0",
  45000
)
check('กลับมาที่หน้ารายการได้', !!rowsBack)

const rowBtns = () =>
  evaluate(`(() => {
  const tr = [...document.querySelectorAll('.tpllist tbody tr')].find((x) => [...x.querySelectorAll('button')].some((b) => b.textContent.trim() === 'เปิด'))
  if (!tr) return { miss: 'ไม่เจอแถว' }
  const cell = tr.querySelector('td.tplrow__acts')
  if (!cell) return { miss: 'ไม่เจอ td.tplrow__acts' }
  const btns = [...cell.querySelectorAll('button')]
  const byText = (t) => btns.find((b) => b.textContent.trim() === t)
  const icon = (el) => {
    if (!el) return ''
    const v = getComputedStyle(el, '::before').content
    return v && v !== 'none' && v !== 'normal' ? v : ''
  }
  const box = cell.getBoundingClientRect()
  const rects = btns.map((b) => b.getBoundingClientRect())
  const left = Math.min(...rects.map((b) => b.left))
  const right = Math.max(...rects.map((b) => b.right))
  const star = btns.find((b) => '★☆'.includes(b.textContent.trim()))
  return {
    n: btns.length,
    fill: box.width ? Math.round(((right - left) / box.width) * 100) : 0,
    span: Math.round(right - left),
    openText: (byText('เปิด') || {}).textContent?.trim() || '',
    lastLabel: byText('ลบ') ? 'ลบ' : byText('สำเนา') ? 'สำเนา' : '',
    starW: star ? Math.round(star.getBoundingClientRect().width) : 0,
    starLabel: star ? star.getAttribute('aria-label') || '' : '',
    starPressed: star ? star.getAttribute('aria-pressed') : null,
    icons: {
      open: icon(byText('เปิด')),
      dl: icon(byText('ดาวน์โหลด')),
      del: icon(byText('ลบ') || byText('สำเนา')),
    },
  }
})()`)

for (const w of [579, 1440]) {
  console.log(`\nจอ ${w}px`)
  await setWidth(w)
  await sleep(400)
  const r = await rowBtns()
  check(
    'ปุ่มช่องสุดท้ายยังมีอยู่ (ลบ หรือ สำเนา) — ไม่หายไปทั้งดุ้น',
    ['ลบ', 'สำเนา'].includes(r.lastLabel),
    JSON.stringify(r.lastLabel)
  )
  check('เจอปุ่มจัดการ 4 ปุ่ม', r.n === 4, `${r.n} ปุ่ม`)
  check('textContent ยังเป็น "เปิด" เป๊ะ (กันเทสต์อื่นพัง)', r.openText === 'เปิด', JSON.stringify(r.openText))
  check('มีไอคอนหน้า "เปิด"', !!r.icons.open, r.icons.open || 'ไม่มี')
  check('มีไอคอนหน้า "ดาวน์โหลด"', !!r.icons.dl, r.icons.dl || 'ไม่มี')
  check('มีไอคอนหน้า "ลบ"', !!r.icons.del, r.icons.del || 'ไม่มี')
  check('ปุ่มดาวมี aria-label', !!r.starLabel, r.starLabel || 'ไม่มี')
  check('ปุ่มดาวมี aria-pressed', r.starPressed !== null, String(r.starPressed))
  check('ปุ่มดาวเล็กลง (≤ 40px)', r.starW > 0 && r.starW <= 40, `${r.starW}px`)
  /*
   * ⚠️ วัด "ไม่ยืดเต็มบรรทัด" **เฉพาะจอแคบ**
   *   จอกว้างคอลัมน์ "จัดการ" จะหดตามเนื้อหาอยู่แล้ว → fill สูงเสมอ
   *   ถ้าวัดที่จอกว้างด้วยจะได้ค่าที่ไม่ผ่าน ทั้งที่หน้าจอถูกต้องแล้ว
   *   (เทสต์ที่ตกเพราะวัดผิดที่ = เทสต์ที่ทำให้คนแก้โค้ดเสีย)
   */
  if (w === 579) {
    check('ปุ่มไม่ยืดเต็มบรรทัด (กินพื้นที่ < 90%)', r.fill < 90, `${r.fill}% (กว้าง ${r.span}px)`)
    await shot('w579-small-buttons')
  }
}
/**
 * ── 9 · แถบแท็บบนมือถือ ──────────────────────────────────────────────
 * ผู้ใช้สั่ง: *"ทำให้รองรับหน้าจอแบบมือถือ"*
 * (ภาพจาก /studio ที่ 481×539 — แท็บที่ 4 หลุดนอกจอ + scrollbar แนวนอนโผล่)
 *
 * ⚠️ เดิมเป็น `display:flex; overflow-x:auto` = เลื่อนแนวนอนได้
 *    ซึ่งแย่มากบนมือถือ
 *    · scrollbar กินความสูงจอ และมือถือหลายเครื่องซ่อนมันอยู่แล้ว
 *      → เห็นแถบเลื่อนตัวเองเฉย ๆ แต่ไม่รู้ว่าต้องเลื่อน
 *    · แท็บที่ 4 ซ่อนนอกจอ ผู้ใช้เลยไม่รู้ว่ามีแท็บนั้น
 *    · แก้เป็นกริด 2 คอลัมน์ → เห็นครบทุกแท็บโดยไม่ต้องเลื่อนอะไรเลย
 *
 * ⚠️ ตรวจที่ 390px ไม่ใช่ 481px
 *    481 คือจอที่ผู้ใช้ถ่าย แต่ของจริงที่ใช้บนมือถือเล็กกว่านั้นอีก
 *    ถ้าแก้แล้วผ่านที่ 481 แต่พังที่ 390 = แก้ไม่จริง
 */
console.log('\n[9] เมนูนำทางบนมือถือ (390px) — เก็บในลิ้นชัก ไม่กินความกว้างเนื้อหา')
await setWidth(390)

/*
 * จังหวะที่ 1 — ลิ้นชัก**ปิดอยู่**
 * ⚠️ ตอนนี้แท็บอยู่นอกจอโดยเจตนา ไม่ใช่หลุดจอ
 *   เกณฑ์ที่สำคัญจึงเปลี่ยนไปเป็น "ไม่กินความกว้างเนื้อหา + ปุ่มเมนูกดได้"
 */
const closed = await evaluate(`(() => {
  const rail = document.querySelector('[data-testid="studio-rail"]')
  const btn = document.querySelector('[data-testid="rail-open"]')
  if (!rail || !btn) return null
  const rb = rail.getBoundingClientRect()
  const bb = btn.getBoundingClientRect()
  const x = bb.x + bb.width / 2, y = bb.y + bb.height / 2
  const hit = document.elementFromPoint(x, y)
  return {
    tabs: rail.querySelectorAll('.tabs__tab').length,
    /** ขอบขวาของ sidebar ยังอยู่ซ้ายของขอบจออยู่ไหม = พับเก็บแล้ว */
    railRight: Math.round(rb.right),
    btnW: Math.round(bb.width),
    btnH: Math.round(bb.height),
    btnOut: Math.round(Math.max(0, bb.right - document.documentElement.clientWidth)),
    btnHit: !!hit && (hit === btn || btn.contains(hit)),
  }
})()`)
check('เจอ sidebar', !!closed, closed ? '' : 'ไม่เจอ [data-testid=studio-rail]')
if (!closed) {
  skipCheck('เมนูบนมือถือ', 'ไม่เจอ sidebar')
} else {
  check('มีแท็บครบ 5 อันในเมนู', closed.tabs === 5, `${closed.tabs} แท็บ`)
  check('ลิ้นชักพับเก็บนอกจอ (ไม่กินความกว้างเนื้อหา)', closed.railRight <= 1, `ขอบขวาอยู่หลังขอบจอ ${closed.railRight}px`)
  check('ปุ่มเมนูสูงพอแตะนิ้ว ≥36px', closed.btnH >= 36, `${closed.btnW}×${closed.btnH}px`)
  check('ปุ่มเมนูไม่ล้นออกจอ', closed.btnOut === 0, `ล้น ${closed.btnOut}px`)
  check('จุดกดปุ่มเมนูไม่ถูกอะไรบัง', closed.btnHit, '')

  // ── เปิดลิ้นชักด้วยเมาส์จริง ไม่ใช่ element.click() ─────────────────
  const mb = await evaluate(`(() => {
    const b = document.querySelector('[data-testid="rail-open"]')
    if (!b) return null
    const r = b.getBoundingClientRect()
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
  })()`)
  for (const type of ['mousePressed', 'mouseReleased'])
    await send('Input.dispatchMouseEvent', { type, x: mb.x, y: mb.y, button: 'left', clickCount: 1 })
  await sleep(500)

  const open = await evaluate(`(() => {
    const el = document.querySelector('[data-testid="studio-rail"]')
    if (!el) return null
    const r = el.getBoundingClientRect()
    const tabs = [...el.querySelectorAll('.tabs__tab')]
    return {
      railW: Math.round(r.width),
      railRight: Math.round(r.right),
      railTop: Math.round(r.top),
      /** ต้องเป็นแนวตั้ง = แต่ละแท็บคนละบรรทัด ไม่ใช่เรียงกันในแถวเดียว */
      rows: new Set(tabs.map((t) => Math.round(t.getBoundingClientRect().top))).size,
      tabs: tabs.map((t) => {
        const b = t.getBoundingClientRect()
        return {
          text: t.textContent.trim().replace(/\\s+/g, ' ').slice(0, 14),
          w: Math.round(b.width),
          h: Math.round(b.height),
          outRight: Math.round(Math.max(0, b.right - innerWidth)),
          outLeft: Math.round(Math.max(0, -b.left)),
          on: t.classList.contains('tabs__tab--on'),
        }
      }),
    }
  })()`)
  check('เปิดลิ้นชักแล้วแถบเข้าจอ', (open?.railRight ?? 0) > 0 && (open?.railTop ?? -1) >= -1, `ขวาสุด ${open?.railRight}px`)
  check('เมนูกว้างพอสำหรับชื่อแท็บ (200-320px)', (open?.railW ?? 0) >= 200 && (open?.railW ?? 0) <= 320, `${open?.railW}px`)
  check('แท็บเรียงแนวตั้ง (คนละแถว)', open?.rows === open?.tabs.length, `${open?.rows} แถว / ${open?.tabs.length} แท็บ`)
  check('ไม่มีแท็บหลุดออกนอกจอ', open?.tabs.every((t) => t.outRight === 0 && t.outLeft === 0) === true, JSON.stringify(open?.tabs.map((t) => t.outRight)))
  check('ทุกแท็บกดได้ (สูงพอแตะนิ้ว ≥36px)', open?.tabs.every((t) => t.h >= 36) === true, JSON.stringify(open?.tabs.map((t) => t.h)))
  check('ทุกแท็บกว้างพอให้เห็น (≥60px)', open?.tabs.every((t) => t.w >= 60) === true, JSON.stringify(open?.tabs.map((t) => t.w)))
  check('มีแท็บที่เลือกอยู่ถูกไฮไลต์', open?.tabs.some((t) => t.on) === true, open?.tabs.find((t) => t.on)?.text ?? 'ไม่มี')
  await shot('w390-drawer')

  const wasOn = open?.tabs.find((t) => t.on)?.text
  const box = await evaluate(`(() => {
    const t = [...document.querySelectorAll('.tabs__tab')].find((x) => !x.classList.contains('tabs__tab--on'))
    if (!t) return null
    t.scrollIntoView({ block: 'nearest' })
    const r = t.getBoundingClientRect()
    const x = r.x + r.width / 2, y = r.y + r.height / 2
    const hit = document.elementFromPoint(x, y)
    return { ok: !!hit && (hit === t || t.contains(hit)), label: t.textContent.trim().replace(/\\s+/g, ' ').slice(0, 14), x, y }
  })()`)
  check('จุดกดแท็บในลิ้นชักไม่ถูกอะไรบัง', !!box?.ok, box?.ok ? box.label : 'มีอย่างอื่นบังจุดกด')
  if (box?.ok) {
    for (const type of ['mousePressed', 'mouseReleased'])
      await send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 })
    await sleep(500)
    const after = await evaluate(`(() => {
      const t = [...document.querySelectorAll('.tabs__tab')].find((x) => x.classList.contains('tabs__tab--on'))
      return t ? t.textContent.trim().replace(/\\s+/g, ' ').slice(0, 14) : null
    })()`)
    check('กดแท็บในลิ้นชักแล้วเปลี่ยนจริง', !!after && after !== wasOn, `${wasOn} → ${after}`)
    /**
     * ⚠️ ต้องปิดลิ้นชักเอง ไม่ใช่แค่เปลี่ยนแท็บ
     *   ไม่งั้นผู้ใช้เลือกเมนูเสร็จแล้วยังเห็นเมนูบังเนื้อหาที่เพิ่งเลือก
     *   และจะเข้าใจว่าหน้าเว็บค้าง
     */
    check('เลือกแล้วลิ้นชักปิดเอง', await evaluate(`(() => {
      const r = document.querySelector('[data-testid="studio-rail"]')
      if (!r) return false
      return r.getBoundingClientRect().right <= 1
    })()`), '')
    // กลับแท็บแรกไว้ที่เดิม ไม่ให้ผู้ใช้เจอหน้าที่เปลี่ยนไปแล้วคิดว่าระบบพัง
    await evaluate(`(() => {
      document.querySelector('[data-testid="rail-open"]')?.click()
    })()`)
    await sleep(350)
    await evaluate(`document.querySelector('.tabs__tab')?.click()`)
    await sleep(300)
  }
}

await setWidth(579)
console.log(`\nผ่าน ${pass} · ตก ${fail}`)
await send('Browser.close').catch(() => {})
chrome.kill()
await redis.del(`session:${sid}`)
redis.disconnect()
process.exit(fail ? 1 : 0)
