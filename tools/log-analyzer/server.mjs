/**
 * Log Analyzer — เว็บ UI สำหรับวิเคราะห์ log ของทุก container ด้วย LLM (MiniMax)
 *
 * ── ทำงานยังไง ───────────────────────────────────────────────────────
 *   เบราว์เซอร์  ──►  server.mjs  ──►  Loki API      (ดึง log + สถิติ)
 *                              └──►  MiniMax API    (ยิงตรง ไม่ผ่าน Python)
 *
 * ── เรื่องความปลอดภัยที่ตั้งใจทำ ─────────────────────────────────────
 *   API key อยู่ใน .env ของโปรเจกต์ และถูก .gitignore ไว้ · server อ่านเอง
 *   เพื่อยิง แต่ไม่เคยส่ง key ไปยังเบราว์เซอร์ — /api/status บอกแค่ว่า
 *   "มีคีย์ไหม / อ่านมาจากไฟล์ไหน" ไม่บอกค่าคีย์
 *
 * ── วิธีรัน ──────────────────────────────────────────────────────────
 *   node tools/log-analyzer/server.mjs
 *   แล้วเปิด http://127.0.0.1:3110
 */

import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.LOG_UI_PORT || 3110);
/**
 * ค่าเริ่มต้น 127.0.0.1 = ปลอดภัย เพราะหน้านี้**ไม่มี auth**
 * เปิด 0.0.0.0 ได้เฉพาะตอนรันใน container ที่ gateway เป็นคนเรียกเข้ามาเท่านั้น
 * (ค่าที่ gateway ใช้เรียกคือชื่อ service ใน Docker network ไม่ใช่ผ่าน LAN)
 */
const HOST = process.env.LOG_UI_HOST || '127.0.0.1';
const LOKI_URL = process.env.LOKI_URL || 'http://127.0.0.1:3100';
const ALLOY_METRICS = process.env.ALLOY_METRICS || 'http://127.0.0.1:12345/metrics';

/**
 * ชื่อ compose project ที่ถือว่าเป็น "ของเรา" — ทุก query ไปหา Loki จะติด label นี้
 *
 * เครื่องนี้มีหลาย stack ปะปนกัน (สำรวจ 2026-10-06): `dokploy-infra` · `docgen` · `dockers`
 * Loki เก็บ 14 วัน ถ้าไม่กรอง หน้าเว็บจะเห็นชื่อของทุกโปรเจกต์ รวมถึงตัวที่ถูกลบไปแล้ว
 *
 * ⚠️ Alloy กรองตั้งแต่ต้นอยู่แล้ว (observability/alloy/config.alloy) แต่การกรองนั้น
 *    มีผลเฉพาะ log ที่เข้ามา**หลัง** restart · log เก่าที่เก็บไว้แล้วยังอยู่ครบ
 *    จึงต้องกรองซ้ำตอนอ่านด้วย ไม่งั้นรอ log เก่าหมดอายุ 14 วันถึงจะหาย
 *
 * ตั้งเป็นค่าว่างได้ถ้าอยากดูทุก stream ตอน debug
 */
const COMPOSE_PROJECT = process.env.COMPOSE_PROJECT ?? 'dokploy-infra';

// ─────────────────────────────────────────────────────────────────────
//  credential — อ่านจาก .env ของโปรเจกต์
//
//  ไฟล์ config.yaml ของ MiniMax Code มีค่า apiKey เป็น placeholder (ยาว ~6 ตัวอักษร)
//  เรียก API ไม่ได้ แต่ไฟล์นั้นยังมีประโยชน์: เราใช้ baseURL + รายชื่อโมเดลจากที่นั่น
//  ส่วนคีย์จริงใส่ในไฟล์เดียวของทั้งโปรเจกต์: dokploy-infra/.env
//  (2026-10-06 รวมไฟล์ env ทั้งหมดไว้ที่นี่ ดู docgen-platform/logs/prove-env-merge.mjs)
//
//  ตัวแปร: MINIMAX_API_KEY (บังคับ) · MINIMAX_BASE_URL (ไม่บังคับ)
//
//  ⚠️ ไฟล์นั้นถูก .gitignore ไว้แล้ว — คีย์จะไม่หลุดเข้า git
//     ห้ามสร้าง .env ในโฟลเดอร์นี้อีก ค่าจะถูกอ่านไม่เจอแล้วเงียบ ๆ
//     (เคยมีไฟล์นี้แล้วลบทิ้งตอนรวมไฟล์ — ไม่มีอะไรอ้างถึงแล้ว)
// ─────────────────────────────────────────────────────────────────────
const REPO_ROOT = join(__dirname, '..', '..');
//  ไฟล์เดียวของทั้งโปรเจกต์ (รวมไฟล์ env ทั้งหมดไว้ที่นี่ 2026-10-06)
//  เก็บรายการที่เคยมีไว้เป็นทางสำรอง เผื่อย้ายกลับมาใช้ แต่ไม่มีไฟล์ตามชื่อเหล่านี้แล้ว
const ENV_FILES = [
  join(REPO_ROOT, 'dokploy-infra', '.env'),
  join(REPO_ROOT, '.env'),
];

//  endpoint สาธารณะของ MiniMax แบบ Anthropic-compatible
//  https://platform.minimax.io/docs/api-reference/text-anthropic-api
//
//  ⚠️ ไม่เอา baseURL จาก config.yaml มาใช้: ค่านั้นชี้ไปที่เกตเวย์ภายในของ
//  แอป (agent.minimax.io/mavis/...) ซึ่งรับเฉพาะคีย์ของแอปเท่านั้น
//  คีย์ที่ผู้ใช้ใส่เองเป็นคีย์จาก platform.minimax.io → ต้องใช้ endpoint นี้
const PUBLIC_BASE_URL = 'https://api.minimax.io/anthropic/v1';

