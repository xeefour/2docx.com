import { env, UpstreamError, normalizeThaiAlignment, setDocxThaiLanguage, normalizeCarboneData } from '@docgen/shared'

/** log ของ worker — รูปแบบเดียวกับ index.ts */
const logger = {
  info: (msg: string, meta: Record<string, unknown> = {}) =>
    console.log(JSON.stringify({ level: 'info', msg, ...meta })),
}

function headers(): Record<string, string> {
  return {
    Authorization: `Bearer ${env.DOCSERVER_API_KEY}`,
    'carbone-version': '5',
  }
}

const base = (): string => env.DOCSERVER_URL.replace(/\/$/, '')

/** ตรวจว่าได้ไฟล์จริง ไม่ใช่ JSON ที่หน้าตาเหมือนไฟล์ */
function assertRealFile(buf: Buffer, where: string): Buffer {
  // กันเผื่อ — ถ้าได้ JSON กลับมาแปลว่ายังไม่เสร็จ จะได้เรนเดอร์ซ้ำ
  if (buf.length < 1024 && buf[0] === 0x7b) {
    throw new UpstreamError('docserver', `${where} — ยังไม่เสร็จ ได้ JSON กลับมาแทนไฟล์`, buf.toString().slice(0, 300))
  }

  const magic = buf.subarray(0, 4).toString('latin1')
  const isPdf = magic === '%PDF'
  const isZip = buf[0] === 0x50 && buf[1] === 0x4b // docx/xlsx/pptx = zip

  if (!isPdf && !isZip) {
    throw new UpstreamError('docserver', `${where} — ได้ข้อมูลแปลกปลอม (magic: ${magic})`)
  }
  return buf
}

/**
 * สั่งเรนเดอร์แม่แบบที่ลงทะเบียนไว้ → ได้ไฟล์ตามรูปแบบที่ขอ
 *
 * Carbone 5 เรนเดอร์แบบ async ต้องยิง 2 รอบ:
 *   1) POST /render/{templateId}  →  ได้ { data: { renderId: "xxx.pdf" } }
 *   2) GET  /render/{renderId}    →  ได้ไฟล์จริง
 * ยิงรอบเดียวจะได้ JSON ~73 bytes ไม่ใช่ PDF
 */
async function renderToBuffer(
  templateId: string,
  body: { data: Record<string, unknown>; convertTo: string },
): Promise<Buffer> {
  const h = headers()

  // ── รอบ 1: สั่งเรนเดอร์ ได้ renderId ──────────────────────
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), env.DOCSERVER_TIMEOUT_MS)

  let renderId: string
  try {
    const res = await fetch(`${base()}/render/${encodeURIComponent(templateId)}`, {
      method: 'POST',
      headers: { ...h, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    })

    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new UpstreamError('docserver', `รอบ 1 ตอบ ${res.status}`, text.slice(0, 500))
    }

    const json = (await res.json()) as { success?: boolean; data?: { renderId?: string } }
    if (!json.success || !json.data?.renderId) {
      throw new UpstreamError('docserver', 'ไม่ได้ renderId', json)
    }
    renderId = json.data.renderId
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new UpstreamError('docserver', `เรนเดอร์เกิน ${env.DOCSERVER_TIMEOUT_MS} ms`)
    }
    throw err
  } finally {
    clearTimeout(timer)
  }

  // ── รอบ 2: ดึงไฟล์จริง ────────────────────────────────
  // ใช้ timeout ใหม่ เพราะรอบ 1 กินเวลาไปแล้ว
  const fileRes = await fetch(`${base()}/render/${encodeURIComponent(renderId)}`, {
    headers: h,
    signal: AbortSignal.timeout(env.DOCSERVER_TIMEOUT_MS),
  }).catch((err: unknown) => {
    throw new UpstreamError('docserver', 'ดึงไฟล์ไม่สำเร็จ', String(err))
  })

  if (!fileRes.ok) {
    throw new UpstreamError('docserver', `รอบ 2 ตอบ ${fileRes.status}`)
  }

  return assertRealFile(Buffer.from(await fileRes.arrayBuffer()), 'รอบ 2')
}

/**
 * แปลงไฟล์ .docx ดิบเป็น PDF โดยไม่ต้องลงทะเบียนเป็นแม่แบบ
 *
 * ใช้ `POST /render/template?download=true` ซึ่งรับไฟล์แม่แบบเป็น base64
 * ใน body แล้วคืนไฟล์ที่แปลงเสร็จมาเป็น binary ในคำตอบเดียว (ไม่ต้องดึงไฟล์รอบสอง)
 * เหมาะกับไฟล์ชั่วคราวที่เราสร้างขึ้นเอง เช่น .docx ที่แก้ w:jc แล้ว
 */
async function renderRawTemplateToPdf(docx: Buffer): Promise<Buffer> {
  const res = await fetch(`${base()}/render/template?download=true`, {
    method: 'POST',
    headers: { ...headers(), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      template: docx.toString('base64'),
      data: {},
      convertTo: 'pdf',
    }),
    signal: AbortSignal.timeout(env.DOCSERVER_TIMEOUT_MS),
  }).catch((err: unknown) => {
    throw new UpstreamError('docserver', 'ส่งไฟล์ .docx เพื่อแปลงเป็น PDF ไม่สำเร็จ', String(err))
  })

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new UpstreamError('docserver', `แปลง .docx เป็น PDF ตอบ ${res.status}`, text.slice(0, 500))
  }

  return assertRealFile(Buffer.from(await res.arrayBuffer()), 'แปลง .docx เป็น PDF')
}

