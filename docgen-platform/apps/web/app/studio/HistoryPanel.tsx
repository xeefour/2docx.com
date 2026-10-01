'use client'

/** แท็บประวัติ — ใครใช้แม่แบบนี้บ้าง แล้วผลเป็นอย่างไร */
import { useEffect, useState } from 'react'
import { api, type TemplateHistory } from './lib/api'

const STATUS_TONE: Record<string, string> = {
  done: 'pill ok',
  failed: 'pill err',
  rendering: 'pill warn',
  queued: 'pill',
}

function when(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString('th-TH', { dateStyle: 'medium', timeStyle: 'short' })
}

export default function HistoryPanel({ templateKey }: { templateKey: string }) {
  const [data, setData] = useState<TemplateHistory | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    setLoading(true)
    void api
      .history(templateKey)
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
  }, [templateKey])

  if (loading) return <p className="muted" style={{ padding: 16 }}>กำลังโหลดประวัติ…</p>
  if (error) return <p className="field-error" style={{ padding: 16 }}>{error}</p>
  if (!data) return null

  if (data.total === 0) {
    return (
      <p className="muted" style={{ padding: 24, textAlign: 'center', margin: 0 }}>
        ยังไม่มีใครสร้างเอกสารจากแม่แบบนี้
      </p>
    )
  }

  return (
    <div style={{ display: 'grid', gap: 16, gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))' }}>
      {/* ── สรุปรายคน ── */}
      <div className="card" style={{ padding: 16 }}>
        <h2 style={{ margin: '0 0 4px', fontSize: 15 }}>ผู้ใช้แม่แบบนี้</h2>
        <p className="muted" style={{ margin: '0 0 10px', fontSize: 12 }}>
          ทั้งหมด {data.total} ฉบับ · {data.users.length} คน
        </p>

        {data.users.map((u) => (
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
      </div>

      {/* ── รายการล่าสุด ── */}
      <div className="card" style={{ overflow: 'hidden' }}>
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
          <tbody>
            {data.items.map((d) => (
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
      </div>
    </div>
  )
}