const CONFIG_PATH = join(
  process.env.__MAVIS_PARENT_DATA_DIR || process.env.MINIMAX_DATA_DIR || join(homedir(), '.minimax'),
  'config.yaml'
);

/** แปลง .env เป็น object — รองรับ # comment และ quote */
function parseDotEnv(text) {
  const o = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i < 1) continue;
    const k = line.slice(0, i).trim();
    let v = line.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (k) o[k] = v;
  }
  return o;
}

let envCache = null;
async function loadDotEnv() {
  if (envCache && Date.now() - envCache.at < 15000) return envCache.v;
  const merged = {};
  let found = null;
  for (const f of ENV_FILES) {
    try {
      const parsed = parseDotEnv(await readFile(f, 'utf8'));
      for (const [k, v] of Object.entries(parsed)) if (!(k in merged)) merged[k] = v;
      found = found || f;
    } catch { /* ไม่มีไฟล์นี้ — ข้ามไป */ }
  }
  envCache = { v: merged, at: Date.now(), found };
  return merged;
}

/** คีย์จาก .env · baseURL จาก .env ไม่งั้นใช้ endpoint สาธารณะ · โมเดลจาก config.yaml */
async function loadCreds() {
  const env = await loadDotEnv();
  const key = process.env.MINIMAX_API_KEY || process.env.LOG_UI_API_KEY || env.MINIMAX_API_KEY || '';

  const rawBase = env.MINIMAX_BASE_URL || process.env.MINIMAX_BASE_URL || PUBLIC_BASE_URL;

  //  endpoint ต้องลงท้ายด้วย /v1 เสมอ เพราะเรายิงที่ {baseURL}/messages
  const baseURL = rawBase.replace(/\/+$/, '').replace(/\/v1$/, '') + '/v1';

  //  config.yaml ไม่มีคีย์ที่ใช้ได้ แต่ยังมีประโยชน์: รายชื่อโมเดล + ตัวที่เป็นค่าเริ่มต้น
  let models = [];
  let defaultModel = '';
  try {
    const y = await readFile(CONFIG_PATH, 'utf8');
    defaultModel = (/^defaultModel:\s*(\S+)\s*$/m.exec(y)?.[1] || '').trim();
    models = parseModels(y);
  } catch { /* ไม่มี config.yaml — ใช้รายการโมเดลสำรอง */ }

  const isPlaceholder = !key || key.length < 20 || /^(xxx|your|changeme|<|\$\{)/i.test(key);
  return {
    key: isPlaceholder ? '' : key,
    placeholder: isPlaceholder,
    keyLength: key.length,
    baseURL,
    models,
    defaultModel,
    envFile: envCache?.found || null,
  };
}

/**
 * อ่านรายชื่อโมเดลจาก config.yaml โดยไม่ต้องใช้ YAML library
 * โครงสร้าง: provider.minimax.models.<ID>.name
 *   - ชื่อโมเดลอยู่ที่ indent 6
 *   - name: อยู่ที่ indent 8
 */
function parseModels(y) {
  const out = [];
  let inModels = false;
  let cur = null;
  for (const ln of y.split(/\r?\n/)) {
    if (/^ {4}models:\s*$/.test(ln)) { inModels = true; continue; }
    if (inModels) {
      if (/^ {4}\S/.test(ln)) { inModels = false; cur = null; continue; }
      const k = /^ {6}([A-Za-z0-9._-]+):\s*$/.exec(ln);
      if (k) { cur = { ref: `minimax/${k[1]}`, name: k[1], isDefault: false }; out.push(cur); continue; }
      const n = /^ {8}name:\s*(.+?)\s*$/.exec(ln);
      if (n && cur) cur.name = n[1].replace(/^["']|["']$/g, '');
    }
  }
  const def = (/^defaultModel:\s*(.+?)\s*$/m.exec(y)?.[1] || '').trim();
  for (const m of out) m.isDefault = m.ref === def;
  return out;
}

async function keyState() {
  const c = await loadCreds();
  const base = { envFile: c.envFile, baseURL: c.baseURL };
  if (c.key) return { ok: true, via: process.env.MINIMAX_API_KEY ? 'env' : 'dotenv', ...base };
  if (c.baseURL) return { ok: false, via: 'no-key', ...base };
  return { ok: false, via: 'no-config', ...base };
}

// ─────────────────────────────────────────────────────────────────────
//  ครอบ spawn เป็น promise
// ─────────────────────────────────────────────────────────────────────
function sh(cmd, args, { input = null, timeout = 120000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { windowsHide: true });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill();
      err += `\n[หมดเวลา ${timeout / 1000}s]`;
    }, timeout);

    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout: '', stderr: `${cmd} เรียกไม่ได้: ${e.message}` });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout: out, stderr: err });
    });

    if (input !== null) {
      child.stdin.write(input);
      child.stdin.end();
    }
  });
}

// ─────────────────────────────────────────────────────────────────────
//  Loki
// ─────────────────────────────────────────────────────────────────────
async function lokiQueryRange(q, startIso, endIso, limit = 100) {
  const qs = encodeURIComponent(q);
  const url = `${LOKI_URL}/loki/api/v1/query_range?query=${qs}&start=${startIso}&end=${endIso}&limit=${limit}&direction=backward`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Loki ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return (await r.json()).data?.result || [];
}