/**
 * เรนเดอร์เอกสารจากแม่แบบ
 *
 * ── PDF ใช้สองขั้น ส่วนรูปแบบอื่นใช้ขั้นเดียว ──────────────────
 * `thaiDistribute` (กระจายทั้งบรรทัดแบบไทย) เป็นค่าที่ Word เข้าใจ
 * แต่ LibreOffice ที่ใช้แปลงเป็น PDF ไม่รู้จัก → ผลลัพธ์กลายเป็น "ชิดซ้าย"
 *
 * ถ้าแก้ค่านี้ในตัวแม่แบบตั้งแต่ตอนอัปโหลด เอกสาร `.docx` ที่ส่งมอบจะเสีย
 * การกระจายแบบไทยไป เพราะ Carbone คง `w:jc` เดิมทุกประการในไฟล์ที่ส่งออก
 * จึงต้องแก้ตอนส่งออก PDF เท่านั้น:
 *
 *   1. ให้ Carbone เติมข้อมูลลงแม่แบบ → .docx (ยังเป็น thaiDistribute)
 *   2. แก้ thaiDistribute → both ในไฟล์นั้น
 *   3. ส่ง .docx ที่แก้แล้วกลับเข้า Carbone ให้แปลงเป็น PDF
 *
 * รูปแบบอื่น (docx/odt/…) ไม่ต้องแก้อะไร — ส่งตรงจากแม่แบบตามเดิม
 * (ดู tests/README-DockerHub.md หัวข้อ "สำคัญ — อย่าแก้แม่แบบเป็น both")
 *
 * ── .docx ที่ส่งมอบ เพิ่มการตั้งภาษาไทยอีกชั้น ──────────────────
 * แม่แบบต้นแบบตั้งภาษาเริ่มต้นไว้ที่ en-US ทำให้ Word/LibreOffice
 * เอาพจนานุกรมอังกฤษมาตรวจข้อความไทย → ขึ้นเส้นหยักสีแดงทั้งบรรทัด
 * แก้ตอนส่งออกที่นี่ (ไม่แตะแม่แบบ) เพราะ Carbone ไม่รู้จักเรื่องนี้
 * ดูรายละเอียดที่ `packages/shared/src/docx-lang.ts`
 */
export async function renderDocument(input: {
  templateId: string
  data: Record<string, unknown>
  outputFormat: string
}): Promise<Buffer> {
  const { templateId, data: rawData, outputFormat } = input

  /**
   * ช่อง checkbox ที่ไม่ได้ติ๊กมีค่า `false` แต่ Carbone 5 จะพิมพ์คำว่า "false"
   * ลงไปในเอกสาร แก้ตรงนี้ที่เดียวเพราะทั้งพรีวิวและดาวน์โหลดวิ่งผ่านฟังก์ชันนี้เสมอ
   * (ค่าใน Mongo คงเป็น `false` ไว้ เพื่อให้ฟอร์มกลับมาแสดง "ไม่ได้ติ๊ก" ถูกต้อง)
   */
  const { data, result: carbData } = normalizeCarboneData(rawData)
  if (carbData.changed) {
    logger.info('แปลง checkbox ที่ไม่ได้ติ๊กก่อนส่งให้ Carbone', {
      templateId,
      converted: carbData.converted,
      paths: carbData.paths,
    })
  }

  if (outputFormat !== 'pdf') {
    const out = await renderToBuffer(templateId, { data, convertTo: outputFormat })

    // เรียกเฉพาะ .docx — เส้นตรวจสะกดมีแต่โปรแกรมตรวจไฟล์ของ Microsoft/LibreOffice
    if (outputFormat === 'docx') {
      const { buf, result: lang } = setDocxThaiLanguage(out)
      if (lang.changed) {
        logger.info('ตั้งภาษาไทยในไฟล์ .docx ก่อนส่งออก', {
          templateId,
          runs: lang.runs,
          alreadyThai: lang.alreadyThai,
          skippedMixed: lang.skippedMixed,
        })
      }
      return buf
    }

    return out
  }

  // ── ขั้นที่ 1: เติมข้อมูล → .docx ที่ยังคง thaiDistribute ─────
  const filled = await renderToBuffer(templateId, { data, convertTo: 'docx' })

  // ── ขั้นที่ 2: แก้การจัดย่อหน้าให้ LibreOffice เข้าใจ ────────
  const { buf: patched, result: aligned } = normalizeThaiAlignment(filled)
  if (aligned.changed) {
    logger.info('แก้การจัดย่อหน้าไทยเป็น both ก่อนส่งออก PDF', {
      templateId,
      replaced: aligned.replaced,
    })
  }

  // ── ขั้นที่ 3: ส่ง .docx ที่แก้แล้วกลับเข้าไปแปลงเป็น PDF ──
  return renderRawTemplateToPdf(patched)
}

export const contentTypeFor = (format: string): string =>
  ({
    pdf: 'application/pdf',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    odt: 'application/vnd.oasis.opendocument.text',
  })[format] ?? 'application/octet-stream'
