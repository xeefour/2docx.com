'use client'

/**
 * ── กล่องจดหมาย (Inbox) ────────────────────────────────────────────
 *
 * ผู้ใช้สั่ง:
 *   *"เพิ่มกล่องจดหมาย inbox **แบ่งประเภท**ของจดหมายด้วย
 *     จากระบบที่เตือนต่าง ๆ เวลามีอะไรที่เกี่ยวข้องให้แจ้งเตือนเข้าไปในกล่องนี้
 *     จากเพื่อนที่ส่งมาให้ เช่น แชร์แม่แบบให้"*
 *
 * ── หลักการที่ยึดในไฟล์นี้ ─────────────────────────────────────────
 *
 * 1. **แผงนี้เป็นเจ้าของจำนวนที่ยังไม่อ่านของตัวเอง**
 *    โหลดรายการและตัวเลขเองทั้งหมด ไม่ต้องรอบพ่อมาสั่งรีเฟรช
 *    เคยมี prop `onChanged` ให้พ่อมาอัปเดตป้ายนับบนกระดิ่ง/แท็บ แต่ผู้ใช้สั่ง
 *    เอากระดิ่งกับป้ายนับออกให้ sidebar เหมือนหน้า /account · /teams แล้ว
 *    จึงเหลือเป็น optional (ดู `notifyChanged`)
 *
 * 2. **คลิกฉบับที่ยังไม่อ่าน = ทำเครื่องหมายก่อน แล้วค่อยนำทาง**
 *    ทำแบบ optimistic เพราะถ้ารอเครือข่าย แล้วค่อย push ผู้ใช้จะรู้สึกว่าเว็บค้าง
 *    ถ้า API ล้ม ก็ดึงข้อมูลกลับมาให้ตรงกับเซิร์ฟเวอร์อีกครั้ง
 *
 * 3. **ทำลายข้อมูลต้องยืนยันเสมอ**
 *    ล้างกล่อง/ลบฉบับเดียวย้อนกลับไม่ได้ จึงใช้ปุ่มสองจังหวะแบบเดียวกับ
 *    ปุ่มลบแม่แบบใน `Studio.tsx` แทน `window.confirm` (ซึ่งบล็อกทั้งหน้า)
 *
 * ⚠️ ไฟล์นี้ export `KIND_LABEL` / `KIND_ICON` / `timeAgo` ให้ `InboxBell.tsx` ใช้ซ้ำ
 *    เพราะทั้งสองไฟล์อยู่ในแท็บเดียวกันเสมอ แยกไฟล์ helper เพิ่มแล้วจะเป็นไฟล์ที่ 3
 *    ที่ไม่มีใครอยากแก้ คำเดียวกันสองที่สำคัญกว่าไฟล์เพิ่มหนึ่งไฟล์
 */

