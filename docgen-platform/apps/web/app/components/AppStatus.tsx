'use client'

/**
 * สถานะระหว่างเปลี่ยนหน้า + ช่องคัดลอก URL
 *
 * ทำไมต้องมี
 *   · เปลี่ยนหน้าแล้วเบราว์เซอร์ค้างเงียบ ไม่รู้ว่ากำลังไปไหน → แถบโหลดบนสุด + ผ้าคลุมที่บอกปลายทาง
 *   · เวลามีปัญหา ต้องส่ง URL ไปให้คนอื่นแก้ → แถบมุมจอล่างซ้าย คัดลอกได้ทันที
 *   · ถ้าหน้าค้างจริง ๆ (watchdog) → ปลดผ้าคลุม พร้อมปุ่มรีเฟรช ไม่ทิ้งผู้ใช้ไว้กับหน้าค้าง
 *
 * การจับการเปลี่ยนหน้าไม่ใช้ Next router API (มันไม่มี event สำหรับ pending)
 *   1. ดักคลิกแบบ capture บน <a> ที่ชี้เข้าเว็บเรา → ได้ปลายทางทันที ก่อนเครือข่ายเริ่ม
 *   2. ดัก popstate / hashchange (ปุ่มย้อนกลับ, ไป-กลับ)
 *   3. ดัก history.pushState / replaceState (router.push ในปุ่ม) — ข้ามถ้า URL เปลี่ยนไปแล้ว
 *   4. usePathname เปลี่ยน = เปลี่ยนหน้าสำเร็จ → ปิดแถบโหลด
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { usePathname } from 'next/navigation'

/* ── จังหวะเวลา ────────────────────────────────────────────────
 * SHOW_VEIL_AFTER — เปลี่ยนหน้าเร็วกว่านี้ไม่ต้องกางผ้าคลุม (ไม่กะพริบตามสายตา)
 * MIN_BAR_MS       — ให้แถบโหลดเห็นชัดอย่างน้อยนิด ไม่งั้นเหมือนไม่มีอะไรเกิดขึ้น
 * WATCHDOG_MS     — ค้างเกินนี้ถือว่ามีปัญหา → ปลดผ้าคลุม + ชี้ทางออก
 */
const SHOW_VEIL_AFTER = 180
const MIN_BAR_MS = 400
const WATCHDOG_MS = 15000

/* ── ชื่อหน้าแบบอ่านง่าย ─────────────────────────────────────── */
function labelFor(pathname: string): string {
  if (pathname === '/' || pathname === '') return 'หน้าแรก'
  if (pathname.startsWith('/studio')) return 'Studio'
  if (pathname.startsWith('/docs')) return 'เอกสาร API'
  if (pathname.startsWith('/auth')) return 'เข้าสู่ระบบ'
  return pathname
}

/* ── บันทึกข้อผิดพลาดไว้ระดับโมดูล ───────────────────────────────
 * เก็บข้ามการ re-render และข้ามหน้า เพื่อให้ข้อความ "คัดลอกข้อมูลแก้ปัญหา"
 * ยังมีข้อผิดพลาดของเมื่อกี้แนบไปด้วย
 */
type ErrorRecord = { at: string; where: string; message: string }
const errorLog: ErrorRecord[] = []
function logError(where: string, message: string) {
  errorLog.unshift({ at: new Date().toISOString(), where, message: message.slice(0, 400) })
  if (errorLog.length > 5) errorLog.pop()
}

/** คัดลอกข้อความ — มีทางสำรองกรณี clipboard ถูกบล็อก (เช่น ไม่ได้กดอนุญาต) */
async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    /* ตกไปลองวิธีถัดไป */
  }
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.setAttribute('readonly', '')
    ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0'
    document.body.appendChild(ta)
    ta.select()
    const ok = document.execCommand('copy')
    ta.remove()
    return ok
  } catch {
    return false
  }
}

