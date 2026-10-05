/**
 * เปิด docserver ให้ dev server ที่รัน**บน host** ใช้ชั่วคราว
 *
 * ── ทำไมต้องมี ──────────────────────────────────────────────
 * `dokploy-infra/docker-compose.yml` ตัด `ports:` ของ docserver ออกแล้ว
 * เพื่อไม่ให้มีทางเข้าจากเครื่องนี้ (ตัว Carbone ไม่มี auth เลย)
 * ผลคือ process ที่รันบน host (dev API, worker, สคริปต์ใน `tools/`)
 * ยิง `http://127.0.0.1:4000` ไม่ได้อีก
 *
 * ทางออกที่เลือก: ใช้ container ตัวเล็ก ๆ ทำหน้าที่เป็น "สะพราน"
 * ฟังที่ 127.0.0.1:4000 บน host แล้วต่อไปที่ docserver ในเครือข่าย Docker
 * → หยุดสะพรานเมื่อไหร่ ก็กลับเป็นปิดทันที ไม่ต้องแตะ compose
 *
 * ── ทำไมไม่ใช้ IP ของ container ตรง ๆ ───────────────────────
 * ทดสอบแล้ว: host ยิง 172.19.x.x ไม่ถึง (Docker Desktop ใช้ WSL2
 * ซึ่งแยก network namespace ของ host ออกจากของ container)
 * และถ้าใช้ IP ก็ยังผิดอีกที เพราะ IP เปลี่ยนทุกครั้งที่ recreate
 *
 * ── ใช้ ─────────────────────────────────────────────────────
 *   node --env-file=.env tools/docserver-bridge.mjs          เปิด
 *   node --env-file=.env tools/docserver-bridge.mjs stop     ปิด
 *   หรือ: npm run dev:docserver / npm run dev:docserver:stop
 */
import { execFileSync } from 'node:child_process'

const BRIDGE = 'docserver-dev-bridge'
const HOST_PORT = '4000'
const TARGET = 'docserver:4000'
const stop = process.argv[2] === 'stop'

/** คืน true ถ้า docserver ตอบกลับ — วัดจริง ไม่เดา */
async function reachable() {
  try {
    const res = await fetch(`http://127.0.0.1:${HOST_PORT}/status`, {
      signal: AbortSignal.timeout(3000),
    })
    return res.ok
  } catch {
    return false
  }
}

const docker = (...args) =>
  execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

const exists = (name) => {
  try {
    return docker('ps', '-a', '--filter', `name=^/${name}$`, '--format', '{{.Names}}') === name
  } catch {
    return false
  }
}

// ── ปิด ──────────────────────────────────────────────────────
if (stop) {
  if (exists(BRIDGE)) {
    docker('rm', '-f', BRIDGE)
    console.log(`ปิดสะพรานแล้ว (${BRIDGE})`)
  } else {
    console.log('ไม่มีสะพรานอยู่แล้ว — ไม่ต้องทำอะไร')
  }
  process.exit(0)
}

// ── เปิด ─────────────────────────────────────────────────────

// เปิดซ้ำได้ — ถ้ามีอยู่แล้วและยังใช้ได้ บอกจบ ไม่ต้องสร้างใหม่
if (await reachable()) {
  console.log(`docserver ตอบที่ 127.0.0.1:${HOST_PORT} อยู่แล้ว — ไม่ต้องทำอะไร`)
  process.exit(0)
}
if (exists(BRIDGE)) {
  docker('rm', '-f', BRIDGE)
  console.log('เจอสะพรานตัวเก่าที่ไม่ทำงาน — ลบแล้วสร้างใหม่')
}

// กันไว้ก่อน: ถ้า docserver เองไม่ healthy สะพรานจะผ่านแต่ปลายทางไม่มี
const health = (() => {
  try {
    return docker('inspect', '--format', '{{.State.Health.Status}}', 'docserver')
  } catch {
    return 'ไม่มี'
  }
})()
if (health !== 'healthy') {
  console.error(`docserver ยังไม่ healthy (${health}) — แก้ให้ healthy ก่อน แล้วค่อยเปิดสะพราน`)
  process.exit(1)
}

docker(
  'run',
  '-d',
  '--name',
  BRIDGE,
  '--network',
  'infra',
  '-p',
  `127.0.0.1:${HOST_PORT}:${HOST_PORT}`,
  '--restart',
  'no',
  'alpine/socat',
  `TCP-LISTEN:${HOST_PORT},fork,reuseaddr`,
  `TCP:${TARGET}`,
)

// รอจนกว่าจะยิงได้จริง — ไม่เชื่อว่า "รันคำสั่งแล้ว = ใช้ได้"
let ok = false
for (let i = 0; i < 20; i++) {
  await new Promise((r) => setTimeout(r, 500))
  if (await reachable()) {
    ok = true
    break
  }
}
if (!ok) {
  console.error(`เปิดสะพรานแล้วแต่ยังยิง ${TARGET} ไม่ถึง — ดู log: docker logs ${BRIDGE}`)
  process.exit(1)
}

const info = await (await fetch(`http://127.0.0.1:${HOST_PORT}/status`)).json()
console.log(`เปิดสะพรานแล้ว → http://127.0.0.1:${HOST_PORT}  (docserver ${info.version ?? '?'})`)
console.log(`ปิดเมื่อเสร็จ: npm run dev:docserver:stop`)
