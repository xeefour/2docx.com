# -*- coding: utf-8 -*-
"""ตรวจผลส่วนที่ 3: ตารางซ้ำและเงื่อนไข"""
import os, sys, re, json
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "lib"))
from helper import (Checker, docx_text, docx_nospace, contains_ns,
                    docx_count, pdf_header, pdf_to_png, pdf_pages)

DOCX = os.path.join(HERE, "output", "ตารางและเงื่อนไข-ผลลัพธ์.docx")
PDF  = os.path.join(HERE, "output", "ตารางและเงื่อนไข-ผลลัพธ์.pdf")
DATA = os.path.join(HERE, "data", "ข้อมูล.json")

c = Checker()
data = json.load(open(DATA, encoding="utf-8"))
ns = docx_nospace(DOCX)
text = docx_text(DOCX)

# --- 3.1 ตารางซ้ำ ---
c.section("3.1 ตารางซ้ำ")
c.ck(len(data["items"]) == 3, "ข้อมูลต้นทางมี 3 รายการ")
for it in data["items"]:
    c.ck(contains_ns(ns, it["รายการ"]), f"แถว: {it['รายการ'][:30]}")
    c.ck(it["ลำดับ"] in ns, f"เลขลำดับ {it['ลำดับ']}")
    c.ck(contains_ns(ns, it["จำนวน"]), f"จำนวน: {it['จำนวน']}")
c.ck("{d.items[i]}" not in ns, "ไม่มีแท็กวน [i] ค้าง")
c.ck("{d.items[i+1]}" not in ns, "ไม่มีแท็กวน [i+1] ค้าง")

# --- 3.2 อาร์เรย์ว่าง ---
c.section("3.2 ตารางที่ไม่มีข้อมูล")
c.ck(data["รายการว่าง"] == [], "ข้อมูลต้นทางเป็นอาร์เรย์ว่าง")
c.ck("{d.รายการว่าง[i]" not in ns, "แถว [i] ถูกลบ")
c.ck("{d.รายการว่าง[i+1]}" not in ns, "แถว [i+1] ถูกลบ")

# --- 3.3 / 3.4 เงื่อนไข ---
c.section("3.3 และ 3.4 เงื่อนไข")
c.ck(data["เร่งด่วน"] is True, "ข้อมูล: เร่งด่วน = true")
c.ck(data["ปกติ"] is False, "ข้อมูล: ปกติ = false")
c.ck("แสดงเพราะเร่งด่วนเป็นจริง" in ns, "เงื่อนไขจริง → แสดงข้อความ")
c.ck("แสดงเพราะปกติเป็นเท็จ" in ns, "เงื่อนไขเท็จ → ใช้ elseShow")
c.ck("ไม่ควรเห็น" not in ns, "ไม่มีข้อความจากเงื่อนไขที่ไม่จริง")
c.ck("ifEQ" not in ns, "ไม่มีแท็ก ifEQ ค้าง")

# --- 3.5 ตารางซ้อน ---
c.section("3.5 ตารางซ้อนกัน 2 ชั้น")
for g in data["กลุ่ม"]:
    c.ck(contains_ns(ns, g["ชื่อกลุ่ม"]), f"กลุ่ม: {g['ชื่อกลุ่ม']}")
    for sub in g["รายการ"]:
        c.ck(contains_ns(ns, sub["ชื่อ"]), f"  ย่อย: {sub['ชื่อ']}")

# --- 3.6 ไม่มีแท็กค้าง ---
c.section("3.6 ไม่มีแท็กค้าง")
leftover = [t for t in re.findall(r"\{[^{}]{1,40}\}", text) if t != "{จังหวัด}"]
c.ck(not leftover, "ไม่มีแท็กเหลือในเอกสาร", f"พบ {leftover[:3]}")

# --- PDF ---
c.section("ไฟล์ผลลัพธ์")
c.ck(pdf_header(PDF).startswith("%PDF-"), "PDF มีโครงสร้างถูกต้อง")
pg = pdf_pages(PDF)
c.ck(pg > 0, f"PDF มี {pg} หน้า")
made, _ = pdf_to_png(PDF, os.path.join(HERE, "output"), "ตาราง", max_pages=2)
if made:
    print(f"ภาพ: {made[0]}")

c.report()
