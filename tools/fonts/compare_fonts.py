# -*- coding: utf-8 -*-
"""
เปรียบเทียบฟอนต์ TH Sarabun New กับ PSK
เพื่อดูว่าใช้แทนกันได้หรือไม่ (หน้าตาเหมือนกันแค่ไหน)
"""
import os
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

# ดู tools/fonts/README.md — path ทั้งหมดคำนวณจากตำแหน่งไฟล์นี้
REPO = Path(__file__).resolve().parent.parent.parent
D = str(REPO / "tests" / "lib" / "fonts")
TEST = "หนังสือรับรอง เลขที่ ๘๕/๒๕๖๙ จังหวัดพิษณุโลก"

fonts = [
    ("TH Sarabun New", os.path.join(D, "THSarabunNew.ttf")),
    ("TH Sarabun PSK", os.path.join(D, "THSarabunPSK Regular.ttf")),
    ("TH Sarabun PSK Bold", os.path.join(D, "THSarabunPSK Bold.ttf")),
    ("TH Sarabun New Bold", os.path.join(D, "THSarabunNew Bold.ttf")),
]

W, H = 1100, 130 * len(fonts) + 60
img = Image.new("RGB", (W, H), (255, 255, 255))
d = ImageDraw.Draw(img)

y = 30
for name, path in fonts:
    try:
        f = ImageFont.truetype(path, 16)  # 16pt
    except Exception as e:
        d.text((20, y), f"{name}: โหลดไม่ได้ ({e})", fill=(200, 0, 0))
        y += 120
        continue
    bb = d.textbbox((0, 0), TEST, font=f)
    d.text((20, y - 18), name, font=ImageFont.truetype(
        os.path.join(D, "THSarabunNew.ttf"), 11), fill=(120, 120, 120))
    d.text((20, y), TEST, font=f, fill=(0, 0, 0))
    # วาดเส้นฐานเพื่อเทียบความสูง
    d.line([(15, y + bb[3] + 2), (W - 15, y + bb[3] + 2)], fill=(220, 220, 220))
    print(f"{name:<24} ความสูงข้อความ {bb[3]-bb[1]:>3}px  "
          f"กว้าง {bb[2]-bb[0]:>4}px")
    y += 120

out = str(REPO / "tools" / "fonts" / "font-compare.png")
img.save(out)
print(f"\nบันทึกภาพเทียบ: {out}")
