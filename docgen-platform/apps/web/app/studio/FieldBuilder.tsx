'use client'

/**
 * ตัวออกแบบช่องกรอกของแม่แบบ (custom input properties)
 *
 * ผู้ใช้กำหนดเองได้ว่า
 *   · ช่องนี้เป็น input / textarea / select / ตัวเลข / วันที่ / checkbox ฯลฯ
 *   · ต้องกรอกไหม · ต้องเป็นจำนวนเต็มไหม · ต้อง match regex ไหม
 *   · อยู่กลุ่มไหน · เรียงลำดับเท่าไร
 *   · ให้ AI ช่วยเติมช่องนี้ไหม
 *
 * ⚠️ `key` ต้องตรงกับแท็ก `{d.…}` ในไฟล์แม่แบบ มิฉะนั้น Carbone จะไม่แทนค่า
 *    จึงมีปุ่ม "เติมช่องจากแท็กที่แม่แบบใช้" เป็นทางลัดที่ปลอดภัยที่สุด
 */
import { useState } from 'react'
import type { FieldDef, FieldType, TemplateTag } from './lib/api'
import { groupFields, groupKey, sortFields } from './lib/fields'

const TYPES: Array<{ id: FieldType; label: string }> = [
  { id: 'text', label: 'ข้อความสั้น (input)' },
  { id: 'textarea', label: 'ข้อความยาว (textarea)' },
  { id: 'number', label: 'ตัวเลขทศนิยมได้' },
  { id: 'integer', label: 'จำนวนเต็ม' },
  { id: 'select', label: 'เลือกอย่างเดียว (select)' },
  { id: 'multiselect', label: 'เลือกได้หลายอัน' },
  { id: 'date', label: 'วันที่' },
  { id: 'email', label: 'อีเมล' },
  { id: 'checkbox', label: 'ใช่ / ไม่ใช่' },
]

const emptyField = (order: number): FieldDef => ({
  key: '',
  label: '',
  type: 'text',
  group: '',
  order,
  required: false,
  ai: { enabled: true },
})

/**
 * แปลงข้อความหลายบรรทัดเป็นรายการตัวเลือก — รูปแบบ `ค่า|ป้าย` บรรทัดละหนึ่งค่า
 *
 * - ข้ามบรรทัดว่าง
 * - ไม่มี `|` → ใช้ค่าเดียวกันทั้งค่าและป้าย
 * - `|` เกินหนึ่งตัว → เอาส่วนที่เหลือไปรวมเป็นป้าย (ป้ายหนังสือราชการมี `|` บ่อย)
 */
function parseOptionLines(text: string): NonNullable<FieldDef['options']> {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [value, ...rest] = line.split('|')
      return { value, label: rest.join('|') || value }
    })
}

/**
 * ตัวแก้ไขตัวเลือกของช่อง `select` / `multiselect`
 *
 * ⚠️ กล่อง "เพิ่มหลายบรรทัดพร้อมกัน" ต้องเป็น **uncontrolled**
 *
 *    ถ้าเขียนแบบเดียวกับช่อง key คือ
 *      `value={options.map(o => `${o.value}|${o.label}`).join('\n')}`
 *      แล้วยิง onChange ทุกตัวอักษร → พิมพ์ "นาย" กลายเป็น "นาย|นาย" กลางคัน
 *      ค่ากลับมาเขียนทับสิ่งที่ผู้ใช้พิมพ์ → เคอร์เซอร์กระโดด → พิมพ์ไทยติดขัด
 *      (อาการเดียวกับที่ผู้ใช้เจอที่ช่อง key พอดี)
 *
 *    จึงเก็บข้อความดิบไว้ใน `bulk` เอง แล้วค่อยแปลงเป็น options
 *    `bulk === null` = ผู้ใช้ยังไม่แตะ → ให้ textarea ใช้ค่าเริ่มต้นจาก options
 */
