# -*- coding: utf-8 -*-
"""
เปรียบเทียบฟอนต์ 3 ชุด ที่มีอยู่ในเครื่อง

  1. TH Sarabun New   — จาก GitHub (เก็บไว้ก่อนหน้า)
  2. TH Sarabun PSK   — จาก GitHub SarabunConsortium (เก็บไว้ก่อนหน้า)
  3. TH SarabunPSK    — จาก THSarabun.rar (ตัวใหม่)
  4. TH Niramit AS    — จาก THSarabun.rar

ต้องการรู้ว่าตัวที่ 2 กับ 3 ต่างกันแค่ไหน
"""
import os
from PIL import Image, ImageDraw, ImageFont

NEW = r"D:\2docx.com\tests\lib\fonts"
RAR = r"D:\2docx.com\tests\lib\fonts\_จากrar"

cands = [
    ("TH Sarabun New (github)",  os.path.join(NEW, "THSarabunNew.ttf")),
    ("TH Sarabun PSK (github)",  os.path.join(NEW, "THSarabunPSK Regular.ttf")),
    ("TH SarabunPSK (rar)",      None),  # หาโดยเดินโฟลเดอร์
    ("TH Niramit AS (rar)",      None),
]

def find_rar_exact(fname):
    """หาไฟล์แบบตรงชื่อเป๊ะ ไม่เอาไฟล์อื่นที่มีคำคล้าย"""
    for root, dirs, files in os.walk(RAR):
        if fname in files:
            return os.path.join(root, fname)
    return None

# เลือกชุดโฟลเดอร์ที่มีชื่อภาษาไทย (ไม่มีจุดกลาง)
cands[2] = ("TH SarabunPSK (rar)", find_rar_exact("THSarabunIT๙.ttf"))
cands[3] = ("TH Niramit AS (rar)", find_rar_exact("TH NiramitAS-IT๙.ttf"))
if not cands[3][1]:
    cands[3] = ("TH Niramit AS (rar)", find_rar_exact("TH NiramitIT๙.ttf"))

TEST = "หนังสือรับรอง เลขที่ ๘๕/๒๕๖๙ จังหวัดพิษณุโลก"

print("=" * 70)
print(" เปรียบเทียบฟอนต์")
print("=" * 70)

for label, path in cands:
    if not path or not os.path.exists(path):
        print(f"  {label:<26} ไม่พบไฟล์")
        continue
    f = ImageFont.truetype(path, 16)
    im = Image.new("L", (10, 10))
    d = ImageDraw.Draw(im)
    bb = d.textbbox((0, 0), TEST, font=f)
    fam, sty = f.getname()
    print(f"  {label}")
    print(f"    ไฟล์ : {os.path.basename(path)}")
    print(f"    ชื่อ : {fam!r} / {sty}")
    print(f"    ขนาด : สูง {bb[3]-bb[1]}px  กว้าง {bb[2]-bb[0]}px")
    print(f"    ขนาดไฟล์: {os.path.getsize(path):,} bytes")

# ---------- สร้างภาพเทียบ ----------
print()
print("=" * 70)

W = 1200
rowh = 140
rows = [(l, p) for l, p in cands if p and os.path.exists(p)]
H = rowh * len(rows) + 40
img = Image.new("RGB", (W, H), (255, 255, 255))
d = ImageDraw.Draw(img)

lbl_font = None
try:
    lbl_font = ImageFont.truetype(os.path.join(NEW, "THSarabunNew.ttf"), 12)
except Exception:
    pass

y = 20
for label, path in rows:
    f = ImageFont.truetype(path, 32)     # ขยายเป็น 32px เพื่อให้เห็นชัด
    d.text((20, y), label, font=lbl_font, fill=(150, 150, 150))
    d.text((20, y + 22), TEST, font=f, fill=(0, 0, 0))
    bb = d.textbbox((0, 0), TEST, font=f)
    d.line([(15, y + bb[3] + 8), (W - 15, y + bb[3] + 8)], fill=(220, 220, 220))
    # แสดงขนาดจริง
    d.text((W - 260, y + 22), f"สูง {bb[3]-bb[1]}px / กว้าง {bb[2]-bb[0]}px",
           font=lbl_font, fill=(150, 150, 150))
    y += rowh

out = r"D:\2docx.com\tools\font-compare-3sets.png"
img.save(out)
print(f"บันทึกภาพเทียบ: {out}")
