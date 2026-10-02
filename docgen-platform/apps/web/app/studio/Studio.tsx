'use client'

/**
 * 2docx Studio — เครื่องมือจัดการแม่แบบเอกสาร
 *
 * ออกแบบตาม Carbone Studio แต่ตัดสิ่งที่เราไม่ใช้ออก:
 *   · รองรับเฉพาะ `{d.}`  (ไม่มี `c.` `t()` `:convEnum` — ยังไม่ได้เปิดใน render payload)
 *   · ไม่มี Carbone Studio, origin 0/1 จึงไม่ต้องกังวล
 *   · ใช้ API ของเราเองทั้งหมด เข้าสู่ระบบผ่าน Casdoor เดียวกับที่อื่น
 *
 * หน้านี้แบ่งเป็น 4 แท็บ
 *   แม่แบบทั้งหมด · ที่ฉันเป็นเจ้าของ · แชร์กับฉัน · บุ๊กมาร์ก
 * ส่วนรายละเอียดของแม่แบบหนึ่งตัวอยู่ใน `TemplateEditor.tsx`
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  api,
  ApiError,
  templateKeyOf,
  type AccessView,
  type BookmarkRecord,
  type Template,
  type TemplateTag,
} from './lib/api'
import Tabs from './Tabs'
import TemplateEditor from './TemplateEditor'
import { readParam, readTemplateKey, setUrl, studioPath, TAB_PARAM } from './lib/urlState'

const ACCEPT = '.docx,.xlsx,.pptx,.odt,.ods,.odp'
const MAX_MB = 20

type ListTab = 'all' | 'mine' | 'shared' | 'bookmarks'

/**
 * แท็บของหน้ารายการใช้ `?tabs=` ตัวเดียวกับฝั่งซ้ายของหน้าแก้ไข
 *
 * ⚠️ ค่าใน URL อาจเป็นของ**หน้าแก้ไข** ได้ (เช่นคนกดย้อนกลับมาจาก
 *    `/studio/<key>?tabs=form` แล้ว URL ยังมี query ติดมา)
 *    → ต้องตรวจว่าอยู่ในชุดของหน้านี้ก่อน ไม่งั้นจะเปิดแท็บผิด
 */
const LIST_TABS: ListTab[] = ['all', 'mine', 'shared', 'bookmarks']

/** อ่านแท็บหน้ารายการจาก URL ได้ — ค่าผิด/ไม่มี = `all` */
function readListTab(search: string): ListTab {
  const t = readParam(search, TAB_PARAM)
  return LIST_TABS.includes(t as ListTab) ? (t as ListTab) : 'all'
}

/**
 * @param initialKey key ของแม่แบบที่จะเปิดทันที — มาจาก path `/studio/<key>`
 *   (route `app/studio/[key]/page.tsx` ส่งมาให้ จึงรีเฟรชแล้วยังอยู่แม่แบบเดิม)
 */