function OptionsEditor({
  field,
  index,
  canEdit,
  onChange,
}: {
  field: FieldDef
  index: number
  canEdit: boolean
  onChange: (options: NonNullable<FieldDef['options']>) => void
}) {
  const options = field.options ?? []
  const [bulk, setBulk] = useState<string | null>(null)

  const setOptions = (next: NonNullable<FieldDef['options']>) => {
    // รายการเปลี่ยนจากข้างนอก (เพิ่ม/ลบแถว) → ให้กล่องข้อความกลับไปอ่านค่าจาก options ใหม่
    setBulk(null)
    onChange(next)
  }

  const patchOption = (oi: number, p: Partial<{ value: string; label: string }>) => {
    const next = [...options]
    next[oi] = { ...next[oi], ...p }
    setOptions(next)
  }

  return (
    <div style={{ gridColumn: '1 / -1' }}>
      <label style={{ fontWeight: 600 }}>ตัวเลือกที่ให้ผู้ใช้เลือก</label>
      <div className="muted" style={{ fontSize: 12.5, marginBottom: 8 }}>
        <strong>ค่า</strong> คือสิ่งที่ต้องตรงกับแท็กในไฟล์แม่แบบ (Carbone จะแทนค่านี้)
        · <strong>ป้าย</strong> คือข้อความที่ผู้ใช้เห็นในช่องเลือก (เว้นว่างไว้ = ใช้ค่าเดียวกับป้าย)
      </div>

      {options.length === 0 && (
        <p className="muted" style={{ margin: '0 0 8px', fontSize: 13 }}>
          ยังไม่มีตัวเลือก — กด “+ เพิ่มตัวเลือก” ด้านล่าง
        </p>
      )}

      <div style={{ display: 'grid', gap: 8 }}>
        {options.map((o, oi) => (
          <div key={oi} style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <div style={{ flex: '1 1 160px', minWidth: 140 }}>
              <input
                value={o.value}
                disabled={!canEdit}
                placeholder="ค่า เช่น นาย"
                aria-label={`ค่าตัวเลือกที่ ${oi + 1}`}
                data-testid={`option-value-${index}-${oi}`}
                onChange={(e) => patchOption(oi, { value: e.target.value })}
              />
            </div>
            <div style={{ flex: '1 1 160px', minWidth: 140 }}>
              <input
                value={o.label}
                disabled={!canEdit}
                placeholder="ป้ายที่แสดง (ถ้าว่างใช้ค่าเดียวกัน)"
                aria-label={`ป้ายตัวเลือกที่ ${oi + 1}`}
                data-testid={`option-label-${index}-${oi}`}
                onChange={(e) => patchOption(oi, { label: e.target.value })}
              />
            </div>
            <button
              className="ghost danger"
              style={{ padding: '5px 10px', fontSize: 12 }}
              disabled={!canEdit}
              data-testid={`option-remove-${index}-${oi}`}
              onClick={() => setOptions(options.filter((_, x) => x !== oi))}
              title="เอาตัวเลือกนี้ออก"
            >
              ลบ
            </button>
          </div>
        ))}
      </div>

      <button
        className="ghost"
        style={{ marginTop: 10 }}
        disabled={!canEdit}
        data-testid={`add-option-${index}`}
        onClick={() => setOptions([...options, { value: '', label: '' }])}
      >
        + เพิ่มตัวเลือก
      </button>

      <details style={{ marginTop: 10 }}>
        <summary className="muted" style={{ fontSize: 12.5, cursor: 'pointer' }}>
          เพิ่มหลายตัวเลือกพร้อมกัน (วางหลายบรรทัด)
        </summary>
        <textarea
          rows={4}
          disabled={!canEdit}
          style={{ marginTop: 8, width: '100%' }}
          placeholder={'นาย\nนาง\nนางสาว'}
          data-testid={`bulk-options-${index}`}
          defaultValue={options.map((o) => `${o.value}|${o.label}`).join('\n')}
          value={bulk ?? undefined}
          onChange={(e) => {
            const text = e.target.value
            setBulk(text)
            onChange(parseOptionLines(text))
          }}
        />
      </details>
    </div>
  )
}

