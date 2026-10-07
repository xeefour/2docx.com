import { z } from 'zod/v4'
import {
  ErrorResponse,
  FieldDef,
  SetAccessBody,
  ShareBody,
  ChatBody,
  InterviewPlanBody,
  InterviewPlanReply,
  InterviewComposeBody,
  InterviewComposeReply,
  CreateBookmarkBody,
  LlmStatus,
  AccessView,
  BookmarkRecord,
  ChatSession,
  TemplateHistory,
  MyTemplateHistory,
  MyHistoryQuery,
  NotificationKind,
  InboxQuery,
  InboxList,
} from '@docgen/shared'
import type { App } from '../../types.js'
import { readTemplateTags } from '../templates/tags.js'
import { llmStatus } from './llm.js'
import { planInterview, composeInterview } from './interview.js'
import {
  getFormSchema,
  saveFormSchema,
  importTagsToForm,
  deleteFormSchema,
  getAccessView,
  setVisibility,
  setTemplateTeam,
  addShare,
  removeShare,
  deleteAccess,
  resolveAccess,
  listChatSessions,
  getChatSession,
  deleteChatSession,
  chat,
  listBookmarks,
  addBookmark,
  removeBookmark,
  templateHistory,
  myTemplateHistory,
} from './service.js'
import {
  listInbox,
  markRead,
  markAllRead,
  deleteNotification,
  clearInbox,
} from './notifications.js'

/**
 * route ของฟีเจอร์ Studio ทั้งชุด — ตั้งใจรวมไว้ที่ไฟล์เดียว
 * เพราะทุกอันผูกกับ "แม่แบบหนึ่งตัว" เหมือนกัน และการแยกไฟล์เยอะ
 * จะทำให้ต้องเปิดหลายไฟล์เพื่อดูว่าอะไรเรียกอะไร
 *
 * ⚠️ path ที่เป็นตัวอักษรควรประกาศก่อน path ที่มีพารามิเตอร์
 *    เช่น `/access/resolve` ต้องมาก่อน `/access/:key`
 *    (Fastify ให้ความสำคัญกับ static segment มากกว่าอยู่แล้ว
 *     แต่เขียน static ก่อนไว้ทำให้อ่านง่ายและไม่ต้องเดา)
 */
