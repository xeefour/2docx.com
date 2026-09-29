# -*- coding: utf-8 -*-
"""
ทดสอบว่าเอกสารราชการที่ใช้ชื่อฟอนต์ "TH SarabunIT๙" แสดงผลถูกต้อง
โดยไม่ต้องแก้ชื่อฟอนต์ในไฟล์
"""
import os, re, json, zipfile, base64, subprocess, time
from docx import Document

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "output")
os.makedirs(OUT, exist_ok=True)

SRC = r"C:\Users\DOPA\Downloads\หนังสือรับรองเงินเดือน.docx"
TPL = os.path.join(OUT, "แม่แบบ-ไม่แก้ชื่อฟอนต์.docx")

REAL_TEXT = ("ตามที่ จังหวัดพิษณุโลก แจ้งว่ากรมการปกครองได้ส่งเงินจัดสรรงบประมาณ"
             "รายจ่ายประจำปี งบประมาณ พ.ศ. 2569 งบกลาง "
             "รายการเงินสำรองจ่ายเพื่อกรณีฉุกเฉินหรือจำเป็น "
             "สำหรับดำเนินโครงการสนับสนุนการลงทะเบียนเพื่อสวัสดิการแห่งรัฐ ปี 2569 "
             "โดยให้ที่ทำการปกครองอำเภอเร่งดำเนินการเบิกจ่ายงบประมาณ"
             "ให้เป็นไปตามระเบียบและหลักเกณฑ์ที่กำหนดโดยเร็ว")

BASE = "http://127.0.0.1:4000"
CURL = os.path.join(os.environ.get("SystemRoot", r"C:\Windows"), "System32", "curl.exe")


def ptext(pxml):
    parts = re.findall(r"<w:t(?:\s[^>]*)?>(.*?)</w:t>", pxml, re.S)
    s = "".join(parts)
    for a, b in [("&amp;", "&"), ("&lt;", "<"), ("&gt;", ">"),
                 ("&quot;", '"'), ("&apos;", "'")]:
        s = s.replace(a, b)
    return s


def curl_json(args):
    return subprocess.run([CURL, "-s"] + args, capture_output=True, text=True,
                          encoding="utf-8", errors="replace").stdout


print("=" * 68)
print(" ทดสอบ: เอกสารที่ใช้ชื่อฟอนต์ TH SarabunIT๙ (ไม่แก้ชื่อ)")
print("=" * 68)

# ---------- 1. เตรียมแม่แบบ: ใส่ {d.เนื้อหา} แต่ไม่แตะชื่อฟอนต์ ----------
tmp = TPL + ".tmp"
with zipfile.ZipFile(SRC) as zin, zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as zout:
    for item in zin.infolist():
        data = zin.read(item.filename)
        if item.filename == "word/document.xml":
            xml = data.decode("utf-8")

            def fix(m):
                para = m.group(0)
                if "{เนื้อหา}" not in ptext(para):
                    return para
                return re.sub(r'(<w:t(?:\s[^>]*)?)>(เนื้อหา)(</w:t>)',
                              r'\1>d.\2\3', para)

            xml = re.sub(r"<w:p(?:\s[^>]*)?>.*?</w:p>", fix, xml, flags=re.S)
            data = xml.encode("utf-8")
        zout.writestr(item, data)
os.replace(tmp, TPL)

# ตรวจว่าชื่อฟอนต์ยังเป็นของเดิม
with zipfile.ZipFile(TPL) as z:
    fx = z.read("word/fontTable.xml").decode("utf-8")
    dx = z.read("word/document.xml").decode("utf-8")
names = re.findall(r'<w:font w:name="([^"]+)"', fx)
print("\n[1] ฟอนต์ในแม่แบบ (ไม่ได้แก้)")
for n in names:
    print(f"      - {n}")
