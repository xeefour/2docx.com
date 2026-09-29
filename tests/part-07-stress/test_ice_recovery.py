# -*- coding: utf-8 -*-
"""
ทดสอบว่า Carbone ICE กู้สถานะหลังหมดเวลาได้หรือไม่
(ต่างจาก LibreOffice ที่ทดสอบแล้วว่าฟื้นได้)
"""
import os, sys, json, time, subprocess

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "lib"))
from helper import pdf_pages

BASE = "http://127.0.0.1:4000"
CURL = os.path.join(os.environ.get("SystemRoot", r"C:\Windows"), "System32", "curl.exe")
TPL = os.path.join(HERE, "..", "part-03-table-loop", "templates",
                   "ตารางและเงื่อนไข.docx")
OUTD = os.path.join(HERE, "output")
LIMIT = 75


def curl(args):
    return subprocess.run([CURL, "-s"] + args, capture_output=True, text=True,
                          encoding="utf-8", errors="replace").stdout


up = os.path.join(OUTD, "_ice-up.json")
subprocess.run([CURL, "-s", "-o", up, "-X", "POST", f"{BASE}/template",
                "-H", "Authorization: Bearer carbon-ce",
                "-F", f"template=@{TPL}", "--max-time", "120"],
               capture_output=True)
tpl_id = json.load(open(up, encoding="utf-8"))["data"]["templateId"]


def run(data, tag, conv, limit=LIMIT):
    pf = os.path.join(OUTD, "_ice-pf.json")
    with open(pf, "w", encoding="utf-8") as f:
        json.dump({"data": data, "convertTo": "pdf", "converter": conv},
                  f, ensure_ascii=False)
    out = os.path.join(OUTD, f"_ice_{tag}.pdf")
    t0 = time.time()
    subprocess.run([CURL, "-s", "-o", out, "-X", "POST",
                    f"{BASE}/render/{tpl_id}?download=true",
                    "-H", "Authorization: Bearer carbon-ce",
                    "-H", "Content-Type: application/json",
                    "-H", "carbone-version: 5",
                    "--data-binary", f"@{pf}", "--max-time", str(limit)],
                   capture_output=True)
    dt = time.time() - t0
    sz = os.path.getsize(out) if os.path.exists(out) else 0
    ok = sz > 1000
    return dt, ok, (pdf_pages(out) if ok else 0)


light = {"items": [{"ลำดับ": str(i+1), "รายการ": f"รายการที่ {i+1}",
                    "จำนวน": f"{i+1} ชิ้น"} for i in range(1000)],
         "รายการว่าง": [], "เร่งด่วน": True, "ปกติ": False,
         "กลุ่ม": [{"ชื่อกลุ่ม": "ก", "รายการ": [{"ชื่อ": "x"}]}]}

heavy = {"items": [{"ลำดับ": str(i+1),
                    "รายการ": ("ก" * 200 * 1024) if i == 0 else f"รายการที่ {i+1}",
                    "จำนวน": f"{i+1} ชิ้น"} for i in range(200)],
         "รายการว่าง": [], "เร่งด่วน": True, "ปกติ": False,
         "กลุ่ม": [{"ชื่อกลุ่ม": "ก", "รายการ": [{"ชื่อ": "x"}]}]}

print("=" * 68)
print(" ทดสอบ: Carbone ICE กู้สถานะหลังหมดเวลาไหม")
print("=" * 68)
print()

print("ช่วงที่ 1 — เอกสาร 1,000 แถว ด้วย ICE (ก่อนหนัก)")
for i in range(2):
    dt, ok, pg = run(light, f"pre{i}", "I")
    print(f"  ICE #{i+1}: {dt:>6.1f} วิ  {pg:>3} หน้า  {'OK' if ok else 'ล้มเหลว'}")

print()
print("ช่วงที่ 2 — เอกสารหนัก ด้วย ICE (คาดว่าหมดเวลา)")
dt, ok, pg = run(heavy, "boom", "I")
print(f"  ICE หนัก: {dt:>6.1f} วิ  {'OK' if ok else 'หมดเวลา'}")

print()
print("ช่วงที่ 3 — เอกสาร 1,000 แถว ด้วย ICE (หลังหนัก)")
res = []
for i in range(3):
    dt, ok, pg = run(light, f"post{i}", "I")
    res.append(ok)
    print(f"  ICE #{i+1}: {dt:>6.1f} วิ  {pg:>3} หน้า  {'OK' if ok else 'หมดเวลา'}")

print()
print("ช่วงที่ 4 — สลับกลับไปใช้ LibreOffice")
for i in range(2):
    dt, ok, pg = run(light, f"back{i}", "L")
    print(f"  L   #{i+1}: {dt:>6.1f} วิ  {pg:>3} หน้า  {'OK' if ok else 'หมดเวลา'}")

n = sum(res)
print()
print("=" * 68)
print(f" ผล ICE หลังหมดเวลา: ผ่าน {n}/{len(res)}")
if n == len(res):
    print(" >>> ICE กู้สถานะได้เช่นกัน")
else:
    print(" >>> ICE ไม่กู้สถานะ! ต้องระวัง")
print("=" * 68)
