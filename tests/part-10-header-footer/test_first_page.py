# -*- coding: utf-8 -*-
"""
ทดสอบ "หน้าแรกต่างจากหน้าอื่น" (different first page)
======================================================

เอกสารราชการไทยหลายฉบับใช้รูปแบบนี้:
  - หน้าแรก  : มีหัวเอกสารเต็มรูปแบบ (เช่น ตราสัญลักษณ์ + ชื่อหน่วยงาน)
  - หน้าถัดไป: มีเฉพาะเลขหน้า หรือไม่มีหัวเอกสารเลย
  (เพราะหน้าแรกมีหัวเอกสารประจำเอกสารอยู่แล้ว ไม่ต้องซ้ำ)

วิธีเปิดใน Word:
  แทรก → ส่วนหัวและท้าย → ส่วนหัว → ตัวเลือก "หน้าแรกต่างจากหน้าถัดไป"

ทดสอบว่า Carbone/LibreOffice รักษาการตั้งค่านี้ไว้หรือไม่
"""
import os, re, sys, json, subprocess, time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "lib"))
from helper import Checker

OUTD = os.path.join(HERE, "output")
os.makedirs(OUTD, exist_ok=True)
BASE = "http://127.0.0.1:4000"
CURL = os.path.join(os.environ.get("SystemRoot", r"C:\Windows"), "System32", "curl.exe")

c = Checker()
data = json.load(open(os.path.join(HERE, "data", "ข้อมูล.json"), encoding="utf-8"))
TPL = os.path.join(HERE, "templates", "หน้าแรกต่างจากหน้าถัดไป.docx")


def curl(args):
    return subprocess.run([CURL, "-s"] + args, capture_output=True, text=True,
                          encoding="utf-8", errors="replace").stdout


# ------------------------------------------------------------------
#  1. ตรวจว่าแม่แบบมีการตั้งค่า different first page
# ------------------------------------------------------------------
c.section("1. ตรวจแม่แบบ")
import zipfile
with zipfile.ZipFile(TPL) as z:
    names = z.namelist()
    doc_xml = z.read("word/document.xml").decode("utf-8")
    hdrs = sorted(n for n in names if re.search(r"word/header\d*\.xml", n))
    ftrs = sorted(n for n in names if re.search(r"word/footer\d*\.xml", n))
    rels = z.read("word/_rels/document.xml.rels").decode("utf-8")

c.ck("titlePg" in doc_xml,
     "เปิดการตั้งค่า 'หน้าแรกต่างจากหน้าถัดไป' (w:titlePg)")
c.ck(len(hdrs) >= 2, f"มีส่วนหัว 2 ชุด ({len(hdrs)} ไฟล์)")
c.ck(len(ftrs) >= 2, f"มีส่วนท้าย 2 ชุด ({len(ftrs)} ไฟล์)")
print(f"    ไฟล์ส่วนท้าย: {ftrs}")

# ตรวจว่าส่วนท้ายหน้าแรกไม่มีเลขหน้า (ตามที่ออกแบบไว้)
# ต้องดูจาก relationship: ไฟล์ใดเป็นของ "first"
with zipfile.ZipFile(TPL) as z:
    rels = z.read("word/_rels/document.xml.rels").decode("utf-8")
    # sectPr ระบุว่า footer ไหนเป็นของ first
    m = re.search(r'<w:footerReference w:type="first"[^>]*r:id="([^"]+)"', doc_xml)
    first_rid = m.group(1) if m else None
    m2 = re.search(r'Id="%s"[^>]*Target="([^"]+)"' % re.escape(first_rid), rels) if first_rid else None
    first_file = "word/" + m2.group(1) if m2 else None
    ftr_first = z.read(first_file).decode("utf-8") if first_file in names else ""

if first_file:
    c.ck("PAGE" not in ftr_first,
         f"ส่วนท้ายหน้าแรก ({os.path.basename(first_file)}) ไม่มีเลขหน้า")
