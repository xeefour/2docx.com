'use client'

/**
 * แท็บประวัติ — ใครใช้แม่แบบนี้บ้าง แล้วผลเป็นอย่างไร
 *
 * ── ต้องแบ่งหน้า ───────────────────────────────────────────────
 * ผู้ใช้สั่ง: *"ข้อมูลเยอะมาก แก้ไขให้มี pageination"* — เจอตอนเปิดแม่แบบที่
 * มีคนใช้เยอะ (317 ฉบับ / 100 คน) แล้วการ์ดยาวจนหาชื่อคนที่อยู่ล่างสุดไม่เจอ
 *
 * ── ทำไมสองรายการแบ่งหน้าแยกกัน ─────────────────────────────────
 *   · ผู้ใช้    = ข้อมูล**ทั้งหมด**มาอยู่แล้ว (server รวมให้ ไม่เกิน 100 คน) → ตัดที่เบราว์เซอร์
 *   · ฉบับล่าสุด = มีเป็น 317 ฉบับ → ต้องให้ **server** ตัด ไม่งั้นยิงมาทั้งหมดทุกครั้งที่เปลี่ยนหน้า
 */
import { useEffect, useState } from 'react'
import { api, type TemplateHistory } from './lib/api'
import Pager from './Pager'

const STATUS_TONE: Record<string, string> = {
  done: 'pill ok',
  failed: 'pill err',
  rendering: 'pill warn',
  queued: 'pill',
}

/** กี่คนต่อหน้า — 10 คนสูงพอดีกับการ์ดบนจอ 900px ที่มีผู้ใช้ 4 คน */
const PAGE_USERS = 10
/** กี่ฉบับต่อหน้า — 20 แถวยังอ่านออกโดยไม่ต้องเลื่อนในการ์ด */
const PAGE_DOCS = 20

function when(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString('th-TH', { dateStyle: 'medium', timeStyle: 'short' })
}

/** "1–20 จาก 317" — บอกว่าตอนนี้เห็นช่วงไหน */
function rangeOf(page: number, pageSize: number, total: number): string {
  if (total === 0) return 'ไม่มีฉบับ'
  const from = (page - 1) * pageSize + 1
  const to = Math.min(total, page * pageSize)
  return `${from}–${to} จาก ${total}`
}

