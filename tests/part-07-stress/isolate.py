# -*- coding: utf-8 -*-
"""
หาสาเหตุที่ทำให้ผลต่างกัน
กรณี 1: ข้อมูลปกติ (ไม่ส่ง converter)            → 1,000 แถว 1.4 วิ
กรณี 2: ส่ง converter="L"                        → ?
กรณี 3: ข้อมูลที่มีค่าว่างในช่องที่วนซ้ำ          → ?
กรณี 4: ทั้งสองอย่าง                              → ?
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


up = os.path.join(OUTD, "_iso-up.json")
subprocess.run([CURL, "-s", "-o", up, "-X", "POST", f"{BASE}/template",
                "-H", "Authorization: Bearer carbon-ce",
                "-F", f"template=@{TPL}", "--max-time", "120"],
               capture_output=True)
tpl_id = json.load(open(up, encoding="utf-8"))["data"]["templateId"]


def run(data, tag, converter=None):
    body = {"data": data, "convertTo": "pdf"}
    if converter:
        body["converter"] = converter
    pf = os.path.join(OUTD, "_iso-pf.json")
    with open(pf, "w", encoding="utf-8") as f:
        json.dump(body, f, ensure_ascii=False)
    out = os.path.join(OUTD, f"_iso_{tag}.pdf")
    t0 = time.time()
    subprocess.run([CURL, "-s", "-o", out, "-X", "POST",
                    f"{BASE}/render/{tpl_id}?download=true",
                    "-H", "Authorization: Bearer carbon-ce",
                    "-H", "Content-Type: application/json",
                    "-H", "carbone-version: 5",
                    "--data-binary", f"@{pf}", "--max-time", str(LIMIT)],
                   capture_output=True)
    dt = time.time() - t0
    sz = os.path.getsize(out) if os.path.exists(out) else 0
    ok = sz > 1000
    pg = pdf_pages(out) if ok else 0
    return dt, ok, pg


def mk(n, first_empty):
    first = "" if first_empty else "รายการที่ 1"
    return {"items": [{"ลำดับ": str(i + 1),
                       "รายการ": first if i == 0 else f"รายการที่ {i+1}",
                       "จำนวน": f"{i+1} ชิ้น"} for i in range(n)],
            "รายการว่าง": [], "เร่งด่วน": True, "ปกติ": False,
            "กลุ่ม": [{"ชื่อกลุ่ม": "ก", "รายการ": [{"ชื่อ": "x"}]}]}


tests = [
    ("ข้อมูลปกติ",            mk(1000, False), None),
    ("ส่ง converter=L",       mk(1000, False), "L"),
    ("แถวแรกเป็นค่าว่าง",       mk(1000, True),  None),
    ("ค่าว่าง + converter=L", mk(1000, True),  "L"),
    ("แถวแรกเป็นค่าว่าง 100",  mk(100,  True),  None),
    ("แถวแรกเป็นค่าว่าง 500",  mk(500,  True),  None),
]

print("=" * 66)
print(f" หาสาเหตุ (จำกัด {LIMIT} วินาทีต่อเคส)")
print("=" * 66)
print()
print(f"{'กรณี':<26} {'เวลา':>10} {'หน้า':>7}  ผล")
print("-" * 66)

for label, data, conv in tests:
    dt, ok, pg = run(data, label.replace(" ", "_")[:20], conv)
    flag = "OK" if ok else "หมดเวลา"
    print(f"{label:<26} {dt:>9.1f} วิ {pg:>6}  {flag}")

print()
print("=" * 66)
