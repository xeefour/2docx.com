# -*- coding: utf-8 -*-
"""
ส่วนที่ 3: ตารางซ้ำและเงื่อนไข
==============================
ทดสอบส่วนที่ยากที่สุดของ Carbone

  3.1  ตารางซ้ำวนตามอาร์เรย์ พร้อมเลขลำดับ
  3.2  อาร์เรย์ว่าง → ทั้งแถว [i] และ [i+1] ต้องหาย
  3.3  เงื่อนไข ifEQ + show (เงื่อนไขเป็นจริง)
  3.4  เงื่อนไข elseShow (เงื่อนไขเป็นเท็จ)
  3.5  ตารางซ้อนกัน 2 ชั้น
  3.6  ไม่มีแท็กค้างเหลือ

ไวยากรณ์ที่ทดสอบ:
  ตารางซ้ำ  = {d.items[i].ชื่อ}   ปิดด้วย {d.items[i+1]} ในแถวถัดไป
  เงื่อนไข  = {d.ฟิลด์:ifEQ(ค่า):show('ข้อความ'):elseShow('ข้อความอื่น')}

รัน:  python make.py
"""
import os, json
from docx import Document
from docx.shared import Pt, Cm
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.enum.table import WD_TABLE_ALIGNMENT
from docx.oxml.ns import qn

HERE = os.path.dirname(os.path.abspath(__file__))
TPL = os.path.join(HERE, "templates", "ตารางและเงื่อนไข.docx")
DATA = os.path.join(HERE, "data", "ข้อมูล.json")
os.makedirs(os.path.dirname(TPL), exist_ok=True)
os.makedirs(os.path.dirname(DATA), exist_ok=True)

FONT = "TH Sarabun New"
doc = Document()
sec = doc.sections[0]
sec.page_width, sec.page_height = Cm(21.0), Cm(29.7)
sec.top_margin = sec.bottom_margin = Cm(2.0)
sec.left_margin = sec.right_margin = Cm(2.0)

st = doc.styles["Normal"]
st.font.name = FONT
st.font.size = Pt(16)
st.element.rPr.rFonts.set(qn("w:eastAsia"), FONT)
st.paragraph_format.line_spacing = 1.4


def par(text="", bold=False, size=16, after=4):
    p = doc.add_paragraph()
    p.paragraph_format.line_spacing = 1.4
    p.paragraph_format.space_after = Pt(after)
    if text:
        r = p.add_run(text)
        r.font.name = FONT
        r.font.size = Pt(size)
        r.bold = bold
        r._element.rPr.rFonts.set(qn("w:eastAsia"), FONT)
    return p


def cell(c, text, bold=False, center=False, size=14):
    p = c.paragraphs[0]
    p.paragraph_format.line_spacing = 1.3
    if center:
        p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    r = p.add_run(text)
    r.font.name = FONT
    r.font.size = Pt(size)
    r.bold = bold
    r._element.rPr.rFonts.set(qn("w:eastAsia"), FONT)


# --- 3.1 ตารางซ้ำ ---
par("3.1 ตารางซ้ำ (วนตามจำนวนรายการ)", bold=True, after=6)
t1 = doc.add_table(rows=3, cols=3)
t1.style = "Table Grid"
t1.alignment = WD_TABLE_ALIGNMENT.CENTER
for i, h in enumerate(["ลำดับ", "รายการ", "จำนวน"]):
    cell(t1.rows[0].cells[i], h, bold=True, center=True)
for i, t in enumerate(["{d.items[i].ลำดับ}", "{d.items[i].รายการ}", "{d.items[i].จำนวน}"]):
    cell(t1.rows[1].cells[i], t, center=(i != 1))
cell(t1.rows[2].cells[0], "{d.items[i+1]}", center=True)

# --- 3.2 อาร์เรย์ว่าง ---
par("", after=8)
par("3.2 ตารางที่ไม่มีข้อมูล (ควรไม่เหลือแถวค้าง)", bold=True, after=6)
t2 = doc.add_table(rows=2, cols=2)
t2.style = "Table Grid"
t2.alignment = WD_TABLE_ALIGNMENT.CENTER
for i, h in enumerate(["รายการ", "จำนวน"]):
    cell(t2.rows[0].cells[i], h, bold=True, center=True)
