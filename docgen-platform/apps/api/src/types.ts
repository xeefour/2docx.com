import type {
  FastifyInstance,
  FastifyBaseLogger,
  RawReplyDefaultExpression,
  RawRequestDefaultExpression,
  RawServerDefault,
} from 'fastify'
import type { ZodTypeProvider } from '@fastify/type-provider-zod'

/**
 * FastifyInstance ที่ผูก Zod type provider แล้ว
 * ใช้แทน FastifyInstance ปกติในไฟล์ route/service
 * ไม่งั้น req.body / req.params / req.query จะเป็น `unknown`
 */
export type App = FastifyInstance<
  RawServerDefault,
  RawRequestDefaultExpression,
  RawReplyDefaultExpression,
  FastifyBaseLogger,
  ZodTypeProvider
>
