# -*- coding: utf-8 -*-
"""
ตรวจผลส่วนที่ 2: ข้อความภาษาไทย
อ่านผลจาก output/ข้อความไทย-ผลลัพธ์.docx เทียบกับ data/ข้อมูล.json
"""
import os, sys, json
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "lib"))
from helper import (Checker, docx_text, docx_nospace, contains, contains_ns,
                    pdf_header, pdf_has_font, pdf_thai_chars,
                    pdf_to_png, pdf_pages)

DOCX = os.path.join(HERE, "output", "ข้อความไทย-ผลลัพธ์.docx")
PDF  = os.path.join(HERE, "output", "ข้อความไทย-ผลลัพธ์.pdf")
DATA = os.path.join(HERE, "data", "ข้อมูล.json")

c = Checker()
data = json.load(open(DATA, encoding="utf-8"))
text = docx_text(DOCX)
ns = docx_nospace(DOCX)

# --- 2.1 ข้อความปกติ ---
c.section("2.1 แทนค่าข้อความปกติ")
for k in ["ชื่อผู้ร้องเรียน", "ที่อยู่", "เรื่อง", "จังหวัด", "ชื่อระบบ"]:
    c.ck(contains(text, ns, data[k]), f"แทนค่า {k}", f"ไม่พบ '{data[k][:30]}'")

# --- 2.2 กับดัก: ไม่มี d. ---
c.section("2.2 แท็กที่ลืมใส่ d. (ต้องไม่ถูกแทน)")
c.ck("{จังหวัด}" in ns, "แท็กไม่มี d. ยังอยู่ในเอกสาร (ถูกต้องตามที่คาด)")
c.ck("ถูกต้อง:ชลบุรี" in ns, "แท็กมี d. ถูกแทนค่า")

# --- 2.3 อักษรพิเศษ ---
c.section("2.3 อักษรไทยพิเศษและสระวรรณยุกต์")
for ch in ["ญ", "ฏ", "ฐ", "ศ", "ษ", "ฬ"]:
    c.ck(ch in text, f"อักษร {ch}")
for ch in ["ๆ", "ฯ", "ๅ", "็", "่", "้", "๊", "๋", "์"]:
    c.ck(ch in text, f"สระ/เครื่องหมาย {ch}")
c.ck("ก้าวหน้าเข้าสู่โลกดิจิทัล" in ns, "ประโยคไทยที่มีสระซ้อนกัน")

# --- 2.4 ตัวเลขไทย ---
c.section("2.4 ตัวเลขไทย")
c.ck(all(d in text for d in "๐๑๒๓๔๕๖๗๘๙"), "เลขไทยครบ 10 ตัว")
c.ck("๑๒,๓๔๕.๖๗" in ns, "เลขไทยมีจุลภาค")
c.ck("1234" in text, "เลขอารบิก")

# --- 2.5 ข้อความยาว ---
c.section("2.5 ข้อความยาวหลายบรรทัด")
c.ck(len(data["ความคิดเห็น"]) > 100, "ข้อมูลต้นทางยาวเกิน 100 ตัวอักษร")
# ใช้ contains_ns เพราะ Word เก็บการเว้นวรรคไว้คนละจุดกับ JSON
c.ck(contains_ns(ns, data["ความคิดเห็น"]), "ข้อความยาวถูกแทนครบถ้วน")

# --- 2.6 ค่าที่ไม่มี ---
c.section("2.6 ค่าที่ไม่มีในข้อมูล")
c.ck("{d.ไม่มีค่านี้}" not in ns, "ไม่มีแท็กค้าง")
c.ck("ผลลัพธ์:[]" in ns, "แทนเป็นค่าว่าง")

# --- 2.7 ค่าบูล ---
c.section("2.7 ค่าบูล")
c.ck(data["เร่งด่วน"] is True, "ข้อมูลต้นทางเป็น true")
c.ck("true" in ns or "จริง" in ns, "ค่าบูลถูกแทนเป็นข้อความ")

# --- 2.8 อังกฤษผสม ---
c.section("2.8 อังกฤษผสม")
c.ck("test@example.com" in text, "อีเมล")
c.ck("Ref.No.1234/2569" in ns, "เลขอ้างอิงแบบอังกฤษ")

# --- 2.9 ฟอนต์ใน PDF ---
c.section("2.9 ฟอนต์ใน PDF")
c.ck(pdf_header(PDF).startswith("%PDF-"), "PDF มีโครงสร้างถูกต้อง")
c.ck(pdf_has_font(PDF, "THSarabunNew", "TH+SarabunNew"),
     "ฝังฟอนต์ TH Sarabun New", "ไม่พบ")
thai = pdf_thai_chars(PDF)
c.ck(thai > 100, f"อ่านอักษรไทยจาก PDF ได้ {thai} ตัว", "น้อยเกินไป")
pg = pdf_pages(PDF)
c.ck(pg > 0, f"PDF มี {pg} หน้า")

# --- สร้างภาพ ---
made, _ = pdf_to_png(PDF, os.path.join(HERE, "output"), "ข้อความไทย", max_pages=1)
if made:
    print(f"สร้างภาพตรวจสอบ: {made[0]}")

c.report()