import { useCallback, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { ApiError, api } from './lib/api'
import type { Notification, NotificationKind } from '@docgen/shared'

/**
 * ⚠️ ป้ายประเภท — **คัดลอกค่ามา** ไม่ได้ import ค่าจริงจาก `@docgen/shared`
 *
 *   ดูเหตุผลที่ห้าม import ค่าในคอมเมนต์ต้น `lib/api.ts` (barrel ดึง `mongodb` เข้า client)
 *   ค่าตรงนี้ต้องตรงกับ `NOTIFICATION_KIND_LABEL` ใน shared
 *   ถ้าวันหนึ่งฝั่ง API เปลี่ยนคำ ให้แก้ที่นี่ด้วย
 */
export const KIND_LABEL: Record<NotificationKind, string> = {
  share: 'การแชร์',
  access: 'สิทธิ์',
  document: 'งานเอกสาร',
  system: 'ระบบ',
  issue: 'ปัญหาที่แจ้ง',
}

/**
 * ไอคอนต่อประเภท — ใช้แยกประเภทด้วยสายตาเร็วกว่าอ่านป้าย
 * (ประเภท "สิทธิ์" กับ "งานเอกสาร" เป็นคำทั่วไป อ่านช้ากว่าจำกลุ่มสี/ไอคอน)
 */
export const KIND_ICON: Record<NotificationKind, string> = {
  share: '🤝',
  access: '🔑',
  document: '📄',
  system: '⚙️',
  issue: '🐛',
}

/**
 * เวลาแบบ "เมื่อ x นาทีที่แล้ว"
 *
 * ⚠️ `String(at)` เป็นตัวแปลงที่ต้องมี
 *   type ใน shared ประกาศ `at` เป็น `Date` (ฝั่ง API ใช้ Date จริง)
 *   แต่พอส่งผ่าน JSON มันกลายเป็น ISO **string** ทันที
 *   `new Date(x)` รับได้ทั้งสองแบบ แต่ TS ไม่ยอมให้ส่ง `Date` เข้าไป
 *   → ผ่าน `String()` คือวิธีเดียวที่ถูกทั้งเรื่องชนิดและเรื่อง runtime
 */
export function timeAgo(at: Date | string): string {
  const ms = Date.now() - new Date(String(at)).getTime()
  if (!Number.isFinite(ms)) return ''
  const min = Math.floor(ms / 60_000)
  if (min < 1) return 'เมื่อครู่'
  if (min < 60) return `เมื่อ ${min} นาทีที่แล้ว`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `เมื่อ ${hr} ชั่วโมงที่แล้ว`
  const day = Math.floor(hr / 24)
  if (day < 30) return `เมื่อ ${day} วันที่แล้ว`
  return `เมื่อ ${Math.floor(day / 30)} เดือนที่แล้ว`
}

/** ประเภทที่ตัวกรองให้เลือก — `all` = ทุกประเภทรวมกัน */
type Filter = NotificationKind | 'all'

const FILTERS: Filter[] = ['all', 'share', 'access', 'document', 'system', 'issue']

/** testid ของปุ่มตัวกรอง — เทสต์อัตโนมัติอ้างตามชื่อนี้ ห้ามเปลี่ยน */
const FILTER_TESTID: Record<Filter, string> = {
  all: 'inbox-filter-all',
  share: 'inbox-filter-share',
  access: 'inbox-filter-access',
  document: 'inbox-filter-document',
  system: 'inbox-filter-system',
  issue: 'inbox-filter-issue',
}

/** ขอจาก API มากี่ฉบับต่อครั้ง — พอให้ผู้ใช้เลื่อนอ่านได้โดยไม่ต้องกดรีเฟรช */
const PAGE = 50

/** รูปแบบรายการที่แผงนี้ถืออยู่ (ไม่ใช้ทั้ง `InboxList` ตรง ๆ เพราะแตะทีละฉบับ) */
type Row = Notification

export default function InboxPanel({ onChanged }: { onChanged?: () => void } = {}) {
  /**
   * หลังผู้ใช้อ่าน/ลบ จะมีการ `load()` ใหม่เสมอ ซึ่งทำให้รายการและตัวเลขในแผงนี้ถูกต้อง
   *   `onChanged` เคยมีไว้เพื่อแจ้งพ่อให้รีเฟรช**ป้ายนับบนกระดิ่ง/แท็บ**
   *   แต่ผู้ใช้สั่งเอากระดิ่งกับป้ายนับออกให้ sidebar เหมือนหน้า /account · /teams แล้ว
   *   จึงเหลือเป็น optional — ถ้าภายหลังเพิ่มป้ายนับกลับมา ส่ง prop นี้กลับได้เลย
   */
  const notifyChanged = () => onChanged?.()
  const router = useRouter()
  const [filter, setFilter] = useState<Filter>('all')
  const [rows, setRows] = useState<Row[]>([])
  const [total, setTotal] = useState(0)
  const [unread, setUnread] = useState(0)
  const [unreadByKind, setUnreadByKind] = useState<Record<string, number>>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  /** ข้อความบอกผลลัพธ์ของ action ล่าสุด (อ่านแล้วกี่ฉบับ / ลบกี่ฉบับ) */
  const [notice, setNotice] = useState<string | null>(null)
  /** id ของฉบับที่กำลังทำงาน / `'all'` = อ่านทั้งหมด / `'clear'` = ล้างกล่อง */
  const [busy, setBusy] = useState('')
  /** ปุ่มที่กดครั้งแรกแล้วรอกดซ้ำ = กดยืนยัน */
  const [armed, setArmed] = useState('')

  const load = useCallback(async (f: Filter) => {
    setLoading(true)
    setError(null)
    try {
      const r = await api.listNotifications({ kind: f === 'all' ? undefined : f, limit: PAGE })
      setRows(r.items)
      setTotal(r.total)
      setUnread(r.unread)
      setUnreadByKind(r.unreadByKind)
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load(filter)
  }, [filter, load])

  /**
   * คลิกฉบับหนึ่ง
   *
   * ⚠️ ทำเครื่องหมายว่าอ่าน**ก่อน**นำทาง ไม่ใช่รอผล
   *   ถ้ารอ API แล้วค่อย push ผู้ใช้จะเห็นหน้าค้างเวลาไปยังปลายทาง
   *   และกดซ้ำระหว่างรอไม่ได้ (กันยิงซ้ำด้วย)
   */
  function openItem(n: Row) {
    if (!n.read && busy !== n._id) {
      setBusy(n._id)
      setRows((list) => list.map((x) => (x._id === n._id ? { ...x, read: true } : x)))
      setUnread((v) => Math.max(0, v - 1))
      setUnreadByKind((m) => ({ ...m, [n.kind]: Math.max(0, (m[n.kind] ?? 0) - 1) }))
      void api.markNotificationRead(n._id).catch(() => {
        // API ล้ม = ดึงของจริงกลับมา อย่าปล่อยให้หน้าจอโกหกับเซิร์ฟเวอร์
        void load(filter)
      })
      notifyChanged()
      // ⚠️ ล้างเฉพาะเมื่อ `busy` ยังเป็นฉบับนี้อยู่
      //   ถ้าใช้ `setBusy('')` ตรง ๆ จะไปลบสถานะของ action ที่เพิ่งเริ่ม
      //   แล้วเปิดปุ่มทั้งหมดกลางคัน
      setTimeout(() => setBusy((b) => (b === n._id ? '' : b)), 400)    }
    if (n.link) router.push(n.link)
  }

  /** ปุ่ม "อ่านทั้งหมด" — ทำเฉพาะประเภทที่กรองอยู่ ไม่งั้นผู้ใช้จะเผลออ่านทั้งกล่อง */
  async function markAll() {
    const kind = filter === 'all' ? undefined : filter
    setBusy('all')
    setError(null)
    try {
      const n = await api.markAllNotificationsRead(kind)
      await load(filter)
      notifyChanged()
      if (n > 0) setNotice(`อ่านแล้ว ${n} ฉบับ`)
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e))
    } finally {
      setBusy('')
    }
  }

  /** ปุ่ม "ล้างกล่อง" — กดครั้งแรกเปลี่ยนเป็นปุ่มยืนยัน กดซ้ำถึงจะลบจริง */
  async function clear() {
    if (armed !== 'clear') {
      setArmed('clear')
      return
    }
    const kind = filter === 'all' ? undefined : filter
    setBusy('clear')
    setError(null)
    try {
      const n = await api.clearNotifications(kind)
      await load(filter)
      notifyChanged()
      setNotice(n > 0 ? `ลบจดหมาย ${n} ฉบับแล้ว` : 'ไม่มีจดหมายให้ลบ')
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e))
    } finally {
      setBusy('')
      setArmed('')
    }
  }

  /** ปุ่มลบรายฉบับ — ใช้รูปแบบกดสองจังหวะเหมือนปุ่มล้างกล่อง */
  async function remove(n: Row) {
    if (armed !== n._id) {
      setArmed(n._id)
      return
    }
    setBusy(n._id)
    setError(null)
    try {
      await api.deleteNotification(n._id)
      await load(filter)
      notifyChanged()
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e))
    } finally {
      setBusy('')
      setArmed('')
    }
  }

  return (
    <section className="inbox" data-testid="inbox-panel" role="region" aria-label="กล่องจดหมาย">
      <div className="inbox__bar">
        <div className="inbox__filters" role="group" aria-label="กรองตามประเภทจดหมาย">
          {FILTERS.map((f) => {
            const label = f === 'all' ? 'ทั้งหมด' : KIND_LABEL[f]
            // ป้ายตัวเลขบน "ทั้งหมด" = ยังไม่อ่านรวมทุกประเภท (ไม่ใช่ผลรวมของรายการที่กรองอยู่)
            const n = f === 'all' ? unread : (unreadByKind[f] ?? 0)
            return (
              <button
                key={f}
                type="button"
                className="inbox__filter"
                data-testid={FILTER_TESTID[f]}
                aria-pressed={filter === f}
                onClick={() => {
                  setArmed('')
                  setFilter(f)
                }}
              >
                {label}
                {n > 0 && <span className="inbox__n">{n}</span>}
              </button>
            )
          })}
        </div>
        <div className="inbox__acts">
          <button
            type="button"
            className="ghost"
            data-testid="inbox-mark-all-read"
            onClick={() => void markAll()}
            disabled={busy !== '' || unread === 0}
            title="ทำเครื่องหมายว่าอ่านแล้วทุกฉบับที่ยังไม่อ่าน"
          >
            อ่านทั้งหมด
          </button>
          <button
            type="button"
            className={armed === 'clear' ? 'danger' : 'ghost'}
            data-testid="inbox-clear"
            onClick={() => void clear()}
            disabled={busy !== '' || rows.length === 0}
            title={armed === 'clear' ? 'กดซ้ำอีกครั้งเพื่อยืนยันการลบ' : 'ล้างจดหมายที่เหลืออยู่ทั้งหมด'}
          >
            {armed === 'clear' ? 'ยืนยันล้างกล่อง?' : 'ล้างกล่อง'}
          </button>
        </div>
      </div>

      {notice && (
        <div className="pill ok pill--msg inbox__msg">
          <span>{notice}</span>
          <button type="button" className="ghost" onClick={() => setNotice(null)}>
            ปิด
          </button>
        </div>
      )}
      {error && (
        <div className="pill err pill--msg inbox__msg" role="alert">
          <span>{error}</span>
          <button type="button" className="ghost" onClick={() => void load(filter)}>
            ลองใหม่
          </button>
        </div>
      )}

      <div className="card inbox__card">
        {loading ? (
          <div className="muted inbox__state">กำลังโหลดจดหมาย…</div>
        ) : rows.length === 0 ? (
          <div className="muted inbox__state" data-testid="inbox-empty">
            <p className="inbox__state-t">ยังไม่มีจดหมาย</p>
            <p className="inbox__state-s">
              เวลามีคนแชร์แม่แบบให้ สิทธิ์ของคุณเปลี่ยน หรืองานเอกสารเสร็จ ระบบจะส่งมาเก็บที่นี่
            </p>
            <button type="button" className="ghost" onClick={() => void load(filter)}>
              รีเฟรช
            </button>
          </div>
        ) : (
          <ul className="inbox__list">
            {rows.map((n) => (
              <li
                key={n._id}
                className={`inbox__item${n.read ? '' : ' inbox__item--unread'}`}
                data-testid="inbox-item"
              >
                <span className="ntf__icon" aria-hidden="true">
                  {KIND_ICON[n.kind]}
                </span>
                {/*
                 * ปุ่มเปิด = ปุ่ม**เดียว**ครอบเนื้อหาทั้งหมด แยกจากปุ่มลบเป็นอีกปุ่ม
                 * ⚠️ ห้ามซ้อน <button> ใน <button> (HTML ไม่อนุญาต และคีย์บอร์ดจะพัง)
                 */}
                <button
                  type="button"
                  className="ntf__main"
                  onClick={() => openItem(n)}
                  disabled={busy === n._id}
                >
                  <span className="ntf__top">
                    <span className="ntf__title" data-testid="inbox-item-title">
                      {n.title}
                    </span>
                    {!n.read && (
                      <span
                        className="ntf__dot"
                        data-testid="inbox-item-unread"
                        role="img"
                        aria-label="ยังไม่อ่าน"
                      />
                    )}
                  </span>
                  <span className="ntf__body" data-testid="inbox-item-body">
                    {n.body}
                  </span>
                  <span className="ntf__meta">
                    <span className="pill">{KIND_LABEL[n.kind]}</span>
                    {n.templateName && <span className="muted ntf__tpl">{n.templateName}</span>}
                    <span className="muted ntf__time">{timeAgo(n.at)}</span>
                  </span>
                </button>
                <button
                  type="button"
                  className={armed === n._id ? 'danger ntf__del' : 'ghost ntf__del'}
                  data-testid="inbox-item-delete"
                  onClick={() => void remove(n)}
                  disabled={busy !== ''}
                  title={armed === n._id ? 'กดซ้ำอีกครั้งเพื่อยืนยันการลบ' : 'ลบจดหมายฉบับนี้'}
                  aria-label={`ลบจดหมาย ${n.title}`}
                >
                  {armed === n._id ? 'ยืนยัน' : 'ลบ'}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/*
       * ⚠️ ตัวเลข "ยังไม่อ่าน" ต้องมี testid ของตัวเอง ไม่ใช่อ่านจากข้อความรวม
       *   เพราะบรรทัดนี้มีตัวเลขสามตัว (แสดง · ทั้งหมด · ยังไม่อ่าน)
       *   เทสต์ที่ไล่ regex จะได้ตัวแรกซึ่งไม่ใช่ตัวที่ต้องการ
       *   (เคยได้ 4 แทน 0 แล้วเกณฑ์ตกทั้งที่ระบบทำงานถูก)
       */}
      <p className="muted inbox__foot" data-testid="inbox-foot">
        {loading ? (
          'กำลังโหลด…'
        ) : (
          /**
           * ⚠️ ต้องแยก JSX ออกมานอก template literal
           *   เพราะ `${ … }` รับได้แค่**นิพจน์ JS** ไม่รับ JSX
           *   เคยลองใส่ `<b>` ไว้ใน `${ }` แล้ว TypeScript พังทันที
           */
          <>
            {`แสดง ${rows.length} ฉบับ · ในกล่องทั้งหมด ${total} ฉบับ · ยังไม่อ่าน `}
            <b data-testid="inbox-unread" style={{ fontWeight: 600 }}>
              {unread}
            </b>
            {' ฉบับ'}
          </>
        )}
      </p>
    </section>
  )
}
