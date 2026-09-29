# -*- coding: utf-8 -*-
"""ตรวจผลส่วนที่ 4: รูปภาพ (หลังฉีดรูปและแปลง PDF แล้ว)"""
import os, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "lib"))
from helper import (Checker, docx_pic_descrs, docx_image_checksums,
                    pdf_header, pdf_has_font, pdf_thai_chars,
                    pdf_to_png, pdf_pages)

DOCX = os.path.join(HERE, "output", "ฉีดรูป.docx")
PDF  = os.path.join(HERE, "output", "รูปภาพ-ผลลัพธ์.pdf")

c = Checker()
descrs = docx_pic_descrs(DOCX)
sums = docx_image_checksums(DOCX)

c.section("4.1 รูปเดี่ยว")
c.ck("ตราสัญลักษณ์" in descrs, "ช่องรูปเดี่ยวยังอยู่ (ฉีดสำเร็จ)")

c.section("4.2 หลายรูปในช่องเดียว")
multi = [d for d in descrs if d.startswith("หลักฐานหลายรูป")]
c.ck(len(multi) == 3, f"ได้ {len(multi)} รูป (ต้องการ 3)", f"ได้ {len(multi)}")

c.section("4.3 รูปในตาราง")
c.ck("ภาพในตาราง" in descrs, "รูปในตารางยังอยู่")

c.section("4.4 ซ่อนแถวที่ไม่มีรูป")
c.ck("ภาพแถว1" in descrs, "แถวที่มีรูป ยังอยู่")
c.ck(not any("ภาพแถว2" in d for d in descrs), "แถวที่ไม่มีรูป ถูกซ่อน")

c.section("4.5 ลบรูปที่ไม่ต้องการ")
c.ck(not any("รูปที่ไม่ต้องการ" in d for d in descrs), "รูปที่ไม่ต้องการ ถูกลบ")

c.section("4.6 รูปแยกส่วนกันจริง (กันบั๊กรูปซ้ำ)")
uniq = len(set(sums.values()))
c.ck(uniq >= 3, f"รูปมี checksum ต่างกัน {uniq} ค่า", "น้อยกว่า 3 — รูปอาจชนกัน")
print(f"  ไฟล์รูป {len(sums)} ไฟล์ / ต่างกัน {uniq} ค่า")
for n, h in sorted(sums.items()):
    print(f"    {n:<30} {h}")

c.section("4.7 แปลงเป็น PDF ได้")
c.ck(pdf_header(PDF).startswith("%PDF-"), "PDF มีโครงสร้างถูกต้อง")
c.ck(pdf_has_font(PDF, "THSarabunNew", "TH+SarabunNew"), "ฝังฟอนต์ไทย")
thai = pdf_thai_chars(PDF)
c.ck(thai > 50, f"อ่านอักษรไทยได้ {thai} ตัว")
pg = pdf_pages(PDF)
c.ck(pg > 0, f"PDF มี {pg} หน้า")

made, _ = pdf_to_png(PDF, os.path.join(HERE, "output"), "รูปภาพ", max_pages=1)
if made:
    print(f"\nภาพ: {made[0]}")

c.report()
