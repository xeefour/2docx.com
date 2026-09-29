# -*- coding: utf-8 -*-
"""
สร้างแม่แบบหนังสือรับรอง จากไฟล์ต้นฉบับของผู้ใช้
โดย
  1. เปลี่ยนชื่อฟอนต์ "TH SarabunIT๙" เป็น "TH Sarabun PSK" (ที่ container มีติดตั้ง)
  2. ใส่ตัวแปร {d.เนื้อหา} ในตำแหน่งที่เหมาะสม
  3. เพิ่มตัวแปรสำหรับวันที่/เลขที่ เพื่อทดสอบ
  4. เก็บการตั้งค่า thaiDistribute ไว้ทั้งหมด (จุดที่ต้องทดสอบ)

ไม่แก้ไขไฟล์ต้นฉบับ — เขียนไฟล์ใหม่เสมอ
"""
import os, re, shutil, zipfile

SRC = r"C:\Users\DOPA\Downloads\หนังสือรับรองเงินเดือน.docx"
OUT_DIR = r"D:\2docx.com\tests\part-09-thai-distribute"
os.makedirs(os.path.join(OUT_DIR, "templates"), exist_ok=True)
os.makedirs(os.path.join(OUT_DIR, "output"), exist_ok=True)
OUT = os.path.join(OUT_DIR, "templates", "หนังสือรับรอง.docx")

OLD_FONT = "TH SarabunIT๙"   # ชื่อฟอนต์ที่ใช้ในต้นฉบับ (ไม่มีในระบบ)
NEW_FONT = "TH Sarabun PSK"   # ฟอนต์ที่ติดตั้งใน container แล้ว

# เนื้อหาจริงที่ผู้ใช้ให้มา
REAL_TEXT = ("ตามที่ จังหวัดพิษณุโลก แจ้งว่ากรมการปกครองได้ส่งเงินจัดสรรงบประมาณ"
             "รายจ่ายประจำปี งบประมาณ พ.ศ. 2569 งบกลาง "
             "รายการเงินสำรองจ่ายเพื่อกรณีฉุกเฉินหรือจำเป็น "
             "สำหรับดำเนินโครงการสนับสนุนการลงทะเบียนเพื่อสวัสดิการแห่งรัฐ ปี 2569 "
             "โดยให้ที่ทำการปกครองอำเภอเร่งดำเนินการเบิกจ่ายงบประมาณ"
             "ให้เป็นไปตามระเบียบและหลักเกณฑ์ที่กำหนดโดยเร็ว")

# ---------- 1. คัดลอกไฟล์ ----------
shutil.copy2(SRC, OUT)

# ---------- 2. แก้ไข XML ภายใน ----------
tmp = OUT + ".tmp"
changed = {"font": 0, "jc_thai": 0, "jc_other": 0, "marker": 0}

with zipfile.ZipFile(OUT) as zin:
    items = zin.infolist()
    with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as zout:
        for item in items:
            data = zin.read(item.filename)
            if item.filename.endswith(".xml") and b"Sarabun" in data:
                txt = data.decode("utf-8")

                # 2.1 เปลี่ยนชื่อฟอนต์
                n = txt.count(OLD_FONT)
                if n:
                    txt = txt.replace(OLD_FONT, NEW_FONT)
                    changed["font"] += n

                # 2.2 นับการกระจายย่อหน้า
                changed["jc_thai"] += len(re.findall(r'<w:jc w:val="thaiDistribute"', txt))
                changed["jc_other"] += len(re.findall(r'<w:jc w:val="(?:both|distribute)"', txt))

                data = txt.encode("utf-8")
            zout.writestr(item, data)

os.replace(tmp, OUT)

print("=" * 62)
print(" สร้างแม่แบบหนังสือรับรอง")
print("=" * 62)
print(f"ต้นฉบับ : {os.path.basename(SRC)}")
print(f"ผลลัพธ์: {os.path.basename(OUT)}")
print()
print(f"  เปลี่ยนชื่อฟอนต์ {OLD_FONT} -> {NEW_FONT}: {changed['font']} จุด")
print(f"  พบ thaiDistribute: {changed['jc_thai']} ย่อหน้า")
print(f"  พบ distribute/both: {changed['jc_other']} ย่อหน้า")