/* ── บริบท "กำลังทำงาน" ให้หน้าจอในระบบรายงานได้ ──────────────
 * ใช้เมื่อรอ server ที่ไม่ใช่การเปลี่ยนหน้า เช่น รอเรนเดอร์ PDF
 *   const setAppBusy = useAppBusy()
 *   useEffect(() => { setAppBusy(busy ? 'กำลังเรนเดอร์…' : null); return () => setAppBusy(null) }, [busy])
 */
type BusyApi = { set: (label: string | null) => void }
const BusyContext = createContext<BusyApi>({ set: () => {} })
export function useAppBusy(): (label: string | null) => void {
  return useContext(BusyContext).set
}

export default function AppStatus({ children }: { children: ReactNode }) {
  const pathname = usePathname()

  const [mounted, setMounted] = useState(false)
  const [href, setHref] = useState('')
  const [pending, setPending] = useState<{ href: string; since: number } | null>(null)
  const [veil, setVeil] = useState(false)
  const [slow, setSlow] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  const [copied, setCopied] = useState<'url' | 'diag' | null>(null)
  const [errCount, setErrCount] = useState(0)

  const pendingRef = useRef<{ href: string; since: number } | null>(null)

  /* ── ตั้งค่าเริ่มต้น: ซ่อนผ้าคลุมตอนเปิดหน้าครั้งแรก + เก็บค่าที่ผู้ใช้เคยเลือกไว้ ── */
  useEffect(() => {
    setMounted(true)
    setHref(window.location.href)
    setOpen(localStorage.getItem('appstatus.urlbar') !== 'collapsed')
  }, [])

  useEffect(() => {
    localStorage.setItem('appstatus.urlbar', open ? 'open' : 'collapsed')
  }, [open])

  const setHrefNow = useCallback(() => setHref(window.location.href), [])

  /** เริ่มแสดงสถานะ "กำลังไป" — ข้ามถ้าเป็นลิงก์ภายนอก/ไฟล์เดียวกัน/แค่ hash */
  const start = useCallback((url: string | null | undefined) => {
    if (!url) return
    let abs: URL
    try {
      abs = new URL(url, window.location.href)
    } catch {
      return
    }
    if (abs.origin !== window.location.origin) return
    // hash ไม่ทำให้เปลี่ยนหน้า (ไม่ต้องกางผ้าคลุม)
    if (abs.pathname === window.location.pathname && abs.search === window.location.search) return
    // ถ้า URL เป็นของหน้าปัจจุบันอยู่แล้ว = router เพิ่ง commit เสร็จ ไม่ใช่การเริ่มนำทาง
    if (abs.href === window.location.href) return

    const next = { href: abs.href, since: Date.now() }
    pendingRef.current = next
    setPending(next)
    setSlow(false)
    setHref(abs.href)
  }, [])

  const stop = useCallback(() => {
    pendingRef.current = null
    setPending(null)
    setVeil(false)
    setSlow(false)
    setHrefNow()
  }, [setHrefNow])

  /* ── ฟังเหตุการเปลี่ยนหน้า ───────────────────────────────── */
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0) return
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
      const el = (e.target as HTMLElement | null)?.closest?.('a')
      if (!el) return
      if (el.hasAttribute('download')) return
      if (el.getAttribute('target') && el.getAttribute('target') !== '_self') return
      const href = el.getAttribute('href')
      if (!href || href.startsWith('#')) return
      start(href)
    }

    const onPop = () => {
      start(window.location.href)
      setHrefNow()
    }

    // router.push ในปุ่ม (ไม่ใช่ <a>) — Next เรียกหลัง commit เสร็จ
    // start() จะข้ามให้เอง เพราะ URL เปลี่ยนไปแล้ว → ไม่เคยค้างผ้าคลุม
    const origPush = history.pushState
    const origReplace = history.replaceState
    history.pushState = function (state, title, url) {
      const r = origPush.call(this, state, title, url)
      if (url) start(String(url))
      else setHrefNow()
      return r
    }
    history.replaceState = function (state, title, url) {
      const r = origReplace.call(this, state, title, url)
      if (url) start(String(url))
      else setHrefNow()
      return r
    }

    document.addEventListener('click', onClick, true)
    window.addEventListener('popstate', onPop)
    window.addEventListener('hashchange', onPop)

    return () => {
      document.removeEventListener('click', onClick, true)
      window.removeEventListener('popstate', onPop)
      window.removeEventListener('hashchange', onPop)
      history.pushState = origPush
      history.replaceState = origReplace
    }
  }, [start, setHrefNow])

  /* ── เปลี่ยนหน้าเสร็จ = pathname เปลี่ยน ───────────────────── */
  useEffect(() => {
    const p = pendingRef.current
    if (!p) return
    const dest = new URL(p.href)
    const arrived = dest.pathname === pathname
    if (!arrived) return
    // ให้แถบโหลดเห็นชัดอย่างน้อย MIN_BAR_MS
    const wait = Math.max(0, MIN_BAR_MS - (Date.now() - p.since))
    const t = setTimeout(() => {
      // ระหว่างรอ อาจมีการนำทางครั้งใหม่ทับของเดิม — อย่าไปปิดของใหม่
      if (pendingRef.current === p) stop()
    }, wait)
    return () => clearTimeout(t)
  }, [pathname, stop])

  /* ── จังหวะผ้าคลุม: ช้าเกินไปค่อยกาง ─────────────────────── */
  useEffect(() => {
    if (!pending) return
    const t1 = setTimeout(() => setVeil(true), SHOW_VEIL_AFTER)
    return () => clearTimeout(t1)
  }, [pending])

  /* ── watchdog: ค้างเกินกำหนด = มีปัญหา → ปลดผ้าคลุมให้ผู้ใช้ออกได้ ── */
  useEffect(() => {
    if (!pending) return
    const t = setTimeout(() => {
      setSlow(true)
      setVeil(false)
    }, WATCHDOG_MS)
    return () => clearTimeout(t)
  }, [pending])

  /* ── จับข้อผิดพลาดที่หลุดรอด เพื่อแนบไปกับข้อมูลแก้ปัญหา ───── */
  useEffect(() => {
    const onError = (e: ErrorEvent) => {
      logError('error', `${e.message} @ ${e.filename}:${e.lineno}`)
      setErrCount((n) => n + 1)
      setOpen(true)
    }
    const onReject = (e: PromiseRejectionEvent) => {
      const r = e.reason
      logError('promise', r instanceof Error ? `${r.message}` : String(r))
      setErrCount((n) => n + 1)
      setOpen(true)
    }
    window.addEventListener('error', onError)
    window.addEventListener('unhandledrejection', onReject)
    return () => {
      window.removeEventListener('error', onError)
      window.removeEventListener('unhandledrejection', onReject)
    }
  }, [])

  /* ── คัดลอก ─────────────────────────────────────────────── */
  const shown = pending?.href ?? href
  const shownPath = safePath(shown)
  const shownLabel = labelFor(shownPath)

  const doCopy = useCallback(async (kind: 'url' | 'diag') => {
    const ok = await copyText(kind === 'url' ? shown : buildDiagnostic(shown, shownLabel))
    setCopied(ok ? kind : null)
    if (ok) setTimeout(() => setCopied(null), 1800)
  }, [shown, shownLabel])

  const setAppBusy = useCallback((label: string | null) => setBusy(label), [])
  const busyApi = useMemo(() => ({ set: setAppBusy }), [setAppBusy])

  const working = Boolean(pending) || Boolean(busy)

  return (
    <BusyContext.Provider value={busyApi}>
      {/* ผ้าคลุมตอนเปิดหน้าครั้งแรก — server render ไว้ก่อน แล้ว JS ค่อยถอดออก
          ถ้า JS ไม่ทำงาน CSS จะซ่อนมันเองใน 6 วินาที หน้าเว็บจะไม่ถูกบังค้าง */}
      {!mounted && (
        <div className="bootveil" aria-hidden="true">
          <div className="bootveil__card">
            <span className="spinner" />
            <span>กำลังเปิดระบบ…</span>
          </div>
        </div>
      )}

      {/* แถบโหลดบนสุด — ขึ้นทันทีที่เริ่มนำทาง */}
      {(pending || busy) && <div className="topbar" role="progressbar" aria-label="กำลังทำงาน" />}

      {/* ผ้าคลุมหน้าจอ — บอกว่ากำลังไปหน้าไหน */}
      {veil && pending && (
        <div className="veil" role="status" aria-live="polite">
          <div className="veil__card">
            <span className="spinner" />
            <div className="veil__text">
              <strong>กำลังเปิดหน้า</strong>
              <span className="mono">
                {labelFor(safePath(pending.href))} · {safePath(pending.href)}
              </span>
            </div>
          </div>
        </div>
      )}

      {/* แถบ URL มุมล่างซ้าย — คัดลอกไปส่งแก้ปัญหาได้ */}
      <div className="urlbar" data-open={open ? 'true' : 'false'}>
        {open && (
          <div className="urlbar__panel">
            <div className="urlbar__head">
              <strong>{shownLabel}</strong>
              {pending && <span className="pill warn">กำลังเปิด</span>}
              {busy && <span className="pill">{busy}</span>}
            </div>

            <code className="urlbar__url" title={shown}>
              {shown}
            </code>

            {slow && (
              <>
                <div className="urlbar__slow">
                  เปิดหน้านี้นานผิดปกติ (นานกว่า {WATCHDOG_MS / 1000} วินาที) — กด “รีเฟรชหน้านี้”
                  แล้วคัดลอก URL ไปแนบได้เลย
                </div>
                <button className="ghost" onClick={() => window.location.reload()}>
                  รีเฟรชหน้านี้
                </button>
              </>
            )}

            {errCount > 0 && errorLog.length > 0 && (
              <div className="urlbar__err">
                <strong>ข้อผิดพลาดล่าสุด</strong>
                <span className="mono">{errorLog[0].message}</span>
              </div>
            )}

            <div className="urlbar__actions">
              <button className="ghost" onClick={() => void doCopy('url')}>
                {copied === 'url' ? 'คัดลอกแล้ว ✓' : 'คัดลอก URL'}
              </button>
              <button className="ghost" onClick={() => void doCopy('diag')}>
                {copied === 'diag' ? 'คัดลอกแล้ว ✓' : 'คัดลอกข้อมูลแก้ปัญหา'}
              </button>
              <button className="ghost" onClick={() => setOpen(false)}>
                ซ่อน
              </button>
            </div>
          </div>
        )}

        <button
          className="urlbar__toggle"
          onClick={() => setOpen((v) => !v)}
          title="แสดง URL ปัจจุบัน (คัดลอกไปส่งแก้ปัญหา)"
        >
          {working && <span className="spinner spinner--sm" />}
          <span className="urlbar__name">{pending ? 'กำลังไป' : shownLabel}</span>
          <span className="mono urlbar__path">{safePath(shown)}</span>
        </button>
      </div>

      {children}
    </BusyContext.Provider>
  )
}

/* ── ตัวช่วย ─────────────────────────────────────────────── */

function safePath(url: string): string {
  try {
    const u = new URL(url)
    return `${u.pathname}${u.search}${u.hash}` || '/'
  } catch {
    return url
  }
}

/** ข้อความสำหรับแนบไปให้คนอื่นแก้ — URL อย่างเดียวมักไม่พอ */
function buildDiagnostic(url: string, label: string): string {
  const now = new Date()
  const lines = [
    `หน้า: ${label}`,
    `URL: ${url}`,
    `เวลา: ${now.toLocaleString('th-TH', { dateStyle: 'medium', timeStyle: 'medium' })}`,
    `ออนไลน์: ${navigator.onLine ? 'ใช่' : 'ไม่'}`,
    `จอ: ${window.innerWidth}x${window.innerHeight}`,
    `เบราว์เซอร์: ${navigator.userAgent}`,
  ]
  if (errorLog.length > 0) {
    lines.push('ข้อผิดพลาดล่าสุด:')
    for (const e of errorLog) lines.push(`- [${e.where}] ${e.message}`)
  }
  return lines.join('\n')
}
