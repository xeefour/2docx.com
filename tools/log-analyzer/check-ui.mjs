// ตรวจหน้าเว็บที่ server เสิร์ฟจริง — ยืนยันว่าข้อความตั้งคีย์ชี้ไปที่ .env ของโปรเจกต์
const html = await (await fetch('http://127.0.0.1:3110/')).text();

const checks = [
  ['ข้อความตั้งคีย์ในหน้าเว็บ', /MINIMAX_API_KEY/],
  ['ชี้ไปที่ envPath (ไฟล์ที่ server เจอจริง)', /id="envPath"/],
  // จับได้ทั้งแบบ \ และ / — เคยพลาดตอนมีแต่รูปแบบ backslash
  ['ไม่มีการอ้าง ~/.minimax/config.yaml เป็นทางตั้งคีย์', (s) => !/\.minimax[\\/]config\.yaml/.test(s)],
  ['ไม่มีการอ้าง llm_call.py', (s) => !s.includes('llm_call')],
  ['ไม่มี element cfgPath ที่ค้างอยู่', (s) => !s.includes('cfgPath')],
  ['ไม่มีการอ้าง s.configPath ใน JS', (s) => !s.includes('configPath')],
  ['footer บอกว่าอ่าน key จาก .env', /API key อยู่ใน <code>\.env<\/code>/],
  ['มีตัวเลือกระดับความคิด (effort)', /<select id="effort"/],
  ['มีตัวเลือกครบทั้ง 5 ระดับ', (s) => (s.match(/<option value="(low|medium|high|xhigh|max)"/g) || []).length === 5],
  ['ส่ง effort ไปกับ /api/analyze', (s) => /effort: \$\('#effort'\)\.value/.test(s)],
  ['ส่ง effort ไปกับ /api/ask', (s) => (s.match(/effort: \$\('#effort'\)\.value/g) || []).length === 2],
  ['แสดงจำนวน token ที่โมเดลใช้', (s) => s.includes('function tokNote')],
  ['มีค่าเริ่มต้น effort = high', (s) => /<option value="high" selected>/.test(s)],
];

let fail = 0;
for (const [label, t] of checks) {
  const ok = typeof t === 'function' ? t(html) : t.test(html);
  if (!ok) fail++;
  console.log((ok ? '  PASS  ' : '  FAIL  ') + label);
}

// ย่อหน้าคำเตือนที่ผู้ใช้จะเห็นจริง
const start = html.indexOf('<div id="keyWarn"');
const end = html.indexOf('<!-- ── controls ── -->');
if (start >= 0 && end > start) {
  console.log('\n--- ข้อความที่ผู้ใช้เห็นตอนยังไม่มีคีย์ ---');
  console.log(
    html
      .slice(start, end)
      .replace(/<[^>]+>/g, ' ')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/[ \t]+/g, ' ')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .join('\n')
  );
}

console.log(fail === 0 ? '\nผ่านทั้งหมด' : `\nมี ${fail} ข้อที่ไม่ผ่าน`);
process.exit(fail === 0 ? 0 : 1);
