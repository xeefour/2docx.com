import { z } from 'zod/v4'

/**
 * connection string ไม่ใช่ URL ที่จะเอาไป fetch
 * `z.string().url()` ใน Zod 4 ปฏิเสธ mongodb:// เพราะ comma ใน host list
 * ทำให้ไม่ผ่าน WHATWG URL spec → ใช้เช็ค scheme เองแทน
 */
const connString = (scheme: string) =>
  z
    .string()
    .min(1, 'ต้องมีค่า')
    .refine((v) => v.startsWith(`${scheme}://`), {
      message: `ต้องขึ้นต้นด้วย ${scheme}://`,
    })

/** URL ปกติ (จะถูกเอาไป fetch จริง) — ใช้ .url() ได้ */
const httpUrl = z.string().url()

/**
 * URL ที่ "เว้นว่าง = ไม่ตั้ง" — รับค่าว่างได้ด้วย
 *
 * ⚠️ ทำไมต้องมีตัวนี้ (เจอจริง 2026-10-06)
 *   `z.string().url().optional()` รับ `undefined` แต่**ไม่รับ `''`**
 *   ขณะที่ไฟล์ `.env` / `.env.example` ของเราเขียนค่าเว้นว่างเป็น `KEY=`
 *   (เป็นรูปแบบมาตรฐานของไฟล์ env และเป็นวิธีบอกว่า "ยังไม่ได้ตั้ง")
 *   ผลคือ `LLM_BASE_URL=` ทำให้ API crash ตอน boot ด้วย "Invalid URL"
 *   ทั้งที่ผู้ใช้ทำตามค่าตัวอย่างเป๊ะ → schema ต้องยอมรับรูปแบบของไฟล์จริง
 */
