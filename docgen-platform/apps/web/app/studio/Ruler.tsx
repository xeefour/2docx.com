'use client'

/**
 * ไม้บรรทัด (ruler) — บนหน้ากระดาษและด้านซ้าย แบบเดียวกับ Word
 *
 * ── ทำไมต้องเป็น SVG ไม่ใช่ div ซ้อ ๆ ───────────────────────────
 *   จุดขีดหนึ่งหน้าของเอกสารราชการมีหลายร้อยจุด
 *   ถ้าใช้ `<div>` หนึ่งจุดหนึ่ง element จะหนักและซูมแล้วกระพริบ
 *   SVG วาดเป็นเส้นเดียวจบ และเลขก็อยู่ในโมเดลเดียวกันขยับตามซูมฟรี ๆ
 *
 * ── ตำแหน่ง 0 ต้องตรงขอบกระดาษเป๊ะ ────────────────────────────
 *   ไม้บรรทัดกว้างเท่ากับ `stageW` ซึ่งคือความกว้างจริงของ canvas
 *   ถ้ากว้างเกิน ขอบขวาจะไม่ตรงขอบกระดาษ → ผู้ใช้วัดผิด
 *   จึงวาดไม้บรรทัด**ภายใน** stage ที่กำหนด width เท่ากับ canvas พอดี
 */
import { formatTick, pageUnits, ticks, type RulerUnit } from './lib/ruler'

const TICK = 'var(--ink-4, #9aa0a6)'
const TEXT = 'var(--ink-3, #6b7280)'

export default function Ruler({
  pageW,
  pageH,
  unit,
  width,
  height,
}: {
  /** ขนาดหน้ากระดาษเป็น pt จาก PDF */
  pageW: number
  pageH: number
  unit: RulerUnit
  /** ขนาดจริงบนจอของ canvas (px) — ไม้บรรทัดต้องกว้างเท่านี้ */
  width: number
  height: number
}) {
  if (width <= 0 || height <= 0) return null

  const h = pageUnits(pageW, pageH, unit)
  const th = ticks(h.w, width)
  const tv = ticks(h.h, height)

  return (
    <>
      {/* ── ไม้บรรทัดบน ── */}
      <svg className="rul rul--h" width={width} height={18} aria-hidden="true">
        {/* เส้นฐานล่างของไม้บรรทัด = ขอบบนของกระดาษ */}
        <line x1={0} y1={17.5} x2={width} y2={17.5} stroke={TICK} strokeWidth={1} />
        {th.minor.map((v) => (
          <line
            key={`n${v}`}
            x1={(v / h.w) * width}
            y1={17.5}
            x2={(v / h.w) * width}
            y2={12.5}
            stroke={TICK}
            strokeWidth={1}
          />
        ))}
        {th.major.map((v) => (
          <g key={`m${v}`}>
            <line
              x1={(v / h.w) * width}
              y1={17.5}
              x2={(v / h.w) * width}
              y2={8.5}
              stroke={TICK}
              strokeWidth={1}
            />
            <text
              x={(v / h.w) * width}
              y={8}
              fontSize={9}
              fill={TEXT}
              textAnchor="middle"
              fontFamily="ui-monospace, Consolas, monospace"
            >
              {formatTick(v, unit)}
            </text>
          </g>
        ))}
      </svg>

      {/* ── ไม้บรรทัดซ้าย ── */}
      <svg className="rul rul--v" width={18} height={height} aria-hidden="true">
        <line x1={17.5} y1={0} x2={17.5} y2={height} stroke={TICK} strokeWidth={1} />
        {tv.minor.map((v) => (
          <line
            key={`n${v}`}
            x1={17.5}
            y1={(v / h.h) * height}
            x2={12.5}
            y2={(v / h.h) * height}
            stroke={TICK}
            strokeWidth={1}
          />
        ))}
        {tv.major.map((v) => (
          <g key={`m${v}`}>
            <line
              x1={17.5}
              y1={(v / h.h) * height}
              x2={8.5}
              y2={(v / h.h) * height}
              stroke={TICK}
              strokeWidth={1}
            />
            <text
              transform={`translate(8 ${(v / h.h) * height}) rotate(-90)`}
              fontSize={9}
              fill={TEXT}
              textAnchor="middle"
              fontFamily="ui-monospace, Consolas, monospace"
            >
              {formatTick(v, unit)}
            </text>
          </g>
        ))}
      </svg>
    </>
  )
}
