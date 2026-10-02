'use client'

/**
 * แท็บ "แม่แบบ & การแชร์"
 *
 * ซ้าย: metadata ที่แก้ได้ (ชื่อ/หมวด/แท็ก) — ไปที่ Carbone
 * ขวา: ใครมีสิทธิ์ใช้แม่แบบนี้ — เก็บใน Mongo ของเราเอง
 */
import { useRef, useState } from 'react'
import { api, ApiError, type AccessView, type Template } from './lib/api'

/** ชนิดไฟล์ที่ Carbone รับได้ — ต้องตรงกับ ALLOWED_EXT ของ API */
const ACCEPT = '.docx,.xlsx,.pptx,.odt,.ods,.odp,.doc,.odf'

export default function SharePanel({
  template,
  access,
  onAccess,
  notify,
}: {
  template: Template
  access: AccessView | null
  onAccess: (a: AccessView) => void
  notify: (msg: string) => void
}) {
  const [name, setName] = useState('')
  const [category, setCategory] = useState(template.category ?? '')
  const [tagsText, setTagsText] = useState(template.tags.join(', '))
  const [busy, setBusy] = useState(false)
  const [sub, setSub] = useState('')
  const [role, setRole] = useState<'viewer' | 'editor'>('viewer')
  /** ไฟล์ที่เลือกไว้แต่ยังไม่ยืนยัน — ต้องกดยืนยันอีกครั้ง เพราะการเขียนทับกระทบทุกคน */
  const [pendingFile, setPendingFile] = useState<File | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const isOwner = access?.relation === 'owner'
  /**
   * ยังไม่มีใครตั้งค่าแม่แบบนี้ → คนแรกที่กดกลายเป็นเจ้าของ (ตรงกับฝั่ง API)
   *
   * ⚠️ ต้องแสดงปุ่มด้วยแม้ยังไม่ใช่เจ้าของ
   *    ถ้าไม่แสดง ผู้ใช้จะไม่มีทางขอเป็นเจ้าของผ่านหน้าเว็บเลย
   */
  const noOwnerYet = access?.owner === null || access === null
  const canManage = isOwner || noOwnerYet
  const canEdit = access?.canEdit ?? true

  async function run(fn: () => Promise<void>) {
    setBusy(true)
    try {
      await fn()
    } catch (e) {
      notify(e instanceof ApiError ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const saveMeta = () =>
    run(async () => {
      await api.updateTemplate(template.versionId, {
        name: template.name,
        category: category.trim(),
        tags: tagsText
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
      })
      notify('บันทึกข้อมูลแม่แบบแล้ว')
    })

  const setVis = (visibility: 'private' | 'published') =>
    run(async () => {
      onAccess(await api.setVisibility(templateKeyOfTemplate(template), visibility))
      notify(visibility === 'private' ? 'ตั้งเป็นแบบส่วนตัวแล้ว' : 'เปิดเป็นสาธารณแล้ว')
    })

  /**
   * อัปโหลดไฟล์ใหม่แทนแม่แบบเดิม
   *
   * ส่งชื่อ/หมวด/แท็กของเดิมไปด้วย เพื่อให้เวอร์ชันใหม่ไม่ต้องมากรอก metadata ใหม่
   */
  const doReplace = () =>
    run(async () => {
      if (!pendingFile) return
      await api.replaceTemplate(templateKeyOfTemplate(template), pendingFile, {
        name: template.name ?? '',
        category: category.trim(),
        tags: template.tags,
      })
      setPendingFile(null)
      if (fileRef.current) fileRef.current.value = ''
      notify(
        'บันทึกเป็นเวอร์ชันใหม่ของแม่แบบนี้แล้ว (ช่องฟอร์มและสิทธิ์เดิมยังอยู่) ' +
          '— ถ้ารายการยังเปิดไฟล์เดิมอยู่ ให้กดรีเฟรชหน้า',
      )
    })

  return (
    <div style={{ display: 'grid', gap: 16, gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))' }}>
      {/* ── metadata ── */}
      <div className="card" style={{ padding: 16 }}>
        <h2 style={{ margin: '0 0 12px', fontSize: 15 }}>ข้อมูลแม่แบบ</h2>
        <div style={{ display: 'grid', gap: 12 }}>
          <div>
            <label>ชื่อ</label>
            <input value={template.name ?? ''} disabled onChange={() => {}} readOnly />
          </div>
          <div>
            <label>หมวด</label>
            <input
              value={category}
              disabled={!canEdit || busy}
              onChange={(e) => setCategory(e.target.value)}
            />
          </div>
          <div>
            <label>แท็ก (คั่นด้วยจุลภาค)</label>
            <input
              value={tagsText}
              disabled={!canEdit || busy}
              onChange={(e) => setTagsText(e.target.value)}
            />
          </div>
          <div>
            <label>versionId</label>
            <div className="mono" style={{ fontSize: 12, color: 'var(--ink-3)' }}>
              {template.versionId}
            </div>
          </div>
          <button onClick={() => void saveMeta()} disabled={!canEdit || busy}>
            บันทึกข้อมูลแม่แบบ
          </button>
        </div>

        {/* ── ไฟล์แม่แบบ: ดาวน์โหลด / อัปโหลดแทน ── */}
        <div
          style={{
            marginTop: 16,
            paddingTop: 14,
            borderTop: '1px solid var(--line)',
            display: 'grid',
            gap: 10,
          }}
        >
          <div style={{ fontSize: 13, fontWeight: 500 }}>ไฟล์แม่แบบ</div>

          <a
            className="ghost"
            href={api.templateFileUrl(templateKeyOfTemplate(template))}
            download
            data-testid="template-download"
            style={{ textAlign: 'center', textDecoration: 'none' }}
          >
            ⬇️ ดาวน์โหลดแม่แบบ
          </a>

          {canEdit ? (
            <>
              <input
                ref={fileRef}
                type="file"
                accept={ACCEPT}
                data-testid="template-file"
                onChange={(e) => setPendingFile(e.target.files?.[0] ?? null)}
                style={{ display: 'none' }}
              />
              <button
                className="ghost"
                disabled={busy}
                data-testid="template-replace"
                onClick={() => fileRef.current?.click()}
              >
                ⬆️ อัปโหลดแม่แบบใหม่แทน
              </button>

              {pendingFile && (
                <div
                  className="pill warn"
                  style={{ padding: '10px 12px', display: 'block', lineHeight: 1.5 }}
                >
                  <div style={{ marginBottom: 8 }}>
                    จะแทนไฟล์ <b>{pendingFile.name}</b> (
                    {(pendingFile.size / 1024).toFixed(0)} KB)
                    <br />
                    เป็น<b>เวอร์ชันใหม่</b>ของแม่แบบนี้ — ช่องฟอร์มและสิทธิ์เดิมยังอยู่
                    แต่ตัวอย่างเอกสารเดิมจะเป็นของเวอร์ชันเก่า
                  </div>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button
                      className="ghost danger"
                      disabled={busy}
                      onClick={() => {
                        setPendingFile(null)
                        if (fileRef.current) fileRef.current.value = ''
                      }}
                    >
                      ยกเลิก
                    </button>
                    <button disabled={busy} onClick={() => void doReplace()}>
                      {busy ? 'กำลังอัปโหลด…' : 'ยืนยันแทนไฟล์เดิม'}
                    </button>
                  </div>
                </div>
              )}
            </>
          ) : (
            <p className="muted" style={{ fontSize: 12.5, margin: 0 }}>
              คุณมีสิทธิ์แค่ดูอย่างเดียว — จึงดาวน์โหลดได้แต่แทนไฟล์ไม่ได้
            </p>
          )}
        </div>
      </div>

      {/* ── การแชร์ ── */}
      <div className="card" style={{ padding: 16 }}>
        <h2 style={{ margin: '0 0 4px', fontSize: 15 }}>การแชร์และสิทธิ์</h2>
        <p className="muted" style={{ margin: '0 0 12px', fontSize: 12 }}>
          {isOwner
            ? 'คุณเป็นเจ้าของแม่แบบนี้'
            : noOwnerYet
              ? 'ยังไม่มีเจ้าของ — คนแรกที่ตั้งค่าด้านล่างจะกลายเป็นเจ้าของ'
              : access?.relation === 'shared'
                ? `ถูกแชร์ให้คุณ (สิทธิ์: ${access.role === 'editor' ? 'แก้ไขได้' : 'ดูอย่างเดียว'})`
                : 'แม่แบบนี้เปิดสาธารณ — ผู้ได้สิทธิ์ทุกคนแก้ไขได้'}
        </p>

        {/* สิทธิ์ของฉัน */}
        <div className="pill" style={{ marginBottom: 12 }}>
          {access?.visibility === 'private' ? '🔒 แบบส่วนตัว' : '🌐 เปิดสาธารณ'}
          {access?.ownerName ? ` · เจ้าของ: ${access.ownerName}` : ''}
        </div>

        {canManage ? (
          <>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 14 }}>
              <button
                className="ghost"
                disabled={busy}
                onClick={() => void setVis('published')}
                style={{
                  borderColor: access?.visibility === 'published' ? 'var(--brand)' : undefined,
                }}
              >
                🌐 เปิดสาธารณ
              </button>
              <button
                className="ghost"
                disabled={busy}
                onClick={() => void setVis('private')}
                style={{ borderColor: access?.visibility === 'private' ? 'var(--brand)' : undefined }}
              >
                🔒 แบบส่วนตัว
              </button>
              {isOwner && (
                <button
                  className="ghost danger"
                  disabled={busy}
                  title="ล้างการตั้งค่าทั้งหมด → กลับเป็นเปิดสาธารณแบบเริ่มต้น"
                  onClick={() =>
                    void run(async () => {
                      await api.clearAccess(templateKeyOfTemplate(template))
                      onAccess(await api.getAccess(templateKeyOfTemplate(template)))
                      notify('ล้างการตั้งค่าการแชร์แล้ว')
                    })
                  }
                >
                  ล้างการตั้งค่า
                </button>
              )}
            </div>

            <h3 style={{ fontSize: 13, margin: '0 0 8px' }}>
              อนุญาตให้ใครใช้ได้ ({access?.sharedWith.length ?? 0})
            </h3>
            {access?.sharedWith.length === 0 && (
              <p className="muted" style={{ fontSize: 12.5, margin: '0 0 10px' }}>
                ยังไม่ได้แชร์ให้ใคร
              </p>
            )}

            <div style={{ display: 'grid', gap: 6, marginBottom: 12 }}>
              {(access?.sharedWith ?? []).map((s) => (
                <div className="who" key={s.sub}>
                  <div className="avatar">{(s.name ?? s.sub).slice(0, 1).toUpperCase()}</div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="who__name">{s.name ?? '(ไม่ทราบชื่อ)'}</div>
                    <div className="who__meta mono">{s.sub}</div>
                  </div>
                  <select
                    value={s.role}
                    disabled={busy}
                    style={{ width: 'auto', fontSize: 12.5 }}
                    onChange={(e) =>
                      void run(async () => {
                        onAccess(
                          await api.share(
                            templateKeyOfTemplate(template),
                            s.sub,
                            e.target.value as 'viewer' | 'editor',
                            s.name ?? undefined,
                          ),
                        )
                      })
                    }
                  >
                    <option value="viewer">ดูอย่างเดียว</option>
                    <option value="editor">แก้ไขได้</option>
                  </select>
                  <button
                    className="ghost danger"
                    disabled={busy}
                    style={{ padding: '4px 9px', fontSize: 12 }}
                    onClick={() =>
                      void run(async () => {
                        onAccess(await api.unshare(templateKeyOfTemplate(template), s.sub))
                        notify('ถอนสิทธิ์แล้ว')
                      })
                    }
                  >
                    ถอน
                  </button>
                </div>
              ))}
            </div>

            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
              <div style={{ flex: 1, minWidth: 200 }}>
                <label>subject ของผู้ใช้ (จาก Casdoor)</label>
                <input
                  value={sub}
                  disabled={busy}
                  placeholder="เช่น 1a2b3c4d-…"
                  onChange={(e) => setSub(e.target.value)}
                />
              </div>
              <div>
                <label>สิทธิ์</label>
                <select
                  value={role}
                  disabled={busy}
                  onChange={(e) => setRole(e.target.value as 'viewer' | 'editor')}
                >
                  <option value="viewer">ดูอย่างเดียว</option>
                  <option value="editor">แก้ไขได้</option>
                </select>
              </div>
              <button
                disabled={busy || !sub.trim()}
                onClick={() =>
                  void run(async () => {
                    onAccess(await api.share(templateKeyOfTemplate(template), sub.trim(), role))
                    setSub('')
                    notify('เพิ่มสิทธิ์แล้ว')
                  })
                }
              >
                เพิ่ม
              </button>
            </div>
          </>
        ) : (
          <p className="muted" style={{ fontSize: 12.5, margin: 0 }}>
            เฉพาะเจ้าของแม่แบบเท่านั้นที่เปลี่ยนการตั้งค่านี้ได้
            {access?.ownerName ? ` (เจ้าของคือ ${access.ownerName})` : ''}
          </p>        )}
      </div>
    </div>
  )
}

/** key ที่ใช้ผูกข้อมูลทั้งหมด — ต้องตรงกับที่ใช้ทั่วระบบ */
function templateKeyOfTemplate(t: Template): string {
  return String(t.id ?? t.versionId)
}
