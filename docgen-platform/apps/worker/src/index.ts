import { connect, RetentionPolicy, StorageType, DiscardPolicy, AckPolicy } from 'nats'
import { MongoClient, type Db } from 'mongodb'
import { env, natsServers, resolveMongoUrl, now, RenderJob, type DocumentRecord } from '@docgen/shared'
import { ensureBucket, putObject } from './s3.js'
import { renderDocument, contentTypeFor } from './docserver.js'
import { applyBranding } from './branding.js'

const COLLECTION = 'documents'
const CONSUMER = 'render-worker'
const MAX_ATTEMPTS = 3

/** ใช้ตัดสินว่า worker restart เมื่อไร — แสดงใน /api/health */
const STARTED_AT = now()

const logger = {
  info: (msg: string, meta: Record<string, unknown> = {}) =>
    console.log(JSON.stringify({ level: 'info', msg, ...meta })),
  warn: (msg: string, meta: Record<string, unknown> = {}) =>
    console.log(JSON.stringify({ level: 'warn', msg, ...meta })),
  error: (msg: string, meta: Record<string, unknown> = {}) =>
    console.error(JSON.stringify({ level: 'error', msg, ...meta })),
}

// ── แยก key ตามวันที่ จะได้ไม่กระจุกอยู่โฟลเดอร์เดียว ──────────
function storageKeyFor(documentId: string, format: string): string {
  const d = now()
  const y = d.getUTCFullYear()
  const m = String(d.getUTCMonth() + 1).padStart(2, '0')
  const day = String(d.getUTCDate()).padStart(2, '0')
  return `${y}/${m}/${day}/${documentId}.${format}`
}

