# -*- coding: utf-8 -*-
"""
ส่วนที่ 10: หัวกระดาษซ้ำและเลขหน้าอัตโนมัติ
=========================================
ทดสอบสิ่งที่เอกสารราชการใช้ทุกฉบับ

  10.1  ส่วนหัว (header) แสดงทุกหน้า
  10.2  ส่วนท้าย (footer) แสดงทุกหน้า
  10.3  เลขหน้าอัตโนมัติ (ฟิลด์ PAGE)
  10.4  จำนวนหน้าทั้งหมด (ฟิลด์ NUMPAGES)
  10.5  หน้าแรกต่างจากหน้าอื่น (different first page)
  10.6  ฟอนต์ไทยในส่วนหัว/ท้าย

เอกสารราชการไทยมักมีรูปแบบ:
  หัวเอกสาร  : ชื่อหน่วยงาน (บางฉบับมีเส้นคั่น)
  ท้ายเอกสาร : หน้า 1 / 5  หรือ  "หน้า 1 จาก 5"

รัน:  python make.py
"""
import os
from docx import Document
from docx.shared import Pt, Cm
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.enum.table import WD_TABLE_ALIGNMENT
from docx.oxml.ns import qn
from docx.oxml import OxmlElement

HERE = os.path.dirname(os.path.abspath(__file__))
TPL = os.path.join(HERE, "templates", "หัวกระดาษ-เลขหน้า.docx")
DATA = os.path.join(HERE, "data", "ข้อมูล.json")
os.makedirs(os.path.dirname(TPL), exist_ok=True)
os.makedirs(os.path.dirname(DATA), exist_ok=True)

FONT = "TH Sarabun New"


def set_font(run, size=16, bold=False):
    run.font.name = FONT
    run.font.size = Pt(size)
    run.bold = bold
    run._element.rPr.rFonts.set(qn("w:eastAsia"), FONT)
    run._element.rPr.rFonts.set(qn("w:cs"), FONT)


def add_field(paragraph, field_code, size=16, bold=False):
    """
    แทรกฟิลด์ของ Word (เช่น PAGE, NUMPAGES)
    ฟิลด์เหล่านี้ LibreOffice/Word จะคำนวณค่าให้ตอนเปิด

    โครงสร้าง XML:
      <w:fldChar w:fldCharType="begin"/>
      <w:instrText> PAGE </w:instrText>
      <w:fldChar w:fldCharType="separate"/>
      <w:t>1</w:t>            (ค่าเริ่มต้น จะถูกคำนวณใหม่)
      <w:fldChar w:fldCharType="end"/>
    """
    r1 = paragraph.add_run()
    fc1 = OxmlElement("w:fldChar")
    fc1.set(qn("w:fldCharType"), "begin")
    r1._r.append(fc1)

    r2 = paragraph.add_run()
    it = OxmlElement("w:instrText")
    it.set(qn("xml:space"), "preserve")
    it.text = f" {field_code} "
    r2._r.append(it)

    r3 = paragraph.add_run()
    fc2 = OxmlElement("w:fldChar")
    fc2.set(qn("w:fldCharType"), "separate")
    r3._r.append(fc2)

    # ค่าเริ่มต้น (ถ้าไม่คำนวณจะได้ค่านี้)
    r4 = paragraph.add_run("1")
    set_font(r4, size, bold)

    r5 = paragraph.add_run()
    fc3 = OxmlElement("w:fldChar")
    fc3.set(qn("w:fldCharType"), "end")
    r5._r.append(fc3)

    for r in (r1, r2, r3, r5):
        set_font(r, size, bold)


doc = Document()

# ---------- ตั้งค่าหน้า A4 ขอบมาตรฐานราชการ ----------
sec = doc.sections[0]
sec.page_width, sec.page_height = Cm(21.0), Cm(29.7)
sec.top_margin = Cm(3.0)       # เผื่อที่ส่วนหัว
sec.bottom_margin = Cm(2.5)    # เผื่อที่ส่วนท้าย
sec.left_margin = Cm(3.0)      # ขอบเย็บซ้ายสำหรับเล่มเอกสาร
sec.right_margin = Cm(2.0)
sec.header_distance = Cm(1.5)
sec.footer_distance = Cm(1.5)

st = doc.styles["Normal"]
st.font.name = FONT
st.font.size = Pt(16)
st.element.rPr.rFonts.set(qn("w:eastAsia"), FONT)
st.element.rPr.rFonts.set(qn("w:cs"), FONT)
st.paragraph_format.line_spacing = 1.5


def par(text="", align=WD_ALIGN_PARAGRAPH.LEFT, bold=False, size=16, after=0):
    p = doc.add_paragraph()
    p.alignment = align
    p.paragraph_format.line_spacing = 1.5
    p.paragraph_format.space_after = Pt(after)
    if text:
        set_font(p.add_run(text), size, bold)
    return p


# ==========================================================
#  ส่วนหัวเอกสาร
# ==========================================================
hdr = sec.header
hp = hdr.paragraphs[0]
hp.alignment = WD_ALIGN_PARAGRAPH.CENTER
hp.paragraph_format.line_spacing = 1.0
set_font(hp.add_run("{d.หน่วยงาน}"), 14, True)

# เส้นคั่นใต้หัวเอกสาร
ppr = hp._p.get_or_add_pPr()
pbdr = OxmlElement("w:pBdr")
bottom = OxmlElement("w:bottom")
bottom.set(qn("w:val"), "single")
bottom.set(qn("w:sz"), "6")
bottom.set(qn("w:space"), "1")
bottom.set(qn("w:color"), "000000")
pbdr.append(bottom)
ppr.append(pbdr)

