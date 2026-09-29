# -*- coding: utf-8 -*-
"""
ส่วนที่ 2: ข้อความภาษาไทย
==========================
ทดสอบว่าการแทนค่าข้อความภาษาไทยทำงานถูกต้องแค่ไหน

  2.1  แทนค่าข้อความปกติ (ชื่อฟิลด์เป็นภาษาไทย)
  2.2  แท็กที่ลืมใส่ d. นำหน้า → ไม่ถูกแทน (กับดักที่พบบ่อยที่สุด)
  2.3  อักษรไทยพิเศษ และสระวรรณยุกต์
  2.4  ตัวเลขไทยและจุลภาค
  2.5  ข้อความยาวหลายบรรทัด
  2.6  ค่าที่ไม่มีใน JSON → ต้องเป็นค่าว่าง ไม่ใช่แท็กค้าง
  2.7  ค่าบูล (true/false)
  2.8  อังกฤษผสมในประโยคไทย
  2.9  ฟอนต์ที่ฝังใน PDF

รัน:  python make.py
"""
import os, json
from docx import Document
from docx.shared import Pt, Cm
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.oxml.ns import qn

HERE = os.path.dirname(os.path.abspath(__file__))
TPL = os.path.join(HERE, "templates", "ข้อความไทย.docx")
DATA = os.path.join(HERE, "data", "ข้อมูล.json")
os.makedirs(os.path.dirname(TPL), exist_ok=True)
os.makedirs(os.path.dirname(DATA), exist_ok=True)

FONT = "TH Sarabun New"
doc = Document()
sec = doc.sections[0]
sec.page_width, sec.page_height = Cm(21.0), Cm(29.7)
sec.top_margin = sec.bottom_margin = Cm(2.0)
sec.left_margin = sec.right_margin = Cm(2.2)

st = doc.styles["Normal"]
st.font.name = FONT
st.font.size = Pt(16)
st.element.rPr.rFonts.set(qn("w:eastAsia"), FONT)
st.element.rPr.rFonts.set(qn("w:cs"), FONT)
st.paragraph_format.line_spacing = 1.5


def par(text, bold=False, size=16, after=4):
    p = doc.add_paragraph()
    p.paragraph_format.line_spacing = 1.5
    p.paragraph_format.space_after = Pt(after)
    r = p.add_run(text)
    r.font.name = FONT
    r.font.size = Pt(size)
    r.bold = bold
    r._element.rPr.rFonts.set(qn("w:eastAsia"), FONT)
    return p


# 2.1
par("2.1 ข้อความปกติ", bold=True, after=6)
par("ชื่อผู้ร้องเรียน: {d.ชื่อผู้ร้องเรียน}")
par("ที่อยู่: {d.ที่อยู่}")
par("เรื่อง: {d.เรื่อง}")

# 2.2 กับดัก
par("2.2 แท็กที่ลืมใส่ d. (บรรทัดแรกถูก บรรทัดหลังไม่ถูก)", bold=True, after=6)
par("ถูกต้อง: {d.จังหวัด}")
par("ผิดพลาด: {จังหวัด}")

# 2.3
par("2.3 อักษรไทยพิเศษและสระวรรณยุกต์", bold=True, after=6)
par("ก-ฮ ญ ฏ ฐ ศ ษ ส ห ฬ")
par("ๆ ฯ ๅ ็ ่ ้ ๊ ๋ ์")
par("ประโยคจริง: ก้าวหน้าเข้าสู่โลกดิจิทัล")

# 2.4
par("2.4 ตัวเลขไทย", bold=True, after=6)
par("เลขไทย: ๐๑๒๓๔๕๖๗๘๙")
par("จุลภาค: ๑๒,๓๔๕.๖๗")
par("เลขผสม: 1234")

# 2.5
par("2.5 ข้อความยาวหลายบรรทัด", bold=True, after=6)
par("{d.ความคิดเห็น}")

# 2.6
par("2.6 ค่าที่ไม่มีในข้อมูล (ควรเป็นว่าง)", bold=True, after=6)
par("ผลลัพธ์: [{d.ไม่มีค่านี้}]")

# 2.7
par("2.7 ค่าบูล", bold=True, after=6)
par("เร่งด่วน = {d.เร่งด่วน}")

# 2.8
par("2.8 อังกฤษผสมในประโยคไทย", bold=True, after=6)
par("Ref. No. 1234/2569, Email: test@example.com")
par("ระบบ {d.ชื่อระบบ} เชื่อมต่อกับ API")

doc.save(TPL)
print("แม่แบบ:", os.path.basename(TPL))

data = {
    "ชื่อผู้ร้องเรียน": "นายสมชาย ใจดี",
    "ที่อยู่": "123 หมู่ 4 ตำบลบ้านสวน อำเภอเมือง จังหวัดชลบุรี 20000",
    "เรื่อง": "ร้องเรียนไฟดับและน้ำท่วมขังในพื้นที่หมู่บ้าน",
    "จังหวัด": "ชลบุรี",
    "ความคิดเห็น": "ได้รับเรื่องร้องเรียนแล้ว จะได้ส่งกำกับกองอุตสาหกรรมและการท่องเที่ยว"
                   " เพื่อตรวจสอบสถานการณ์ และประสานกับกองพลังงานภูมิภาค"
                   " เพื่อแก้ไขให้แล้วเสร็จโดยเร็ว",
    "เร่งด่วน": True,
    "ชื่อระบบ": "DocxAPI",
}
with open(DATA, "w", encoding="utf-8") as f:
    json.dump(data, f, ensure_ascii=False, indent=2)
print("ข้อมูล  :", os.path.basename(DATA))
