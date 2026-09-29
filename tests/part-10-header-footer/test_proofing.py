# -*- coding: utf-8 -*-
"""ทดสอบตัวแก้ภาษาไทยกับแม่แบบจริง"""
import os, sys, zipfile, re

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "lib"))
from thai_proofing import fix_document, check_document

TPL = os.path.join(HERE, "templates", "หัวกระดาษ-เลขหน้า.docx")
OUT = os.path.join(HERE, "output", "ทดสอบ-แก้ภาษา.docx")
os.makedirs(os.path.dirname(OUT), exist_ok=True)


def show(path, label):
    r = check_document(path)
    print(f"\n{label}")
    print(f"  {'ส่วน':<10} {'ภาษาไทย':>9} {'ภาษาอื่น':>9} {'noProof':>8}")
    print("  " + "-" * 40)
    for k in ("document", "header", "footer"):
        v = r[k]
        flag = "OK" if v["th"] > 0 else "--"
        print(f"  {k:<10} {v['th']:>4} {flag:<4} {v['en']:>9} {v['noproof']:>8}")


print("=" * 62)
print(" ทดสอบตัวแก้ภาษาไทย (แก้เส้นหยักแดง)")
print("=" * 62)

# ---------- ก่อนแก้ ----------
show(TPL, "[1] ก่อนแก้ไข (แม่แบบต้นฉบับ)")

# ---------- วิธีที่ 1: ตั้งภาษาไทย ----------
print("\n" + "-" * 62)
print("[2] วิธีที่ 1: ตั้งภาษาไทย (Word ยังตรวจสะกดแต่เป็นภาษาไทย)")
print("-" * 62)
s1 = fix_document(TPL, OUT, skip_proof=False)
print(f"  แก้ไป: {s1}")
show(OUT, "  ผลลัพธ์")

# ตรวจว่า XML ถูกต้อง
with zipfile.ZipFile(OUT) as z:
    h = z.read("word/header1.xml").decode("utf-8")
langs = re.findall(r"<w:lang[^>]*/>", h)
print(f"\n  แท็ก w:lang ในส่วนหัว: {len(langs)} จุด")
if langs:
    print(f"  ตัวอย่าง: {langs[0]}")

# ---------- วิธีที่ 2: noProof ----------
print("\n" + "-" * 62)
print("[3] วิธีที่ 2: noProof (ไม่ต้องตรวจสะกดเลย)")
print("-" * 62)
OUT2 = os.path.join(HERE, "output", "ทดสอบ-noProof.docx")
s2 = fix_document(TPL, OUT2, skip_proof=True)
print(f"  แก้ไป: {s2}")
show(OUT2, "  ผลลัพธ์")

# ---------- ตรวจว่าไฟล์ยังเปิดได้ ----------
print("\n" + "-" * 62)
print("[4] ตรวจว่าไฟล์ยังถูกต้อง")
print("-" * 62)
from docx import Document
for p in (OUT, OUT2):
    try:
        d = Document(p)
        print(f"  เปิดได้: {os.path.basename(p)}  ({len(d.paragraphs)} ย่อหน้า)")
    except Exception as e:
        print(f"  เปิดไม่ได้: {os.path.basename(p)} -> {e}")

print("\n" + "=" * 62)
print(f"ไฟล์ทดสอบ: {OUT}")
print("=" * 62)