const optionalUrl = z.preprocess(
  (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
  httpUrl.optional(),
)

/**
 * Config ทั้งระบบ validate ครั้งเดียวตอน import
 * ถ้าตัวไหนขาดหรือผิดรูป จะ crash ทันทีตอน start — ไม่ใช่ตอนรันคำขอแรก
 */
const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  /**
   * ⚠️ ค่าเริ่มต้นต้องเป็น `127.0.0.1` ไม่ใช่ `0.0.0.0`
   *
   *   ค่าเริ่มต้นนี้มีผลตอนรันบน **host** ตอน dev — ซึ่งเป็นกรณีที่พลาดง่ายที่สุด
   *   วัดจริง 2026-10-05: ทั้ง API (:4001) และเว็บ (:3000) ถูก bind ที่ 0.0.0.0
   *   ทำให้เข้าได้จาก LAN (`192.168.100.200:3000` ได้ 200) และจาก Tailscale
   *   ทั้ง tailnet (`100.77.216.111:3000` ได้ 200) ทั้งที่ตั้งใจปิดไว้
   *
   *   ใน container ต้องเป็น `0.0.0.0` เพื่อให้ gateway ยิงเข้ามาได้
   *   → `docker-compose.yml` ตั้ง `API_HOST: 0.0.0.0` ให้ service `api` ไว้แล้ว
   *   ค่าเริ่มต้นจึงเป็นแบบ "พลาดแล้วปลอดภัย" (fail-safe) ไม่ใช่เปิดกว้างโดยค่าเริ่มต้น
   */
  API_HOST: z.string().default('127.0.0.1'),
  API_PORT: z.coerce.number().int().positive().default(4000),
  CORS_ORIGINS: z.string().default('http://localhost:3000'),

  MONGO_INIT_URL: connString('mongodb'),
  MONGO_URL: connString('mongodb'),
  MONGO_DB: z.string().default('app'),
  /**
   * candidate ที่ใช้หา primary ตอนรันบน host ตรง ๆ
   *
   * ตอนรันใน Docker ใช้ชื่อ service (`mongo-1,mongo-2,mongo-3`) driver จัดการเอง
   * แต่ตอนรันบน Windows host ชื่อ `mongo-1` resolve ไม่ได้ → ต้องใช้
   * directConnection ซึ่งจะ pin ที่ node เดียว ถ้าตัวนั้นเป็น SECONDARY
   * การเขียนจะได้ "not primary" แล้ว crash ตอน boot
   *
   * ใส่พอร์ตที่ publish ออกมาทั้งหมด เช่น
   *   127.0.0.1:27017,127.0.0.1:27018,127.0.0.1:27019
   * เว้นว่างไว้ = ไม่ต้องหา (ถูกแล้วถ้ารันใน Docker)
   */
  MONGO_PRIMARY_CANDIDATES: z.string().optional(),

  VALKEY_URL: connString('redis'),

  // ── Casdoor SSO (OIDC) ──────────────────────────────────────
  /**
   * issuer ของ Casdoor — ใช้ค้น endpoint จาก discovery document
   * ดู https://<issuer>/.well-known/openid-configuration
   */
  CASDOOR_ISSUER: httpUrl,

  CASDOOR_CLIENT_ID: z.string().min(1),
  CASDOOR_CLIENT_SECRET: z.string().min(1),

  /**
   * callback ที่ลงทะเบียนไว้ใน Casdoor — ต้องตรงกันเป๊ะทุกตัวอักษร
   *
   * ⚠️ ใช้ `localhost` ไม่ใช่ `127.0.0.1` ถ้าหน้าเว็บเปิดที่ localhost
   *    เพราะ browser มอง `localhost` กับ `127.0.0.1` เป็นคนละ site
   *    ถ้าใช้คนละแบบ cookie SameSite=Lax จะไม่ถูกส่ง → login ไม่ติด
   */
  CASDOOR_REDIRECT_URI: httpUrl,

  /** scope ที่ขอ — Casdoor รองรับ openid profile email */
  CASDOOR_SCOPES: z.string().default('openid profile email'),

  /** หลัง login สำเร็จจะพาไปที่นี่ */
  AUTH_SUCCESS_REDIRECT: httpUrl.default('http://localhost:3000'),

  SESSION_COOKIE_NAME: z.string().default('docgen_session'),
  /** อายุ session วินาที (default 1 วัน) */
  SESSION_TTL: z.coerce.number().int().positive().default(86_400),

  /**
   * จำนวน request ต่อ IP ต่อหน้าต่างเวลา
   *
   * ⚠️ ค่าเดิม 100/นาที น้อยเกินไปมากสำหรับ Studio
   *   เปิดหน้าเดียวยิงราว 6 request (แม่แบบ + ประวัติ + chat + ที่แชร่กับฉัน + สิทธิ์ + LLM)
   *   ผู้ใช้ที่รีเฟรชสัก 5 ครั้งก็ชน 429 แล้ว
   *   ตั้งเป็น 0 = ปิด (เครื่องที่อยู่ใน tailnet ส่วนตัว ปิดได้)
   */
  RATE_LIMIT_MAX: z.coerce.number().int().min(0).default(600),
  /** ความยาวหน้าต่างเวลาของ rate limit (มิลลิวินาที) */
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  /**
   * ต้องเป็น true เมื่อเสิร์ฟผ่าน https (Tailscale Serve / Cloudflare)
   * browser จะปฏิเสธ cookie Secure=false บน https และ
   * cookie SameSite=None จะใช้ไม่ได้ถ้าไม่มี Secure
   */
  SESSION_COOKIE_SECURE: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),

  NATS_URL: connString('nats'),
  NATS_STREAM: z.string().default('DOCGEN'),
  NATS_SUBJECT: z.string().default('jobs.render'),

  S3_ENDPOINT: httpUrl,
  /**
   * endpoint ที่ "ภายนอก" เข้าถึงได้ — ใช้เฉพาะตอนออก presigned URL
   *
   * ต้องตั้งเมื่อ client ที่เรียก API ไม่ได้อยู่บนเครื่องเดียวกัน
   * เช่นเข้าผ่าน Tailscale Serve → RustFS ต้องชี้ที่ hostname ของ tailnet
   * ไม่งั้น URL ที่ส่งให้ client จะชี้ 127.0.0.1 ซึ่งหมายถึง localhost ของ client
   *
   * เว้นว่างไว้ = ใช้ S3_ENDPOINT (เหมาะกับ dev ที่เรียกจากเครื่องเดียวกัน)
   */
  S3_PUBLIC_ENDPOINT: httpUrl.optional(),
  S3_REGION: z.string().default('us-east-1'),
  S3_ACCESS_KEY: z.string().min(1),
  S3_SECRET_KEY: z.string().min(1),
  S3_BUCKET: z.string().default('documents'),
  S3_FORCE_PATH_STYLE: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),

  DOCSERVER_URL: httpUrl,
  DOCSERVER_API_KEY: z.string().default('carbon-ce'),
  DOCSERVER_TIMEOUT_MS: z.coerce.number().int().positive().default(300_000),


  // ── อีเมล (SMTP) ───────────────────────────────────────────────
  /**
   * ใช้ส่งอีเมลเชิญคนที่ยังไม่เคยเข้าระบบ ให้เข้าถึงแม่แบบได้
   *
   * ⚠️ ทุกตัวเป็น optional โดยตั้งใจ
   *   ถ้าบังคับให้มี ระบบที่ยังไม่ได้ตั้งค่าจะ crash ตอนบูตทันที
   *   แต่การส่งอีเมลเป็น**ฟีเจอร์เสริม** — ขาดไปแค่ฟีเจอร์นี้
   *   ไม่ควรทำให้ทั้งระบบล่ม (ดู `modules/people/mail.ts` ที่คืนค่า `mailReady: false`)
   *
   * ปล่อยว่างทั้งหมด = ระบบยังรับคำเชิญได้ แต่ไม่ส่งอีเมล
   *   ผู้ใช้ที่ถูกเชิญยังได้สิทธิ์ปกติตอนเข้าระบบครั้งแรก
   */
  SMTP_HOST: z.string().optional(),
  /** 587 = STARTTLS ของ SMTP ทั่วไป · 465 = SSL ตรง · 25 = ไม่เข้ารหัส */
  SMTP_PORT: z.coerce.number().int().positive().default(587),
  /** true = ต่อแบบ SSL ตรง (พอร์ต 465) · false = STARTTLS (พอร์ต 587) */
  SMTP_SECURE: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  /** ว่าง = ไม่ต้องยืนยันตัวตน (เช่น relay ภายใน) */
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  /** ช่อง From ที่ผู้รับเห็น — ต้องเป็นโดเมนที่ยิงได้จริง ไม่งั้นติด spam */
  SMTP_FROM: z.string().min(1).default('2docx.com <no-reply@2docx.com>'),
  /**
   * ชื่อที่จะเขียนทับลง metadata ของไฟล์ที่เรนเดอร์ออกมา
   *
   * ต้นฉบับที่ไม่ทำอะไรเลยจะได้:
   *   PDF  → /Producer = "LibreOffice 26.2.4.2"  /Creator = "Writer"
   *   DOCX → Application = "Microsoft Office Word"
   *   และที่แย่กว่านั้น — `dc:creator` ของแม่แบบ .docx จะรั่วมาทั้งฉบับ
   *   (ในของเราเจอชื่อจริงของผู้ทำแม่แบบปนอยู่ในทุกไฟล์ที่ส่งออก)
   *
   * เว้นว่าง = ปล่อยให้เป็นของเดิม
   */
  OUTPUT_BRAND: z.string().max(120).default('2docx.com'),

  // ── LLM (AI ช่วยกรอกฟอร์มใน Studio) ──────────────────────────
  /**
   * เจ้าของโมเดล — `minimax` | `openai` (OpenAI-compatible ทั่วไป) | `mock`
   *
   * ⚠️ `mock` ไม่เรียกเครือข่ายเลย ใช้ตอน dev/ทดสอบ pipeline
   *    โดยเดา data จากชื่อฟิลด์ที่มีอยู่ (ไม่ใช่ AI จริง)
   *    เปลี่ยนเป็น `minimax` เมื่อตั้ง LLM_API_KEY แล้ว
   */
  LLM_PROVIDER: z.enum(['minimax', 'openai', 'mock']).default('mock'),
  /**
   * base URL แบบ OpenAI-compatible
   * MiniMax (นอกประเทศ) = `https://api.minimax.io/v1`
   * MiniMax (จีน)        = `https://api.minimaxi.com/v1`
   * OpenAI               = `https://api.openai.com/v1`
   *
   * เว้นว่าง = ใช้ค่าเริ่มต้นของ provider ที่เลือก
   */
  LLM_BASE_URL: optionalUrl,
  /** เว้นว่าง = provider ยังไม่พร้อมใช้งาน (API จะตอบ 503 พร้อมเหตุผล) */
  LLM_API_KEY: z.string().optional(),
  LLM_MODEL: z.string().default('MiniMax-M3'),
  LLM_TIMEOUT_MS: z.coerce.number().int().positive().default(120_000),
  LLM_TEMPERATURE: z.coerce.number().min(0).max(2).default(0.2),
  /**
   * MiniMax M3 เปิด "คิด" โดยค่าเริ่มต้น ซึ่งช้ากว่าหลายเท่าเมื่อต้องการแค่เติมค่าในฟอร์ม
   * ปิดไว้เป็น `disabled` แล้วผู้ใช้จะได้คำตอบทันที
   * provider อื่นไม่รู้จัก field นี้ — ส่งไปก็ไม่อันตราย
   */
  LLM_THINKING: z.enum(['auto', 'disabled']).default('disabled'),
  /** จำกัดความยาวคำตอบ token */
  LLM_MAX_TOKENS: z.coerce.number().int().positive().default(2000),

  /**
   * ผู้ที่จะเห็นรายงานปัญหาที่ผู้ใช้ส่งมา — คั่นด้วย `,` (ค่าของ Casdoor คือ `sub`)
   *
   * เว่นว่าง = ปิดฟีเจอร์รายงานปัญหาทั้งหมด
   *   ปุ่ม "รายงานปัญหา" จะไม่โผล่ที่ไหน และหน้า `/reports` จะตอบ 403 ให้ทุกคน
   *   เหตุผลที่เว้นว่างแล้วปิด ไม่ใช่แค่ไม่มีใครมาดู — ถ้ามีรายงานแล้วไม่มีคนอ่าน
   *   ผู้ใช้จะกดแล้วเห็น "ส่งแล้ว" แต่เราไม่เห็น ซึ่งแย่กว่าไม่มีปุ่ม
   *
   * ⚠️ ผู้ส่งรายงานเป็นคนอื่นได้ทุกคน (ไม่ต้องอยู่ในรายชื่อนี้)
   *   รายชื่อนี้คือ "ใครเป็นผู้ดูแล" ไม่ใช่ "ใครขอรายงานได้"
   *   เพราะการจำกัดผู้ส่งจะทำให้ผู้ใช้ที่เจอปัญหาจริงพึ่งทางลัดไม่ได้
   *   ซึ่งแปลว่าปัญหาจะถูกเก็บไว้เงียบ ๆ ซึ่งแย่กว่าปล่อยให้ส่ง
   */
  REPORT_TO_SUBS: z.string().default(''),
})

