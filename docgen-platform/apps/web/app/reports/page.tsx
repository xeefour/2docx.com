'use client'

/**
 * `/reports` — หน้ารายงานปัญหาสำหรับผู้ดูแล
 *
 * ── ทำไมต้องมีหน้านี้ ไม่ใช่ดูจากกล่องจดหมายอย่างเดียว ────────────────
 *   กระดิ่งบอกได้แค่ "มีคนแจ้งปัญหา" แต่แก้งานจริงต้องดู **ภาพหน้าจอ + error + หน้าที่เกิด**
 *   ซึ่งยาวมากและอ่านจากกล่องจดหมายไม่ได้ (จดหมายโดนตัดที่ 500 ตัวอักษร)
 *   ถ้าไม่มีหน้านี้ เราต้องกลับไปกดทุกกระดิ่งแล้วค้นหาในประวัติแชท → จะไม่มีใครทำ
 *
 * ── ใครเข้าหน้านี้ได้ ────────────────────────────────────────────────
 *   เฉพาะ `REPORT_TO_SUBS` — คนอื่นโดน 404 จาก API
 *   หน้าเว็บจึงแสดง "ไม่มีสิทธิ์" พร้อมคำอธิบาย แทนที่จะเป็นหน้าว่างที่ดูเหมือนระบบพัง
 *
 * ⚠️ ลิงก์จากกระดิ่งจะเป็น `/reports?open=<id>` → เปิดรายงานฉบับนั้นขึ้นมาเลย
 *   (ถ้าไม่ทำ ผู้ดูแลต้องเลื่อนหาเองว่ากระดิ่งใบไหนเกี่ยวกับอะไร — ซึ่งแย่มาก
 *    เพราะกระดิ่งหนึ่งฉบับ = หนึ่งรายงาน แต่ต้องเดาว่าอันไหนคือของเราที่เพิ่งได้)
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { IssueReport, IssueReportList, ReportStatus } from '@docgen/shared'
import { ApiError, api } from '../studio/lib/api'
import AppRail from '../components/AppRail'
import RailMenuButton from '../components/RailMenuButton'
import { NavRailList } from '../components/NavLinks'

/** ป้าย/ปุ่มของแต่ละสถานะ — เรียงตามลำดับงานที่ต้องทำจริง */
const STATUSES: { id: ReportStatus; label: string }[] = [
  { id: 'open', label: 'ยังไม่ได้แก้' },
  { id: 'doing', label: 'กำลังแก้' },
  { id: 'fixed', label: 'แก้แล้ว' },
]

function fmtDate(v: string | Date): string {
  const d = typeof v === 'string' ? new Date(v) : v
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleString('th-TH', { dateStyle: 'medium', timeStyle: 'short' })
}