/**
 * stream selector ที่ใช้ทุกครั้งที่ถาม Loki — ผูกไว้กับโปรเจกต์ของเรา
 * ตั้ง COMPOSE_PROJECT เป็นค่าว่าง = ไม่กรอง (ใช้ตอน debug เท่านั้น)
 */
const scopeSel = (extra = 'container=~".+"') =>
  (COMPOSE_PROJECT ? `compose_project="${COMPOSE_PROJECT}", ` : '') + extra;

/**
 * รายชื่อ container ที่มี log จริงในช่วงเวลาที่กำหนด (ใช้เติม dropdown)
 *
 * คืน [] เงียบ ๆ เมื่อ Loki ไม่พร้อม เพราะผู้เรียกไม่ควรพังเพราะของเสริม
 * (หน้าเว็บต้องยังดู digest ได้แม้ Loki ล่มชั่วคราว)
 *
 * ── ทำไมไม่ใช้ /loki/api/v1/label/container/values ──────────────────────
 *   เคยใช้ทางนั้น แล้วพังเงียบ — เจอตอนพิสูจน์ 2026-10-06:
 *     1. endpoint นั้น**ไม่รับ match[]** บน Loki 3.7.8 ของเรา
 *        ส่ง `match[]={compose_project="dokploy-infra"}` ไปก็ถูกเมิน ไม่ error
 *        แต่ก็ไม่กรอง — ทดสอบด้วย selector แคบที่สุด `{job="dokploy-infra.gateway"}`
 *        ผลยังคืน 25 ตัวเท่าเดิม คือ "ดูเหมือนทำงานแต่ไม่ทำอะไร"
 *        (ข้อนี้อันตรายกว่า error เพราะโค้ดผ่านการทดสอบโดยไม่มีใครเห็น)
 *     2. แม้ไม่ใส่ match[] ผลก็ยังรวมทุกโปรเจกต์ + container ที่ถูกลบไปแล้ว
 *        เพราะ Loki เก็บ log ไว้ครบ 14 วัน
 *   วิธีที่ถูกคือถามเป็น log query จริง ด้วย selector ที่มี compose_project
 *
 * ── ทำไมใช้ /query (instant) ไม่ใช่ /query_range ────────────────────────
 *   เคยใช้ query_range + step = ความกว้างหน้าต่าง แล้วผิด — เจอตอนพิสูจน์ 2026-10-06
 *   Loki **จัดตำแหน่งจุดให้ตรงกับหน่วยของ step** ไม่ได้เริ่มที่ `start` ที่เราส่งไป
 *   พอ step=86400 (1 วัน) จุดสุดท้ายจึงตกลงมาที่เที่ยงคืน UTC ไม่ใช่ที่ `end`
 *   ถามเวลา 08:21Z ก็ได้จุดสุดท้ายที่ 00:00Z = **ย้อนกลับไป 8 ชม. กว่าที่ถาม**
 *   พอเอามาเทียบกับ `end` ด้วยเกณฑ์แบบ `end - 5 นาที` ของจริงจะโดนตัดทิ้งหมด
 *   เหลือแค่ 12 จาก 22 ตัว โดยมี `docgen-web` ที่มี log จริง 5 บรรทัดหายไปด้วย
 *
 *   instant query ไม่มีปัญหานี้ เพราะถาม ณ เวลาเดียว ไม่มีจุดให้เลือก
 *   ⚠️ ใช้ได้เฉพาะ metric query — log query ต้องใช้ query_range เสมอ
 *      (อันนั้นตอบ 400 จริง ไม่ใช่ข้อจำกัดของเวอร์ชันนี้)
 */
async function lokiContainers(hours = 24) {
  const secs = Math.max(1, Math.round(hours)) * 3600;
  const q = encodeURIComponent(`sum by (container) (count_over_time({${scopeSel()}}[${secs}s]))`);
  const url = `${LOKI_URL}/loki/api/v1/query?query=${q}&time=${encodeURIComponent(new Date().toISOString())}`;
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(20000) });
    if (!r.ok) return [];
    const rows = (await r.json()).data?.result ?? [];
    // ทิ้งค่าที่เป็น 0 — Loki บางเวอร์ชันคืน stream ที่ไม่มีข้อมูลกลับมาด้วย
    // ถ้าไม่ทิ้ง container ที่ถูกลบไปแล้วจะโผล่ใน dropdown แบบเงียบ ๆ
    return rows
      .filter((row) => Number(row.value?.[1] ?? 0) > 0)
      .map((row) => row.metric?.container)
      .filter(Boolean)
      .sort();
  } catch {
    return [];
  }
}

/** แปลง window เป็นนาที + ช่วงเวลา ISO (UTC) — ต้องใช้ UTC เสมอ */
function windowOf(since) {
  const m = /^(\d+)([smhd])$/.exec(String(since).trim());
  let mins = 60;
  if (m) {
    const n = Number(m[1]);
    mins = { s: Math.max(1, n / 60), m: n, h: n * 60, d: n * 1440 }[m[2]];
  }
  const end = new Date();
  const start = new Date(end.getTime() - mins * 60000);
  return {
    mins: Math.ceil(mins),
    start: start.toISOString(),
    end: end.toISOString(),
    label: `${Math.round(mins)} นาที`,
  };
}

const hhmm = (nsBigInt) => {
  const ms = Number(BigInt(nsBigInt) / 1000000n);
  const d = new Date(ms);
  const p = (x) => String(x).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};

/** Loki คืน timestamp หน่วยนาโนวินาที (string) */
const toNs = (v) => (typeof v === 'string' ? v : String(v));

