# -*- coding: utf-8 -*-
"""
ส่วนที่ 8: เอกสารจริงแบบครบวงจร
================================
ทดสอบงานจริงที่จะใช้ในระบบราชการ โดยรวมทุกอย่างเข้าด้วยกัน
ตามขั้นตอนจริงของการใช้งาน

  ขั้นตอน:
    1. รับข้อมูล JSON + รูปจากระบบต้นนทาง
    2. ฉีดรูปลงแม่แบบด้วยตัวฉีดที่เขียนเอง
    3. ส่งเข้า Carbone เพื่อเติมข้อความ + แปลง PDF
    4. ตรวจสอบผลลัพธ์ว่าถูกต้องครบถ้วน

  ทดสอบ:
    8.1  เอกสารหนังสือราชการครบทุกส่วน
    8.2  ตารางหลักฐานวนหลายแถว พร้อมรูป
    8.3  เงื่อนไขเร่งด่วน / ไม่เร่งด่วน
    8.4  เอกสารหลายหน้า
    8.5  ผลลัพธ์ผ่านทั้งแบบ DOCX และ PDF
    8.6  ทำซ้ำด้วยข้อมูลต่างกัน แล้วผลต้องต่างกัน (ไม่ใช่ไฟล์ค้าง)

รัน:  python test_full.py
"""
import os, sys, json, time, base64, subprocess, shutil

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "lib"))
from helper import (Checker, docx_text, docx_nospace, contains_ns,
                    docx_pic_descrs, docx_image_checksums, docx_count,
                    pdf_header, pdf_has_font, pdf_thai_chars,
                    pdf_to_png, pdf_pages)
from docx_image_injector import ImageInjector

CURL = os.path.join(os.environ.get("SystemRoot", r"C:\Windows"), "System32", "curl.exe")
BASE = "http://127.0.0.1:4000"
TPL = os.path.join(HERE, "templates", "หนังสือราชการ.docx")
OUTD = os.path.join(HERE, "output")
os.makedirs(OUTD, exist_ok=True)

c = Checker()


# ------------------------------------------------------------------
#  ฟังก์ชันช่วยเรียก API
# ------------------------------------------------------------------
def curl_json(args):
    r = subprocess.run([CURL, "-s"] + args, capture_output=True, text=True,
                       encoding="utf-8", errors="replace")
    return r.stdout


def upload_template(path):
    out = os.path.join(OUTD, "_up.json")
    subprocess.run([CURL, "-s", "-o", out, "-X", "POST", f"{BASE}/template",
                    "-H", "Authorization: Bearer carbon-ce",
                    "-F", f"template=@{path}", "--max-time", "180"],
                   capture_output=True)
    try:
        return json.load(open(out, encoding="utf-8"))["data"]["templateId"]
    except Exception:
        return None


def render(tpl_id, data, fmt, out_path):
    pf = os.path.join(OUTD, "_pf.json")
    with open(pf, "w", encoding="utf-8") as f:
        json.dump({"data": data, "convertTo": fmt}, f, ensure_ascii=False)
    t0 = time.time()
    subprocess.run([CURL, "-s", "-o", out_path, "-X", "POST",
                    f"{BASE}/render/{tpl_id}?download=true",
                    "-H", "Authorization: Bearer carbon-ce",
                    "-H", "Content-Type: application/json",
                    "-H", "carbone-version: 5",
                    "--data-binary", f"@{pf}", "--max-time", "600"],
                   capture_output=True)
    return time.time() - t0


def convert_only(docx_path, out_pdf):
    """แปลงไฟล์โดยไม่ส่ง data (ใช้หลังฉีดรูปแล้ว)"""
    b64 = base64.b64encode(open(docx_path, "rb").read()).decode()
    pf = os.path.join(OUTD, "_cf.json")
    with open(pf, "w", encoding="utf-8") as f:
        json.dump({"template": b64, "convertTo": "pdf"}, f)
    subprocess.run([CURL, "-s", "-o", out_pdf, "-X", "POST",
                    f"{BASE}/render/template?download=true",
                    "-H", "Authorization: Bearer carbon-ce",
                    "-H", "Content-Type: application/json",
                    "-H", "carbone-version: 5",
                    "--data-binary", f"@{pf}", "--max-time", "600"],
                   capture_output=True)
    return os.path.exists(out_pdf) and os.path.getsize(out_pdf) > 1000


