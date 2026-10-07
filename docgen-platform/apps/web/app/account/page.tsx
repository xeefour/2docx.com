/**
 * หน้าบัญชีผู้ใช้ — `/account`
 *
 * ข้อมูลทั้งหมดมาจาก `GET /api/account` คำขอเดียว (โปรไฟล์ + สถิติ + ค่าตั้งค่า)
 *
 * ⚠️ เป็น client component เพราะต้องยิง API หลังผู้ใช้ล็อกอิน
 *   หน้าแรกเป็น server component เพราะต้องการ SEO — หน้านี้อยู่หลังล็อกอิน ไม่ต้อง
 *
 * ⚠️ แก้ชื่อ/อีเมลไม่ได้ที่นี่ (มาจาก Casdoor) แต่**เปลี่ยนรูปโปรไฟล์ได้**
 *   รูปที่อัปโหลดที่นี่เก็บแยกใน S3 และไม่แตะรูปที่ Casdoor
 *   → ชื่อกับรูปจึงมาจากคนละที่ ตั้งใจให้เป็นแบบนี้
 *   (ถ้าเก็บซ้ำที่ Casdoor ต้องเขียน API ของ Casdoor ด้วย ซึ่งเราไม่ได้ทำ)
 *
 * ── sidebar ────────────────────────────────────────────────────
 *   ใช้คลาส `.shell` / `.rail` ชุดเดียวกับ Studio (ดูคอมเมนต์ที่ `AccountRail.tsx`)
 *   รายการในเมนูเป็นส่วนของหน้าเดียวกัน → กดแล้วเลื่อนไป ไม่เปลี่ยนหน้า
 */
'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import type { AccountSummary, UpdateSettingsBody, UserSettings } from '@docgen/shared'
import AccountRail from './AccountRail'
import RailMenuButton from '../components/RailMenuButton'
import { CrossLinks } from '../components/NavLinks'
import type { TabDef } from '../studio/Tabs'

/** กลับมาที่หน้านี้หลังล็อกอินเสร็จ — `/auth/login` รับ `returnTo` อยู่แล้ว */
const RETURN_TO = '/account'

/** ขนาดรูปที่แนะนำ — API กันที่ 2 MB แต่บอกผู้ใช้ก่อนจะไม่เปลืองการอัปโหลด */
const MAX_AVATAR_MB = 2

type State =
  | { phase: 'loading' }
  | { phase: 'error'; message: string }
  | { phase: 'ready'; data: AccountSummary }

type Section = 'profile' | 'stats' | 'notify' | 'account'

/** แปลงวันที่เป็นภาษาไทยแบบอ่านง่าย */
function fmtDate(d: string | Date | null | undefined): string {
  if (!d) return 'ยังไม่เคยแก้'
  const date = typeof d === 'string' ? new Date(d) : d
  if (Number.isNaN(date.getTime())) return 'ยังไม่เคยแก้'
  return date.toLocaleString('th-TH', { dateStyle: 'medium', timeStyle: 'short' })
}

/** ตัวเลขให้อ่านง่ายขึ้น (12,345) */
function fmtNum(n: number): string {
  return n.toLocaleString('th-TH')
}

/** การ์ดตัวเลขสรุป */
function Stat({ label, value, hint }: { label: string; value: number; hint: string }) {
  return (
    <div
      style={{
        background: 'var(--surface)',
        border: '1px solid var(--line)',
        borderRadius: 'var(--radius)',
        padding: '14px',
      }}
    >
      <div style={{ fontSize: 12, color: 'var(--ink-3)' }}>{label}</div>
      <div style={{ fontSize: 26, fontWeight: 700, lineHeight: 1.3, letterSpacing: '-0.02em' }}>
        {fmtNum(value)}
      </div>
      <div style={{ fontSize: 11, color: 'var(--ink-3)' }}>{hint}</div>
    </div>
  )
}

/** สวิตช์เปิด/ปิด — ใช้ checkbox ซ่อนแล้ววาดเอง เพื่อให้กดด้วยคีย์บอร์ดได้ */
function Toggle({
  checked,
  onChange,
  label,
  hint,
  disabled,
  testId,
}: {
  checked: boolean
  onChange: (v: boolean) => void
  label: string
  hint: string
  disabled?: boolean
  testId: string
}) {
  return (
    <label
      style={{
        display: 'flex',
        gap: 12,
        alignItems: 'flex-start',
        padding: '12px 0',
        cursor: disabled ? 'default' : 'pointer',
        opacity: disabled ? 0.6 : 1,
      }}
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        data-testid={testId}
        style={{ width: 18, height: 18, marginTop: 3, accentColor: 'var(--brand)', flexShrink: 0 }}
      />
      <span>
        <span style={{ display: 'block', fontWeight: 600 }}>{label}</span>
        <span style={{ display: 'block', fontSize: 13, color: 'var(--ink-2)' }}>{hint}</span>
      </span>
    </label>
  )
}