cell(t2.rows[1].cells[0], "{d.รายการว่าง[i].ชื่อ}")
cell(t2.rows[1].cells[1], "{d.รายการว่าง[i+1]}", center=True)

# --- 3.3 / 3.4 เงื่อนไข ---
par("", after=8)
par("3.3 เงื่อนไขที่เป็นจริง", bold=True, after=6)
par("{d.เร่งด่วน:ifEQ(true):show('แสดงเพราะเร่งด่วนเป็นจริง')}")

par("3.4 เงื่อนไขที่เป็นเท็จ (ใช้ elseShow)", bold=True, after=6)
par("{d.ปกติ:ifEQ(true):show('ไม่ควรเห็น'):elseShow('แสดงเพราะปกติเป็นเท็จ')}")

# --- 3.5 ตารางซ้อน ---
# สำคัญ: ตารางซ้อน 2 ชั้น ต้องมี [i+1] ของทั้งชั้นนอกและชั้นใน
# ถ้ามีแค่ชั้นนอก Carbone จะแจ้งว่า
#   "marker ... has no corresponding [i+1] for array รายการ"
# เรียงแบบ: ชั้นนอกเปิด → ชั้นในเปิดและปิด → ชั้นนอกปิด
par("", after=8)
par("3.5 ตารางซ้อนกัน 2 ชั้น", bold=True, after=6)
t3 = doc.add_table(rows=4, cols=2)
t3.style = "Table Grid"
t3.alignment = WD_TABLE_ALIGNMENT.CENTER
for i, h in enumerate(["หมวดหมู่", "รายการย่อย"]):
    cell(t3.rows[0].cells[i], h, bold=True, center=True)

# แถวที่ 2: ข้อมูล — เปิดวนชั้นนอกแล้วเปิดวนชั้นใน
cell(t3.rows[1].cells[0], "{d.กลุ่ม[i].ชื่อกลุ่ม}")
cell(t3.rows[1].cells[1], "{d.กลุ่ม[i].รายการ[i].ชื่อ}")

# แถวที่ 3: ปิดวนชั้นใน
cell(t3.rows[2].cells[0], "")
cell(t3.rows[2].cells[1], "{d.กลุ่ม[i].รายการ[i+1]}")

# แถวที่ 4: ปิดวนชั้นนอก
cell(t3.rows[3].cells[0], "{d.กลุ่ม[i+1]}", center=True)
cell(t3.rows[3].cells[1], "")

doc.save(TPL)
print("แม่แบบ:", os.path.basename(TPL))

data = {
    "items": [
        {"ลำดับ": "1", "รายการ": "ภาพถ่ายไฟดับบริเวณหมู่ 4", "จำนวน": "3 ภาพ"},
        {"ลำดับ": "2", "รายการ": "ใบเสนอราคาซ่อมระบบไฟฟ้า", "จำนวน": "1 ฉบับ"},
        {"ลำดับ": "3", "รายการ": "บันทึกรายงานเจ้าหน้าที่ออกตรวจสอบ", "จำนวน": "1 ฉบับ"},
    ],
    "รายการว่าง": [],
    "เร่งด่วน": True,
    "ปกติ": False,
    "กลุ่ม": [
        {"ชื่อกลุ่ม": "เอกสารหลักฐาน", "รายการ": [
            {"ชื่อ": "ใบเสนอราคา"}, {"ชื่อ": "บันทึกตรวจสอบ"}]},
        {"ชื่อกลุ่ม": "ภาพถ่าย", "รายการ": [
            {"ชื่อ": "ภาพหมู่ 4"}, {"ชื่อ": "ภาพหน้าบ้าน"}, {"ชื่อ": "ภาพถนน"}]},
    ],
}
with open(DATA, "w", encoding="utf-8") as f:
    json.dump(data, f, ensure_ascii=False, indent=2)
print("ข้อมูล  :", os.path.basename(DATA))