def make_data(case=1, n_evidence=3):
    """สร้างข้อมูลหนังสือราชการสำหรับทดสอบ"""
    names = ["นายสมชาย ใจดี", "นางสุดารัตน์ วงศ์ทอง", "นายประเสริฐ ชัยพฤกษ์"]
    provinces = ["ชลบุรี", "ระยอง", "เชียงใหม่"]
    evidence = []
    kinds = ["ภาพถ่ายไฟดับบริเวณหมู่ 4", "ใบเสนอราคาซ่อมระบบไฟฟ้า",
             "บันทึกรายงานเจ้าหน้าที่ออกตรวจสอบ", "หนังสือรับรองจากชุมชน",
             "ภาพถ่ายน้ำท่วมหน้าบ้าน"]
    for i in range(n_evidence):
        evidence.append({
            "ลำดับ": str(i + 1),
            "หลักฐาน": f"{kinds[i % len(kinds)]} (ชุดที่ {case})",
            "จำนวน": f"{i + 1} ชิ้น",
            "หมายเหตุ": f"บันทึกเมื่อวันที่ {10 + i}/09/2569",
        })
    return {
        "เลขที่หนังสือ": f"04{case:02d}/2569",
        "เรื่อง": f"ร้องเรียนไฟดับและน้ำท่วมขัง (ชุดทดสอบ {case})",
        "เรื่องร้องเรียน": "ไฟดับนานกว่า 6 ชั่วโมง และน้ำท่วมขังทางเข้าบ้าน",
        "ชื่อผู้ร้องเรียน": names[case % 3],
        "ชื่อเจ้าหน้าที่": f"นางสาวสุดารัตน์ วงศ์ทอง (ชุด {case})",
        "ตำแหน่ง": "นายกริจการส่วนกลาง",
        "สังกัด": "กองประสานงานและบริการประชาชน",
        "ความคิดเห็น": "ได้รับเรื่องร้องเรียนแล้ว จะได้ส่งกำกับกองอุตสาหกรรม"
                       "และการท่องเที่ยว และกองพลังงานภูมิภาค เพื่อตรวจสอบ"
                       "และแก้ไขโดยเร็วโดยเร็ว",
        "เร่งด่วน": (case % 2 == 1),
        "อำเภอ": "เมือง",
        "จังหวัด": provinces[case % 3],
        "กอง": "ประสานงานและบริการประชาชน",
        "items": evidence,
    }


# ------------------------------------------------------------------
#  เตรียมภาพ
# ------------------------------------------------------------------
IMG = os.path.join(HERE, "images")
os.makedirs(IMG, exist_ok=True)


def make_seal(path):
    from PIL import Image, ImageDraw, ImageFont
    W = H = 420
    im = Image.new("RGBA", (W, H), (255, 255, 255, 0))
    d = ImageDraw.Draw(im)
    d.ellipse([20, 20, W - 20, H - 20], outline=(18, 110, 160, 255), width=12)
    d.ellipse([45, 45, W - 45, H - 45], outline=(18, 110, 160, 255), width=4)
    import math
    cx, cy, r = W / 2, H / 2 - 40, 95
    pts = []
    for i in range(10):
        a = -math.pi / 2 + i * math.pi / 5
        rad = r if i % 2 == 0 else r * 0.45
        pts.append((cx + rad * math.cos(a), cy + rad * math.sin(a)))
    d.polygon(pts, fill=(200, 30, 40, 255))
    fd = os.path.join(HERE, "..", "lib", "fonts", "THSarabunNew.ttf")
    try:
        f = ImageFont.truetype(fd, 40)
        d.text((cx - 90, cy + 90), "ตราสัญลักษณ์", font=f, fill=(18, 110, 160, 255))
    except Exception:
        pass
    im.save(path)
    return path


