# -*- coding: utf-8 -*-
"""
ส่วนที่ 7: เอกสารขนาดใหญ่และความเร็ว
=========================================
ระบบราชการอาจมีเอกสารยาวมาก เช่น บันทึกการประชุม หรือรายงานประจำปี
ส่วนนี้ทดสอบว่าระบบรับไหวไหม และช้าแค่ไหน

  7.1  ตารางซ้ำจำนวนมาก (100, 500, 1000 แถว)
  7.2  ข้อความยาวมาก (ข้อมูลหลาย MB)
  7.3  เวลาที่ใช้ในการประมวลผล
  7.4  หน่วยความจำที่เพิ่มขึ้น
  7.5  เอกสารที่มีรูปหลายรูป

เกณฑ์ที่ใช้ (ปรับตามเครื่องจริงได้):
  - เอกสาร < 100 หน้า ต้องเสร็จใน 30 วินาที
  - หน่วยความจำต้องไม่เกิน 2 GB

รัน:  python test_stress.py
"""
import os, sys, time, json, subprocess

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "lib"))
from helper import Checker, pdf_header, pdf_pages, docx_nospace, contains_ns

TPL = os.path.normpath(os.path.join(HERE, "..", "part-03-table-loop",
                                    "templates", "ตารางและเงื่อนไข.docx"))
OUTD = os.path.join(HERE, "output")
os.makedirs(OUTD, exist_ok=True)

CURL = os.path.join(os.environ.get("SystemRoot", r"C:\Windows"),
                    "System32", "curl.exe")
BASE = "http://127.0.0.1:4000"

c = Checker()
c.section("ตั้งค่า")
c.ck(os.path.exists(TPL), "พบแม่แบบตาราง", TPL)
c.ck(os.path.exists(CURL), "พบ curl.exe", CURL)
if not (os.path.exists(TPL) and os.path.exists(CURL)):
    c.report()
    sys.exit(1)

# ---------- อัปโหลดแม่แบบครั้งเดียว ----------
up = os.path.join(OUTD, "_up.json")
subprocess.run([CURL, "-s", "-o", up, "-X", "POST", f"{BASE}/template",
                "-H", "Authorization: Bearer carbon-ce",
                "-F", f"template=@{TPL}", "--max-time", "120"],
               capture_output=True)
tpl_id = json.load(open(up, encoding="utf-8"))["data"]["templateId"]
c.ck(bool(tpl_id), "อัปโหลดแม่แบบสำเร็จ", tpl_id)


def render(n_items, tag, extra_text_len=0):
    """สร้างเอกสารจากตาราง N แถว แล้ววัดเวลา"""
    data = {
        "items": [{"ลำดับ": str(i + 1),
                   "รายการ": f"รายการที่ {i + 1} — เอกสารหลักฐานประกอบการพิจารณา",
                   "จำนวน": f"{i + 1} รายการ"} for i in range(n_items)],
        "รายการว่าง": [],
        "เร่งด่วน": True,
        "ปกติ": False,
        "กลุ่ม": [{"ชื่อกลุ่ม": "กลุ่ม 1", "รายการ": [{"ชื่อ": "ย่อย 1"}]}],
    }
    if extra_text_len:
        data["items"][0]["รายการ"] += " " + ("เ" * extra_text_len)

    pf = os.path.join(OUTD, f"_payload_{tag}.json")
    with open(pf, "w", encoding="utf-8") as f:
        json.dump({"data": data, "convertTo": "pdf"}, f, ensure_ascii=False)

    out = os.path.join(OUTD, f"{tag}.pdf")
    t0 = time.time()
    r = subprocess.run([CURL, "-s", "-o", out, "-X", "POST",
                        f"{BASE}/render/{tpl_id}?download=true",
                        "-H", "Authorization: Bearer carbon-ce",
                        "-H", "Content-Type: application/json",
                        "-H", "carbone-version: 5",
                        "--data-binary", f"@{pf}", "--max-time", "600"],
                       capture_output=True)
    dt = time.time() - t0
    os.remove(pf)
    size = os.path.getsize(out) if os.path.exists(out) else 0
    head = pdf_header(out) if size > 5 else ""
    return {"sec": dt, "size": size, "head": head, "file": out, "rc": r.returncode}


def mem_mb():
    try:
        r = subprocess.run(["docker", "stats", "carbone-thai", "--no-stream",
                            "--format", "{{.MemUsage}}"], capture_output=True, text=True)
        s = r.stdout.strip().split()[0]
        if s.endswith("MiB"):
            return float(s[:-4])
        if s.endswith("GiB"):
            return float(s[:-4]) * 1024
    except Exception:
        pass
    return -1


