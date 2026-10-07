# -*- coding: utf-8 -*-
"""
ตรวจโครงสร้างเอกสาร .docx เพื่อหาสิ่งที่ต้องทำกับการกระจายย่อหน้า
(ไม่แก้ไขไฟล์ — อ่านอย่างเดียว)
"""
import os, sys, zipfile, re
from docx import Document
from docx.shared import Pt

SRC = r"C:\Users\DOPA\Downloads\หนังสือรับรองเงินเดือน.docx"

print("=" * 70)
print(" โครงสร้างเอกสาร")
print("=" * 70)

with zipfile.ZipFile(SRC) as z:
    names = z.namelist()
    xml = z.read("word/document.xml").decode("utf-8")

print(f"\nไฟล์: {os.path.basename(SRC)}")
print(f"ขนาด: {os.path.getsize(SRC):,} bytes")
print(f"ไฟล์ใน zip: {len(names)}")

# ---------- 1. ตรวจการกระจายย่อหน้า ----------
print("\n" + "-" * 70)
print("1. การกระจายย่อหน้า (Distributed / Justified text)")
print("-" * 70)
# w:jc val="distribute" (Word เก็บ distributed เป็น "distribute" หรือ "both")
jc_all = re.findall(r'<w:jc w:val="([^"]+)"', xml)
from collections import Counter
jc_count = Counter(jc_all)
print("  ค่า w:jc ที่พบ:")
for k, v in jc_count.most_common():
    label = {
        "both": "justify (กระจายสองข้าง)",
        "distribute": "distribute (กระจายทั้งบรรทัด)",
        "left": "ชิดซ้าย",
        "right": "ชิดขวา",
        "center": "กึ่งกลาง",
        "thaiDistribute": "thaiDistribute (กระจายแบบไทย)",
    }.get(k, k)
    print(f"    {k:<16} {v:>3} ครั้ง   {label}")
print(f"\n  มี w:jc distribute หรือไม่: "
      f"{'มี' if 'distribute' in jc_all else 'ไม่มี'}")

# ---------- 2. ตรวจฟอนต์ ----------
print("\n" + "-" * 70)
print("2. ฟอนต์ที่ใช้")
print("-" * 70)
fonts = Counter(re.findall(r'<w:rFonts[^>]*w:ascii="([^"]+)"', xml))
for k, v in fonts.most_common():
    print(f"    {k:<30} {v:>3} ครั้ง")
sizes = Counter(re.findall(r'<w:sz w:val="(\d+)"', xml))
print("\n  ขนาดฟอนต์ (ครึ่งพอยต์):")
for k, v in sizes.most_common():
    print(f"    {int(k)/2:>6.0f} pt{'':<10} {v:>3} ครั้ง")

# ---------- 3. ตรวจย่อหน้า ----------
print("\n" + "-" * 70)
print("3. ย่อหน้า")
print("-" * 70)
doc = Document(SRC)
print(f"  จำนวนย่อหน้า: {len(doc.paragraphs)}")
print(f"  จำนวนตาราง: {len(doc.tables)}")

sec = doc.sections[0]
print(f"\n  ขนาดหน้า: {sec.page_width.cm:.1f} x {sec.page_height.cm:.1f} ซม.")
print(f"  ขอบ: บน {sec.top_margin.cm:.2f} / ล่าง {sec.bottom_margin.cm:.2f} / "
      f"ซ้าย {sec.left_margin.cm:.2f} / ขวา {sec.right_margin.cm:.2f} ซม.")

# ---------- 4. แสดงข้อความแต่ละย่อหน้า ----------
print("\n" + "-" * 70)
print("4. เนื้อหาแต่ละย่อหน้า")
print("-" * 70)
for i, p in enumerate(doc.paragraphs):
    t = p.text.strip()
    if not t:
        continue
    al = p.paragraph_format.alignment
    # อ่านค่า jc จาก XML โดยตรง
    m = re.search(r'<w:jc w:val="([^"]+)"', p._p.xml)
    jcv = m.group(1) if m else "(ไม่มี=ค่าเริ่มต้น)"
    ls = p.paragraph_format.line_spacing
    ind = p.paragraph_format.first_line_indent
    print(f"\n  [{i}] jc={jcv}  line_spacing={ls}  indent={ind}")
    print(f"      {t[:120]}")

# ---------- 5. ตรวจส่วนหัว/ท้าย ----------
print("\n" + "-" * 70)
print("5. ส่วนหัวและท้ายเอกสาร")
print("-" * 70)
for n in names:
    if "header" in n or "footer" in n:
        print(f"  {n}")

print("\n" + "=" * 70)