export default function ReportsPage() {
  const [railOpen, setRailOpen] = useState(false)
  const [data, setData] = useState<IssueReportList | null>(null)
  const [denied, setDenied] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [userName, setUserName] = useState('')

  /**
   * ชื่อผู้ใช้ในส่วนล่างของ sidebar
   *
   * ⚠️ ต้องมีทุกหน้า — `probe-rail-consistency.mjs` ตรวจข้อนี้
   *   เจอจริงรอบนี้: `/reports` ลืมส่ง → ไม่มีชื่อในส่วนล่างของทุกหน้าอื่น
   *   หน้านี้เป็น client component อยู่แล้ว จึงอ่านได้ตรง ๆ ไม่ต้องยิง `GET /api/account`
   *   (รุ่นนั้นนับ 5 อย่าง แพงเกินจำเป็นสำหรับแค่ชื่อ)
   */
  useEffect(() => {
    let alive = true
    api
      .me()
      .then((r) => alive && setUserName(r.user?.name ?? ''))
      .catch(() => alive && setUserName(''))
    return () => { alive = false }
  }, [])

  /**
   * อ่าน `?open=<id>` จาก `window` ใน effect ไม่ใช่ `useSearchParams()`
   *
   * ⚠️ `useSearchParams()` ใน client component ที่ prerender ได้
   *   ทำให้ Next บังคับให้ห่อด้วย `<Suspense>` และ build หน้านี้จะพังตอน prerender
   *   (เจอจริง: `useSearchParams() should be wrapped in a suspense boundary`)
   *   ค่านี้ใช้แค่ตอน mount เพื่อกางรายงานที่ลิงก์จากกระดิ่งชี้มา
   *   การอ่านจาก `window` ตรง ๆ ได้ผลเหมือนกันและไม่ต้องเพิ่มชั้นขอบ
   */
  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get('open')
    if (id) setExpanded(id)
  }, [])

  const load = useCallback(async () => {
    try {
      setData(await api.listReports())
      setDenied(null)
      setError(null)
    } catch (err) {
      setData(null)
      // 404 = ไม่ใช่ผู้ดูแล (API ตอบ 404 ตั้งใจไม่ใช่ 403) → อธิบายให้เข้าใจ
      if (err instanceof ApiError && err.status === 404) {
        setDenied('คุณไม่ได้อยู่ในรายชื่อผู้รับรายงานปัญหา (REPORT_TO_SUBS)')
        return
      }
      setError(err instanceof ApiError ? err.message : 'โหลดรายงานไม่สำเร็จ')
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const setStatus = async (id: string, status: ReportStatus) => {
    setBusyId(id)
    try {
      const updated = await api.setReportStatus(id, status)
      setData((prev) =>
        prev
          ? {
              ...prev,
              items: prev.items.map((r) => (r._id === id ? updated : r)),
              // ทำป้าย "ยังค้าง" ให้ตรงกับฐานข้อมูลโดยไม่ยิงซ้ำ
              open: prev.items.reduce(
                (n, r) => n + (r._id === id ? (updated.resolvedAt ? 0 : 1) : r.resolvedAt ? 0 : 1),
                0,
              ),
            }
          : prev,
      )
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'เปลี่ยนสถานะไม่สำเร็จ')
    } finally {
      setBusyId(null)
    }
  }

  const openCount = useMemo(() => (data ? data.items.filter((r) => !r.resolvedAt).length : 0), [data])

  return (
    <div className="shell">
      <AppRail
        subtitle="รายงานปัญหา"
        navLabel="เมนู"
        nav={<NavRailList current="/reports" onNavigate={() => setRailOpen(false)} />}
        navTestId="rail-list-nav"
        userName={userName}
        open={railOpen}
        onClose={() => setRailOpen(false)}
        testId="reports-rail"
      />

      <div className="shell__main">
        <div className="pagebar">
          <RailMenuButton onOpen={() => setRailOpen(true)} />
          <h1 className="pagebar__title">รายงานปัญหา</h1>
          {data && (
            <span className="pill" data-testid="reports-open-count">
              ค้างอยู่ {openCount} · ทั้งหมด {data.total}
            </span>
          )}
        </div>

        {denied && (
          <div className="card" data-testid="reports-denied">
            <strong>คุณดูรายงานปัญหาไม่ได้</strong>
            <p style={{ color: 'var(--ink-2)', margin: '8px 0 0' }}>{denied}</p>
            <p style={{ color: 'var(--ink-3)', margin: '6px 0 0' }}>
              ถ้าคุณควรเป็นผู้ดูแล ให้ผู้ดูแลระบบเพิ่ม sub ของคุณใน <code>REPORT_TO_SUBS</code> แล้วรีสตาร์ท API
            </p>
          </div>
        )}

        {error && (
          <div className="card" data-testid="reports-error">
            <strong style={{ color: 'var(--err)' }}>โหลดรายงานไม่สำเร็จ</strong>
            <p style={{ color: 'var(--ink-2)', margin: '8px 0 12px' }}>{error}</p>
            <button onClick={() => void load()}>ลองใหม่</button>
          </div>
        )}

        {data && data.items.length === 0 && (
          <div className="card" data-testid="reports-empty">
            ยังไม่มีรายงานปัญหาเลย — ถ้ามีผู้ใช้เจอปัญหา
            ปุ่ม “รายงานปัญหา” จะอยู่ในแถบ URL มุมล่างซ้ายของทุกหน้า
          </div>
        )}

        <div className="stack" style={{ display: 'grid', gap: 12 }}>
          {data?.items.map((r) => {
            const isOpen = expanded === r._id
            return (
              <article
                key={r._id}
                className="card"
                data-testid="report-item"
                data-report-id={r._id}
                style={{ borderLeft: `3px solid ${r.resolvedAt ? 'var(--ok)' : 'var(--warn)'}` }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
                  <strong>{r.summary}</strong>
                  <span className="pill">{STATUSES.find((s) => s.id === r.status)?.label ?? r.status}</span>
                </div>
                <p style={{ color: 'var(--ink-3)', margin: '6px 0 0', fontSize: 12.5 }}>
                  {r.reporterName} · {fmtDate(r.createdAt)}
                  {r.pageUrl ? (
                    <>
                      {' · '}
                      <code>{r.pageUrl}</code>
                    </>
                  ) : null}
                </p>

                <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
                  {STATUSES.map((s) => (
                    <button
                      key={s.id}
                      className={r.status === s.id ? 'primary' : 'ghost'}
                      disabled={busyId === r._id || r.status === s.id}
                      data-testid={`report-set-${s.id}`}
                      onClick={() => void setStatus(r._id, s.id)}
                    >
                      {s.label}
                    </button>
                  ))}
                  <button className="ghost" data-testid="report-toggle" onClick={() => setExpanded(isOpen ? null : r._id)}>
                    {isOpen ? 'ซ่อนรายละเอียด' : 'ดูรายละเอียด'}
                  </button>
                </div>

                {isOpen && (
                  <div className="report-detail" data-testid="report-detail">
                    {r.details && (
                      <p style={{ whiteSpace: 'pre-wrap', margin: '12px 0 0' }}>{r.details}</p>
                    )}
                    {r.shotKey && (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        className="report-detail__shot"
                        data-testid="report-shot"
                        src={`/api/reports/${encodeURIComponent(r._id)}/shot`}
                        alt="ภาพหน้าจอที่ผู้ใช้แนบมา"
                      />
                    )}
                    {!r.details && !r.shotKey && (
                      <p style={{ color: 'var(--ink-3)', margin: '12px 0 0' }}>
                        ผู้ใช้ไม่ได้เขียนรายละเอียดและไม่ได้แนบภาพ
                      </p>
                    )}
                    {r.diagnostics && (
                      <details style={{ marginTop: 12 }}>
                        <summary style={{ cursor: 'pointer', color: 'var(--ink-2)' }}>
                          ข้อมูลวินิจฉัยจากเบราว์เซอร์
                        </summary>
                        <pre className="mono report-detail__diag">{r.diagnostics}</pre>
                      </details>
                    )}
                  </div>
                )}
              </article>
            )
          })}
        </div>
      </div>
    </div>
  )
}