/**
 * ดูสถานะทุก service เป็นตารางในเทอร์มินัล
 *
 *   node --env-file=.env tools/health.mjs
 *
 * ไม่ต้อง login — `/api/health` เปิดสาธารณอยู่แล้ว
 * ข้อมูลเดียวกับที่เห็นใน Swagger UI ที่ /docs
 */
const API = process.env.PUBLIC_API_URL ?? 'http://127.0.0.1:4001'

const ICON = { up: '●', degraded: '◐', down: '○' }

// สี ANSI ได้เฉพาะเทอร์มินัลจริง — ตอน pipe ลงไฟล์หรือ CI จะเห็นรหัสยถัยถ้าไม่กัน
const TTY = process.stdout.isTTY && process.env.NO_COLOR === undefined
const COLOR = TTY
  ? { up: '\x1b[32m', degraded: '\x1b[33m', down: '\x1b[31m' }
  : { up: '', degraded: '', down: '' }
const RESET = TTY ? '\x1b[0m' : ''

const res = await fetch(`${API}/api/health`, { headers: { accept: 'application/json' } })
const body = await res.json()

const rows = [body.api, ...body.checks]

// ความกว้างคอลัมน์ — คำนวณจากข้อมูลจริงกันหน้าจอล้น
const w = (key) => Math.max(...rows.map((r) => (r[key] ?? '').toString().length), key.length)

const cols = {
  label: w('label'),
  container: w('container'),
  id: w('id'),
}

const line = (l) =>
  console.log(
    `${COLOR[l.status]}${ICON[l.status]} ${l.status.padEnd(9)}${RESET}` +
      `${l.label.padEnd(cols.label + 2)}` +
      `${(l.container ?? '—').padEnd(cols.container + 2)}` +
      `${String(l.latencyMs === null ? 'timeout' : `${l.latencyMs}ms`).padEnd(9)}` +
      `${l.detail}`,
  )

console.log()
console.log(`  2docx · health   HTTP ${res.status} · ${body.status} · probe ${body.tookMs}ms`)
console.log(`  ${'─'.repeat(104)}`)
console.log(
  `  ${'SERVICE'.padEnd(cols.label)} ${'CONTAINER'.padEnd(cols.container)} ` +
    `${'LATENCY'.padEnd(9)}DETAIL`,
)
console.log(`  ${'─'.repeat(104)}`)
for (const r of rows) line(r)
console.log(`  ${'─'.repeat(104)}`)
console.log(
  `  up ${body.summary.up} · degraded ${body.summary.degraded} · down ${body.summary.down}` +
    `   ·   API uptime ${Math.floor(body.uptimeSec / 60)}น ${body.uptimeSec % 60}ว`,
)
console.log()

process.exit(res.ok ? 0 : 1)
