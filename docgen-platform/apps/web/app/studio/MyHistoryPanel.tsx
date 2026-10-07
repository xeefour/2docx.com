'use client'

/**
 * แท็บ "ประวัติ" ฝั่งซ้าย — ฉันสั่งเรนเดอร์แม่แบบนี้ไปแล้วครั้งไหนบ้าง
 *
 * ── ต่างจาก "ผู้ใช้แม่แบบนี้" (ฝั่งขวา) ยังไง ──────────────────
 *   ขวา  ผู้ใช้แม่แบบนี้ = ใครใช้บ้าง (ทุกคน) → ดูภาพรวม อ่านอย่างเดียว
 *   ซ้าย ประวัติ        = ของฉันเอง          → ค้นหาแล้วคลิก "แก้ไข" เพื่อกู้ค่าเดิมมา
 *
 * ── ทำไมต้องค้นได้ ────────────────────────────────────────────
 *   ชื่อฉบับคือ `studio: <ชื่อแม่แบบ>` ซึ่งเหมือนกันหมดทุกฉบับ
 *   คนทำงานจำชื่อฉบับไม่ได้ แต่จำ**ชื่อผู้รับ** ได้
 *   จึงค้นทั้งชื่อฉบับและค่าที่กรอกไว้ แล้วโชว์ตัวอย่างค่าให้เห็นก่อนกดแก้ไข
 */
import { useEffect, useRef, useState } from 'react'
import { api, type MyHistory } from './lib/api'
import Pager from './Pager'

/**
 * กี่ฉบับต่อหน้า
 *
 * ผู้ใช้สั่ง: *"ประวัติให้แสดงเฉพาะประวัติของผู้ใช้รายนั้น ๆ ถ้ามีมากๆ ทำเป็น pageination"*
 * แถวละบรรทัดพร้อมตัวอย่างค่าที่กรอก ถ้ามากกว่านี้ก็ต้องเลื่อนในการ์ดอยู่ดี ๆ แล้ว
 * และต้องให้ **server** ตัด ไม่ใช่ตัดในเบราว์เซอร์ เพราะแต่ละฉบับแนบ `data` ที่กรอก
 * (ชื่อผู้รับ ที่อยู่ …) ยิงมาทั้งหมดแล้วเอาไว้แต่ในหน่วยความจำเปล่า ๆ
 */
const PAGE_SIZE = 10

const STATUS_TONE: Record<string, string> = {
  done: 'pill ok',
  failed: 'pill err',
  rendering: 'pill warn',
  queued: 'pill',
}

const STATUS_TH: Record<string, string> = {
  done: 'สำเร็จ',
  failed: 'ล้มเหลว',
  rendering: 'กำลังเรนเดอร์',
  queued: 'รอคิว',
}

function when(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString('th-TH', { dateStyle: 'medium', timeStyle: 'short' })
}

/** ค่าที่กรอกไว้ → บรรทัด "ชื่อ: ค่า" สั้น ๆ ให้เห็นว่าเป็นฉบับไหน */
function previewOf(data: Record<string, unknown>, limit = 3): string[] {
  const out: string[] = []
  for (const [k, v] of Object.entries(data)) {
    if (out.length >= limit) break
    if (v === null || v === undefined || v === '') continue
    const text = typeof v === 'object' ? JSON.stringify(v) : String(v)
    if (!text) continue
    out.push(text.length > 48 ? `${text.slice(0, 48)}…` : text)
  }
  return out
}

/** "1–10 จาก 43" — บอกว่าตอนนี้เห็นช่วงไหน */
function rangeOf(page: number, pageSize: number, total: number): string {
  if (total === 0) return 'ไม่มีฉบับ'
  const from = (page - 1) * pageSize + 1
  const to = Math.min(total, page * pageSize)
  return `${from}–${to} จาก ${total}`
}

