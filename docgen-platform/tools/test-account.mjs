/**
 * ทดสอบ `/api/account` — โปรไฟล์ + สถิติ + ค่าตั้งค่า
 *
 *   node --env-file=../dokploy-infra/.env --env-file=../dokploy-infra/.env.development tools/test-account.mjs
 *
 * ทำ session ปลอมใส่ Valkey เอง (แบบเดียวกับ dump-runs.mjs / check-xml.mjs)
 * เพราะล็อกอินผ่าน Casdoor ต้องเปิดเบราว์เซอร์จริง — ไม่คุ้มกับการทดสอบ route
 *
 * ทดสอบแค่ API ยังไม่ตรวจ UI ของหน้า `/account` (อันนั้นต้องใช้ CDP)
 */
import { Redis } from 'ioredis'
import { MongoClient } from 'mongodb'
import { deflateSync } from 'node:zlib'
import { resolveMongoUrl } from '@docgen/shared'

const API = 'http://127.0.0.1:4001'
const STAMP = Date.now()
const SID = `acct-${STAMP}`
const OTHER = `acctother-${STAMP}`

let pass = 0
let fail = 0

function ok(label, cond, extra = '') {
  if (cond) {
    pass++
    console.log(`  ✓ ${label}`)
  } else {
    fail++
    console.log(`  ✗ ${label}${extra ? ` — ${extra}` : ''}`)
  }
}

const redis = new Redis(process.env.VALKEY_URL)
await redis.set(
  `session:${SID}`,
  JSON.stringify({
    sub: SID,
    name: 'ทดสอบ บัญชี',
    email: 'acct@test.local',
    avatar: '',
    affiliation: 'กรมทดสอบ',
  }),
  'EX',
  900,
)
const H = { cookie: `docgen_session=${SID}`, 'content-type': 'application/json' }
const H2 = { cookie: `docgen_session=${OTHER}`, 'content-type': 'application/json' }

let mongo
const db = async () => {
  if (!mongo) {
    mongo = new MongoClient(await resolveMongoUrl(() => {}))
    await mongo.connect()
  }
  return mongo.db(process.env.MONGO_DB ?? 'app')
}

/** เอกสารที่สร้างระหว่างทดสอบ — ต้องล้างทิ้ง */
const created = []

/** สร้าง session ปลอมใน Valkey */
const mkSession = async (sid, user) => {
  await redis.set(
    `session:${sid}`,
    JSON.stringify({ sub: sid, avatar: '', ...user }),
    'EX',
    900,
  )
}

/** ยืมไฟล์จากแม่แบบที่มีอยู่แล้ว (POST /api/templates รับเฉพาะ multipart) */
const mkTemplate = async (sid, name) => {
  const list = await (await fetch(`${API}/api/templates`, { headers: H2 })).json()
  const donor = (list.items ?? []).find((t) => t.id ?? t.versionId)
  if (!donor) throw new Error('ไม่มีแม่แบบเดิมให้ยืมไฟล์')
  const bytes = new Uint8Array(
    await (
      await fetch(`${API}/api/templates/${encodeURIComponent(String(donor.id ?? donor.versionId))}`, {
        headers: H2,
      })
    ).arrayBuffer(),
  )
  const f = new FormData()
  f.set('versioning', 'true')
  f.set('name', name)
  f.set('template', new Blob([bytes], { type: 'application/octet-stream' }), 'ต้นฉบับ.docx')
  /**
   * ⚠️ ห้ามใส่ content-type ตรง ๆ — FormData ต้องให้เบราว์เซอร์เติม boundary เอง
   *   ถ้ากำหนดเอง Fastify จะพยายาม parse เป็น JSON แล้วล้มด้วย
   *   FST_ERR_CTP_INVALID_CONTENT_LENGTH (ขึ้น 500)
   */
  const r = await fetch(`${API}/api/templates`, {
    method: 'POST',
    headers: { cookie: `docgen_session=${OTHER}` },
    body: f,
  })
  const b = await r.json().catch(() => null)
  if (!r.ok) throw new Error(`สร้างแม่แบบไม่สำเร็จ (${r.status}): ${JSON.stringify(b)}`)
  const key = String(b?.id ?? b?.templateKey ?? '')
  if (key) created.push(key)
  return key
}

