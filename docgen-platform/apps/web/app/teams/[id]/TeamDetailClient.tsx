'use client'

import Link from 'next/link'
import { useCallback, useState } from 'react'
// ⚠️ ต้อง alias ชื่อ type — ถ้าใช้ `TeamDetail` ตรง ๆ จะชนกับชื่อ component ตัวเอง
import type { TeamDetail as TeamDetailData, TeamMember, TeamRole } from '@docgen/shared'
import AppRail from '../../components/AppRail'
import RailMenuButton from '../../components/RailMenuButton'
import { NavRailList } from '../../components/NavLinks'
import { ROLE_LABEL } from '../TeamsPage'

/** role ที่เลือกได้ตอนเลื่อนสิทธิ์ */
const ASSIGNABLE: TeamRole[] = ['viewer', 'editor', 'admin', 'owner']
const ASSIGN_LABEL: Record<TeamRole, string> = {
  viewer: ROLE_LABEL.viewer,
  editor: ROLE_LABEL.editor,
  admin: ROLE_LABEL.admin,
  owner: ROLE_LABEL.owner,
}

type Props = {
  initial: TeamDetailData
  meSub: string
  /** true = ผู้ดูแลขึ้นไป (เห็นปุ่มจัดการสมาชิก) */
  canManage: boolean
  /** ชื่อผู้ใช้สำหรับส่วนล่างของ sidebar (ให้เหมือนหน้าอื่น) */
  meName?: string
}

/**
 * init สำหรับ fetch — ประกาศเองเพราะ `RequestInit.body` เป็น union ของไบต์
 * ถ้าใช้ตรง ๆ แล้วส่ง object จะเป็น error ตอน compile
 */
type JsonInit = Omit<RequestInit, 'body'> & { body?: unknown }

/**
 * ช่วยยิง API แล้วโยนข้อความ error มาให้ขึ้นหน้าจอ
 *
 * ⚠️ ต้องไม่ส่ง `content-type` ตอนไม่มี body
 *   Fastify ตอบ 500 ว่า "Body cannot be empty when content-type is set to application/json"
 */
