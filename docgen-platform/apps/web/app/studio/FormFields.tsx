'use client'

/**
 * เรนเดอร์ช่องกรอกตาม schema ที่ผู้ใช้ออกแบบไว้
 *
 * ทำไมไม่กรอก `data` ตรง ๆ
 *   · ฟิลด์ในแม่แบบมีทั้งข้อความ ตัวเลข วันที่ dropdown กล่องเลือกหลายอัน
 *     การกรอกแบบเดียว (textbox ยาว ๆ) ทำให้ผู้ใช้พิมพ์ผิดง่าย
 *   · กติกา (required / integer / regex) ต้องตรวจตอนพิมพ์ ไม่ใช่ตอนกดเรนเดอร์
 *   · จัดกลุ่มและเรียงลำดับได้ตามที่ผู้ใช้ตั้ง
 *
 * ค่าที่ไม่มีใน schema แต่มีอยู่ใน `data` (เช่นกรอกจากแท็กเมื่อยังไม่ได้ตั้งฟอร์ม)
 * → แสดงเป็นกลุ่ม "ยังไม่ได้จัดกลุ่ม" เพื่อไม่ให้ข้อมูลหายจากสายตา
 */
import { useMemo } from 'react'
import { fieldDomId, fieldLabel, getPath, groupFields, groupKey, setPath } from './lib/fields'
import FieldAi from './FieldAi'
import type { FieldDef, TemplateTag } from './lib/api'

/**
 * ช่องที่ให้ผู้ช่วย AI ประจำช่องได้
 *
 * เงื่อนไขคือ "ช่องที่ผู้ใช้พิมพ์ข้อความเอง" = ทุกอย่างที่เรนเดอร์เป็น
 * `<textarea>` หรือ `<input>` — รวมช่องตัวเลขกับช่องวันที่ด้วย
 *
 * ❌ ไม่ให้กับ select / multiselect / checkbox
 *    เพราะสามอย่างนั้นผู้ใช้ "เลือก" ไม่ใช่ "เขียน" การให้ AI ช่วยจึงไม่มีความหมาย
 */
const AI_TYPES = new Set(['text', 'textarea', 'email', 'date', 'number', 'integer'])

export default function FormFields({
  fields,
  data,
  errors,
  onChange,
  disabled,
  tags,
  templateKey,
  templateName,
  notify,
}: {
  fields: FieldDef[]
  data: Record<string, unknown>
  errors: Record<string, string>
  onChange: (next: Record<string, unknown>) => void
  disabled?: boolean
  /** แท็กของแม่แบบ — ใช้เตือนว่ามีช่องที่ "ยังไม่ได้ทำเป็นช่องกรอก" */
  tags?: TemplateTag[]
  /** ข้อมูลสำหรับผู้ช่วย AI ประจำช่อง — ถ้าไม่ส่งมาจะไม่แสดงไอคอน */
  templateKey?: string
  templateName?: string
  notify?: (msg: string) => void
}) {
  const groups = useMemo(() => {
    const known = new Set(fields.map((f) => f.key))
    const extra = (tags ?? []).filter((t) => t.path && !known.has(t.path))
    const base = groupFields(fields)
    if (extra.length === 0) return base
    return [
      ...base,
      {
        group: 'ยังไม่ได้ทำเป็นช่องกรอก',
        fields: extra.map<FieldDef>((t, i) => ({
          key: t.path,
          label: t.path,
          type: 'text',
          group: '',
          order: i,
          required: false,
        })),
      },
    ]
  }, [fields, tags])

  const set = (key: string, value: unknown) => onChange(setPath(data, key, value))

  if (groups.length === 0) {
    return (
      <div className="muted" style={{ padding: '32px 16px', textAlign: 'center' }}>
        ยังไม่ได้ตั้งฟอร์มของแม่แบบนี้
        <br />
        ไปที่แท็บ <strong>ช่องฟอร์ม</strong> แล้วกด “เติมช่องจากแท็กที่แม่แบบใช้”
      </div>
    )
  }

  return (
    <div className="fieldset">
      {groups.map((g) => (
        <fieldset className="fieldset__group" key={groupKey(g, fields)} style={{ margin: 0 }}>
          <legend className="fieldset__legend">{g.group}</legend>
          <div className="fieldset">
            {g.fields.map((f, i) => (
              <Field
                /**
                 * ⚠️ `key` ต้องนิ่ง ห้ามใช้ `f.key`
                 *    ช่องใหม่จะมี `key` ว่างหลายช่องพร้อมกัน → key ซ้ำ
                 *    และถ้าใช้ `f.key` การแก้ชื่อช่องจะทำให้ React ถอด/ใส่ใหม่ทั้งตัว
                 *    → ช่องที่กำลังพิมพ์หลุดโฟกัส (IME ไทยพักด้วย)
                 *
                 * ⚠️ ห้ามผูกกับ `g.group` ด้วย — ชื่อกลุ่มเปลี่ยนได้จากแท็บ "ช่องฟอร์ม"
                 *    ใช้ `groupKey()` ซึ่งผูกกับลำดับช่องแทน (เหตุผลเดียวกับที่ผู้ใช้เจอโฟกัสหลุด)
                 */
                key={`${groupKey(g, fields)}-${i}`}
                field={f}
                value={getPath(data, f.key)}
                error={errors[f.key]}
                disabled={disabled}
                onChange={(v) => set(f.key, v)}
                ai={
                  templateKey
                    ? { templateKey, templateName: templateName ?? '', notify: notify ?? (() => {}) }
                    : null
                }
              />
            ))}
          </div>
        </fieldset>
      ))}
    </div>
  )
}