export default function MyHistoryPanel({
  templateKey,
  onRestore,
}: {
  templateKey: string
  /**
   * กู้ค่าเดิมกลับเข้าฟอร์ม — พ่อเป็นคนสลับแท็บและขึ้นข้อความบอกผล
   * (พ่อรู้ว่าค่าไหนไม่มีช่องในฟอร์ม จึงต้องเป็นคนบอก)
   */
  onRestore: (data: Record<string, unknown>) => void
}) {
  const [data, setData] = useState<MyHistory | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [q, setQ] = useState('')
  /** หน้าปัจจุบัน (เริ่มที่ 1) — server ตัดให้ทุกหน้า */
  const [page, setPage] = useState(1)
  /**
   * นับรอบการโหลด — ใช้เรียกซ้ำหลังลบเอกสาร
   *
   * ⚠️ ต้องอยู่ในเงื่อนไขกันยิงซ้ำของ effect ด้วย
   *   ไม่งั้นกดลบแล้วรีโหลดจะถูก `return` ทิ้งเพราะคำค้น+หน้าไม่เปลี่ยน
   */
  const [reloadKey, setReloadKey] = useState(0)
  /** แถวที่กด "ลบ" แล้วรอยืนยัน (หายเองใน 4 วิ) — เหมือนปุ่มลบแม่แบบในหน้ารายการ */
  const [confirmId, setConfirmId] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [delMsg, setDelMsg] = useState<string | null>(null)

  /**
   * รีเซ็ตเลขหน้าเมื่อเปลี่ยนแม่แบบหรือพิมพ์คำค้นใหม่ — ทำ**ระหว่าง render** ไม่ใช่ใน useEffect
   *
   * ⚠️ ถ้ารีเซ็ตใน `useEffect` ตัว fetch จะยิงไปแล้ว 1 รอบด้วยเลขหน้าของคำค้นเก่า
   *   แล้วค่อยยิงซ้ำอีกรอบหลังรีเซ็ต (ผลของคำค้นเก่าหายไปเฉย ๆ)
   *
   *   React อนุญาตให้เรียก setState ระหว่าง render เพื่อ "ปรับ state ให้ตรงกับค่าที่เปลี่ยน"
   *   ได้โดยเฉพาะกรณีนี้ (React จะ render ซ้ำในรอบเดียว ไม่วนซ้ำ)
   */
  const [ctx, setCtx] = useState(`${templateKey}\u0000${q.trim()}`)
  const ctxNow = `${templateKey}\u0000${q.trim()}`
  if (ctx !== ctxNow) {
    setCtx(ctxNow)
    setPage(1)
  }

  const pageCount = Math.max(1, Math.ceil((data?.total ?? 0) / PAGE_SIZE))
  /**
   * กันเลขหน้าค้างเกิน — เช่น ค้นแล้วเจอ 3 ฉบับ ตอนยังอยู่หน้า 5
   *   (เกิดได้จริงตอนกดค้นหาใหม่ทั้งที่ยังไม่ทันรีเซ็ต หรือข้อมูลหดลงเอง)
   */
  if (page > pageCount) setPage(pageCount)

  /**
   * คำขอที่ยิงไปแล้ว — ใช้กันยิงซ้ำ
   *
   * ต้องรวม **คำค้น + หน้า + รอบโหลด** ไว้ด้วยกัน
   *   · ขาดคำค้น → กดเปลี่ยนหน้าแล้วถูก `return` ทิ้ง (หน้าไม่เปลี่ยน)
   *   · ขาดหน้า   → เปลี่ยนหน้าแล้วไม่ยิงใหม่
   *   · ขาดรอบโหลด → กดลบเอกสารแล้วรีโหลดไม่เกิด (ข้อมูลเก่าค้างบนจอ)
   *
   * ⚠️ ต้องเริ่มเป็น `null` ไม่ใช่ `''`
   *    ถ้าเริ่มเป็นค่าว่าง เงื่อนไขจะเป็นจริงตั้งแต่แรก
   *    → effect return ทันที → **ไม่ยิง API เลยตอนเปิดหน้า** รายการว่างตลอด
   *    (เคยเจอ: พิมพ์คำค้นแล้วถึงจะมีข้อมูลปรากฏ)
   */
  const sent = useRef<string | null>(null)
  const seq = useRef(0)

  /**
   * ลบเอกสารฉบับนั้น (ผู้ใช้สั่ง: *"เพิ่มปุ่มลบ ประวัติ"*)
   *
   * ⚠️ ลบถาวร ไม่มีถังขยะแบบแม่แบบ
   *   เลยต้องยืนยันสองขั้นตอน + บอกผู้ใช้ตรง ๆ ว่าหายถาวรและไฟล์ผลลัพธ์หายด้วย
   */
  async function removeItem(id: string) {
    if (busyId) return
    setBusyId(id)
    setDelMsg(null)
    try {
      await api.deleteDocument(id)
      setConfirmId(null)
      setDelMsg('ลบฉบับนี้แล้ว — ไฟล์ผลลัพธ์ถูกลบตามไปด้วย กู้คืนไม่ได้')
      setReloadKey((k) => k + 1)
    } catch (e) {
      setDelMsg(e instanceof Error ? e.message : 'ลบไม่สำเร็จ')
    } finally {
      setBusyId(null)
    }
  }

  /**
   * ค้นเมื่อหยุดพิมพ์ 350ms
   *
   * ⚠️ ต้องมี `seq` กันผลค้าย้อนหลัง
   *    ถ้าไม่มี การพิมพ์เร็ว ๆ แล้ว request เก่าตอบทีหลังจะทับของใหม่
   *    ผู้ใช้จะเห็นรายการไม่ตรงกับที่พิมพ์
   */
  useEffect(() => {
    const t = setTimeout(() => {
      const next = q.trim()
      const want = `${next}\u0000${page}\u0000${reloadKey}`
      if (want === sent.current) return
      sent.current = want
      const mine = ++seq.current
      setLoading(true)
      setError(null)
      void api
        .myHistory(templateKey, next, { limit: PAGE_SIZE, skip: (page - 1) * PAGE_SIZE })
        .then((r) => {
          if (mine === seq.current) setData(r)
        })
        .catch((e) => {
          if (mine === seq.current) setError(e instanceof Error ? e.message : String(e))
        })
        .finally(() => {
          if (mine === seq.current) setLoading(false)
        })
    }, 350)
    return () => clearTimeout(t)
  }, [q, templateKey, page, reloadKey])

  const items = data?.items ?? []

  if (error) return <p className="field-error" style={{ padding: 16 }}>{error}</p>

  /*
   * `padding: 0` ในการ์ดข้างล่าง — หัวข้อกับแต่ละแถวจัด padding ตัวเอง
   *   ถ้าไม่กำกับจะซ้อนกับค่าตั้งต้นของ `.card`
   *
   * ⚠️ คอมเมนต์นี้ต้องอยู่**นอก** `return ( … )` ไม่ใช่ข้างใน
   *   เพราะวงเล็บของ return รับได้ element เดียว คอมเมนต์ JSX เพิ่มอีกชิ้นจะเป็น syntax error
   */
  return (
    <div className="card" style={{ overflow: 'hidden', padding: 0 }}>
      <div style={{ padding: '14px 16px', borderBottom: '1px solid var(--line)' }}>
        <h2 style={{ margin: '0 0 2px', fontSize: 15 }}>ประวัติของฉัน</h2>
        <p className="muted" style={{ margin: '0 0 10px', fontSize: 12 }}>
          เฉพาะฉบับที่คุณสั่งเรนเดอร์เองเท่านั้น ไม่มีของคนอื่นปนมา
          <br />
          กด “ลบ” เพื่อเอาฉบับนั้นออกจากประวัติ — ลบถาวร กู้คืนไม่ได้
หรือคำในเอกสาร แล้วกด “แก้ไข” เพื่อเอาค่าเดิมกลับมา
        </p>
        <input
          type="search"
          className="myhist__q"
          placeholder="ค้นหาในประวัติ…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          data-testid="myhistory-search"
        />
      </div>

      {loading && items.length === 0 && (
        <p className="muted" style={{ padding: 20, textAlign: 'center', margin: 0 }}>
          กำลังโหลดประวัติ…
        </p>
      )}

      {!loading && items.length === 0 && (
        <p className="muted" style={{ padding: 28, textAlign: 'center', margin: 0 }}>
          {q.trim() ? `ไม่พบประวัติที่ตรงกับ “${q.trim()}”` : 'ยังไม่เคยสั่งเรนเดอร์แม่แบบนี้'}
        </p>
      )}

      {items.length > 0 && (
        <ul className="myhist" data-testid="myhistory-list">
          {items.map((d) => {
            const lines = previewOf(d.data)
            const canRestore = Object.keys(d.data).length > 0
            return (
              <li key={d._id} className="myhist__row">
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="myhist__top">
                    <span className="myhist__label">{d.label ?? '(ไม่มีชื่อฉบับ)'}</span>
                    <span className={STATUS_TONE[d.status] ?? 'pill'}>
                      {STATUS_TH[d.status] ?? d.status}
                    </span>
                    <span className="pill mono">{d.outputFormat}</span>
                  </div>
                  <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>
                    {when(d.createdAt)}
                  </div>
                  {lines.length > 0 && (
                    <div className="myhist__peek">
                      {lines.map((t, i) => (
                        <span key={i}>{t}</span>
                      ))}
                    </div>
                  )}
                  {!canRestore && (
                    <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                      เอกสารเก่า — ยังไม่ได้เก็บค่าที่กรอกไว้ กู้ค่าไม่ได้
                    </div>
                  )}
                </div>
                <div className="myhist__acts">
                  <button
                    className="ghost"
                    data-testid="myhistory-restore"
                    disabled={!canRestore}
                    onClick={() => onRestore(d.data)}
                  >
                    แก้ไข
                  </button>
                  <button
                    className={confirmId === d._id ? 'danger' : 'ghost'}
                    data-testid="myhistory-delete"
                    disabled={busyId !== null}
                    title="ลบฉบับนี้ถาวร (ไฟล์ผลลัพธ์หายด้วย)"
                    onClick={() => {
                      if (busyId) return
                      if (confirmId !== d._id) {
                        // กดครั้งแรก = ขอยืนยัน · กดอีกครั้งภายใน 4 วิ = ลบจริง
                        setConfirmId(d._id)
                        setDelMsg(null)
                        setTimeout(
                          () => setConfirmId((c) => (c === d._id ? null : c)),
                          4000,
                        )
                        return
                      }
                      void removeItem(d._id)
                    }}
                  >
                    {busyId === d._id ? 'กำลังลบ…' : confirmId === d._id ? 'ยืนยันลบ?' : 'ลบ'}
                  </button>
                </div>
              </li>
            )
          })}
        </ul>
      )}

      {delMsg && (
        <p
          className={delMsg.startsWith('ลบฉบับนี้แล้ว') ? 'muted' : 'field-error'}
          data-testid="myhistory-del-msg"
          style={{ padding: '8px 16px', margin: 0, fontSize: 12, borderTop: '1px solid var(--line)' }}
        >
          {delMsg}
        </p>
      )}

      {loading && items.length > 0 && (
        <p className="muted" style={{ padding: '8px 16px', margin: 0, fontSize: 12 }}>
          กำลังโหลดหน้า {page}…
        </p>
      )}

      {data && items.length > 0 && pageCount > 1 && (
        <Pager
          page={page}
          pageCount={pageCount}
          onChange={setPage}
          testId="myhistory-pager"
          summary={`หน้า ${page} / ${pageCount}`}
        >
          {rangeOf(page, PAGE_SIZE, data.total)}
          {q.trim() ? ` · ค้นหา “${q.trim()}”` : ''}
        </Pager>
      )}

      {data && items.length > 0 && pageCount <= 1 && (
        <div className="muted" style={{ padding: '10px 16px', fontSize: 12, borderTop: '1px solid var(--line)' }}>
          ทั้งหมด {data.total} ฉบับ
          {q.trim() ? ` · ค้นหา “${q.trim()}” เจอ ${data.total}` : ''}
        </div>
      )}
    </div>
  )
}
