// ทดสอบว่าคีย์ใช้ได้กับโมเดลไหนบ้าง — ยิงข้อความสั้น ๆ ไปโมเดลละตัว
import { readFileSync } from 'node:fs';

const env = Object.fromEntries(
  readFileSync('.env', 'utf8')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => {
      const i = l.indexOf('=');
      return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')];
    })
);

const KEY = env.MINIMAX_API_KEY;
const URL = (env.MINIMAX_BASE_URL || 'https://api.minimax.io/anthropic/v1') + '/messages';

const MODELS = ['MiniMax-M3.1-Flash-Preview', 'MiniMax-M3', 'MiniMax-M2.7'];

for (const model of MODELS) {
  const t0 = Date.now();
  try {
    const r = await fetch(URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model,
        max_tokens: 64,
        messages: [{ role: 'user', content: 'ตอบว่า OK ถ้าอ่านข้อความนี้ได้' }],
      }),
    });
    const body = await r.text();
    const ms = Date.now() - t0;

    if (!r.ok) {
      console.log(`✗ ${model.padEnd(26)} HTTP ${r.status} (${ms}ms) ${body.slice(0, 220)}`);
      continue;
    }
    const d = JSON.parse(body);
    const text = (d.content || [])
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('')
      .replace(/\s+/g, ' ')
      .trim();
    console.log(`✓ ${model.padEnd(26)} HTTP 200 (${ms}ms) · ${d.usage?.output_tokens ?? '?'} tok · "${text.slice(0, 80)}"`);
  } catch (e) {
    console.log(`✗ ${model.padEnd(26)} ${e.message}`);
  }
}
