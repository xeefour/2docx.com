import { fileURLToPath } from 'node:url'

/**
 * ⚠️ rewrite `/api` ไปที่ Fastify — นี่คือเหตุผลที่ Studio ใช้งานได้โดยไม่ต้องตั้ง CORS
 *
 * เบราว์เซอร์จะคุยกับ origin เดียว (localhost:3000) เสมอ
 * cookie session ของ Casdoor จึงถูกส่งไปด้วยทุกครั้งโดยไม่ต้องพึ่ง `SameSite=None`
 * และไม่ต้องเพิ่ม `Access-Control-Allow-Credentials` ที่ฝั่ง API
 *
 * ── เรื่องพอร์ตกับ cookie ──────────────────────────────────────
 * cookie **ไม่แยกพอร์ต** — cookie ที่ตั้งที่ `localhost:4001`
 * จะถูกส่งไปยัง `localhost:3000` ด้วย
 * นี่คือเหตุผลที่ Casdoor callback ชี้ไปที่ API (:4001) ได้
 * แล้วผู้ใช้ยังล็อกอินอยู่บน Studio (:3000)
 *
 * ⚠️ แต่ host ต้องเหมือนกัน: `localhost` กับ `127.0.0.1` ถือเป็นคนละโดเมน
 *    cookie ที่ตั้งที่ `localhost` จะ**ไม่ถูกส่ง**ไป `127.0.0.1`
 *    เข้าเว็บด้วย `localhost:3000` ให้ตรงกันเสมอ
 */
const API_ORIGIN = process.env.API_ORIGIN ?? 'http://127.0.0.1:4001'

/** @type {import('next').NextConfig} */
export default {
  // ป้าย dev ของ Next ปกติจะอยู่มุมล่างซ้าย ซึ่งชนกับแถบ URL ของเรา
  // (แถบนั้นต้องกดได้ตอนหน้าค้าง ถ้าถูกทับก็กดไม่ได้) → ย้ายไปมุมล่างขวา
  // ตัวนี้มีเฉพาะตอน dev เท่านั้น production ไม่มี
  devIndicators: { position: 'bottom-right' },

  /**
   * ── สำหรับ Docker ─────────────────────────────────────────────
   * `standalone` ให้ Next ออกมาเป็น `server.js` + `node_modules` ชุดเล็ก
   *   (ตัด dependency ที่ไม่ได้ใช้ออก) → ไม่ต้องก๊อป `node_modules` ทั้งก้อนเข้า image
   *   ตอน dev ค่านี้ไม่มีผล เพราะ `next dev` ไม่ได้ใช้โหมดนี้
   *
   * ⚠️ `outputFileTracingRoot` ต้องเป็น**สตริง** ไม่ใช่ URL object
   *    (ส่ง `new URL(...)` ไปตรง ๆ แล้ว `next build` พังด้วย
   *     `The "path" argument must be of type string. Received an instance of URL`)
   *
   *    ต้องชี้ที่**ราก monorepo** ไม่ใช่ `apps/web`
   *    เพราะเว็บ import จาก `@docgen/shared` ซึ่งอยู่คนละ workspace
   *    ถ้าไม่ตั้ง Next จะ trace แค่ใน `apps/web` แล้ว build ออกมา runtime error
   *    ว่า "Cannot find module '@docgen/shared'"
   */
  output: 'standalone',
  outputFileTracingRoot: fileURLToPath(new URL('../../', import.meta.url)),

  async rewrites() {
    return [
      { source: '/api/:path*', destination: `${API_ORIGIN}/api/:path*` },
      // auth ไม่ได้อยู่ใต้ prefix /api — ต้อง rewrite แยก
      // ไม่งั้นผู้ใช้กด "เข้าสู่ระบบ" แล้วได้ 404 จาก Next
      { source: '/auth/:path*', destination: `${API_ORIGIN}/auth/:path*` },
      // เอกสาร API ให้เปิดจากเว็บได้โดยไม่ต้องจำพอร์ต
      { source: '/docs', destination: `${API_ORIGIN}/docs` },
      { source: '/openapi.json', destination: `${API_ORIGIN}/openapi.json` },
    ]
  },
}
