#!/bin/sh
# ── จุดเริ่ม gateway ────────────────────────────────────────────────
# ข้อเหตุผลที่มีไฟล์นี้: Caddy บังคับให้ basic_auth ใช้ "bcrypt hash"
#   ไม่รับรหัสผ่านธรรมดา แต่ hash เก็บกลับไม่ได้ (ทางเดียว) = ผู้ใช้อ่านไม่รู้ว่าตั้งอะไรไว้
#   วิธีนี้จึงเก็บ "รหัสผ่านธรรมดา" ใน .env ให้อ่านและแก้ได้ตามใจ
#   แล้วค่อยแปลงเป็น hash ตอน container เริ่มทำงานทุกครั้ง
#
# ⚠️ ไฟล์นี้ต้องเป็น LF เท่านั้น — ถ้าเป็น CRLF บusybox sh จะหา /bin/sh\r ไม่เจอ
#
# ค่าที่อ่าน:
#   ANALYZE_AUTH_USER      ชื่อผู้ใช้ (ค่าเริ่มต้น ops)
#   ANALYZE_AUTH_PASSWORD  รหัสผ่านธรรมดา — อ่านได้จาก .env เท่านั้น

set -e

SRC="/etc/caddy/Caddyfile"
OUT="/tmp/Caddyfile"
PLACEHOLDER="ANALYZE_HASH_PLACEHOLDER"

if [ -z "${ANALYZE_AUTH_PASSWORD:-}" ]; then
  echo "[gateway] ไม่ได้ตั้ง ANALYZE_AUTH_PASSWORD — ปฏิเสธจะขึ้น ไม่ได้เปิดหน้า /analyze ทิ้งไว้" >&2
  echo "[gateway] ใส่ใน dokploy-infra/.env แล้วสั่ง up -d gateway ใหม่" >&2
  exit 1
fi

# bcrypt ใช้เวลาประมาณวินาทีเดียว (cost 14) — ยอมได้เพราะทำตอน start ครั้งเดียว
HASH="$(caddy hash-password --plaintext "$ANALYZE_AUTH_PASSWORD")"

if [ -z "$HASH" ]; then
  echo "[gateway] สร้าง hash ไม่สำเร็จ" >&2
  exit 1
fi

# แทน placeholder ด้วย hash
# ปลอดภัย: bcrypt ใช้ตัวอักษร ./A-Za-z0-9 เท่านั้น ไม่มี & หรือ \ ที่ sed จะตีความ
sed "s|${PLACEHOLDER}|${HASH}|" "$SRC" > "$OUT"

# เขียน log ว่าใช้ hash ของผู้ใช้ไหน (ไม่เขียนรหัสผ่าน)
echo "[gateway] /analyze ล็อกด้วย basic_auth ผู้ใช้ '${ANALYZE_AUTH_USER:-ops}'"

exec caddy run --config "$OUT" --adapter caddyfile "$@"