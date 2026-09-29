# -*- coding: utf-8 -*-
"""
รันเอกสารทดสอบหัวกระดาษ + เลขหน้าอัตโนมัติผ่าน Carbone
แล้วตรวจทุกหน้าว่าหัว/ท้ายปรากฏถูกต้องไหม
"""
import os, re, sys, json, base64, subprocess, time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "lib"))
from helper import Checker, docx_text, docx_nospace, contains_ns, \
    pdf_header, pdf_thai_chars, pdf_pages

TPL = os.path.join(HERE, "templates", "หัวกระดาษ-เลขหน้า.docx")
DATA = os.path.join(HERE, "data", "ข้อมูล.json")
OUTD = os.path.join(HERE, "output")
os.makedirs(OUTD, exist_ok=True)

BASE = "http://127.0.0.1:4000"
CURL = os.path.join(os.environ.get("SystemRoot", r"C:\Windows"), "System32", "curl.exe")

c = Checker()
data = json.load(open(DATA, encoding="utf-8"))


def curl(args):
    return subprocess.run([CURL, "-s"] + args, capture_output=True, text=True,
                          encoding="utf-8", errors="replace").stdout


# ------------------------------------------------------------------
#  1. ตรวจแม่แบบมีส่วนหัว/ท้ายและฟิลด์เลขหน้าจริงไหม
# ------------------------------------------------------------------
c.section("1. ตรวจโครงสร้างแม่แบบ")
import zipfile
with zipfile.ZipFile(TPL) as z:
    names = z.namelist()
    hdrs = [n for n in names if re.search(r"word/header\d*\.xml", n)]
    ftrs = [n for n in names if re.search(r"word/footer\d*\.xml", n)]
    doc_xml = z.read("word/document.xml").decode("utf-8")
    fx = z.read("word/fontTable.xml").decode("utf-8")

c.ck(len(hdrs) > 0, f"มีไฟล์ส่วนหัว ({len(hdrs)} ไฟล์)")
c.ck(len(ftrs) > 0, f"มีไฟล์ส่วนท้าย ({len(ftrs)} ไฟล์)")

if ftrs:
    with zipfile.ZipFile(TPL) as z:
        fxml = z.read(ftrs[0]).decode("utf-8")
    c.ck("PAGE" in fxml, "ส่วนท้ายมีฟิลด์ PAGE (เลขหน้าปัจจุบัน)")
    c.ck("NUMPAGES" in fxml, "ส่วนท้ายมีฟิลด์ NUMPAGES (จำนวนหน้าทั้งหมด)")
    c.ck('w:fldCharType="begin"' in fxml, "ฟิลด์ถูกประกาศแบบถูกต้อง (fldChar begin)")

if hdrs:
    with zipfile.ZipFile(TPL) as z:
        hxml = z.read(hdrs[0]).decode("utf-8")
    c.ck("d.หน่วยงาน" in hxml, "ส่วนหัวมีตัวแปร {d.หน่วยงาน}")
    c.ck("w:pBdr" in hxml, "ส่วนหัวมีเส้นคั่น")

# ตรวจว่าเนื้อหาหลักใช้ฟอนต์ไทย (fontTable อาจไม่ประกาศเพราะอิงจาก Normal style)
c.ck("Sarabun" in doc_xml or "Sarabun" in fx,
     "เนื้อหาหลักใช้ฟอนต์ TH Sarabun")

# ------------------------------------------------------------------
#  2. ส่งผ่าน Carbone
# ------------------------------------------------------------------
c.section("2. สร้างเอกสารผ่าน Carbone")

up = os.path.join(OUTD, "_up.json")
subprocess.run([CURL, "-s", "-o", up, "-X", "POST", f"{BASE}/template",
                "-H", "Authorization: Bearer carbon-ce",
                "-F", f"template=@{TPL}", "--max-time", "180"], capture_output=True)
try:
    tpl_id = json.load(open(up, encoding="utf-8"))["data"]["templateId"]
except Exception:
    tpl_id = None
c.ck(tpl_id is not None, "อัปโหลดแม่แบบได้")
if not tpl_id:
    c.report()
    sys.exit(1)

pf = os.path.join(OUTD, "_pf.json")
docx_out = os.path.join(OUTD, "ผลลัพธ์.docx")
pdf_out = os.path.join(OUTD, "ผลลัพธ์.pdf")

for fmt, out in (("docx", docx_out), ("pdf", pdf_out)):
    with open(pf, "w", encoding="utf-8") as f:
        json.dump({"data": data, "convertTo": fmt}, f, ensure_ascii=False)
    t0 = time.time()
    subprocess.run([CURL, "-s", "-o", out, "-X", "POST",
                    f"{BASE}/render/{tpl_id}?download=true",
                    "-H", "Authorization: Bearer carbon-ce",
                    "-H", "Content-Type: application/json",
                    "-H", "carbone-version: 5",
                    "--data-binary", f"@{pf}", "--max-time", "300"],
                   capture_output=True)
    dt = time.time() - t0
    sz = os.path.getsize(out) if os.path.exists(out) else 0
    print(f"    {fmt}: {sz:,} bytes  ({dt:.1f} วิ)")
    c.ck(sz > 5000, f"ได้ไฟล์ {fmt}")