export default function HistoryPanel({ templateKey }: { templateKey: string }) {
  const [data, setData] = useState<TemplateHistory | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [userPage, setUserPage] = useState(1)
  const [docPage, setDocPage] = useState(1)

  /**
   * ⚠️ รีเซ็ตเลขหน้าตอนเปลี่ยนแม่แบบ ต้องทำ**ระหว่าง render** ไม่ใช่ใน useEffect
   *
   *   ถ้ารีเซ็ตใน `useEffect` ตัว fetch จะยิงไปแล้ว 1 รอบด้วยเลขหน้าของแม่แบบเก่า
   *   แล้วค่อยยิงซ้ำอีกรอบหลังรีเซ็ต (ข้อมูลของแม่แบบเก่าหายไปเฉย ๆ)
   *
   *   React อนุญาตให้เรียก setState ระหว่าง render เพื่อ "ปรับ state ให้ตรงกับ props"
   *   ได้โดยเฉพาะกรณีนี้ (React จะ render ซ้ำในรอบเดียว ไม่วนซ้ำ)
   */
  const [pageKey, setPageKey] = useState(templateKey)
  if (pageKey !== templateKey) {
    setPageKey(templateKey)
    setUserPage(1)
    setDocPage(1)
  }

  useEffect(() => {
    let alive = true
    setLoading(true)
    void api
      .history(templateKey, { limit: PAGE_DOCS, skip: (docPage - 1) * PAGE_DOCS })
      .then((r) => {
        if (alive) setData(r)
      })
      .catch((e) => {
        if (alive) setError(e instanceof Error ? e.message : String(e))
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [templateKey, docPage])

  if (error) return <p className="field-error" style={{ padding: 16 }}>{error}</p>
  if (loading && !data) return <p className="muted" style={{ padding: 16 }}>กำลังโหลดประวัติ…</p>
  if (!data) return null

  if (data.total === 0) {
    return (
      <p className="muted" style={{ padding: 24, textAlign: 'center', margin: 0 }}>
        ยังไม่มีใครสร้างเอกสารจากแม่แบบนี้
      </p>
    )
  }

  // ── รายคน: ตัดในเบราว์เซอร์ เพราะข้อมูลชุดนี้มาครบอยู่แล้ว ──
  const users = data.users
  const userPages = Math.max(1, Math.ceil(users.length / PAGE_USERS))
  const safeUserPage = Math.min(userPage, userPages)
  const shownUsers = users.slice((safeUserPage - 1) * PAGE_USERS, safeUserPage * PAGE_USERS)

  // ── ฉบับล่าสุด: server ตัดให้ ต้องกันหน้าที่เกินไว้เผื่อข้อมูลหดลง ──
  const docPages = Math.max(1, Math.ceil(data.total / PAGE_DOCS))
  const safeDocPage = Math.min(docPage, docPages)
  const items = data.items

  return (
    <div style={{ display: 'grid', gap: 16, gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))' }}>
      {/* ── สรุปรายคน ── */}
      <div className="card" data-testid="history-users" style={{ padding: 16 }}>
        <h2 style={{ margin: '0 0 4px', fontSize: 15 }}>ผู้ใช้แม่แบบนี้</h2>
        <p className="muted" style={{ margin: '0 0 10px', fontSize: 12 }}>
          ทั้งหมด {data.total} ฉบับ · {users.length} คน
        </p>

        {shownUsers.map((u) => (
          <div className="who" key={u.sub}>
            <div className="avatar">{(u.name ?? u.sub).slice(0, 1).toUpperCase()}</div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="who__name">{u.name ?? '(ไม่ทราบชื่อ)'}</div>
              <div className="who__meta">
                ล่าสุด {when(u.lastAt)}
                {u.failCount > 0 ? ` · ล้มเหลว ${u.failCount} ครั้ง` : ''}
              </div>
            </div>
            <span className={u.failCount > 0 ? 'pill warn' : 'pill ok'}>{u.count} ฉบับ</span>
          </div>
        ))}

        <Pager
          page={safeUserPage}
          pageCount={userPages}
          onChange={setUserPage}
          testId="history-users-pager"
          summary={users.length > 0 ? `หน้า ${safeUserPage} / ${userPages} · ${users.length} คน` : undefined}
        />
      </div>

      {/* ── รายการล่าสุด ── */}
      <div className="card" data-testid="history-docs" style={{ overflow: 'hidden' }}>
        <div style={{ padding: '14px 16px', borderBottom: '1px solid var(--line)' }}>
          <h2 style={{ margin: 0, fontSize: 15 }}>ฉบับล่าสุด</h2>
        </div>
        <table>
          <thead>
            <tr>
              <th>ป้าย</th>
              <th>ผู้สร้าง</th>
              <th>รูปแบบ</th>
              <th>สถานะ</th>
              <th>เวลา</th>
            </tr>
          </thead>
          <tbody data-testid="history-docs-body">
            {items.map((d) => (
              <tr key={d._id}>
                <td>{d.label ?? '—'}</td>
                <td>{d.createdByName ?? d.createdBy ?? '—'}</td>
                <td className="mono">{d.outputFormat}</td>
                <td>
                  <span className={STATUS_TONE[d.status] ?? 'pill'}>{d.status}</span>
                </td>
                <td className="muted" style={{ fontSize: 12 }}>
                  {when(d.createdAt)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        {loading && (
          <p className="muted" style={{ padding: '8px 16px', margin: 0, fontSize: 12 }}>
            กำลังโหลดหน้า {safeDocPage}…
          </p>
        )}

        <Pager
          page={safeDocPage}
          pageCount={docPages}
          onChange={setDocPage}
          testId="history-docs-pager"
          summary={`หน้า ${safeDocPage} / ${docPages}`}
        >
          {rangeOf(safeDocPage, PAGE_DOCS, data.total)}
        </Pager>
      </div>
    </div>
  )
}