// ─────────────────────────────────────────────────────────────────────
//  แบบที่ทำให้ "น่าสงสัย" — ปรับได้ผ่าน API /api/patterns
// ─────────────────────────────────────────────────────────────────────
let SUSPECT =
  '(?i)error|fatal|panic|exception|refused|denied|unauthoriz|forbidden|timeout|timed out|unhealthy|crashloop|out of memory|oom|abort|invalid|cannot|could not|unable|not primary|NotWritablePrimary|heartbeat failed|ReadConcernMajority|topology change|sync source|Host failed in replica set|slow query';

// ─────────────────────────────────────────────────────────────────────
//  สร้าง digest — นี่คือสิ่งที่ส่งให้ LLM อ่าน
// ─────────────────────────────────────────────────────────────────────
async function buildDigest({ since, containers }) {
  const w = windowOf(since);
  const list = (Array.isArray(containers) ? containers : [])
    .flatMap((c) => String(c).split(','))
    .map((c) => c.trim())
    .filter(Boolean);
  const cFilter = scopeSel(list.length ? `container=~"(${list.join('|')})"` : 'container=~".+"');

  const out = [];
  const meta = { since: w.mins, containers: list, all: [], volume: [], groups: [], status: [], drop: null, replica: null };

  // ── 0. รายชื่อ container ที่มี log จริง ────────────────────────────
  //  อ่านจาก label ของ Loki ไม่ใช่ `docker ps`
  //
  //  เพราะ: ตอนรันเป็น container เราไม่ได้ mount docker.sock (ตั้งใจ เรื่องความปลอดภัย)
  //         ถ้าอ่านจาก `docker ps` รายชื่อจะว่าง หน้าเว็บจะมี dropdown แค่ตัวเดียว "ทุกตัว"
  //         และ Loki รู้ดีกว่า Docker อยู่แล้ว เพราะมันคือคนเก็บ log
  //
  //  ⚠️ ใช้ช่วงเวลาคงที่ 24 ชม. ไม่ใช่ช่วงที่ผู้ใช้เลือก
  //     เพราะ dropdown ต้องไม่ขยับตามช่วงเวลา — ถ้าใช้ w.start แล้วเปลี่ยนเป็น "15 นาที"
  //     รายชื่อจะหายไปเกือบหมด ทำให้เลือกกรองไม่ได้
  //     (Loki เก็บไว้ 14 วัน ใช้ 24 ชม. = รายชื่อนิ่งและครอบคลุมพอ)
  //
  //  ⚠️ กรองด้วย compose_project ที่นี่ด้วย — ไม่งั้น dropdown จะมีชื่อของโปรเจกต์อื่น
  //     และ container ที่ถูกลบไปแล้วปนอยู่ เพราะ Loki เก็บ log ไว้ครบ 14 วัน
  const labelVals = await lokiContainers(24);
  meta.all = labelVals;
  out.push(`> container ที่มี log ใน 24 ชม. ล่าสุด (เฉพาะโปรเจกต์ ${COMPOSE_PROJECT || 'ทั้งหมด'}): ${labelVals.length} ตัว` +
    (labelVals.length ? ` (${labelVals.join(', ')})` : ''));
  out.push('');

  out.push(`# รายงาน log ของระบบ Docker (ช่วง ${w.label} ที่ผ่านมา)`);
  out.push(`เวลาที่รันรายงาน: ${new Date().toLocaleString('th-TH')}`);
  out.push(`ขอบเขต: ${list.length ? list.join(', ') : 'ทุก container'}`);
  if (COMPOSE_PROJECT) out.push(`โปรเจกต์ที่รายงานนี้ครอบคลุม: ${COMPOSE_PROJECT}`);
  out.push('');

  // ── 1. สถานะ container ──
  out.push('## 1. สถานะ container');
  // กรองด้วย label ให้ตรง scope เดียวกับที่ Loki เก็บ ไม่งั้นจะเห็น container
  // ของโปรเจกต์อื่นปนอยู่ในหัวข้อนี้ (มีผลตอนรันบน host เท่านั้น — ในโหมด container
  // ไม่มี docker CLI อยู่แล้ว หัวข้อนี้จะขึ้นว่าอ่านไม่ได้ตามปกติ)
  const psArgs = ['ps', '--format', '{{.Names}}|{{.Status}}'];
  if (COMPOSE_PROJECT) psArgs.unshift('--filter', `label=com.docker.compose.project=${COMPOSE_PROJECT}`);
  const ps = await sh('docker', psArgs, { timeout: 20000 });
  if (ps.code === 0 && ps.stdout.trim()) {
    for (const line of ps.stdout.trim().split(/\r?\n/)) {
      const [name, st = ''] = line.split('|');
      const bad = /unhealthy|Restarting|Exited/i.test(st);
      meta.status.push({ name, st, ok: !bad });
      out.push(`- ${name}: ${st}${bad ? '   <<< มีปัญหา' : ''}`);
    }
  } else {
    out.push('- อ่านสถานะ docker ไม่ได้ (อาจเพราะ Docker ไม่ทำงาน)');
  }
  out.push('');

  // ── 2. replica set ──
  const rsJs =
    'const s=rs.status();const p=s.members.find(m=>m.stateStr==="PRIMARY");' +
    'let o="PRIMARY="+p.name.replace(":27017","");' +
    's.members.forEach(m=>{const d=p.optime.ts.getHighBits()-m.optime.ts.getHighBits();' +
    'o+=" | "+m.name.replace(":27017","")+"="+(d>0?("lag"+d+"s"):(d<0?("AHEAD "+(-d)+"s (หน้า primary!)"):"lag0s"))+",health="+m.health;});print(o);';
  const rs = await sh('docker', ['exec', 'mongo-1', 'mongosh', '--quiet', '--eval', rsJs], { timeout: 25000 });
  if (rs.code === 0) {
    const line = (rs.stdout + rs.stderr).split(/\r?\n/).find((l) => l.includes('PRIMARY='));
    if (line) {
      meta.replica = line.trim();
      out.push('## 2. สถานะ MongoDB replica set');
      out.push(line.trim());
    }
  }
  out.push('');

  // ── 3. ปริมาณ log ──
  try {
    const rows = await lokiQueryRange(`sum by (container) (bytes_over_time({${cFilter}}[${w.mins}m]))`, w.start, w.end, 50);
    const vols = rows
      .map((r) => ({ c: r.metric?.container || '?', b: Number(r.values.at(-1)?.[1] || 0) }))
      .filter((x) => x.b > 0)
      .sort((a, b) => b.b - a.b);
    const total = vols.reduce((s, x) => s + x.b, 0);
    meta.volume = vols.map((x) => ({ c: x.c, mb: x.b / 1048576 }));
    meta.totalMb = total / 1048576;
    out.push('## 3. ปริมาณ log ที่เก็บไว้ (Loki)');
    if (!vols.length) {
      out.push('- ไม่มีข้อมูลในช่วงนี้ (Loki เพิ่งเริ่มทำงาน หรือ Loki ไม่ทำงาน)');
    } else {
      for (const v of vols.slice(0, 12)) {
        const pct = total ? (100 * v.b) / total : 0;
        out.push(`- ${v.c}: ${(v.b / 1048576).toFixed(2)} MB (${pct.toFixed(1)}%)`);
      }
      out.push(`- รวม: ${(total / 1048576).toFixed(2)} MB  ≈ ${((total / 1048576 / (w.mins / 1440))).toFixed(1)} MB/วัน`);
    }
    out.push('');
  } catch (e) {
    out.push('## 3. ปริมาณ log');
    out.push(`- ดึงจาก Loki ไม่สำเร็จ: ${e.message}`);
    out.push('');
  }

  // ── 4. เหตุการณ์น่าสงสัย ──
  try {
    const rows = await lokiQueryRange(`{${cFilter}} |~ "${SUSPECT}"`, w.start, w.end, 800);
    const groups = new Map();
    let total = 0;

    for (const r of rows) {
      const cname = r.stream?.container || r.metric?.container || '?';
      for (const v of r.values || []) {
        total++;
        const line = String(v[1] || '');
        const mm = /"msg":"([^"]{1,90})"/.exec(line) || /\bmsg="?([^" ]{1,80})"?/.exec(line);
        let key = mm ? mm[1] : line.replace(/\s+/g, ' ').trim().slice(0, 80);
        if (!key) continue;
        const gk = `${cname}|${key}`;
        if (!groups.has(gk)) {
          groups.set(gk, { c: cname, k: key, n: 0, first: hhmm(toNs(v[0])), last: hhmm(toNs(v[0])), samples: [] });
        }
        const g = groups.get(gk);
        g.n++;
        const t = hhmm(toNs(v[0]));
        if (t < g.first) g.first = t;
        if (t > g.last) g.last = t;
        if (g.samples.length < 2) g.samples.push(line);
      }
    }

    const all = [...groups.values()].sort((a, b) => b.n - a.n);
    meta.groups = all;
    meta.totalSuspect = total;

    out.push('## 4. เหตุการณ์ที่เข้าเงื่อนไข "น่าสงสัย"');
    out.push(`พบ ${total} บรรทัด / ${all.length} ประเภท`);
    out.push('');
    out.push('(ช่วงเวลาแบบ "กระจาย" = เกิดตลอดช่วง = น่าจะเป็นปัญหาค้าง · "จุดเดียว" = เกิดก้อนเดียว = มักเป็นตอน restart)');
    out.push('');

    const show = all.filter((g) => g.n >= 2).slice(0, 20);
    for (const g of show) {
      out.push(`- [${g.c}] "${g.k}" × ${g.n}`);
      out.push(`    ช่วงเวลา ${g.first}–${g.last} (${g.first === g.last ? 'จุดเดียว' : 'กระจาย'})`);
      for (const s of g.samples) {
        const cl = s.replace(/\s+/g, ' ').trim();
        out.push(`    | ${cl.slice(0, 240)}${cl.length > 240 ? '…' : ''}`);
      }
    }
    const once = all.filter((g) => g.n < 2);
    if (once.length) {
      out.push(`- ...และเกิดครั้งเดียวอีก ${once.length} ประเภท จาก ${[...new Set(once.map((g) => g.c))].join(', ')}`);
    }
    if (!all.length) out.push('- ไม่พบเลย');
    out.push('');
  } catch (e) {
    out.push('## 4. เหตุการณ์น่าสงสัย');
    out.push(`- ดึงจาก Loki ไม่สำเร็จ: ${e.message}`);
    out.push('');
  }

  // ── 5. สถิติการตัด noise ──
  try {
    const t = await (await fetch(ALLOY_METRICS)).text();
    const pick = (name) => {
      const m = new RegExp(`^${name}\\{[^\\n]*?\\}\\s+([0-9.e+]+)`, 'm').exec(t);
      return m ? Number(m[1]) : 0;
    };
    const read = pick('loki_source_docker_target_entries_total');
    const sent = pick('loki_write_sent_entries_total');
    const drop = [...t.matchAll(/^loki_process_dropped_lines_total\{[^\n]*?\}\s+([0-9.e+]+)/gm)]
      .reduce((s, m) => s + Number(m[1]), 0);
    meta.drop = { read, drop, sent };
    out.push('## 5. สถิติการเก็บ log (Alloy)');
    if (read > 0) {
      out.push(`- อ่านจาก Docker ${Math.round(read).toLocaleString()} บรรทัด → ตัด noise ${Math.round(drop).toLocaleString()} (${((100 * drop) / read).toFixed(1)}%) → ส่งเข้า Loki ${Math.round(sent).toLocaleString()}`);
    } else {
      out.push('- ยังไม่มีตัวเลข (Alloy เพิ่งเริ่มทำงาน)');
    }
    out.push('');
  } catch {
    out.push('## 5. สถิติการเก็บ log');
    out.push('- อ่าน metrics ของ Alloy ไม่ได้');
    out.push('');
  }

  return { text: out.join('\n'), meta, window: w };
}