# ==========================================================
#  ส่วนท้ายเอกสาร — เลขหน้าอัตโนมัติ
# ==========================================================
ftr = sec.footer
fp = ftr.paragraphs[0]
fp.alignment = WD_ALIGN_PARAGRAPH.CENTER
fp.paragraph_format.line_spacing = 1.0
set_font(fp.add_run("หน้า "), 14, False)
add_field(fp, "PAGE", 14, False)          # เลขหน้าปัจจุบัน
set_font(fp.add_run(" จาก "), 14, False)
add_field(fp, "NUMPAGES", 14, False)      # จำนวนหน้าทั้งหมด
set_font(fp.add_run(" หน้า"), 14, False)

# ==========================================================
#  เนื้อหาเอกสาร
# ==========================================================
par("{d.ที่}", after=4)
par("ที่  {d.เลขที่หนังสือ}", after=4)
par("หนังสือรับรอง", WD_ALIGN_PARAGRAPH.CENTER, True, 18, 12)
par("เรื่อง  {d.เรื่อง}", after=12)
par("เรียน  นายอำเภอ{d.อำเภอ}", after=14)

par("ด้วย  ข้าพเจ้า{d.ชื่อเจ้าหน้าที่} ตำแหน่ง{d.ตำแหน่ง}", after=10)

# ---------- เนื้อหายาวเพื่อให้เกิดหลายหน้า ----------
par("{d.เนื้อหา}", after=14)

par("จึงเรียนมาเพื่อโปรดพิจารณา", after=30)
par("ลงชื่อ  ..................................................", after=0)
par("({d.ชื่อเจ้าหน้าที่})", after=4)
par("{d.ตำแหน่ง}")

# ---------- ใส่เนื้อหาให้หลายหน้า เพื่อทดสอบว่าหัว/ท้ายซ้ำทุกหน้า ----------
doc.add_page_break()
par("ภาคผนวก ก  ข้อมูลประกอบ", WD_ALIGN_PARAGRAPH.CENTER, True, 18, 14)

items = [
    "๑. สำเนาหนังสือแจ้งการจัดสรรงบประมาณ",
    "๒. สำเนาบัญชีรายรายจ่าย",
    "๓. สำเนาใบเสนอราคา",
    "๔. สำเนาหนังสือรับรองจากหน่วยงานต้นทาง",
    "๕. รายงานสรุปผลการดำเนินการ",
    "๖. ภาพถ่ายกิจกรรม",
    "๗. ทะเบียนผู้ได้รับเงินสวัสดิการ",
    "๘. สำเนาทะเบียนราษฎรบรรณ",
]
for i, t in enumerate(items, 1):
    par(t, after=6)
    if i % 2 == 0:
        par()

doc.add_page_break()
par("ภาคผนวก ข  บันทึกรายละเอียด", WD_ALIGN_PARAGRAPH.CENTER, True, 18, 14)
for i in range(1, 16):
    par(f"{i}. รายการที่ {i} — ใช้สร้างหน้าเพิ่มเพื่อทดสอบการแสดงหัวกระดาษ "
        f"และเลขหน้าอัตโนมัติให้ปรากฏครบทุกหน้า", after=6)

doc.save(TPL)
print("สร้างแม่แบบ:", os.path.basename(TPL))

# ---------------- ข้อมูล ----------------
import json
data = {
    "หน่วยงาน": "ที่ทำการปกครองอำเภอเมืองนครศรีธรรมราช",
    "ที่": "ที่ 0511.01/๑๒๓/๒๕๖๙",
    "เลขที่หนังสือ": "๘๕/๒๕๖๙",
    "เรื่อง": "รายงานผลการดำเนินการสนับสนุนการลงทะเบียนเพื่อสวัสดิการแห่งรัฐ ปี ๒๕๖๙",
    "อำเภอ": "เมืองนครศรีธรรมราช",
    "ชื่อเจ้าหน้าที่": "นางสาวสุดารัตน์ วงศ์ทอง",
    "ตำแหน่ง": "ปลัดอำเภอ (เจ้าพนักงานปกครองชำนาญการ) รักษาราชการแทน",
    "เนื้อหา": (
        "ตามที่ จังหวัดพิษณุโลก แจ้งว่ากรมการปกครองได้ส่งเงินจัดสรรงบประมาณ"
        "รายจ่ายประจำปี งบประมาณ พ.ศ. 2569 งบกลาง รายการเงินสำรองจ่าย"
        "เพื่อกรณีฉุกเฉินหรือจำเป็น สำหรับดำเนินโครงการสนับสนุนการลงทะเบียน"
        "เพื่อสวัสดิการแห่งรัฐ ปี 2569 โดยให้ที่ทำการปกครองอำเภอเร่งดำเนินการ"
        "เบิกจ่ายงบประมาณให้เป็นไปตามระเบียบและหลักเกณฑ์ที่กำหนดโดยเร็ว นั้น"),
}
with open(DATA, "w", encoding="utf-8") as f:
    json.dump(data, f, ensure_ascii=False, indent=2)
print("ข้อมูล  :", os.path.basename(DATA))
print()
print("โครงสร้างที่สร้าง:")
print("  - ส่วนหัว: ชื่อหน่วยงาน + เส้นคั่น")
print("  - ส่วนท้าย: หน้า {PAGE} จาก {NUMPAGES} หน้า")
print("  - เนื้อหา: 3 หน้า (มีภาคผนวก 2 หน้า)")