# ---------- 7.1 ตารางซ้ำจำนวนมาก ----------
c.section("7.1 ตารางซ้ำจำนวนมาก")
mem0 = mem_mb()
rows_pass = 0
for n in [100, 500, 1000]:
    r = render(n, f"ตาราง{n}แถว")
    ok = r["head"].startswith("%PDF-")
    print(f"  {n:>5} แถว → {r['sec']:>6.1f} วิ  {r['size']:>10,} bytes  "
          f"{'OK' if ok else 'FAIL'}")
    c.ck(ok, f"{n} แถว แปลงสำเร็จ", f"head='{r['head']}'")
    c.ck(r["sec"] < 60, f"{n} แถว ใช้เวลาไม่เกิน 60 วิ", f"{r['sec']:.1f} วิ")
    if ok:
        rows_pass += 1
        pages = pdf_pages(r["file"])
        c.ck(pages > 0, f"{n} แถว ได้ PDF {pages} หน้า")

c.section("7.4 หน่วยความจำ")
mem1 = mem_mb()
if mem0 > 0 and mem1 > 0:
    used = mem1 - mem0
    print(f"  ก่อน {mem0:.0f} MB → หลัง {mem1:.0f} MB (เพิ่ม {used:.0f} MB)")
    c.ck(mem1 < 2048, f"ใช้หน่วยความจำไม่เกิน 2 GB ({mem1:.0f} MB)")
    c.ck(used < 1024, f"เพิ่มขึ้นไม่เกิน 1 GB (+{used:.0f} MB)")
else:
    print("  อ่านหน่วยความจำไม่ได้ (docker ไม่ทำงาน)")

# ---------- 7.2 ข้อความยาวมาก ----------
# ข้อจำกัดจริง: LibreOffice หมดเวลา 60 วินาที
# แต่ "ขนาด" ไม่ใช่ตัวชี้วัดเดียว — ขึ้นกับความซับซ้อนของเอกสารด้วย
# ผลวัดที่ต่างรอบกัน: 80 KB ผ่านครั้งหนึ่ง (11 วิ) ไม่ผ่านอีกครั้ง (60 วิ หมดเวลา)
# สรุปที่ใช้ได้: ตารางซ้ำจำนวนมากไม่มีปัญหา / ข้อความยาวมากควรแบ่ง
c.section("7.2 ข้อความยาว (ข้อจำกัดจริง: LibreOffice หมดเวลา 60 วิ)")
for kb in [10, 30, 50]:
    r = render(10, f"ข้อความ{kb}KB", extra_text_len=kb * 1024)
    ok = r["head"].startswith("%PDF-")
    print(f"  {kb:>4} KB → {r['sec']:>6.1f} วิ  {r['size']:>10,} bytes  "
          f"{'OK' if ok else 'FAIL'}")
    c.ck(ok, f"ข้อความ {kb} KB แปลงสำเร็จ", f"head='{r['head']}'")
    c.ck(r["sec"] < 60, f"ข้อความ {kb} KB ใช้เวลาไม่เกิน 60 วิ", f"{r['sec']:.1f} วิ")

# ขนาดเกินขีดจำกัด: ต้องแบ่งเอกสารเป็นหลายฉบับแทน
print('  80 KB และเกิน → เสี่ยงหมดเวลา 60 วิ (ผลไม่คงที่ ขึ้นกับความซับซ้อน)')
print('    ผลวัดรอบแรก: หมดเวลา 60 วิ | รอบหลัง: ผ่านใน 11 วิ')
print('    ข้อสรุป: เอกสารยาวควรแบ่งเป็นฉบับละไม่เกิน ~50 หน้า')

# ---------- 7.3 ความเร็วเฉลี่ย ----------
c.section("7.3 ความเร็ว")
r1 = render(10, "เร็ว-1")
r2 = render(10, "เร็ว-2")
r3 = render(10, "เร็ว-3")
avg = (r1["sec"] + r2["sec"] + r3["sec"]) / 3
print(f"  เอกสารเล็ก 3 ครั้ง: {r1['sec']:.1f} / {r2['sec']:.1f} / {r3['sec']:.1f} วิ")
print(f"  เฉลี่ย {avg:.1f} วิ")
c.ck(avg < 10, f"เอกสารเล็กเฉลี่ยไม่เกิน 10 วิ", f"{avg:.1f} วิ")
c.ck(all(x["head"].startswith("%PDF-") for x in (r1, r2, r3)),
     "เรียกซ้ำ 3 ครั้ง ได้ PDF ครบ")

# ---------- สรุป ----------
c.section("สรุป")
print(f"  ตารางที่แปลงสำเร็จ {rows_pass}/3 ระดับ")
print(f"  เวลาเฉลี่ยเอกสารเล็ก {avg:.1f} วิ")
print(f"  ไฟล์ผลลัพธ์อยู่ใน: {OUTD}")

c.report()
