export { env, corsOrigins, natsServers } from './env.js'
export { resolveMongoUrl } from './mongo.js'
export {
  AppError,
  NotFoundError,
  ConflictError,
  ValidationError,
  UpstreamError,
  type AppErrorCode,
} from './errors.js'
export * from './schemas.js'
export * from './studio.js'
export { normalizeThaiAlignment, type NormalizeResult } from './normalize.js'
export { setDocxThaiLanguage, type SetLanguageResult } from './docx-lang.js'

/** ตัวช่วยเล็ก ๆ ที่ใช้ทั้ง API และ worker */
export const now = (): Date => new Date()

/** สร้าง id สั้น ๆ — ถ้าอยากใช้ ULID เปลี่ยนที่นี่ที่เดียว */
export function newId(prefix = ''): string {
  const rand = crypto.randomUUID().replace(/-/g, '').slice(0, 20)
  return prefix ? `${prefix}_${rand}` : rand
}
