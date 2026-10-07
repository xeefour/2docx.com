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
import Link from 'next/link'
import {
  api,
  ApiError,
  canDeleteTemplate,
  cloneName,
  templateKeyOf,
  type AccessView,
  type BookmarkRecord,
  type Template,
  type TemplateTag,
  type Tombstone,
} from './lib/api'
import Tabs from './Tabs'
import Pager from './Pager'
import ThumbLightbox from './ThumbLightbox'
import UploadGuide from './UploadGuide'
import TemplateEditor from './TemplateEditor'
// ⚠️ `InboxBell` ถูกถอดออกจาก sidebar แล้ว (ผู้ใช้สั่งให้เหมือนหน้า /account · /teams)
//   ไฟล์ `InboxBell.tsx` ยังอยู่ เผื่อภายหลังอยากได้ป้ายนับจดหมายกลับมา
import InboxPanel from './InboxPanel'
import StudioRail from './StudioRail'
import BookmarkButton, { type BookmarkTeam } from './BookmarkButton'
import RailMenuButton from '../components/RailMenuButton'
import { CrossLinks } from '../components/NavLinks'
import { readParam, readTemplateKey, setUrl, studioPath, TAB_PARAM } from './lib/urlState'

/**
 * ── มุมมีหน้ารายการ: รายการ / ชิด ─────────────────────────────────
 *
 * ผู้ใช้สั่ง: *"ในหน้าหลักสามารถเลือกได้ว่าจะแสดงเป็นรายการ หรือ grid"*
 *
 * ⚠️ เก็บใน localStorage เพราะเป็นค่ากำหนดส่วนตัวของผู้ใช้แต่ละคน
 *   ไม่ใช่การตั้งค่าของระบบ → ไม่ต้องเก็บใน Mongo และไม่ต้องรอ API
 * `grid` เป็นค่าเริ่มต้นเพราะมีรูปตัวอย่างให้ดู (ค่าเริ่มต้นเดิมคือรายการ)
 */
const VIEW_KEY = 'studio.listView'
const readStoredView = (): 'list' | 'grid' => {
  // SSR ไม่มี window → ค่าเริ่มต้นต้องไม่แตะ storage
  if (typeof window === 'undefined') return 'grid'
  try {
    return window.localStorage.getItem(VIEW_KEY) === 'list' ? 'list' : 'grid'
  } catch {
    // โหมดส่วนตัว/ปิด storage → ใช้ค่าเริ่มต้น (ไม่ควรทำให้ทั้งหน้าพัง)
    return 'grid'
  }
}

/**
 * ⚠️ รับเฉพาะ .docx — ไม่ใช่เพราะอยากจำกัด แต่เพราะทำไม่ได้จริง
 *   ดู `apps/worker/src/docserver.ts` ขั้นที่ 1 ของการส่งออก PDF:
 *     `renderToBuffer(templateId, { data, convertTo: 'docx' })`
 *   คือขอให้ Carbone แปลงแม่แบบเป็น .docx **เสมอ** ไม่ว่าต้นฉบับจะเป็นนามสกุลอะไร
 *   แม่แบบ .xlsx/.pptx จึงตายที่ขั้นนี้ (เคยเจอจริง: เรนเดอร์ .xlsx เป็น PDF ไม่ผ่าน)
 *
 *   ถ้าวันหนึ่งรองรับครบทุกชนิดจริง ค่อยขยายที่นี่ทั้งอันนี้และฝั่ง API
 *   (`ALLOWED_EXT` ใน apps/api/.../templates/route.ts)
 */
const ACCEPT = '.docx'
const MAX_MB = 20

type ListTab = 'all' | 'mine' | 'shared' | 'bookmarks' | 'inbox'

/**
 * แท็บของหน้ารายการใช้ `?tabs=` ตัวเดียวกับฝั่งซ้ายของหน้าแก้ไข
 *
 * ⚠️ ค่าใน URL อาจเป็นของ**หน้าแก้ไข** ได้ (เช่นคนกดย้อนกลับมาจาก
 *    `/studio/<key>?tabs=form` แล้ว URL ยังมี query ติดมา)
 *    → ต้องตรวจว่าอยู่ในชุดของหน้านี้ก่อน ไม่งั้นจะเปิดแท็บผิด
 *
 * ⚠️ `inbox` อยู่ในชุดนี้ด้วย แม้จะไม่ใช่รายการแม่แบบ
 *   เพราะต้องเปิดจากลิงก์ตรง ๆ ได้ (`/studio?tabs=inbox`) และรีเฟรชแล้วต้องอยู่แท็บเดิม
 */
const LIST_TABS: ListTab[] = ['all', 'mine', 'shared', 'bookmarks', 'inbox']

/** อ่านแท็บหน้ารายการจาก URL ได้ — ค่าผิด/ไม่มี = `all` */
function readListTab(search: string): ListTab {
  const t = readParam(search, TAB_PARAM)
  return LIST_TABS.includes(t as ListTab) ? (t as ListTab) : 'all'
}

/**
 * @param initialKey key ของแม่แบบที่จะเปิดทันที — มาจาก path `/studio/<key>`
 *   (route `app/studio/[key]/page.tsx` ส่งมาให้ จึงรีเฟรชแล้วยังอยู่แม่แบบเดิม)
 * @param meName ชื่อผู้ใช้สำหรับ footer — มาจาก server แบบเดียวกับหน้า /teams
 *   (ถ้าดึงฝั่ง client จะเห็น footer ว่างแล้วกระพริบตอนข้อมูลมาถึง)
 */
