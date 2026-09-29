# -*- coding: utf-8 -*-
"""
เตรียมแม่แบบ 2 เวอร์ชัน เพื่อเทียบผลการกระจายย่อหน้า

  A: ไม่เปลี่ยนอะไร  (ย่อหน้าเนื้อหาไม่มี jc = ค่าเริ่มต้น = ชิดซ้าย)
  B: ตั้ง thaiDistribute ให้ย่อหน้าเนื้อหา  (แบบที่เอกสารราชการไทยใช้)

ทดสอบว่า LibreOffice รักษาค่า thaiDistribute ไว้หรือเปลี่ยนเป็นค่าอื่น
"""
import os, re, shutil, zipfile

BASE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(BASE, "templates", "หนังสือรับรอง.docx")
OUTD = os.path.join(BASE, "output")
os.makedirs(OUTD, exist_ok=True)

THAI_DISTRIBUTE = 'thaiDistribute'


def para_text(para_xml):
    """
    ดึงข้อความจาก <w:p> โดยรวมทุก <w:t> เข้าด้วยกัน

    จำเป็นมาก เพราะ Word แบ่งข้อความเป็นหลาย run
    เช่น "{d.เนื้อหา}" อาจเป็น 3 runs: "{" + "เนื้อหา" + "}"
    ถ้าค้นหา "{d.เนื้อหา}" ใน XML ตรง ๆ จะไม่เจอ
    """
    parts = re.findall(r"<w:t(?:\s[^>]*)?>(.*?)</w:t>", para_xml, re.S)
    s = "".join(parts)
    for a, b in [("&amp;", "&"), ("&lt;", "<"), ("&gt;", ">"),
                 ("&quot;", '"'), ("&apos;", "'")]:
        s = s.replace(a, b)
    return s


def set_jc_on_marker(src, out, jc_value, label):
    """ตั้งค่า jc ให้ย่อหน้าที่มี {เนื้อหา}"""
    changed = 0
    tmp = out + ".tmp"
    with zipfile.ZipFile(src) as zin, zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as zout:
        for item in zin.infolist():
            data = zin.read(item.filename)
            if item.filename == "word/document.xml":
                xml = data.decode("utf-8")
                # หา <w:p> ที่มี {เนื้อหา}
                def fix(m):
                    nonlocal changed
                    para = m.group(0)
                    # ต้องรวม <w:t> ทั้งหมดก่อน จึงจะเจอ "{d.เนื้อหา}"
                    if "{d.เนื้อหา}" not in para_text(para):
                        return para
                    changed += 1
                    # แทนที่ jc เดิม (ถ้ามี) หรือเพิ่มเข้าไปใน w:pPr
                    if "<w:pPr>" in para or "<w:pPr/>" in para:
                        if re.search(r'<w:jc w:val="[^"]*"/>', para):
                            para = re.sub(r'<w:jc w:val="[^"]*"/>',
                                          f'<w:jc w:val="{jc_value}"/>', para, count=1)
                        else:
                            para = para.replace("<w:pPr>",
                                                f'<w:pPr><w:jc w:val="{jc_value}"/>', 1)
                            para = para.replace("<w:pPr/>",
                                                f'<w:pPr><w:jc w:val="{jc_value}"/></w:pPr>', 1)
                    else:
                        # ไม่มี pPr — ต้องสร้าง
                        para = re.sub(r"(<w:p(?:\s[^>]*)?>)",
                                      rf'\1<w:pPr><w:jc w:val="{jc_value}"/></w:pPr>',
                                      para, count=1)
                    return para
                # รองรับทั้ง <w:p> และ <w:p ...> (มี attribute)
                xml = re.sub(r"<w:p(?:\s[^>]*)?>.*?</w:p>", fix, xml, flags=re.S)
                data = xml.encode("utf-8")
            zout.writestr(item, data)
    os.replace(tmp, out)
    print(f"  {label}: แก้ {changed} ย่อหน้า -> jc={jc_value}")
    return out


print("=" * 66)
print(" เตรียมแม่แบบเพื่อทดสอบการกระจายย่อหน้า")
print("=" * 66)

# ---------- เวอร์ชัน A: ไม่เปลี่ยน ----------
a = os.path.join(OUTD, "แม่แบบ-A-ไม่กระจาย.docx")
shutil.copy2(SRC, a)
print("\nสร้างแม่แบบ:")

# ---------- เวอร์ชัน B: thaiDistribute ----------
b = os.path.join(OUTD, "แม่แบบ-B-thaiDistribute.docx")
set_jc_on_marker(SRC, b, THAI_DISTRIBUTE, "B")

# ---------- เวอร์ชัน C: กระจายสองข้าง (both) ----------
c = os.path.join(OUTD, "แม่แบบ-C-both.docx")
set_jc_on_marker(SRC, c, "both", "C")

print()
print("=" * 66)
print(" ยืนยันการตั้งค่า")
print("=" * 66)

for label, path in [("A ไม่กระจาย      ", a),
                    ("B thaiDistribute  ", b),
                    ("C both            ", c)]:
    with zipfile.ZipFile(path) as z:
        xml = z.read("word/document.xml").decode("utf-8")
    paras = re.findall(r"<w:p(?:\s[^>]*)?>.*?</w:p>", xml, re.S)
    found = []
    for px in paras:
        if "{d.เนื้อหา}" in para_text(px):
            m = re.search(r'<w:jc w:val="([^"]+)"', px)
            found.append(m.group(1) if m else "(ค่าเริ่มต้น)")
    # นับ thaiDistribute ทั้งไฟล์
    n_td = len(re.findall(r'<w:jc w:val="thaiDistribute"', xml))
    print(f"  {label} ย่อหน้าเนื้อหา = {found[0] if found else '?'}"
          f"   (thaiDistribute ทั้งไฟล์: {n_td})")

print()
print("พร้อมทดสอบ")
