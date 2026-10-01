/**
 * `GET /api/health` — สถานะทุก service ในจุดเดียว
 *
 * เปิดสาธารณ (ไม่ต้อง login) โดยเจตนา เพราะ:
 * · เป็น endpoint ที่ load balancer / Docker healthcheck เรียก
 *   ถ้าบังคับ login ระบบจะตัดสินว่า unhealthy ทันทีที่ session หมดอายุ
 * · เปิดไว้ที่ `/docs` ให้กด "Try it out" ดูสถานะสดได้เลย
 *
 * เปิดเผยแค่ชื่อ service + up/down + latency ไม่มี credential หรือข้อมูลเอกสาร
 */
import type { FastifyPluginAsync } from 'fastify'
import { HealthReport, type HealthCheck } from '@docgen/shared'
import { buildChecks, runChecks, fmtMs } from './checks.js'

export const healthRoutes: FastifyPluginAsync = async (app) => {
  const checks = buildChecks(app)

  app.get(
    '/health',
    {
      schema: {
        tags: ['health'],
        summary: 'สถานะทุก service ที่ระบบพึ่ง',
        description: [
          'ยิงซ้ำได้ตลอด ปลอดภัยทั้งหลักและหลังบ้าน',
          '',
          'รหัสผลลัพธ์:',
          '- `200` = ทุกตัว `up`',
          '- `503` = มีตัวที่ `down` หรือ `degraded` (ยังเข้าใช้บางส่วนได้)',
          '',
          '⚠️ เพิ่ม container ใหม่ต้องแก้ `modules/health/checks.ts`',
          '   รายการนี้ไม่ได้อ่านจาก `docker ps` อัตโนมัติ',
        ].join('\n'),
        response: {
          200: HealthReport,
          503: HealthReport,
        },
      },
    },
    async (_req, reply) => {
      const started = Date.now()
      const results = await runChecks(checks)

      const summary = {
        up: results.filter((c) => c.status === 'up').length,
        degraded: results.filter((c) => c.status === 'degraded').length,
        down: results.filter((c) => c.status === 'down').length,
      }

      // ตัว API เองตอบได้แปลว่ายัง up เสมอ (ถ้าตายก็ไม่มี response ให้ดูอยู่แล้ว)
      const api: HealthCheck = {
        id: 'api',
        label: 'API (Fastify)',
        container: 'api',
        status: 'up',
        latencyMs: 0,
        detail: `uptime ${fmtMs(process.uptime() * 1000)} · Node ${process.version}`,
      }

      const report: HealthReport = {
        // มีตัวที่ down = ระบบใช้ไม่ได้จริง → 503 ให้ monitor จับได้
        status: summary.down > 0 ? 'down' : summary.degraded > 0 ? 'degraded' : 'ok',
        uptimeSec: Math.round(process.uptime()),
        tookMs: Date.now() - started,
        api,
        checks: results,
        summary,
      }

      if (summary.down > 0) {
        app.log.warn({ summary, tookMs: report.tookMs }, 'health check พบ service ที่ล่ม')
        return reply.code(503).send(report)
      }
      return reply.send(report)
    },
  )
}
