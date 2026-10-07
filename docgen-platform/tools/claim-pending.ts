/**
 * ตัวช่วยเทสต์ — จำลอง "ผู้ใช้เข้าสู่ระบบ" หนึ่งครั้ง
 *
 *   node_modules\.bin\tsx.cmd tools/claim-pending.ts <sub> <email> <name>
 *   → พิมพ์จำนวนทีมที่ผูกสำเร็จ
 *
 * ⚠️ เรียก `claimPendingInvites()` **ของจริง** ไม่ใช่แก้ Mongo เอง
 *   เทสต์ที่จำลองผลในฐานข้อมูลเอง จะผ่านแม้ฟังก์ชันพัง
 *   และจุดที่เรียกจริงคือ callback ของ Casdoor ซึ่งเทสต์ยิงไม่ได้
 *   (ต้องมี Casdoor จริง) → ต้องเรียกตรงฟังก์ชันแทน
 */
import { MongoClient } from 'mongodb'
import { resolveMongoUrl } from '@docgen/shared'
import { claimPendingInvites } from '../apps/api/src/modules/teams/service.js'

const [sub, email, name] = process.argv.slice(2)
if (!sub || !email) {
  console.error('ใช้: tsx tools/claim-pending.ts <sub> <email> [name]')
  process.exit(2)
}

const client = new MongoClient(await resolveMongoUrl(() => {}))
await client.connect()
try {
  const claimed = await claimPendingInvites(
    // ใช้แค่ `mongo` กับ `log` — `claimPendingInvites` ไม่แตะอย่างอื่น
    { mongo: client.db(process.env.MONGO_DB ?? 'app'), log: { info() {}, warn() {} } },
    { sub, email, name: name ?? email },
  )
  process.stdout.write(String(claimed))
} finally {
  await client.close()
}