/** หัวข้อของแต่ละส่วนในเนื้อหา — ใช้ทั้งเลื่อนไป (scroll-margin) และเป็นจุดอ้างอิงของ rail */
function SectionTitle({ id, children }: { id: Section; children: string }) {
  return (
    <h2
      id={`sec-${id}`}
      style={{
        fontSize: 15,
        margin: '0 0 10px',
        color: 'var(--ink-2)',
        // หัวข้อต้องไม่ถูกแถบบนของเบราว์เซอร์บังตอนกดจาก sidebar
        scrollMarginTop: 12,
      }}
    >
      {children}
    </h2>
  )
}

export default function AccountPage() {
  const [state, setState] = useState<State>({ phase: 'loading' })

  /** ค่าที่ผู้ใช้กำลังแก้ (ยังไม่บันทึก) — แยกจากค่าที่โหลดมา */
  const [draft, setDraft] = useState<UserSettings | null>(null)
  const [saving, setSaving] = useState(false)
  const [savedAt, setSavedAt] = useState<number | null>(null)

  // ── รูปโปรไฟล์ ────────────────────────────────────────────
  /**
   * เพิ่มค่านี้ทุกครั้งที่อัปโหลดสำเร็จ เพื่อบังคับให้ `<img>` โหลดใหม่
   * URL เดิมไม่เปลี่ยน (`/api/account/avatar`) และ API ตั้ง `no-store` ไว้
   * แต่เบราว์เซอร์บางตัวยังจดรูปที่เห็นไว้ → ใส่ query กันเหนียว
   */
  const [avatarRev, setAvatarRev] = useState(0)
  const [uploading, setUploading] = useState(false)
  const [avatarError, setAvatarError] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  // ── sidebar ────────────────────────────────────────────────
  const [section, setSection] = useState<Section>('profile')
  const [railOpen, setRailOpen] = useState(false)

  const load = useCallback(async () => {
    let alive = true
    try {
      const res = await fetch('/api/account', { credentials: 'same-origin' })

      // ยังไม่ล็อกอิน (หรือ session หมดอายุ) → พาไปล็อกอิน แล้วกลับมาที่หน้านี้
      if (res.status === 401) {
        window.location.href = `/auth/login?returnTo=${encodeURIComponent(RETURN_TO)}`
        return
      }
      if (!res.ok) throw new Error(`โหลดไม่สำเร็จ (${res.status})`)

      const data = (await res.json()) as AccountSummary
      if (!alive) return
      setState({ phase: 'ready', data })
      setDraft(data.settings)
    } catch (err) {
      if (!alive) return
      setState({
        phase: 'error',
        message: err instanceof Error ? err.message : 'โหลดไม่สำเร็จ',
      })
    }
    return () => {
      alive = false
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  /** แก้ค่าเดียว */
  const save = async (patch: UpdateSettingsBody) => {
    if (!draft) return
    setSaving(true)
    setSavedAt(null)
    try {
      const res = await fetch('/api/account/settings', {
        method: 'PUT',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(patch),
      })
      if (res.status === 401) {
        window.location.href = `/auth/login?returnTo=${encodeURIComponent(RETURN_TO)}`
        return
      }
      if (!res.ok) throw new Error(`บันทึกไม่สำเร็จ (${res.status})`)

      const b = await res.json()
      setDraft(b.settings)
      setState((s) => (s.phase === 'ready' ? { phase: 'ready', data: { ...s.data, ...b } } : s))
      setSavedAt(Date.now())
    } catch (err) {
      setState((s) =>
        s.phase === 'ready'
          ? s
          : { phase: 'error', message: err instanceof Error ? err.message : 'บันทึกไม่สำเร็จ' },
      )
    } finally {
      setSaving(false)
    }
  }

  /** อัปโหลดรูปใหม่ */
  const uploadAvatar = async (file: File) => {
    setAvatarError(null)

    // บอกผู้ใช้ก่อนที่จะยิง ไม่ใช่รอให้ API ปฏิเสธแล้วค่อยขึ้นข้อความ
    if (file.size > MAX_AVATAR_MB * 1024 * 1024) {
      setAvatarError(`ไฟล์ใหญ่เกิน ${MAX_AVATAR_MB} MB`)
      return
    }

    setUploading(true)
    try {
      const form = new FormData()
      form.set('avatar', file, file.name || 'avatar.png')
      // ⚠️ ห้ามตั้ง content-type เอง — ต้องให้เบราว์เซอร์เติม boundary ของ multipart
      const res = await fetch('/api/account/avatar', {
        method: 'PUT',
        credentials: 'same-origin',
        body: form,
      })
      if (res.status === 401) {
        window.location.href = `/auth/login?returnTo=${encodeURIComponent(RETURN_TO)}`
        return
      }
      if (!res.ok) {
        const b = await res.json().catch(() => null)
        throw new Error(b?.message ?? `อัปโหลดไม่สำเร็จ (${res.status})`)
      }

      setAvatarRev((n) => n + 1)
      setState((s) =>
        s.phase === 'ready'
          ? {
              phase: 'ready',
              data: { ...s.data, profile: { ...s.data.profile, hasCustomAvatar: true } },
            }
          : s,
      )
    } catch (err) {
      setAvatarError(err instanceof Error ? err.message : 'อัปโหลดไม่สำเร็จ')
    } finally {
      setUploading(false)
      // ล้างค่าใน input เพื่อให้เลือกไฟล์เดิมซ้ำแล้วยัง fire change
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  /** ลบรูปที่อัปโหลดเอง → กลับไปใช้รูปจาก Casdoor */
  const deleteAvatar = async () => {
    setAvatarError(null)
    setUploading(true)
    try {
      // ⚠️ ห้ามใส่ content-type — request นี้ไม่มี body
      //   Fastify จะตอบ 500 ว่า "Body cannot be empty when content-type is set to..."
      const res = await fetch('/api/account/avatar', {
        method: 'DELETE',
        credentials: 'same-origin',
      })
      if (!res.ok) throw new Error(`ลบไม่สำเร็จ (${res.status})`)

      setAvatarRev((n) => n + 1)
      setState((s) =>
        s.phase === 'ready'
          ? {
              phase: 'ready',
              data: { ...s.data, profile: { ...s.data.profile, hasCustomAvatar: false } },
            }
          : s,
      )
    } catch (err) {
      setAvatarError(err instanceof Error ? err.message : 'ลบไม่สำเร็จ')
    } finally {
      setUploading(false)
    }
  }

  /** กดเมนูใน sidebar → เลื่อนไปยังส่วนนั้น แล้วปิดลิ้นชัก (จอเล็ก) */
  const goSection = (id: string) => {
    setSection(id as Section)
    setRailOpen(false)
    document.getElementById(`sec-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  // ── ยังโหลดไม่เสร็จ ────────────────────────────────────────
  if (state.phase === 'loading') {
    return (
      <main style={{ maxWidth: 780, margin: '0 auto', padding: '64px 24px' }}>
        <p style={{ color: 'var(--ink-2)' }}>กำลังโหลดข้อมูลบัญชี…</p>
      </main>
    )
  }

  // ── โหลดไม่สำเร็จ ───────────────────────────────────────────
  if (state.phase === 'error') {
    return (
      <main style={{ maxWidth: 780, margin: '0 auto', padding: '64px 24px' }}>
        <div
          style={{
            background: 'var(--err-bg)',
            border: '1px solid var(--err)',
            borderRadius: 'var(--radius)',
            padding: '18px 20px',
          }}
        >
          <strong style={{ color: 'var(--err)' }}>โหลดข้อมูลไม่สำเร็จ</strong>
          <p style={{ margin: '6px 0 14px', color: 'var(--ink-2)' }}>{state.message}</p>
          <button onClick={() => void load()}>ลองใหม่</button>
        </div>
      </main>
    )
  }

  const { profile, stats } = state.data
  const avatarSrc = profile.hasCustomAvatar ? `/api/account/avatar?v=${avatarRev}` : profile.avatar

  const tabs: TabDef[] = [
    { id: 'profile', label: 'โปรไฟล์' },
    { id: 'stats', label: 'สรุปการใช้งาน' },
    { id: 'notify', label: 'การแจ้งเตือน' },
    { id: 'account', label: 'บัญชี' },
  ]

  return (
    <div className="shell">
      {/*
       * ส่วนล่าง (ชื่อผู้ใช้ + ออกจากระบบ) ย้ายไปอยู่ใน `RailFooter` ตัวเดียวกับทุกหน้า
       *   จึงเหลือส่ง `userName` (ย่อด้วย … อัตโนมัติ) กับลิงก์เสริมที่เฉพาะหน้านี้
       *   ชื่อผู้ใช้ที่ยาวจะไม่ล้นบรรทัดแล้ว เพราะกติกา ellipsis อยู่ที่ตัวเดียว
       */}
      <AccountRail
        tabs={tabs}
        active={section}
        onTab={goSection}
        open={railOpen}
        onClose={() => setRailOpen(false)}
        action={
          /**
           * ⚠️ ห้ามใส่ `className="rail__top"` ซ้ำ — `AccountRail` ห่อ action ด้วย
           *   `.rail__top` อยู่แล้ว การซ้อนจะได้โครงผิดจาก CSS ของ Studio
           *   (`.rail__top > label` เป็นตัวเลือกที่ Studio เขียนไว้สำหรับปุ่มอัปโหลด)
           */
          <div style={{ display: 'flex', justifyContent: 'center' }}>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
              <button
                type="button"
                onClick={() => fileRef.current?.click()}
                disabled={uploading}
                data-testid="account-avatar-pick"
                aria-label="เปลี่ยนรูปโปรไฟล์"
                title="เปลี่ยนรูปโปรไฟล์"
                style={{
                  // 56px = เทียบกับความหนาแน่นของ rail ที่มีอยู่
                  // รูปใหญ่กว่านี้จะดูเหมือนปุ่มหลักของหน้า ซึ่งไม่ใช่หน้าที่ของ rail
                  width: 56,
                  height: 56,
                  borderRadius: '50%',
                  padding: 0,
                  border: '1px dashed var(--brand-border)',
                  background: 'var(--brand-soft)',
                  color: 'var(--brand)',
                  overflow: 'hidden',
                  display: 'grid',
                  placeItems: 'center',
                  fontSize: 20,
                  fontWeight: 700,
                  position: 'relative',
                }}
              >
                {avatarSrc ? (
                  // eslint-disable-next-line @next/next/no-img-element -- URL มาจาก Casdoor/S3 ผ่าน API ของเรา ใช้ next/image ไม่ได้
                  <img
                    src={avatarSrc}
                    alt=""
                    data-testid="account-avatar-rail"
                    style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                  />
                ) : (
                  (profile.name || '?').trim().charAt(0)
                )}
                {uploading && (
                  <span
                    style={{
                      position: 'absolute',
                      inset: 0,
                      background: 'color-mix(in srgb, var(--surface) 75%, transparent)',
                      display: 'grid',
                      placeItems: 'center',
                      fontSize: 11,
                    }}
                  >
                    …
                  </span>
                )}
              </button>
              <span style={{ fontSize: 11, color: 'var(--ink-3)' }}>
                {uploading ? 'กำลังบันทึก…' : 'เปลี่ยนรูป'}
              </span>
            </div>
          </div>
        }
        userName={profile.name}
        extra={<CrossLinks current="/account" onNavigate={() => setRailOpen(false)} />}
      />

      <div className="shell__main">
        {/* ปุ่มเปิดลิ้นชัก — จอเล็กเท่านั้น (CSS ซ่อนให้เองบนจอใหญ่) */}
        <div className="pagebar">
          <RailMenuButton onOpen={() => setRailOpen(true)} />
          <h1 className="pagebar__title">บัญชีของฉัน</h1>
        </div>

        <div style={{ maxWidth: 780, margin: '0 auto', padding: '24px 24px 96px' }}>
          {/* input ซ่อนไว้ — ปุ่มใน sidebar เป็นตัวที่ผู้ใช้เห็น */}
          <input
            ref={fileRef}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            onChange={(e) => {
              const f = e.target.files?.[0]
              if (f) void uploadAvatar(f)
            }}
            style={{ display: 'none' }}
            data-testid="account-avatar-input"
          />

          {/* ── โปรไฟล์ ─────────────────────────────────────── */}
          <SectionTitle id="profile">โปรไฟล์</SectionTitle>
          <div
            style={{
              display: 'flex',
              gap: 18,
              alignItems: 'center',
              background: 'var(--surface)',
              border: '1px solid var(--line)',
              borderRadius: 'var(--radius)',
              boxShadow: 'var(--shadow)',
              padding: '22px 24px',
              marginBottom: 22,
            }}
            data-testid="account-profile"
          >
            <div style={{ flex: 'none' }}>
              {avatarSrc ? (
                // eslint-disable-next-line @next/next/no-img-element -- ดูคอมเมนต์ข้างบน
                <img
                  src={avatarSrc}
                  alt=""
                  data-testid="account-avatar"
                  width={64}
                  height={64}
                  style={{ borderRadius: '50%', objectFit: 'cover', display: 'block' }}
                />
              ) : (
                <div
                  style={{
                    width: 64,
                    height: 64,
                    borderRadius: '50%',
                    background: 'var(--brand-soft)',
                    color: 'var(--brand)',
                    display: 'grid',
                    placeItems: 'center',
                    fontSize: 26,
                    fontWeight: 700,
                  }}
                  aria-hidden
                >
                  {(profile.name || '?').trim().charAt(0)}
                </div>
              )}
            </div>

            <div style={{ minWidth: 0, flex: 1 }}>
              <h2 style={{ fontSize: 22, margin: 0, letterSpacing: '-0.01em' }}>{profile.name}</h2>
              <div style={{ color: 'var(--ink-2)', fontSize: 14 }}>{profile.email}</div>
              {profile.affiliation && (
                <div style={{ color: 'var(--ink-3)', fontSize: 13 }}>{profile.affiliation}</div>
              )}
              <div
                style={{
                  color: 'var(--ink-3)',
                  fontSize: 12,
                  marginTop: 4,
                  fontFamily: 'ui-monospace, monospace',
                  wordBreak: 'break-all',
                }}
                title="รหัสผู้ใช้จาก Casdoor (เปลี่ยนไม่ได้)"
              >
                {profile.sub}
              </div>

              <div
                style={{ display: 'flex', gap: 10, marginTop: 12, flexWrap: 'wrap', alignItems: 'center' }}
              >
                <button
                  type="button"
                  onClick={() => fileRef.current?.click()}
                  disabled={uploading}
                  data-testid="account-avatar-change"
                  style={{ fontSize: 13, padding: '7px 14px' }}
                >
                  {uploading ? 'กำลังบันทึก…' : profile.hasCustomAvatar ? 'เปลี่ยนรูป' : 'อัปโหลดรูป'}
                </button>
                {profile.hasCustomAvatar && (
                  <button
                    type="button"
                    onClick={() => void deleteAvatar()}
                    disabled={uploading}
                    data-testid="account-avatar-remove"
                    className="ghost"
                    style={{ fontSize: 13, padding: '7px 14px' }}
                  >
                    ลบรูป
                  </button>
                )}
                <span style={{ fontSize: 12, color: 'var(--ink-3)' }}>
                  PNG, JPEG หรือ WebP · สูงสุด {MAX_AVATAR_MB} MB
                </span>
              </div>

              {avatarError && (
                <p
                  style={{ color: 'var(--err)', fontSize: 13, margin: '8px 0 0' }}
                  data-testid="account-avatar-error"
                >
                  {avatarError}
                </p>
              )}
            </div>
          </div>

          {/* ── สถิติ ───────────────────────────────────────── */}
          <SectionTitle id="stats">สรุปการใช้งาน</SectionTitle>
          <div
            style={{
              display: 'grid',
              /*
               * 128px = 5 ใบลงในแถวเดียวพอดีที่ความกว้างเนื้อหา 780px
               * ถ้ากว้างกว่านี้ (minmax 150px) จะเหลือใบที่ 5 ลอยเดี่ยวแถวสอง
               */
              gridTemplateColumns: 'repeat(auto-fit, minmax(128px, 1fr))',
              gap: 12,
              marginBottom: 26,
            }}
            data-testid="account-stats"
          >
            <Stat label="แม่แบบที่บุ๊กมาร์ก" value={stats.bookmarks} hint="แม่แบบที่กดเก็บไว้" />
            <Stat label="แม่แบบของตัวเอง" value={stats.ownedTemplates} hint="ที่คุณเป็นเจ้าของ" />
            <Stat label="เอกสารที่สร้าง" value={stats.documents} hint="ทุกสถานะ" />
            <Stat label="ห้องแชท AI" value={stats.chats} hint="กับ AI" />
            <Stat label="จดหมายค้าง" value={stats.unreadNotifications} hint="ที่ยังไม่ได้อ่าน" />
          </div>

          {/* ── การแจ้งเตือน ─────────────────────────────────── */}
          <SectionTitle id="notify">การแจ้งเตือน</SectionTitle>
          <div
            style={{
              background: 'var(--surface)',
              border: '1px solid var(--line)',
              borderRadius: 'var(--radius)',
              padding: '6px 22px 18px',
              marginBottom: 26,
            }}
          >
            {draft && (
              <>
                <Toggle
                  testId="account-toggle-share"
                  checked={draft.notifyOnShare}
                  disabled={saving}
                  onChange={(v) => {
                    setDraft({ ...draft, notifyOnShare: v })
                    void save({ notifyOnShare: v })
                  }}
                  label="มีคนแชร์แม่แบบให้"
                  hint="แจ้งเตือนในกล่องจดหมายเมื่อมีคนแชร์แม่แบบมาให้คุณ"
                />
                <div style={{ height: 1, background: 'var(--line)' }} />
                <Toggle
                  testId="account-toggle-document"
                  checked={draft.notifyOnDocument}
                  disabled={saving}
                  onChange={(v) => {
                    setDraft({ ...draft, notifyOnDocument: v })
                    void save({ notifyOnDocument: v })
                  }}
                  label="งานเอกสารเสร็จหรือล้มเหลว"
                  hint="แจ้งเตือนเมื่อเอกสารที่คุณสั่งสร้างเสร็จ หรือสร้างไม่สำเร็จ"
                />
              </>
            )}

            <p style={{ fontSize: 12, color: 'var(--ink-3)', margin: '14px 0 0' }}>
              การแจ้งเตือนเรื่อง<strong>สิทธิ์</strong> (เปลี่ยนสิทธิ์ · ถูกถอนสิทธิ์) ปิดไม่ได้
              เพราะถ้าไม่รู้ ผู้ใช้จะเปิดแม่แบบแล้วเจอ 403 โดยไม่มีคำอธิบาย
            </p>

            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 12,
                marginTop: 14,
                fontSize: 13,
                color: 'var(--ink-3)',
                flexWrap: 'wrap',
              }}
            >
              {saving && <span>กำลังบันทึก…</span>}
              {!saving && savedAt && (
                <span style={{ color: 'var(--ok)' }} data-testid="account-saved">
                  บันทึกแล้ว
                </span>
              )}
              {!saving && !savedAt && <span>แก้ค่าเมื่อไหร่ บันทึกให้อัตโนมัติ</span>}
              <span style={{ marginLeft: 'auto' }}>
                แก้ค่าล่าสุด {fmtDate(state.data.settingsUpdatedAt)}
              </span>
            </div>
          </div>

          {/* ── บัญชี ───────────────────────────────────────── */}
          <SectionTitle id="account">บัญชี</SectionTitle>
          <div
            style={{
              background: 'var(--surface)',
              border: '1px solid var(--line)',
              borderRadius: 'var(--radius)',
              padding: '18px 22px',
              display: 'flex',
              flexWrap: 'wrap',
              gap: 12,
              alignItems: 'center',
            }}
          >
            <p style={{ margin: 0, fontSize: 13, color: 'var(--ink-2)', flex: 1, minWidth: 220 }}>
              ชื่อ อีเมล และรูปโปรไฟล์มาจาก Casdoor — ระบบนี้ไม่เก็บซ้ำสองที่
              (รูปที่อัปโหลดด้านบนเป็นของแยกที่เก็บในระบบเรา)
            </p>
            <Link
              href="/studio"
              className="ghost"
              style={{
                textDecoration: 'none',
                padding: '8px 14px',
                border: '1px solid var(--line)',
                borderRadius: 8,
                color: 'var(--ink-2)',
                fontSize: 14,
              }}
            >
              กลับไป Studio
            </Link>
            {/* ⚠️ auth route ไม่ได้อยู่ใต้ /api — ใช้ /auth/logout */}
            <a
              href="/auth/logout"
              style={{
                textDecoration: 'none',
                padding: '8px 14px',
                background: 'var(--err-bg)',
                color: 'var(--err)',
                borderRadius: 8,
                fontSize: 14,
              }}
            >
              ออกจากระบบ
            </a>
          </div>
        </div>
      </div>
    </div>
  )
}
