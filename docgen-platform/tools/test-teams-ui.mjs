/**
 * ระบบทีม — ทดสอบหน้าเว็บจริง (สร้างทีม · เชิญ · เปลี่ยนสิทธิ์ · ถอน · ย้ายแม่แบบ)
 *
 *   node --env-file=../dokploy-infra/.env --env-file=../dokploy-infra/.env.development tools/test-teams-ui.mjs
 *
 * ทำ session ปลอมใน Valkey เหมือน test-teams.mjs
 * เน้นสิ่งที่ API เทสต์ไม่ได้: ปุ่มถูกซ่อน/โผล่ตามสิทธิ์จริง และผลบนจอตรงกับที่เก็บ
 */
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Redis } from 'ioredis'
import { MongoClient } from 'mongodb'
import { resolveMongoUrl } from '@docgen/shared'

const WEB = 'http://localhost:3000'
const API = process.env.API_URL ?? 'http://127.0.0.1:4001'
const CHROME = process.env.CHROME_PATH ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const PORT = 9421
const STAMP = Date.now()
const OUT = new URL('../tests/nav-status/output-teams/', import.meta.url)
mkdirSync(OUT, { recursive: true })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let pass = 0
let fail = 0
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`)
  ok ? pass++ : fail++
}

const redis = new Redis(process.env.VALKEY_URL)
let mongo
const db = async () => {
  if (!mongo) {
    mongo = new MongoClient(await resolveMongoUrl(() => {}))
    await mongo.connect()
  }
  return mongo.db(process.env.MONGO_DB ?? 'app')
}

const OWNER = `tui-owner-${STAMP}`
const MEMBER = `tui-member-${STAMP}`
/** อีเมลของแต่ละคน — ตรงกับ session ปลอมด้านล่าง (เชิญด้วยอีเมล) */
const OWNER_EMAIL = `owner-${STAMP}@test.local`
const MEMBER_EMAIL = `member-${STAMP}@test.local`
const h = (sid) => ({ cookie: `docgen_session=${sid}`, 'content-type': 'application/json' })

/**
 * จำลองการเข้าสู่ระบบ → เรียก `claimPendingInvites()` ตัวจริง
 *
 * ⚠️ จุดที่เรียกจริงคือ callback ของ Casdoor (ยิงผ่าน HTTP ไม่ได้ในเทสต์)
 *   ต้องเรียกฟังก์ชันตรง ๆ ไม่ใช่แก้ Mongo เอง — ถ้าจำลองผลเอง เทสต์จะผ่านทั้งที่โค้ดพัง
 */
const claim = (sub, email) =>
  new Promise((res, rej) => {
    const c = spawn(
      process.execPath,
      ['--env-file=../dokploy-infra/.env --env-file=../dokploy-infra/.env.development', 'node_modules/tsx/dist/cli.mjs', 'tools/claim-pending.ts', sub, email, 'สมาชิกทดสอบ'],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    )
    let out = ''
    let errOut = ''
    c.stdout.on('data', (d) => (out += d))
    c.stderr.on('data', (d) => (errOut += d))
    c.on('close', (code) => (code === 0 ? res(Number(out.trim() || 0)) : rej(new Error(errOut.slice(0, 400)))))
  })

for (const [sid, name, email] of [
  [OWNER, 'เจ้าของทีมทดสอบ', OWNER_EMAIL],
  [MEMBER, 'สมาชิกทดสอบ', MEMBER_EMAIL],
]) {
  await redis.set(
    `session:${sid}`,
    JSON.stringify({ sub: sid, name, email, avatar: '' }),
    'EX',
    900,
  )
}

const call = async (path, sid, opt = {}) => {
  const hasBody = opt.body !== undefined
  const r = await fetch(`${API}${path}`, {
    method: opt.method ?? 'GET',
    ...(hasBody ? { body: JSON.stringify(opt.body) } : {}),
    headers: { cookie: `docgen_session=${sid}`, ...(hasBody ? { 'content-type': 'application/json' } : {}) },
  })
  const t = await r.text()
  let body = null
  try {
    body = t ? JSON.parse(t) : null
  } catch {
    body = t
  }
  return { status: r.status, body }
}

let teamId = ''
const teamName = `ทีมทดสอบ ${STAMP}`

// ── CDP ─────────────────────────────────────────────────────────
const profile = mkdtempSync(join(tmpdir(), 'cdp-teams-'))
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
const waitFor = async (e, ms = 20000) => {
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
const clickJs = async (js) => {
  /**
   * วนรอก่อนเสมอ เพราะเจอสองกับดักตอน Next dev:
   *   1) `Runtime.evaluate` ได้ค่า undefined ตอนหน้ากำลังเปลี่ยน → คลิกไปเปล่า
   *   2) หน้ายังไม่ไฮเดรต → ปุ่ม submit ไม่มี onSubmit → native form submit ไม่เกิดอะไร
   */
  let box = null
  for (let i = 0; i < 24; i++) {
    try {
      box = await evaluate(`(() => { ${js} })()`)
    } catch {
      box = null
    }
    if (box && typeof box.x === 'number' && box.ok) break
    box = box && typeof box.x === 'number' ? box : null
    await sleep(500)
  }
  if (!box?.ok) return box ?? { miss: 'หน้ายังไม่พร้อมรับคำสั่ง' }
  for (const type of ['mousePressed', 'mouseReleased'])
    await send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 })
  await sleep(400)
  return box
}
const clickTestId = (id) =>
  clickJs(`
    const el = document.querySelector('[data-testid=${JSON.stringify(id)}]')
    if (!el) return { miss: 'ไม่เจอ ${id}' }
    /**
     * ⚠️ ต้องรอ React ไฮเดรตก่อนคลิกเสมอ
     *   HTML จาก SSR ยังไม่มี onSubmit → กดแล้วเป็น native form submit (ไม่มีอะไรเกิดขึ้น)
     *   เคยเจอแล้ว: คลิกผ่าน แต่ทีมไม่ถูกสร้าง และหน้าเว็บรอเห็นการ์ดทีมจนตกทั้งชุด
     *   ใช้ fiber ของ React เป็นสัญญาณ — HTML ฝั่งเซิร์ฟเวอร์ไม่มีคีย์นี้
     */
    let hydrated = false
    for (const k in el) if (k.startsWith('__reactFiber$') || k.startsWith('__reactProps$')) { hydrated = true; break }
    el.scrollIntoView({ block: 'center' })
    const r = el.getBoundingClientRect()
    const x = r.x + r.width / 2, y = r.y + r.height / 2
    const hit = document.elementFromPoint(x, y)
    const onTop = !!hit && (hit === el || el.contains(hit))
    return {
      ok: hydrated && onTop,
      x, y,
      miss: !hydrated
        ? 'React ยังไม่ไฮเดรต (คลิกแล้วไม่มีอะไรเกิดขึ้น)'
        : onTop
          ? undefined
          : 'ปุ่มถูกบังโดย ' + (hit ? hit.tagName + '.' + (hit.className || '-') + ' tid=' + (hit.getAttribute('data-testid') ?? '-') : 'null'),
    }
  `)
/**
 * กดปุ่มแล้วรอผลจริง — คลิกเดียวอาจยังไม่พอ
 * คืนจำนวนครั้งที่กดแล้วผลปรากฏจริง (0 = กดไม่ได้เลย)
 */
const clickUntil = async (id, expect, ms = 20000) => {
  const end = Date.now() + ms
  let tries = 0
  while (Date.now() < end) {
    const c = await clickTestId(id)
    if (c?.ok) {
      tries++
      await sleep(1200)
      try {
        if (await evaluate(expect)) return tries
      } catch {}
    } else {
      await sleep(500)
    }
  }
  return 0
}
/**
 * เซ็ตค่าใน input/select แล้ว fire event ให้ React เห็น (ต้องใช้ native setter)
 * รอ hydration ก่อนเสมอ — ไม่งั้น onChange ยังไม่ผูก ค่าที่เซ็ตไม่ถูกนำไปใช้
 */
const setField = async (id, value) => {
  const end = Date.now() + 30000
  while (Date.now() < end) {
    const ready = await evaluate(`
      (() => {
        const el = document.querySelector('[data-testid=${JSON.stringify(id)}]')
        if (!el) return false
        for (const k in el) if (k.startsWith('__reactFiber$') || k.startsWith('__reactProps$')) return true
        return false
      })()
    `).catch(() => false)
    if (ready === true) break
    await sleep(400)
  }
  return evaluate(`
  (() => {
    const el = document.querySelector('[data-testid=${JSON.stringify(id)}]')
    if (!el) return false
    const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(value)})
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
    return true
  })()
  `)
}
const goto = async (url) => {
  await send('Page.navigate', { url })
  await sleep(1400)
}

await send('Page.enable')
await send('Runtime.enable')
await send('Network.enable')
await send('Network.setCookie', { name: 'docgen_session', value: OWNER, url: WEB })

try {
  // ── 1. หน้า /teams ───────────────────────────────────────────
  console.log('\n[1] หน้ารายชื่อทีม')
  await goto(`${WEB}/teams`)
  {
    check('เปิดหน้า /teams ได้', await waitFor(`!!document.querySelector('[data-testid="teams-rail"]')`))
    check('ยังไม่มีทีม → ขึ้นข้อความว่าง', await waitFor(`!!document.querySelector('[data-testid="teams-empty"]')`))
    check('มีฟอร์มสร้างทีม', await waitFor(`!!document.querySelector('[data-testid="teams-create-form"]')`))
    await shot('01-empty.png')
  }

  // ── 2. สร้างทีมจากหน้าเว็บ ───────────────────────────────────
  console.log('\n[2] สร้างทีม')
  {
    await setField('teams-create-name', teamName)
    const c = await clickTestId('teams-create-submit')
    check('กดสร้างทีมได้', !!c?.ok, c?.miss ?? '')
    // หน้า reload เองหลังสร้าง — รอจนกว่าจะเห็นการ์ดจริง
    check('เห็นการ์ดทีมใหม่', await waitFor(`!!document.querySelector('[data-testid="teams-list"]')`, 30000))

    const list = await call('/api/teams', OWNER)
    teamId = list.body?.items?.[0]?.team ?? ''
    check('มีทีมใน API ตรงกับหน้าเว็บ', !!teamId, teamId)
    check('role ของผู้สร้างเป็นเจ้าของทีม', list.body?.items?.[0]?.role === 'owner', list.body?.items?.[0]?.role)
    check('หน้าเว็บแสดงป้ายเจ้าของทีม', await waitFor(`document.querySelector('[data-testid="teams-role-${teamId}"]')?.textContent?.includes('เจ้าของ')`))
    await shot('02-created.png')
  }

  // ── 3. เชิญสมาชิก ────────────────────────────────────────────
  console.log('\n[3] เชิญสมาชิก')
  await goto(`${WEB}/teams/${encodeURIComponent(teamId)}`)
  {
    check('เปิดหน้าทีมได้', await waitFor(`!!document.querySelector('[data-testid="team-name"]')`))
    check('เห็นชื่อทีม', (await evaluate(`document.body.innerText`)).includes(teamName))
    check('เจ้าของทีมเห็นฟอร์มเชิญ', await waitFor(`!!document.querySelector('[data-testid="team-add-form"]')`))
    check('เจ้าของทีมเห็นปุ่มลบทีม', await waitFor(`!!document.querySelector('[data-testid="team-delete"]')`))

    await setField('team-add-email', MEMBER_EMAIL)
    await setField('team-add-role', 'editor')
    // คนที่เพิ่งถูกเชิญยังไม่มี sub → แถวในรายการใช้**อีเมล**เป็นตัวระบุ
    const a = await clickUntil('team-add-submit', `!!document.querySelector('[data-testid="team-member-${MEMBER_EMAIL}"]')`)
    check('กดเชิญได้', a > 0, a === 0 ? 'กดแล้วสมาชิกไม่โผล่' : `กด ${a} ครั้ง`)
    check('สมาชิกใหม่โผล่ในรายการ', await waitFor(`!!document.querySelector('[data-testid="team-member-${MEMBER_EMAIL}"]')`))
    check('ขึ้นป้าย "รอเข้าระบบ"', await waitFor(`!!document.querySelector('[data-testid="team-member-pending-${MEMBER_EMAIL}"]')`))
    check('role ถูกต้อง (ผู้แก้ไข)', await evaluate(`document.querySelector('[data-testid="team-member-role-${MEMBER_EMAIL}"]')?.textContent?.includes('ผู้แก้ไข')`))
    await shot('03-members.png')

    // จำลองเข้าสู่ระบบ → ผูกสมาชิกเป็นของจริง แล้วทดสอบต่อด้วย sub
    await claim(MEMBER, MEMBER_EMAIL)
    const d = await call(`/api/teams/${teamId}`, OWNER)
    check('บันทึกลง Mongo จริง — 2 คน', d.body?.members?.length === 2, `${d.body?.members?.length} คน`)
    check(
      'หลังเข้าสู่ระบบ ป้าย "รอเข้าระบบ" หายไป',
      await (async () => {
        await goto(`${WEB}/teams/${encodeURIComponent(teamId)}`)
        return waitFor(`!document.querySelector('[data-testid="team-member-pending-${MEMBER_EMAIL}"]')`)
      })(),
    )
  }

  // ── 4. owner คนสุดท้าย: ปุ่มถอนต้องถูกปิด ──────────────────────
  console.log('\n[4] ปุ่มถอนเจ้าของทีมคนสุดท้ายต้องกดไม่ได้')
  {
    const disabled = await evaluate(`
      document.querySelector('[data-testid="team-member-remove-${OWNER}"]')?.disabled
    `)
    check('ปุ่มถอนเจ้าของคนสุดท้ายถูก disable', disabled === true, `disabled=${disabled}`)
    const selDisabled = await evaluate(`
      document.querySelector('[data-testid="team-member-select-${OWNER}"]')?.disabled
    `)
    check('ตัวเลือกสิทธิ์ของตัวเองถูก disable', selDisabled === true, `disabled=${selDisabled}`)
  }

  // ── 5. สมาชิกถูกเชิญแล้วเห็นทีม แต่จัดการสมาชิกไม่ได้ ────────────
  console.log('\n[5] มุมมองของสมาชิก')
  {
    await send('Network.setCookie', { name: 'docgen_session', value: MEMBER, url: WEB })
    await goto(`${WEB}/teams/${encodeURIComponent(teamId)}`)
    check('สมาชิกเห็นชื่อทีม', await waitFor(`!!document.querySelector('[data-testid="team-name"]')`))
    check('สมาชิกเห็นรายชื่อสมาชิกทั้งทีม', (await evaluate(`document.body.innerText`)).includes(OWNER))
    check('สมาชิก (editor) ไม่เห็นฟอร์มเชิญ', (await evaluate(`!!document.querySelector('[data-testid="team-add-form"]')`)) === false)
    check('สมาชิกไม่เห็นปุ่มลบทีม', (await evaluate(`!!document.querySelector('[data-testid="team-delete"]')`)) === false)
    await shot('04-member-view.png')
  }

  // ── 6. ย้ายแม่แบบเข้าทีมจาก Studio ────────────────────────────
  console.log('\n[6] ย้ายแม่แบบเข้าทีมใน Studio')
  {
    // ข้อ 5 สลับคุกกี้ไปเป็นสมาชิกแล้ว — ต้องกลับเป็นเจ้าของทีมก่อน
    // ไม่งั้นเปิด Studio แล้วเป็นสมาชิก → canManage = false → ไม่เห็นกล่องทีมเลย
    await send('Network.setCookie', { name: 'docgen_session', value: OWNER, url: WEB })

    // สร้างแม่แบบเป็นเจ้าของทีม
    const list = await call('/api/templates', OWNER)
    const donor = (list.body?.items ?? []).find((t) => t.id ?? t.versionId)
    const bytes = new Uint8Array(
      await (
        await fetch(`${API}/api/templates/${encodeURIComponent(String(donor.id ?? donor.versionId))}`, {
          headers: h(OWNER),
        })
      ).arrayBuffer(),
    )
    // อัปโหลดบางครั้งได้ 400 (Content-Length ไม่ตรง) — ลองซ้ำได้
    let cb = null
    for (let i = 0; i < 4; i++) {
      const f = new FormData()
      f.set('versioning', 'true')
      f.set('name', `แม่แบบทีม ${STAMP}`)
      f.set('template', new Blob([bytes], { type: 'application/octet-stream' }), 'ต้นฉบับ.docx')
      const cr = await fetch(`${API}/api/templates`, {
        method: 'POST',
        // ⚠️ ห้ามใช้ h() ตรงนี้ — มันใส่ content-type: application/json มาด้วย
        // แล้ว Fastify พยายาม parse multipart เป็น JSON → 400 Content-Length ไม่ตรง
        headers: { cookie: `docgen_session=${OWNER}` },
        body: f,
      })
      cb = await cr.json().catch(() => null)
      if (cr.ok) break
      await sleep(800)
    }
    const key = String(cb?.id ?? cb?.templateKey ?? '')
    check('อัปโหลดแม่แบบทดสอบได้', !!key, key || JSON.stringify(cb).slice(0, 120))
    if (!key) throw new Error('อัปโหลดแม่แบบไม่สำเร็จ — ทดสอบต่อไม่ได้')

    // เปิดแท็บการแชร์และสิทธิ์
    // ⚠️ ต้องใช้ pane=history (การ์ดแชร์ถูกย้ายไปแท็บนี้แล้ว) และรอ bootveil ก่อน
    await goto(`${WEB}/studio/${encodeURIComponent(key)}?tabs=form&pane=history`)
    await waitFor('!document.querySelector(".bootveil")', 45000)
    check('กล่องทีมโผล่ในแท็บแชร์', await waitFor(`!!document.querySelector('[data-testid="share-team-box"]')`, 30000))
    // รายชื่อทีมโหลดเสร็จช้ากว่ากล่อง → ต้องรอ ไม่ใช่วัดครั้งเดียว
    check(
      'ตัวเลือกทีมถูกเติมจาก /api/teams',
      await waitFor(
        `[...(document.querySelector('[data-testid="share-team-select"]')?.options ?? [])].some((o) => o.textContent.includes(${JSON.stringify(teamName)}))`,
        20000,
      ),
    )

    // เลือกทีม (รอให้ผลจริงปรากฏ ไม่ใช่แค่ onChange)
    await setField('share-team-select', teamId)
    check('เลือกทีมแล้วป้ายชื่อทีมโผล่', await waitFor(`!!document.querySelector('[data-testid="share-team-name"]')`, 20000))
    check(
      'ป้ายตรงกับชื่อทีม',
      (await evaluate(`document.querySelector('[data-testid="share-team-name"]')?.textContent`)) === teamName,
    )

    // ตรงกับฝั่ง API
    const acc = await call(`/api/access/${encodeURIComponent(key)}`, OWNER)
    check('API ยืนยันว่าอยู่ในทีม', acc.body?.team === teamId, `ได้ ${acc.body?.team}`)
    check('API บังคับเป็น private', acc.body?.visibility === 'private', `ได้ ${acc.body?.visibility}`)
    await shot('05-template-team.png')

    // สมาชิกทีมต้องเห็นแม่แบบนี้ได้
    const mView = await call(`/api/access/${encodeURIComponent(key)}`, MEMBER)
    check('สมาชิกทีม (editor) แก้ได้', mView.body?.canEdit === true, `canEdit=${mView.body?.canEdit}`)
    check('สมาชิกทีมเห็นชื่อทีม', mView.body?.teamName === teamName, `ได้ ${mView.body?.teamName}`)

    // ถอนออกจากทีมจากหน้าเว็บ (เลือกค่าว่าง) — สิทธิ์ทีมต้องหายทันที
    await setField('share-team-select', '')
    check('ป้ายชื่อทีมหายหลังถอน', await waitFor(`!document.querySelector('[data-testid="share-team-name"]')`, 20000))
    const out = await call(`/api/access/${encodeURIComponent(key)}`, MEMBER)
    check('สมาชิกทีมถูกตัดสิทธิ์ทันทีหลังถอน', out.body?.canEdit === false, `canEdit=${out.body?.canEdit}`)

    // เก็บกวาด
    await call(`/api/templates/${encodeURIComponent(key)}/purge`, OWNER, { method: 'DELETE' }).catch(() => {})
  }

  // ── 7. ลิงก์เข้าหน้าทีม ───────────────────────────────────────
  console.log('\n[7] ลิงก์เข้าหน้าทีม')
  {
    await goto(`${WEB}/studio`)
    check('Studio มีลิงก์ไป /teams', await waitFor(`!!document.querySelector('[data-testid="rail-teams"]')`, 20000))

    await goto(`${WEB}/account`)
    check('หน้าบัญชีมีลิงก์ไป /teams', await waitFor(`[...document.querySelectorAll('a')].some((a) => a.getAttribute('href') === '/teams')`))
  }

  // ── 8. จอเล็กต้องไม่ล้น ───────────────────────────────────────
  console.log('\n[8] จอเล็ก 390px')
  {
    await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true })
    await goto(`${WEB}/teams/${encodeURIComponent(teamId)}`)
    await waitFor(`!!document.querySelector('[data-testid="team-name"]')`)
    const over = await evaluate(`document.documentElement.scrollWidth - document.documentElement.clientWidth`)
    check('หน้าทีมไม่ล้นแนวนอน', over <= 1, `ล้น ${over}px`)
    await shot('06-mobile.png')
    await send('Emulation.clearDeviceMetricsOverride')
  }
} finally {
  try {
    const d = await db()
    const rows = await d.collection('teams').find({ name: teamName }).toArray()
    const ids = rows.map((t) => String(t._id))
    await d.collection('team_members').deleteMany({ team: { $in: ids } })
    await d.collection('teams').deleteMany({ _id: { $in: ids } })
    await d.collection('template_access').updateMany({ team: { $in: ids } }, { $set: { team: null } })
  } catch {}
  const keys = await redis.keys('session:tui-*')
  if (keys.length) await redis.del(...keys)
  redis.disconnect()
  if (mongo) await mongo.close()
  try { await send('Browser.close') } catch {}
  chrome.kill()
}

console.log(`\n── ผ่าน ${pass} · ไม่ผ่าน ${fail} ─────────────────────`)
process.exit(fail ? 1 : 0)
