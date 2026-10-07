// โมเดลยอมรับ max_tokens สูงสุดเท่าไหร่ และการเพิ่มมันมีผลจริงไหม
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

const URL = (env.MINIMAX_BASE_URL || 'https://api.minimax.io/anthropic/v1') + '/messages';
const PROMPT = 'ตอบว่า OK สั้นที่สุด';

// ค่าเดียวกันทุกครั้ง เปลี่ยนแค่ max_tokens
for (const maxTokens of [32000, 65536, 131072, 262144, 1048576]) {
  const t0 = Date.now();
  try {
    const r = await fetch(URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': env.MINIMAX_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'MiniMax-M3.1-Flash-Preview',
        max_tokens: maxTokens,
        output_config: { effort: 'high' },
        messages: [{ role: 'user', content: PROMPT }],
      }),
    });
    const raw = await r.text();
    const ms = Date.now() - t0;

    if (!r.ok) {
      console.log(
        `max_tokens=${String(maxTokens).padStart(8)} → HTTP ${r.status} (${ms}ms)  ${raw.slice(0, 180)}`
      );
      continue;
    }
    const d = JSON.parse(raw);
    console.log(
      `max_tokens=${String(maxTokens).padStart(8)} → HTTP 200 (${ms}ms) · ใช้จริง ${d.usage?.output_tokens} tok · stop=${d.stop_reason}`
    );
  } catch (e) {
    console.log(`max_tokens=${String(maxTokens).padStart(8)} → ${e.message}`);
  }
}
