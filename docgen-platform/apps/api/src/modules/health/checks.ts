/**
 * health check ของทุก service ที่แอปพึ่ง
 *
 * ═══════════════════════════════════════════════════════════════════
 *  🛠  เพิ่ม docker container ใหม่ → แก้ไฟล์นี้ไฟล์เดียว
 * ═══════════════════════════════════════════════════════════════════
 *
 * ขั้นตอน:
 *   1. เพิ่ม service ใน docker-compose (โปรเจกต์ `dokploy-infra` หรือ `docgen-platform`)
 *   2. ถ้าต้องตั้งค่าใหม่ ใส่ env ใน `packages/shared/src/env.ts` + `.env.example` ด้วย
 *   3. เพิ่ม object หนึ่งตัวใน `CHECKS` (ฟังก์ชัน `buildChecks`) ด้านล่าง
 *   4. ใส่ `container` = ชื่อที่ `docker ps` แสดง เพื่อให้เทียบกันได้
 *   5. ถ้าไม่มี client ใน API ให้ probe ด้วย `fetch` ไปที่ endpoint ตรง ๆ แทน
 *
 * ไม่ต้องแก้ที่อื่น — route อ่านจาก array นี้อัตโนมัติ
 * แล้วโผล่ใน Swagger UI ที่ `/apis` พร้อมกัน
 *
 * ── กติกา ────────────────────────────────────────────────────
 * · timeout ใส่ใน `runCheck()` ให้อัตโนมัติ เสมอ
 *   (ไม่งั้น service ที่ค้างจะดึงทั้ง endpoint ไปด้วย)
 * · throw = down · คืน status 'degraded' = ใช้ได้แต่มีเรื่องน่าห่วง
 * · `detail` เขียนให้คนอ่านแล้วรู้ทันทีว่าต้องไปแก้อะไร ไม่ใช่แค่ "OK"
 */
import type { FastifyInstance } from 'fastify'
import { env, type HealthCheck } from '@docgen/shared'

/** ตัว probe หนึ่งตัว — คืน detail หรือ throw เพื่อบอกว่าตาย */
type CheckFn = () => Promise<{ detail: string; status?: 'up' | 'degraded' }>

interface Check {
  id: string
  label: string
  /** ชื่อ container ตาม `docker ps` — null ถ้าไม่ได้อยู่ใน container */
  container: string | null
  run: CheckFn
}

/** timeout ต่อ 1 service — สั้นพอที่จะรู้เร็ว ยาวพอที่ network ไม่จะสั่น */
const TIMEOUT_MS = 2_000

/** worker เขียน heartbeat ทุก 30 วิ — ขาดเกินนี้ถือว่าตาย */
const WORKER_STALE_SEC = 90

/** ตัด error ให้สั้นและอ่านออก — stack เต็มไม่มีประโยชน์ตรงนี้ */
function reason(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  return msg.replace(/\s+/g, ' ').slice(0, 140)
}

/** แปลง ms ให้อ่านง่าย */
function fmtMs(n: number): string {
  return n < 1000 ? `${Math.round(n)}ms` : `${(n / 1000).toFixed(2)}s`
}

/** ผ่านไปกี่วินาที — null ถ้าไม่เคยเขียนมา */
function since(date: Date | undefined | null): number | null {
  if (!date) return null
  return Math.round((Date.now() - date.getTime()) / 1000)
}

