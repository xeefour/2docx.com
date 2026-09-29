# -*- coding: utf-8 -*-
"""
วัด "การกระจายย่อหน้า" จาก PDF จริง

หลักการ: ถ้าย่อหน้าถูกกระจาย ระยะห่างระหว่างคำที่ปลายบรรทัด
กับขอบขวาของกระดาษ จะน้อยมาก (ถ้ากระจายทั้งบรรทัด)
ถ้าเป็นชิดซ้าย ระยะว่างขวาจะเป็นศูนย์ (ข้อความจบที่ขอบซ้าย)

วิธีวัด: ดึงตำแหน่งของแต่ละคำ (bbox) จาก PDF แล้วดูว่า
  - คำสุดท้ายของบรรทัดอยู่ใกล้ขอบขวาแค่ไหน
  - คำทั้งหมดกระจายเต็มความกว้างหรือไม่
"""
import os, sys, fitz, statistics

PDF = sys.argv[1] if len(sys.argv) > 1 else None
LABEL = sys.argv[2] if len(sys.argv) > 2 else ""

if not PDF:
    print("ใช้: python measure_align.py <ไฟล์.pdf> [ป้ายกำกับ]")
    sys.exit(1)

doc = fitz.open(PDF)
page = doc[0]
W, H = page.rect.width, page.rect.height
# ขอบกระดาษ (จากต้นฉบับ: ซ้าย 3.0 ซม. = 85 จุด, ขวา 2.0 ซม. = 57 จุด)
LEFT = 3.0 * 28.35
RIGHT = W - 2.0 * 28.35
TEXT_W = RIGHT - LEFT

print("=" * 68)
print(f" การวัดการกระจายย่อหน้า {LABEL}")
print("=" * 68)
print(f"ไฟล์: {os.path.basename(PDF)}")
print(f"หน้า: {len(doc)} | ขนาด: {W:.0f} x {H:.0f} จุด")
print(f"ขอบซ้าย: {LEFT:.0f} | ขอบขวา: {RIGHT:.0f} | ความกว้างข้อความ: {TEXT_W:.0f} จุด")
print()

# ดึงทุกคำที่อยู่ในช่วงเนื้อหาหลัก (y ระหว่าง 200-450 โดยประมาณ)
words = page.get_text("words")  # x0, y0, x1, y1, word, block, line, wordno
content = [w for w in words if w[4].strip()]

# จัดกลุ่มเป็นบรรทัด
lines = {}
for w in content:
    key = round(w[1] / 6)  # จัดกลุ่มบรรทัดด้วย y
    lines.setdefault(key, []).append(w)
lines = sorted(lines.items())

print(f"พบ {len(lines)} บรรทัด")
print()
print(f"{'บรรทัด':>6} {'x เริ่ม':>8} {'x จบ':>8} {'กว้าง':>8} "
      f"{'เหลือขวา':>9} {'%เต็ม':>7}  ข้อความ")
print("-" * 68)

gaps = []
for idx, (key, ws) in enumerate(lines):
    ws = sorted(ws, key=lambda w: w[0])
    x0 = min(w[0] for w in ws)
    x1 = max(w[2] for w in ws)
    width = x1 - x0
    right_gap = RIGHT - x1
    fill = (x1 - LEFT) / TEXT_W * 100
    text = " ".join(w[4] for w in ws)[:34]
    marker = ""
    # ถ้าขยายเกือบเต็มขอบขวา = กระจาย
    if right_gap < 12:
        marker = "  <- เต็มขอบขวา"
        gaps.append(right_gap)
    print(f"{idx:>6} {x0:>8.1f} {x1:>8.1f} {width:>8.1f} "
          f"{right_gap:>9.1f} {fill:>6.1f}%  {text}{marker}")

print()
print("=" * 68)
if gaps:
    print(f" บรรทัดที่ยืดเต็มขอบขวา: {len(gaps)} บรรทัด")
    print(f" ระยะเหลือขวาเฉลี่ย: {statistics.mean(gaps):.1f} จุด")
    print(" -> ย่อหน้านี้ถูกกระจาย (justify/distribute)")
else:
    print(" ไม่พบบรรทัดที่ยืดเต็มขอบขวา")
    print(" -> ย่อหน้าไม่ถูกกระจาย (ชิดซ้าย)")
print("=" * 68)

# บันทึกภาพ
png = PDF.replace(".pdf", "-measure.png")
page.get_pixmap(dpi=110).save(png)
print(f"\nภาพ: {png}")
