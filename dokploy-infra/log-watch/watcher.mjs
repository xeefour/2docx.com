/**
 * Log Watch — ตรวจระบบอัตโนมัติทุกชั่วโมง
 *
 * ทำอะไร
 * ------
 *   1. สุขภาพระบบ        → /api/health ของระบบเรา (ราย service)
 *   2. เส้นทางหลัก        → ยิงทีละเส้นทางผ่าน gateway แล้วดู "เนื้อหา" ไม่ใช่แค่ 200
 *   3. พอร์ตที่รั่ว        → ต่อ TCP ไปที่พอร์ตบน host.docker.internal
 *                          (ต่อได้ = ผูกกับ 0.0.0.0 = เข้าจาก LAN ได้)
 *   4. เหตุการณ์น่าสงสัย → นับจาก Loki
 *   5. ถ้าพบปัญหา          → สรุปด้วย AI (ยิงเฉพาะตอนพบ ประหยัดโควตา) แล้วเขียนไฟล์
 *
 * ทำไมต้องเช็ค "เนื้อหา" ไม่ใช่แค่สถานะ
 * ---------------------------------------
 *   เคยเจอ container ขึ้น "Up" แต่ตอบไม่ได้ (crash loop ช้า, dependency ตาย, route พัง)
 *   การเช็คแค่ 200 ผ่านทั้งที่ระบบตาย
 *
 * ทำไมไม่ใช้ docker CLI
 * ----------------------
 *   ตั้งใจไม่ mount docker.sock (สิทธิ์เทียบ root ของ host)
 *   สถานะ container จึงอ่านจาก /api/health ของระบบเราแทน
 */
