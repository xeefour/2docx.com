import { env } from '@docgen/shared'
import { buildApp } from './app.js'

const app = await buildApp()

try {
  await app.listen({ host: env.API_HOST, port: env.API_PORT })
  app.log.info(`เอกสาร API อยู่ที่ /docs`)
} catch (err) {
  app.log.error({ err }, 'เปิดเซิร์ฟเวอร์ไม่ได้')
  process.exit(1)
}

// SIGTERM มาจาก docker stop — ปิดให้ทัน
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, async () => {
    app.log.info({ signal }, 'กำลังปิด...')
    try {
      // timeout กันการปิดค้างถ้า connection ค้าง
      await app.close()
      process.exit(0)
    } catch (err) {
      app.log.error({ err }, 'ปิดไม่สำเร็จ')
      process.exit(1)
    }
  })
}
