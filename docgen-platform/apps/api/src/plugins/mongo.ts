import fp from 'fastify-plugin'
import { MongoClient, type Db } from 'mongodb'
import { env, resolveMongoUrl } from '@docgen/shared'

declare module 'fastify' {
  interface FastifyInstance {
    mongo: Db
  }
}

export const mongoPlugin = fp(async (app) => {
  // ตอนรันบน host ตรง ๆ ต้องหา primary ก่อน — directConnection จะ pin ที่ node เดียว
  // ถ้าเป็น SECONDARY การเขียนตอน boot (createIndexes) จะได้ "not primary"
  const url = await resolveMongoUrl((msg, meta) => app.log.info({ ...meta }, msg))

  const client = new MongoClient(url, {
    // serverSelectionTimeoutMS สั้น ๆ ไว้ fail เร็วตอน boot
    // แทนที่จะรอไปเรื่อย ๆ ตอนมี request เข้ามา
    serverSelectionTimeoutMS: 10_000,
  })

  try {
    await client.connect()
  } catch (err) {
    app.log.error(
      { err, url: url.replace(/\/\/[^@]*@/, '//***@') },
      'ต่อ MongoDB ไม่ได้',
    )
    throw err
  }

  const db = client.db(env.MONGO_DB)

  /**
   * ลบ index ที่เปลี่ยนนิยามไปแล้ว — `createIndexes` จะไม่แก้ของเดิมให้
   *   จะพ่น `IndexKeySpecsConflict` (code 85) แล้วบูตไม่ขึ้น
   *   `dropIndex` คืน error ถ้าไม่มีอยู่จริง → กลืนทิ้งได้
   */
  const dropIndex = async (collection: string, name: string) => {
    try {
      await db.collection(collection).dropIndex(name)
      app.log.info({ collection, index: name }, 'ลบ index เก่าที่นิยามไม่ตรงแล้ว')
    } catch {
      // ไม่มี index นี้อยู่แล้ว = ปกติ
    }
  }

  // เช็คว่า replica set ทำงานจริง — ถ้าเป็น standalone
  // transaction จะใช้ไม่ได้แต่จะไม่รู้ตัวจนกว่าจะพังตอน runtime
  const hello = await db.admin().command({ hello: 1 })
  if (!hello.setName) {
    app.log.warn(
      'MongoDB ที่ต่ออยู่ไม่ใช่ replica set — ' +
        'transaction และ change stream ใช้ไม่ได้ ' +
        '(ถ้าเป็น dev เฉย ๆ ไม่เป็นไร แต่ production ต้องแก้)',
    )
  } else {
    app.log.info({ set: hello.setName }, 'MongoDB replica set พร้อม')
  }

  // index ที่ต้องมีทุก collection — สร้างตอน boot ดีกว่าไปค่อยสร้างตอน query ช้า
  await db.collection('documents').createIndexes([
    { key: { status: 1, createdAt: -1 }, name: 'status_created' },
    { key: { templateId: 1, createdAt: -1 }, name: 'template_created' },
    // ทุก query หลัง auth กรองด้วย createdBy เสมอ → ต้องมี index
    { key: { createdBy: 1, createdAt: -1 }, name: 'owner_created' },
  ])

  // ── collection ของฟีเจอร์ Studio ────────────────────────────
  // form_schemas / template_access ใช้ templateKey เป็น _id เลย
  // → upsert ได้โดยไม่ต้องมี index เพิ่ม (Mongo ใช้ _id เป็น key อยู่แล้ว)
  //
  // user_settings ก็แบบเดียวกัน — ใช้ sub ของผู้ใช้เป็น _id (หนึ่งคนมีแถวเดียว)
  //   ถ้าวันหลังเพิ่ม "ประวัติการแก้ค่าตั้งค่า" ค่อยมาเพิ่ม index ตอนนั้น
  await db.collection('chat_sessions').createIndexes([
    { key: { user: 1, updatedAt: -1 }, name: 'user_updated' },
    { key: { user: 1, templateKey: 1, updatedAt: -1 }, name: 'user_template_updated' },
  ])
  await db.collection('bookmarks').createIndexes([
    { key: { user: 1, createdAt: -1 }, name: 'user_created' },
    // กดบุ๊กมาร์กซ้ำต้องไม่เพิ่มซ้ำ → unique ต่อ user+template
    { key: { user: 1, templateKey: 1 }, name: 'user_template_unique', unique: true },
  ])
  await db.collection('template_access').createIndexes([
    { key: { owner: 1 }, name: 'owner' },
    { key: { 'sharedWith.sub': 1 }, name: 'shared_with' },
  ])
  /**
   * ถังขยะแม่แบบ — ตัวกวาด query `purgeAt <= now` ทุก 15 นาที
   * ไม่มี index = สแกนทั้ง collection ทุกรอบ (ถึงตอนนี้เล็ก แต่จะโตเมื่อมีการลบจริง)
   */
  await db.collection('template_tombstones').createIndexes([
    { key: { purgeAt: 1 }, name: 'purge_at' },
    { key: { deletedBy: 1, deletedAt: -1 }, name: 'deleted_by' },
  ])

  /**
   * กล่องจดหมาย (inbox) — ทุก query กรองด้วย `user` ของผู้เรียกเสมอ
   *
   * ⚠️ index ต้องขึ้นต้นด้วย `user` เสมอ ไม่ใช่แค่ index แยกทีละฟิลด์
   *   ถ้าไม่มี ทุกครั้งที่เปิดกล่องจดหมายจะสแกนจดหมายของ**ทุกคน**ทั้ง collection
   *   (แย่กว่าที่คิด เพราะ collection เดียวกันเก็บข้อความของผู้ใช้ทุกคน)
   */
  await db.collection('notifications').createIndexes([
    { key: { user: 1, at: -1 }, name: 'user_at' },
    // นับเฉพาะที่ยังไม่อ่าน (ทำป้ายบนกระดิ่ง 🔔) → ต้องมี `read` ต่อด้วย
    { key: { user: 1, read: 1, at: -1 }, name: 'user_unread_at' },
  ])

  // ── ระบบทีม ────────────────────────────────────────────────
  /**
   * `team_members` — หัวใจของระบบทีม
   *
   * ⚠️ `unique` ต่อ (team, sub) คือกันไม่ให้คนเดียวอยู่ในทีมเดียวสองแถว
   *   ถ้าไม่มี การเชิญซ้ำจะกลายเป็นสมาชิกสองคน → นับผิด และลดสิทธิ์อาจพัง
   *   (เจอจริงตอนทดสอบ: เรียก `addMember` ซ้ำด้วยคนเดิม)
   *
   * ⚠️ **ต้องเป็น partial index** เพราะเชิญด้วยอีเมล = แถวที่ยังไม่มี `sub` (`sub: null`)
   *   ถ้าไม่ใส่ partial → `null` ซ้ำกันในทีมเดียวได้แค่แถวเดียว
   *   = เชิญคนที่สองด้วยอีเมลแล้วพังทันที
   */
  // index เดิมเป็น unique ทั้งก้อน → ต้องทิ้งก่อน ไม่งั้นของเก่ายังบังคับ `sub: null` ไว้
  await dropIndex('team_members', 'team_sub_unique')
  await db.collection('team_members').createIndexes([
    {
      key: { team: 1, sub: 1 },
      name: 'team_sub_unique',
      unique: true,
      partialFilterExpression: { sub: { $type: 'string' } },
    },
    // กันเชิญอีเมลเดิมซ้ำในทีมเดียว (คนละแถวกับ sub) — กันนับสมาชิกเกินจริง
    {
      key: { team: 1, email: 1 },
      name: 'team_email_unique',
      unique: true,
      partialFilterExpression: { email: { $type: 'string' } },
    },
    // หน้า "ทีมของฉัน" กรองด้วย sub เสมอ
    { key: { sub: 1 }, name: 'sub' },
    // ตอนเข้าสู่ระบบ: หาแถวที่รอผูกด้วยอีเมลของตัวเอง (ข้ามทีม)
    { key: { email: 1 }, name: 'email' },
    // นับ owner ก่อนลดสิทธิ์ (กัน owner คนสุดท้ายหลุดสิทธิ์)
    { key: { team: 1, role: 1 }, name: 'team_role' },
  ])
  /**
   * `template_access.team` — แม่แบบของทีม
   *
   * ใช้นับแม่แบบของทีม (ป้ายในหน้ารายการทีม) และถอน `team` เวลาลบทีม
   * แม่แบบที่ยังไม่มีทีม = `team: null` → index นี้ครอบทั้งสองกรณี
   */
  await db.collection('template_access').createIndexes([
    { key: { team: 1 }, name: 'team' },
    { key: { owner: 1 }, name: 'owner' },
    { key: { 'sharedWith.sub': 1 }, name: 'shared_with' },
  ])

  /**
   * รายงานปัญหาจากผู้ใช้
   *
   * หน้า `/reports` เปิดด้วย `sort({ createdAt: -1 }).limit(200)`
   * → ถ้าไม่มี index นี้จะสแกนทั้ง collection ทุกครั้งที่เปิดหน้า
   * (และ collection นี้โตเร็วเป็นพิเศษ เพราะเปิดส่งได้โดยไม่ต้องเป็นผู้ดูแล)
   */
  await db.collection('issue_reports').createIndexes([
    { key: { createdAt: -1 }, name: 'created' },
    // ทำป้าย "ยังค้างอยู่ N" — นับเฉพาะที่ยังไม่ได้ปิด
    { key: { resolvedAt: 1 }, name: 'resolved' },
  ])

  app.decorate('mongo', db)

  app.addHook('onClose', async () => {
    await client.close()
  })

  app.log.info({ db: env.MONGO_DB }, 'MongoDB เชื่อมต่อแล้ว')
})