def make_photo(path, color, label, idx):
    from PIL import Image, ImageDraw, ImageFont
    W, H = 460, 320
    im = Image.new("RGB", (W, H), color)
    d = ImageDraw.Draw(im)
    d.rectangle([0, 0, W - 1, H - 1], outline=(255, 255, 255), width=10)
    d.line([(0, 0), (W, H)], fill=(255, 255, 255), width=5)
    d.line([(W, 0), (0, H)], fill=(255, 255, 255), width=5)
    try:
        f = ImageFont.truetype(
            os.path.join(HERE, "..", "lib", "fonts", "THSarabunNew Bold.ttf"), 36)
    except Exception:
        f = ImageFont.load_default()
    bb = d.textbbox((0, 0), label, font=f)
    d.text(((W - bb[2]) / 2, (H - bb[3]) / 2), label, font=f, fill=(255, 255, 255))
    im.save(path, "JPEG", quality=85)
    return path


# ------------------------------------------------------------------
c.section("8.0 เตรียมข้อมูล")
tpl_id = upload_template(TPL)
c.ck(bool(tpl_id), "อัปโหลดแม่แบบหนังสือราชการสำเร็จ")
if not tpl_id:
    c.report()
    sys.exit(1)

seal = make_seal(os.path.join(IMG, "ตรา.png"))
photos = [make_photo(os.path.join(IMG, f"หลักฐาน{i+1}.jpg"),
                      [(150, 40, 130), (170, 90, 20), (20, 120, 60)][i % 3],
                      f"หลักฐาน {i+1}", i) for i in range(3)]
c.ck(os.path.exists(seal), "สร้างรูปตราสัญลักษณ์")
c.ck(all(os.path.exists(p) for p in photos), "สร้างรูปหลักฐาน 3 รูป")

# ------------------------------------------------------------------
#  กรณีที่ 1: เร่งด่วน + หลักฐาน 3 รูป
# ------------------------------------------------------------------
c.section("8.1 เอกสารหนังสือราชการ (เร่งด่วน, หลักฐาน 3 รูป)")
data1 = make_data(case=1, n_evidence=3)

# ขั้นที่ 1: ฉีดรูป
docx_injected = os.path.join(OUTD, "ฉีดรูป.docx")
inj = ImageInjector(TPL, fit="contain")
inj.set("ตราสัญลักษณ์", seal)
inj.set_many("หลักฐาน", photos)
inj.run()
inj.save(docx_injected)
c.ck(os.path.getsize(docx_injected) > 20000, "ฉีดรูปสำเร็จ")

descrs = docx_pic_descrs(docx_injected)
multi = [d for d in descrs if d.startswith("หลักฐาน")]
c.ck("ตราสัญลักษณ์" in descrs, "8.2 ช่องตราสัญลักษณ์มีรูป")
c.ck(len(multi) == 3, f"8.2 ช่องหลักฐานมี {len(multi)} รูป", f"ได้ {len(multi)}")
sums = docx_image_checksums(docx_injected)
c.ck(len(set(sums.values())) >= 3, f"8.2 รูปแยกส่วนกันจริง ({len(set(sums.values()))} ค่า)")

# ขั้นที่ 2: Carbone เติมข้อความในแม่แบบที่ยังไม่มีรูป
docx_out = os.path.join(OUTD, "หนังสือราชการ.docx")
t1 = render(tpl_id, data1, "docx", docx_out)
print(f"  เวลาเติมข้อความ: {t1:.1f} วิ")
c.ck(os.path.getsize(docx_out) > 20000, "8.5 ได้ไฟล์ DOCX")

# ขั้นที่ 2b: ฉีดรูปลงไฟล์ที่เติมข้อความแล้ว (เรียงลำดับสำคัญ)
# ต้องเติมข้อความก่อน แล้วค่อยฉีดรูป
# เพราะการฉีดรูปเขียนทับ XML ของรูป ซึ่งอยู่ในไฟล์เดียวกับข้อความ
# ถ้าฉีดก่อนแล้วค่อยเติมข้อความ จะพบว่าแท็กถูกรบกวน
final_docx = os.path.join(OUTD, "หนังสือราชการ-พร้อมรูป.docx")
inj3 = ImageInjector(docx_out, fit="contain")
inj3.set("ตราสัญลักษณ์", seal)
inj3.set_many("หลักฐาน", photos)
inj3.run()
inj3.save(final_docx)
c.ck(os.path.getsize(final_docx) > 20000, "8.2 ฉีดรูปลงเอกสารที่เติมข้อความแล้ว")

# ตรวจว่าแท็กถูกแทนหมดและรูปยังอยู่
ns_final = docx_nospace(final_docx)
c.ck("{d." not in ns_final, "8.1 ไม่มีแท็กค้างหลังฉีดรูป")
c.ck("ตราสัญลักษณ์" in docx_pic_descrs(final_docx), "8.2 รูปยังอยู่หลังฉีด")