const putSettings = (sid, patch) =>
  fetch(`${API}/api/account/settings`, {
    method: 'PUT',
    headers: { cookie: `docgen_session=${sid}`, 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  })

const shareCount = async (sid) => {
  const b = await (await fetch(`${API}/api/notifications?kind=share`, {
    headers: { cookie: `docgen_session=${sid}` },
  })).json()
  return b?.items?.length ?? 0
}

// ── สร้าง PNG จริง เพื่อทดสอบการตรวจ magic bytes ────────────────
/**
 * สร้างไฟล์ PNG ที่ถูกต้องจริง ไม่ใช่แค่ไฟล์ที่ตั้งชื่อ .png
 *
 * ⚠️ ต้องเป็นไฟล์ PNG จริง เพราะ API ตรวจจาก**ไบต์จริง** ไม่ใช่นามสกุลหรือ Content-Type
 *   ถ้าใช้ไฟล์ปลอม ทดสอบผ่านทั้งที่ตัวตรวจอาจพัง
 */
const CRC_TABLE = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c
  }
  return t
})()
function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
function makePng(w = 8, h = 8, rgb = [109, 59, 191]) {
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
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // color type: truecolor RGB
  const raw = Buffer.alloc(h * (1 + w * 3))
  for (let y = 0; y < h; y++) {
    const off = y * (1 + w * 3)
    raw[off] = 0 // filter: none
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

/** ส่งไฟล์ขึ้น PUT /api/account/avatar */
const putAvatar = async (sid, bytes, filename = 'a.png', field = 'avatar') => {
  const f = new FormData()
  f.set(field, new Blob([bytes], { type: 'image/png' }), filename)
  // ⚠️ ห้ามใส่ content-type เอง — FormData ต้องให้เบราว์เซอร์เติม boundary
  const r = await fetch(`${API}/api/account/avatar`, {
    method: 'PUT',
    headers: { cookie: `docgen_session=${sid}` },
    body: f,
  })
  return { status: r.status, body: await r.json().catch(() => null) }
}

await mkSession(SID, {
  name: 'ทดสอบ บัญชี',
  email: 'acct@test.local',
  affiliation: 'กรมทดสอบ',
})
await mkSession(OTHER, { name: 'เจ้าของแม่แบบ', email: 'other@test.local' })

try {
  // ── 1. ไม่มี cookie ต้องโดน 401 ──────────────────────────────
  console.log('\n[1] ไม่มี session')
  {
    const res = await fetch(`${API}/api/account`)
    ok('โดน 401', res.status === 401, `ได้ ${res.status}`)
  }

  // ── 2. ค่าเริ่มต้น ยังไม่เคยบันทึก ────────────────────────────
  console.log('\n[2] ค่าตั้งค่าตอนยังไม่เคยบันทึก')
  {
    const res = await fetch(`${API}/api/account/settings`, { headers: H })
    const b = await res.json()
    ok('ตอบ 200', res.status === 200, `ได้ ${res.status}`)
    ok('เปิดการแจ้งเตือนการแชร์ไว้เป็นค่าเริ่มต้น', b.settings?.notifyOnShare === true)
    ok('เปิดการแจ้งเตือนงานเอกสารไว้เป็นค่าเริ่มต้น', b.settings?.notifyOnDocument === true)
    ok('updatedAt = null (ยังไม่เคยแตะ)', b.updatedAt === null, `ได้ ${b.updatedAt}`)
  }

  // ── 3. ข้อมูลบัญชี ───────────────────────────────────────────
  console.log('\n[3] GET /api/account')
  let first
  {
    const res = await fetch(`${API}/api/account`, { headers: H })
    first = await res.json()
    ok('ตอบ 200', res.status === 200, `ได้ ${res.status}`)
    ok('sub ตรงกับ session', first.profile?.sub === SID, `ได้ ${first.profile?.sub}`)
    ok('name ตรงกับ session', first.profile?.name === 'ทดสอบ บัญชี')
    ok('email ตรงกับ session', first.profile?.email === 'acct@test.local')
    ok('affiliation อ่านมาได้', first.profile?.affiliation === 'กรมทดสอบ')
    ok('avatar ว่างไม่ใช่ undefined', first.profile?.avatar === '')

    // ผู้ใช้ใหม่ต้องได้ 0 ทุกตัว และเป็นเลข ไม่ใช่ null
    const s = first.stats ?? {}
    const keys = ['bookmarks', 'chats', 'documents', 'ownedTemplates', 'unreadNotifications']
    ok('สถิติครบทุกช่อง', keys.every((k) => typeof s[k] === 'number'), JSON.stringify(s))
    ok('สถิติเป็น 0 หมด (ผู้ใช้ใหม่)', keys.every((k) => s[k] === 0), JSON.stringify(s))
  }

  // ── 4. แก้ค่าเดียว ต้องไม่ลบอีกค่า ─────────────────────────────
  console.log('\n[4] PUT แก้ทีละช่อง')
  {
    const res = await fetch(`${API}/api/account/settings`, {
      method: 'PUT',
      headers: H,
      body: JSON.stringify({ notifyOnShare: false }),
    })
    const b = await res.json()
    ok('ตอบ 200', res.status === 200, `ได้ ${res.status}`)
    ok('ปิดการแจ้งเตือนการแชร์ได้', b.settings?.notifyOnShare === false)
    ok('อีกค่าไม่หายไป (merge ไม่ใช่ replace)', b.settings?.notifyOnDocument === true)
    ok('มี updatedAt แล้ว', typeof b.updatedAt === 'string' && b.updatedAt.length > 0)
  }

  // ── 5. อ่านกลับมา = ค่าที่บันทึกไว้ ───────────────────────────
  console.log('\n[5] อ่านกลับหลังบันทึก')
  {
    const res = await fetch(`${API}/api/account`, { headers: H })
    const b = await res.json()
    ok('ค่าที่บันทึกไว้ยังอยู่', b.settings?.notifyOnShare === false)
    ok('settingsUpdatedAt ไม่เป็น null', b.settingsUpdatedAt !== null)
  }

  // ── 6. body ไม่ผ่าน validation ต้องโดน 422 ────────────────────
  console.log('\n[6] body ผิด')
  {
    const res = await fetch(`${API}/api/account/settings`, {
      method: 'PUT',
      headers: H,
      body: JSON.stringify({ notifyOnShare: 'ใช่' }),
    })
    const b = await res.json()
    ok('โดน 422', res.status === 422, `ได้ ${res.status}`)
    ok('บอกว่า VALIDATION_FAILED', b.code === 'VALIDATION_FAILED', `ได้ ${b.code}`)
  }

  // ── 7. เปิดกลับ แล้วค่าเริ่มต้นต้องไม่ถูกทับตอนอ่าน ───────────
  console.log('\n[7] เปิดกลับ')
  {
    await fetch(`${API}/api/account/settings`, {
      method: 'PUT',
      headers: H,
      body: JSON.stringify({ notifyOnShare: true, notifyOnDocument: false }),
    })
    const b = await (await fetch(`${API}/api/account`, { headers: H })).json()
    ok('เปิดการแจ้งเตือนการแชร์กลับได้', b.settings?.notifyOnShare === true)
    ok('ปิดการแจ้งเตือนงานเอกสารได้', b.settings?.notifyOnDocument === false)
  }
  // ── 8. ค่าตั้งค่าต้อง**มีผลจริง** ไม่ใช่แค่บันทึกแล้วลืม ─────────
  console.log('\n[8] ค่าตั้งค่ามีผลกับกล่องจดหมายจริงหรือยัง')
  {
    const tpl = await mkTemplate(OTHER, `ทดสอบค่าตั้งค่า ${STAMP}`)
    ok('สร้างแม่แบบสำหรับทดสอบได้', !!tpl, tpl)

    // 8a — ปิดไว้ = ต้องไม่มีจดหมาย
    await putSettings(SID, { notifyOnShare: false })
    const base = await shareCount(SID)
    await fetch(`${API}/api/access/${encodeURIComponent(tpl)}/share`, {
      method: 'POST',
      headers: H2,
      body: JSON.stringify({ sub: SID, name: 'ผู้รับแชร์', role: 'editor' }),
    })
    const muted = await shareCount(SID)
    ok('ปิดแล้วไม่ส่งจดหมายประเภท share', muted === base, `${base} → ${muted}`)

    // 8b — เปิดแล้วต้องมีจดหมาย
    //      ต้องใช้**แม่แบบอีกอัน** เพราะการแชร์คนเดิมซ้ำจะไปเข้าเส้นทาง "สิทธิ์เปลี่ยน"
    //      ซึ่งยิงเป็นประเภท `access` ไม่ใช่ `share` (`service.ts` ช่วง addShare)
    await putSettings(SID, { notifyOnShare: true })
    const tpl2 = await mkTemplate(OTHER, `ทดสอบค่าตั้งค่า B ${STAMP}`)
    await fetch(`${API}/api/access/${encodeURIComponent(tpl2)}/share`, {
      method: 'POST',
      headers: H2,
      body: JSON.stringify({ sub: SID, name: 'ผู้รับแชร์', role: 'editor' }),
    })
    const on = await shareCount(SID)
    ok('เปิดแล้วส่งจดหมายประเภท share', on > muted, `${muted} → ${on}`)

    // 8c — ประเภท access ปิดไม่ได้ (ผู้ใช้ต้องรู้ว่าสิทธิ์เปลี่ยน)
    //      ต้อง**เปลี่ยนสิทธิ์** ไม่ใช่ส่งค่าเดิมซ้ำ — ระบบแจ้งเฉพาะตอนค่าเปลี่ยน
    //      (`service.ts`: `prior.role !== input.role`)
    await putSettings(SID, { notifyOnShare: false })
    await fetch(`${API}/api/access/${encodeURIComponent(tpl)}/share`, {
      method: 'POST',
      headers: H2,
      body: JSON.stringify({ sub: SID, name: 'ผู้รับแชร์', role: 'viewer' }),
    })
    const acc = await (await fetch(`${API}/api/notifications?kind=access`, {
      headers: { cookie: `docgen_session=${SID}` },
    })).json()
    ok(
      'ประเภท access ยังส่งแม้ปิดการแจ้งเตือน',
      (acc?.items?.length ?? 0) > 0,
      `ได้ ${acc?.items?.length ?? 0} ฉบับ`,
    )
  }

  // ── 9. รูปโปรไฟล์ ────────────────────────────────────────────
  console.log('\n[9] เปลี่ยนรูปโปรไฟล์')
  {
    const png = makePng()
    ok('สร้าง PNG จริงได้', png[0] === 0x89 && png[1] === 0x50, `${png.length} ไบต์`)

    // 9a — ยังไม่มีรูป ต้องได้ 404
    {
      const r = await fetch(`${API}/api/account/avatar`, {
        headers: { cookie: `docgen_session=${SID}` },
      })
      ok('ยังไม่มีรูป → 404', r.status === 404, `ได้ ${r.status}`)
      const acc = await (await fetch(`${API}/api/account`, { headers: H })).json()
      ok('hasCustomAvatar = false', acc.profile?.hasCustomAvatar === false)
    }

    // 9b — อัปโหลด PNG จริง
    {
      const { status, body } = await putAvatar(SID, png)
      ok('อัปโหลด PNG ได้', status === 200, `ได้ ${status} ${JSON.stringify(body)}`)
      ok('ตอบว่ามีรูปแล้ว', body?.hasCustomAvatar === true)

      const r = await fetch(`${API}/api/account/avatar`, { headers: { cookie: `docgen_session=${SID}` } })
      ok('ดึงรูปกลับได้', r.status === 200, `ได้ ${r.status}`)
      ok('content-type เป็น image/png', r.headers.get('content-type') === 'image/png', r.headers.get('content-type'))
      ok('ไม่ให้ cache (เปลี่ยนรูปแล้วต้องเห็นใหม่)', (r.headers.get('cache-control') ?? '').includes('no-store'))

      const got = Buffer.from(await r.arrayBuffer())
      ok('ไบต์ตรงกับที่อัปโหลด', got.equals(png), `${got.length} vs ${png.length}`)

      const acc = await (await fetch(`${API}/api/account`, { headers: H })).json()
      ok('GET /api/account บอกว่ามีรูปแล้ว', acc.profile?.hasCustomAvatar === true)
    }

    // 9c — ความปลอดภัย: ส่ง HTML มาแต่หลอกว่าเป็นรูป
    {
      const html = Buffer.from('<html><script>alert(1)</script></html>', 'utf8')
      const { status, body } = await putAvatar(SID, html, 'evil.png')
      ok('HTML ที่หลอกนามสกุล .png ถูกปฏิเสธ', status === 400, `ได้ ${status} ${JSON.stringify(body)}`)

      // รูปเดิมต้องยังอยู่ — ของที่บันทึกไว้ไม่ถูกทับด้วยของแย่
      const r = await fetch(`${API}/api/account/avatar`, { headers: { cookie: `docgen_session=${SID}` } })
      const got = Buffer.from(await r.arrayBuffer())
      ok('รูปเดิมไม่หายจากการอัปโหลดของแย่', got.equals(png))
    }

    // 9d — ใหญ่เกิน 2 MB
    {
      const big = Buffer.concat([png, Buffer.alloc(3 * 1024 * 1024)])
      const { status } = await putAvatar(SID, big, 'big.png')
      ok('ไฟล์ใหญ่เกิน 2 MB ถูกปฏิเสธ', status === 400, `ได้ ${status}`)
    }

    // 9e — ชื่อ field ผิด
    {
      const { status } = await putAvatar(SID, png, 'a.png', 'notavatar')
      ok('ส่งผิดชื่อ field ถูกปฏิเสธ', status === 400, `ได้ ${status}`)
    }

    // 9f — คนอื่นอ่านรูปของเราไม่ได้ (แต่ละคนมีรูปของตัวเองเท่านั้น)
    {
      const r = await fetch(`${API}/api/account/avatar`, {
        headers: { cookie: `docgen_session=${OTHER}` },
      })
      ok('อีกคนไม่เห็นรูปของเรา', r.status === 404, `ได้ ${r.status}`)
    }

    // 9g — ลบแล้วกลับไปใช้รูปจาก Casdoor
    {
      /**
       * ⚠️ ห้ามใส่ content-type ตอน DELETE ที่ไม่มี body
       *   Fastify ตอบ 500 ทันทีว่า "Body cannot be empty when content-type is set to
       *   'application/json'" → ตัวช่วย `call()` ของหน้าเว็บถอดให้เองอยู่แล้ว
       */
      const r = await fetch(`${API}/api/account/avatar`, {
        method: 'DELETE',
        headers: { cookie: `docgen_session=${SID}` },
      })
      const b = await r.json().catch(() => null)
      ok('ลบรูปได้', r.status === 200, `ได้ ${r.status} ${JSON.stringify(b)}`)
      ok('ตอบว่าไม่มีรูปแล้ว', b?.hasCustomAvatar === false, JSON.stringify(b))

      const again = await fetch(`${API}/api/account/avatar`, { headers: { cookie: `docgen_session=${SID}` } })
      ok('ดึงรูปไม่ได้หลังลบ', again.status === 404, `ได้ ${again.status}`)

      const acc = await (await fetch(`${API}/api/account`, { headers: H })).json()
      ok('hasCustomAvatar กลับเป็น false', acc.profile?.hasCustomAvatar === false)
    }
  }
} finally {
  // ── เก็บกวาด ───────────────────────────────────────────────
  for (const k of created) {
    await fetch(`${API}/api/templates/${encodeURIComponent(k)}/purge`, {
      method: 'DELETE',
      headers: H2,
    }).catch(() => {})
  }
  try {
    const d = await db()
    await d.collection('user_settings').deleteMany({ _id: { $in: [SID, OTHER] } })
    await d.collection('notifications').deleteMany({ user: { $in: [SID, OTHER] } })
    await d.collection('template_access').deleteMany({ _id: { $in: created } })
    await d.collection('template_tombstones').deleteMany({ _id: { $in: created } })
  } catch {}
  const keys = await redis.keys('session:acct-*')
  if (keys.length) await redis.del(...keys)
  redis.disconnect()
  if (mongo) await mongo.close()
}

console.log(`\n── ผ่าน ${pass} · ไม่ผ่าน ${fail} ─────────────────────`)
process.exit(fail ? 1 : 0)