export default function Studio({ initialKey }: { initialKey?: string } = {}) {
  const [templates, setTemplates] = useState<Template[]>([])
  const [categories, setCategories] = useState<string[]>([])
  const [access, setAccess] = useState<Record<string, AccessView>>({})
  const [bookmarks, setBookmarks] = useState<BookmarkRecord[]>([])
  const [search, setSearch] = useState('')
  const [category, setCategory] = useState('')
  const [tab, setTab] = useState<ListTab>('all')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const [notFound, setNotFound] = useState<string | null>(null)

  const [open, setOpen] = useState<Template | null>(null)

  const load = useCallback(async () => {
    try {
      setError(null)
      const [t, c, b] = await Promise.all([
        api.listTemplates(),
        api.categories(),
        api.bookmarks(),
      ])
      setTemplates(t.items)
      setCategories(c.items)
      setBookmarks(b.items)
      // สิทธิ์ทีเดียวทั้งหมด — ถามทีละตัวจะเป็น N+1
      if (t.items.length > 0) {
        const map = await api.resolveAccess(t.items.map(templateKeyOf))
        setAccess(map)
      }
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  /**
   * อ่านแท็บหน้ารายการจาก URL ตอน mount
   *
   * ⚠️ ต้องอ่านใน effect ไม่ใช่ตอนสร้าง state
   *    เพราะหน้านี้ถูก SSR ด้วย (server ไม่มี `window`)
   *    ถ้าอ่านตอน render ฝั่งเบราว์เซอร์จะได้ค่าคนละอันกับ server → hydration mismatch
   *    (เรื่องเดียวกันนี้เคยเจอใน `TemplateEditor`)
   */
  useEffect(() => {
    setTab(readListTab(window.location.search))
  }, [])

  /**
   * สลับแท็บหน้ารายการ → เขียนลง URL เสมอ
   *
   * ⚠️ ใช้ `push` ไม่ใช่ `replace` เพราะผู้ใช้ต้องกดย้อนกลับย้อนแท็บได้
   *    ถ้าใช้ `replace` ปุ่มย้อนกลับของเบราว์เซอร์จะกระโดดข้ามแท็บทั้งหมด
   *    (หน้าแก้ไขใช้ `replace` เพราะสลับแท็บขณะกรอกฟอร์ม ไม่ต้องย้อน)
   */
  const pickListTab = useCallback((next: ListTab) => {
    setTab(next)
    // แท็บแรกไม่ต้องเขียน จะได้ URL สะอาดเป็น `/studio`
    setUrl(studioPath(null, next === 'all' ? null : next), 'push')
  }, [])

  /** เปิดแม่แบบ — URL เปลี่ยนด้วยเสมอ เพื่อให้คัดลอกไปให้คนอื่นเปิดต่อได้ */
  const openTemplate = useCallback((t: Template) => {
    setNotFound(null)
    setOpen(t)
    // ระบุแท็บเริ่มต้นทั้งสองฝั่ง — ไม่งั้น URL จะขาด `pane` ไป
    // (`?tabs=` ของหน้ารายการถูกแทนที่ไปด้วยแท็บซ้ายของหน้านี้ ไม่ชนกัน)
    setUrl(studioPath(templateKeyOf(t), 'form', 'preview'), 'push')
  }, [])

  /**
   * ปิดกลับไปหน้ารายการ — ต้องคืน**แท็บเดิม** ที่ผู้ใช้อยู่ก่อนเปิดแม่แบบ
   * ไม่งั้นปิดเสร็จจะหลุดไปแท็บแรกเสมอ (เคยเป็นอาการนี้ตอนยังไม่ผูกกับ URL)
   */
  const closeTemplate = useCallback(() => {
    setOpen(null)
    setUrl(studioPath(null, tab === 'all' ? null : tab), 'push')
  }, [tab])

  /**
   * เปิดแม่แบบจาก URL ตอนโหลดเสร็จ
   *
   * ⚠️ ต้องมี ref กันทำซ้ำ — ถ้าไม่กัน `templates` จะเป็น array ใหม่ทุกครั้งที่ `load()`
   *    แล้วผู้ใช้ที่เพิ่งกด "กลับ" จะถูกเปิดแม่แบบเดิมกลับมาเอง
   */
  const openedFromUrl = useRef(false)
  useEffect(() => {
    if (openedFromUrl.current) return
    if (!initialKey || loading || templates.length === 0) return
    openedFromUrl.current = true
    const found = templates.find((t) => templateKeyOf(t) === initialKey)
    if (found) setOpen(found)
    else setNotFound(`ไม่พบแม่แบบ key ${initialKey} — แสดงรายการทั้งหมดแทน`)
  }, [initialKey, loading, templates])

  /**
   * ปุ่มย้อนกลับ / ไป-กลับ ของเบราว์เซอร์
   *
   * ⚠️ pushState ไม่ยิง event ให้ฟัง เราจึงต้องฟัง `popstate` เอง
   *    (ถ้าไม่ฟัง URL จะเปลี่ยนแต่หน้าไม่ตาม → กดย้อนกลับแล้วเห็นหน้าเดิม)
   */
  useEffect(() => {
    const onPop = () => {
      const key = readTemplateKey(window.location.pathname)
      if (!key) {
        // ⚠️ ต้องอ่านแท็บจาก URL ตรงนี้ด้วย ไม่งั้นกดย้อนกลับแล้ว URL เปลี่ยนแต่แท็บไม่เปลี่ยน
        //   เฉพาะตอนที่อยู่**หน้ารายการ**เท่านั้นที่อ่าน — ตอนเปิดแม่แบบ
        //   `?tabs=form` เป็นแท็บ**ซ้าย**ของหน้าแก้ไข ไม่ใช่แท็บหน้านี้
        setTab(readListTab(window.location.search))
        setOpen(null)
        return
      }
      const found = templates.find((t) => templateKeyOf(t) === key)
      if (found) {
        setNotFound(null)
        setOpen(found)
      } else {
        setOpen(null)
        setNotFound(`ไม่พบแม่แบบ key ${key} — แสดงรายการทั้งหมดแทน`)
      }
    }
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [templates])

  const bookmarkKeys = useMemo(
    () => new Set(bookmarks.map((b) => b.templateKey)),
    [bookmarks],
  )

  /** กดดาว → เพิ่ม/ลบบุ๊กมาร์ก (เรียกจากปุ่มในตาราง) */
  async function toggleBookmark(t: Template) {
    const key = templateKeyOf(t)
    try {
      if (bookmarkKeys.has(key)) {
        await api.removeBookmark(key)
        setBookmarks((b) => b.filter((x) => x.templateKey !== key))
      } else {
        await api.addBookmark({ templateKey: key, versionId: t.versionId, templateName: t.name })
        const r = await api.bookmarks()
        setBookmarks(r.items)
      }
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e))
    }
  }

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return templates.filter((t) => {
      const key = templateKeyOf(t)
      const view = access[key]

      // แม่แบบส่วนตัวของคนอื่น → ซ่อนไป ไม่งั้นจะเห็นชื่อแม่แบบที่ใช้ไม่ได้
      if (view?.visibility === 'private' && view.relation === 'published') return false

      if (tab === 'mine' && view?.relation !== 'owner') return false
      if (tab === 'shared' && view?.relation !== 'shared') return false
      if (tab === 'bookmarks' && !bookmarkKeys.has(key)) return false

      if (category && t.category !== category) return false
      if (!q) return true
      return (
        t.name.toLowerCase().includes(q) ||
        t.versionId.toLowerCase().includes(q) ||
        t.tags.some((x) => x.toLowerCase().includes(q))
      )
    })
  }, [templates, search, category, tab, access, bookmarkKeys])

  if (open) {
    return (
      <>
        {/*
          ⚠️ Banner ต้องอยู่ตรงนี้ด้วย ไม่ใช่แค่ในหน้ารายการ
            ตอนเปิดแม่แบบ หน้านี้ return ออกไปก่อนถึงจุดที่เรนเดอร์ Banner
            ทำให้ `notify()` จากหน้าแก้ไข (บันทึกช่องแล้ว · AI เติมข้อมูล · เรียก AI ไม่สำเร็จ)
            ไม่เคยโผล่ขึ้นให้ผู้ใช้เห็นเลย
        */}
        {toast && <Banner tone="ok" onClose={() => setToast(null)}>{toast}</Banner>}
        <TemplateEditor
          // ⚠️ key สำคัญ — ถ้าไม่ใส่ React จะ reuse component เดิมตอนสลับแม่แบบ
          //   แล้วแท็บที่เลือกไว้ของแม่แบบก่อนหน้าจะค้างมาด้วย
          key={templateKeyOf(open)}
          template={open}
          onClose={closeTemplate}
          onSaved={async (msg) => {
            setToast(msg)
            closeTemplate()
            await load()
          }}
          notify={setToast}
        />
      </>
    )
  }

  const tabs = [
    { id: 'all', label: 'แม่แบบทั้งหมด', count: templates.length },
    { id: 'mine', label: 'ที่ฉันเป็นเจ้าของ' },
    { id: 'shared', label: 'แชร์กับฉัน' },
    { id: 'bookmarks', label: 'บุ๊กมาร์ก', count: bookmarks.length },
  ]

  return (
    <div
      style={{
        maxWidth: 1180,
        margin: '0 auto',
        padding: '28px 24px 80px',
        /**
         * ⚠️ ต้องเป็น flex column + gap
         *   เดิมกล่องทุกอันเป็น block ปกติเรียงต่อกัน
         *   พอสลับแท็บบุ๊กมาร์กตอนที่ยังไม่มีบุ๊กมาร์ก
         *   กล่อง "ยังไม่มีบุ๊กมาร์ก" จะชิดกับกล่องตารางเป๊ะ ๆ ไม่มีช่องว่าง
         *   (ใช้ margin ทีละกล่องแก้ไม่ได้ เพราะจำนวนกล่องเปลี่ยนตามเงื่อนไข
         *   เช่น ตอนมี Banner แทรก ช่องว่างจะหายไปอีก)
         */
        display: 'flex',
        flexDirection: 'column',
        gap: 14,
      }}
    >
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 14,
          flexWrap: 'wrap',
          marginBottom: 18,
        }}
      >
        <div>
          <h1 style={{ margin: 0, fontSize: 25 }}>Studio</h1>
          <p className="muted" style={{ margin: '2px 0 0', fontSize: 13 }}>
            จัดการแม่แบบเอกสาร · {templates.length} แม่แบบ
          </p>
        </div>
        <div style={{ flex: 1 }} />
        {/* ⚠️ auth route ไม่ได้อยู่ใต้ /api — ใช้ /auth/logout */}
        <a href="/auth/logout" className="muted" style={{ fontSize: 13 }}>
          ออกจากระบบ
        </a>
        <UploadButton
          onDone={async (name) => {
            setToast(`อัปโหลด "${name}" แล้ว`)
            await load()
          }}
          onError={setError}
        />
      </header>

      <Tabs tabs={tabs} active={tab} onChange={(id) => pickListTab(id as ListTab)} />

      {/* ตัวกรอง — ไม่ใส่ margin แล้ว ใช้ gap ของพ่อแทน ไม่งั้นจะเป็น 14 + 16 = 30px */}
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="ค้นหาจากชื่อ แท็ก หรือ versionId"
          style={{ maxWidth: 320 }}
        />
        <select value={category} onChange={(e) => setCategory(e.target.value)} style={{ maxWidth: 200 }}>
          <option value="">ทุกหมวด</option>
          {categories.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
        {category && (
          <button className="ghost" onClick={() => setCategory('')}>
            ล้างตัวกรอง
          </button>
        )}
        <div className="muted" style={{ alignSelf: 'center', fontSize: 13, marginLeft: 'auto' }}>
          แสดง {filtered.length} จาก {templates.length}
        </div>
      </div>

      {error && <Banner tone="err" onClose={() => setError(null)}>{error}</Banner>}
      {notFound && (
        <Banner tone="err" onClose={() => setNotFound(null)}>
          {notFound}
        </Banner>
      )}
      {toast && <Banner tone="ok" onClose={() => setToast(null)}>{toast}</Banner>}

      {tab === 'bookmarks' && bookmarks.length === 0 && !loading && (
        <div className="card muted" style={{ padding: 40, textAlign: 'center' }}>
          ยังไม่มีบุ๊กมาร์ก — กดดาว ★ ที่แม่แบบที่ใช้บ่อยเพื่อเก็บไว้ตรงนี้
        </div>
      )}

      <div className="card" style={{ overflow: 'hidden' }}>
        {loading ? (
          <div className="muted" style={{ padding: 40, textAlign: 'center' }}>
            กำลังโหลด…
          </div>
        ) : filtered.length === 0 ? (
          <div className="muted" style={{ padding: 48, textAlign: 'center' }}>
            ไม่พบแม่แบบ — ลองล้างตัวกรอง หรืออัปโหลดไฟล์ใหม่
          </div>
        ) : (
          /*
           * ⚠️ `tpllist` — ต้องมี class นี้เพื่อให้กฎ responsive ของมือถือ
           *    แยกได้ว่าตารางไหนคือรายการแม่แบบ (หน้านี้) ไม่ไปกระทบตารางอื่น
           *    เช่นตารางประวัติใน `HistoryPanel` ที่ยังต้องการเป็นตารางเหมือนเดิม
           */
          <table className="tpllist">
            <thead>
              <tr>
                <th>ชื่อ</th>
                <th>หมวด</th>
                <th>แท็ก</th>
                <th>ชนิด</th>
                <th style={{ textAlign: 'right' }}>จัดการ</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((t) => {
                const key = templateKeyOf(t)
                const view = access[key]
                return (
                  <TemplateRow
                    key={t.versionId}
                    tpl={t}
                    view={view}
                    starred={bookmarkKeys.has(key)}
                    onStar={() => void toggleBookmark(t)}
                    onOpen={() => openTemplate(t)}
                    onChanged={load}
                    onError={setError}
                    notify={setToast}
                  />
                )
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}

// ── แถวในตาราง ────────────────────────────────────────────────
function TemplateRow({
  tpl,
  view,
  starred,
  onStar,
  onOpen,
  onChanged,
  onError,
  notify,
}: {
  tpl: Template
  view?: AccessView
  starred: boolean
  onStar: () => void
  onOpen: () => void
  onChanged: () => Promise<void>
  onError: (s: string) => void
  notify: (s: string) => void
}) {
  const [busy, setBusy] = useState(false)
  const [confirming, setConfirming] = useState(false)

  async function remove() {
    if (!confirming) {
      setConfirming(true)
      setTimeout(() => setConfirming(false), 4000)
      return
    }
    setBusy(true)
    try {
      await api.deleteTemplate(tpl.versionId)
      notify(`ลบ "${tpl.name}" แล้ว`)
      await onChanged()
    } catch (e) {
      onError(e instanceof ApiError ? e.message : String(e))
    } finally {
      setBusy(false)
      setConfirming(false)
    }
  }

  return (
    <tr>
      <td>
        <button
          className="ghost"
          onClick={onOpen}
          style={{ padding: 0, border: 'none', background: 'none', color: 'var(--brand)', textAlign: 'left' }}
          title={view && !view.canEdit ? 'ดูอย่างเดียว (ไม่มีสิทธิ์แก้ไข)' : 'เปิดแม่แบบ'}
        >
          {tpl.name || '(ไม่มีชื่อ)'}
        </button>
        <div className="muted mono" style={{ fontSize: 11 }}>
          {tpl.versionId.slice(0, 16)}…
        </div>
        <div style={{ display: 'flex', gap: 4, marginTop: 3 }}>
          {view?.relation === 'owner' && <span className="pill">เจ้าของ</span>}
          {view?.relation === 'shared' && (
            <span className="pill">{view.role === 'editor' ? 'แชร์·แก้ได้' : 'แชร์·ดูอย่างเดียว'}</span>
          )}
          {view?.visibility === 'private' && <span className="pill">🔒</span>}
        </div>
      </td>
      <td data-label="หมวด" className={tpl.category ? undefined : 'is-empty'}>
        {tpl.category ? <span className="pill">{tpl.category}</span> : <span className="muted">—</span>}
      </td>
      <td data-label="แท็ก" className={tpl.tags.length ? undefined : 'is-empty'}>
        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', maxWidth: 240 }}>
          {tpl.tags.slice(0, 3).map((g) => (
            <span key={g} className="pill">
              {g}
            </span>
          ))}
          {tpl.tags.length > 3 && <span className="muted" style={{ fontSize: 12 }}>+{tpl.tags.length - 3}</span>}
        </div>
      </td>
      <td className="muted mono" data-label="ชนิด">
        {tpl.type}
      </td>
      <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
        <button
          className="ghost"
          onClick={onStar}
          title={starred ? 'เอาออกจากบุ๊กมาร์ก' : 'เพิ่มในบุ๊กมาร์ก'}
          style={{ padding: '4px 9px', color: starred ? 'var(--warn)' : undefined }}
        >
          {starred ? '★' : '☆'}
        </button>{' '}
        <button className="ghost" onClick={onOpen} disabled={busy}>
          เปิด
        </button>{' '}
        <a href={`/api/templates/${encodeURIComponent(tpl.versionId)}`} download>
          <button className="ghost" disabled={busy}>
            ดาวน์โหลด
          </button>
        </a>{' '}
        <button className={confirming ? 'danger' : 'ghost'} onClick={remove} disabled={busy}>
          {confirming ? 'ยืนยันลบ?' : 'ลบ'}
        </button>
      </td>
    </tr>
  )
}

// ── ปุ่มอัปโหลด ────────────────────────────────────────────────
function UploadButton({
  onDone,
  onError,
}: {
  onDone: (name: string) => Promise<void>
  onError: (s: string) => void
}) {
  const [busy, setBusy] = useState(false)
  const [over, setOver] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)

  async function send(file: File) {
    if (file.size > MAX_MB * 1024 * 1024) {
      onError(`ไฟล์ใหญ่เกิน ${MAX_MB} MB`)
      return
    }
    setBusy(true)
    try {
      await api.uploadTemplate(file, { name: file.name.replace(/\.[^.]+$/, ''), category: '', tags: [] })
      await onDone(file.name)
    } catch (e) {
      onError(e instanceof ApiError ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <input
        ref={fileInput}
        type="file"
        accept={ACCEPT}
        style={{ display: 'none' }}
        onChange={(e) => {
          const f = e.target.files?.[0]
          if (f) void send(f)
          e.target.value = ''
        }}
      />
      <label
        onClick={() => fileInput.current?.click()}
        onDragOver={(e) => {
          e.preventDefault()
          setOver(true)
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault()
          setOver(false)
          const f = e.dataTransfer.files?.[0]
          if (f) void send(f)
        }}
        style={{
          border: `1px dashed ${over ? 'var(--brand)' : 'var(--line)'}`,
          background: over ? 'var(--brand-soft)' : 'var(--surface)',
          color: over ? 'var(--brand-dark)' : 'var(--ink-2)',
          padding: '8px 14px',
          borderRadius: 8,
          cursor: 'pointer',
          margin: 0,
          fontSize: 14,
          userSelect: 'none',
        }}
      >
        {busy ? 'กำลังอัปโหลด…' : 'อัปโหลดแม่แบบ'}
      </label>
    </>
  )
}

function Banner({
  tone,
  children,
  onClose,
}: {
  tone: 'ok' | 'err'
  children: React.ReactNode
  onClose?: () => void
}) {
  return (
    <div
      className={`pill ${tone}`}
      style={{
        display: 'flex',
        gap: 10,
        alignItems: 'center',
        padding: '9px 14px',
        marginBottom: 14,
        borderRadius: 8,
        fontSize: 13,
      }}
    >
      <span style={{ flex: 1 }}>{children}</span>
      {onClose && (
        <button className="ghost" onClick={onClose} style={{ padding: '2px 8px', fontSize: 12 }}>
          ปิด
        </button>
      )}
    </div>
  )
}