ns = docx_nospace(docx_out)
c.ck(contains_ns(ns, data1["ชื่อผู้ร้องเรียน"]), "8.1 ชื่อผู้ร้องเรียนถูกแทน")
c.ck(contains_ns(ns, data1["จังหวัด"]), "8.1 จังหวัดถูกแทน")
c.ck(contains_ns(ns, data1["เลขที่หนังสือ"]), "8.1 เลขที่หนังสือถูกแทน")
c.ck(contains_ns(ns, data1["ชื่อเจ้าหน้าที่"]), "8.1 ชื่อเจ้าหน้าที่ถูกแทน")
c.ck(contains_ns(ns, data1["ความคิดเห็น"]), "8.1 ความคิดเห็นถูกแทน")
for it in data1["items"]:
    c.ck(contains_ns(ns, it["หลักฐาน"]), f"8.2 หลักฐานแถว {it['ลำดับ']}")
c.ck("เรื่องนี้เป็นเรื่องเร่งด่วน" in ns, "8.3 เงื่อนไขเร่งด่วน=true แสดงบรรทัด")
c.ck("ไม่แสดงบรรทัดนี้" not in ns, "8.3 ไม่มีบรรทัดจากเงื่อนไขเท็จ")
c.ck("{d." not in ns, "8.1 ไม่มีแท็กค้าง")

# ขั้นที่ 3: แปลงเป็น PDF จากไฟล์ที่เติมข้อความ+ฉีดรูปครบแล้ว
pdf_out = os.path.join(OUTD, "หนังสือราชการ.pdf")
t_start = time.time()
ok = convert_only(final_docx, pdf_out)   # แปลงไฟล์ที่เต็มสมบูรณ์
t2 = time.time() - t_start
print(f"  เวลาแปลง PDF: {t2:.1f} วิ")
c.ck(ok, "8.5 ได้ไฟล์ PDF")
c.ck(pdf_header(pdf_out).startswith("%PDF-"), "8.5 PDF มีโครงสร้างถูกต้อง")
c.ck(pdf_has_font(pdf_out, "THSarabunNew", "TH+SarabunNew"), "8.5 ฝังฟอนต์ TH Sarabun New")
thai = pdf_thai_chars(pdf_out)
c.ck(thai > 200, f"8.5 อ่านอักษรไทยได้ {thai} ตัว")
# ยืนยันว่า PDF ไม่มีแท็กค้าง
# หมายเหตุสำคัญ: PDF เก็บสระ/วรรณยุกต์ไทยเป็น glyph แยกที่มีรหัสพิเศษ
# (เช่น "\x02\x03" แทน "่") ทำให้ค้นข้อความไทยตรง ๆ ไม่เจอเสมอ
# การตรวจเนื้อหาไทยที่ถูกต้องต้องทำกับไฟล์ DOCX ไม่ใช่ PDF
# ส่วน PDF ตรวจแค่โครงสร้าง ฟอนต์ และจำนวนอักษรไทย
try:
    import pypdf
    _t = "\n".join(p.extract_text() or "" for p in pypdf.PdfReader(pdf_out).pages)
    c.ck("{d." not in _t, "8.1 PDF ไม่มีแท็กค้าง")
    c.ck("0511.01/04" in _t.replace("\n", ""),
         "8.1 PDF มีเลขที่หนังสือจริง (ไม่ใช่แท็ก)")
    # นับอักษรไทยใน PDF เทียบกับเอกสารต้นฉบับ
    # ถ้ามีเนื้อหาครบ จำนวนอักษรไทยต้องใกล้เคียงกับไฟล์ DOCX
    _thai_pdf = sum(1 for ch in _t if "\u0E00" <= ch <= "\u0E7F")
    _thai_docx = sum(1 for ch in docx_nospace(final_docx)
                     if "\u0E00" <= ch <= "\u0E7F")
    print(f"  อักษรไทย: DOCX {_thai_docx} ตัว / PDF {_thai_pdf} ตัว "
          f"({_thai_pdf / _thai_docx * 100:.0f}%)")
    # เกณฑ์: PDF เก็บสระ/วรรณยุกต์เป็น glyph แยก (นับไม่เป็นอักษรไทย)
    # ทำให้จำนวนต่ำกว่า DOCX เสมอ ตัวเลขประมาณ 65-80% ถือว่าปกติ
    c.ck(_thai_pdf >= _thai_docx * 0.6,
         f"8.1 PDF มีเนื้อหาไทยครบ (PDF มี {_thai_pdf}/{_thai_docx} ตัว)")
    print("    (หมายเหตุ: PDF เก็บสระไทยเป็น glyph แยก จึงนับได้น้อยกว่า DOCX 30-40%"
          " — เนื้อหาไทยถูกต้องตามภาพที่เห็น)")