export function buildChecks(app: FastifyInstance): Check[] {
  return [
    // ── MongoDB ───────────────────────────────────────────────
    {
      id: 'mongodb',
      label: 'MongoDB (replica set rs0)',
      container: 'mongo-1 / mongo-2 / mongo-3',
      run: async () => {
        // ping แค่บอกว่าต่อได้ — ต้องดูด้วยว่าเป็น primary ไหม
        // ถ้าเป็น SECONDARY การเขียนจะได้ "not primary" แล้วพังตอนนั้น
        await app.mongo.command({ ping: 1 })

        const status = (await app.mongo
          .admin()
          .command({ replSetGetStatus: 1 })) as unknown as {
          set: string
          myState: number
          members: { name: string; stateStr: string }[]
        }

        // state 1 = PRIMARY
        const primary = status.members.find((m) => m.stateStr === 'PRIMARY')?.name
        const healthy = status.members.filter((m) => m.stateStr === 'PRIMARY').length === 1

        if (!healthy) {
          return {
            status: 'degraded',
            detail: `replica set '${status.set}' มี PRIMARY ไม่ครบ 1 ตัว`,
          }
        }

        return {
          detail: `${status.set} · primary = ${primary} · ${status.members.length} node`,
        }
      },
    },

    // ── Valkey ────────────────────────────────────────────────
    {
      id: 'valkey',
      label: 'Valkey (session + cache)',
      container: 'valkey',
      run: async () => {
        const pong = await app.cache.ping()
        if (pong !== 'PONG') throw new Error(`คาดว่า PONG แต่ได้ ${pong}`)

        // อ่าน memory เพราะถ้าไม่บอก จะไม่รู้ว่า session กิน heap ไปเท่าไร
        const mem = (await app.cache.info('memory')) as unknown as string
        const used = mem.match(/used_memory_human:(\S+)/)?.[1] ?? 'ไม่ทราบ'
        return { detail: `PONG · ใช้ ${used}` }
      },
    },

    // ── NATS JetStream ────────────────────────────────────────
    {
      id: 'nats',
      label: `NATS JetStream (stream ${env.NATS_STREAM})`,
      container: 'nats',
      run: async () => {
        try {
          const stream = await app.js.streams.get(env.NATS_STREAM)
          const info = await stream.info()
          return {
            detail: `stream ${info.config.name} · ${info.state.messages} ข้อความ · ${info.state.bytes} bytes`,
          }
        } catch {
          // ยังไม่มี stream ไม่ใช่ปัญหา — worker จะสร้างให้ตอนขึ้น
          return {
            status: 'degraded',
            detail: `ยังไม่มี stream '${env.NATS_STREAM}' — worker จะสร้างตอนขึ้น`,
          }
        }
      },
    },

    // ── RustFS (S3) ───────────────────────────────────────────
    {
      id: 'rustfs',
      label: `RustFS (S3 · bucket ${env.S3_BUCKET})`,
      container: 'rustfs',
      run: async () => {
        await app.s3.ping()
        return { detail: `bucket '${env.S3_BUCKET}' เข้าถึงได้` }
      },
    },

    // ── docserver ─────────────────────────────────────────────
    {
      id: 'docserver',
      label: '2docx docserver (เรนเดอร์)',
      container: 'docserver',
      run: async () => {
        // ⚠️ ห้ามใส่ header 'Expect' — fetch ของ Node (undici) ไม่รองรับ
        // ⚠️ docserver ไม่มี /info หรือ /version — มีแต่ /templates ที่ใช้ได้จริง
        const res = await fetch(`${env.DOCSERVER_URL}/templates`, {
          headers: {
            Authorization: `Bearer ${env.DOCSERVER_API_KEY}`,
            'carbone-version': '5',
          },
        })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)

        const body = (await res.json()) as { data?: unknown[] }
        const count = body.data?.length ?? 0
        return { detail: `ตอบกลับ · มีแม่แบบ ${count} รายการ` }
      },
    },

    // ── worker ────────────────────────────────────────────────
    {
      id: 'worker',
      label: 'worker (เรนเดอร์งาน)',
      container: 'worker',
      run: async () => {
        // เช็ค heartbeat ที่ worker เขียนลง Mongo ไม่ใช่ consumer state
        // เพราะ consumer ยังมีอยู่ต่อแม้ worker ตายไปแล้ว
        // → ถ้าใช้ consumer จะโชว์ผิดว่าปกติ
        const doc = await app.mongo
          .collection<{ _id: string; lastSeen: Date; startedAt: Date }>('workers')
          .findOne({ _id: 'render-worker' })

        const age = since(doc?.lastSeen)
        if (age === null) {
          return {
            status: 'degraded',
            detail: 'ยังไม่เคยเจอ heartbeat — worker อาจยังไม่ได้ขึ้น หรือเป็นเวอร์ชันก่อนมี heartbeat',
          }
        }
        if (age > WORKER_STALE_SEC) {
          throw new Error(`ไม่ตอบ heartbeat มา ${age} วินาที (เกิน ${WORKER_STALE_SEC} วิ)`)
        }

        // รายงานสถานะคิวควบคู่ เพราะ "ยังไม่ตอบ" ไม่ได้แปลว่า "ไม่ทำงาน"
        let queue = ''
        try {
          const consumer = await app.jsm.consumers.info(env.NATS_STREAM, 'render-worker')
          queue = ` · คิวค้าง ${consumer.num_pending} · รอ ack ${consumer.num_ack_pending}`
        } catch {
          queue = ' · ไม่เจอ consumer'
        }

        return { detail: `heartbeat ${age} วิที่แล้ว${queue}` }
      },
    },
  ]
}

/**
 * รันทุก check พร้อมกันแล้วแปลงเป็น HealthCheck[]
 *
 * ใช้ Promise.allSettled เพราะ check หนึ่งพังต้องไม่ทำให้ทั้งหน้า error
 * และ timeout ต้องมีเสมอ ไม่งั้น service ที่ค้างจะดึง request นี้ค้างตามไป
 */
export async function runChecks(checks: Check[]): Promise<HealthCheck[]> {
  return Promise.all(
    checks.map(async (c): Promise<HealthCheck> => {
      const started = Date.now()
      let timer: NodeJS.Timeout | undefined

      try {
        const timeout = new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`ไม่ตอบใน ${TIMEOUT_MS / 1000} วินาที`)),
            TIMEOUT_MS,
          )
        })

        const { detail, status = 'up' } = await Promise.race([c.run(), timeout])

        return {
          id: c.id,
          label: c.label,
          container: c.container,
          status,
          latencyMs: Date.now() - started,
          detail,
        }
      } catch (err) {
        // timeout แยกออกมาเป็น latencyMs: null เพราะ "ตอบช้า" กับ "ไม่ตอบ" ไม่เหมือนกัน
        const timedOut = err instanceof Error && err.message.startsWith('ไม่ตอบใน')
        return {
          id: c.id,
          label: c.label,
          container: c.container,
          status: 'down',
          latencyMs: timedOut ? null : Date.now() - started,
          detail: reason(err),
        }
      } finally {
        clearTimeout(timer)
      }
    }),
  )
}

export { fmtMs }