function Field({
  field: f,
  value,
  error,
  disabled,
  onChange,
  ai,
}: {
  field: FieldDef
  value: unknown
  error?: string
  disabled?: boolean
  onChange: (v: unknown) => void
  /** ข้อมูลสำหรับผู้ช่วย AI — null = ไม่ต้องใช้ (เช่น ไม่มี templateKey) */
  ai: { templateKey: string; templateName: string; notify: (msg: string) => void } | null
}) {
  const id = fieldDomId(f.key)
  const label = (
    <>
      {fieldLabel(f)}
      {f.required && <span style={{ color: 'var(--err)' }}> *</span>}
    </>
  )

  /**
   * ไอคอน AI ขวาสุดของช่อง — แสดงเฉพาะช่องที่พิมพ์ข้อความได้
   * วางเป็นลูกเดียวของ `.fieldbox` ซึ่ง `position: relative` ใน globals.css
   */
  const withAi = (input: React.ReactNode) => {
    const usable = ai && !disabled && AI_TYPES.has(f.type) && f.ai?.enabled !== false
    if (!usable) return input
    return (
      <div className="fieldbox">
        {input}
        <FieldAi
          field={f}
          value={value}
          templateKey={ai.templateKey}
          templateName={ai.templateName}
          onApply={onChange}
          notify={ai.notify}
        />
      </div>
    )
  }

  // checkbox ไม่ใช้ label ของ form — ต้องวางคู่กันเอง
  if (f.type === 'checkbox') {
    return (
      <div className="checkbox-row">
        <input
          id={id}
          type="checkbox"
          checked={value === true}
          disabled={disabled}
          onChange={(e) => onChange(e.target.checked)}
        />
        <label htmlFor={id}>{label}</label>
        {f.help && <span className="field-help" style={{ margin: 0 }}>{f.help}</span>}
        {error && <span className="field-error">{error}</span>}
      </div>
    )
  }

  return (
    <div>
      <label htmlFor={id}>{label}</label>

      {f.type === 'textarea' &&
        withAi(
          <textarea
            id={id}
            rows={4}
            value={String(value ?? '')}
            placeholder={f.placeholder}
            disabled={disabled}
            onChange={(e) => onChange(e.target.value)}
          />,
        )}

      {(f.type === 'text' || f.type === 'email' || f.type === 'date') &&
        withAi(
          <input
            id={id}
            type={f.type === 'date' ? 'date' : f.type === 'email' ? 'email' : 'text'}
            value={String(value ?? '')}
            placeholder={f.placeholder}
            disabled={disabled}
            onChange={(e) => onChange(e.target.value)}
          />,
        )}

      {(f.type === 'number' || f.type === 'integer') &&
        withAi(
          <input
            id={id}
            type="number"
            step={f.type === 'integer' ? 1 : 'any'}
            value={value === undefined || value === null ? '' : String(value)}
            placeholder={f.placeholder}
            disabled={disabled}
            onChange={(e) => onChange(e.target.value === '' ? '' : Number(e.target.value))}
          />,
        )}

      {f.type === 'select' && (
        <select
          id={id}
          value={String(value ?? '')}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
        >
          <option value="">— เลือก —</option>
          {(f.options ?? []).map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      )}

      {f.type === 'multiselect' && (
        <select
          id={id}
          multiple
          size={Math.min(6, Math.max(3, f.options?.length ?? 3))}
          value={Array.isArray(value) ? (value as string[]) : []}
          disabled={disabled}
          onChange={(e) =>
            onChange([...e.target.selectedOptions].map((o) => o.value))
          }
          style={{ height: 'auto' }}
        >
          {(f.options ?? []).map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      )}

      {f.help && <span className="field-help">{f.help}</span>}
      {error && <span className="field-error">{error}</span>}
    </div>
  )
}