import { writeFileSync, mkdirSync, appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const GW = process.env.GATEWAY_URL || 'http://docgen-gateway';
const LOKI = process.env.LOKI_URL || 'http://loki:3100';
const ANALYZER = process.env.ANALYZER_URL || 'http://log-analyzer:3110';
const ALLOY = process.env.ALLOY_METRICS || 'http://alloy:12345/metrics';
const OUT_DIR = process.env.FINDINGS_DIR || '/findings';
const INTERVAL_MS = Math.max(60_000, Number(process.env.CHECK_INTERVAL_MIN || 60) * 60_000);
const API_KEY = process.env.MINIMAX_API_KEY || '';
const BASE_URL = (process.env.MINIMAX_BASE_URL || 'https://api.minimax.io/anthropic/v1').replace(/\/+$/, '');
const MODEL = process.env.WATCH_MODEL || 'minimax/MiniMax-M3.1-Flash-Preview';

// หมายเหตุ: รายการพอร์ตที่ต้องตรวจมีอยู่ฝั่ง host ที่ collect-host-state.ps1 เท่านั้น
//   ไม่ได้ประกาศซ้ำในไฟล์นี้ เพราะสองรายการจะหลุดจากกันเมื่อมีการเพิ่มพอร์ตใหม่
//   (เคยเป็นแบบนี้มาแล้ว — ค่าในไฟล์นี้ไม่มีใครใช้ จึงเป็นตัวหลอกที่ดูน่าเชื่อถือ)

// เส้นทางหลักผ่าน gateway — expect คือข้อความที่ต้องอยู่ในเนื้อหา
const ROUTES = [
  { name: 'healthz', path: '/healthz', expect: 'ok' },
  { name: 'หน้าเว็บ', path: '/', expect: '2docx' },
  { name: 'API health', path: '/api/health', expect: 'status' },
  { name: 'เอกสาร API', path: '/apis', expect: 'swagger' },
  { name: 'สเปก API', path: '/openapi.json', expect: 'openapi' },
  { name: 'ไฟล์ใน S3', path: '/files/', expect: '<' },
  { name: 'Loki', path: '/logs/ready', expect: 'ready' },
];

/**
 * รูปแบบที่นับ "น่าสงสัย" — ต้องเขียนให้ RE2 ของ Loki รับได้จริง
 *
 * ⚠️ วัดแล้วบน Loki 3.7.8 วันที่ 2026-10-06:
 *   · `\b` (word boundary) → ไม่ error แต่คืน **0 ผลลัพธ์** เงียบ ๆ (อันตรายกว่า error
 *     เพราะดูเหมือน "ไม่มีปัญหา" ทั้งที่ตัวกรองใช้ไม่ได้)
 *   · `\s` → HTTP 400 Bad Request
 *   · กลุ่ม `(a|b|c)` และคำเว้นวรรคตรง ๆ → ใช้ได้
 *
 *   จึงต้องเขียนเป็นคำเต็มแยกกัน ไม่ใช้ \b และไม่ใช้ \s
 */
const SUSPECT = [
  'error', 'fatal', 'panic', 'exception', 'refused', 'denied',
  'unauthoriz', 'forbidden', 'failed', 'failure', 'timeout', 'timed out',
  'unhealthy', 'crashloop', 'out of memory', 'oom', 'killed', 'abort',
  'invalid', 'cannot', 'could not', 'unable',
].join('|');

/**
 * ตัด container ที่ "log ของตัวเอง" มีคำว่า error/failed ปนอยู่
 *
 * ⚠️ ทำไมต้องตัด — วัดได้ตอน 2026-10-06 ว่า
 *   รวมทุกตัว        9,740 บรรทัด/ชม.
 *   ตัด loki ออก     2,238 บรรทัด/ชม.   ← ลดไป 77% ทันที
 *
 *   เพราะ Loki เขียน log ทุกครั้งที่มี query เข้ามา และ query ของเราเอง
 *   มีคำว่า error/fatal อยู่ในข้อความ → นับตัวเองเป็น "เหตุการณ์น่าสงสัย" วนไป
 *   ตัวที่ตัดออกคือ loki (เขียน log ทุก query), log-watch (เขียน log ตัวเองทุกชม.),
 *   log-analyzer (ยิง query ที่มีคำว่า error) — ทั้งสามตัวยังถูกตรวจสุขภาพ
 *   โดยตัวตรวจอื่นอยู่แล้ว (checkAnalyzer ยิง /api/status ของ log-analyzer)
 */
const SELF_NOISE = ['loki', 'log-watch', 'log-analyzer'];

/**
 * เกณฑ์ที่ถือว่า "น่าสงสัยมากเกินไป" — ปรับได้ด้วย env SUSPECT_LIMIT
 *
 * ตั้งจากค่าที่วัดได้จริงหลังกรอง noise ออก: หลังตัดตัวเองและตัด Info ของ mongo
 * เหลือ 0 บรรทัด/ชม. → ใช้ 30 เป็นเพดานกันเหนียว โดยยังต่ำกว่าครึ่งของ
 * ปริมาณ noise ดิบเดิม (2,127) มาก
 */
const SUSPECT_LIMIT = Math.max(1, Number(process.env.SUSPECT_LIMIT || 30));

// ── helpers ──────────────────────────────────────────────────────────
const log = (...a) => console.log(`[${new Date().toISOString()}]`, ...a);

async function probeRoute(r) {
  const started = Date.now();
  try {
    const res = await fetch(`${GW}${r.path}`, {
      signal: AbortSignal.timeout(10_000), redirect: 'manual',
    });
    const text = await res.text();
    const ms = Date.now() - started;
    const hasContent = r.expect ? text.includes(r.expect) : true;
    const ok = res.ok && hasContent;
    return { ...r, ok, status: res.status, ms, bytes: text.length,
      detail: ok ? '' : (hasContent ? `HTTP ${res.status}` : `เนื้อหาไม่มี "${r.expect}"`) };
  } catch (e) {
    return { ...r, ok: false, status: 0, ms: Date.now() - started, bytes: 0,
      detail: e.name === 'TimeoutError' ? 'หมดเวลา 10 วิ' : e.message };
  }
}

async function checkHealth() {
  try {
    const res = await fetch(`${GW}/api/health`, { signal: AbortSignal.timeout(15_000) });
    const j = await res.json();
    const checks = j.checks ?? [];
    return {
      ok: j.summary?.down === 0 && j.summary?.degraded === 0,
      summary: j.summary,
      tookMs: j.tookMs,
      checks: checks.map((c) => ({ label: c.label, status: c.status, detail: c.detail, latencyMs: c.latencyMs })),
    };
  } catch (e) {
    return { ok: false, summary: null, error: e.message, checks: [] };
  }
}

async function checkAnalyzer() {
  try {
    const res = await fetch(`${ANALYZER}/api/status`, { signal: AbortSignal.timeout(10_000) });
    const j = await res.json();
    return { ok: res.ok && j.loki === true, loki: j.loki, keyOk: j.key?.ok ?? false, models: (j.models ?? []).length };
  } catch (e) { return { ok: false, error: e.message }; }
}

// (ตัวตรวจพอร์ตอยู่ใน checkPorts() — ดูเหตุผลว่าทำไมถึงอ่านจาก host)

/**
 * ตรวจพอร์ตที่รั่วออก LAN — อ่านจากไฟล์ที่ host เขียนให้
 *
 * ⚠️ ทำไมถึงอ่านจาก host แทนที่จะต่อเอง
 *   วิธีที่ดูเหมือนใช้ได้ — ต่อ TCP ไปที่ host.docker.internal:<port>
 *   — ผิดบน Windows Docker Desktop (WSL2)
 *
 *   วัดจริงตอน 2026-10-06: พอร์ตที่ผูกกับ 127.0.0.1 เท่านั้น
 *   (8090 · 3000 · 4001 · 3100 · 12345) ต่อถึงจาก container ได้หมด
 *   เพราะ vpnkit/HNS ใน WSL2 รับการเชื่อมต่อจาก container แล้วส่งต่อเข้า
 *   loopback ให้ → ขึ้นว่า "รั่ว 5 พอร์ต" ทั้งที่ LAN เข้าไม่ได้จริง
 *
 *   ถ้าปล่อยไว้แบบนั้น watcher จะร้องเตือนทุกชั่วโมงจนผู้ใช้เลิกสนใจ
 *   ซึ่งแย่กว่าไม่ตรวจเลย — จึงให้ host เป็นคนเก็บสถานะ bind แล้วส่งมาเป็นไฟล์
 *
 * ไฟล์นี้เขียนโดย `collect-host-state.ps1` (ฝั่ง host) ดูวิธีลงทะเบียนใน README
 */
async function checkPorts() {
  const file = join(OUT_DIR, 'host-state.json');
  let st;
  try {
    st = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return { ok: false, reason: 'ยังไม่มี host-state.json — ต้องรัน collect-host-state.ps1 บน host', leaks: [], stale: null };
  }

  const ageMin = Math.round((Date.now() - Date.parse(st.ts)) / 60000);
  const stale = Number.isFinite(ageMin) && ageMin > 120;   // เก่ากว่า 2 ชม. = ข้อมูลไม่ถูกต้อง
  const leaks = [
    ...(st.listeners ?? []).filter((l) => l.exposed).map((l) => ({ kind: 'listener', port: l.port, address: l.address })),
    ...(st.containers ?? []).filter((c) => c.exposed).map((c) => ({ kind: 'container', name: c.name, ports: c.ports })),
  ];
  return {
    ok: !stale,
    stale: ageMin,
    ageMin,
    checked: (st.listeners ?? []).length,
    leaks,
    // รายชื่อ container ที่ยังทำงานอยู่ ณ เวลาเก็บข้อมูล
    // ใช้ตัดปัญหาปลอมจาก log ของ container ที่ถูกลบไปแล้ว (ดู countSuspects)
    running: (st.containers ?? []).map((c) => c.name),
    note: stale ? `ข้อมูลเก่า ${ageMin} นาที — ไม่นับว่าปกติ` : null,
  };
}

/**
 * ยิง metric query ไปที่ Loki แล้วคืนจำนวนแยกราย container
 *
 * ⚠️⚠️ กับดักที่วัดได้จริง 2026-10-06 — หน้าต่างซ้อนกันทำให้นับเกิน
 *   Loki ประเมินผลทุก `step` วินาที แล้วแต่ละจุดคือ `count_over_time([ชั่วโมง])`
 *   ซึ่งเป็นหน้าต่างย้อนหลัง 1 ชั่วโมง **ถ้า step เล็กกว่าหน้าต่าง หน้าต่างจะซ้อนกัน**
 *   แล้วเอามาบวกกัน → บวมเป็นหลายเท่า
 *
 *   วัดกับ container ที่ log เยอะจริง (`loki`) ตอน 2026-10-06:
 *     step=60   → 62 จุด · รวมทุกจุด 42,811 · จุดสุดท้าย 822   = บวม 52 เท่า
 *     step=3600 →  3 จุด · รวมทุกจุด  1,032 · จุดสุดท้าย 826
 *
 *   และการที่ Loki คืน 3 จุด ไม่ใช่เรื่องบังเอิญ — มัน**จัดจุดประเมินให้ตรงขอบเวลา**
 *   ได้จุดที่ 04:00 / 05:00 / 06:00 พอดี แต่ละจุดจึงแทน "ชั่วโมงเต็ม" หนึ่งชั่วโมง
 *
 *   สรุป: **step ต้อง ≥ ความกว้างหน้าต่าง** แล้วอ่านเฉพาะจุดสุดท้าย (slice(-1))
 *   จึงได้ "ชั่วโมงเต็มที่เพิ่งผ่านมา" ซึ่งตรงกว่าช่วงท้ายที่เป็นเศษ
 *   และไม่มีทางบวมเกิน
 *
 * ⚠️ `container!="ชื่อ"` ใน LogQL เทียบแบบตรงตัวอักษร ไม่ใช่ regex
 *   ต้องการ "ไม่ใช่ mongo" ต้องเขียน `container!~"mongo-.+"`
 *   ถ้าใช้ผิดจะได้ผลลวงว่ากรองแล้วทั้งที่ไม่ได้กรองเลย (เจอแล้วระหว่างเขียน)
 */
async function lokiByContainer(inner, hours) {
  const end = new Date();
  const windowMs = hours * 3600_000;
  const start = new Date(end.getTime() - windowMs);
  const q = encodeURIComponent(`sum by (container) (${inner})`);
  const url =
    `${LOKI}/loki/api/v1/query_range?query=${q}` +
    `&start=${encodeURIComponent(start.toISOString())}` +
    `&end=${encodeURIComponent(end.toISOString())}` +
    `&step=${hours * 3600}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`Loki ${res.status}: ${(await res.text()).slice(0, 150)}`);
  const rows = (await res.json()).data?.result ?? [];

  // ⚠️⚠️ Loki คืน "จุด" เฉพาะจุดที่ stream นั้นมีข้อมูลในหน้าต่างนั้นจริง
  //   stream ที่หยุดเขียน log ไปแล้วจะไม่มีจุดใหม่ → จุดสุดท้ายที่ได้อาจ**เก่าได้เป็นชั่วโมง**
  //   วัดจริง 2026-10-06: container ที่หยุดเขียนตั้งแต่ 04:45
  //     ตอนถามเวลา 06:00 Loki คืนจุดเดียว คือจุดที่ครอบคลุม [04:00–05:00] = 42
  //     ถ้าเอาจุดสุดท้ายมาใช้ตรง ๆ จะได้ตัวเลขเก่า 1 ชั่วโมง
  //     และถ้าหยุดเขียนนานกว่านั้น จะเดินหน้าไปเรื่อย ๆ เป็นเวลา 14 วัน (retention ของ Loki)
  //
  //   แก้โดยทิ้งจุดที่เก่ากว่าหน้าต่างที่ถามก่อน แล้วค่อยเอาจุดสุดท้าย
  //   ถ้าไม่เหลือจุดเลย = ไม่มีบรรทัดที่ตรงเงื่อนไขในหน้าต่างนี้ = ไม่ต้องนับ
  //
  //   ⚠️ metric query คืน timestamp หน่วย **วินาที** (log query คือนาโนวินาที)
  const cutoffSec = (end.getTime() - windowMs) / 1000;
  const out = new Map();
  for (const s of rows) {
    const name = s.metric?.container ?? '(ไม่ทราบ)';
    const fresh = (s.values ?? []).filter((v) => Number(v[0]) >= cutoffSec);
    if (!fresh.length) continue;
    const n = Number(fresh[fresh.length - 1][1]) || 0;   // จุดสุดท้ายที่ยังอยู่ในหน้าต่าง
    if (n > 0) out.set(name, (out.get(name) ?? 0) + n);
  }
  return out;
}

/**
 * นับบรรทัดที่ตรงกับเงื่อนไข "น่าสงสัย" ในช่วงที่กำหนด แยกราย container
 *
 * ต้องใช้ `query_range` ไม่ใช่ `query` (instant)
 *   ตัวหลังตอบ 400 Bad Request บน Loki 3.7.8 เมื่อถาม log query
 *
 * ต้องแยก mongo ออกมากรองระดับความรุนแรง — วัดได้ 2026-10-06:
 *   mongo 3 ตัวเขียน 120,009 บรรทัด/ชม. แยกเป็น
 *     Info 119,856 · Warn 153 · Error 0 · Fatal 0
 *   คือเกือบทั้งหมดเป็นเรื่องปกติของ replica set ("Ending connection due to
 *   bad connection status", "Index build: waiting for last optime") ที่มีคำว่า
 *   error/timeout/failed ปนอยู่ → ถ้านับตามคำ จะขึ้นว่า "ระบบมีปัญหา 2,127 ครั้ง/ชม."
 *   ทุกชั่วโมงจนผู้ใช้เลิกสนใจ ซึ่งแย่กว่าไม่ตรวจเลย
 *   จึงนับเฉพาะระดับ W/E/F ซึ่งเป็นปัญหาจริงตามความหมายของ MongoDB เอง
 */
async function countSuspects(hours = 1) {
  const quiet = SELF_NOISE.map((c) => `container!="${c}"`).join(', ');
  try {
    // mongo → เอาเฉพาะ Warn/Error/Fatal
    const mongo = await lokiByContainer(
      `count_over_time({container=~"mongo-.+", ${quiet}} |~ "\\"s\\":\\"(W|E|F)\\"" |~ "${SUSPECT}" [${hours}h])`,
      hours,
    );
    // ที่เหลือ → นับตามคำทั่วไป
    const rest = await lokiByContainer(
      `count_over_time({container=~".+", container!~"mongo-.+", ${quiet}} |~ "${SUSPECT}" [${hours}h])`,
      hours,
    );
    const byContainer = [...new Map([...mongo, ...rest]).entries()]
      .map(([container, count]) => ({ container, count }))
      .sort((a, b) => b.count - a.count);
    const total = byContainer.reduce((a, b) => a + b.count, 0);
    return {
      ok: true,
      count: total,
      windowHours: hours,
      limit: SUSPECT_LIMIT,
      overLimit: byContainer.filter((x) => x.count > SUSPECT_LIMIT),
      byContainer,
      note: 'mongo นับเฉพาะระดับ Warn/Error/Fatal · ตัด log ของตัวตรวจเองออกแล้ว',
    };
  } catch (e) {
    return { ok: false, count: 0, error: e.message, windowHours: hours, byContainer: [] };
  }
}

async function alloyStats() {
  try {
    const res = await fetch(ALLOY, { signal: AbortSignal.timeout(10_000) });
    const t = await res.text();
    const pick = (n) => { const m = t.match(new RegExp(`^${n}\\{[^\\n]*?\\}\\s+([0-9.e+]+)`, 'm')); return m ? Number(m[1]) : null; };
    return { ok: true, read: pick('loki_source_docker_target_entries_total'), sent: pick('loki_write_sent_entries_total') };
  } catch { return { ok: false }; }
}

// ── AI: สรุปเฉพาะตอนพบปัญหา ──────────────────────────────────────────
async function askAI(problemText) {
  if (!API_KEY) return '(ไม่ได้ตั้ง MINIMAX_API_KEY — ข้ามการสรุป)';
  const body = {
    model: MODEL,
    max_tokens: 262144,
    output_config: { effort: 'low' },     // effort ใช้ได้เฉพาะ M3.1
    messages: [{
      role: 'user',
      content:
`คุณคือผู้ตรวจสอบระบบ Docker ที่ทำงานอัตโนมัติทุกชั่วโมง และเจอความผิดปกติ

รายงานตรวจสอบรอบนี้:
${problemText}

เขียนสรุปสำหรับคนดูแลระบบตามรูปแบบนี้เท่านั้น:

## สาเหตุที่น่าจะเป็น
- ...

## สิ่งที่ต้องทำ
1. ...   (คำสั่งที่รันได้จริง ถ้ามี)

## ข้อควรระวัง
- ...

ตอบไทย กระชับ อ้างอิงตัวเลขจากรายงานที่ให้มา ถ้าข้อมูลไม่พอให้บอกว่าต้องดูอะไรเพิ่ม`,
    }],
  };
  try {
    const res = await fetch(`${BASE_URL}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(240_000),
    });
    const data = await res.json();
    if (!res.ok) return `(AI ตอบ ${res.status}: ${JSON.stringify(data).slice(0, 300)})`;
    const text = (data.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
    if (!text) {
      const kinds = (data.content ?? []).map((b) => b.type).join(', ') || '(ไม่มี block เลย)';
      return `(AI ไม่ได้ส่งคำตอบกลับ — stop_reason=${data.stop_reason}, block=${kinds})`;
    }
    return text;
  } catch (e) { return `(เรียก AI ไม่สำเร็จ: ${e.message})`; }
}