const parsed = schema.safeParse(process.env)

if (!parsed.success) {
  // พิมพ์ให้อ่านรู้เรื่อง — ไม่งั้น error จะเป็นก้อน JSON ยาว ๆ
  const issues = parsed.error.issues
    .map((i) => `  • ${i.path.join('.')}: ${i.message}`)
    .join('\n')

  console.error(
    [
      '',
      '✖ ตั้งค่า environment ไม่ถูกต้อง',
      '',
      issues,
      '',
      '  ตรวจไฟล์ .env — ดูไฟล์ .env.example เป็นต้นแบบ',
      '',
    ].join('\n'),
  )
  process.exit(1)
}

export const env = parsed.data

/** CORS แยกเป็น array — เก็บเป็น string เดียวใช้ยาก */
export const corsOrigins = env.CORS_ORIGINS.split(',')
  .map((s) => s.trim())
  .filter(Boolean)

/**
 * ผู้ที่ได้รับรายงานปัญหา — ตัดตัวคั่นออก ตัวว่างทิ้ง และตัดซ้ำให้ด้วย
 *
 * ⚠️ ต้องคืนค่าเป็น array ใหม่ทุกครั้ง ไม่ใช่ cache ไว้เป็นตัวแปรคงที่
 *   ถ้าเก็บเป็น array ที่สร้างครั้งเดียวแล้วส่งต่อ ใครก็แก้ค่าในนั้นได้
 *   (เช่น push เพิ่ม) → รายชื่อผู้รับจะโตเงียบ ๆ ระหว่างที่โปรเซสยังรันอยู่
 */