export default function FieldBuilder({
  fields,
  tags,
  canEdit,
  busy,
  onSave,
  onImportTags,
  onClear,
  notify,
}: {
  fields: FieldDef[]
  tags: TemplateTag[]
  canEdit: boolean
  busy: boolean
  onSave: (fields: FieldDef[]) => Promise<void>
  onImportTags: () => Promise<void>
  onClear: () => Promise<void>
  notify: (msg: string) => void
}) {
  const [draft, setDraft] = useState<FieldDef[]>(fields)
  const [editing, setEditing] = useState<number | null>(null)
  const [saving, setSaving] = useState(false)

  // โหลดค่าใหม่จาก server (เช่น กด "เติมจากแท็ก") โดยไม่ทับที่ผู้ใช้กำลังแก้
  if (fields !== draft && editing === null) {
    setDraft(fields)
  }

  const dirty = JSON.stringify(sortFields(fields)) !== JSON.stringify(sortFields(draft))

  const patch = (i: number, p: Partial<FieldDef>) =>
    setDraft((d) => d.map((f, idx) => (idx === i ? { ...f, ...p } : f)))

  const patchRule = (i: number, p: Partial<NonNullable<FieldDef['rules']>>) =>
    setDraft((d) =>
      d.map((f, idx) => (idx === i ? { ...f, rules: { ...(f.rules ?? {}), ...p } } : f)),
    )

  async function save() {
    // key ว่าง = ยังไม่กรอกชื่อช่อง → ข้ามไป ไม่ใช่ error
    const cleaned = draft
      .filter((f) => f.key.trim())
      .map((f, i) => ({ ...f, key: f.key.trim(), label: f.label.trim(), order: i }))

    const dup = cleaned.map((f) => f.key).filter((k, i, a) => a.indexOf(k) !== i)
    if (dup.length > 0) {
      notify(`มีช่องชื่อซ้ำ: ${[...new Set(dup)].join(', ')}`)
      return
    }

    setSaving(true)
    try {
      await onSave(cleaned)
    } catch {
      // onSave แจ้ง error ให้ผู้ใช้เองแล้ว (ผ่าน notify) — ที่นี่แค่กันไม่ให้ error หลุดเป็น
      // unhandled rejection แล้วไปโผล่ในแถบสถานะของหน้าเว็บ
    } finally {
      setSaving(false)
    }
  }

  const groups = groupFields(draft)

  return (
    <div style={{ display: 'grid', gap: 14 }}>
      {/* ── แถบเครื่องมือ ── */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <button
          className="ghost"
          disabled={!canEdit || busy}
          onClick={() => {
            setDraft((d) => [...d, emptyField(d.length)])
            setEditing(draft.length)
          }}
        >
          + เพิ่มช่อง
        </button>
        <button
          className="ghost"
          disabled={!canEdit || busy || fields.length === 0}
          onClick={async () => {
            if (!confirm(`ล้างช่องทั้งหมดของแม่แบบนี้? (${fields.length} ช่อง)`)) return
            await onClear()
          }}
          title="ล้างฟอร์ม → กลับไปใช้ช่องจากแท็กอัตโนมัติ"
        >
          ล้างช่องทั้งหมด
        </button>
        <div style={{ flex: 1 }} />
        {dirty && <span className="pill warn">ยังไม่บันทึก</span>}
        <button onClick={() => void save()} disabled={!canEdit || saving || !dirty}>
          {saving ? 'กำลังบันทึก…' : 'บันทึกช่องฟอร์ม'}
        </button>
      </div>

      {!canEdit && (
        <p className="muted" style={{ margin: 0, fontSize: 13 }}>
          คุณมีสิทธิ์ดูอย่างเดียวสำหรับแม่แบบนี้ — ขอสิทธิ์จากเจ้าของเพื่อแก้ไข
        </p>
      )}

      {/* ── ช่องที่ยังไม่ได้ทำ ── */}
      <div className="card" style={{ padding: 14 }}>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <div style={{ flex: 1, minWidth: 240 }}>
            <strong style={{ fontSize: 14 }}>เติมช่องจากแท็กที่แม่แบบใช้</strong>
            <div className="muted" style={{ fontSize: 12.5 }}>
              อ่าน <code className="mono">{'{d.…}'}</code> จากไฟล์แม่แบบจริงแล้วสร้างช่องให้ครบ
              (ช่องที่มีอยู่แล้วจะไม่ถูกทับ) — พบ {tags.length} แท็ก
            </div>
          </div>
          <button className="ghost" disabled={!canEdit || busy} onClick={() => void onImportTags()}>
            เติมช่องอัตโนมัติ
          </button>
        </div>
        {tags.length > 0 && (
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 10 }}>
            {tags.map((t) => (
              <span key={t.path} className="pill" title={`ใช้ ${t.count} ครั้ง`}>
                <code>{t.path}</code>
              </span>
            ))}
          </div>
        )}
      </div>

      {/* ── รายการช่อง ── */}
      {groups.length === 0 && (
        <p className="muted" style={{ textAlign: 'center', padding: '32px 0', margin: 0 }}>
          ยังไม่มีช่องกรอก — กด “เติมช่องอัตโนมัติ” หรือ “+ เพิ่มช่อง”
        </p>
      )}

      {groups.map((g) => (
        /**
         * ⚠️ `key` ต้องเป็น `groupKey(g, draft)` ไม่ใช่ `g.group`
         *   ชื่อกลุ่มเปลี่ยนทุกตัวอักษรที่พิมพ์ในช่อง "กลุ่ม" → ถ้าใช้ชื่อเป็น key
         *   React จะถอดกลุ่มทิ้งแล้วใส่ใหม่ → โฟกัสหลุดทุกตัวอักษร
         */
        <div key={groupKey(g, draft)}>
          <div className="fieldset__legend" style={{ marginBottom: 8 }}>
            {g.group}
          </div>
          <div className="card" style={{ overflow: 'hidden' }}>
            {g.fields.map((f) => {
              const i = draft.indexOf(f)
              const open = editing === i
              return (
                /**
                 * ⚠️ `key` ต้อง**นิ่ง** ห้ามผูกกับ `f.key`
                 *
                 *   เคยใช้ ``key={`${f.key}-${i}`}`` → พิมพ์อักษรในช่อง key ครั้งเดียว
                 *   ค่า key เปลี่ยน → React มองว่าเป็น element ใหม่ → **ถอดแล้วใส่ใหม่**
                 *   ผลคือโฟกัสหลุดทุกตัวอักษร (พิมพ์ "ไ" แล้วต้องคลิกใหม่)
                 *   และที่แย่กว่านั้น **IME ไทยพังทันที** เพราะ input ที่กำลัง "เรียงพิมพ์"
                 *   ถูกทำลายกลางคัน (ผู้ใช้รายงานว่า "พิมพ์ 1 ครั้งแล้วต้องรอ")
                 *
                 *   ใช้เลข index ของ draft แทน ซึ่งตรงกับตัวตนของโค้ดอยู่แล้ว
                 *   (`patch(i, …)` · `editing === i` · `draft.indexOf(f)`)
                 *   กดย้ายขึ้น/ลงแล้วแถวจะสลับ key กัน (React สร้างใหม่) แต่ตอนนั้นโฟกัสอยู่ที่ปุ่ม
                 *   ไม่กระทบการพิมพ์
                 */
                <div key={i} style={{ borderBottom: '1px solid var(--line)' }}>
                  {/* ── แถวสรุป ── */}
                  <div
                    style={{
                      display: 'flex',
                      gap: 10,
                      alignItems: 'center',
                      padding: '10px 14px',
                      flexWrap: 'wrap',
                    }}
                  >
                    <code className="mono" style={{ fontSize: 12.5 }}>
                      {f.key || '(ยังไม่ได้ตั้งชื่อ)'}
                    </code>
                    <span className="muted" style={{ fontSize: 12.5 }}>
                      {f.label && f.label !== f.key ? `— ${f.label}` : ''}
                    </span>
                    <span className="pill">{TYPES.find((t) => t.id === f.type)?.label ?? f.type}</span>
                    {f.required && <span className="pill err">required</span>}
                    {f.rules?.integer && <span className="pill">integer</span>}
                    {f.rules?.pattern && <span className="pill">regex</span>}
                    {f.ai?.enabled === false && <span className="pill">AI ไม่ช่วย</span>}

                    <div style={{ flex: 1 }} />

                    <button
                      className="ghost"
                      style={{ padding: '3px 8px', fontSize: 12 }}
                      disabled={!canEdit || i === 0}
                      onClick={() => {
                        const next = [...draft]
                        ;[next[i - 1], next[i]] = [next[i], next[i - 1]]
                        setDraft(next)
                      }}
                      title="ย้ายขึ้น"
                    >
                      ↑
                    </button>
                    <button
                      className="ghost"
                      style={{ padding: '3px 8px', fontSize: 12 }}
                      disabled={!canEdit || i === draft.length - 1}
                      onClick={() => {
                        const next = [...draft]
                        ;[next[i + 1], next[i]] = [next[i], next[i + 1]]
                        setDraft(next)
                      }}
                      title="ย้ายลง"
                    >
                      ↓
                    </button>
                    <button
                      className="ghost"
                      style={{ padding: '3px 8px', fontSize: 12 }}
                      data-testid={`field-edit-${i}`}
                      onClick={() => setEditing(open ? null : i)}
                    >
                      {open ? 'ปิด' : 'แก้ไข'}
                    </button>
                    <button
                      className="ghost danger"
                      style={{ padding: '3px 8px', fontSize: 12 }}
                      disabled={!canEdit}
                      onClick={() => {
                        setDraft((d) => d.filter((_, idx) => idx !== i))
                        setEditing(null)
                      }}
                    >
                      ลบ
                    </button>
                  </div>

                  {/* ── ฟอร์มแก้ไข ── */}
                  {open && (
                    <div
                      style={{
                        padding: 16,
                        background: 'var(--bg)',
                        display: 'grid',
                        gap: 12,
                        gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
                      }}
                    >
                      <div>
                        <label>key (ต้องตรงกับแท็กในไฟล์แม่แบบ)</label>
                        <input
                          value={f.key}
                          disabled={!canEdit}
                          data-testid={`field-key-${i}`}
                          onChange={(e) => patch(i, { key: e.target.value })}
                        />
                      </div>
                      <div>
                        <label>ป้ายกำกับที่ผู้ใช้เห็น</label>
                        <input
                          value={f.label}
                          disabled={!canEdit}
                          data-testid={`field-label-${i}`}
                          placeholder={f.key}
                          onChange={(e) => patch(i, { label: e.target.value })}
                        />
                      </div>
                      <div>
                        <label>ชนิด</label>
                        <select
                          value={f.type}
                          disabled={!canEdit}
                          data-testid={`field-type-${i}`}
                          onChange={(e) => patch(i, { type: e.target.value as FieldType })}
                        >
                          {TYPES.map((t) => (
                            <option key={t.id} value={t.id}>
                              {t.label}
                            </option>
                          ))}
                        </select>
                      </div>
                      <div>
                        <label>กลุ่ม</label>
                        <input
                          value={f.group}
                          disabled={!canEdit}
                          data-testid={`field-group-${i}`}
                          placeholder="ทั่วไป"
                          onChange={(e) => patch(i, { group: e.target.value })}
                        />
                      </div>
                      <div>
                        <label>ตัวอย่างในช่อง (placeholder)</label>
                        <input
                          value={f.placeholder ?? ''}
                          disabled={!canEdit}
                          onChange={(e) => patch(i, { placeholder: e.target.value })}
                        />
                      </div>
                      <div>
                        <label>คำอธิบายเพิ่มเติม</label>
                        <input
                          value={f.help ?? ''}
                          disabled={!canEdit}
                          onChange={(e) => patch(i, { help: e.target.value })}
                        />
                      </div>

                      {(f.type === 'select' || f.type === 'multiselect') && (
                        <OptionsEditor
                          field={f}
                          index={i}
                          canEdit={canEdit}
                          onChange={(options) => patch(i, { options })}
                        />
                      )}

                      <div style={{ gridColumn: '1 / -1' }}>
                        <label style={{ fontWeight: 600 }}>กติกาการตรวจ</label>
                        <div className="checkbox-row">
                          <input
                            id={`req-${i}`}
                            type="checkbox"
                            checked={f.required}
                            disabled={!canEdit}
                            onChange={(e) => patch(i, { required: e.target.checked })}
                          />
                          <label htmlFor={`req-${i}`}>ต้องกรอก (required)</label>
                        </div>
                        <div className="checkbox-row" style={{ marginTop: 6 }}>
                          <input
                            id={`int-${i}`}
                            type="checkbox"
                            checked={f.rules?.integer ?? f.type === 'integer'}
                            disabled={!canEdit}
                            onChange={(e) => patchRule(i, { integer: e.target.checked })}
                          />
                          <label htmlFor={`int-${i}`}>ต้องเป็นจำนวนเต็ม</label>
                        </div>

                        <div
                          style={{
                            display: 'grid',
                            gap: 8,
                            gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))',
                            marginTop: 10,
                          }}
                        >
                          <div>
                            <label>ความยาวต่ำสุด</label>
                            <input
                              type="number"
                              value={f.rules?.minLength ?? ''}
                              disabled={!canEdit}
                              onChange={(e) =>
                                patchRule(i, {
                                  minLength: e.target.value === '' ? undefined : Number(e.target.value),
                                })
                              }
                            />
                          </div>
                          <div>
                            <label>ความยาวมากสุด</label>
                            <input
                              type="number"
                              value={f.rules?.maxLength ?? ''}
                              disabled={!canEdit}
                              onChange={(e) =>
                                patchRule(i, {
                                  maxLength: e.target.value === '' ? undefined : Number(e.target.value),
                                })
                              }
                            />
                          </div>
                          <div>
                            <label>ค่าต่ำสุด</label>
                            <input
                              type="number"
                              value={f.rules?.min ?? ''}
                              disabled={!canEdit}
                              onChange={(e) =>
                                patchRule(i, { min: e.target.value === '' ? undefined : Number(e.target.value) })
                              }
                            />
                          </div>
                          <div>
                            <label>ค่ามากสุด</label>
                            <input
                              type="number"
                              value={f.rules?.max ?? ''}
                              disabled={!canEdit}
                              onChange={(e) =>
                                patchRule(i, { max: e.target.value === '' ? undefined : Number(e.target.value) })
                              }
                            />
                          </div>
                        </div>

                        <div style={{ marginTop: 10 }}>
                          <label>ต้อง match regex (JavaScript)</label>
                          <input
                            value={f.rules?.pattern ?? ''}
                            disabled={!canEdit}
                            placeholder="^[ก-๙\\s]+$"
                            onChange={(e) =>
                              patchRule(i, { pattern: e.target.value || undefined })
                            }
                          />
                          {f.rules?.pattern && (
                            <span
                              className="field-help"
                              style={{
                                color: 'var(--err)',
                                display: 'block',
                                fontSize: 12,
                              }}
                            >
                              {(() => {
                                try {
                                  new RegExp(f.rules.pattern as string)
                                  return 'regex ถูกต้อง'
                                } catch (e) {
                                  return `regex ผิด: ${(e as Error).message}`
                                }
                              })()}
                            </span>
                          )}
                        </div>
                        <div style={{ marginTop: 10 }}>
                          <label>ข้อความตอนไม่ผ่าน regex</label>
                          <input
                            value={f.rules?.patternMessage ?? ''}
                            disabled={!canEdit}
                            onChange={(e) =>
                              patchRule(i, { patternMessage: e.target.value || undefined })
                            }
                          />
                        </div>
                      </div>

                      <div style={{ gridColumn: '1 / -1' }}>
                        <label style={{ fontWeight: 600 }}>ให้ AI ช่วยเติมช่องนี้</label>
                        <div className="checkbox-row">
                          <input
                            id={`ai-${i}`}
                            type="checkbox"
                            checked={f.ai?.enabled !== false}
                            disabled={!canEdit}
                            onChange={(e) =>
                              patch(i, { ai: { enabled: e.target.checked, hint: f.ai?.hint } })
                            }
                          />
                          <label htmlFor={`ai-${i}`}>อนุญาตให้ AI เติมค่าในช่องนี้</label>
                        </div>
                        {f.ai?.enabled !== false && (
                          <div style={{ marginTop: 8 }}>
                            <input
                              value={f.ai?.hint ?? ''}
                              disabled={!canEdit}
                              placeholder="เช่น ใส่เป็น วัน/เดือน/ปี พ.ศ."
                              onChange={(e) => patch(i, { ai: { enabled: true, hint: e.target.value } })}
                            />
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      ))}
    </div>
  )
}
