# -*- coding: utf-8 -*-
"""
แม่แบบหนังสือราชการ (สำหรับส่วนที่ 8 — ทดสอบครบวงจร)
ครอบคลุม: ข้อความ + ตารางซ้ำ + เงื่อนไข + ช่องรูป ในแม่แบบเดียว
"""
import os
from docx import Document
from docx.shared import Pt, Cm
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.enum.table import WD_TABLE_ALIGNMENT
from docx.oxml.ns import qn

HERE = os.path.dirname(os.path.abspath(__file__))
TPL = os.path.join(HERE, "templates", "หนังสือราชการ.docx")
IMG = os.path.join(HERE, "images")
os.makedirs(os.path.dirname(TPL), exist_ok=True)
os.makedirs(IMG, exist_ok=True)

# สร้างรูป placeholder
from PIL import Image
def placeholder(path, color, size=(500, 340)):
    im = Image.new("RGB", size, color)
    im.save(path, "JPEG", quality=80)
    return path

ph_seal = placeholder(os.path.join(IMG, "_ph_trา.jpg"), (200, 200, 200), (400, 400))
ph_photo = placeholder(os.path.join(IMG, "_ph_photo.jpg"), (180, 180, 180))

FONT = "TH Sarabun New"
doc = Document()
sec = doc.sections[0]
sec.page_width, sec.page_height = Cm(21.0), Cm(29.7)
sec.top_margin = sec.bottom_margin = Cm(2.54)
sec.left_margin = sec.right_margin = Cm(2.54)

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
        r = p.add_run(text)
        r.font.name = FONT
        r.font.size = Pt(size)
        r.bold = bold
        r._element.rPr.rFonts.set(qn("w:eastAsia"), FONT)
    return p


def descr(shape, text, name=""):
    dp = shape._inline.docPr
    dp.set("name", name or text)
    dp.set("descr", text)


# ---------- ตราสัญลักษณ์กลางหน้า ----------
p = par(align=WD_ALIGN_PARAGRAPH.CENTER, after=4)
s = p.add_run().add_picture(ph_seal, width=Cm(3.2))
descr(s, "ตราสัญลักษณ์", "ตรา")

# ---------- หัวหนังสือ ----------
par("ที่  ชม. 0511.01/{d.เลขที่หนังสือ}", after=4)
par("ที่  อำเภอ{d.อำเภอ} จังหวัด{d.จังหวัด}", after=4)
par("ที่  กอง{d.กอง} โทร. 0-XXXX-XXXX ต่อ XXX", after=10)

par("หนังสือราชการ", WD_ALIGN_PARAGRAPH.CENTER, True, 18, 10)
par("เรื่อง  {d.เรื่อง}", after=4)
par("เรียน  นายอำเภอ{d.อำเภอ}", after=12)

# ---------- เนื้อหา ----------
par("ด้วย  ข้าพเจ้า{d.ชื่อเจ้าหน้าที่} ตำแหน่ง{d.ตำแหน่ง} สังกัด{d.สังกัด}", after=4)
par("ด้วยความปรารถนาดี", after=8)
par("          ในชื่อ{d.ชื่อผู้ร้องเรียน} ได้มาร้องเรียนเรื่อง{d.เรื่องร้องเรียน}", after=4)
par("          โดยมีรายละเอียดดังต่อไปนี้", after=10)

# ---------- เงื่อนไขเร่งด่วน ----------
p = par(after=8)
r = p.add_run("{d.เร่งด่วน:ifEQ(true):show('เรื่องนี้เป็นเรื่องเร่งด่วน ขอให้พิจารณาด่วน')"
              ":elseShow('ไม่แสดงบรรทัดนี้เมื่อไม่เร่งด่วน')}")
r.font.name = FONT
r.font.size = Pt(16)
r.bold = True
r._element.rPr.rFonts.set(qn("w:eastAsia"), FONT)

# ---------- ตารางหลักฐาน ----------
par("หลักฐานประกอบการร้องเรียน", bold=True, after=6)

t = doc.add_table(rows=2, cols=4)
t.style = "Table Grid"
t.alignment = WD_TABLE_ALIGNMENT.CENTER


def cell(c, text, bold=False, center=False, size=14):
    pp = c.paragraphs[0]
    pp.paragraph_format.line_spacing = 1.3
    if center:
        pp.alignment = WD_ALIGN_PARAGRAPH.CENTER
    rr = pp.add_run(text)
    rr.font.name = FONT
    rr.font.size = Pt(size)
    rr.bold = bold
    rr._element.rPr.rFonts.set(qn("w:eastAsia"), FONT)


for i, h in enumerate(["ลำดับ", "รายการหลักฐาน", "จำนวน", "ภาพหลักฐาน"]):
    cell(t.rows[0].cells[i], h, bold=True, center=True)

cells = t.rows[1].cells
cell(cells[0], "{d.items[i].ลำดับ}", center=True)
cell(cells[1], "{d.items[i].หลักฐาน}")
cell(cells[2], "{d.items[i].จำนวน}", center=True)
pimg = cells[3].paragraphs[0]
pimg.alignment = WD_ALIGN_PARAGRAPH.CENTER
s = pimg.add_run().add_picture(ph_photo, width=Cm(2.6))
descr(s, "หลักฐาน", "รูปหลักฐาน")

# แถวปิดการวน
t2 = doc.add_table(rows=1, cols=4)
t2.style = "Table Grid"
cell(t2.rows[0].cells[3], "{d.items[i+1]}", center=True, size=8)

par(after=10)

# ---------- ความคิดเห็น ----------
par("{d.ความคิดเห็น}", after=14)
par("จึงเรียนมาเพื่อโปรดพิจารณา", after=20)
par("ลงชื่อ  ..................................................", after=0)
par("({d.ชื่อเจ้าหน้าที่})", after=4)
par("{d.ตำแหน่ง}")

doc.save(TPL)
print("สร้างแม่แบบหนังสือราชการ:", os.path.basename(TPL))
print("ช่องรูปที่มี: ตราสัญลักษณ์, หลักฐาน")
