'use client'

import Link from 'next/link'
import { useCanReceiveReports } from './AppStatus'

/**
 * เมนูข้ามหน้าของแอป — ชุดเดียวกันทุกหน้า (Studio · บัญชีของฉัน · ทีมของฉัน)
 *
 * ── ทำไมต้องเป็นที่เดียวทั้งแอป ─────────────────────────────────────────────
 *   เคยมีเมนูข้ามหน้า 4 เขียน:
 *     · `/studio`      → ทีมของฉัน · บัญชีของฉัน (ต่อท้ายในรายการแท็บ)
 *     · `/account`     → กลับไป Studio · ทีมของฉัน (ในส่วนล่าง คนละที่กับ /studio)
 *     · `/teams`       → Studio · บัญชีของฉัน · ทีม (คนละลำดับ)
 *     · `/teams/[id]`  → ทีมทั้งหมด · Studio · บัญชี (คนละคำ ไม่มีไฮไลต์หน้าปัจจุบัน)
 *   ผลคือปุ่มไปหน้าอื่นอยู่คนละตำแหน่งกันทุกหน้า → ผู้ใช้ต้องหาใหม่ทุกครั้งที่สลับ
 *   ผู้ใช้สั่ง 2026-10-07: *"อื่น ๆ ทำให้เหมือนกับ /studio มันสวยดี"*
 *
 *   กติกาที่ใช้ทุกหน้า:
 *     1. อยู่**ต่อท้ายรายการเมนูของหน้า** ไม่ใช่คนละกลุ่มคนละที่
 *     2. หน้าที่อยู่**ไม่ต้องโชว์** (ไม่มีประโยชน์ และทำให้รายการยาวขึ้น)
 *     3. ป้ายเดียวกันเสมอ — ของเดิม `/teams` เขียน "ทีม" แต่หน้าอื่นเขียน "ทีมของฉัน"
 *
 * ⚠️ ใช้คลาสชุดเดียวกับแท็บ (`tabs__tab`) → หน้าตาเหมือนกันโดยไม่ต้องเขียน CSS ใหม่
 *
 * ⚠️ รายการ "รายงานปัญหา" โผล่เฉพาะผู้ดูแล แต่**ทุกหน้าตัดสินเหมือนกัน**
 *   เพราะเงื่อนไขมาจากคนเดียว (มีอยู่ใน `REPORT_TO_SUBS` ไหม) ไม่ใช่จากหน้าที่เปิด
 *   ถ้าคนละหน้าโผล่ไม่เหมือนกัน เกณฑ์ "ทุกหน้าเรียงเหมือนกัน" จะตกถาวร
 *   และผู้ใช้จะหาปุ่มไปหน้ารายงานปัญหาไม่เจอเอง
 */
const BASE_ITEMS = [
  { href: '/studio', label: 'Studio', testId: 'rail-studio' },
  { href: '/account', label: 'บัญชีของฉัน', testId: 'rail-account' },
  { href: '/teams', label: 'ทีมของฉัน', testId: 'rail-teams' },
] as const

/** เมนูที่เห็นเฉพาะผู้ดูแล — ต่อท้ายรายการปกติเสมอ ไม่ใช่คนละกลุ่ม */
const ADMIN_ITEMS = [{ href: '/reports', label: 'รายงานปัญหา', testId: 'rail-reports' }] as const

/** รายการเมนูของหน้านี้ — จุดเดียวที่ตัดสินว่ามีรายการผู้ดูแลหรือไม่ */
function useItems() {
  const canReceive = useCanReceiveReports()
  return canReceive ? [...BASE_ITEMS, ...ADMIN_ITEMS] : BASE_ITEMS
}

/**
 * สำหรับหน้าที่**มีแท็บของตัวเอง** — ส่งเข้าไปใน `Tabs` ผ่าน prop `extra`
 * จึงได้อยู่ใน `.tabs__list` ชุดเดียวกับแท็บ ไม่เกิดกลุ่มแยกที่มีช่องว่างกลาง
 *
 * @param current  path ของหน้าที่กำลังเปิด → จะถูกข้ามออกจากรายการ
 * @param onNavigate  ปิดลิ้นชักหลังกด (จอเล็ก) ถ้าไม่ส่ง กดแล้วลิ้นชักยังค้างทับเนื้อหาใหม่
 */
export function CrossLinks({ current, onNavigate }: { current: string; onNavigate?: () => void }) {
  const items = useItems()
  return (
    <>
      {items.filter((it) => it.href !== current).map((it) => (
        <Link
          key={it.href}
          href={it.href}
          className="tabs__tab"
          style={{ textDecoration: 'none' }}
          data-testid={it.testId}
          onClick={onNavigate}
        >
          {it.label}
        </Link>
      ))}
    </>
  );
}

/**
 * สำหรับหน้าที่**ไม่มีแท็บของตัวเอง** (หน้าทีม) — วาดเป็นรายการเต็มพร้อมครอบ `.tabs__list`
 * และทำหน้าที่อยู่ให้เป็น `tabs__tab--on` + `aria-current`
 *
 * ⚠️ ต้องคงครอบ `.tabs--rail` / `.tabs__list` ไว้
 *   ถ้าส่งเป็น `extra` ของ `Tabs` จะได้ `.tabs` ซ้อนสองชั้น
 */
export function NavRailList({ current, onNavigate }: { current: string; onNavigate?: () => void }) {
  const items = useItems()
  return (
    <div className="tabs--rail">
      <div className="tabs__list">
        {items.map((it) =>
          it.href === current ? (
            <span
              key={it.href}
              className="tabs__tab tabs__tab--on"
              aria-current="page"
              data-testid="cross-link-current"
            >
              {it.label}
            </span>
          ) : (
            <Link
              key={it.href}
              href={it.href}
              className="tabs__tab"
              style={{ textDecoration: 'none' }}
              data-testid={it.testId}
              onClick={onNavigate}
            >
              {it.label}
            </Link>
          ),
        )}
      </div>
    </div>
  );
}