c.ck(pdf_header(pdf_out).startswith("%PDF-"), "PDF มีโครงสร้างถูกต้อง")

# ------------------------------------------------------------------
#  3. ตรวจเนื้อหาหลัก
# ------------------------------------------------------------------
c.section("3. ตรวจเนื้อหาเอกสาร")
ns = docx_nospace(docx_out)
for k, v in data.items():
    if k == "หน่วยงาน":
        continue   # อยู่ในส่วนหัว ตรวจแยกข้างล่าง
    c.ck(contains_ns(ns, v), f"แทนค่า {k}")

# ------------------------------------------------------------------
#  4. ตรวจส่วนหัว/ท้ายในไฟล์ผลลัพธ์
# ------------------------------------------------------------------
c.section("4. ตรวจส่วนหัวและท้ายหลังผ่าน Carbone")
with zipfile.ZipFile(docx_out) as z:
    out_names = z.namelist()
    out_hdrs = [n for n in out_names if re.search(r"word/header\d*\.xml", n)]
    out_ftrs = [n for n in out_names if re.search(r"word/footer\d*\.xml", n)]
    fxml2 = z.read(out_ftrs[0]).decode("utf-8") if out_ftrs else ""
    hxml2 = z.read(out_hdrs[0]).decode("utf-8") if out_hdrs else ""

c.ck(len(out_hdrs) > 0, f"ส่วนหัวยังอยู่ในไฟล์ผลลัพธ์ ({len(out_hdrs)})")
c.ck(len(out_ftrs) > 0, f"ส่วนท้ายยังอยู่ในไฟล์ผลลัพธ์ ({len(out_ftrs)})")
c.ck("PAGE" in fxml2, "ฟิลด์ PAGE ไม่ถูกลบ")
c.ck("NUMPAGES" in fxml2, "ฟิลด์ NUMPAGES ไม่ถูกลบ")
c.ck(data["หน่วยงาน"] in hxml2, "ชื่อหน่วยงานถูกแทนค่าในส่วนหัว")

# ------------------------------------------------------------------
#  5. ตรวจจาก PDF จริง — หัว/ท้ายครบทุกหน้าไหม
# ------------------------------------------------------------------
c.section("5. ตรวจจาก PDF จริง")
import fitz

doc = fitz.open(pdf_out)
n = len(doc)
c.ck(n >= 3, f"PDF มี {n} หน้า (ควร 3 หน้าขึ้นไป)")

hdr_ok, ftr_ok, pageno = 0, 0, []
unit = re.sub(r"\s+", "", data["หน่วยงาน"])

for i, page in enumerate(doc, 1):
    txt = re.sub(r"\s+", "", page.get_text())

    # 5.1 ส่วนหัวปรากฏบนหน้านี้ไหม
    has_hdr = unit in txt
    if has_hdr:
        hdr_ok += 1
    else:
        print(f"    หน้า {i}: ไม่พบชื่อหน่วยงานในส่วนหัว")

    # 5.2 เลขหน้า
    m = re.search(r"หน้า(\d+)จาก(\d+)หน้า", txt)
    if m:
        pageno.append((i, int(m.group(1)), int(m.group(2))))
        ftr_ok += 1
    else:
        print(f"    หน้า {i}: ไม่พบรูปแบบ 'หน้า N จาก M หน้า'")

c.section("6. ผลการตรวจทุกหน้า")
print(f"    หัวกระดาษปรากฏ: {hdr_ok}/{n} หน้า")
print(f"    ท้ายเอกสารปรากฏ: {ftr_ok}/{n} หน้า")
print(f"    เลขหน้าที่อ่านได้: {pageno}")
print()

c.ck(hdr_ok == n, f"ส่วนหัวแสดงครบทุกหน้า ({hdr_ok}/{n})")
c.ck(ftr_ok == n, f"ส่วนท้ายแสดงครบทุกหน้า ({ftr_ok}/{n})")

if len(pageno) == n:
    nums = [p[1] for p in pageno]
    c.ck(nums == list(range(1, n + 1)),
         f"เลขหน้าเรียงถูกต้อง 1-{n}", f"ได้ {nums}")
    totals = {p[2] for p in pageno}
    c.ck(totals == {n},
         f"จำนวนหน้าทั้งหมด = {n} ทุกหน้า", f"ได้ {totals}")
else:
    c.ck(False, f"อ่านเลขหน้าได้ครบทุกหน้า ({len(pageno)}/{n})")

thai = pdf_thai_chars(pdf_out)
c.ck(thai > 300, f"อักษรไทยใน PDF {thai:,} ตัว")

# ---------- ภาพทุกหน้า ----------
c.section("7. ภาพตรวจสอบ")
made = []
for i in range(min(n, 4)):
    p = os.path.join(OUTD, f"หน้า{i+1}.png")
    doc[i].get_pixmap(dpi=100).save(p)
    made.append(p)
print(f"    สร้างภาพ {len(made)} หน้า: {made[0]}")
if len(made) > 1:
    print(f"    {made[1]}")

print()
print(f"ผลลัพธ์: {pdf_out}")
c.report()