export default function Studio({
  initialKey,
  meName = '',
}: { initialKey?: string; meName?: string } = {}) {
  const [templates, setTemplates] = useState<Template[]>([])
  const [categories, setCategories] = useState<string[]>([])
  const [access, setAccess] = useState<Record<string, AccessView>>({})
  /** มุมมีรายการ: รายการ | ชิด (จำค่าไว้ต่อคนใน localStorage) */
  const [listView, setListView] = useState<'list' | 'grid'>(readStoredView)
  const [page, setPage] = useState(1)
  /** ลิ้นชักเปิดอยู่หรือไม่ — มีผลเฉพาะจอเล็ก (CSS ซ่อน sidebar บนจอใหญ่) */
  const [railOpen, setRailOpen] = useState(false)
  /** key → รูปตัวอย่างแรก (null = ยังไม่มีรูป หรือดูไม่ได้) */
  const [thumbs, setThumbs] = useState<Record<string, string | null>>({})
  /** แม่แบบที่กำลังเปิดดูรูปตัวอย่างเต็ม (null = ปิดอยู่) */
  const [peek, setPeek] = useState<{ key: string; name: string } | null>(null)

  const [bookmarks, setBookmarks] = useState<BookmarkRecord[]>([])
  /**
   * ทีมของผู้ใช้ — เป็นตัวเลือกใน dropdown ของปุ่มดาว
   *
   * ⚠️ โหลดพร้อมกันใน `load()` แล้ว ไม่ต้องโหลดซ้ำในปุ่ม
   *   เก็บเป็น `BookmarkTeam[]` (มีแค่ team+name) เพราะปุ่มดาวใช้แค่สองค่านี้
   *   ส่วน `TeamAccess` ที่ API คืนมามี role/จำนวนสมาชิกเพิ่ม ซึ่่งไม่ได้ใช้ตรงนี้
   */
  const [teams, setTeams] = useState<BookmarkTeam[]>([])
  const [search, setSearch] = useState('')
  const [category, setCategory] = useState('')
  const [tag, setTag] = useState('')
  const [tab, setTab] = useState<ListTab>('all')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const [notFound, setNotFound] = useState<string | null>(null)

  const [open, setOpen] = useState<Template | null>(null)

  const load = useCallback(async () => {
    try {
      setError(null)
      const [t, c, b, tm] = await Promise.all([
        api.listTemplates(),
        api.categories(),
        api.bookmarks(),
        /*
         * ⚠️ ทีมต้องโหลด**ที่หน้ารายการ** ไม่ใช่ฝั่งปุ่มดาวหรือแท็บแชร์
         *   เพราะปุ่มดาวมีทั้งในตารางรายการและในหน้าแก้ไข
         *   ถ้าแต่ละที่โหลดเอง จะเกิดหลายรอบและอาจได้ค่าไม่ตรงกัน
         *   (เกิดแบบเดียวกับที่ sidebar ต้องรวมเป็นชิ้นเดียว)
         */
        api.myTeams().catch(() => ({ items: [] })),
      ])
      setTemplates(t.items)
      setCategories(c.items)
      setBookmarks(b.items)
      setTeams(tm.items)
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
    if (found) {
      setOpen(found)
      return
    }
    /**
     * ── แม่แบบที่อยู่ถังขยะ: ยังเปิดได้ ──
     *
     * ⚠️ ต้องพยายามเปิด ไม่ใช่บอกว่าไม่พบทันที
     *   เพราะเรา**กรองแม่แบบถังขยะออกจากรายการ** (ไม่งั้นผู้ใช้กดลบแล้วยังเห็นอยู่)
     *   แต่ผู้ใช้สั่งให้ *"แจ้งเตือนผู้ใช้ว่าจะลบแม่แบบนี้ ใครจะใช้ให้ clone ไปแทน"*
     *   ถ้าบอก "ไม่พบแม่แบบ" เท่านั้น ป้ายเตือนก็ไม่มีทางโชว์
     *   และคนที่กดลิงก์ที่แชร์ไว้จะเจอแค่หน้ารายการ — แย่กว่าไม่เตือนเลย
     *
     * ไฟล์ยังอยู่ครบ 14 วัน จึงประกอบ `Template` จากข้อมูล tombstone ได้
     * ฟิลด์ที่ไม่มีใน tombstone (`type`/`size`/`createdAt`) ใส่ค่าโปร่ง ๆ
     * เพราะหน้าแก้ไขไม่ได้ใช้มันอยู่แล้ว
     */
    void api
      .trashOf(initialKey)
      .then(({ item }) => {
        if (!item) {
          setNotFound(`ไม่พบแม่แบบ key ${initialKey} — แสดงรายการทั้งหมดแทน`)
          return
        }
        setNotFound(null)
        setOpen({
          id: item.templateKey,
          versionId: item.templateKey,
          name: item.name,
          category: item.category,
          tags: item.tags,
          type: '',
          size: 0,
          createdAt: 0,
        })
      })
      .catch(() => setNotFound(`ไม่พบแม่แบบ key ${initialKey} — แสดงรายการทั้งหมดแทน`))
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

  /** ทีมที่บุ๊กมาร์กแต่ละแม่แบบเก็บไว้ — null = ส่วนตัว */
  const bookmarkTeams = useMemo(() => {
    const m = new Map<string, string | null>()
    for (const b of bookmarks) m.set(b.templateKey, b.team ?? null)
    return m
  }, [bookmarks])

  /**
   * เก็บบุ๊กมาร์กลงที่ที่เลือก — เรียกซ้ำ = **เปลี่ยนที่เก็บ** ไม่ใช่สร้างซ้ำ
   * (หนึ่งแม่แบบมีบุ๊กมาร์กได้รายการเดียว ดู `BookmarkRecord`)
   *
   * ⚠️ `team` คือ "เก็บไว้ที่ไหน" **ไม่ใช่** ย้ายแม่แบบเข้าทีม
   *   ย้ายแม่แบบอยู่ที่ `api.setTemplateTeam` (แท็บการแชร์และสิทธิ์)
   *   ปนสองเรื่องนี้แล้วผู้ใช้จะเผลอแชร์แม่แบบตัวเองออกไปทั้งทีม
   *
   * ⚠️ ต้อง `throw` ต่อให้ผู้เรียกด้วย
   *   หน้าแก้ไข `return` ออกจากหน้านี้ไปก่อนถึงจุดที่เรนเดอร์ `error`
   *   ถ้ากลืน error ทิ้ง ผู้ใช้จะเห็นดาวไม่เปลี่ยนและไม่มีข้อความบอกว่าเพราะอะไร
   */
  async function bookmarkTo(t: Template, team: string | null) {
    try {
      await api.addBookmark({
        templateKey: templateKeyOf(t),
        versionId: t.versionId,
        templateName: t.name,
        team,
      })
      const r = await api.bookmarks()
      setBookmarks(r.items)
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e))
      throw e
    }
  }

  /** เอาบุ๊กมาร์กออกทั้งหมด (ไม่สนว่าเก็บไว้ที่ไหน) */
  async function unbookmark(t: Template) {
    const key = templateKeyOf(t)
    try {
      await api.removeBookmark(key)
      setBookmarks((b) => b.filter((x) => x.templateKey !== key))
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e))
      throw e
    }
  }

  /*
   * (เดิมมี `toggleBookmark` ที่เดาเองว่าจะเพิ่มหรือลบจากสถานะปัจจุบัน
   *  ตอนนี้ผู้เรียกต้องบอก**ปลายทาง**ชัดเจนแทน เพราะเมื่อมีทีม
   *  ปุ่มเดียวต้องเลือกได้ว่าจะย้ายที่เก็บ ซึ่ง "เดา" ไม่ได้)
   */

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
      if (tag && !t.tags.includes(tag)) return false
      if (!q) return true
      return (
        t.name.toLowerCase().includes(q) ||
        t.versionId.toLowerCase().includes(q) ||
        t.tags.some((x) => x.toLowerCase().includes(q))
      )
    })
  }, [templates, search, category, tag, tab, access, bookmarkKeys])

  /**
   * ── แบ่งหน้า (ผู้ใช้ชี้ว่าเดิมไม่มี) ──────────────────────────────
   * วัดแล้ว: แท็บ "แม่แบบทั้งหมด" มี 43 รายการ หน้าสูง 5,982px = เลื่อน 6 จอ
   * และ API คืน `hasMore` มาให้ตั้งแต่แรก แต่หน้าเว็บไม่เคยใช้
   *
   * ⚠️ ต้องแบ่งหน้า**ฝั่งเบราว์เซอร์** ไม่ใช่ที่ API
   *   เพราะตัวกรองทั้งหมด (แท็บ · หมวด · แท็ก · ค้นหา · บุ๊กมาร์ก) คำนวณที่ `filtered`
   *   ถ้าให้ API แบ่งหน้า ผู้ใช้ที่อยู่แท็บ "ที่ฉันเป็นเจ้าของ" จะเห็นหน้าว่าง
   *   เพราะ API ไม่รู้ว่าผู้ใช้อยู่แท็บไหน
   */
  const LIST_PAGE_SIZE = 12
  const pageCount = Math.max(1, Math.ceil(filtered.length / LIST_PAGE_SIZE))
  /**
   * ⚠️ ผู้ใช้ลบ/ย้ายแม่แบบจนหน้าสุดท้ายหายไป ต้องถูกดึงกลับ
   *   ไม่ใช่ค้างหน้าว่างจนกด ‹ ไม่ได้ (เคยเจอกับถังขยะตอนทำครั้งนี้)
   */
  const safePage = Math.min(page, pageCount)
  const shown = filtered.slice((safePage - 1) * LIST_PAGE_SIZE, safePage * LIST_PAGE_SIZE)

  /**
   * เปลี่ยนตัวกรองแล้วต้องกลับหน้าแรก — ไม่งั้นค้างหน้า 5 ทั้งที่กรองเหลือ 2 รายการ
   *
   * ⚠️ ห้ามใส่ `listView` ในรายการนี้
   *   การสลับชิด/กว้างไม่ได้เปลี่ยนผลลัพธ์อะไร เปลี่ยนแค่ความหนาแน่นของหน้าเดิม
   *   ถ้าดันกลับหน้า 1 ผู้ใช้ที่เพิ่งเลื่อนไปหน้า 4 เพื่อหาแม่แบบที่มีรูปย่อ
   *   จะถูกโยนกลับไปหน้าแรกทุกครั้งที่กดสลับโหมด (เจอจาก test-row-peek ตก 8 ข้อ)
   */
  useEffect(() => {
    setPage(1)
  }, [search, category, tag, tab])
  useEffect(() => {
    if (page !== safePage) setPage(safePage)
  }, [page, safePage])

  /**
   * ดึงภาพย่อของทุกแม่แบบที่เห็นในรายการ ใน**คำขอเดียว**
   *
   * ⚠️ ถ้ายิงทีละแถวจะเป็น N+1 — หน้าแรกยิงหลายสิบคำขอพร้อมกัน
   *   และแต่ละอันยังยิง S3 เพื่อออก presigned URL อีกที
   *
   * ⚠️ ภาพย่อโหลดไม่สำเร็จ = ไม่ทำให้หน้ารายการพัง
   *   ตัวอย่างคือตกหลุดออกไป ไม่ใช่ตัวหลักของหน้านี้ → โหลดไม่สำเร็จก็ปล่อยเป็นค่าว่าง
   */
  useEffect(() => {
    if (loading || filtered.length === 0) {
      setThumbs({})
      return
    }
    let alive = true
    const keys = [...new Set(filtered.map(templateKeyOf))]
    void api
      .thumbs(keys)
      .then(({ items }) => {
        if (!alive) return
        setThumbs(
          Object.fromEntries(
            Object.entries(items).map(([k, v]) => [
              k,
              v ? api.previewFileUrl(k, v.id) : null,
            ]),
          ),
        )
      })
      .catch(() => {
        // เงียบไว้ — ภาพย่อเป็นของเสริม ไม่ใช่ตัวหลักของหน้า
        if (alive) setThumbs({})
      })
    return () => {
      alive = false
    }
  }, [loading, filtered])


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
          /*
           * ดาวบุ๊กมาร์กในหน้าแก้ไข (ผู้ใช้สั่ง: *"เพิ่มปุ่มสัญาลักษ์ bookmark ขวามือ"*)
           *
           * สถานะถือที่ `bookmarks` ของหน้านี้แหล่งเดียว → กลับไปหน้ารายการแล้วดาว
           * ในตารางตรงกันเสมอ ไม่ต้องยิง `load()` ใหม่
           */
          bookmarked={bookmarkKeys.has(templateKeyOf(open))}
          bookmarkTeam={bookmarkTeams.get(templateKeyOf(open)) ?? null}
          teams={teams}
          onBookmark={(team) => bookmarkTo(open, team)}
          onUnbookmark={() => unbookmark(open)}
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

  /**
   * ⚠️ ไม่ใส่ `count` ทุกแท็บ
   *   ผู้ใช้สั่งให้ sidebar เหมือนหน้า /account กับ /teams ซึ่งโชว์แค่ชื่อ
   *   วัดจากหน้าเว็บจริงแล้วตัวเลข (44, 1) เป็นสิ่งเดียวที่ทำให้รายการดูไม่เหมือนหน้าอื่น
   *   (ตัวเลขยังอยู่ในหัวข้อแถบบนถ้าผู้ใช้ต้องการดูจำนวน)
   */
  const tabs = [
    { id: 'all', label: 'แม่แบบทั้งหมด' },
    { id: 'mine', label: 'ที่ฉันเป็นเจ้าของ' },
    { id: 'shared', label: 'แชร์กับฉัน' },
    { id: 'bookmarks', label: 'บุ๊กมาร์ก' },
    { id: 'inbox', label: 'จดหมาย' },
  ]

  /** ชื่อแท็บที่เปิดอยู่ — ย้ายมาเป็นหัวเรื่องในแถบบน ตอนนี้ชื่อแอปอยู่ที่ sidebar แล้ว */
  const activeTitle = tabs.find((t) => t.id === tab)?.label ?? 'แม่แบบ'

  return (
    <div className="shell">
      {/*
       * ⚠️ ผู้ใช้สั่งเอากระดิ่ง 🔔 ออก ให้เหลือชื่อผู้ใช้ + ออกจากระบบเหมือนหน้าอื่น
       *   (กระดิ่งเป็นตัวเดียวใน sidebar ที่ไม่ใช่เมนู และ /account · /teams ไม่มี)
       *
       *   ผลที่ตามมา: จำนวนจดหมายที่ยังไม่อ่านไม่มีที่โชว์แล้ว
       *   ผู้ใช้ต้องกดแท็บ "จดหมาย" เพื่อดู → ถ้าภายหลังอยากได้ป้ายนับกลับมา
       *   ให้ใส่ `count: inboxUnread` ที่แท็บจดหมายได้เลย (โครงยังรองรับอยู่)
       *
       *   ส่วนล่าง (ชื่อผู้ใช้ + ออกจากระบบ) ย้ายไปอยู่ใน `RailFooter` ตัวเดียวกับทุกหน้า
       *   จึงเหลือส่งแค่ `userName` — ไม่ต้องเขียน `flex: 1 1 0` ซ้ำในทุกหน้า
       *
       * ⚠️ คอมเมนต์ต้องอยู่**ก่อนเปิดแท็ก** ไม่ใช่ระหว่างแอตทริบิวต์
       *   JSX attribute ไม่รับคอมเมนต์ตรงตำแหน่งนั้น → error "'...' expected"
       */}
      <StudioRail
        tabs={tabs}
        active={tab}
        onTab={(id) => {
          pickListTab(id as ListTab)
          // ⚠️ บนจอเล็กต้องปิดลิ้นชักทุกครั้งที่เลือก
          //   ไม่งั้นผ้าคลุมมืดยังบังเนื้อหาที่เพิ่งเลือกไว้
          setRailOpen(false)
        }}
        total={templates.length}
        action={
          <UploadButton
            onDone={async (name) => {
              setToast(`อัปโหลด "${name}" แล้ว`)
              await load()
            }}
            onError={setError}
          />
        }
        extraNav={
          /**
           * ⚠️ เมนูข้ามหน้าย้ายไปอยู่ใน CrossLinks (components/NavLinks.tsx) แล้ว
           *   เพราะเคยมี 4 ชุดที่แต่ละหน้าเขียนเอง คนละที่คนละลำดับ
           *   ผู้ใช้สั่ง 2026-10-07: "อื่น ๆ ทำให้เหมือนกับ /studio"
           *   ตอนนี้หน้านี้เป็นเจ้าของแบบอ้างอิง → ตำแหน่งและลำดับต้องเหมือนทุกหน้า
           *
           * ⚠️ onNavigate ปิดลิ้นชักเมื่อจอเล็ก
           *   การกดจะเปลี่ยนหน้าให้อยู่แล้ว แต่ระหว่างนั้นผ้าคลุมมืดยังทับอยู่
           *   ผู้ใช้จะเห็นเนื้อหาค้างเป็นจอเดิมแล้วคิดว่ากดไม่ได้
           */
          <CrossLinks current="/studio" onNavigate={() => setRailOpen(false)} />
        }
        userName={meName}
        open={railOpen}
        onClose={() => setRailOpen(false)}
      />

      <div className="shell__main">
        <div className="pagebar">
          <RailMenuButton onOpen={() => setRailOpen(true)} />
          <h1 className="pagebar__title">{activeTitle}</h1>
        </div>


      {/*
       * ⚠️ เงื่อนไข `tab !== 'inbox'` ครอบ**เฉพาะ**ส่วนที่เป็นรายการแม่แบบ
       *   ไม่งั้นผู้ใช้ที่เปิดแท็บจดหมายจะเห็นช่องค้นหา/หมวดที่กรองแม่แบบ
       *   ซึ่งไม่มีทางมีผลกับอะไรเลย แล้วเข้าใจว่าหน้าเสีย
       *   ส่วน Banner ด้านล่างยังอยู่ที่เดิม เพื่อไม่ให้ลำดับภาพของแท็บเดิมเปลี่ยน
       */}
      {tab !== 'inbox' && (
        <>
      {/* ตัวกรอง — ไม่ใส่ margin แล้ว ใช้ gap ของพ่อแทน ไม่งั้นจะเป็น 14 + 16 = 30px */}
      <div className="filters">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="ค้นหาจากชื่อ แท็ก หรือ versionId"
          className="filters__q"
        />
          <div className="viewtoggle" role="group" aria-label="วิธีแสดงรายการ">
            {(['grid', 'list'] as const).map((m) => (
              <button
                key={m}
                type="button"
                className={`viewtoggle__btn${listView === m ? ' is-on' : ''}`}
                data-testid={`view-${m}`}
                aria-pressed={listView === m}
                /**
                 * ผู้ใช้สั่ง: *"ไม่เข้าใจความหมาย ชิด ไม่ต้องใส่ข้อความ"*
                 *   → ตัดคำว่า "ชิด"/"รายการ" ออก เหลือไอคอนอย่างเดียว
                 *   คำอธิบายจึงต้องย้ายไป `title` (คนวางเมาส์เห็น)
                 *   และ `aria-label` (โปรแกรมอ่านหน้าจออ่าน) — ไม่งั้นปุ่มจะไร้ชื่อ
                 */
                title={m === 'grid' ? 'แสดงเป็นชิด' : 'แสดงเป็นรายการ'}
                aria-label={m === 'grid' ? 'แสดงเป็นชิด' : 'แสดงเป็นรายการ'}
                onClick={() => {
                  setListView(m)
                  try {
                    window.localStorage.setItem(VIEW_KEY, m)
                  } catch {
                    // storage ใช้ไม่ได้ = เลือกได้แต่จำข้ามหน้า
                  }
                }}
              >
                <span className="viewtoggle__i" aria-hidden="true">
                  {/**
                   * ⚠️ โหมดชิดใช้สี่เหลี่ยม**เดียว** ไม่ใช่ตาราง 2×2
                   *   ผู้ใช้สั่ง: *"รูป icon ตารางสี่เหลี่ยมมากไป
                   *   ขอรูปสี่เหลี่ยม 2 x 2 รวมเป็นสี่เหลี่ยมเดียว"*
                   *   เดิมใช้ `▦` (U+25A6) ซึ่งคือสี่เหลี่ยมที่ถูกแบ่ง 4 ช่อง
                   *   มองแล้วเหมือนไอคอน "ตารางข้อมูล" มากกว่า "การ์ดแม่แบบ"
                   *   ซึ่งคือสิ่งที่โหมดนี้แสดงจริง
                   *
                   *   `■` (U+25A0) เป็นสี่เหลี่ยมเต็มหนึ่งอัน
                   *   น้ำหนักเท่ากับ `☰` ของโหมดรายการ จึงไม่หนักหนาเกินกัน
                   */}
                  {m === 'grid' ? '■' : '☰'}
                </span>
              </button>
            ))}
          </div>
          <select
            className="filters__cat"
            value={category}
            onChange={(e) => setCategory(e.target.value)}
          >
          <option value="">ทุกหมวด</option>
          {categories.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
        {(category || tag) && (
          <button
            className="ghost"
            onClick={() => {
              setCategory('')
              setTag('')
            }}
          >
            ล้างตัวกรอง
          </button>
        )}
        {/*
         * แท็กไม่มีช่องเลือกในแถบตัวกรอง (หมวดมี `<select>` ให้เห็นค่าอยู่แล้ว)
         *   ถ้าไม่มีป้ายนี้ ผู้ใช้จะกดชิปแล้วรายการหาย แต่ไม่รู้ว่าถูกกรองอะไร
         *   และกด "ล้างตัวกรอง" ต้องเดาเอง ว่าต้องกดหรือเปล่า
         *   ยกตัวนี้ทำหน้าที่ทั้งบอกค่าและยกเลิกในจุดเดียว
         */}
        {tag && (
          <button
            className="pill pill--btn is-on"
            data-testid="clear-tag"
            onClick={() => setTag('')}
            title="เอาตัวกรองแท็กออก"
          >
            แท็ก: {tag} ✕
          </button>
        )}
        <div className="muted filters__count">
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
        </>
      )}

      {/*
       * แท็บจดหมาย — โหลดและนับเองทั้งหมด
       * ⚠️ ไม่ต้องส่ง `onChanged` แล้ว เพราะผู้ใช้สั่งเอากระดิ่งกับป้ายนับออก
       *   และให้ sidebar เหมือนหน้า /account · /teams
       */}
      {tab === 'inbox' && <InboxPanel />}

      {/*
       * `padding: 0` ในการ์ดข้างล่าง — แถวรายการจัด padding ตัวเองทั้งหมด
       *   ถ้าไม่กำกับจะซ้อนกับค่าตั้งต้นของ `.card`
       *
       * ⚠️ คอมเมนต์นี้ต้องอยู่**นอก**วงเล็บของ `{cond && ( … )}` ไม่ใช่ข้างใน
       *   เพราะข้างในคือตำแหน่งนิพจน์ JS ที่ไม่รับคอมเมนต์ JSX
       *
       * ⚠️ และห้ามพิมพ์รูปแบบคอมเมนต์ JSX ซ้อนในคอมเมนต์นี้
       *   เพราะเครื่องหมายปิดจะไปปิดคอมเมนต์นี้ก่อนเวลา → ทั้งไฟล์พัง
       */}
      {tab !== 'inbox' && (
      <div className="card" style={{ overflow: 'hidden', padding: 0 }}>
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
          <table className={`tpllist${listView === 'grid' ? ' tpllist--grid' : ''}`}>
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
              {shown.map((t) => {
                const key = templateKeyOf(t)
                const view = access[key]
                return (
                  <TemplateRow
                    key={t.versionId}
                    tpl={t}
                    view={view}
                    starred={bookmarkKeys.has(key)}
                    thumb={thumbs[key] ?? null}
                    bookmarkTeam={bookmarkTeams.get(key) ?? null}
                    teams={teams}
                    // ⚠️ ต้อง `.catch()` — `bookmarkTo` โยน error ต่อให้ผู้เรียก
                    //   แต่ตรงนี้ข้อความแสดงผ่าน `setError` ของหน้านี้อยู่แล้ว
                    //   ถ้าไม่จับ promise จะกลายเป็น unhandledrejection (หน้าจอแดง)
                    onBookmark={(team) => void bookmarkTo(t, team).catch(() => {})}
                    onUnbookmark={() => void unbookmark(t).catch(() => {})}
                    activeCategory={category}
                    activeTag={tag}
                    onPickCategory={(c) => setCategory(category === c ? '' : c)}
                    onPickTag={(g) => setTag(tag === g ? '' : g)}
                    onPeek={() => setPeek({ key, name: t.name })}
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
      {pageCount > 1 && (
        <Pager
          page={safePage}
          pageCount={pageCount}
          onChange={setPage}
          testId="list-pager"
          summary={`ทั้งหมด ${filtered.length} แม่แบบ`}
        >
          {`แสดง ${(safePage - 1) * LIST_PAGE_SIZE + 1}–${Math.min(
            safePage * LIST_PAGE_SIZE,
            filtered.length,
          )}`}
        </Pager>
      )}

      </div>
      )}

      {peek && (
        <ThumbLightbox
          templateKey={peek.key}
          templateName={peek.name}
          onClose={() => setPeek(null)}
        />
      )}

      <TrashPanel notify={setToast} onRestored={load} />
      </div>
    </div>
  )
}

/**
 * ── ถังขยะแม่แบบ ────────────────────────────────────────────────────
 *
 * ผู้ใช้สั่ง: *"…ทำให้ restore ภายหลังได้"*
 *
 * ⚠️ ต้องมีที่ให้ผู้ใช้**กลับมาเจอ**แม่แบบที่ตัวเองเพิ่งลบ
 *   ไม่งั้นหลังกดลบปุ่ม "กู้คืน" ที่ป้ายเตือนบนหน้าแม่แบบก็เป็นทางเดียว
 *   แต่พอปิดหน้านั้นไป ก็หาไม่เจออีกเลย แล้วคิดว่ากดลบถาวร
 *
 * ⚠️ โหลดซ้ำหลังกู้คืน เพราะแม่แบบกลับมาอยู่ในรายการหลักด้วย
 * ⚠️ โหลดซ้ำหลังกู้คืน เพราะแม่แบบกลับมาอยู่ในรายการหลักด้วย
 *
 * ── แบ่งหน้า (ผู้ใช้ชี้ว่าเดิมไม่มี) ──────────────────────────────────
 * ถังขยะไม่ได้มีแค่ 3 รายการเสมอไป ถ้าผู้ใช้ลบทีละเอกสารแล้วไม่กดกู้คืน
 * ภายใน 14 วันอาจสะสมได้หลายร้อยรายการ และเดิมโหลดมาทั้งหมดมาเรนเดอร์รวดเดียว
 * ตอนนี้แบ่งหน้าที่ API แล้วใช้ `Pager` ตัวเดียวกับหน้าประวัติ
 */
const TRASH_PAGE_SIZE = 10

function TrashPanel({
  notify,
  onRestored,
}: {
  notify: (msg: string) => void
  onRestored: () => void
}) {
  const [items, setItems] = useState<Tombstone[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [busy, setBusy] = useState('')

  const load = useCallback(() => {
    void api
      .trashList(TRASH_PAGE_SIZE, (page - 1) * TRASH_PAGE_SIZE)
      .then((r) => {
        setItems(r.items ?? [])
        setTotal(r.total ?? 0)
      })
      // โหลดไม่ได้ = ไม่มีถังขยะ ไม่ต้องรบกวนผู้ใช้ด้วยข้อความ error
      .catch(() => {
        setItems([])
        setTotal(0)
      })
  }, [page])

  useEffect(load, [load])

  const pageCount = Math.max(1, Math.ceil(total / TRASH_PAGE_SIZE))
  /**
   * ⚠️ ผู้ใช้กดกู้คืน/ลบจนหน้าที่อยู่ไม่มีของแล้ว
   *   ต้องดึงกลับไปหน้าสุดท้าย ไม่ใช่ค้างหน้าว่างไว้
   *   (เคยเจอกับหน้าประวัติ: กู้คืนหมดหน้าสุดท้ายแล้วเห็นรายการว่างจนกดกลับไม่ได้)
   */
  if (page > pageCount) {
    setPage(pageCount)
    return null
  }
  if (items.length === 0) return null

  return (
    <div
      data-testid="trash-panel"
      className="card"
      style={{ padding: 16, marginTop: 16, borderStyle: 'dashed' }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
        <h2 style={{ margin: 0, fontSize: 15, flex: 1 }}>🗑️ ถังขยะ ({total})</h2>
      </div>
      <p className="muted" style={{ fontSize: 12.5, marginTop: 0, marginBottom: 10 }}>
        แม่แบบเหล่านี้หายจากรายการแล้ว แต่ไฟล์ยังอยู่ จะถูกลบถาวรใน 14 วัน
        กู้คืนได้ตลอดช่วงนั้น
      </p>

      {/**
       * ⚠️ `minmax(0, 1fr)` คือหัวใจของการแก้เรื่องนี้ — อย่าถอดออก
       *   คอลัมน์กริดแบบ `auto` จะถูกบังคับให้ ≥ min-content ของแถว
       *   และ min-content ของชื่อที่เป็น hash คือ**ความกว้างทั้งข้อความ** (468px)
       *   เพราะมันไม่มีช่องว่างให้พักบรรทัด
       *   (`overflow: hidden` ช่วยไม่ได้ — มันแค่ตัดสายตา ไม่ได้ลดขนาดเชิงสายฟลี)
       *
       * วัดแล้วก่อนแก้: คอลัมน์กว้าง 489.7px ในขณะที่กล่องถังขยะกว้างแค่ 283px
       *   → แถวล้นออกนอกการ์ดไปชนขอบหน้า ปุ่ม "กู้คืน" โดนดันจนกดไม่ทัน
       */}
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 8 }}>
        {items.map((t) => (
          <div
            key={t.templateKey}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              flexWrap: 'wrap',
              padding: '8px 10px',
              border: '1px solid var(--line)',
              borderRadius: 8,
            }}
          >
            <div style={{ flex: 1, minWidth: 160 }}>
              {/**
               * ⚠️ ชื่อแม่แบบไม่ได้เป็นคำธรรมดาเสมอไป
               *   คีย์จาก Carbone คือเลขฐานสิบหก 64 หลัก ซึ่ง**ไม่มีช่องว่างให้พักบรรทัด**
               *   CSS ปกติจึงพักมันไม่ได้ → ข้อความรั่นออกมาเกินกล่อง
               *
               * วัดแล้ว (test-trash-longname): ที่ 360–560px ตัวอักษรทับปุ่ม "กู้คืน"
               *   ถึง 1,032px² และล้นออกนอกการ์ดถังขยะ 195px
               *
               * `overflow: hidden` คือกุญแจจริง ๆ ไม่ใช่แค่ `textOverflow`
               *   เพราะแถวนี้เป็น grid item → ขนาด track ถูกบังคับให้ ≥ min-content
               *   ของข้อความ (468px) แถวจึงกว้างเกินการ์ด ต้องตัดที่ min-content
               *   ให้เป็น 0 ก่อน ไม่งั้น `…` จะไม่มีวันโผล่
               *
               * `title` เก็บชื่อเต็มไว้ เพราะถังขยะเป็นที่เดียวที่ผู้ใช้จำแนก
               *   แม่แบบพวกนี้ได้ — ตัดทิ้งโดยไม่มีทางอ่านชื่อครบถือว่าผิด
               */}
              <div
                style={{
                  fontSize: 13.5,
                  fontWeight: 600,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
                title={t.name}
              >
                {t.name}
              </div>
              <div className="muted" style={{ fontSize: 12 }}>
                {t.category || 'ไม่มีหมวด'} · เหลืออีก{' '}
                <b style={{ color: t.daysLeft <= 3 ? 'var(--err)' : undefined }}>{t.daysLeft} วัน</b>
                {t.deletedByName ? ` · ลบโดย ${t.deletedByName}` : ''}
              </div>
            </div>
            <button
              disabled={busy === t.templateKey}
              data-testid={`trash-restore-${t.templateKey}`}
              onClick={() => {
                setBusy(t.templateKey)
                void api
                  .restoreTemplate(t.templateKey)
                  .then(() => {
                    notify(`กู้คืน "${t.name}" แล้ว`)
                    onRestored()
                    load()
                  })
                  .catch((e) => notify(e instanceof ApiError ? e.message : String(e)))
                  .finally(() => setBusy(''))
              }}
            >
              {busy === t.templateKey ? 'กำลังกู้คืน…' : 'กู้คืน'}
            </button>
          </div>
        ))}
      </div>

      {/**
       * แถบแบ่งหน้า — ซ่อนตอนมีหน้าเดียว
       * ถ้าโชว์ตอนมีแค่หน้าเดียว ผู้ใช้จะเห็นปุ่ม ‹ 1 › ที่กดอะไรไม่ได้เลย
       * แล้วคิดว่าระบบพัง
       */}
      {pageCount > 1 && (
        <Pager
          page={page}
          pageCount={pageCount}
          onChange={setPage}
          testId="trash-pager"
          summary={`ทั้งหมด ${total} รายการ`}
        >
          {`แสดง ${(page - 1) * TRASH_PAGE_SIZE + 1}–${Math.min(
            page * TRASH_PAGE_SIZE,
            total,
          )}`}
        </Pager>
      )}
    </div>
  )
}

// ── แถวในตาราง ────────────────────────────────────────────────
function TemplateRow({
  tpl,
  view,
  starred,
  bookmarkTeam,
  teams,
  onBookmark,
  onUnbookmark,
  thumb,
  activeCategory,
  activeTag,
  onPickCategory,
  onPickTag,
  onPeek,
  onOpen,
  onChanged,
  onError,
  notify,
}: {
  tpl: Template
  view?: AccessView
  starred: boolean
  /** ทีมที่บุ๊กมาร์กนี้เก็บไว้ — null = ส่วนตัว */
  bookmarkTeam: string | null
  /** ตัวเลือกทีมของผู้ใช้ (โหลดที่หน้ารายการแล้วส่งลงมา) */
  teams: BookmarkTeam[]
  /** เลือกที่เก็บ — null = ส่วนตัว */
  onBookmark: (team: string | null) => void
  onUnbookmark: () => void
  /** URL ภาพย่อ (null = ยังไม่มีรูปตัวอย่าง) */
  thumb?: string | null
  /** หมวด/แท็กที่กำลังกรองอยู่ — ใช้ไฮไลต์ชิปที่ถูกเลือก */
  activeCategory: string
  activeTag: string
  /** กดชิป = สลับเป็นตัวกรองนั้น (กดซ้ำ = ยกเลิก) */
  onPickCategory: (c: string) => void
  onPickTag: (g: string) => void
  /** เปิดดูรูปตัวอย่างเต็ม (ผู้ใช้สั่ง *"คลิกที่รูปก็ได้"*) */
  onPeek: () => void
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
      /**
       * ลบแล้วเข้าถังขยะ ไม่ได้ลบทิ้งทันที
       * คืน `daysLeft` มาบอกผู้ใช้ตรง ๆ เพราะกติกา 14 วันเป็นเรื่องสำคัญ
       * ถ้าบอกแค่ "ลบแล้ว" ผู้ใช้จะเชื่อว่าหายถาวร แล้วไม่กู้คืนทั้งที่ยังทำได้
       */
      const t = await api.deleteTemplate(tpl.versionId)
      notify(`ย้าย "${t.name}" เข้าถังขยะแล้ว — ลบถาวรใน ${t.daysLeft} วัน (กู้คืนได้ก่อนหน้านั้น)`)
      await onChanged()
    } catch (e) {
      onError(e instanceof ApiError ? e.message : String(e))
    } finally {
      setBusy(false)
      setConfirming(false)
    }
  }

  /**
   * สำเนาแม่แบบ — ปุ่มสำหรับคนที่**ไม่ใช่เจ้าของ**
   *
   * ผู้ใช้สั่ง: *"ปุ่มลบแม่แบบ จะแสดงเฉพาะผู้ที่เป็นเจ้าของเท่านั้น
   *   แทนที่ด้วยปุ่มสำเนาแม่แบบ แทน"*
   *
   * ⚠️ เดิมคนที่ไม่ใช่เจ้าของก็เห็นปุ่ม "ลบ" แล้วได้ 403 ตอนกด
   *   แสดงปุ่มที่กดไม่ได้ = หลอกผู้ใช้ว่าเขาลบได้ (แล้วเขาจะไปหาทางอื่น
   *   หรือคิดว่าระบบเพี้ยน ซึ่งแย่กว่าไม่มีปุ่ม)
   *
   * ⚠️ กติกา "ใครเห็นอะไร" อยู่ใน `canDeleteTemplate()` จุดเดียวกับที่ `SharePanel`
   *    ใช้ เพื่อไม่ให้สองที่ drift จนคนกดลบแม่แบบคนอื่นได้อีก
   *
   * ⚠️ `cloneTemplate()` ดึงไฟล์มาอัปโหลดเป็นแม่แบบใหม่ → ต้นฉบับไม่ถูกแตะ
   *    คนที่แชร์อยู่จึงยังใช้ต้นฉบับได้ตามเดิม
   */
  async function clone() {
    setBusy(true)
    try {
      const name = cloneName(tpl.name)
      await api.cloneTemplate(templateKeyOf(tpl), {
        name,
        category: tpl.category ?? '',
        tags: tpl.tags,
      })
      notify(`เก็บเป็น "${name}" แล้ว — แก้ได้อิสระ ไม่กระทบต้นฉบับ`)
      await onChanged()
    } catch (e) {
      onError(e instanceof ApiError ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <tr>
      <td>
        <button
          className="ghost"
          onClick={onOpen}
          style={{
            padding: 0,
            border: 'none',
            background: 'none',
            color: 'var(--brand)',
            textAlign: 'left',
            /**
             * ⚠️ ชื่อแม่แบบไม่ได้เป็นคำธรรมดาเสมอไป
             *   คีย์จาก Carbone คือเลขฐานสิบหก 64 หลัก ไม่มีช่องว่างให้พักบรรทัด
             *   ถ้าไม่จำกัด `table-layout: auto` จะขยายคอลัมน์ชื่อให้พอข้อความ
             *   แล้วดันคอลัมน์ปุ่มทางขวาออกนอกจอ (วัดแล้ว: ที่ 390px ตารางกว้าง 518px
             *   ในกล่อง 345px → ปุ่ม "ดาวน์โหลด" และช่องอื่นหายไปนอกจอ)
             *
             * `maxWidth` คือตัวกันการขยาย · `textOverflow` คือตัวบอกผู้ใช้ว่ามีของต่อ
             *   แก้ที่ปุ่มชื่อจุดเดียว ได้ทั้งโหมดรายการ (ตาราง) และโหมดชิด (การ์ด)
             *   เพราะทั้งสองโหมดใช้ปุ่มชื่อตัวเดียวกัน
             */
            display: 'block',
            maxWidth: 280,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
          /**
           * รวมชื่อเต็มไว้ใน tooltip ด้วย — ตัดทิ้งโดยไม่มีทางอ่านชื่อครบถือว่าผิด
           * (คำแนะนำเดิมยังอยู่ เพียงต่อท้ายด้วยชื่อ)
           */
          title={
            (view && !view.canEdit ? 'ดูอย่างเดียว (ไม่มีสิทธิ์แก้ไข) — ' : 'เปิดแม่แบบ — ') +
            (tpl.name || '(ไม่มีชื่อ)')
          }
        >
          {tpl.name || '(ไม่มีชื่อ)'}
        </button>
        {/*
         * ป้ายบอกว่าบุ๊กมาร์กนี้เก็บไว้ที่ไหน
         *   จำเป็นเพราะผู้ใช้เลือกได้หลายที่ (ส่วนตัว / ทีม) แล้วตอนกลับมาดูแท็บบุ๊กมาร์ก
         *   จะเห็นเป็นรายการเดียวกันทั้งหมด ถ้าไม่มีป้ายจะไม่รู้ว่าอันไหนอยู่ทีมไหน
         *
         * ⚠️ ชื่อทีมมาจาก `teams` ที่โหลดครั้งเดียวที่หน้ารายการ
         *   ถ้าหาไม่เจอ (เช่นทีมถูกลบไปแล้วแต่ข้อมูลยังค้าง) ให้ซ่อนป้าย
         *   แทนที่จะแสดงคำว่า "ไม่มีทีม" ซึ่งทำให้ผู้ใช้งงว่าทำไมตัวเองมีทีมนั้นไม่ได้
         */}
        {starred && bookmarkTeam && teams.some((t) => t.team === bookmarkTeam) && (
          <span className="pill" data-testid="bookmark-team-badge">
            ทีม · {teams.find((t) => t.team === bookmarkTeam)?.name}
          </span>
        )}
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
        {tpl.category ? <button
          type="button"
          className={'pill pill--btn' + (activeCategory === tpl.category ? ' is-on' : '')}
          data-testid="row-cat"
          aria-pressed={activeCategory === tpl.category}
          onClick={() => onPickCategory(tpl.category)}
          title={'กดเพื่อดูเฉพาะหมวด "' + tpl.category + '"'}
        >
          {tpl.category}
        </button> : <span className="muted">—</span>}
      </td>
      <td data-label="แท็ก" className={tpl.tags.length ? undefined : 'is-empty'}>
        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', maxWidth: 240 }}>
          {tpl.tags.slice(0, 3).map((g) => (
            <button
              key={g}
              type="button"
              className={'pill pill--btn' + (activeTag === g ? ' is-on' : '')}
              data-testid="row-tag"
              aria-pressed={activeTag === g}
              onClick={() => onPickTag(g)}
              title={'กดเพื่อดูเฉพาะแท็ก "' + g + '"'}
            >
              {g}
            </button>
          ))}
          {tpl.tags.length > 3 && <span className="muted" style={{ fontSize: 12 }}>+{tpl.tags.length - 3}</span>}
        </div>
      </td>
      <td className="muted mono" data-label="ชนิด">
        {tpl.type}
      </td>
      <td className="tplrow__acts" style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
        <BookmarkButton
          bookmarked={starred}
          team={bookmarkTeam}
          teams={teams}
          onPick={onBookmark}
          onRemove={onUnbookmark}
          className="ghost tplrow__i-star"
          testId="bookmark-toggle-row"
          templateKey={templateKeyOf(tpl)}
          labelOn="เอาออกจากบุ๊กมาร์ก"
          labelOff="เพิ่มในบุ๊กมาร์ก"
        />{' '}
        <button
          className="ghost tplrow__i-open"
          onClick={onOpen}
          disabled={busy}
          title="เปิดแม่แบบ"
        >
          เปิด
        </button>{' '}
        {/*
         * ปุ่ม "ดูตัวอย่าง" — ผู้ใช้สั่ง:
         *   *"แบบ list มีปุ่ม preview กดแล้ว มีรูปตัวอย่างแสดงเป็น popup"*
         *
         * ⚠️ ต้องอยู่หลัง "เปิด" เพราะลำดับนี้คือ
         *   "ดูว่าหน้าตาเป็นยังไง → เปิดไปแก้" ถ้าย้ายไปหน้าสุดท้าย
         *   ผู้ใช้จะเจอปุ่มลบ/ดาวน์โหลดก่อน แล้วคิดว่าทำอะไรไม่ได้
         *
         * ⚠️ ใส่เฉพาะตอน**มีรูปย่อจริง**
         *   ถ้ากดแล้วเปิด lightbox ว่าง นั่นแย่กว่าไม่มีปุ่ม
         *   (`thumbs` โหลดทุกโหมดอยู่แล้ว เพราะผูกกับ `filtered` ไม่ใช่ `listView`)
         *
         * ⚠️ ไอคอนเป็น `::before` ใน CSS ไม่ใช่ <span> ใน JSX
         *   เพราะหลายชุดเทสต์เลือกปุ่มในแถวด้วย `textContent.trim()`
         *   (ดูหัวข้อใน globals.css) ถ้าใส่ emoji ในข้อความจะไปชน selector เดิม
         */}
        {thumb && (
          <button
            className="ghost tplrow__i-peek"
            data-testid="row-peek"
            onClick={onPeek}
            disabled={busy}
            title="ดูรูปตัวอย่างของแม่แบบนี้"
          >
            ดูตัวอย่าง
          </button>
        )}{' '}
        <a href={`/api/templates/${encodeURIComponent(tpl.versionId)}`} download>
          <button className="ghost tplrow__i-dl" disabled={busy} title="ดาวน์โหลดไฟล์แม่แบบ">
            ดาวน์โหลด
          </button>
        </a>{' '}
        {/*
         * ปุ่มช่องสุดท้ายของแถว — สลับตามสิทธิ์
         *
         * ⚠️ ต้องมีปุ่ม**เสมอ** ไม่ว่าจะเป็นเจ้าของหรือไม่
         *    ถ้าปล่อยให้หายไปเมื่อไม่ใช่เจ้าของ ผู้ใช้จะสับสนว่ากดอะไรไม่ได้
         *    (แถวนี้มีปุ่มนี้อยู่ตลอด เพิ่งเปลี่ยนมาเป็น "สำเนา")
         *
         * ⚠️ เงื่อนไขอยู่ใน `canDeleteTemplate()` ไม่ใช่เขียน `relation === 'owner'` ซ้ำ
         *    เพราะฝั่ง API ยังให้ลบได้เมื่อแม่แบบยังไม่มีเจ้าของ (ดูคอมเมนต์ในไฟล์นั้น)
         */}
        {canDeleteTemplate(view) ? (
          <button
            className={`${confirming ? 'danger' : 'ghost'} tplrow__i-del`}
            data-testid="row-delete"
            onClick={remove}
            disabled={busy}
            title={confirming ? 'กดซ้ำอีกครั้งเพื่อยืนยันการลบ' : 'ลบแม่แบบนี้'}
          >
            {confirming ? 'ยืนยันลบ?' : 'ลบ'}
          </button>
        ) : (
          <button
            className="ghost tplrow__i-clone"
            data-testid="row-clone"
            onClick={() => void clone()}
            disabled={busy}
            title="เก็บสำเนาไว้ใช้เอง — แม่แบบต้นฉบับไม่เปลี่ยน"
          >
            สำเนา
          </button>
        )}
      </td>
        {/*
         * ภาพย่อ — **ต่อท้ายสุดเท่านั้น**
         *   กฎจอแคบใน globals.css ใช้ `td:nth-child(2..4)` เป็น data-label
         *   ถ้าแทรกคอลัมน์ตรงกลาง หมวด/แท็ก/ชนิดไฟล์จะเลื่อนตำแหน่ง
         *   แล้วป้ายกำกับบนมือถือผิดทั้งชุด
         *   โชว์เฉพาะตอนเป็นมุมมีชิด (ซ่อนด้วย CSS)
         */}
        <td className="tplrow__thumb" data-label="ตัวอย่าง">
          {/*
           * ⚠️ ผู้ใช้สั่ง *"คลิกที่รูปก็ได้ บางทีผู้ใช้ต้องการคลิกที่นี้"*
           *   เดิมเป็น <img> จึงไม่มีอาการชี้เมาส์และกดไม่ได้
           *   ครอบด้วย <button> เพื่อให้เป็นเป้าหมายที่กดได้จริง + เข้าถึงด้วยคีย์บอร์ด
           *   ⚠️ คง <img> ไว้ข้างใน (ไม่ใช้ background-image)
           *   เพราะเทสต์หลายชุดเลือกด้วย data-testid="row-thumb" และ
           *   onError ต้องซ่อนรูปเสียเพื่อไม่ให้กรอบเสียค้างรกหน้าจอ
           */}
          {thumb ? (
            <button
              type="button"
              onClick={onPeek}
              data-testid="row-thumb-btn"
              aria-label={`ดูภาพตัวอย่างของ ${tpl.name}`}
            >
              <img
                src={thumb}
                alt=""
                loading="lazy"
                data-testid="row-thumb"
                onError={(e) => {
                  // รูปเสีย = ไม่ใช่ตัวหลัก → ซ่อนทิ้ง ไม่ปล่อยกรอบเสียค้างไว้ให้รกหน้าจอ
                  e.currentTarget.style.visibility = 'hidden'
                }}
              />
            </button>
          ) : (
            <span className="tplrow__noimg" aria-hidden="true">
              ไม่มีตัวอย่าง
            </span>
          )}
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
  /**
   * ผู้ใช้สั่ง: *"ถ้าคลิกที่นี้จะมี popup ขึ้นมา"*
   *   คลิกแล้วต้องเห็นคำอธิบายก่อน ไม่ใช่กระโดดไปเปิด file picker ทันที
   *   เพราะคนส่วนใหญ่ยังไม่รู้ว่าแม่แบบทำยังไง ถ้ากระโดดไปเลือกไฟล์
   *   เขาจะเลือกผิดแล้วค้างอยู่ที่หน้าที่เลือกไฟล์
   */
  const [guide, setGuide] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)

  async function send(file: File) {
    /**
     * ⚠️ ต้องเช็คฝั่ง client ด้วย ไม่ใช่พึ่ง `accept` อย่างเดียว
     *   `accept` เป็นแค่คำแนะนำของ file picker — ลากไฟล์ .xlsx มาวางก็เข้ามาได้เสมอ
     *   ถ้าปล่อยให้หลุด ผู้ใช้จะเห็น "อัปโหลดสำเร็จ" แล้วพังตอนกดส่งออกเอกสาร
     *   ซึ่งแก้ยากกว่าบอกตรง ๆ ตอนเลือกไฟล์
     */
    if (!/\.docx$/i.test(file.name)) {
      onError('รองรับเฉพาะไฟล์ .docx เท่านั้น — ถ้ายังไม่รู้จะเริ่มอย่างไร กดปุ่มนี้อีกครั้งเพื่อดูวิธีทำและดาวน์โหลดไฟล์ตัวอย่างได้')
      return
    }
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
        onClick={() => setGuide(true)}
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
          // ⚠️ เล็กลงเพื่อให้เหมือนรูปโปรไฟล์ใน /account (ผู้ใช้สั่งย่อ)
          //   เดิมกินเต็มความกว้าง sidebar และสูง 42px เท่าปุ่มหลัก
          //   แต่ sidebar ตอนนี้เหลือแค่รายการเมนู → ปุ่มหลักที่ใหญ่ที่สุดกลับกินพื้นที่เมนู
          //   ยังคงเป็นเส้นประเพราะเป็นปลายทางวางไฟล์ (ลากไฟล์มาวางได้) ไม่ใช่แค่ปุ่มกด
          padding: '5px 10px',
          borderRadius: 8,
          cursor: 'pointer',
          margin: 0,
          fontSize: 13,
          userSelect: 'none',
          gap: 5,
        }}
      >
        <span aria-hidden="true">↑</span>
        {busy ? 'กำลังอัปโหลด…' : 'อัปโหลดแม่แบบ'}
      </label>

      {guide && (
        <UploadGuide
          onClose={() => setGuide(false)}
          onPick={() => {
            // ปิดป็อปอัปก่อนเปิด file picker
            // ไม่งั้น picker จะโผล่ทับป็อปอัป แล้วผู้ใช้กดปิดไม่ได้
            setGuide(false)
            fileInput.current?.click()
          }}
        />
      )}
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
      className={`pill ${tone} pill--msg`}
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
