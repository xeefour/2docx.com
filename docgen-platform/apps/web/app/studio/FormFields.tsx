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
import { useMemo, useState } from 'react'
import {
  fieldDomId,
  fieldLabel,
  getPath,
  groupFields,
  groupKey,
  looksLikeToken,
  middleTruncate,
  setPath,
} from './lib/fields'
import { copyText } from './lib/copy'
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
   * ค่าที่ยาวเกินอ่าน (hash 64 ตัว, URL) ไม่ต้องยัดลงช่องกรอก
   *
   * ⚠️ เงื่อนไข: ต้องกลับไปเป็นช่องกรอกปกติได้ ไม่งั้นผู้ใช้แก้ค่าไม่ได้
   *   เพราะการย่อค่าใน `<input>` จะทำให้**บันทึกค่าที่ย่อแล้ว**ลงไปในเอกสาร
   *   การย่อจึงทำได้เฉพาะตอน**แสดง** แล้วต้องมีทางกลับเป็นช่องกรอกเต็มเสมอ
   */
  const [expandLong, setExpandLong] = useState(false)
  const textValue = String(value ?? '')
  const isLong = (f.type === 'text' || f.type === 'email') && looksLikeToken(textValue)
  // พิมพ์เองได้ = ต้องกลับเป็น input เสมอ (ยกเว้นตอนฟอร์มถูกล็อกอ่านอย่างเดียว)
  const collapseLong = isLong && !expandLong

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

      {collapseLong && (
        <LongValue
          full={textValue}
          disabled={disabled}
          onExpand={() => setExpandLong(true)}
        />
      )}

      {(f.type === 'text' || f.type === 'email' || f.type === 'date') &&
        !collapseLong &&
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

      {/* ช่องยาวที่กด "แก้ไข" แล้ว → ต้องมีทางย่อกลับ ไม่งั้นผู้ใช้แก้แล้วออกไม่ได้
        (ย่อกลับได้เฉพาะตอนยังเป็นค่ายาวอยู่ ถ้าแก้จนสั้นแล้วปุ่มนี้หายเอง) */}
      {isLong && expandLong && !disabled && (
        <button type="button" className="ghost fieldlong__toggle" onClick={() => setExpandLong(false)}>
          ย่อค่าให้สั้น
        </button>
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

/**
 * แถวแสดงค่าที่ยาวเกินอ่าน — หัว…ท้าย + ปุ่มคัดลอก + ปุ่มกลับไปแก้
 *
 * ── ทำไมต้องมีปุ่มคัดลอก ────────────────────────────────────────────────
 *   ย่อให้สั้นแล้วผู้ใช้เอา**ค่าเต็ม**ไปใช้ต่อไม่ได้ และ hash ยาว 64 ตัว
 *   เลือกเมาส์ด้วยตาแล้วหลุดไปกลางคัน (ไม่มีจุดขัดให้จับ)
 *   คัดลอกจึงเป็นทางออกที่ผู้ใช้คาดหวังจริง ไม่ใช่ของแถม
 */
function LongValue({
  full,
  disabled,
  onExpand,
}: {
  full: string
  disabled?: boolean
  onExpand: () => void
}) {
  const [state, setState] = useState<'idle' | 'ok' | 'err'>('idle')
  return (
    <div className="fieldlong">
      {/*
        `title` เป็นทางเดียวที่โชว์ค่าเต็มโดยไม่ต้องกลับไปเป็นช่องกรอก
        ผู้ใช้เอาเมาส์ทับได้เห็นทั้งหมด (คัดลอกให้คนละทาง)
      */}
      <code className="fieldlong__val" title={full} data-testid="fieldlong-val">
        {middleTruncate(full)}
      </code>
      <span className="fieldlong__len">{full.length} ตัวอักษร</span>
      <button
        type="button"
        className={'ghost fieldlong__copy' + (state === 'idle' ? '' : ` ${state}`)}
        data-testid="fieldlong-copy"
        onClick={() =>
          void (async () => {
            const ok = await copyText(full)
            setState(ok ? 'ok' : 'err')
            setTimeout(() => setState('idle'), 1600)
          })()
        }
      >
        {state === 'ok' ? 'คัดลอกแล้ว ✓' : state === 'err' ? 'คัดลอกไม่สำเร็จ' : 'คัดลอก'}
      </button>
      {!disabled && (
        <button
          type="button"
          className="ghost fieldlong__toggle"
          data-testid="fieldlong-expand"
          onClick={onExpand}
        >
          แก้ไข
        </button>
      )}
      {/*
        ⚠️ ไม่ใส่ live region ซ้ำซ้อนกับป้ายปุ่ม
          screen reader จะอ่านข้อความเดียวกันสองครั้ง (เหมือนเคยเจอที่ SharePanel)
          ป้ายปุ่มเปลี่ยนอยู่แล้ว = การยืนยันผลผ่านช่องทางเดียว
      */}
    </div>
  )
}