else:
    c.ck(False, "พบส่วนท้ายสำหรับหน้าแรก", "ไม่พบ footerReference type=first")

# ------------------------------------------------------------------
#  2. รันผ่าน Carbone
# ------------------------------------------------------------------
c.section("2. สร้าง PDF ผ่าน Carbone")
up = os.path.join(OUTD, "_up2.json")
subprocess.run([CURL, "-s", "-o", up, "-X", "POST", f"{BASE}/template",
                "-H", "Authorization: Bearer carbon-ce",
                "-F", f"template=@{TPL}", "--max-time", "180"], capture_output=True)
tpl_id = json.load(open(up, encoding="utf-8"))["data"]["templateId"]
c.ck(tpl_id is not None, "อัปโหลดแม่แบบได้")

pf = os.path.join(OUTD, "_pf2.json")
with open(pf, "w", encoding="utf-8") as f:
    json.dump({"data": data, "convertTo": "pdf"}, f, ensure_ascii=False)

pdf_out = os.path.join(OUTD, "ผลลัพธ์-หน้าแรกต่าง.pdf")
t0 = time.time()
subprocess.run([CURL, "-s", "-o", pdf_out, "-X", "POST",
                f"{BASE}/render/{tpl_id}?download=true",
                "-H", "Authorization: Bearer carbon-ce",
                "-H", "Content-Type: application/json",
                "-H", "carbone-version: 5",
                "--data-binary", f"@{pf}", "--max-time", "300"],
               capture_output=True)
dt = time.time() - t0
print(f"    PDF: {os.path.getsize(pdf_out):,} bytes  ({dt:.1f} วิ)")

# ------------------------------------------------------------------
#  3. ตรวจผลจริง
# ------------------------------------------------------------------
c.section("3. ตรวจผลใน PDF")
import fitz
doc = fitz.open(pdf_out)
n = len(doc)
c.ck(n >= 2, f"PDF มี {n} หน้า")

unit = re.sub(r"\s+", "", data["หน่วยงาน"])
rows = []
for i, page in enumerate(doc, 1):
    txt = re.sub(r"\s+", "", page.get_text())
    has_unit = unit in txt
    m = re.search(r"หน้า(\d+)จาก(\d+)หน้า", txt)
    pageno = int(m.group(1)) if m else None
    rows.append((i, has_unit, pageno))
    print(f"    หน้า {i}: หัวเอกสาร={'มี' if has_unit else 'ไม่มี':<6} "
          f"เลขหน้า={pageno}")

print()
if rows:
    p1_unit, p1_no = rows[0][1], rows[0][2]
    p2_unit, p2_no = rows[1][1], rows[1][2] if len(rows) > 1 else (None, None)

    c.ck(p1_unit, "หน้าแรกมีหัวเอกสาร (ตามที่ออกแบบ)")
    c.ck(p1_no is None, "หน้าแรกไม่มีเลขหน้า (ตามที่ออกแบบ)")

    if len(rows) > 1:
        c.ck(p2_unit, "หน้าถัดไปมีหัวเอกสารเหมือนกัน")
        c.ck(p2_no == 2, f"หน้าถัดไปมีเลขหน้า = 2 (ได้ {p2_no})")

    # หน้าถัดไปต้องมีเลขหน้าครบ
    have = [r[2] for r in rows[1:] if r[2] is not None]
    c.ck(have == list(range(2, n + 1)),
         f"เลขหน้าเรียงถูกต้อง 2-{n}", f"ได้ {have}")

made = []
for i in range(min(n, 3)):
    p = os.path.join(OUTD, f"ต่างหน้าแรก-{i+1}.png")
    doc[i].get_pixmap(dpi=100).save(p)
    made.append(p)
print()
print(f"    ภาพ: {made[0]}")

print()
print(f"ผลลัพธ์: {pdf_out}")
c.report()
