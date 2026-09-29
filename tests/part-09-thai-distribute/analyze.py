# -*- coding: utf-8 -*-
"""
วิเคราะห์ตำแหน่ง {เนื้อหา} และเตรียมแม่แบบให้พร้อมทดสอบ thaiDistribute
"""
import os, re, zipfile
from docx import Document

TPL = r"D:\2docx.com\tests\part-09-thai-distribute\templates\หนังสือรับรอง.docx"

print("=" * 66)
print(" ตำแหน่งข้อความและการตั้งค่าในแม่แบบ")
print("=" * 66)

doc = Document(TPL)
for i, p in enumerate(doc.paragraphs):
    t = p.text.strip()
    m = re.search(r'<w:jc w:val="([^"]+)"', p._p.xml)
    jc = m.group(1) if m else "-"
    has_marker = "{เนื้อหา}" in t
    if not t and jc == "-":
        continue
    mark = "  <<< ตำแหน่งเนื้อหา" if has_marker else ""
    print(f"[{i:>2}] jc={jc:<16} {t[:70]}{mark}")

print()
print("=" * 66)
print(" สรุป")
print("=" * 66)

with zipfile.ZipFile(TPL) as z:
    xml = z.read("word/document.xml").decode("utf-8")

# นับย่อหน้าทั้งหมดที่มีเนื้อหา
paras = re.findall(r"<w:p[ >].*?</w:p>", xml, re.S)
print(f"ย่อหน้าทั้งหมด: {len(paras)}")
for i, px in enumerate(paras):
    txt = "".join(re.findall(r"<w:t[^>]*>(.*?)</w:t>", px, re.S))
    jc = re.search(r'<w:jc w:val="([^"]+)"', px)
    if txt.strip():
        j = jc.group(1) if jc else "(ค่าเริ่มต้น)"
        flag = "  thaiDistribute!" if j == "thaiDistribute" else ""
        print(f"  [{i:>2}] jc={j:<16} {txt[:60]}{flag}")