// ─────────────────────────────────────────────────────────────────────
//  เรียก LLM ผ่าน MiniMax API โดยตรง (Anthropic Messages API)
// ─────────────────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `คุณคือผู้เชี่ยวชาญ DevOps/SRE ที่วิเคราะห์ log ของระบบ Docker และ MongoDB replica set

หลักการที่ต้องยึด:
1. ยึดหลักฐานจากข้อมูลเท่านั้น ถ้าข้อมูลไม่พอสรุป ให้บอกว่า "ข้อมูลไม่พอ" และบอกว่าต้องดูอะไรเพิ่ม ห้ามเดา
2. แยก "ก้อนเดียว" ออกจาก "เรื่องค้าง" ให้ชัดเจน
   - เหตุการณ์ที่เกาะกลุ่มในช่วงเวลาสั้น ๆ (เช่นตอน restart/deploy) = ปกติ ไม่ต้องทำอะไร
   - เหตุการณ์ที่กระจายสม่ำเสมอตลอดช่วง = ปัญหาจริงที่ต้องตาม
3. ให้ความสำคัญกับผลกระทบต่อระบบ ไม่ใช่แค่ "log เยอะ"
4. ระบุสิ่งที่ปกติด้วย เพื่อไม่ให้ผู้ใช้กังวลเรื่องไม่จำเป็น
5. ทุกข้อสรุปต้องผูกกับหลักฐานที่เห็น (จำนวนครั้ง / เวลา / ชื่อ container) เสมอ
6. ถ้าเห็นว่าเป็น noise ของระบบ ให้บอกได้ว่าควรปิดที่ต้นทางหรือกรองทิ้ง