export function reportReceivers(): string[] {
  return [...new Set(env.REPORT_TO_SUBS.split(',').map((s) => s.trim()).filter(Boolean))]
}

/**
 * ตัวเลือกสำหรับ `nats.connect()`
 *
 * ⚠️ nats.js 2.x ไม่ parse userinfo (`nats://app:pass@host:4222`) จาก server URL
 *    — `ServerImpl` เก็บแค่ hostname/port แล้วทิ้ง credential ทิ้งไป
 *    ผลลัพธ์คือ server ตอบกลับ `Authorization Violation` และ log ว่า `User ""`
 *    ต้องแยก user/pass มาส่งเป็น option เองเท่านั้น
 */
export function natsServers(raw = env.NATS_URL): {
  servers: string[]
  user: string
  pass: string
} {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error(
      `NATS_URL ต้องเป็น URL ที่ parse ได้ (เช่น nats://app:pass@host:4222) — ได้: ${raw}`,
    )
  }

  const user = decodeURIComponent(url.username)
  const pass = decodeURIComponent(url.password)
  if (!user || !pass) {
    throw new Error(
      'NATS_URL ต้องมี user:pass ใน URL — ' +
        'nats.js 2.x ไม่ดึง credential จาก URL ให้ ต้องใส่ให้ครบ',
    )
  }

  // ตัด credential ออก เหลือ scheme + host + port
  const bare = `${url.protocol}//${url.host}`
  return { servers: [bare], user, pass }
}
