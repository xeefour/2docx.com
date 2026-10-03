'use client'

/**
 * หน้าแก้ไขแม่แบบหนึ่งตัว — แบ่งเป็นแท็บเพื่อไม่ให้หน้ากว้างเกินไป
 *
 *   ซ้าย  ฟอร์ม            · กรอกข้อมูล + ให้ AI ช่วย (แผงข้าง) + เรนเดอร์เห็นผล
 *         JSON ข้อมูลดิบ   · แก้ data ตรง ๆ (สำหรับค่าที่ฟอร์มยังไม่รองรับ)
 *         ประวัติ          · ฉันเคยสั่งเรนเดอร์แม่แบบนี้เมื่อไร · ค้นแล้วกด "แก้ไข" เพื่อกู้ค่าเดิม
 *
 *   ขวา   ตัวอย่างเอกสาร · แม่แบบ & การแชร์ · ช่องฟอร์ม · ผู้ใช้แม่แบบนี้
 *
 * ── ประวัติสองฝั่งต่างกันตรงไหน ─────────────────────────────
 *   ซ้าย "ประวัติ"        = ของฉันเอง มีค่าที่กรอก → เอามาแก้ต่อได้
 *   ขวา  "ผู้ใช้แม่แบบนี้" = ทุกคน · ดูภาพรวม · อ่านอย่างเดียว (ไม่คืนค่าที่กรอกของคนอื่น)
 *
 * ข้อมูล `data` มีที่เดียวจริง ทั้งฟอร์มและ JSON แก้ชุดเดียวกัน
 * ทำให้สลับแท็บไปมาสลับแล้วข้อมูลไม่หาย
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  api,
  ApiError,
  templateKeyOf,
  waitForRender,
  type AccessView,
  type FieldDef,
  type Template,
  type TemplateTag,
  type Tombstone,
} from './lib/api'
import { validateFormData, withDefaults } from './lib/fields'
import Tabs from './Tabs'
import FormFields from './FormFields'
import AiChat from './AiChat'
import FieldBuilder from './FieldBuilder'
import SharePanel from './SharePanel'
import HistoryPanel from './HistoryPanel'
import TrashBanner from './TrashBanner'
import MyHistoryPanel from './MyHistoryPanel'
import DocumentPreview from './DocumentPreview'
import DownloadMenu from './DownloadMenu'
import { JsonEditor } from './lib/JsonEditor'
import { readParam, setUrl, studioPath, PANE_PARAM, TAB_PARAM } from './lib/urlState'
import { useAppBusy } from '../components/AppStatus'
import type { LoadedPdf } from './lib/pdf'

/** แท็บฝั่งซ้าย — สิ่งที่กรอกลงเอกสาร + ประวัติของฉันเอง */
type LeftTabId = 'form' | 'json' | 'history'/** แท็บฝั่งขวา — เรื่องของตัวแม่แบบ (รวม "ใครใช้แม่แบบนี้") */
type PaneId = 'preview' | 'template' | 'fields' | 'history'

const LEFT_TABS: readonly string[] = ['form', 'json', 'history']
const PANE_IDS: readonly string[] = ['preview', 'template', 'fields', 'history']

