/**
 * ทดสอบฟีเจอร์ Studio ชุดใหม่: ฟอร์มที่ออกแบบเอง · การแชร์ · แชท AI · บุ๊กมาร์ก · ประวัติ
 *
 *   node --env-file=.env tools/test-studio-v2.mjs
 *
 * ใช้ LLM_PROVIDER=mock ที่ตั้งไว้เป็นค่าเริ่มต้น
 * → ทดสอบ pipeline ทั้งเส้น (merge / ประวัติ / session) โดยไม่ต้องมี API key
 *   ถ้าตั้ง key แล้ว สคริปต์นี้ยังผ่าน เพราะไม่ได้ยืนยันคำตอบของโมเดล
 */
import { Redis } from 'ioredis'

const API = 'http://127.0.0.1:4001'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let pass = 0
let fail = 0
const failures = []

function check(name, ok, detail = '') {
  if (ok) {
    pass++
    console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ''}`)
  } else {
    fail++
    failures.push(name)
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

const redis = new Redis(process.env.VALKEY_URL)

/** ผู้ใช้สองคน — ใช้ทดสอบสิทธิ์แชร์ */
async function makeUser(tag) {
  const sub = `${tag}-${Date.now()}-${Math.floor(Math.random() * 1000)}`
  await redis.set(
    `session:${sub}`,
    JSON.stringify({ sub, name: `ผู้ใช้ ${tag}`, email: `${sub}@test.local`, avatar: '' }),
    'EX',
    900,
  )
  return { sub, headers: { cookie: `docgen_session=${sub}`, 'content-type': 'application/json' } }
}

const call = async (path, { headers, ...init } = {}) => {
  /**
   * ⚠️ อย่าส่ง content-type เมื่อไม่มี body
   *    Fastify ตอบ 500 ทันทีว่า
   *    "Body cannot be empty when content-type is set to 'application/json'"
   *    (DELETE ทุกตัวในสคริปต์นี้ไม่มี body)
   */
  const hasBody = init.body !== undefined
  const finalHeaders = hasBody ? headers : { cookie: headers?.cookie }
  const res = await fetch(`${API}/api${path}`, { headers: finalHeaders, ...init })
  const text = await res.text()
  let body = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = { raw: text }
  }
  return { status: res.status, body }
}

// ── เตรียมแม่แบบจริงหนึ่งตัว ─────────────────────────────────
console.log('\n[0] เตรียมข้อมูล')
const alice = await makeUser('alice')
const bob = await makeUser('bob')

/**
 * เลือกแม่แบบที่ alice "คุ้มสิทธิ์เจ้าของ" ได้
 *
 * ⚠️ ต้องทำแบบนี้เพราะผู้ใช้ของแต่ละรอบคนละคน (sub สุ่มใหม่)
 *    ถ้าแม่แบบไหนมีเจ้าของ/ผู้ถูกแชร์จากรอบก่อน alice จะแก้ฟอร์มไม่ได้ (403)
 *    → สคริปต์ต้องเลือกแม่แบบที่ยังไม่มีใครตั้งค่าไว้
 */
let tpl = null
let key = null
{
  const list = await call('/templates', { headers: alice.headers })
  if (list.status !== 200 || !list.body?.items?.length) {
    console.log(`✗ ดึงรายการแม่แบบไม่ได้ (${list.status}) — จบการทดสอบ`)
    redis.disconnect()
    process.exit(1)
  }
  for (const cand of list.body.items) {
    const claim = await call(`/access/${cand.id}`, {
      headers: alice.headers,
      method: 'PUT',
      body: JSON.stringify({ visibility: 'published' }),
    })
    if (claim.status === 200 && claim.body?.owner === alice.sub) {
      tpl = cand
      key = String(cand.id)
      break
    }
  }
  if (!tpl) {
    console.log('✗ ไม่มีแม่แบบที่ alice จะสามารถทดสอบได้ (ทุกตัวมีเจ้าของอยู่แล้ว)')
    redis.disconnect()
    process.exit(1)
  }
  console.log(`  ใช้แม่แบบ "${tpl.name}" key=${key}`)
}

/** ล้าง state ที่รอบก่อนทิ้ง — ทำให้สคริปต์รันซ้ำได้โดยไม่ต้องคนละแม่แบบ */
async function resetState(headers) {
  await call(`/form/${key}`, { headers, method: 'DELETE' })
  await call(`/access/${key}`, { headers, method: 'DELETE' })
  // คุ้มสิทธิ์เจ้าของคืนมา เผื่อขั้นตอนถัดไปต้องแก้ได้
  await call(`/access/${key}`, {
    headers,
    method: 'PUT',
    body: JSON.stringify({ visibility: 'published' }),
  })
}
await resetState(alice.headers)

// ── 1. สถานะ LLM ───────────────────────────────────────────
console.log('\n[1] สถานะผู้ช่วย AI')
{
  const r = await call('/llm/status', { headers: alice.headers })
  check('ตอบ 200', r.status === 200)
  check('มี provider/model', Boolean(r.body?.provider && r.body?.model), `${r.body?.provider}/${r.body?.model}`)
  check(
    'configured = true (โหมด mock ใช้ได้เสมอ)',
    r.body?.configured === true,
    r.body?.reason ?? '',
  )
}

// ── 2. ฟอร์ม: นำเข้าจากแท็ก ─────────────────────────────────
console.log('\n[2] สร้างฟิลด์อัตโนมัติจากแท็กของแม่แบบ')
let fields = []
{
  const r = await call(`/form/${key}/import-tags`, {
    headers: alice.headers,
    method: 'POST',
    body: JSON.stringify({ versionId: tpl.versionId }),
  })
  check('ตอบ 200', r.status === 200, JSON.stringify(r.body).slice(0, 120))
  fields = r.body?.fields ?? []
  check('ได้ฟิลด์กลับมา', fields.length > 0, `${fields.length} ฟิลด์`)
  check('ทุกฟิลด์มี key', fields.every((f) => Boolean(f.key)))

  // เรียกซ้ำต้องไม่เพิ่มซ้ำ
  const again = await call(`/form/${key}/import-tags`, {
    headers: alice.headers,
    method: 'POST',
    body: JSON.stringify({ versionId: tpl.versionId }),
  })
  check('เรียกซ้ำแล้วไม่เพิ่มซ้ำ', again.body?.fields?.length === fields.length, `${again.body?.fields?.length}`)
}

// ── 3. ฟอร์ม: ตั้งค่าเอง (ชนิด/กฎ/กลุ่ม/ลำดับ) ────────────────
console.log('\n[3] บันทึกฟอร์มที่ผู้ใช้ออกแบบเอง')
{
  const first = fields[0]?.key ?? 'x'
  const body = {
    fields: [
      {
        key: first,
        label: 'ชื่อผู้รับ',
        type: 'text',
        group: 'ผู้รับ',
        order: 0,
        required: true,
        rules: { minLength: 2, maxLength: 60 },
        ai: { enabled: true, hint: 'ชื่อ-นามสกุล เต็ม' },
      },
      {
        key: 'เลขที่',
        label: 'เลขที่หนังสือ',
        type: 'integer',
        group: 'ผู้รับ',
        order: 1,
        required: true,
        rules: { min: 1, max: 99999 },
        ai: { enabled: true },
      },
      {
        key: 'ประเภท',
        label: 'ประเภทเรื่อง',
        type: 'select',
        group: 'เนื้อหา',
        order: 0,
        required: true,
        options: [
          { value: 'ขออนุญาต', label: 'ขออนุญาต' },
          { value: 'รายงาน', label: 'รายงาน' },
        ],
        ai: { enabled: true },
      },
      {
        key: 'ผู้รับ.ชื่อ',
        label: 'ชื่อในกลุ่ม (path แบบ nested)',
        type: 'text',
        group: 'กลุ่มย่อย',
        order: 0,
        required: false,
        rules: { pattern: '^[ก-ฮ\\s]+$', patternMessage: 'ใส่เป็นภาษาไทยเท่านั้น' },
        ai: { enabled: false },
      },
    ],
  }

  const r = await call(`/form/${key}`, {
    headers: alice.headers,
    method: 'PUT',
    body: JSON.stringify(body),
  })
  check('บันทึกได้', r.status === 200, JSON.stringify(r.body).slice(0, 120))
  check('คืนฟิลด์ครบ', r.body?.fields?.length === 4, `${r.body?.fields?.length}`)

  // key ซ้ำต้องโดนปฏิเสธ ไม่ใช่ทับกันเงียบ
  const dup = await call(`/form/${key}`, {
    headers: alice.headers,
    method: 'PUT',
    body: JSON.stringify({ fields: [{ key: 'a' }, { key: 'a' }] }),
  })
  check('key ซ้ำถูกปฏิเสธ', dup.status === 422, `HTTP ${dup.status}`)

  // อ่านกลับ
  const read = await call(`/form/${key}`, { headers: bob.headers })
  check('คนอื่นอ่านฟอร์มได้', read.status === 200 && read.body?.fields?.length === 4)
  check(
    'กติกา regex ถูกเก็บไว้',
    read.body?.fields?.find((f) => f.key === 'ผู้รับ.ชื่อ')?.rules?.pattern === '^[ก-ฮ\\s]+$',
  )
}

// ── 4. การแชร์และสิทธิ์ ──────────────────────────────────────
console.log('\n[4] publish / private / แชร์รายคน')
{
  // alice คุ้มสิทธิ์เจ้าของไว้แล้วในขั้นตอนเตรียมข้อมูล (คนแรกที่ตั้งค่า = เจ้าของ)
  const mine = await call(`/access/${key}`, { headers: alice.headers })
  check('คนแรกที่ตั้งค่า = เจ้าของ', mine.body?.owner === alice.sub, String(mine.body?.owner))
  check('เจ้าของแก้ได้', mine.body?.canEdit === true && mine.body?.relation === 'owner')

  // ── ตั้งเป็น private ──
  const priv = await call(`/access/${key}`, {
    headers: alice.headers,
    method: 'PUT',
    body: JSON.stringify({ visibility: 'private' }),
  })
  check('ตั้งเป็น private ได้', priv.body?.visibility === 'private')

  // ── คนที่ไม่ได้ถูกแชร์ → แก้ไม่ได้ ──
  const bobView = await call(`/access/${key}`, { headers: bob.headers })
  check('คนนอกมองเห็นเจ้าของถูกต้อง', bobView.body?.owner === alice.sub)
  check('คนนอกแก้ไม่ได้', bobView.body?.canEdit === false)

  const denied = await call(`/form/${key}`, {
    headers: bob.headers,
    method: 'PUT',
    body: JSON.stringify({ fields: [] }),
  })
  check('คนนอกบันทึกฟอร์มถูกปฏิเสธ 403', denied.status === 403, `HTTP ${denied.status}`)

  const deniedShare = await call(`/access/${key}/share`, {
    headers: bob.headers,
    method: 'POST',
    body: JSON.stringify({ sub: 'someone', role: 'viewer' }),
  })
  check('คนนอกเพิ่มผู้ใช้เองไม่ได้', deniedShare.status === 403, `HTTP ${deniedShare.status}`)

  // ── เจ้าของแชร์ให้ bob เป็น viewer ก่อน ──
  const shareViewer = await call(`/access/${key}/share`, {
    headers: alice.headers,
    method: 'POST',
    body: JSON.stringify({ sub: bob.sub, name: 'ผู้ใช้ bob', role: 'viewer' }),
  })
  check('เพิ่มคนเข้าใช้ได้', shareViewer.body?.sharedWith?.length === 1)

  const asViewer = await call(`/access/${key}`, { headers: bob.headers })
  check('ถูกแชร์แล้ว relation = shared', asViewer.body?.relation === 'shared')
  check('role viewer = ดูอย่างเดียว', asViewer.body?.canEdit === false)

  // ── อัปเกรดเป็น editor ──
  const shareEditor = await call(`/access/${key}/share`, {
    headers: alice.headers,
    method: 'POST',
    body: JSON.stringify({ sub: bob.sub, name: 'ผู้ใช้ bob', role: 'editor' }),
  })
  check('อัปเกรดเป็น editor ได้', shareEditor.body?.sharedWith?.[0]?.role === 'editor')

  const asEditor = await call(`/access/${key}`, { headers: bob.headers })
  check('editor แก้ได้', asEditor.body?.canEdit === true)
  const editOk = await call(`/form/${key}`, {
    headers: bob.headers,
    method: 'PUT',
    body: JSON.stringify({ fields: [] }),
  })
  check('editor บันทึกฟอร์มได้', editOk.status === 200, `HTTP ${editOk.status}`)

  // คืนฟอร์มให้มีช่องเหมือนเดิม เผื่อขั้นตอนถัดไปใช้
  await call(`/form/${key}/import-tags`, {
    headers: alice.headers,
    method: 'POST',
    body: JSON.stringify({ versionId: tpl.versionId }),
  })

  // ── ถอนสิทธิ์ ──
  const revoked = await call(`/access/${key}/share/${bob.sub}`, {
    headers: alice.headers,
    method: 'DELETE',
  })
  check('ถอนสิทธิ์ได้', revoked.body?.sharedWith?.length === 0)
  const afterRevoke = await call(`/access/${key}`, { headers: bob.headers })
  check('หลังถอนแล้วแก้ไม่ได้', afterRevoke.body?.canEdit === false)

  // ── ล้างการแชร์ทั้งหมด → กลับเป็นเปิดสาธารณ ──
  const cleared = await call(`/access/${key}`, { headers: alice.headers, method: 'DELETE' })
  check('ล้างการแชร์ได้', cleared.status === 204, `HTTP ${cleared.status}`)
  const backToDefault = await call(`/access/${key}`, { headers: bob.headers })
  check('ล้างแล้วทุกคนแก้ได้อีกครั้ง', backToDefault.body?.visibility === 'published' && backToDefault.body?.canEdit === true)

  // ── resolve หลายแม่แบบ ──
  const resolve = await call('/access/resolve', {
    headers: alice.headers,
    method: 'POST',
    body: JSON.stringify({ keys: [key, '999999999'] }),
  })
  check('resolve ได้ทุก key', Object.keys(resolve.body ?? {}).length === 2)
  check('key ที่ไม่มีข้อมูล = published', resolve.body?.['999999999']?.visibility === 'published')
}

// ── 5. แชทกับ AI ────────────────────────────────────────────
console.log('\n[5] แชทให้ AI ช่วยกรอกข้อมูล')
{
  const r = await call('/chat', {
    headers: alice.headers,
    method: 'POST',
    body: JSON.stringify({
      templateKey: key,
      message: 'ออกหนังสือรับรองให้นายสมชาย แซ่ม ชมพู เรื่องขออนุญาตเปลี่ยนประจำรถ',
      data: { 'เลขที่': 12 },
      templateName: tpl.name,
    }),
  })
  check('ตอบ 200', r.status === 200, JSON.stringify(r.body).slice(0, 160))
  check('ได้ sessionId', Boolean(r.body?.sessionId))
  check('ได้ข้อความตอบ', Boolean(r.body?.reply))
  check('ได้ data กลับมา', r.body?.data && Object.keys(r.body.data).length > 0)
  check(
    'ค่าที่ผู้ใช้กรอกเองไม่ถูกทับ',
    r.body?.data?.['เลขที่'] === 12,
    `ได้ ${JSON.stringify(r.body?.data?.['เลขที่'])}`,
  )
  check('รายงานว่าเปลี่ยนอะไรบ้าง', Array.isArray(r.body?.changed))

  // คุยต่อใน session เดิม
  const r2 = await call('/chat', {
    headers: alice.headers,
    method: 'POST',
    body: JSON.stringify({
      templateKey: key,
      sessionId: r.body.sessionId,
      message: 'เปลี่ยนชื่อผู้รับเป็นนายสมชาย ใจดี',
      data: r.body.data,
    }),
  })
  check('คุยต่อได้ใน session เดิม', r2.body?.sessionId === r.body.sessionId)

  const s = await call(`/chat/sessions/${r.body.sessionId}`, { headers: alice.headers })
  check('เก็บประวัติแชทไว้', (s.body?.messages?.length ?? 0) === 4, `${s.body?.messages?.length} ข้อความ`)
  check('ข้อความมี role ครบ', s.body?.messages?.[0]?.role === 'user' && s.body?.messages?.[1]?.role === 'assistant')

  // คนอื่นอ่านแชทไม่ได้
  const other = await call(`/chat/sessions/${r.body.sessionId}`, { headers: bob.headers })
  check('แชทเป็นของผู้ถามจริง ๆ (คนอื่นอ่านไม่ได้)', other.status === 404, `HTTP ${other.status}`)

  const listS = await call('/chat/sessions', { headers: alice.headers })
  check('มีรายการแชท', (listS.body?.items?.length ?? 0) >= 1)

  // ลบแชท
  const del = await call(`/chat/sessions/${r.body.sessionId}`, { headers: alice.headers, method: 'DELETE' })
  check('ลบแชทได้', del.status === 204, `HTTP ${del.status}`)
  const gone = await call(`/chat/sessions/${r.body.sessionId}`, { headers: alice.headers })
  check('ลบแล้วหาไม่เจอ', gone.status === 404)
}

// ── 6. บุ๊กมาร์ก ────────────────────────────────────────────
console.log('\n[6] บุ๊กมาร์ก')
{
  const add = await call('/bookmarks', {
    headers: alice.headers,
    method: 'POST',
    body: JSON.stringify({ templateKey: key, versionId: tpl.versionId, templateName: tpl.name, note: 'ใช้บ่อย' }),
  })
  check('เพิ่มได้', add.status === 200 && Boolean(add.body?._id))

  const list = await call('/bookmarks', { headers: alice.headers })
  check('มีในรายการ', (list.body?.items?.length ?? 0) === 1)
  check('เก็บชื่อแม่แบบไว้แสดง', list.body?.items?.[0]?.templateName === tpl.name)

  // เพิ่มซ้ำต้องไม่เพิ่มแถวใหม่
  await call('/bookmarks', {
    headers: alice.headers,
    method: 'POST',
    body: JSON.stringify({ templateKey: key, versionId: tpl.versionId, templateName: tpl.name }),
  })
  const list2 = await call('/bookmarks', { headers: alice.headers })
  check('เพิ่มซ้ำไม่เพิ่มซ้ำ', (list2.body?.items?.length ?? 0) === 1)

  // ของคนอื่นมองไม่เห็น
  const otherList = await call('/bookmarks', { headers: bob.headers })
  check('บุ๊กมาร์กเป็นของผู้ใช้คนนั้น', (otherList.body?.items?.length ?? 0) === 0)

  const del = await call(`/bookmarks/${key}`, { headers: alice.headers, method: 'DELETE' })
  check('ลบได้', del.status === 204, `HTTP ${del.status}`)
  const empty = await call('/bookmarks', { headers: alice.headers })
  check('ลบแล้วว่าง', (empty.body?.items?.length ?? 0) === 0)
}

// ── 7. ประวัติการสร้างเอกสารของแม่แบบ ────────────────────────
console.log('\n[7] ประวัติ — ใครใช้แม่แบบนี้บ้าง')
{
  // สร้างเอกสารจริง 1 ชิ้นเพื่อให้มีประวัติ
  const created = await call('/documents', {
    headers: alice.headers,
    method: 'POST',
    body: JSON.stringify({
      templateId: tpl.versionId,
      data: { [fields[0]?.key ?? 'ชื่อ']: 'ทดสอบประวัติการใช้งาน' },
      outputFormat: 'pdf',
      label: 'studio-v2-history-test',
    }),
  })
  check('สร้างเอกสารได้', created.status === 201 || created.status === 200, `HTTP ${created.status}`)

  const hist = await call(`/history/${key}`, { headers: alice.headers })
  check('ตอบ 200', hist.status === 200, JSON.stringify(hist.body).slice(0, 120))
  check('มีสรุปรายคน', (hist.body?.users?.length ?? 0) > 0, `${hist.body?.users?.length} คน`)
  check(
    'นับชื่อผู้สร้างได้',
    hist.body?.users?.some((u) => u.sub === alice.sub && u.name === 'ผู้ใช้ alice'),
    JSON.stringify(hist.body?.users?.[0] ?? {}),
  )
  check('รายการล่าสุดมี label', hist.body?.items?.[0]?.label === 'studio-v2-history-test')

  // คนอื่นเห็นประวัติได้ (มันคือข้อมูลของแม่แบบ ไม่ใช่ข้อมูลส่วนตัวของเอกสาร)
  const asOther = await call(`/history/${key}`, { headers: bob.headers })
  check('คนอื่นดูประวัติได้', asOther.status === 200)

  // เก็บกวาด
  if (created.body?._id) {
    for (let i = 0; i < 30; i++) {
      const d = await call(`/documents/${created.body._id}`, { headers: alice.headers })
      if (d.body?.status === 'done' || d.body?.status === 'failed') break
      await sleep(1000)
    }
    await call(`/documents/${created.body._id}`, { headers: alice.headers, method: 'DELETE' })
  }
}

// ── เก็บกวาด ────────────────────────────────────────────────
// คืนสภาพเดิม ไม่ให้ผลของสคริปต์ไปรบกวนการใช้งานจริง
await call(`/form/${key}`, { headers: alice.headers, method: 'DELETE' })
await call(`/access/${key}`, { headers: alice.headers, method: 'DELETE' })
await redis.del(`session:${alice.sub}`)
await redis.del(`session:${bob.sub}`)
redis.disconnect()

console.log(`\n──── สรุป: ผ่าน ${pass} · ไม่ผ่าน ${fail} ────`)
if (failures.length) for (const f of failures) console.log(`  ✗ ${f}`)
process.exit(fail === 0 ? 0 : 1)