// ── รอบตรวจ ──────────────────────────────────────────────────────────
async function runOnce() {
  const startedAt = new Date();
  log('── เริ่มตรวจรอบใหม่ ──');

  const [health, routes, ports, suspects, analyzer, alloy] = await Promise.all([
    checkHealth(), Promise.all(ROUTES.map(probeRoute)), checkPorts(),
    countSuspects(1), checkAnalyzer(), alloyStats(),
  ]);

  const problems = [];
  if (!health.ok) problems.push(`สุขภาพรวมไม่ปกติ (${health.summary ? `up ${health.summary.up} · degraded ${health.summary.degraded} · down ${health.summary.down}` : health.error})`);
  for (const c of health.checks) if (c.status !== 'up') problems.push(`${c.label}: ${c.status} — ${c.detail}`);
  const badRoutes = routes.filter((r) => !r.ok);
  for (const r of badRoutes) problems.push(`เส้นทาง ${r.name} (${r.path}) ผิดปกติ — ${r.detail}`);
  const leaks = ports.leaks ?? [];
  for (const p of leaks) {
    problems.push(p.kind === 'listener'
      ? `พอร์ต ${p.port} ผูกกับ ${p.address} — เข้าจาก LAN ได้ ควรผูก 127.0.0.1`
      : `container ${p.name} publish พอร์ตออกมา (${p.ports}) — เข้าจาก LAN ได้`);
  }
  if (ports.note) problems.push(ports.note);
  if (!analyzer.ok) problems.push(`log-analyzer ไม่พร้อม — ${analyzer.error ?? 'ติดต่อ Loki ไม่ได้'}`);
  if (!suspects.ok) {
    problems.push(`นับเหตุการณ์น่าสงสัยไม่ได้ — ${suspects.error} (ตรวจนี้ถือว่าไม่ผ่าน เพราะเงียบไปดีกว่าผ่านผิด)`);
  } else {
    // ⚠️ log ของ container ที่ถูกลบแล้วยังอยู่ใน Loki ครบ retention (14 วัน)
    //   ถ้าไม่กันไว้ ทุกครั้งที่ `docker rm` จะมีแจ้งเตือนปลอมซ้ำเป็นเวลา 14 วัน
    //   (เจอจริงระหว่างทดสอบ — container ที่ฉีดเพื่อพิสูจน์วิธีนับ โดนนับเป็น "ปัญหา" 42 ครั้ง/ชม.)
    //   แก้โดยเทียบกับรายชื่อ container ที่ยังทำงานอยู่ ซึ่ง host-state.json มีอยู่แล้ว
    //   ⚠️ เชื่อได้เฉพาะตอน host-state.json สดไม่เกิน 2 ชม. — ถ้าเก่าแล้วต้องไม่ตัดสินใจตาม
    const runningSet = ports.ok && ports.running ? new Set(ports.running) : null;
    for (const x of suspects.overLimit) {
      const stopped = runningSet ? !runningSet.has(x.container) : false;
      if (stopped) {
        problems.push(
          `${x.container} ไม่ได้ทำงานอยู่แล้ว แต่มี log ค้าง ${x.count} บรรทัด/ชม. — ` +
          `นับเป็นปัญหาไม่ได้ เพราะ Loki ยังเก็บ log ของ container ที่ลบแล้วไว้ ${14} วัน ` +
          `(ถ้าตั้งใจแล้วให้เพิ่มพอร์ต/แก้ config ที่ทำให้เกิดขึ้น ให้ดูหมวด "ข้อมูลดิบ")`,
        );
      } else {
        problems.push(`${x.container} มีเหตุการณ์น่าสงสัย ${x.count} บรรทัด/ชม. (เกณฑ์ ${suspects.limit})`);
      }
    }
  }

  const summary = {
    ts: startedAt.toISOString(),
    ok: problems.length === 0,
    problemCount: problems.length,
    health, routes: routes.map(({ name, path, ok, status, ms }) => ({ name, path, ok, status, ms })),
    ports, suspects, analyzer, alloy,
  };

  appendFileSync(join(OUT_DIR, 'runs.jsonl'), JSON.stringify(summary) + '\n', 'utf8');

  if (problems.length === 0) {
    log('ไม่พบความผิดปกติ — ไม่เขียนไฟล์ findings (เก็บแค่ runs.jsonl)');
    return summary;
  }

  log(`พบ ${problems.length} รายการ → เขียนไฟล์ + สรุปด้วย AI`);

  const detail = [
    `สุขภาพรวม: ${health.summary ? `up ${health.summary.up} / degraded ${health.summary.degraded} / down ${health.summary.down}` : health.error}`,
    ...health.checks.map((c) => `- ${c.label}: ${c.status} · ${c.detail} · ${c.latencyMs}ms`),
    '',
    `เส้นทาง (${routes.length - badRoutes.length}/${routes.length} ปกติ):`,
    ...routes.map((r) => `- ${r.name} ${r.path} → ${r.ok ? 'ปกติ' : 'ผิดปกติ (' + r.detail + ')'} · ${r.ms}ms`),
    '',
    ports.ok
      ? `พอร์ต: ตรวจ ${ports.checked} รายการจาก host-state.json (อายุ ${ports.ageMin} นาที) · รั่ว ${leaks.length}`
      : `พอร์ต: ตรวจไม่ได้ — ${ports.reason || ports.note || 'ไม่ทราบสาเหตุ'}`,
    ...(ports.leaks ?? []).map((p) => `  - ${p.kind === 'listener' ? `${p.port} ผูกกับ ${p.address}` : `${p.name} → ${p.ports}`}`),
    '',
    suspects.ok
      ? `เหตุการณ์น่าสงสัยใน 1 ชม.: ${suspects.count} บรรทัด (เกณฑ์ต่อ container ${suspects.limit}) — ${suspects.note}` +
        ((suspects.byContainer ?? []).length
          ? '\n' + suspects.byContainer.map((x) =>
              `    ${x.container}: ${x.count}${ports.ok && ports.running && !ports.running.includes(x.container) ? '  (ไม่ได้ทำงานอยู่แล้ว)' : ''}`)
            .join('\n')
          : '\n    (ไม่มี container ไหนเกินเกณฑ์)')
      : `เหตุการณ์น่าสงสัย: อ่านไม่ได้ (${suspects.error})`,
    alloy.ok && alloy.read ? `Alloy: อ่าน ${Math.round(alloy.read).toLocaleString()} บรรทัด → ส่ง Loki ${Math.round(alloy.sent ?? 0).toLocaleString()}` : '',
  ].filter(Boolean).join('\n');

  const ai = await askAI(problems.map((p) => `- ${p}`).join('\n') + '\n\nรายละเอียด:\n' + detail);

  const day = startedAt.toISOString().slice(0, 10);
  const md = [
    `# พบความผิดปกติ — ${startedAt.toLocaleString('th-TH')}`,
    '',
    `> ตรวจอัตโนมัติโดย \`log-watch\` · ${problems.length} รายการ`,
    '',
    '## สิ่งที่พบ',
    ...problems.map((p) => `- ${p}`),
    '',
    '## สรุปจาก AI',
    ai,
    '',
    '## ข้อมูลดิบ',
    '```',
    detail,
    '```',
    '',
  ].join('\n');

  const file = join(OUT_DIR, `${day}.md`);
  // ต่อท้ายไฟล์ของวันนี้ (เขียนหลายรอบต่อวันได้)
  const header = existsSync(file) ? '' : `# รายงานตรวจอัตโนมัติ — ${day}\n\n`;
  appendFileSync(file, header + md, 'utf8');
  writeFileSync(join(OUT_DIR, 'latest.md'), md, 'utf8');

  log(`เขียนแล้ว: ${file} + latest.md`);
  return summary;
}

// ── ลูป ──────────────────────────────────────────────────────────────
mkdirSync(OUT_DIR, { recursive: true });
log(`Log Watch เริ่มทำงาน · ทุก ${INTERVAL_MS / 60000} นาที · เขียนที่ ${OUT_DIR}`);

// รันทันทีตอนบูต แล้วค่อยเป็นรอบ
await runOnce().catch((e) => log('รอบแรกล้ม:', e.message));
setInterval(() => runOnce().catch((e) => log('รอบนี้ล้ม:', e.message)), INTERVAL_MS);