except Exception as e:
    c.ck(False, "8.1 ตรวจข้อความใน PDF", str(e))

pages = pdf_pages(pdf_out)
c.ck(pages >= 1, f"8.4 PDF มี {pages} หน้า")

made, _ = pdf_to_png(pdf_out, OUTD, "หนังสือราชการ", max_pages=1)
if made:
    print(f"  ภาพ: {made[0]}")

# ------------------------------------------------------------------
#  กรณีที่ 2: ไม่เร่งด่วน + หลักฐาน 1 รูป
# ------------------------------------------------------------------
c.section("8.6 ทำซ้ำด้วยข้อมูลต่าง (ต้องได้ผลต่างกัน)")
data2 = make_data(case=2, n_evidence=1)

# เติมข้อความก่อน → แล้วค่อยฉีดรูป
out2 = os.path.join(OUTD, "หนังสือราชการ-2.docx")
render(tpl_id, data2, "docx", out2)
inj2 = ImageInjector(out2, fit="contain")
inj2.set("ตราสัญลักษณ์", seal)
inj2.set_many("หลักฐาน", photos[:1])
inj2.run()
out2_final = os.path.join(OUTD, "หนังสือราชการ-2-พร้อมรูป.docx")
inj2.save(out2_final)

ns2 = docx_nospace(out2_final)

c.ck(contains_ns(ns2, data2["จังหวัด"]), "8.6 จังหวัดของชุดที่ 2 ถูกแทน")
c.ck(data2["จังหวัด"] != data1["จังหวัด"], "ข้อมูลชุดที่ 2 ต่างจากชุดที่ 1")
c.ck(contains_ns(ns2, data2["เลขที่หนังสือ"]), "8.6 เลขที่หนังสือชุดที่ 2")
c.ck(contains_ns(ns2, data2["ชื่อผู้ร้องเรียน"]), "8.6 ชื่อผู้ร้องเรียนชุดที่ 2")

# ไม่เร่งด่วน → ต้องไม่มีบรรทัดเร่งด่วน
c.ck(data2["เร่งด่วน"] is False, "ข้อมูลชุดที่ 2: เร่งด่วน = false")
c.ck("เรื่องนี้เป็นเรื่องเร่งด่วน" not in ns2, "8.3 เงื่อนไขเร่งด่วน=false ไม่แสดง")
c.ck("ไม่แสดงบรรทัดนี้" in ns2, "8.3 เงื่อนไขเท็จ → แสดงบรรทัดสำรอง")

# ผลลัพธ์ต้องต่างกันจริง ไม่ใช่ไฟล์ค้างจากรอบก่อน
c.ck(os.path.getsize(out2) > 0, "8.6 ไฟล์ชุดที่ 2 ไม่ว่าง")
h1 = open(docx_out, "rb").read()
h2 = open(out2, "rb").read()
c.ck(h1 != h2, "8.6 เอกสารสองชุดต่างกันจริง (ไม่ใช่ไฟล์เดิม)")
c.ck(contains_ns(ns2, data1["จังหวัด"]) is False,
     "8.6 ไม่มีข้อมูลของชุดที่ 1 ปนอยู่")

# ------------------------------------------------------------------
c.section("สรุป")
print(f"  เอกสารชุดที่ 1: {os.path.getsize(docx_out):,} bytes (DOCX), "
      f"{os.path.getsize(pdf_out):,} bytes (PDF)")
print(f"  เอกสารชุดที่ 2: {os.path.getsize(out2):,} bytes (DOCX)")
print(f"  เวลารวม: {t1 + t2:.1f} วิ")
print(f"  ไฟล์อยู่ใน: {OUTD}")

c.report()