# ---------- 3. ตรวจชื่อฟอนต์หลังแก้ ----------
with zipfile.ZipFile(OUT) as z:
    ft = z.read("word/fontTable.xml").decode("utf-8")
    doc_xml = z.read("word/document.xml").decode("utf-8")

names = re.findall(r'<w:font w:name="([^"]+)"', ft)
print()
print("  ฟอนต์ที่ประกาศหลังแก้:")
for n in names:
    print(f"    - {n}")

# ตรวจว่ายังเหลือชื่อฟอนต์เก่าไหม
if OLD_FONT in doc_xml or OLD_FONT in ft:
    print(f"\n  !! ยังเหลือชื่อฟอนต์เก่าใน document.xml")
else:
    print(f"\n  ไม่เหลือชื่อฟอนต์เก่าใน document.xml")

# ---------- 3. แก้ที่ค่าตัวแปรให้เป็นไวยากรณ์ Carbone ----------
# ต้นฉบับใช้ {เนื้อหา} ซึ่งเป็นเพียงข้อความธรรมดา ไม่ใช่แท็กของ Carbone
# ต้องเปลี่ยนเป็น {d.เนื้อหา} จึงจะถูกแทนค่าได้
# ต้นฉบับแยกข้อความเป็นหลาย <w:t> จึงต้องรวมก่อนค้นหา
tmp2 = OUT + ".tmp2"
_counter = [0]  # ใช้ list เพราะ nonlocal ใช้ไม่ได้ที่ระดับ module

def ptext(pxml):
    parts = re.findall(r"<w:t(?:\s[^>]*)?>(.*?)</w:t>", pxml, re.S)
    s = "".join(parts)
    for a, b in [("&amp;", "&"), ("&lt;", "<"), ("&gt;", ">"),
                 ("&quot;", '"'), ("&apos;", "'")]:
        s = s.replace(a, b)
    return s

with zipfile.ZipFile(OUT) as zin, zipfile.ZipFile(tmp2, "w", zipfile.ZIP_DEFLATED) as zout:
    for item in zin.infolist():
        data = zin.read(item.filename)
        if item.filename == "word/document.xml":
            xml = data.decode("utf-8")

            def fix_marker(m):
                para = m.group(0)
                if "{เนื้อหา}" not in ptext(para):
                    return para
                _counter[0] += 1
                # เขียนทับ <w:t> ที่มีข้อความ "เนื้อหา" ให้เป็น d.เนื้อหา
                # (เก็บวงเล็บ { } ไว้เป็นคนละ run ตามเดิม)
                para = re.sub(
                    r'(<w:t(?:\s[^>]*)?)>(เนื้อหา)(</w:t>)',
                    r'\1>d.\2\3', para)
                return para

            xml = re.sub(r"<w:p(?:\s[^>]*)?>.*?</w:p>", fix_marker, xml, flags=re.S)
            data = xml.encode("utf-8")
        zout.writestr(item, data)

os.replace(tmp2, OUT)
print(f"  แก้ตัวแปร {{เนื้อหา}} -> {{d.เนื้อหา}}: {_counter[0]} ย่อหน้า")

# ---------- 4. ยืนยัน ----------
with zipfile.ZipFile(OUT) as z:
    doc_xml = z.read("word/document.xml").decode("utf-8")

paras = re.findall(r"<w:p(?:\s[^>]*)?>.*?</w:p>", doc_xml, re.S)
for px in paras:
    if "เนื้อหา" in ptext(px):
        print(f"  ยืนยัน: พบ '{ptext(px).strip()[:30]}'")

print()
print("=" * 62)

# ---------- 4. เขียนข้อมูลทดสอบ ----------
import json
data = {
    "เนื้อหา": REAL_TEXT,
    "วันที่": "29",
    "เดือน": "กันยายน",
    "ปี": "2569",
    "เลขที่": "๘๕/๒๕๖๙",
}
dp = os.path.join(OUT_DIR, "data", "ข้อมูล.json")
os.makedirs(os.path.dirname(dp), exist_ok=True)
with open(dp, "w", encoding="utf-8") as f:
    json.dump(data, f, ensure_ascii=False, indent=2)
print(f"ข้อมูลทดสอบ: {dp}")
print(f"  เนื้อหา {len(REAL_TEXT)} ตัวอักษร")
print(f"  ตัวอักษรไทย {sum(1 for c in REAL_TEXT if '\u0E00' <= c <= '\u0E7F')} ตัว")
