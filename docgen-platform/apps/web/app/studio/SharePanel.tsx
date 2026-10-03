'use client'

/**
 * แท็บ "แม่แบบ & การแชร์"
 *
 * ซ้าย: metadata ที่แก้ได้ (ชื่อ/หมวด/แท็ก) — ไปที่ Carbone
 * ขวา: ใครมีสิทธิ์ใช้แม่แบบนี้ — เก็บใน Mongo ของเราเอง
 */
import { useEffect, useRef, useState } from 'react'
import { api, ApiError, templateKeyOf, type AccessView, type Template } from './lib/api'
import { copyText } from './lib/copy'
import TemplatePreviews from './TemplatePreviews'

/** ชนิดไฟล์ที่ Carbone รับได้ — ต้องตรงกับ ALLOWED_EXT ของ API */
const ACCEPT = '.docx,.xlsx,.pptx,.odt,.ods,.odp,.doc,.odf'

export default function SharePanel({
  template,
  access,
  onAccess,
  notify,
  onDeleted,
  part = 'all',
}: {
  template: Template
  access: AccessView | null
  onAccess: (a: AccessView) => void
  notify: (msg: string) => void
  /**
   * ลบแม่แบบเสร็จ → หน้าแรกต้องรีโหลด (แม่แบบหายจากรายการแล้ว)
   * แยกเป็น prop เพราะ `SharePanel` ไม่รู้ว่าใครเป็นเจ้าของหน้า
   */
  onDeleted: () => void
  /**
   * แสดงการ์ดไหนบ้าง
   *
   * ⚠️ ผู้ใช้สั่งให้ย้ายการ์ด "การแชร์และสิทธิ์" ไปอยู่ในแท็บของตัวเอง
   *   เดิมทั้งสองการ์ดอยู่ในแท็บเดียวกัน ("แม่แบบ & การแชร์") ทำให้แท็บนั้นยาวมาก
   *   และชื่อแท็บก็ไม่ตรงกับเนื้อหาอีกแล้ว
   *   · `meta`   = การ์ด "ข้อมูลแม่แบบ" (ชื่อ/หมวด/แท็ก/ไฟล์/ลบแม่แบบ)
   *   · `access` = การ์ด "การแชร์และสิทธิ์" (สิทธิ์/ลิงก์สาธารณ/ผู้ได้รับ)
   *   · `all`    = ทั้งสองการ์ด (ค่าเริ่มต้น — ใช้ตอนยังไม่ได้แยกแท็บ)
   */
  part?: 'all' | 'meta' | 'access'
}) {
  const [name, setName] = useState('')
  const [category, setCategory] = useState(template.category ?? '')
  const [tagsText, setTagsText] = useState(template.tags.join(', '))
  const [busy, setBusy] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [sub, setSub] = useState('')
  const [role, setRole] = useState<'viewer' | 'editor'>('viewer')
  /** ไฟล์ที่เลือกไว้แต่ยังไม่ยืนยัน — ต้องกดยืนยันอีกครั้ง เพราะการเขียนทับกระทบทุกคน */
  const [pendingFile, setPendingFile] = useState<File | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  /**
   * ปุ่มคัดลอกลิงก์ — ต้องบอกผล**บนตัวปุ่ม** ไม่ใช่รอ Banner บนสุด
   *
   * ⚠️ ผู้ใช้สั่ง: *"ผมคลิก copy link แล้ว แต่ไม่รู้ว่ามัน copy ได้ ระบบแจ้งเตือนแต่อยู่บนสุด
   *     โดยเฉพาะหน้าจอขนาดเล็ก"*
   *
   *   เดิมยืนยันผลแค่ผ่าน `notify()` = Banner ที่ Studio.tsx วางไว้**เหนือ**
   *     `TemplateEditor` ทั้งก้อน (Studio.tsx:282) ส่วนการ์ด "ลิงก์สาธารณ" ที่ผู้ใช้
   *     กดอยู่อยู่ท้ายแท็บขวา → ห่างกันหลายจอเล็ก พอเลื่อนไปมองที่กดปุ่ม
   *     ป้ายเตือนก็เลย่อนไปแล้ว ผู้ใช้เลยคิดว่ากดไม่ติด
   *
   *   ยังเรียก `notify()` เหมือนเดิม เผื่อผู้ใช้เลื่อนขึ้นไปเจอ Banner
   *   (แต่คราวนี้ไม่ต้องพึ่งมันแล้ว)
   */
  const [copied, setCopied] = useState<'ok' | 'err' | null>(null)
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // ปุ่มหายไปก่อนครบเวลา (สลับแท็บ/ปิดแม่แบบ) → ห้ามทิ้ง timer ค้าง
  useEffect(
    () => () => {
      if (copiedTimer.current) clearTimeout(copiedTimer.current)
    },
    []
  )

  /** กดคัดลอกแล้วเปลี่ยนป้ายปุ่มชั่วคราว แล้วคืนป้ายเดิม */
  function flashCopied(next: 'ok' | 'err') {
    setCopied(next)
    if (copiedTimer.current) clearTimeout(copiedTimer.current)
    copiedTimer.current = setTimeout(() => setCopied(null), 2000)
  }

  const isOwner = access?.relation === 'owner'

  /**
   * ── ลิงก์สาธารณ ──
   *
   * ผู้ใช้สั่ง: *"เลือกเปิดสาธารณแล้ว ให้แสดง url ด้วย"*
   * เพราะตอนกด "เปิดสาธารณ" เดิมได้แค่ข้อความว่าเปิดแล้ว
   * แต่ผู้ใช้ยังหา**ลิงก์ที่จะส่งให้คนอื่น**ไม่เจอ ต้องไปเดาเองจากแถบ URL
   *
   * ⚠️ ต้องอ่าน origin หลัง mount เท่านั้น
   *   `window` ไม่มีตอน Next prerender ฝั่งเซิร์ฟเวอร์
   *   ถ้าใช้ตรง ๆ ใน render จะพังตอน build (`window is not defined`)
   *   ตอน mount เสร็จค่อยเติม — ก่อนหน้านั้นแสดง "…" ไปก่อน
   *
   * ⚠️ URL นี้ต้อง**ไม่มี query string**
   *   ตอนผู้ใช้เปิดอยู่ในแท็บ "แม่แบบ" URL จะมี `?tabs=form&pane=template` ติดมาด้วย
   *   ถ้าเอาไปส่งตรง ๆ คนอื่นจะเปิดหน้าในสถานะเดียวกับผู้ส่ง ซึ่งไม่ใช่สิ่งที่ตั้งใจ
   *   เพราะฉะนั้นต้องประกอบเองจาก origin + key เท่านั้น
   */
  const [origin, setOrigin] = useState('')
  useEffect(() => setOrigin(window.location.origin), [])
  const publicUrl = origin ? `${origin}/studio/${templateKeyOfTemplate(template)}` : ''

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
      {(part === 'all' || part === 'meta') && (
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
          <button onClick={() => void saveMeta()} disabled={!canEdit || busy} data-testid="template-save-meta">
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

          {/**
           * ⚠️ ผูกกับ `canManage` ไม่ใช่ `canEdit`
           *   เปิดสาธารณ = ทุกคนแก้ฟอร์มได้ แต่ "เขียนทับไฟล์แม่แบบ/ลบ" ทำไม่ได้
           *   ถ้าใช้ canEdit ปุ่มลบจะโผล่ให้ทุกคนแล้วโดน API ตอบ 403 ตอนกด
           *   (ฝั่ง API ใช้ assertCanReplace — กติกาเดียวกัน)
           */}
          {canManage ? (
            <>
              {/**
               * ── ตัวอย่างเอกสารเป็นรูป ──
               *
               * ผู้ใช้สั่ง: *"เพิ่ม ตัวอย่างแม่แบบที่เป็นรูป สร้างให้อันโนมัติ มีได้หลายรูป
               *   สามารถเพิ่มรูปที่เจ้าของแม่แบบอัพโหลดเองได้"*
               *
               * วางไว้ในการ์ด "ข้อมูลแม่แบบ" เพราะเป็นเรื่องของแม่แบบตัวนั้น
               * ไม่ใช่เรื่องการแชร์ → ไม่ควรไปโผล่ในการ์ด "การแชร์และสิทธิ์"
               *
               * ⚠️ เจ้าของเท่านั้นที่เพิ่ม/ลบรูปได้ (กติกาอยู่ใน component เอง)
               *   คนอื่นที่เปิดดูได้อยู่แล้ว
               */}
              <div
                style={{
                  marginTop: 18,
                  paddingTop: 14,
                  borderTop: '1px solid var(--line)',
                }}
              >
                <div className="lbl" style={{ marginBottom: 8 }}>
                  ตัวอย่างเอกสารเป็นรูป
                </div>
                <TemplatePreviews
                  templateKey={access?.templateKey ?? templateKeyOf(template)}
                  versionId={template.versionId}
                  name={template.name}
                  view={access ?? undefined}
                  notify={notify}
                />
              </div>

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

              {/**
               * ── ลบแม่แบบ (เข้าถังขยะ รอ 14 วัน) ──
               *
               * ผู้ใช้สั่ง: *"เพิ่ม การลบแม่แบบ ถ้าผู้ใช้ลบไปแล้ว ให้รอก่อน 14 วัน ค่อยลบ
               *   … ทำให้ restore ภายหลังได้"*
               *
               * ⚠️ ปุ่มนี้ต้องกดสองจังหวะ
               *   ปุ่ม "ลบ" สีแดงติดกันกดพลาดได้ง่าย (คนมักคลิกเมาส์ซ้าตอนเลื่อนหน้า)
               *   และผลคือแม่แบบหายจากรายการของทุกคน ไม่ใช่แค่ของผู้กด
               *   รอบแรกแค่เผยกล่องยืนยัน รอบที่สองถึงลบจริง
               *
               * ⚠️ เฉพาะเจ้าของเท่านั้นที่เห็นปุ่มนี้ (เหตุผลด้านสิทธิ์อยู่ฝั่ง API)
               *   `canManage` ครอบการ์ดนี้อยู่แล้ว จึงไม่ต้องเช็คซ้ำ
               */}
              {!confirmDelete ? (
                <button
                  className="ghost danger"
                  disabled={busy}
                  data-testid="template-trash"
                  onClick={() => setConfirmDelete(true)}
                >
                  🗑️ ลบแม่แบบ
                </button>
              ) : (
                <div
                  className="pill err pill--msg"
                  data-testid="template-trash-confirm"
                  style={{ padding: '10px 12px', lineHeight: 1.6 }}
                >
                  <div style={{ marginBottom: 8 }}>
                    จะลบ <b>{template.name}</b> ออกจากรายการ
                    และ<b>ไฟล์จะถูกลบถาวรใน 14 วัน</b>
                    ระหว่างนี้กู้คืนได้ทุกเมื่อ และคนที่ใช้แม่แบบนี้อยู่
                    จะเห็นป้ายเตือนให้สำเนาไปเก็บเอง
                  </div>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button
                      className="ghost"
                      disabled={busy}
                      onClick={() => setConfirmDelete(false)}
                    >
                      ยกเลิก
                    </button>
                    <button
                      className="danger"
                      disabled={busy}
                      data-testid="template-trash-confirm-yes"
                      onClick={() =>
                        void (async () => {
                          setBusy(true)
                          try {
                            const t = await api.deleteTemplate(templateKeyOfTemplate(template))
                            notify(`ย้าย "${t.name}" เข้าถังขยะแล้ว — ลบถาวรใน ${t.daysLeft} วัน`)
                            onDeleted()
                          } catch (e) {
                            notify(e instanceof ApiError ? e.message : String(e))
                            setConfirmDelete(false)
                          } finally {
                            setBusy(false)
                          }
                        })()
                      }
                    >
                      {busy ? 'กำลังลบ…' : 'ยืนยันเข้าถังขยะ'}
                    </button>
                  </div>
                </div>
              )}

              {pendingFile && (
                <div
                  className="pill warn pill--msg"
                  style={{ padding: '10px 12px', lineHeight: 1.5 }}
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
              {canEdit
                ? 'แก้ไขฟอร์มได้ตามปกติ แต่เปลี่ยนหรือลบไฟล์แม่แบบไม่ได้ — ต้องเป็นเจ้าของเท่านั้น'
                : 'คุณมีสิทธิ์แค่ดูอย่างเดียว — จึงดาวน์โหลดได้แต่แก้ไขไม่ได้'}
            </p>
          )}
        </div>
      </div>
      )}

      {/* ── การแชร์ ── */}
      {(part === 'all' || part === 'access') && (
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

        {/* ── ลิงก์สาธารณ: ต้องอยู่นอก `canManage` ──
         *   คนที่ไม่ใช่เจ้าของก็ต้องเห็นลิงก์เหมือนกัน ถ้าเอาไปส่งต่อได้จริง
         *   (ถ้าซ่อนไว้ในกล่องของเจ้าของ ผู้ใช้ที่ได้รับการแชร์จะหาลิงก์ไม่เจอ) */}
        {access?.visibility === 'published' && (
          <div
            data-testid="share-public-url"
            style={{
              display: 'grid',
              gap: 8,
              marginBottom: 14,
              padding: '11px 12px',
              background: 'var(--brand-soft)',
              border: '1px solid var(--brand-border)',
              borderRadius: 10,
            }}
          >
            <div style={{ fontSize: 12.5, fontWeight: 600 }}>🌐 ลิงก์สาธารณ</div>
            <div style={{ fontSize: 12, color: 'var(--ink-2)' }}>
              ใครมีลิงก์นี้ก็เปิดใช้และแก้ไขแม่แบบนี้ได้ทันที ไม่ต้องเชิญทีละคน
            </div>
            <code
              className="mono"
              title={publicUrl}
              style={{
                display: 'block',
                padding: '8px 10px',
                background: 'var(--bg)',
                border: '1px solid var(--line)',
                borderRadius: 8,
                fontSize: 12,
                lineHeight: 1.5,
                /**
                 * ลิงก์ยาวมากตอนจอแคบ → ต้องตัดบรรทัดได้
                 * ไม่งั้นกล่องการ์ดจะดันความสูงหน้าเว็บพุ่ง (เคยเจอกับตารางรายการแม่แบบ)
                 */
                wordBreak: 'break-all',
                userSelect: 'all',
              }}
            >
              {publicUrl || '…'}
            </code>
            <button
              className={copied ? `ghost ${copied}` : 'ghost'}
              disabled={busy || !publicUrl}
              data-testid="share-copy-url"
              style={{ justifySelf: 'start' }}
              // ⚠️ ให้ screen reader อ่านป้ายที่เปลี่ยนได้ ไม่งั้นผู้ใช้โปรแกรมอ่านหน้าจอ
              //   ได้แต่ Banner ที่ห่างออกไปหลายจอ
              aria-live="polite"
              onClick={() =>
                void (async () => {
                  const ok = await copyText(publicUrl)
                  flashCopied(ok ? 'ok' : 'err')
                  notify(
                    ok
                      ? 'คัดลอกลิงก์สาธารณแล้ว'
                      : 'คัดลอกไม่สำเร็จ — ให้เลือกข้อความในกล่องด้านบนเอง'
                  )
                })()
              }
            >
              {copied === 'ok'
                ? 'คัดลอกแล้ว ✓'
                : copied === 'err'
                  ? 'คัดลอกไม่สำเร็จ'
                  : 'คัดลอกลิงก์'}
            </button>
          </div>
        )}

        {canManage ? (
          <>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 14 }}>
              <button
                className="ghost"
                disabled={busy}
                data-testid="share-publish"
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
                data-testid="share-private"
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
      )}
    </div>
  )
}

/** key ที่ใช้ผูกข้อมูลทั้งหมด — ต้องตรงกับที่ใช้ทั่วระบบ */
function templateKeyOfTemplate(t: Template): string {
  return String(t.id ?? t.versionId)
}
