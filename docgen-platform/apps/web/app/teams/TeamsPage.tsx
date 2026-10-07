'use client'

import Link from 'next/link'
import { useState } from 'react'
import type { TeamAccess } from '@docgen/shared'
import AppRail from '../components/AppRail'
import RailMenuButton from '../components/RailMenuButton'
import { NavRailList } from '../components/NavLinks'

/**
 * หน้ารายชื่อทีม — `/teams`
 *
 * ใช้ `AppRail` ตัวเดียวกับ `/studio` และ `/account`
 * (ดูเหตุผลที่รวมโครงไว้ที่นั่น) → ไม่ต้องเขียน CSS ซ้ำ และหน้าตาไม่เพี้ยนไปเอง
 *
 * ⚠️ เดิมหน้านี้วาด `<aside className="rail">` เอง ไม่มี state เลย
 *   จอเล็ก CSS ซ่อน sidebar ไว้ แต่**ไม่มีปุ่มไหนเปิดได้** → ผู้ใช้เดินหน้านี้แล้วกลับไม่ได้
 */
export default function TeamsPage({
  teams,
  meName,
  meSub,
  meEmail,
}: {
  teams: TeamAccess[]
  meName: string
  meSub: string
  meEmail: string
}) {
  const [railOpen, setRailOpen] = useState(false)

  return (
    <div className="shell">
      <AppRail
        subtitle="ทีมของฉัน"
        navLabel="เมนู"
        nav={<NavRailList current="/teams" onNavigate={() => setRailOpen(false)} />}
        navTestId="rail-list-nav"
        userName={meName}
        open={railOpen}
        onClose={() => setRailOpen(false)}
        testId="teams-rail"
      />

      <div className="shell__main">
        <div className="pagebar">
          <RailMenuButton onOpen={() => setRailOpen(true)} />
          <h1 className="pagebar__title">ทีมของฉัน</h1>
        </div>

        {/**
         * ⚠️ `width: '100%'` + `minWidth: 0` — คอลัมน์เป็น flex item ที่ถูกจัดขนาดแบบ fit-content
         *   ถ้าไม่กำหนดความกว้างตรง ๆ เนื้อหากว้างจะดันคอลัมน์ล้นจอเล็ก
         *   (box-sizing: border-box ตั้งไว้ทั้งโปรเจกต์แล้ว)
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
          {/* ── สร้างทีม ─────────────────────────────────────── */}
          <form
            data-testid="teams-create-form"
            onSubmit={async (e) => {
              e.preventDefault()
              const f = e.currentTarget
              const name = (f.elements.namedItem('name') as HTMLInputElement).value
              if (!name.trim()) return
              await fetch('/api/teams', {
                method: 'POST',
                credentials: 'same-origin',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ name }),
              })
              f.reset()
              location.reload()
            }}
            style={{
              display: 'flex',
              gap: 10,
              marginBottom: 24,
              flexWrap: 'wrap',
              alignItems: 'center',
            }}
          >
            <input
              name="name"
              placeholder="ชื่อทีมใหม่ เช่น ฝ่ายสารบรรณ"
              maxLength={120}
              required
              data-testid="teams-create-name"
              style={{
                flex: 1,
                minWidth: 220,
                padding: '9px 14px',
                border: '1px solid var(--line)',
                borderRadius: 8,
                font: 'inherit',
                background: 'var(--surface)',
                color: 'var(--ink)',
              }}
            />
            <button type="submit" data-testid="teams-create-submit">
              สร้างทีม
            </button>
          </form>

          {teams.length === 0 ? (
            <div
              className="card"
              style={{ padding: 24, textAlign: 'center', color: 'var(--ink-2)' }}
              data-testid="teams-empty"
            >
              <p style={{ margin: 0 }}>ยังไม่มีทีม</p>
              <p style={{ margin: '6px 0 0', fontSize: 13, color: 'var(--ink-3)' }}>
                สร้างทีมเพื่อให้หลายคนใช้แม่แบบชุดเดียวกันได้
              </p>
            </div>
          ) : (
            <div style={{ display: 'grid', gap: 12 }} data-testid="teams-list">
              {teams.map((t) => (
                <Link
                  key={t.team}
                  href={`/teams/${encodeURIComponent(t.team)}`}
                  className="card"
                  style={{ textDecoration: 'none', display: 'block' }}
                  data-testid={`teams-card-${t.team}`}
                >
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 12,
                      flexWrap: 'wrap',
                    }}
                  >
                    <strong style={{ fontSize: 17 }}>{t.name}</strong>
                    <span className="pill" data-testid={`teams-role-${t.team}`}>
                      {ROLE_LABEL[t.role ?? 'viewer']}
                    </span>
                    <span
                      style={{
                        marginLeft: 'auto',
                        fontSize: 13,
                        color: 'var(--ink-3)',
                      }}
                    >
                      สมาชิก {t.memberCount} · แม่แบบ {t.templateCount}
                    </span>
                  </div>
                </Link>
              ))}
            </div>
          )}

          <p style={{ fontSize: 12, color: 'var(--ink-3)', marginTop: 28 }}>
            แม่แบบของทีมจะถูกตั้งเป็นแบบส่วนตัวโดยอัตโนมัติ — ทุกคนที่ย้ายเข้าทีมแล้ว
            แก้ไขได้ตามสิทธิ์ที่มี คนนอกทีมเข้าไม่ได้
          </p>
          <p style={{ fontSize: 12, color: 'var(--ink-3)' }}>
            เชิญสมาชิกด้วย<strong>อีเมล</strong> — คนที่ยังไม่เคยเข้าระบบจะขึ้นเป็น “รอเข้าระบบ”
            แล้วเข้าทีมอัตโนมัติในครั้งถัดไปที่เขาล็อกอิน
          </p>
          {/* ⚠️ `overflowWrap: anywhere` — อีเมล/รหัสผู้ใช้ยาวและพักบรรทัดไม่ได้
           *   ถ้าไม่ใส่ คอลัมน์จะกว้างเกินจอเล็กแล้วล้นทั้งหน้า (เจอตอนทดสอบที่ 390px) */}
          <p
            style={{
              fontSize: 12,
              color: 'var(--ink-3)',
              marginTop: 6,
              overflowWrap: 'anywhere',
            }}
          >
            อีเมลของคุณคือ <code data-testid="teams-my-email">{meEmail || '(ยังไม่มีใน Casdoor)'}</code>
            {' — '}
            ใช้ตอนเจ้าของทีมเชิญคุณ
            <br />
            รหัสผู้ใช้ของคุณคือ <code>{meSub}</code>
          </p>
        </div>
      </div>
    </div>
  )
}

export const ROLE_LABEL: Record<string, string> = {
  owner: 'เจ้าของทีม',
  admin: 'ผู้ดูแล',
  editor: 'ผู้แก้ไข',
  viewer: 'ผู้ดู',
}
