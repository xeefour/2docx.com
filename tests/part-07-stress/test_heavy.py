# -*- coding: utf-8 -*-
"""
ทดสอบกรณีที่เคยหมดเวลา 60 วินาที
เปรียบเทียบว่า Carbone ICE ช่วยได้จริงไหม
"""
import os, sys, json, time, subprocess

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "lib"))
from helper import pdf_pages

OUTD = os.path.join(HERE, "output")
os.makedirs(OUTD, exist_ok=True)
BASE = "http://127.0.0.1:4000"
CURL = os.path.join(os.environ.get("SystemRoot", r"C:\Windows"), "System32", "curl.exe")
TPL = os.path.join(HERE, "templates", "ตาราง-ตัวอย่าง.docx")


def curl(args):
    return subprocess.run([CURL, "-s"] + args, capture_output=True, text=True,
                          encoding="utf-8", errors="replace").stdout


up = os.path.join(OUTD, "_up.json")
subprocess.run([CURL, "-s", "-o", up, "-X", "POST", f"{BASE}/template",
                "-H", "Authorization: Bearer carbon-ce",
                "-F", f"template=@{TPL}", "--max-time", "180"], capture_output=True)
tpl_id = json.load(open(up, encoding="utf-8"))["data"]["templateId"]


def make_data(n_items, text_len):
    return {
        "items": [{"ลำดับ": str(i + 1),
                   "รายการ": ("ก" * text_len) if i == 0 else f"รายการที่ {i+1}",
                   "จำนวน": f"{i+1} รายการ"} for i in range(n_items)],
        "รายการว่าง": [], "เร่งด่วน": True, "ปกติ": False,
        "กลุ่ม": [{"ชื่อกลุ่ม": "ก", "รายการ": [{"ชื่อ": "x"}]}],
    }


def run(data, conv, tag):
    pf = os.path.join(OUTD, "_pf.json")
    with open(pf, "w", encoding="utf-8") as f:
        json.dump({"data": data, "convertTo": "pdf", "converter": conv},
                  f, ensure_ascii=False)
    out = os.path.join(OUTD, f"_t_{tag}.pdf")
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
    head = open(out, "rb").read(5).decode("latin1") if sz > 5 else ""
    ok = head.startswith("%PDF")
    pg = pdf_pages(out) if ok else 0
    return {"sec": dt, "ok": ok, "size": sz, "pages": pg, "head": head}


print("=" * 74)
print(" ทดสอบกรณีหนัก: เอกสารใหญ่ เทียบ LibreOffice (L) กับ Carbone ICE (I)")
print("=" * 74)
print()
print(f"{'เคส':<26} {'L (LibreOffice)':>20} {'I (Carbone ICE)':>20}  ผล")
print("-" * 74)

cases = [
    ("ปกติ 200 แถว", 200, 0),
    ("ข้อความหนัก 60 KB", 200, 60 * 1024),
    ("ข้อความหนัก 100 KB", 200, 100 * 1024),
    ("ข้อความหนัก 200 KB", 200, 200 * 1024),
    ("ตารางใหญ่ 1000 แถว", 1000, 0),
    ("ตารางใหญ่ 2000 แถว", 2000, 0),
    ("หนักสุด 2000 แถว+ข้อความ", 2000, 80 * 1024),
]

summary = []
for label, n, tl in cases:
    data = make_data(n, tl)
    rL = run(data, "L", f"L{n}_{tl}")
    rI = run(data, "I", f"I{n}_{tl}")

    def cell(r):
        if not r["ok"]:
            return f"หมดเวลา/ผิดพลาด"
        return f"{r['sec']:.1f} วิ {r['pages']} หน้า"

    print(f"{label:<26} {cell(rL):>20} {cell(rI):>20}")
    summary.append((label, rL, rI))

print()
print("=" * 74)
print(" สรุป")
print("=" * 74)
print()
print(f"{'เคส':<26} {'L':>10} {'I':>10}  {'I เร็วกว่า':>10}")
print("-" * 74)
l_fail = i_fail = 0
for label, rL, rI in summary:
    ls = f"{rL['sec']:.1f} วิ" if rL["ok"] else "ไม่ผ่าน"
    is_ = f"{rI['sec']:.1f} วิ" if rI["ok"] else "ไม่ผ่าน"
    if rL["ok"] and rI["ok"]:
        sp = f"{rL['sec']/rI['sec']:.0f}x" if rI["sec"] > 0.01 else "เท่ากัน"
    else:
        sp = "-"
    if not rL["ok"]:
        l_fail += 1
    if not rI["ok"]:
        i_fail += 1
    print(f"{label:<26} {ls:>10} {is_:>10}  {sp:>10}")

print()
print(f"  LibreOffice ล้มเหลว {l_fail}/{len(cases)} เคส")
print(f"  Carbone ICE  ล้มเหลว {i_fail}/{len(cases)} เคส")
print()
if i_fail < l_fail:
    print("  >>> Carbone ICE ช่วยได้จริงในเคสที่ LibreOffice ทำไม่ได้")
elif i_fail == 0 and l_fail == 0:
    print("  >>> ทั้งคู่ผ่านหมดในเคสที่ทดสอบ")
else:
    print("  >>> ต้องแบ่งงานเป็นชิ้นอยู่ดี")
print()
print("=" * 74)