export async function studioRoutes(app: App) {
  const tags = ['studio']

  // ── สถานะ LLM ───────────────────────────────────────────────
  // หน้าเว็บเอาไปบอกว่า "ตอนนี้ใช้โมเดลอะไร / ตั้งค่าแล้วหรือยัง"
  app.get(
    '/llm/status',
    { schema: { tags, summary: 'สถานะผู้ช่วย AI', response: { 200: LlmStatus, 500: ErrorResponse } } },
    async () => llmStatus(),
  )

  // ── ฟอร์ม (ฟิลด์ที่ผู้ใช้ออกแบบเอง) ─────────────────────────
  app.get(
    '/form/:key',
    {
      schema: {
        tags,
        summary: 'ฟอร์มที่ตั้งไว้ของแม่แบบนี้',
        params: z.object({ key: z.string().min(1).max(200) }),
        response: {
          200: z.object({
            templateKey: z.string(),
            fields: z.array(FieldDef),
            updatedAt: z.date().nullable(),
          }),
          500: ErrorResponse,
        },
      },
    },
    async (req) => {
      const form = await getFormSchema(app, req.params.key)
      return {
        templateKey: req.params.key,
        fields: form?.fields ?? [],
        updatedAt: form?.updatedAt ?? null,
      }
    },
  )

  app.put(
    '/form/:key',
    {
      schema: {
        tags,
        summary: 'บันทึกฟอร์มของแม่แบบ',
        description: [
          'ฟิลด์ต้องตรงกับแท็ก `{d.…}` ในไฟล์แม่แบบ ไม่งั้น Carbone จะไม่แทนค่าให้',
          'รองรับ path แบบ nested ด้วยจุด เช่น `ผู้รับ.ชื่อ`',
        ].join('\n'),
        params: z.object({ key: z.string().min(1).max(200) }),
        body: z.object({ fields: z.array(FieldDef).max(200) }),
        response: { 200: z.object({ templateKey: z.string(), fields: z.array(FieldDef) }), 403: ErrorResponse, 500: ErrorResponse },
      },
    },
    async (req) => {
      const doc = await saveFormSchema(
        app,
        { templateKey: req.params.key, fields: req.body.fields },
        req,
      )
      return { templateKey: doc.templateKey, fields: doc.fields }
    },
  )

  // ⚠️ ต้องประกาศก่อน `/form/:key` ไม่งั้น "import-tags" จะถูกมองเป็น :key
  app.post(
    '/form/:key/import-tags',    {
      schema: {
        tags,
        summary: 'สร้างฟิลด์อัตโนมัติจากแท็กที่แม่แบบใช้จริง',
        description: [
          'อ่านแท็ก `{d.*}` จากไฟล์แม่แบบ แล้วสร้างช่องข้อความให้ครบ',
          'ช่องที่มีอยู่แล้วจะไม่ถูกเพิ่มซ้ำ และของเดิมจะไม่ถูกทับ',
        ].join('\n'),
        params: z.object({ key: z.string().min(1).max(200) }),
        body: z.object({ versionId: z.string().min(1).max(200) }),
        response: { 200: z.object({ templateKey: z.string(), fields: z.array(FieldDef) }), 403: ErrorResponse, 500: ErrorResponse },
      },
    },
    async (req) => {
      const tags = await readTemplateTags(req.body.versionId)
      const doc = await importTagsToForm(
        app,
        {
          templateKey: req.params.key,
          versionId: req.body.versionId,
          tags: tags.items.map((t) => t.path),
        },
        req,
      )
      return { templateKey: doc.templateKey, fields: doc.fields }
    },
  )

  // ⚠️ ลบต้องมาก่อน GET/PUT `/form/:key`? ไม่ต้อง — method ต่างกัน
  //    แต่ใส่ไว้ติดกันเพื่อให้อ่านเป็นชุดเดียวกัน
  app.delete(
    '/form/:key',
    {
      schema: {
        tags,
        summary: 'ล้างฟอร์มที่ตั้งไว้ (กลับไปใช้ช่องจากแท็กอัตโนมัติ)',
        params: z.object({ key: z.string().min(1).max(200) }),
        response: { 204: z.null(), 403: ErrorResponse, 500: ErrorResponse },
      },
    },
    async (req, reply) => {
      await deleteFormSchema(app, req.params.key, req)
      return reply.code(204).send(null)
    },
  )

  // ── การแชร์ ───────────────────────────────────────────────
  // ⚠️ static มาก่อน param
  app.post(
    '/access/resolve',
    {
      schema: {
        tags,
        summary: 'สิทธิ์ของฉันต่อหลายแม่แบบพร้อมกัน',
        body: z.object({ keys: z.array(z.string().min(1).max(200)).max(200) }),
        response: { 200: z.record(z.string(), AccessView), 500: ErrorResponse },
      },
    },
    async (req) => resolveAccess(app, req.body.keys, req),
  )

  app.get(
    '/access/:key',
    {
      schema: {
        tags,
        summary: 'สิทธิ์ของฉันต่อแม่แบบนี้',
        params: z.object({ key: z.string().min(1).max(200) }),
        response: { 200: AccessView, 500: ErrorResponse },
      },
    },
    async (req) => getAccessView(app, req.params.key, req),
  )

  app.put(
    '/access/:key',
    {
      schema: {
        tags,
        summary: 'ตั้งค่า publish / private',
        description: [
          'คนแรกที่เรียกเส้นทางนี้ของแม่แบบนั้นจะกลายเป็นเจ้าของ',
          'หลังจากนั้นมีแต่เจ้าของ (หรือผู้ที่ถูกแชร์สิทธิ์ editor) เท่านั้นที่เปลี่ยนได้',
        ].join('\n'),
        params: z.object({ key: z.string().min(1).max(200) }),
        body: z.object({ visibility: z.enum(['private', 'published']) }),
        response: { 200: AccessView, 403: ErrorResponse, 500: ErrorResponse },
      },
    },
    async (req) => setVisibility(app, { templateKey: req.params.key, visibility: req.body.visibility }, req),
  )

  /**
   * ย้ายแม่แบบเข้า/ออกทีม
   *
   * `team: null` = ถอนออกจากทีม กลับเป็นของคนเดิม
   *
   * ⚠️ ย้าย**เข้า**ทีมจะบังคับเป็น private เสมอ
   *   เพราะกติกาเดิม "published = ทุกคนแก้ได้" ถ้าคงสาธารณไว้
   *   แม่แบบของทีมจะยังถูกแก้โดยคนนอกทีมได้ → ทีมไม่มีความหมาย
   */
  app.put(
    '/access/:key/team',
    {
      schema: {
        tags,
        summary: 'ย้ายแม่แบบเข้า/ออกทีม',
        description: [
          '**เข้าทีม** — เจ้าของแม่แบบ หรือผู้ดูแลทีมปลายทาง (กรณีแม่แบบยังไม่มีเจ้าของ)',
          '**ออกจากทีม** — เจ้าของแม่แบบ หรือผู้ดูแลทีมเดิม',
          '',
          'ย้ายเข้าทีมแล้ว `visibility` จะเป็น `private` โดยอัตโนมัติ',
        ].join('\n'),
        params: z.object({ key: z.string().min(1).max(200) }),
        body: z.object({ team: z.string().min(1).max(120).nullable() }),
        response: { 200: AccessView, 401: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse },
      },
    },
    async (req) => setTemplateTeam(app, { templateKey: req.params.key, team: req.body.team }, req),
  )

  app.post(
    '/access/:key/share',
    {
      schema: {
        tags,
        summary: 'อนุญาตให้คนอื่นใช้แม่แบบนี้',
        params: z.object({ key: z.string().min(1).max(200) }),
        body: ShareBody.omit({ templateKey: true }),
        response: { 200: AccessView, 403: ErrorResponse, 500: ErrorResponse },
      },
    },
    async (req) => addShare(app, { templateKey: req.params.key, ...req.body }, req),
  )

  app.delete(
    '/access/:key/share/:sub',
    {
      schema: {
        tags,
        summary: 'ถอนสิทธิ์ของคนหนึ่ง',
        params: z.object({ key: z.string().min(1).max(200), sub: z.string().min(1).max(200) }),
        response: { 200: AccessView, 403: ErrorResponse, 500: ErrorResponse },
      },
    },
    async (req) => removeShare(app, { templateKey: req.params.key, sub: req.params.sub }, req),
  )

  /**
   * ล้างการตั้งค่าการแชร์ทั้งหมด → กลับไปเป็น "เปิดสาธารณ แก้ได้ทุกคน" แบบเริ่มต้น
   *
   * ต้องเป็นเจ้าของเท่านั้น (เหมือนทุกเส้นทางของ access)
   */
  app.delete(
    '/access/:key',
    {
      schema: {
        tags,
        summary: 'ล้างการตั้งค่าการแชร์ทั้งหมด',
        params: z.object({ key: z.string().min(1).max(200) }),
        response: { 204: z.null(), 403: ErrorResponse, 500: ErrorResponse },
      },
    },
    async (req, reply) => {
      await deleteAccess(app, req.params.key, req)
      return reply.code(204).send(null)
    },
  )

  // ข้าวหลายแม่แบบทีเดียว — หน้ารายการถามครั้งเดียว ไม่งั้นเป็น N+1

  // ── ประวัติการสร้างเอกสารของแม่แบบ ──────────────────────────
  app.get(
    '/history/:key',
    {
      schema: {
        tags,
        summary: 'ใครใช้แม่แบบนี้บ้าง',
        description: [
          'มุมมองรวมทุกคน — ใช้ดูว่าแม่แบบนี้ถูกใช้แค่ไหน',
          '⚠️ ไม่คืนค่าที่กรอกไว้ เพราะเป็นข้อมูลส่วนตัวของผู้อื่น',
          'ถ้าจะกู้ค่ามาแก้ต่อ ใช้ `/history/:key/mine` แทน',
        ].join('\n'),
        params: z.object({ key: z.string().min(1).max(200) }),
        querystring: z.object({
          limit: z.coerce.number().int().min(1).max(100).default(30),
          /**
           * ข้ามกี่ฉบับ — ใช้แบ่งหน้า
           *
           * ⚠️ เพดานไว้ที่ 50,000 เพราะ `skip` ต้องไล่ทีละเอกสาร
           *    ถ้าไม่เพดาน ผู้ใช้พิมพ์ `?skip=99999999` แล้วค้างจน docserver ตาย
           *    (index `templateId + createdAt` รองรับอยู่แล้ว ไม่ต้องเพิ่ม)
           */
          skip: z.coerce.number().int().min(0).max(50_000).default(0),
        }),
        response: { 200: TemplateHistory, 500: ErrorResponse },
      },
    },
    async (req) =>
      templateHistory(app, req.params.key, { limit: req.query.limit, skip: req.query.skip }),
  )

  /**
   * ประวัติของฉันเอง — เอาค่าเดิมมาแก้ต่อได้
   *
   * ไม่ชนกับ `/history/:key` เพราะคนละจำนวน path segment
   * (2 กับ 3) — `find-my-way` จับได้ถูกต้องโดยไม่ต้องสนใจลำดับประกาศ
   */
  app.get(
    '/history/:key/mine',
    {
      schema: {
        tags,
        summary: 'ประวัติของฉันเอง (เอาค่าเดิมมาแก้ต่อได้)',
        description: [
          'คืนเฉพาะเอกสารที่ผู้เรียกสร้างเอง พร้อมค่าที่กรอกไว้ในครั้งนั้น',
          'เพื่อให้ "ค้นหาในประวัติ แล้วคลิกแก้ไข" ทำงานได้',
          '',
          '`?q=` ค้นทั้งชื่อฉบับและค่าที่กรอก (เช่น ชื่อผู้รับ)',
        ].join('\n'),
        params: z.object({ key: z.string().min(1).max(200) }),
        querystring: MyHistoryQuery,
        response: { 200: MyTemplateHistory, 401: ErrorResponse, 500: ErrorResponse },
      },
    },
    async (req) => myTemplateHistory(app, req.params.key, req.query, req),
  )

  // ── แชทกับ AI ────────────────────────────────────────────
  app.post(
    '/chat',
    {
      schema: {
        tags,
        summary: 'ให้ AI ช่วยเติมข้อมูลในฟอร์ม',
        description: [
          'ผู้ใช้พิมพ์เล่าความต้องการ → AI ตอบเป็น JSON ที่ merge กับข้อมูลเดิม',
          'ค่าที่ผู้ใช้กรอกเองจะไม่ถูกทับ',
          '',
          'ประวัติแชทถูกเก็บไว้ใน Mongo เพื่อกลับมาคุยต่อได้',
        ].join('\n'),
        body: ChatBody.extend({ provider: z.enum(['minimax', 'openai', 'mock']).optional() }),
        response: {
          200: z.object({
            sessionId: z.string(),
            reply: z.string(),
            data: z.record(z.string(), z.unknown()),
            changed: z.array(z.string()),
            provider: z.string(),
            model: z.string(),
          }),
          502: ErrorResponse,
          503: ErrorResponse,
        },
      },
    },
    async (req) => chat(app, req.body, req),
  )

  // ── สัมภาษณ์ผู้ใช้เพื่อกรอกฟอร์ม ─────────────────────────────────
  // ต่างจาก /chat ตรงที่**โมเดลเป็นคนถาม** ตามช่องที่ยังขาด
  //   แล้วเอาคำตอบมาเรียบเรียงเป็นค่าที่ช่องรับได้ (ตาม input property)
  app.post(
    '/interview/plan',
    {
      schema: {
        tags,
        summary: 'ขอคำถามชุดถัดไปจาก AI (สัมภาษณ์เพื่อกรอกฟอร์ม)',
        description: [
          'คืนคำถามเป็นช่อง ๆ ตามช่องที่ยังไม่มีค่า',
          'mode = one ถามทีละข้อ · batch ถามหลายข้อพร้อมกัน (ไม่เกิน batchSize)',
          'ส่ง answers ที่ผู้ใช้ตอบแล้วกลับไป เพื่อให้ AI ถามต่อโดยไม่ถามซ้ำ',
        ].join('\n'),
        body: InterviewPlanBody,
        response: { 200: InterviewPlanReply, 502: ErrorResponse, 503: ErrorResponse },
      },
    },
    async (req) => planInterview(app, req.body),
  )

  app.post(
    '/interview/compose',
    {
      schema: {
        tags,
        summary: 'เอาคำตอบของผู้ใช้มาเรียบเรียงเป็นค่าของแต่ละช่อง',
        description: [
          'แปลงคำตอบให้ตรงกับชนิดชอง (ตัวเลข/วันที่/ตัวเลือก/อีเมล) ฝั่งเซิร์ฟเวอร์',
          'ค่าที่ผู้ใช้กรอกเองจะไม่ถูกทับ (merge แบบเดียวกับ /chat)',
          'ข้อมูลที่โมเดลให้มาไม่ครบจะอยู่ใน skipped เพื่อให้ UI เตือนได้',
        ].join('\n'),
        body: InterviewComposeBody,
        response: { 200: InterviewComposeReply, 502: ErrorResponse, 503: ErrorResponse },
      },
    },
    async (req) => composeInterview(app, req.body),
  )

  app.get(
    '/chat/sessions',
    {
      schema: {
        tags,
        summary: 'รายการแชทของฉัน',
        querystring: z.object({ templateKey: z.string().max(200).optional() }),
        response: {
          200: z.object({
            items: z.array(
              z.object({
                _id: z.string(),
                templateKey: z.string(),
                title: z.string(),
                messageCount: z.number(),
                updatedAt: z.date(),
              }),
            ),
          }),
          500: ErrorResponse,
        },
      },
    },
    async (req) => ({ items: await listChatSessions(app, req.query.templateKey, req) }),
  )

  app.get(
    '/chat/sessions/:id',
    {
      schema: {
        tags,
        summary: 'ข้อความทั้งหมดของแชทหนึ่ง',
        params: z.object({ id: z.string().min(1) }),
        response: { 200: ChatSession, 404: ErrorResponse, 500: ErrorResponse },
      },
    },
    async (req) => getChatSession(app, req.params.id, req),
  )

  app.delete(
    '/chat/sessions/:id',
    {
      schema: {
        tags,
        summary: 'ลบแชท',
        params: z.object({ id: z.string().min(1) }),
        response: { 204: z.null(), 404: ErrorResponse, 500: ErrorResponse },
      },
    },
    async (req, reply) => {
      await deleteChatSession(app, req.params.id, req)
      return reply.code(204).send(null)
    },
  )

  // ── บุ๊กมาร์ก ────────────────────────────────────────────
  app.get(
    '/bookmarks',
    {
      schema: {
        tags,
        summary: 'บุ๊กมาร์กของฉัน',
        response: { 200: z.object({ items: z.array(BookmarkRecord) }), 500: ErrorResponse },
      },
    },
    async (req) => ({ items: await listBookmarks(app, req) }),
  )

  app.post(
    '/bookmarks',
    {
      schema: {
        tags,
        summary: 'เพิ่มบุ๊กมาร์ก',
        body: CreateBookmarkBody,
        response: { 200: BookmarkRecord, 500: ErrorResponse },
      },
    },
    async (req, reply) => reply.code(200).send(await addBookmark(app, req.body, req)),
  )

  app.delete(
    '/bookmarks/:key',
    {
      schema: {
        tags,
        summary: 'เอาบุ๊กมาร์กออก',
        params: z.object({ key: z.string().min(1).max(200) }),
        response: { 204: z.null(), 404: ErrorResponse, 500: ErrorResponse },
      },
    },
    async (req, reply) => {
      await removeBookmark(app, req.params.key, req)
      return reply.code(204).send(null)
    },
  )

  // ── กล่องจดหมาย (inbox) ─────────────────────────────────────────
  // ผู้ใช้สั่ง: *"เพิ่มกล่องจดหมาย inbox แบ่งประเภทของจดหมายด้วย"*
  //
  // ⚠️ ไม่ต้องใส่ preHandler เอง — app.ts บังคับล็อกอินทั้ง /api อยู่แล้ว
  //
  // ⚠️ path ที่เป็นตัวอักษร (`/read-all`) ต้องประกาศ**ก่อน** path ที่มีพารามิเตอร์
  //    ตามกติกาที่ตั้งไว้ที่หัวไฟล์นี้
  app.get(
    '/notifications',
    {
      schema: {
        tags,
        summary: 'เปิดกล่องจดหมาย',
        description: 'คืนรายการตามตัวกรอง + จำนวนที่ยังไม่อ่าน (รวมแยกตามประเภท) ในคำขอเดียว',
        querystring: InboxQuery,
        response: { 200: InboxList, 500: ErrorResponse },
      },
    },
    async (req) => listInbox(app, req, req.query),
  )

  app.post(
    '/notifications/read-all',
    {
      schema: {
        tags,
        summary: 'ทำเครื่องหมายว่าอ่านแล้วทั้งหมด',
        querystring: z.object({ kind: NotificationKind.optional() }),
        response: { 200: z.object({ updated: z.number() }), 500: ErrorResponse },
      },
    },
    async (req) => ({ updated: await markAllRead(app, req, req.query.kind) }),
  )

  app.post(
    '/notifications/:id/read',
    {
      schema: {
        tags,
        summary: 'ทำเครื่องหมายว่าอ่านแล้ว 1 ฉบับ',
        params: z.object({ id: z.string().min(1).max(100) }),
        response: { 204: z.null(), 404: ErrorResponse, 500: ErrorResponse },
      },
    },
    async (req, reply) => {
      await markRead(app, req, req.params.id)
      return reply.code(204).send(null)
    },
  )

  app.delete(
    '/notifications',
    {
      schema: {
        tags,
        summary: 'ล้างกล่องจดหมาย (ทั้งหมด หรือเฉพาะประเภท)',
        querystring: z.object({ kind: NotificationKind.optional() }),
        response: { 200: z.object({ deleted: z.number() }), 500: ErrorResponse },
      },
    },
    async (req) => ({ deleted: await clearInbox(app, req, req.query.kind) }),
  )

  app.delete(
    '/notifications/:id',
    {
      schema: {
        tags,
        summary: 'ลบจดหมาย 1 ฉบับ',
        params: z.object({ id: z.string().min(1).max(100) }),
        response: { 204: z.null(), 404: ErrorResponse, 500: ErrorResponse },
      },
    },
    async (req, reply) => {
      await deleteNotification(app, req, req.params.id)
      return reply.code(204).send(null)
    },
  )
}

