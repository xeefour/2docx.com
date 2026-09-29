# -*- coding: utf-8 -*-
"""
helper.py — ฟังก์ชันร่วมสำหรับทุกส่วนของชุดทดสอบ
=====================================================
ใช้เพื่อไม่ให้แต่ละส่วนต้องเขียนโค้ดตรวจผลซ้ำ ๆ กัน
"""

import os
import re
import zipfile


# ------------------------------------------------------------------
#  ผลลัพธ์ของการตรวจสอบ
# ------------------------------------------------------------------
class Checker:
    """เก็บผลตรวจแล้วพิมพ์ออกมาเป็นบรรทัด [ผ่าน] / [ไม่ผ่าน]"""

    def __init__(self, title="", show_all=False):
        self.title = title
        self.show_all = show_all
        self.items = []

    def ck(self, ok, label, detail=""):
        self.items.append((bool(ok), label, detail))
        return bool(ok)

    def section(self, name):
        self.items.append((None, name, ""))   # None = หัวข้อคั่น

    def report(self):
        for ok, label, detail in self.items:
            if ok is None:
                print("")
                print(label)
            else:
                mark = "OK  " if ok else "--  "
                line = f"{mark}{label}"
                if not ok and detail:
                    line += f"  ({detail})"
                print(line)
        n_ok = sum(1 for ok, _, _ in self.items if ok is True)
        n_no = sum(1 for ok, _, _ in self.items if ok is False)
        print("")
        print(f"@@RESULT {n_ok} {n_ok + n_no}")
        return n_ok, n_no


# ------------------------------------------------------------------
#  อ่านเนื้อหาในไฟล์ DOCX
# ------------------------------------------------------------------
def docx_text(path):
    """
    อ่านข้อความทั้งหมดในไฟล์ .docx
    รวมช่องว่างไว้ — ใช้ตรวจว่าข้อความตรงตามต้นฉบับไหม
    """
    with zipfile.ZipFile(path) as z:
        xml = z.read("word/document.xml").decode("utf-8")
    parts = re.findall(r"<w:t[^>]*>(.*?)</w:t>", xml, re.S)
    s = "".join(parts)
    for a, b in [("&amp;", "&"), ("&lt;", "<"), ("&gt;", ">"),
                 ("&quot;", '"'), ("&apos;", "'")]:
        s = s.replace(a, b)
    return s


def docx_nospace(path):
    """
    อ่านข้อความโดยตัดช่องว่างทิ้งทั้งหมด
    จำเป็นสำหรับภาษาไทย เพราะ Word/LibreOffice แยกสระออกเป็นหลายส่วน
    ทำให้การค้นข้อความต่อเนื่องแล้วไม่เจอ
    """
    return re.sub(r"\s+", "", docx_text(path))


def docx_xml(path):
    with zipfile.ZipFile(path) as z:
        return z.read("word/document.xml").decode("utf-8")


def docx_images(path):
    """รายชื่อไฟล์รูปทั้งหมดใน .docx"""
    with zipfile.ZipFile(path) as z:
        return [n for n in z.namelist() if n.startswith("word/media/")]


def docx_image_checksums(path):
    """checksum ของรูปแต่ละไฟล์ ใช้ตรวจว่ารูปแยกส่วนกันจริงหรือชนกัน"""
    import hashlib
    out = {}
    with zipfile.ZipFile(path) as z:
        for n in docx_images(path):
            out[n] = hashlib.sha1(z.read(n)).hexdigest()[:10]
    return out


def docx_pic_descrs(path):
    """ช่องคำอธิบาย (descr) ของรูปทั้งหมด — ตัวฉีดรูปจับคู่จากตรงนี้"""
    xml = docx_xml(path)
    return re.findall(r'<wp:docPr[^>]*descr="([^"]*)"', xml)


def docx_count(path, tag):
    """นับจำนวนแท็ก เช่น docx_count(p, 'w:tr') นับแถวในตาราง"""
    return docx_xml(path).count(f"<{tag}>")


# ------------------------------------------------------------------
#  ตรวจฟอนต์ใน PDF
# ------------------------------------------------------------------
def pdf_header(path, n=5):
    with open(path, "rb") as f:
        return f.read(n).decode("latin1", errors="ignore")


def pdf_has_font(path, *names):
    """ตรวจว่ามีชื่อฟอนต์ที่ระบุฝังอยู่ใน PDF หรือไม่"""
    with open(path, "rb") as f:
        raw = f.read()
    return any(n.encode() in raw for n in names)


def pdf_thai_chars(path):
    """นับจำนวนอักษรไทยใน PDF (ใช้ยืนยันว่าฟอนต์ฝังจริง ไม่ใช่ภาพ)"""
    try:
        import pypdf
        r = pypdf.PdfReader(path)
        return sum(1 for p in r.pages for c in (p.extract_text() or "")
                   if "\u0E00" <= c <= "\u0E7F")
    except Exception:
        return -1


def pdf_pages(path):
    try:
        import fitz
        return len(fitz.open(path))
    except Exception:
        return -1


def pdf_to_png(pdf, out_dir, prefix, dpi=105, max_pages=3):
    """แปลง PDF เป็นภาพ เพื่อให้ดูด้วยตา"""
    import fitz
    made = []
    d = fitz.open(pdf)
    for i in range(min(max_pages, len(d))):
        p = os.path.join(out_dir, f"{prefix}-{i + 1}.png")
        d[i].get_pixmap(dpi=dpi).save(p)
        made.append(p)
    return made, len(d)


# ------------------------------------------------------------------
#  ตรวจว่าค่าหนึ่งอยู่ในเอกสารหรือไม่ (รองรับภาษาไทย)
# ------------------------------------------------------------------
def contains(text, nospace, value):
    """ค่าอยู่ในเอกสารไหม — ลองทั้งแบบตรงตัวและแบบตัดช่องว่าง"""
    if value in text:
        return True
    v = re.sub(r"\s+", "", str(value))
    return bool(v) and v in nospace


def contains_ns(nospace, value):
    """
    เทียบโดยตัดช่องว่างทั้งสองฝั่ง
    ต้องใช้ฟังก์ชันนี้เมื่อเทียบข้อความ เพราะ Word แยกการเว้นวรรคเดิม
    ไว้คนละจุดกับที่ JSON ระบุ (เช่น "การท่องเที่ยว เพื่อ" vs "การท่องเที่ยวเพื่อ")
    ตัวช่วยนี้ป้องกันการรายงานผลผิดพลาด
    """
    v = re.sub(r"\s+", "", str(value))
    return bool(v) and v in nospace