async function main() {
  logger.info('worker เริ่มทำงาน', {
    stream: env.NATS_STREAM,
    subject: env.NATS_SUBJECT,
  })

  await ensureBucket()

  // ตอนรันบน host ตรง ๆ ต้องหา primary ก่อน — ดูเหตุผลใน packages/shared/src/mongo.ts
  const mongoUrl = await resolveMongoUrl((msg, meta) => logger.info(msg, meta))
  const mongo = new MongoClient(mongoUrl, { serverSelectionTimeoutMS: 10_000 })
  await mongo.connect()
  const db: Db = mongo.db(env.MONGO_DB)
  const docs = db.collection<DocumentRecord>(COLLECTION)

  // ── heartbeat ───────────────────────────────────────────────
  // ให้ API เช็คว่า worker ยังรอดอยู่จริง ไม่ใช่แค่ดูว่า consumer มีอยู่
  // (consumer ยังมีอยู่ต่อแม้ worker ตายไปแล้ว จะโชว์ผิดว่าปกติ)
  //
  // เขียนลง Mongo ไม่ใช่ Valkey เพราะ worker เปิด Mongo อยู่แล้ว
  // การต่อ Valkey เพิ่มคือ failure mode ใหม่ที่ไม่จำเป็น
  const workers = db.collection('workers')
  const HEARTBEAT_MS = 30_000
  const heartbeat = setInterval(() => {
    workers
      .updateOne(
        { _id: CONSUMER } as never,
        { $set: { lastSeen: now(), startedAt: STARTED_AT } },
        { upsert: true },
      )
      .catch((err: unknown) => logger.warn('เขียน heartbeat ไม่สำเร็จ', { error: String(err) }))
  }, HEARTBEAT_MS)
  // ไม่ต้องรอ interval เป็นตัวค้างตอน process จะจบ
  heartbeat.unref()
  // เขียนทันทีหนึ่งครั้ง ไม่งั้นตอนบูตครั้งแรก health จะโชว์ว่า worker ไม่มี
  await workers.updateOne(
    { _id: CONSUMER } as never,
    { $set: { lastSeen: now(), startedAt: STARTED_AT } },
    { upsert: true },
  )

  const nc = await connect({
    // nats.js 2.x ไม่อ่าน user:pass จาก URL — ต้องส่งเป็น option แยก
    ...natsServers(),
    name: 'docgen-worker',
    maxReconnectAttempts: -1,
    reconnectTimeWait: 2000,
  })

  // ⚠️ สองตัวนี้ไม่เหมือนกันใน nats v2.29
  //   jetstream()        → JetStreamClient  = publish() + consume()
  //   jetstreamManager() → JetStreamManager = streams.add() / consumers.add()
  const js = await nc.jetstream()
  const jsm = await nc.jetstreamManager()

  // ── หน่วยเวลาทั้งหมดข้างล่างเป็น "นาโนวินาที" (nats.js ใช้ ns ไม่ใช่ ms) ──
  //   สับสนหน่วยแล้ว ack_wait จะสั้นจน NATS ส่งซ้ำก่อน render เสร็จ
  const HOUR_NS = 3600 * 1_000_000_000

  // สร้าง stream ถ้ายังไม่มี — ทำให้ worker เป็นตัว bootstrap ได้เอง
  try {
    await js.streams.get(env.NATS_STREAM)
    logger.info('stream มีอยู่แล้ว', { stream: env.NATS_STREAM })
  } catch {
    await jsm.streams.add({
      name: env.NATS_STREAM,
      subjects: [env.NATS_SUBJECT],
      retention: RetentionPolicy.Limits,
      storage: StorageType.File,
      discard: DiscardPolicy.Old,
      max_msgs: 1_000_000,
      max_age: 24 * HOUR_NS, // เก็บงานไว้ 24 ชม. แล้ว NATS ทิ้งเอง
      num_replicas: 1,
    })
    logger.info('สร้าง stream ใหม่', { stream: env.NATS_STREAM })
  }

  // ⚠️ nats v2.29 เปลี่ยน API:
  //   - consumers.add() คืนแค่ ConsumerInfo ไม่ใช่ consumer ที่ consume ได้
  //   - ต้อง get() กลับมาให้���ึ่งค่อย consume
  //   - durable เปลี่ยนชื่อเป็น name
  //   - consume() เป็น async → ต้อง await
  await jsm.consumers.add(env.NATS_STREAM, {
    name: CONSUMER,
    filter_subject: env.NATS_SUBJECT,
    ack_policy: AckPolicy.Explicit,
    max_deliver: MAX_ATTEMPTS,
    // 30 นาที = 6 เท่าของ DOCSERVER_TIMEOUT_MS (5 นาที)
    // สั้นเกิน → worker crash แล้ว NATS ส่งงานซ้ำขณะที่งานเดิมยังทำอยู่
    // ยาวเกิน → งานที่ค้างจะรอนานเกินจำเป็นก่อนถูกส่งซ้ำ
    ack_wait: 30 * 60_000_000, // หน่วยนาโนวินาที
  }).catch((err: Error) => {
    // เคยสร้างไว้แล้ว (restart ครั้งที่สอง) — ไม่ใช่ error จริง
    if (!/already exists/i.test(err.message)) throw err
    logger.info('consumer มีอยู่แล้ว ใช้ตัวเดิม', { consumer: CONSUMER })
  })

  const consumer = await js.consumers.get(env.NATS_STREAM, CONSUMER)
  const messages = await consumer.consume()

  logger.info('consumer พร้อมรับงาน', { consumer: CONSUMER, max_attempts: MAX_ATTEMPTS })

  const shutdown = async (signal: string) => {
    logger.info('กำลังหยุด worker...', { signal })
    clearInterval(heartbeat)
    try {
      await messages.close()
      await nc.drain()
      await mongo.close()
    } catch {
      // ปิดไม่ครบก็จบไป อย่าค้าง
    } finally {
      process.exit(0)
    }
  }
  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))

  // ── ลูปหลัก ────────────────────────────────────────────────
  for await (const msg of messages) {
    // ⚠️ v2.29: msg.data เป็น Uint8Array — ต้องใช้ msg.json<T>() ไม่ใช่ JSON.parse(data)
    const { documentId, templateId, outputFormat, data } = msg.json<RenderJob>()
    const started = Date.now()

    try {
      logger.info('เริ่มเรนเดอร์', { documentId, templateId })

      const updated = await docs.updateOne(
        { _id: documentId } as never,
        { $set: { status: 'rendering', error: null, updatedAt: now() } },
      )
      if (updated.matchedCount === 0) {
        // ไม่พบ = อาจเป็น race (API insert ยังไม่จบ) ไม่ใช่แปลว่างานเสีย
        // → nak ให้ NATS ส่งซ้ำแทนการ ack ทิ้ง
        // ครบ MAX_ATTEMPTS แล้ว NATS จะเลิกส่งเอง (ไม่มีเอกสารให้ mark failed)
        logger.warn('ยังไม่เจอเอกสารใน Mongo — ขอ NATS ส่งซ้ำ', {
          documentId,
          attempt: msg.info?.deliveryCount ?? 1,
        })
        msg.nak(2_000)
        continue
      }

      const buf = await renderDocument({ templateId, data, outputFormat })

      // เขียนทับ metadata ให้เป็นแบรนด์ของเรา ก่อนขึ้น S3
      // ทำหลัง render เสร็จเท่านั้น — ถ้าทำก่อนจะไม่มีไฟล์ให้แก้
      const branded = await applyBranding(buf, outputFormat)

      const key = storageKeyFor(documentId, outputFormat)
      await putObject(key, branded, contentTypeFor(outputFormat))

      await docs.updateOne(
        { _id: documentId } as never,
        { $set: { status: 'done', storageKey: key, updatedAt: now() } },
      )
      msg.ack()

      logger.info('เรนเดอร์สำเร็จ', {
        documentId,
        bytes: branded.length,
        ms: Date.now() - started,
      })
    } catch (err) {
      const attempt = msg.info?.deliveryCount ?? 1
      const isLast = attempt >= MAX_ATTEMPTS

      logger.error(
        isLast ? 'เรนเดอร์ล้มเหลว ไม่มีโอกาสแล้ว' : 'เรนเดอร์ล้มเหลว จะลองใหม่',
        { documentId, error: String(err), attempt },
      )

      await docs
        .updateOne(
          { _id: documentId } as never,
          {
            $set: {
              status: isLast ? 'failed' : 'queued',
              error: isLast ? String(err).slice(0, 500) : null,
              updatedAt: now(),
            },
          },
        )
        .catch(() => undefined)

      if (isLast) {
        msg.ack() // ทิ้ง ไม่งั้นจะวนลมพั่น
      } else {
        msg.nak() // ส่งคืนให้ NATS redeliver
      }
    }
  }
}

main().catch((err) => {
  logger.error('worker ล้ม', { error: String(err) })
  process.exit(1)
})
