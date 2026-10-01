import fp from 'fastify-plugin'
import {
  connect,
  type NatsConnection,
  type JetStreamClient,
  type JetStreamManager,
} from 'nats'
import { env, natsServers } from '@docgen/shared'

declare module 'fastify' {
  interface FastifyInstance {
    nats: NatsConnection
    /** JetStreamClient มี .publish() — JetStreamManager ไม่มี */
    js: JetStreamClient
    /** JetStreamManager มี .streams / .consumers — ใช้ดูสถานะ consumer */
    jsm: JetStreamManager
  }
}

export const natsPlugin = fp(async (app) => {
  const nats = await connect({
    // nats.js 2.x ไม่อ่าน user:pass จาก URL — ต้องส่งเป็น option แยก
    ...natsServers(),
    name: 'docgen-api',
    maxReconnectAttempts: -1,
    reconnectTimeWait: 2000,
  })

  const js = await nats.jetstream()
  const jsm = await nats.jetstreamManager()

  // เช็คว่า stream มีอยู่จริง — ยังไม่มีไม่ throw ให้ API รับงานอื่นได้ก่อน
  try {
    const stream = await js.streams.get(env.NATS_STREAM)
    const info = await stream.info()
    app.log.info(
      { stream: env.NATS_STREAM, messages: info.state.messages },
      'NATS JetStream พร้อม',
    )
  } catch {
    app.log.warn(
      { stream: env.NATS_STREAM },
      `ยังไม่มี stream '${env.NATS_STREAM}' — worker จะสร้างให้เองตอนขึ้น`,
    )
  }

  app.decorate('nats', nats)
  app.decorate('js', js)
  app.decorate('jsm', jsm)

  app.addHook('onClose', async () => {
    await nats.drain().catch(() => nats.close())
  })

  app.log.info('NATS เชื่อมต่อแล้ว')
})
