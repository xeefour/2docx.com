/**
 * `/api/teams` — ระบบทีม
 *
 * ⚠️ ไม่ลงทะเบียนใน `PUBLIC` ที่ `app.ts` — ต้องมี session เสมอ
 */
import { z } from 'zod/v4'
import {
  AddMemberBody,
  CreateTeamBody,
  ErrorResponse,
  MemberRef,
  TeamAccess,
  TeamDetail,
  TeamMember,
  UpdateMemberBody,
  UpdateTeamBody,
} from '@docgen/shared'
import type { App } from '../../types.js'
import {
  addMember,
  createTeam,
  deleteTeam,
  getTeam,
  listMyTeams,
  removeMember,
  renameTeam,
  updateMember,
} from './service.js'

const tags = ['teams']

// ── schema ย่อยที่ใช้ซ้ำหลาย route ────────────────────────────
const IdParam = z.object({ id: z.string().min(1).max(120) })
/**
 * `:who` = `sub` ของผู้ใช้จริง **หรือ** อีเมลของคนที่ยังรอผูก
 * (คนที่ยังไม่เคยเข้าระบบไม่มี `sub` — ดู `resolveMember` ใน service)
 */
const IdWhoParam = z.object({ id: z.string().min(1).max(120), who: MemberRef })

export async function teamRoutes(app: App) {
  /** ทีมของฉันทั้งหมด พร้อม role และจำนวนสมาชิก/แม่แบบ */
  app.get(
    '/teams',
    {
      schema: {
        tags,
        summary: 'ทีมที่ฉันอยู่',
        // ⚠️ ต้องห่อด้วย `z.object` — ถ้าใส่ `{ items: ... }` เปล่า ๆ Fastify จะ
        //    มองเป็น JSON schema แล้วล้มตอน serialize (FST_ERR_INVALID_SCHEMA → 500)
        //    เจอตอนทดสอบ: ทีมว่าง ๆ แล้ว 500 ทั้งที่มีทีมจริง
        response: { 200: z.object({ items: TeamAccess.array() }), 401: ErrorResponse },
      },
    },
    async (req) => ({ items: await listMyTeams(app, req) }),
  )

  /** สร้างทีม — ผู้เรียกเป็นเจ้าของอัตโนมัติ */
  app.post(
    '/teams',
    {
      schema: {
        tags,
        summary: 'สร้างทีมใหม่',
        description: 'ผู้สร้างเป็น "เจ้าของทีม" อัตโนมัติ และเป็นเจ้าของคนแรกเสมอ',
        body: CreateTeamBody,
        response: { 201: TeamDetail, 422: ErrorResponse, 400: ErrorResponse, 401: ErrorResponse },
      },
    },
    async (req, reply) => reply.code(201).send(await createTeam(app, req, req.body)),
  )

  /**
   * รายละเอียดทีม + รายชื่อสมาชิก
   *
   * คนนอกทีมอ่านได้ (เห็น `myRole: null`) เพื่อให้รู้ว่าทีมนี้มีอยู่จริง
   * ตอนย้ายแม่แบบเข้าทีมจะได้เลือกชื่อทีมจากรายการนี้
   */
  app.get(
    '/teams/:id',
    {
      schema: {
        tags,
        summary: 'รายละเอียดทีมและสมาชิก',
        params: IdParam,
        response: { 200: TeamDetail, 401: ErrorResponse, 404: ErrorResponse },
      },
    },
    async (req) => getTeam(app, req, req.params.id),
  )

  /** เปลี่ยนชื่อทีม — admin ขึ้นไป */
  app.patch(
    '/teams/:id',
    {
      schema: {
        tags,
        summary: 'เปลี่ยนชื่อทีม',
        params: IdParam,
        body: UpdateTeamBody,
        response: { 200: z.object({ name: z.string() }), 401: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse },
      },
    },
    async (req) => renameTeam(app, req, req.params.id, req.body.name ?? ''),
  )

  /**
   * ลบทีม — เจ้าของเท่านั้น
   *
   * แม่แบบของทีมจะถูก**ถอนออกจากทีม** ไม่ถูกลบ
   * (กลับเป็นของคนที่อัปโหลด) — ดูเหตุผลที่ `deleteTeam`
   */
  app.delete(
    '/teams/:id',
    {
      schema: {
        tags,
        summary: 'ลบทีม',
        description: 'แม่แบบของทีมจะถูกถอนออก ไม่ถูกลบทิ้ง',
        params: IdParam,
        response: {
          200: z.object({
            templatesReleased: z.number().int(),
            /** บุ๊กมาร์กที่ถูกคืนเป็นส่วนตัว เพราะชี้ไปทีมที่กำลังถูกลบ */
            bookmarksReleased: z.number().int(),
          }),
          401: ErrorResponse,
          403: ErrorResponse,
          404: ErrorResponse,
        },
      },
    },
    async (req) => deleteTeam(app, req, req.params.id),
  )

  /** เชิญสมาชิกเข้าทีม — admin ขึ้นไป · ใส่**อีเมล** ไม่ใช่ `sub` */
  app.post(
    '/teams/:id/members',
    {
      schema: {
        tags,
        summary: 'เชิญสมาชิกด้วยอีเมล',
        description: [
          'คนที่ยังไม่เคยเข้าระบบจะถูกเก็บเป็น "รอผูก" แล้วเข้าทีมอัตโนมัติตอนเข้าสู่ระบบครั้งแรก',
          'เชิญอีเมลเดิมซ้ำ = เปลี่ยน role ของแถวเดิม ไม่ใช่เพิ่มคนใหม่',
          '⚠️ ใช้ `role: owner` เพื่อเลื่อนเจ้าของคนใหม่ **ไม่ได้** — ต้องใช้ `PATCH` แทน',
        ].join('\n'),
        params: IdParam,
        body: AddMemberBody,
        response: {
          200: TeamMember,
          // 422 = Zod ไม่ผ่าน (อีเมลผิดรูปแบบ) · เป็นข้อตกลงของทั้งระบบ ดู setErrorHandler
          422: ErrorResponse,
          401: ErrorResponse,
          403: ErrorResponse,
          404: ErrorResponse,
        },
      },
    },
    async (req) => addMember(app, req, req.params.id, req.body),
  )

  /** เลื่อนสิทธิ์ — นี่คือทางเดียวที่ตั้ง `owner` ใหม่ได้ */
  app.patch(
    '/teams/:id/members/:who',
    {
      schema: {
        tags,
        summary: 'เปลี่ยนสิทธิ์สมาชิก',
        description: 'ทีมต้องมีเจ้าของอย่างน้อย 1 คนเสมอ — ลด role คนสุดท้ายไม่ได้',
        params: IdWhoParam,
        body: UpdateMemberBody,
        response: { 200: TeamMember, 401: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse },
      },
    },
    async (req) => updateMember(app, req, req.params.id, req.params.who, req.body.role),
  )

  /** ถอนสมาชิก — owner คนสุดท้ายออกไม่ได้ */
  app.delete(
    '/teams/:id/members/:who',
    {
      schema: {
        tags,
        summary: 'ถอนสมาชิกออกจากทีม',
        params: IdWhoParam,
        response: { 204: z.null(), 401: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse },
      },
    },
    async (req, reply) => {
      await removeMember(app, req, req.params.id, req.params.who)
      // ⚠️ 204 ห้ามมี body — ต้องส่ง `null` ไม่ใช่เรียก `send()` เปล่า
      //   (Fastify แบบ Zod type provider ไม่ยอมรับ send() ที่ไม่มี argument)
      return reply.code(204).send(null)
    },
  )
}