รูปแบบคำตอบ (ภาษาไทย ใช้ markdown):

## สรุป
2-3 บรรทัด ตอบตรงประเด็นว่าระบบสุขภาพดีแค่ไหน

## 🔴 ปัญหาที่ต้องแก้
รายการแบบ:
- **อาการ** → หลักฐาน (จำนวน/เวลา) → สาเหตุที่เป็นไปได้ → วิธีตรวจสอบ
ถ้าไม่มี ให้เขียนว่า "ไม่พบปัญหาที่ต้องแก้" และบอกว่าตรวจอะไรไปแล้ว

## 🟡 ข้อสังเกต
- สิ่งที่น่าจับตา แต่ยังไม่กระทบ (ถ้าไม่มีเขียนว่าไม่มี)

## ✅ สถานะปกติ
- สั้น ๆ

## 🔎 คำสั่งตรวจสอบเพิ่ม
- คำสั่ง LogQL หรือ shell ที่ผู้ใช้ควรรันต่อ (ใส่โค้ด block)`;

//  M3.1-Flash-Preview "คิดเสมอ" — ถ้าไม่จำกัด effort ค่าเริ่มต้นคือ max
//  ซึ่งกิน max_tokens ไปกับ thinking block เป็นส่วนใหญ่ แล้วไม่เหลือ token
//  ให้ตอบ → ได้ content ที่ไม่มี text block เลย
//  (เคยเจอจริง: max_tokens=8000 กับ digest 85 บรรทัด → คิดจนหมด แต่ API ตอบ 200)
//
//  max_tokens เป็น "เพดาน" ไม่ใช่ "เป้าหมาย" — วัดแล้วโมเดลหยุดเองทุกครั้ง
//  (เพดาน 32K/64K/128K/256K ใช้จริงเท่ากันหมด 16-26 token) ตั้งสูงไว้เลย
//  เพื่อไม่ให้ "เพดาน" กลายเป็นตัวจำกัดงานจริง ตัวกันความเสียหายจริง ๆ
//  คือ timeout ไม่ใช่ max_tokens
//
//  เพดานของ API = 524288 · เกินนี้ตอบ 400 "does not support max tokens > 524288"
const API_MAX_TOKENS = 524288;
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

/** ความยาวคำตอบที่ขอ — สูงพอไม่ให้เป็นข้อจำกัด แต่ไม่เกินเพดานของ API */
function pickMaxTokens(want) {
  const n = Number(want);
  if (!Number.isFinite(n) || n <= 0) return 262144; // 256K
  return Math.min(Math.floor(n), API_MAX_TOKENS);
}

async function askLLM({ prompt, model, maxTokens = 262144, effort = 'high', timeout = 300000 }) {
  const c = await loadCreds();

  if (!c.key) {
    const target = c.envFile || join(REPO_ROOT, '.env');
    throw new Error(
      `ยังไม่ได้ตั้ง MINIMAX_API_KEY\n\n` +
        `ใส่ในไฟล์นี้:\n` +
        `  ${target}\n\n` +
        `เพิ่มบรรทัดนี้ (เป็นบรรทัดเดียว):\n` +
        `  MINIMAX_API_KEY=<คีย์ของคุณ>\n\n` +
        `ไฟล์ .env ถูก .gitignore ไว้แล้ว คีย์จะไม่หลุดเข้า git\n` +
        `แก้แล้วรีสตาร์ท server (Ctrl+C แล้วรัน start.cmd ใหม่)\n\n` +
        `ระหว่างนี้ยังดูภาพรวมและเหตุการณ์น่าสงสัยได้ตามปกติ`
    );
  }
  if (!c.baseURL) {
    throw new Error('ไม่พบ baseURL — ตั้ง MINIMAX_BASE_URL ใน .env หรือปล่อยไว้ให้ใช้ค่าเริ่มต้น');
  }

  // โมเดลรุ่นเก่าไม่รู้จัก output_config — ส่งเฉพาะตอนเป็น M3.1
  const useEffort = EFFORTS.includes(effort) && /M3\.1/i.test(model);

  const url = `${c.baseURL}/messages`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);

  const payload = {
    model: model.split('/').pop(),
    max_tokens: maxTokens,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: prompt }],
  };
  if (useEffort) payload.output_config = { effort };

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': c.key,
        'anthropic-version': '2023-06-01',
      },
      signal: ctrl.signal,
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const body = (await res.text()).slice(0, 400);
      if (res.status === 401 || /token is required/i.test(body)) {
        throw new Error('MiniMax ตอบ 401 — MINIMAX_API_KEY ไม่ถูกต้องหรือหมดอายุ');
      }
      if (res.status === 429) throw new Error('ถูกจำกัดอัตรา (429) — รอสักครู่แล้วลองใหม่ หรือใช้โมเดลที่ช้าลงกว่า');
      if (res.status === 400 && /effort/i.test(body)) {
        throw new Error(`MiniMax ไม่รับ effort="${effort}" — ต้องเป็น ${EFFORTS.join(' / ')}`);
      }
      throw new Error(`MiniMax ตอบ ${res.status}: ${body}`);
    }

    const data = await res.json();
    const blocks = data.content || [];
    const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();

    if (!text) {
      // บอกให้ชัดว่าติดตรงไหน แทนที่จะบอกกว้าง ๆ ว่า content ว่าง
      const kinds = blocks.map((b) => b.type).join(', ') || '(ไม่มี block เลย)';
      const out = data.usage?.output_tokens ?? '?';
      const think = data.usage?.output_tokens_details?.thinking_tokens ?? '?';
      if (data.stop_reason === 'max_tokens') {
        throw new Error(
          `โมเดลคิดจนชนเพดาน ${maxTokens.toLocaleString()} token ยังไม่ได้ตอบ (stop_reason=max_tokens)\n` +
            `เพดานนี้สูงมากแล้ว (เพดานจริงของ API คือ ${API_MAX_TOKENS.toLocaleString()}) แปลว่าโมเดลคิดวนไม่จบ\n` +
            `แก้โดยลดระดับความคิดลง ตัด digest ให้เล็กลง (เลือกช่วงเวลาสั้นลง) หรือเปลี่ยนไปใช้ M3 / M2.7 ที่ไม่คิด`
        );
      }
      throw new Error(
        `MiniMax ไม่ได้ส่งคำตอบกลับ (stop_reason=${data.stop_reason}, block: ${kinds}, ใช้ ${out} token, คิดไป ${think} token)`
      );
    }

    const info = {
      effort: useEffort ? effort : null,
      stopReason: data.stop_reason,
      outputTokens: data.usage?.output_tokens ?? null,
      thinkingTokens: data.usage?.output_tokens_details?.thinking_tokens ?? null,
    };
    return { text, info };
  } catch (e) {
    if (e.name === 'AbortError') throw new Error(`MiniMax ไม่ตอบภายใน ${Math.round(timeout / 1000)} วินาที — ลองช่วงเวลาสั้นลงหรือโมเดลที่เร็วกว่า`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// ─────────────────────────────────────────────────────────────────────
//  รายชื่อโมเดล — อ่านจาก config.yaml (ต้องมีคีย์ถึงจะเรียกได้จริง
//  แต่รายชื่อโมเดลอ่านได้แม้ยังไม่มีคีย์ จึงแสดงใน dropdown ได้ตลอด)
// ─────────────────────────────────────────────────────────────────────
async function getModels() {
  const c = await loadCreds();
  if (c.models?.length) return c.models;
  return [
    { ref: 'minimax/MiniMax-M3.1-Flash-Preview', name: 'MiniMax M3.1 Flash (เร็ว · ตัวค่าเริ่มต้น)', isDefault: true },
    { ref: 'minimax/MiniMax-M3', name: 'MiniMax M3', isDefault: false },
  ];
}

/** เลือกโมเดล — ถ้าไม่ระบุ ใช้ defaultModel จาก config.yaml */
async function pickModel(want) {
  if (want) return want;
  const c = await loadCreds();
  const def = c.models?.find((m) => m.isDefault) || c.models?.[0];
  return def?.ref || 'minimax/MiniMax-M3.1-Flash-Preview';
}

// ─────────────────────────────────────────────────────────────────────
//  cache digest — ไม่ให้คิยรอ Loki นานเกินจำเป็น
// ─────────────────────────────────────────────────────────────────────
const digestCache = new Map();
const CACHE_TTL = 30000;

async function cachedDigest(key, opts) {
  const hit = digestCache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL) return hit.d;
  const d = await buildDigest(opts);
  digestCache.set(key, { at: Date.now(), d });
  if (digestCache.size > 40) digestCache.delete(digestCache.keys().next().value);
  return d;
}

// ─────────────────────────────────────────────────────────────────────
//  HTTP server
// ─────────────────────────────────────────────────────────────────────
function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  const p = url.pathname;

  try {
    if (p === '/' || p === '/index.html') {
      const html = await readFile(join(__dirname, 'index.html'));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(html);
    }

    // สถานะ dependency ของ UI
    if (p === '/api/status') {
      const [models, key, loki, docker] = await Promise.all([
        getModels().catch((e) => [{ ref: '', name: `อ่านรายชื่อโมเดลไม่สำเร็จ: ${e.message}` }]),
        keyState().catch((e) => ({ ok: false, via: 'error', error: e.message })),
        fetch(`${LOKI_URL}/ready`).then((r) => r.ok).catch(() => false),
        sh('docker', ['ps', '--format', '{{.Names}}'], { timeout: 15000 }).then((r) => r.code === 0),
      ]);
      return json(res, 200, { loki, docker, key, models, lokiUrl: LOKI_URL });
    }

    // digest ล้วน ๆ (ไม่ใช้ LLM — เร็ว ใช้ดูสด ๆ ได้)
    if (p === '/api/digest') {
      const since = url.searchParams.get('since') || '1h';
      const containers = url.searchParams.get('containers') || '';
      const d = await cachedDigest(`${since}|${containers}`, { since, containers: containers.split(',').filter(Boolean) });
      return json(res, 200, { text: d.text, meta: d.meta, since: d.window.mins });
    }

    // ให้ LLM วิเคราะห์
    if (p === '/api/analyze' && req.method === 'POST') {
      const body = await readBody(req);
      const since = body.since || '1h';
      const containers = Array.isArray(body.containers) ? body.containers : [];
      const model = await pickModel(body.model);
      const question = (body.question || '').trim();

      const d = await cachedDigest(`${since}|${containers.join(',')}`, { since, containers });

      const parts = ['นี่คือ digest log ของระบบ:', '', d.text, ''];
      if (question) parts.push('คำถามเพิ่มเติมจากผู้ใช้:', question);
      else parts.push('จงวิเคราะห์สถานะรวมของระบบตามรูปแบบที่กำหนด');

      const started = Date.now();
      const { text: analysis, info } = await askLLM({
        prompt: parts.join('\n'),
        model,
        effort: body.effort,
        maxTokens: pickMaxTokens(body.maxTokens),
      });
      return json(res, 200, { analysis, model, info, elapsedMs: Date.now() - started, digest: d.text, meta: d.meta });
    }

    // ถามต่อ (มีบทสนทนาเดิม + digest เป็นบริบท)
    if (p === '/api/ask' && req.method === 'POST') {
      const body = await readBody(req);
      const since = body.since || '1h';
      const containers = Array.isArray(body.containers) ? body.containers : [];
      const model = await pickModel(body.model);
      const question = (body.question || '').trim();
      if (!question) return json(res, 400, { error: 'ต้องมีคำถาม' });

      const d = await cachedDigest(`${since}|${containers.join(',')}`, { since, containers });
      const hist = (body.history || []).slice(-6);

      const lines = [
        'นี่คือ digest log ของระบบ (บริบทเดิม):',
        '',
        d.text,
        '',
        '--- บทสนทนาก่อนหน้า ---',
      ];
      for (const h of hist) lines.push(`${h.role === 'user' ? 'ผู้ใช้' : 'ผู้ช่วย'}: ${h.content}`);
      lines.push('', '--- คำถามใหม่ ---', question);
      lines.push('', 'ตอบเฉพาะคำถามนี้ สั้น ๆ และอ้างอิงหลักฐานจาก digest ข้างบน ถ้าข้อมูลไม่พอตอบว่าต้องดูอะไรเพิ่ม');

      const started = Date.now();
      const { text: answer, info } = await askLLM({
        prompt: lines.join('\n'),
        model,
        effort: body.effort,
        maxTokens: pickMaxTokens(body.maxTokens),
      });
      return json(res, 200, { answer, model, info, elapsedMs: Date.now() - started });
    }

    // ปรับรูปแบบ "น่าสงสัย" จาก UI ได้
    if (p === '/api/patterns' && req.method === 'POST') {
      const body = await readBody(req);
      if (body.pattern) SUSPECT = body.pattern;
      digestCache.clear();
      return json(res, 200, { ok: true, pattern: SUSPECT });
    }

    return json(res, 404, { error: 'ไม่พบเส้นทาง' });
  } catch (e) {
    return json(res, 500, { error: e.message || String(e) });
  }
});

function readBody(req) {
  return new Promise((resolve, reject) => {
    let s = '';
    req.on('data', (d) => {
      s += d;
      if (s.length > 1_000_000) reject(new Error('body ใหญ่เกินไป'));
    });
    req.on('end', () => {
      try {
        resolve(s ? JSON.parse(s) : {});
      } catch (e) {
        reject(new Error('JSON ไม่ถูกต้อง'));
      }
    });
    req.on('error', reject);
  });
}

server.listen(PORT, HOST, async () => {
  const k = await keyState().catch(() => ({ ok: false, via: 'error' }));
  const where =
    k.via === 'env' ? 'environment variable' : k.envFile ? k.envFile : 'ยังไม่ได้ตั้ง';

  console.log(`\n  Log Analyzer พร้อมใช้งาน`);
  console.log(`  →  http://${HOST}:${PORT}`);
  console.log(`\n  Loki        ${LOKI_URL}`);
  console.log(`  API key     ${k.ok ? `พบแล้ว (${where})` : 'ยังไม่ได้ตั้ง — ดูภาพรวมได้ แต่ใช้ AI ไม่ได้'}`);
  if (!k.ok) console.log(`              ใส่ MINIMAX_API_KEY ใน ${join(REPO_ROOT, '.env')} แล้วรีสตาร์ท`);
  console.log('');
});