export default function TemplateEditor({
  template,
  onClose,
  onSaved,
  notify,
  bookmarked,
  onToggleBookmark,
}: {
  template: Template
  onClose: () => void
  onSaved: (msg: string) => void
  notify: (msg: string) => void
  /** แม่แบบนี้อยู่ในบุ๊กมาร์กอยู่ไหม — สถานะถือที่หน้ารายการ (แหล่งเดียว) */
  bookmarked: boolean
  /** สลับบุ๊กมาร์ก — คืน promise ที่ reject เมื่อบันทึกไม่สำเร็จ */
  onToggleBookmark: () => Promise<void>
}) {
  const templateKey = templateKeyOf(template)

  const [tab, setTabState] = useState<LeftTabId>('form')
  const [pane, setPaneState] = useState<PaneId>('preview')
  const [data, setData] = useState<Record<string, unknown>>({})
  const [fields, setFields] = useState<FieldDef[]>([])
  const [tags, setTags] = useState<TemplateTag[]>([])
  const [access, setAccess] = useState<AccessView | null>(null)
  /**
   * tombstone ของแม่แบบนี้ (null = ยังปกติ)
   * ใช้โชว์ป้ายเตือนถังขยะ — ดู `TrashBanner`
   */
  const [trash, setTrash] = useState<Tombstone | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [showErrors, setShowErrors] = useState(false)
  const [previewDoc, setPreviewDoc] = useState<string | null>(null)
  /**
   * ข้อมูล**ณ ตอนที่เรนเดอร์ล่าสุด** เก็บเป็น JSON string
   *
   * ผู้ใช้สั่ง: *"เมื่อ form หรือ json มีการแก้ไขข้อมูล ให้ส่วนของ preview มี overlay
   * ขึ้นมาเตือนผู้ใช้ว่าต้องการจะเรนเดอร์ใหม่หรือไม่"*
   *
   * เก็บเป็น string (ไม่ใช่ object) เพราะ `data` เป็น object ใหม่ทุกครั้งที่แก้
   * เทียบด้วย reference ไม่ได้ แต่ string เทียบด้วยค่าได้
   */
  const [renderedData, setRenderedData] = useState<string | null>(null)
  /** ข้อมูลเวอร์ชันที่ผู้ใช้เลือก "ใช้ผลเดิมต่อไป" — ถ้าแก้เพิ่มจะกลับมาเตือนใหม่ */
  const [staleDismissed, setStaleDismissed] = useState<string | null>(null)
  const [pdf, setPdf] = useState<LoadedPdf | null>(null)
  const [aiOpen, setAiOpen] = useState(true)
  /** กำลังบันทึกบุ๊กมาร์ก — กันกดรัวจนยิง API เป็นสิบครั้ง */
  const [starBusy, setStarBusy] = useState(false)

  /**
   * กดดาวที่ปลายขวาของแถบแท็บ (ผู้ใช้สั่ง: *"เพิ่มปุ่มสัญาลักษ์ bookmark ขวามือ"*)
   *
   * ⚠️ ต้อง `catch` เอง — หน้านี้ `return` ออกจากหน้ารายการไปแล้ว
   *   ป้ายแจ้ง error ของหน้ารายการจึงไม่ถูกเรนเดอร์ตอนนี้
   *   ถ้าไม่จับ error ผู้ใช้จะเห็นดาวไม่เปลี่ยนโดยไม่มีคำอธิบาย
   */
  async function toggleStar() {
    if (starBusy) return
    setStarBusy(true)
    try {
      await onToggleBookmark()
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'บันทึกบุ๊กมาร์กไม่สำเร็จ')
    } finally {
      setStarBusy(false)
    }
  }

  const setAppBusy = useAppBusy()
  useEffect(() => {
    setAppBusy(busy ? (status ?? 'กำลังทำงาน…') : null)
    return () => setAppBusy(null)
  }, [busy, status, setAppBusy])

  /**
   * ⚠️ เคยมีการวัด `--editor-top` (ระยะจากขอบบนจอถึงคอลัมน์ตอน `scroll = 0`)
   *    แล้วเอาไปจำกัดความสูงการ์ดพรีวิวไว้ที่ `100vh - --editor-top`
   *    เพื่อให้ทั้งการ์ด (รวมแถบรูปย่อ) อยู่ในจอตอน `scroll = 0`
   *
   *    ผู้ใช้สั่งเปลี่ยนเป็น "กล่องรูปเอกสารสูงเท่าหน้าจอ
   *    แถบรูปย่ออยู่ใต้ขอบจอ ต้องเลื่อนลงถึงจะเห็น" → การ์ดสูงเกินจอเสมอ
   *    ตัวแปรนี้จึงไม่มีใครอ่านอีกต่อไป และการวัดที่ซับซ้อนขนาดนี้
   *    (callback ref + ResizeObserver ทั้ง `document.body`) กลายเป็นภาระเปล่า
   *
   *    ข้อควรจำ (เจอมาแล้ว): **CSS ตัวแปรที่ JavaScript ไม่ได้ตั้ง
   *    จะกลายเป็น fallback เงียบ ๆ** — เคยมี effect ที่รันตอน mount ที่ `.editor-split`
   *    ยังไม่อยู่ใน DOM แล้ว `return` ทิ้ง → ตัวแปรไม่เคยถูกตั้ง → การ์ดใช้ค่า
   *    fallback 160px มาตลอด แล้วดูเหมือน CSS พัง ทั้งที่ไม่ได้พัง
   */

  /**
   * สลับแท็บของฝั่งไหนก็ได้ → URL เปลี่ยนตาม (เขียนทั้งสองค่า ไม่งั้นอีกฝั่งจะหายจาก URL)
   *
   * ใช้ `replace` ไม่ใช่ `push` — สลับแท็บไม่ควรกองประวัติจนกดย้อนกลับหลายครั้ง
   * (ผู้ใช้คาดว่ากดย้อนกลับครั้งเดียวก็กลับไปหน้ารายการ)
   */
  const syncUrl = useCallback(
    (nextTab: LeftTabId, nextPane: PaneId) => {
      setUrl(studioPath(templateKeyOf(template), nextTab, nextPane), 'replace')
    },
    [template],
  )

  const setTab = useCallback(
    (next: LeftTabId) => {
      setTabState(next)
      syncUrl(next, pane)
    },
    [pane, syncUrl],
  )

  const setPane = useCallback(
    (next: PaneId) => {
      setPaneState(next)
      syncUrl(tab, next)
    },
    [tab, syncUrl],
  )

  /**
   * อ่านแท็บทั้งสองฝั่งจาก URL หลัง mount
   *
   * ⚠️ ต้องอ่านใน effect ไม่ใช่ตอนสร้าง state
   *    เพราะ component นี้ถูก SSR ด้วย (server ไม่มี `window`)
   *    ถ้าอ่านตอน render ฝั่งเบราว์เซอร์จะได้ค่าคนละอันกับ server → hydration mismatch
   *
   * รองรับ URL เก่าที่ใช้ `?tabs=fields|template|preview` ฝั่งเดียว
   * ลิงก์ที่คนอื่นคัดลอกไว้แล้วจะได้ไม่ต้องแก้
   *
   * ⚠️ `?tabs=history` เป็น**แท็บซ้าย**ตามความหมายปัจจุบัน
   *    ต้องตรวจว่าเป็นแท็บซ้ายก่อน แล้วค่อยตีความแบบ URL รุ่นเก่า
   *    ไม่งั้น `?tabs=history` จะไปเปิดฝั่งขวาด้วย (เพราะ `history` เคยเป็นชื่อแท็บเดียว)
   */
  useEffect(() => {
    const q = window.location.search
    const t = readParam(q, TAB_PARAM)
    const p = readParam(q, PANE_PARAM)

    if (t && LEFT_TABS.includes(t)) {
      setTabState(t as LeftTabId)
      // `?pane=` ยังมีผลถ้ามี แต่ถ้าไม่มีให้คงค่าเริ่มต้น (ไม่ตีความรุ่นเก่า)
      if (p && PANE_IDS.includes(p)) setPaneState(p as PaneId)
      return
    }
    if (p && PANE_IDS.includes(p)) setPaneState(p as PaneId)
    else if (t && PANE_IDS.includes(t)) setPaneState(t as PaneId) // URL รุ่นเก่า
  }, [])

  // ── โหลดข้อมูลเริ่มต้น ────────────────────────────────────
  useEffect(() => {
    let alive = true
    setLoading(true)
    setErr(null)
    setData({})
    setFields([])
    setAccess(null)
    setPreviewDoc(null)
    // เปลี่ยนแม่แบบ = ตัวอย่างเดิมใช้ไม่ได้แล้ว
    setRenderedData(null)
    setStaleDismissed(null)

    void (async () => {
      try {
        const [t, f, a, tr] = await Promise.all([
          api.templateTags(template.versionId),
          api.getForm(templateKey),
          api.getAccess(templateKey),
          /**
           * สถานะถังขยะ — โหลดพร้อมกันเลย
           * ⚠️ ต้องโหลดตอนเปิดหน้า ไม่ใช่ตอนกดลบ เพราะคนที่**ไม่ใช่คนกดลบ**
           *   ก็ต้องเห็นป้ายเตือนด้วย (ผู้ใช้สั่งให้แจ้งคนที่ใช้แม่แบบ)
           *   และ route นี้ไม่เช็คสิทธิ์โดยตั้งใจ
           */
          api.trashOf(templateKey)
            .then((r) => r.item)
            .catch(() => null),
        ])
        if (!alive) return
        setTags(t.items)
        setFields(f.fields)
        setAccess(a)
        setTrash(tr)
        // ฟอร์มที่ยังไม่ได้ตั้ง → ใช้แท็กของแม่แบบเป็นช่องกรอก
        const usable = f.fields.length > 0 ? f.fields : autoFieldsFromTags(t.items)
        setData(withDefaults(usable, t.sample))
      } catch (e) {
        if (alive) setErr(`เปิดแม่แบบไม่สำเร็จ: ${e instanceof Error ? e.message : e}`)
      } finally {
        if (alive) setLoading(false)
      }
    })()

    return () => {
      alive = false
    }
  }, [template.versionId, templateKey])

  const errors = useMemo(() => validateFormData(fields, data), [fields, data])

  /**
   * ตัวอย่างที่เห็นอยู่เก่ากว่าข้อมูลปัจจุบันไหม
   *
   * ⚠️ ครอบคลุมทั้งแท็บ "ฟอร์ม" และ "JSON" เพราะทั้งคู่แก้ `data` ตัวเดียวกัน
   *   (ผู้ใช้สั่งให้เตือนเมื่อ "form หรือ json" เปลี่ยน)
   *
   * ⚠️ เงื่อนไข `renderedData !== null` กันไม่ให้ overlay โผล่ตอนยังไม่เคยเรนเดอร์
   */
  const dataJson = useMemo(() => JSON.stringify(data), [data])
  const stale = !!previewDoc && renderedData !== null && dataJson !== renderedData
  const showStaleOverlay = stale && dataJson !== staleDismissed
  const errorCount = Object.keys(errors).length
  const canEdit = access?.canEdit ?? true

  /**
   * กู้ค่าจากประวัติกลับเข้าฟอร์ม
   *
   * ⚠️ `withDefaults(fields, ...)` สำคัญมาก
   *    ค่าที่เก็บมาอาจเก่ากว่าช่องฟอร์มปัจจุบัน (เพิ่มช่องใหม่ทีหลัง)
   *    ถ้าแทนที่ทั้งก้อน ช่องใหม่จะหายไปและ validation จะพัง
   *
   * ⚠️ ค่าที่กู้มาบางค่าอาจไม่มีช่องในฟอร์มปัจจุบัน (เช่น ตอนนั้นยังเป็น JSON อย่างเดียว)
   *    ต้องบอกผู้ใช้ ไม่งั้นเขากด "แก้ไข" แล้วเห็นฟอร์มเหมือนเดิม
   *    จะเข้าใจว่ากู้ไม่ได้
   */
  const restoreFromHistory = useCallback(
    (saved: Record<string, unknown>) => {
      setData((cur) => withDefaults(fields, { ...cur, ...saved }))
      setShowErrors(false)
      setErr(null)
      setPreviewDoc(null)
      setTab('form')

      const known = new Set(fields.map((f) => f.key))
      const orphan = Object.keys(saved).filter((k) => !known.has(k))
      if (orphan.length > 0) {
        notify(
          `กู้ค่ากลับเข้าฟอร์มแล้ว — อีก ${orphan.length} ค่าไม่มีช่องในฟอร์มนี้ ` +
            `ดูที่แท็บ JSON ได้ (${orphan.slice(0, 3).join(', ')}${orphan.length > 3 ? ' …' : ''})`,
        )
      } else {
        notify('กู้ค่าจากประวัติกลับเข้าฟอร์มแล้ว — ตรวจแล้วกดเรนเดอร์ใหม่ได้เลย')
      }
    },
    [fields, notify, setTab],
  )

  // ── เรนเดอร์ ─────────────────────────────────────────────
  const render_ = useCallback(async () => {
    if (errorCount > 0) {
      setShowErrors(true)
      setTab('form')
      setErr(`ยังกรอกไม่ครบ ${errorCount} ช่อง — ดูสีแดงในแท็บฟอร์ม`)
      return
    }
    setBusy(true)
    setErr(null)
    setStatus('กำลังเรนเดอร์…')
    try {
      const { _id } = await api.createDocument({
        templateId: template.versionId,
        data,
        outputFormat: 'pdf',
        label: `studio: ${template.name}`,
      })
      const doc = await waitForRender(_id, (s) => setStatus(`สถานะ: ${s}`))
      if (doc.status === 'failed') throw new Error(doc.error ?? 'เรนเดอร์ไม่สำเร็จ')
      setStatus('เสร็จแล้ว')
      setPreviewDoc(api.fileUrl(_id))
      /**
       * จำข้อมูลชุดนี้ไว้เทียบภายหลัง — ถ้าผู้ใช้แก้ฟอร์มหรือ JSON ต่อ
       * ตัวอย่างจะถือว่า "เก่า" แล้วและต้องขึ้น overlay เตือน
       */
      setRenderedData(JSON.stringify(data))
      setStaleDismissed(null)
      // พาผู้ใช้ไปดูผลลัพธ์ทันที — ไม่งั้นต้องเดาว่าผลอยู่ฝั่งไหน
      setPane('preview')
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
      setStatus(null)
    } finally {
      setBusy(false)
    }
  }, [data, errorCount, template.name, template.versionId])

  // ── บันทึกช่องฟอร์ม ───────────────────────────────────────
  const saveFields = useCallback(
    async (next: FieldDef[]) => {
      try {
        const r = await api.saveForm(templateKey, next)
        setFields(r.fields)
        setData((d) => withDefaults(r.fields, d))
        notify('บันทึกช่องฟอร์มแล้ว')
      } catch (e) {
        notify(e instanceof ApiError ? e.message : String(e))
        throw e
      }
    },
    [templateKey, notify],
  )

  const importTags = useCallback(async () => {
    setBusy(true)
    try {
      const r = await api.importTags(templateKey, template.versionId)
      setFields(r.fields)
      setData((d) => withDefaults(r.fields, d))
      notify(`เติมช่องจากแท็กแล้ว (${r.fields.length} ช่อง)`)
    } catch (e) {
      notify(e instanceof ApiError ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }, [templateKey, template.versionId, notify])

  const clearForm = useCallback(async () => {
    try {
      await api.clearForm(templateKey)
      const usable = autoFieldsFromTags(tags)
      setFields([])
      setData(withDefaults(usable, {}))
      notify('ล้างช่องฟอร์มแล้ว — กลับไปใช้ช่องจากแท็ก')
    } catch (e) {
      notify(e instanceof ApiError ? e.message : String(e))
    }
  }, [templateKey, tags, notify])

  if (loading) {
    return (
      <div className="muted" style={{ padding: 64, textAlign: 'center' }}>
        กำลังเปิดแม่แบบ…
      </div>
    )
  }

  /**
   * แท็บสองกลุ่ม แยกตามคอลัมน์ของจอ
   *
   * ฝั่งซ้าย = สิ่งที่กรอกลงเอกสาร
   * ฝั่งขวา = ตัวแม่แบบและผลลัพธ์ (ผู้ใช่งานจึงไม่ต้องเดาว่าของอยู่ฝั่งไหน)
   */
  const leftTabs = [
    { id: 'form', label: 'ฟอร์ม' },
    { id: 'json', label: 'JSON' },
    { id: 'history', label: 'ประวัติ' },
  ]
  const rightTabs = [
    { id: 'preview', label: 'ตัวอย่างเอกสาร' },
    /**
     * ⚠️ ชื่อแท็บเดิมคือ "แม่แบบ & การแชร์" แต่ผู้ใช้สั่งย้ายการ์ดการแชร์
     *   ไปแท็บของตัวเอง (แท็บ "การแชร์และสิทธิ์") แล้ว
     *   → แท็บนี้เหลือแต่ข้อมูลแม่แบบ ชื่อเดิมจึงโกหกผู้ใช้
     *   `history` เดิมคือแท็บ "ผู้ใช้แม่แบบนี้" ตอนนี้ถูกใช้เป็นที่ของการแชร์แทน
     *   แต่**ยังโชว์รายชื่อผู้ใช้แม่แบบนี้ต่อ** เพราะเป็นเรื่องเดียวกัน
     *   (ใครได้สิทธิ์ · ใครเคยใช้) ไม่ใช่การตัดฟีเจอร์ทิ้ง
     */
    { id: 'template', label: 'ข้อมูลแม่แบบ' },
    { id: 'fields', label: 'ช่องฟอร์ม', count: fields.length },
    { id: 'history', label: 'การแชร์และสิทธิ์' },
  ]

  return (
    <div style={{ maxWidth: 1400, margin: '0 auto', padding: '22px 24px 60px' }}>
      {/* ── หัวเรื่อง ── */}
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 14, flexWrap: 'wrap' }}>
        <button className="ghost" onClick={onClose}>
          ← กลับ
        </button>
        <div style={{ flex: 1, minWidth: 0 }}>
          <h1 style={{ margin: 0, fontSize: 20, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {template.name || '(ไม่มีชื่อ)'}
          </h1>
          <div className="muted mono" style={{ fontSize: 12 }}>
            {template.versionId.slice(0, 20)}… · key {templateKey}
          </div>
        </div>
        {!canEdit && <span className="pill">ดูอย่างเดียว</span>}
        {access?.visibility === 'private' && <span className="pill">🔒 ส่วนตัว</span>}
        {/**
         * ป้ายเตือนบนแถบเครื่องมือ
         *
         * ⚠️ overlay อยู่ในแท็บตัวอย่างเท่านั้น ถ้าผู้ใช้สลับไปแก้แท็บอื่น
         *   (เช่น ข้อมูลแม่แบบ / การแชร์) จะไม่เห็น overlay เลย
         *   ป้ายนี้จึงอยู่ตลอดจนกว่าจะเรนเดอร์ใหม่
         */}
        {stale && (
          <span
            className="pill warn"
            data-testid="preview-stale-badge"
            style={{ cursor: 'pointer' }}
            onClick={() => setPane('preview')}
            title="ข้อมูลเปลี่ยนแล้ว — กดเพื่อไปเรนเดอร์ใหม่"
          >
            ข้อมูลเปลี่ยนแล้ว · เรนเดอร์ใหม่
          </span>
        )}
        <button
          onClick={() => void render_()}
          disabled={busy || !canEdit}
          data-testid="render-preview"
        >
          {busy ? (status ?? 'กำลังทำงาน…') : 'เรนเดอร์ตัวอย่าง'}
        </button>
      </div>

      {err && (
        <div className="pill err pill--msg" style={{ padding: '12px 16px', marginBottom: 12 }}>
          {err}
        </div>
      )}
      {errorCount > 0 && (
        <div
          className="pill warn pill--msg"
          style={{ padding: '10px 14px', marginBottom: 12 }}
          onClick={() => setShowErrors(true)}
        >
          ยังกรอกไม่ครบ {errorCount} ช่อง — กดเพื่อดูรายละเอียด (กดเรนเดอร์จะพาไปแท็บฟอร์มให้)
        </div>
      )}

      {/* ป้ายเตือนถังขยะ — สำคัญที่สุดของหน้านี้ ต้องอยู่บนสุด
          เพื่อให้เห็นก่อนเนื้อหาอื่นทุกครั้งที่เปิด (โดยเฉพาะคนที่ไม่ใช่คนกดลบ) */}
      {trash && (
        <TrashBanner
          trash={trash}
          templateName={template.name}
          notify={notify}
          onRestored={() => setTrash(null)}
        />
      )}

      {/*
       * ── จอหลัก 2 ฝั่ง · แต่ละฝั่งมีแท็บของตัวเอง ──────────────────
       *
       *   ซ้าย  ฟอร์ม · JSON          → สิ่งที่กรอกลงเอกสาร
       *   ขวา   ตัวอย่าง · ข้อมูลแม่แบบ · ช่องฟอร์ม · การแชร์และสิทธิ์
       *
       * เดิมเป็นแท็บเดียวกว้างเต็มหน้า ทำให้ไม่ชัดว่าเนื้อหาอยู่ฝั่งไหน
       * จอแคบกว่า 1080px จะซ้อนเป็นคอลัมน์เดียวอัตโนมัติ
       */}
      <div className="editor-split">
        {/* ───────── ซ้าย ───────── */}
        <div className="editor-col">
          <Tabs
            tabs={leftTabs}
            active={tab}
            onChange={(id) => setTab(id as LeftTabId)}
            trailing={
              <button
                className="tabs__star"
                data-testid="bookmark-toggle"
                aria-pressed={bookmarked}
                aria-label={bookmarked ? 'เอาออกจากบุ๊กมาร์ก' : 'เก็บไว้ในบุ๊กมาร์ก'}
                title={bookmarked ? 'เอาออกจากบุ๊กมาร์ก' : 'เก็บไว้ในบุ๊กมาร์ก'}
                disabled={starBusy}
                onClick={() => void toggleStar()}
              >
                {bookmarked ? '★' : '☆'}
              </button>
            }
          />

          {tab === 'form' && (
            <div className="editor-col">
              <div className="card" style={{ padding: 16 }}>
                <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 12 }}>
                  <h2 style={{ margin: 0, fontSize: 15, flex: 1 }}>ข้อมูลสำหรับสร้างเอกสาร</h2>
                  <button
                    className="ghost"
                    style={{ fontSize: 12.5, padding: '5px 10px' }}
                    onClick={() => setAiOpen((v) => !v)}
                  >
                    {aiOpen ? 'ซ่อน AI' : 'AI ช่วยกรอก'}
                  </button>
                </div>

                <FormFields
                  fields={fields}
                  tags={tags}
                  data={data}
                  errors={showErrors ? errors : {}}
                  disabled={!canEdit}
                  onChange={setData}
                  templateKey={templateKey}
                  templateName={template.name}
                  notify={notify}
                />

                {errorCount > 0 && !showErrors && (
                  <button
                    className="ghost"
                    style={{ marginTop: 12 }}
                    onClick={() => setShowErrors(true)}
                  >
                    ตรวจสิ่งที่ยังขาด ({errorCount})
                  </button>
                )}
              </div>

              {aiOpen && (
                <div className="card" style={{ padding: 14, height: 620, display: 'flex' }}>
                  <div style={{ display: 'flex', flexDirection: 'column', width: '100%', minHeight: 0 }}>
                    <h2 style={{ margin: '0 0 4px', fontSize: 15 }}>AI ช่วยกรอกข้อมูล</h2>
                    <p className="muted" style={{ margin: '0 0 10px', fontSize: 12 }}>
                      เล่าความต้องการได้เลย — AI จะเติมเฉพาะช่องที่ยังว่าง
                    </p>
                    <AiChat
                      templateKey={templateKey}
                      templateName={template.name}
                      data={data}
                      onData={(next, changed) => {
                        setData(next)
                        if (changed.length > 0) {
                          notify(`AI เติมข้อมูล ${changed.length} ช่อง: ${changed.join(', ')}`)
                        }
                      }}
                      notify={notify}
                    />
                  </div>
                </div>
              )}
            </div>
          )}

          {tab === 'json' && (
            <div className="card" style={{ overflow: 'hidden' }}>
              <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--line)' }}>
                <h2 style={{ margin: 0, fontSize: 15 }}>ข้อมูลดิบ (JSON)</h2>
                <p className="muted" style={{ margin: '2px 0 0', fontSize: 12 }}>
                  แก้ตรง ๆ ได้ — ใช้เมื่อฟอร์มยังไม่มีช่องที่ต้องการ · ค่าที่แก้จะกลับไปอยู่ในฟอร์มด้วย
                </p>
              </div>
              <div style={{ padding: 12 }}>
                <JsonEditor
                  value={JSON.stringify(data, null, 2)}
                  onChange={(text) => {
                    try {
                      const parsed: unknown = JSON.parse(text)
                      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                        setData(parsed as Record<string, unknown>)
                      }
                    } catch {
                      /* พิมพ์ไปครึ่งทาง — ยังไม่ parse ได้ ปล่อยให้แก้ต่อ */
                    }
                  }}
                  tags={tags}
                  disabled={!canEdit}
                />
              </div>
            </div>
          )}
          {tab === 'history' && (
            <MyHistoryPanel templateKey={templateKey} onRestore={restoreFromHistory} />
          )}
        </div>

        {/* ───────── ขวา ───────── */}
        {/**
         * ⚠️ sticky อยู่ที่คอลัมน์นี้ ไม่ใช่ที่การ์ด
         *    เพราะตอนนี้แท็บถูกย้ายเข้ามาอยู่ในคอลัมน์เดียวกัน
         *    ถ้า sticky เฉพาะการ์ด แท็บจะเลื่อนหายไปทั้งที่เนื้อหายังอยู่ → ผู้ใช้สับสน
         */}
        <div
          className={`editor-col editor-col--right${pane === 'preview' ? ' editor-col--preview' : ''}`}
        >
          <Tabs tabs={rightTabs} active={pane} onChange={(id) => setPane(id as PaneId)} />

          {pane === 'preview' && (
            // ไม่มีหัวการ์ดแยก — ไม่มีข้อความ "ตัวอย่างเอกสาร" ซ้ำกับชื่อแท็บ
            // และไม่มี dropdown เลือกรูปแบบ (เดิมบีบจนหัวการ์ดสูงเปล่า ~67px)
            <div className="editor-preview card" style={{ overflow: 'hidden', position: 'relative' }}>
              {/**
               * overlay เตือนว่าข้อมูลเปลี่ยนแล้ว (ผู้ใช้สั่ง)
               *
               * ⚠️ ทับ**ทั้งการ์ด** ไม่ใช่แค่แถบเครื่องมือ
               *   เพราะตัวอย่างด้านล่างคือผลจากข้อมูลเก่า ถ้าให้ยังเลื่อน/ซูมได้
               *   ผู้ใช้จะเผลอดูผลลัพธ์ผิดชุดแล้วคิดว่าเป็นของใหม่
               *
               * ⚠️ "ใช้ผลเดิมต่อไป" จำค่า `data` เวอร์ชันที่กดไว้
               *   ถ้าผู้ใช้แก้เพิ่ม → `dataJson` เปลี่ยน → overlay กลับมาโผล่ใหม่
               */}
              {showStaleOverlay && (
                <div
                  data-testid="preview-stale"
                  style={{
                    position: 'absolute',
                    inset: 0,
                    zIndex: 6,
                    background: 'rgba(255, 255, 255, 0.88)',
                    backdropFilter: 'blur(2px)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    padding: 16,
                  }}
                >
                  <div
                    style={{
                      maxWidth: 400,
                      textAlign: 'center',
                      padding: 18,
                      borderRadius: 12,
                      border: '1px solid var(--line)',
                      background: '#fff',
                      boxShadow: '0 10px 30px rgba(26, 21, 35, 0.18)',
                    }}
                  >
                    <strong style={{ fontSize: 14.5 }}>ข้อมูลเปลี่ยนแล้ว</strong>
                    <p className="muted" style={{ fontSize: 12.5, margin: '6px 0 14px' }}>
                      ตัวอย่างที่เห็นยังเป็นผลจากข้อมูลก่อนแก้
                      <br />
                      ต้องการเรนเดอร์ใหม่เพื่อดูตัวอย่างล่าสุดไหม
                    </p>
                    <div style={{ display: 'flex', gap: 8, justifyContent: 'center', flexWrap: 'wrap' }}>
                      <button
                        onClick={() => void render_()}
                        disabled={busy}
                        data-testid="preview-stale-render"
                      >
                        {busy ? 'กำลังเรนเดอร์…' : 'เรนเดอร์ใหม่'}
                      </button>
                      <button
                        className="ghost"
                        onClick={() => setStaleDismissed(dataJson)}
                        data-testid="preview-stale-dismiss"
                      >
                        ใช้ผลเดิมต่อไป
                      </button>
                    </div>
                  </div>
                </div>
              )}
              {previewDoc ? (
                <DocumentPreview
                  key={previewDoc}
                  fileUrl={previewDoc}
                  label={template.name}
                  onPdf={setPdf}
                  toolbarExtra={
                    <DownloadMenu
                      templateId={template.versionId}
                      data={() => data}
                      label={template.name}
                      pageCount={pdf?.count ?? 0}
                      loadPdfForPng={async () => {
                        if (!pdf) throw new Error('ยังไม่มีตัวอย่างให้ดาวน์โหลดเป็นรูป')
                        return pdf
                      }}
                    />
                  }
                />
              ) : (
                <div className="muted" style={{ padding: '72px 24px', textAlign: 'center', fontSize: 14 }}>
                  กด “เรนเดอร์ตัวอย่าง” เพื่อดูผลลัพธ์เป็นรูป
                  <div style={{ marginTop: 6, fontSize: 12.5 }}>
                    ผลลัพธ์จะขึ้นตรงนี้ ไม่ต้องเลื่อนหน้าจอลงไปหา
                  </div>
                </div>
              )}
            </div>
          )}

          {pane === 'template' && (
            <SharePanel
              template={template}
              access={access}
              onAccess={setAccess}
              notify={notify}
              onDeleted={onClose}
              part="meta"
            />
          )}

          {pane === 'fields' && (
            <FieldBuilder
              fields={fields}
              tags={tags}
              canEdit={canEdit}
              busy={busy}
              onSave={saveFields}
              onImportTags={importTags}
              onClear={clearForm}
              notify={notify}
            />
          )}

          {/**
           * แท็บ "การแชร์และสิทธิ์" เดิมชื่อ "ผู้ใช้แม่แบบนี้" (ผู้ใช้สั่งเปลี่ยนชื่อ)
           * ผู้ใช้สั่งย้ายการ์ดการแชร์เข้ามาอยู่ในแท็บนี้ด้วย
           *
           * ⚠️ ยังคงโชว์ `HistoryPanel` ต่อ ไม่ตัดทิ้ง
           *    เพราะเป็นเรื่องเดียวกัน — ใครได้สิทธิ์ (การ์ดบน)
           *    และใครเคยใช้ไปแล้ว (การ์ดล่าง) ผู้ใช้ต้องดูทั้งสองอย่างด้วยกัน
           *    ตัดทิ้งเพราะ "ย้ายการ์ด" เท่านั้น = ทำฟีเจอร์ที่ยังใช้อยู่หายไปเงียบ ๆ
           */}
          {pane === 'history' && (
            <div style={{ display: 'grid', gap: 16 }}>
              <SharePanel
                template={template}
                access={access}
                onAccess={setAccess}
                notify={notify}
                onDeleted={onClose}
                part="access"
              />
              <HistoryPanel templateKey={templateKey} />
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

/** ยังไม่ได้ตั้งฟอร์ม → ใช้แท็กของแม่แบบเป็นช่องกรอกชั่วคราว */
function autoFieldsFromTags(tags: TemplateTag[]): FieldDef[] {
  return tags.map((t, i) => ({
    key: t.path,
    label: t.path,
    type: 'text' as const,
    group: '',
    order: i,
    required: false,
    ai: { enabled: true },
  }))
}