async function call(path: string, init?: JsonInit): Promise<void> {
  // แยก `body` ออกมาเอง — ถ้า spread ทั้งก้อน ชนิด `unknown` จะไปชนกับ `BodyInit` ของ fetch
  const { body, ...rest } = init ?? {}
  const res = await fetch(path, {
    ...rest,
    credentials: 'same-origin',
    ...(body !== undefined
      ? { headers: { 'content-type': 'application/json', ...(rest.headers ?? {}) } }
      : {}),
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  if (res.status === 204) return
  const b = await res.json().catch(() => null)
  if (!res.ok) throw new Error(b?.message ?? `ทำรายการไม่สำเร็จ (${res.status})`)
}

export default function TeamDetailPage({ initial, meSub, canManage, meName }: Props) {
  const [data, setData] = useState<TeamDetailData>(initial)
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [railOpen, setRailOpen] = useState(false)

  /** โหลดใหม่หลังทุกการเปลี่ยนแปลง เพื่อไม่ต้องเดา state ฝั่ง client */
  const reload = useCallback(async () => {
    const r = await fetch(`/api/teams/${encodeURIComponent(data.team)}`, {
      credentials: 'same-origin',
    })
    if (r.ok) setData(await r.json())
  }, [data.team])

  const run = async (fn: () => Promise<void>) => {
    setBusy(true)
    setErr(null)
    try {
      await fn()
      await reload()
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'ทำรายการไม่สำเร็จ')
    } finally {
      setBusy(false)
    }
  }

  const members = data.members ?? []
  const ownerCount = members.filter((m) => m.role === 'owner').length
  /** owner คนสุดท้าย = ลดสิทธิ์/ถอนไม่ได้ (ฝั่ง server บังคับซ้ำ แต่กันไว้ก่อนผู้ใช้กด) */
  const isLastOwner = (m: TeamMember) => m.role === 'owner' && ownerCount <= 1
  /**
   * ตัวระบุสมาชิกใน URL — คนที่ยังไม่เคยเข้าระบบยังไม่มี `sub` → ใช้อีเมลแทน
   * (ต้องตรงกับ `resolveMember` ใน API ที่ดูว่ามี `@` หรือเปล่า)
   *
   * ⚠️ เก็บเป็นค่า**ดิบ** ไม่ encode ตรงนี้
   *   เพราะค่านี้ยังถูกใช้เป็น `data-testid` และ `key` ของ React ด้วย
   *   ถ้า encode แล้ว `@` กลายเป็น `%40` → เทสต์มองหา testid ที่ไม่มีอยู่จริง
   *   (เจอตอนทดสอบ: เชิญสำเร็จ 200 แต่หาแถวไม่เจอ)
   *   encode เฉพาะตอนใส่ใน URL
   */
  const refOf = (m: TeamMember) => m.sub ?? m.email ?? ''
  /** ชื่อที่แสดง — คนที่รอผูกยังไม่มีชื่อจริง ให้โชว์อีเมลแทน */
  const labelOf = (m: TeamMember) => m.name ?? m.email ?? '(ไม่มีชื่อ)'

  return (
    <div className="shell">
      {/*
       * ⚠️ เดิมหน้านี้วาด `<aside className="rail">` เอง ไม่มี state เลย
       *   จอเล็ก CSS ซ่อน sidebar ไว้แต่**ไม่มีปุ่มไหนเปิดได้** → ผู้ใช้เดินหน้านี้แล้วกลับไม่ได้
       *   ตอนนี้ใช้ `AppRail` ตัวเดียวกับทุกหน้า หน้าตาจึงตรงกันทั้งจอใหญ่และจอเล็ก
       */}
      <AppRail
        subtitle="ทีมของฉัน"
        navLabel="เมนู"
        nav={<NavRailList current="/teams" onNavigate={() => setRailOpen(false)} />}
        navTestId="rail-list-nav"
        userName={meName}
        open={railOpen}
        onClose={() => setRailOpen(false)}
        testId="team-rail"
      />

      <div className="shell__main">
        <div className="pagebar">
          <RailMenuButton onOpen={() => setRailOpen(true)} />
          <h1 className="pagebar__title" data-testid="team-name">
            {data.name}
          </h1>
        </div>

        {/**
         * ⚠️ `width: '100%'` + `minWidth: 0` จำเป็น — คอลัมน์นี้เป็น flex item ของ `.shell__main`
         *   และถูกจัดขนาดแบบ **fit-content** ไม่ใช่ stretch → ความกว้างเท่ากับ min-content
         *   ของลูกที่กว้างที่สุด (แถวสมาชิก 363px + padding 48 = 411px) → ล้นจอ 390px
         *   การใส่ `minWidth: 0` อย่างเดียวไม่พอ เพราะ fit-content ยังต้อง ≥ min-content
         *   ระบุ `width: 100%` ตรง ๆ แล้วคอลัมน์ก็กว้างเท่าจอเสมอ ลูกข้างในพับเอง
         *   (`box-sizing: border-box` ตั้งไว้ทั้งโปรเจกต์แล้ว จึงรวม padding อยู่ใน 100%)
         */}
        <div
          style={{
            width: '100%',
            maxWidth: 860,
            margin: '0 auto',
            padding: '24px 24px 96px',
            minWidth: 0,
          }}
        >
          {err && (
            <div
              style={{
                background: 'var(--err-bg)',
                border: '1px solid var(--err)',
                borderRadius: 'var(--radius)',
                padding: '12px 16px',
                marginBottom: 18,
                fontSize: 14,
                color: 'var(--err)',
              }}
              data-testid="team-error"
            >
              {err}
            </div>
          )}

          <p style={{ fontSize: 13, color: 'var(--ink-3)', marginTop: 0 }}>
            สมาชิก {members.length} คน · แม่แบบของทีม {data.templateCount} ฉบับ
            {data.myRole && ` · สิทธิ์ของคุณ: ${ROLE_LABEL[data.myRole]}`}
          </p>

          {/* ── เชิญสมาชิก ───────────────────────────────────── */}
          {canManage && (
            <form
              data-testid="team-add-form"
              onSubmit={(e) => {
                e.preventDefault()
                const f = e.currentTarget
                const email = (f.elements.namedItem('email') as HTMLInputElement).value
                const role = (f.elements.namedItem('role') as HTMLSelectElement).value as TeamRole
                if (!email.trim()) return
                void run(async () => {
                  await call(`/api/teams/${encodeURIComponent(data.team)}/members`, {
                    method: 'POST',
                    body: { email: email.trim(), role },
                  })
                  f.reset()
                })
              }}
              style={{
                display: 'flex',
                gap: 10,
                marginBottom: 20,
                flexWrap: 'wrap',
                alignItems: 'center',
              }}
            >
              <input
                name="email"
                type="email"
                autoComplete="off"
                placeholder="อีเมลของคนที่จะเชิญ เช่น somchai@dopa.go.th"
                required
                data-testid="team-add-email"
                style={{
                  flex: 1,
                  minWidth: 240,
                  padding: '9px 14px',
                  border: '1px solid var(--line)',
                  borderRadius: 8,
                  font: 'inherit',
                  background: 'var(--surface)',
                  color: 'var(--ink)',
                }}
              />
              <select
                name="role"
                defaultValue="viewer"
                data-testid="team-add-role"
                style={{
                  padding: '9px 12px',
                  border: '1px solid var(--line)',
                  borderRadius: 8,
                  font: 'inherit',
                  background: 'var(--surface)',
                  color: 'var(--ink)',
                }}
              >
                {ASSIGNABLE.filter((r) => r !== 'owner').map((r) => (
                  <option key={r} value={r}>
                    {ASSIGN_LABEL[r]}
                  </option>
                ))}
              </select>
              <button type="submit" disabled={busy} data-testid="team-add-submit">
                เชิญ
              </button>
            </form>
          )}
          {canManage && (
            // ⚠️ `overflowWrap: anywhere` จำเป็น — ข้อความยาว ๆ ที่พักบรรทัดไม่ได้
            //   ทำให้คอลัมน์กว้าง 439px ที่จอ 390px แล้วล้นทั้งหน้า 111px
            //   (วัดได้ตอนทดสอบ: เพิ่ม `<p>` นี้แล้วหน้าทีมล้น — ซ่อนทีละบรรทัดไม่ได้ผล ต้องวัด min-content)
            <p
              style={{
                fontSize: 12,
                color: 'var(--ink-3)',
                margin: '-14px 0 20px',
                overflowWrap: 'anywhere',
              }}
            >
              เชิญด้วย<strong>อีเมล</strong> — คนที่ยังไม่เคยเข้าระบบจะขึ้นเป็น “รอเข้าระบบ”
              แล้วเข้าทีมอัตโนมัติในครั้งถัดไปที่เขาล็อกอิน
              {data.meEmail && (
                <>
                  {' '}
                  อีเมลของคุณคือ <code>{data.meEmail}</code>
                </>
              )}
            </p>
          )}

          {/* ── รายชื่อสมาชิก ─────────────────────────────────── */}
          <h2 style={{ fontSize: 15, color: 'var(--ink-2)', margin: '0 0 10px' }}>
            สมาชิก
          </h2>
          <div
            style={{
              background: 'var(--surface)',
              border: '1px solid var(--line)',
              borderRadius: 'var(--radius)',
              overflow: 'hidden',
            }}
          >
            {members.map((m, i) => {
              const ref = refOf(m)
              const refPath = encodeURIComponent(ref)
              return (
              <div
                key={ref}
                data-testid={`team-member-${ref}`}
                style={{
                  display: 'flex',
                  gap: 12,
                  alignItems: 'center',
                  padding: '12px 18px',
                  flexWrap: 'wrap',
                  borderTop: i > 0 ? '1px solid var(--line)' : undefined,
                  // เจ้าของทีมคนสุดท้าย = ห้ามถอนตัวเอง
                  opacity: m.sub === meSub && isLastOwner(m) ? 0.65 : 1,
                }}
              >
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ fontWeight: 600 }}>
                    {labelOf(m)}
                    {m.sub === meSub && (
                      <span style={{ color: 'var(--ink-3)', fontWeight: 400 }}> · คุณ</span>
                    )}
                    {m.pending && (
                      <span
                        className="pill"
                        style={{ marginLeft: 8, fontSize: 11 }}
                        data-testid={`team-member-pending-${ref}`}
                      >
                        รอเข้าระบบ
                      </span>
                    )}
                  </div>
                  <div
                    style={{
                      fontSize: 12,
                      color: 'var(--ink-3)',
                      fontFamily: 'ui-monospace, monospace',
                      wordBreak: 'break-all',
                    }}
                  >
                    {m.sub ?? m.email}
                  </div>
                </div>

                <span className="pill" data-testid={`team-member-role-${ref}`}>
                  {ASSIGN_LABEL[m.role]}
                </span>

                {canManage && (
                  /**
                   * ⚠️ `flexWrap: 'wrap'` จำเป็น — ชุดปุ่ม select+ถอน กว้าง 186px
                   *   ถ้าไม่ wrap จะกลายเป็น min-content ของแถว (363px)
                   *   แล้วดันคอลัมน์ให้กว้าง 411px → ล้นจอ 390px
                   *   (วัดได้ตอนทดสอบ — `minWidth: 0` ที่คอลัมน์ช่วยไม่ได้
                   *    เพราะคอลัมน์ถูกจัดขนาดแบบ fit-content ไม่ใช่ stretch)
                   */
                  <div
                    style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}
                  >
                    <select
                      value={m.role}
                      disabled={busy || isLastOwner(m) || m.sub === meSub}
                      title={
                        isLastOwner(m)
                          ? 'ทีมต้องมีเจ้าของอย่างน้อย 1 คน'
                          : m.sub === meSub
                            ? 'เปลี่ยนสิทธิ์ตัวเองไม่ได้ — ให้คนอื่นทำแทน'
                            : undefined
                      }
                      data-testid={`team-member-select-${ref}`}
                      onChange={(e) =>
                        void run(() =>
                          call(`/api/teams/${encodeURIComponent(data.team)}/members/${refPath}`, {
                            method: 'PATCH',
                            body: { role: e.target.value },
                          }),
                        )
                      }
                      style={{
                        padding: '6px 10px',
                        border: '1px solid var(--line)',
                        borderRadius: 8,
                        font: 'inherit',
                        background: 'var(--surface)',
                        color: 'var(--ink)',
                      }}
                    >
                      {ASSIGNABLE.map((r) => (
                        <option key={r} value={r}>
                          {ASSIGN_LABEL[r]}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      className="ghost"
                      disabled={busy || isLastOwner(m) || m.sub === meSub}
                      title={
                        isLastOwner(m)
                          ? 'ทีมต้องมีเจ้าของอย่างน้อย 1 คน'
                          : m.sub === meSub
                            ? 'ออกจากทีมตัวเองได้ถ้าไม่ใช่เจ้าของคนสุดท้าย'
                            : undefined
                      }
                      data-testid={`team-member-remove-${ref}`}
                      onClick={() =>
                        void run(() =>
                          call(`/api/teams/${encodeURIComponent(data.team)}/members/${refPath}`, {
                            method: 'DELETE',
                          }),
                        )
                      }
                      style={{ fontSize: 13, padding: '6px 12px' }}
                    >
                      ถอน
                    </button>
                  </div>
                )}
              </div>
              )
            })}
          </div>

          <p style={{ fontSize: 12, color: 'var(--ink-3)', marginTop: 14 }}>
            ทีมต้องมี<strong>เจ้าของอย่างน้อย 1 คน</strong> เสมอ — ถ้าจะถอนหรือลดสิทธิ์เจ้าของ
            ให้เลื่อนคนอื่นเป็นเจ้าของก่อน
          </p>

          {/* ── ลบทีม ───────────────────────────────────────── */}
          {data.myRole === 'owner' && (
            <div style={{ marginTop: 34 }}>
              <h2 style={{ fontSize: 15, color: 'var(--ink-2)', margin: '0 0 8px' }}>
                ลบทีม
              </h2>
              <p style={{ fontSize: 13, color: 'var(--ink-2)' }}>
                แม่แบบ {data.templateCount} ฉบับของทีม<strong>จะไม่ถูกลบ</strong> —
                จะถูกถอนกลับเป็นของผู้อัปโหลดแต่ละฉบับ
              </p>
              <button
                type="button"
                disabled={busy}
                data-testid="team-delete"
                onClick={() => {
                  if (!confirm(`ลบทีม "${data.name}" ใช่ไหม? แม่แบบจะถูกถอนกลับเป็นของเจ้าของเดิม`)) return
                  void run(async () => {
                    await call(`/api/teams/${encodeURIComponent(data.team)}`, { method: 'DELETE' })
                    location.href = '/teams'
                  })
                }}
                style={{ background: 'var(--err-bg)', color: 'var(--err)' }}
              >
                ลบทีมนี้
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