has_it9 = any("SarabunIT" in n for n in names)
print(f"    ยังใช้ชื่อ TH SarabunIT๙ อยู่: {'ใช่' if has_it9 else 'ไม่'}")
print(f"    เปลี่ยนเป็น d.เนื้อหา แล้ว: {'ใช่' if 'd.เนื้อหา' in dx else 'ไม่'}")

# ---------- 2. อัปโหลดและสร้าง PDF ----------
print("\n[2] สร้าง PDF ผ่าน Carbone")
up = os.path.join(OUT, "_up.json")
subprocess.run([CURL, "-s", "-o", up, "-X", "POST", f"{BASE}/template",
                "-H", "Authorization: Bearer carbon-ce",
                "-F", f"template=@{TPL}", "--max-time", "180"], capture_output=True)
tpl_id = json.load(open(up, encoding="utf-8"))["data"]["templateId"]
print(f"    templateId: {tpl_id[:16]}...")

pf = os.path.join(OUT, "_pf.json")
with open(pf, "w", encoding="utf-8") as f:
    json.dump({"data": {"เนื้อหา": REAL_TEXT}, "convertTo": "pdf"},
              f, ensure_ascii=False)

pdf = os.path.join(OUT, "ผลลัพธ์-ไม่แก้ชื่อฟอนต์.pdf")
t0 = time.time()
subprocess.run([CURL, "-s", "-o", pdf, "-X", "POST",
                f"{BASE}/render/{tpl_id}?download=true",
                "-H", "Authorization: Bearer carbon-ce",
                "-H", "Content-Type: application/json",
                "-H", "carbone-version: 5",
                "--data-binary", f"@{pf}", "--max-time", "300"],
               capture_output=True)
dt = time.time() - t0

size = os.path.getsize(pdf)
head = open(pdf, "rb").read(5).decode("latin1")
print(f"    PDF: {size:,} bytes  head='{head}'  ({dt:.1f} วิ)")

# ---------- 3. ตรวจว่าฟอนต์ถูกฝังและไม่ใช่ฟอนต์สำรอง ----------
print("\n[3] ตรวจฟอนต์ใน PDF")
raw = open(pdf, "rb").read()
found = []
for k in [b"THSarabunPSK", b"THSarabunIT", b"SarabunNew", b"THSarabunPSK,THSarabunIT",
          b"Laksaman", b"Tlwg", b"NotoSansThai", b"Garuda"]:
    if k in raw:
        found.append(k.decode())
if found:
    print(f"    พบฟอนต์: {', '.join(found)}")
else:
    print("    ไม่พบชื่อฟอนต์ (อาจฝังแบบ subset)")

# ---------- 4. นับอักษรไทย ----------
try:
    import pypdf
    r = pypdf.PdfReader(pdf)
    text = "\n".join(p.extract_text() or "" for p in r.pages)
    thai = sum(1 for ch in text if "\u0E00" <= ch <= "\u0E7F")
    print(f"    จำนวนหน้า: {len(r.pages)}  อักษรไทย: {thai:,}")
    print(f"    เนื้อหาถูกแทน: {'ใช่' if 'กรมการปกครอง' in text or 'สวัสดิการ' in text else 'ตรวจจากภาพ'}")
    # ตรวจว่าไม่มีกล่องสี่เหลี่ยม (ถ้าฟอนต์หาย LibreOffice จะแสดงเป็นสี่เหลี่ยม)
    print(f"    ข้อความ 120 ตัวแรก: {repr(text[:120])}")
except Exception as e:
    print(f"    อ่านข้อความไม่ได้: {e}")

# ---------- 5. ภาพ ----------
png = os.path.join(OUT, "ผลลัพธ์-ฟอนต์-เดิม.png")
try:
    import fitz
    d = fitz.open(pdf)
    d[0].get_pixmap(dpi=105).save(png)
    print(f"\n[4] ภาพ: {png}")
except Exception as e:
    print(f"    สร้างภาพไม่ได้: {e}")

print("\n" + "=" * 68)
