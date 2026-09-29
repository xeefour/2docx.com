# -*- coding: utf-8 -*-
"""ทดสอบซ้ำ 1,000 แถว เพื่อเช็คความสม่ำเสมอของผลการทดสอบ"""
import os, sys, json, time, subprocess

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "lib"))
from helper import pdf_pages

BASE = "http://127.0.0.1:4000"
CURL = os.path.join(os.environ.get("SystemRoot", r"C:\Windows"), "System32", "curl.exe")
TPL = os.path.join(HERE, "..", "part-03-table-loop", "templates",
                   "ตารางและเงื่อนไข.docx")
OUTD = os.path.join(HERE, "output")


def curl(args):
    return subprocess.run([CURL, "-s"] + args, capture_output=True, text=True,
                          encoding="utf-8", errors="replace").stdout


up = os.path.join(OUTD, "_re-up.json")
subprocess.run([CURL, "-s", "-o", up, "-X", "POST", f"{BASE}/template",
                "-H", "Authorization: Bearer carbon-ce",
                "-F", f"template=@{TPL}", "--max-time", "120"],
               capture_output=True)
tpl_id = json.load(open(up, encoding="utf-8"))["data"]["templateId"]
print(f"templateId: {tpl_id[:16]}...")


def mkdata(n):
    return {"items": [{"ลำดับ": str(i + 1), "รายการ": f"รายการที่ {i+1}",
                       "จำนวน": f"{i+1} ชิ้น"} for i in range(n)],
            "รายการว่าง": [], "เร่งด่วน": True, "ปกติ": False,
            "กลุ่ม": [{"ชื่อกลุ่ม": "ก", "รายการ": [{"ชื่อ": "x"}]}]}


print()
print(f"{'จำนวนแถว':>10} {'รอบ':>5} {'เวลา':>10} {'หน้า':>7}  ผล")
print("-" * 46)

for n in (100, 500, 1000):
    for rep in (1, 2):
        pf = os.path.join(OUTD, "_re-pf.json")
        with open(pf, "w", encoding="utf-8") as f:
            json.dump({"data": mkdata(n), "convertTo": "pdf"}, f, ensure_ascii=False)
        out = os.path.join(OUTD, f"_re_{n}_{rep}.pdf")
        t0 = time.time()
        subprocess.run([CURL, "-s", "-o", out, "-X", "POST",
                        f"{BASE}/render/{tpl_id}?download=true",
                        "-H", "Authorization: Bearer carbon-ce",
                        "-H", "Content-Type: application/json",
                        "-H", "carbone-version: 5",
                        "--data-binary", f"@{pf}", "--max-time", "90"],
                       capture_output=True)
        dt = time.time() - t0
        sz = os.path.getsize(out) if os.path.exists(out) else 0
        ok = sz > 1000
        pg = pdf_pages(out) if ok else 0
        print(f"{n:>10} {rep:>5} {dt:>9.1f} วิ {pg:>6}  {'OK' if ok else 'หมดเวลา'}")
