import fp from 'fastify-plugin'
import { Redis } from 'ioredis'
import { env } from '@docgen/shared'

declare module 'fastify' {
  interface FastifyInstance {
    cache: Redis
  }
}

export const valkeyPlugin = fp(async (app) => {
  // ⚠️ ioredis เชื่อมแบบ lazy — ถ้า Valkey ยังไม่ขึ้น จะไม่ throw ตอนนี้
  // แต่จะค้างตอนใช้ จึงต้อง ping ตรวจให้จบตอน boot
  const cache = new Redis(env.VALKEY_URL, {
    lazyConnect: true,
    maxRetriesPerRequest: 2,
    // หน่วงระหว่าง retry ไม่ให้ชนทันทีตอน Valkey restart
    retryStrategy: (times) => Math.min(times * 200, 3000),
  })

  try {
    await cache.connect()
    await cache.ping()
  } catch (err) {
    app.log.error({ err }, 'ต่อ Valkey ไม่ได้')
    throw err
  }

  app.decorate('cache', cache)

  app.addHook('onClose', async () => {
    await cache.quit()
  })

  app.log.info('Valkey เชื่อมต่อแล้ว')
})
