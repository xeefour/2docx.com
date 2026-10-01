import { MongoClient } from 'mongodb'
import { env } from './env.js'

/**
 * หา primary จริงของ replica set แล้วคืน URL ที่ชี้ไปหา node นั้น
 *
 * ปัญหาที่แก้: ตอนรันบน host ตรง ๆ (ไม่ใช่ใน Docker) ชื่อ `mongo-1` ที่ replica set
 * advertise ไว้ resolve ไม่ได้บน Windows → ต้องใช้ `directConnection=true`
 * แต่ directConnection จะ pin ที่ node ที่ระบุตลอดชีวิตของ connection
 * ถ้าตัวนั้นบังเอิญเป็น SECONDARY ทุกการเขียนจะได้ `not primary`
 * แล้วพังตอน boot (เจอตอน primary เปลี่ยนไปเป็น node อื่น)
 *
 * วิธีนี้คือลองไล่ candidate ที่ publish ออกมา หา node ที่ writable
 * แล้วชี้ URL ไปที่ node นั้น
 *
 * ข้อจำกัดที่ต้องรู้: หลังต่อแล้วยัง failover อัตโนมัติไม่ได้
 * ถ้า primary เปลี่ยนอีกรอบตอนรันอยู่ ต้อง restart แอป
 * ทางแก้จริงคือรันแอปใน Docker (ใช้ชื่อ service → driver ทำ failover เอง)
 * หรือเพิ่ม hosts file ให้ชื่อ mongo-1/2/3 ชี้ loopback IP คนละตัว
 */
export async function resolveMongoUrl(
  log?: (msg: string, meta: Record<string, unknown>) => void,
): Promise<string> {
  const raw = env.MONGO_URL

  // อยู่ใน Docker อยู่แล้ว → ใช้ชื่อ service ให้ driver จัดการ replica set เอง
  if (!raw.includes('directConnection=true')) return raw

  const candidates = (env.MONGO_PRIMARY_CANDIDATES ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)

  if (candidates.length === 0) return raw

  // เปลี่ยนแค่ host:port ที่เหลือของ URL ไว้เหมือนเดิม
  const swapHost = (candidate: string) => {
    const u = new URL(raw)
    return raw.replace(u.host, candidate)
  }

  for (const candidate of candidates) {
    const probe = new MongoClient(swapHost(candidate), {
      serverSelectionTimeoutMS: 3_000,
      directConnection: true,
    })
    try {
      await probe.connect()
      const hello = await probe.db('admin').command({ hello: 1 })
      if (hello.isWritablePrimary) {
        await probe.close()
        const fixed = swapHost(candidate)
        log?.('MongoDB: เลือก node ที่เป็น primary แล้ว', {
          node: candidate,
          ทั้งหมด: candidates,
        })
        return fixed
      }
    } catch {
      // node นี้ใช้ไม่ได้ → ลองตัวถัดไป
    } finally {
      await probe.close().catch(() => undefined)
    }
  }

  log?.('MongoDB: หา primary ไม่พบ — ใช้ URL เดิม', { candidates })
  return raw
}
