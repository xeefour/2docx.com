// ตรวจว่าไฟล์ env มีคีย์ MiniMax หรือยัง — พิมพ์ความยาวและ fingerprint เท่านั้น
//
// ⚠️ เคยพิมพ์คีย์จริง 6 ตัวแรก + 4 ตัวท้ายลง console
//    ซึ่งพอจะให้เดาคีย์ยาว 125 ตัวอักษรไม่ได้จริง แต่เป็นการรั่วโดยไม่จำเป็น
//    และผลของคำสั่งนี้มักถูกแปะลงในแชท/ล็อก → เปลี่ยนเป็น sha256 10 ตัวแรก
//
// 📁 ไฟล์ env ของโปรเจกต์รวมไว้ที่เดียว: dokploy-infra/.env (2026-10-06)
//    ถ้าสร้าง .env ในโฟลเดอร์อื่น ค่าจะไม่ถูกอ่าน และจะเห็นว่า "ไม่มีคีย์" ทั้งที่มี
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const files = ['dokploy-infra/.env', '.env'];
let found = false;

for (const f of files) {
  let s;
  try {
    s = readFileSync(f, 'utf8');
  } catch {
    console.log(f.padEnd(24), 'ไม่มีไฟล์');
    continue;
  }
  // ⚠️ ต้องตัด \r ก่อน regex ที่ลงท้ายด้วย $ — ไฟล์ CRLF จะทำให้ไม่ match
  const m = /^\s*MINIMAX_API_KEY\s*=\s*(.*)$/m.exec(s.replace(/\r/g, ''));
  if (!m) {
    const keys = s
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'))
      .map((l) => l.split('=')[0].trim());
    console.log(f.padEnd(24), `มีไฟล์ (${s.length} bytes) แต่ไม่มี MINIMAX_API_KEY | ตัวแปรที่มี ${keys.length} ตัว`);
    continue;
  }
  const v = m[1].trim().replace(/^["']|["']$/g, '');
  found = true;
  const fp = createHash('sha256').update(v).digest('hex').slice(0, 10);
  console.log(f.padEnd(24), `พบ MINIMAX_API_KEY · ยาว ${v.length} ตัวอักษร · sha256:${fp}`);
  if (v.length < 20) console.log('  ⚠️ สั้นผิดปกติ อาจเป็น placeholder');
}

console.log(found ? '\n✓ มีคีย์' : '\n✗ ยังไม่มีคีย์ในไฟล์ที่ server อ่าน');