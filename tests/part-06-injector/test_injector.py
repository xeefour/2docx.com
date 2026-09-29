# -*- coding: utf-8 -*-
"""
ตัวฉีดรูป (ส่วนที่ 6) — ไม่ต้องใช้ Docker
=======================================
ตัวฉีดรูปทำงานบนไฟล์ .docx โดยตรง ไม่ต้องผ่าน Carbone เลย
ใช้ทดสอบตรรกะของตัวฉีดรูปล้วน ๆ

  6.1  พบช่องรูปในแม่แบบ
  6.2  แทนที่รูปเดี่ยว
  6.3  แทรกหลายรูปในช่องเดียว
  6.4  แทนที่รูปในตาราง
  6.5  ซ่อนแถวที่ไม่มีรูป
  6.6  ลบรูปที่ไม่ต้องการ
  6.7  รูปแยกส่วนกันจริง (checksum ต่างกัน)
  6.8  ย่อขนาดโดยคงอัตราส่วน
  6.9  รองรับรูปจาก base64

รัน:  python test_injector.py
"""
import os, sys, base64, json

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "lib"))

from helper import (Checker, docx_pic_descrs, docx_image_checksums,
                    docx_count, docx_text)
from docx_image_injector import ImageInjector

TPL = os.path.join(HERE, "..", "part-04-images", "templates", "รูปภาพ.docx")
DATA = os.path.join(HERE, "..", "part-04-images", "data", "ข้อมูล.json")
TPL = os.path.normpath(TPL)
DATA = os.path.normpath(DATA)
OUTD = os.path.join(HERE, "output")
os.makedirs(OUTD, exist_ok=True)
OUT = os.path.join(OUTD, "ฉีดรูป-ผลลัพธ์.docx")

c = Checker()

# ใช้แม่แบบจากส่วนที่ 4 ถ้ามี ไม่งั้นสร้างใหม่
if not os.path.exists(TPL):
    import subprocess
    r = subprocess.run([sys.executable,
                        os.path.join(HERE, "..", "part-04-images", "make.py")],
                       capture_output=True, text=True, encoding="utf-8")
    print((r.stdout or "").strip())
    if r.returncode != 0:
        print((r.stderr or "").strip()[:300])
    if not os.path.exists(TPL):
        print("สร้างแม่แบบไม่สำเร็จ")
        sys.exit(1)

data = json.load(open(DATA, encoding="utf-8"))

# ---------------- 6.1 พบช่องรูป ----------------
c.section("6.1 พบช่องรูปในแม่แบบ")
base_descrs = docx_pic_descrs(TPL)
expected = ["ตราสัญลักษณ์", "หลักฐานหลายรูป", "ภาพในตาราง",
            "ภาพแถว1", "ภาพแถว2", "รูปที่ไม่ต้องการ"]
for e in expected:
    c.ck(e in base_descrs, f"พบช่อง: {e}")
c.ck(len(base_descrs) == 6, f"พบทั้งหมด {len(base_descrs)} ช่อง", "คาดว่า 6")

# ---------------- ฉีดรูป ----------------
inj = ImageInjector(TPL, fit="contain")
inj.set("ตราสัญลักษณ์", data["ตราสัญลักษณ์"])                    # 4.1 / 6.2
inj.set_many("หลักฐานหลายรูป", data["หลักฐานหลายรูป"])        # 4.2 / 6.3
inj.set("ภาพในตาราง", data["ภาพในตาราง"])                       # 4.3 / 6.4
inj.set("ภาพแถว1", data["ภาพแถว1"])                            # 6.4
inj.run()                                     # ปิดชั่วคราวเพื่อซ่อนแถว
inj.hide_row("ภาพแถว2", data["ภาพแถว2"])                       # 4.4 / 6.5
inj.remove("รูปที่ไม่ต้องการ")                                # 4.5 / 6.6
inj.save(OUT)

c.section("ผลการทำงาน")
for line in inj.log:
    print("  " + line)

# ---------------- ตรวจผล ----------------
descrs = docx_pic_descrs(OUT)
sums = docx_image_checksums(OUT)
xml = docx_text(OUT)

c.section("6.2 ถึง 6.6 ผลลัพธ์")
c.ck("ตราสัญลักษณ์" in descrs, "6.2 รูปเดี่ยวถูกแทนที่")

multi = [d for d in descrs if d.startswith("หลักฐานหลายรูป")]
c.ck(len(multi) == 3, f"6.3 หลายรูปในช่องเดียว (ได้ {len(multi)}/3)",
     f"ได้ {len(multi)} รูป")
c.ck("ภาพในตาราง" in descrs, "6.4 รูปในตารางถูกแทนที่")
c.ck("ภาพแถว1" in descrs, "6.4 แถวที่มีรูปยังอยู่")
c.ck(not any("ภาพแถว2" in d for d in descrs), "6.5 แถวที่ไม่มีรูปถูกซ่อน")
c.ck(not any("รูปที่ไม่ต้องการ" in d for d in descrs), "6.6 รูปที่ไม่ต้องการถูกลบ")

# ---------------- 6.7 รูปแยกส่วน ----------------
c.section("6.7 รูปแยกส่วนกันจริง (กันบั๊กรูปซ้ำ)")
uniq = len(set(sums.values()))
c.ck(uniq >= 3, f"รูปมี checksum ต่างกัน {uniq} ค่า", "น้อยกว่า 3 — อาจชนกัน")
print(f"  ไฟล์รูป {len(sums)} ไฟล์ / checksum ต่างกัน {uniq} ค่า")
for n, h in sorted(sums.items()):
    print(f"    {n:<28} {h}")

# ---------------- 6.8 ขนาดรูป ----------------
c.section("6.8 ย่อขนาดโดยคงอัดส่วน")
import re
from helper import docx_xml
extents = re.findall(r'<wp:extent cx="(\d+)" cy="(\d+)"', docx_xml(OUT))
ratios = [int(cx) / int(cy) for cx, cy in extents if int(cy) > 0]
c.ck(len(ratios) >= 5, f"พบรูป {len(ratios)} รูปพร้อมขนาด")
square = [r for r in ratios if abs(r - 1) < 0.05]
wide = [r for r in ratios if abs(r - 500 / 340) < 0.08]
c.ck(len(square) >= 1, f"6.8 รูปสี่เหลี่ยมถูกย่อเป็น 1:1 ({len(square)} รูป)")
c.ck(len(wide) >= 1, f"6.8 รูป 3:2 ถูกย่อเป็น 3:2 ({len(wide)} รูป)")

# ---------------- 6.9 base64 ----------------
c.section("6.9 รองรับรูปจาก base64")
from docx_image_injector import load_image
p2 = data["หลักฐานหลายรูป"][1]
c.ck(str(p2).startswith("data:image/"), "ข้อมูลมี base64 data URI")
blob = load_image(p2)
c.ck(blob and len(blob) > 100, f"ถอด base64 ได้ {len(blob) if blob else 0} bytes")
c.ck(load_image(None) is None, "ค่าว่าง (None) คืนค่า None ไม่ error")
c.ck(load_image("") is None, "สตริงว่างคืนค่า None ไม่ error")

# ---------------- สรุปไฟล์ ----------------
c.section("ไฟล์ผลลัพธ์")
c.ck(os.path.exists(OUT), "บันทึกไฟล์ได้")
c.ck(os.path.getsize(OUT) > 10000, f"ขนาด {os.path.getsize(OUT):,} bytes")
print(f"\nผลลัพธ์: {OUT}")
print("เปิดด้วย Word หรือ LibreOffice ได้ทันที (ไม่ต้องผ่าน Carbone)")

c.report()
