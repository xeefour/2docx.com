# -*- coding: utf-8 -*-
"""
ทดสอบเวลาอย่างจำกัด: เอกสารหนัก เทียบ LibreOffice (L) กับ Carbone ICE (I)
ใช้ timeout ที่บังคับ เพื่อไม่ให้ทดสอบค้าง
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

HARD_LIMIT = 90   # วินาที — บังคับไม่ให้เกิน


def curl(args):
    return subprocess.run([CURL, "-s"] + args, capture_output=True, text=True,
                          encoding="utf-8", errors="replace").stdout


up = os.path.join(OUTD, "_up2.json")
subprocess.run([CURL, "-s", "-o", up, "-X", "POST", f"{BASE}/template",
                "-H", "Authorization: Bearer carbon-ce",
                "-F", f"template=@{TPL}", "--max-time", "120"],
               capture_output=True)
tpl_id = json.load(open(up, encoding="utf-8"))["data"]["templateId"]


def make(n, tl):
    return {"items": [{"ลำดับ": str(i + 1),
                       "รายการ": ("ก" * tl) if i == 0 else f"รายการที่ {i+1}",
                       "จำนวน": f"{i+1} ชิ้น"} for i in range(n)],
            "รายการว่าง": [], "เร่งด่วน": True, "ปกติ": False,
            "กลุ่ม": [{"ชื่อกลุ่ม": "ก", "รายการ": [{"ชื่อ": "x"}]}]}


def run(data, conv, tag):
    pf = os.path.join(OUTD, "_pf.json")
    with open(pf, "w", encoding="utf-8") as f:
        json.dump({"data": data, "convertTo": "pdf", "converter": conv},
                  f, ensure_ascii=False)
    out = os.path.join(OUTD, f"_h_{tag}.pdf")
    t0 = time.time()
    subprocess.run([CURL, "-s", "-o", out, "-X", "POST",
                    f"{BASE}/render/{tpl_id}?download=true",
                    "-H", "Authorization: Bearer carbon-ce",
                    "-H", "Content-Type: application/json",
                    "-H", "carbone-version: 5",
                    "--data-binary", f"@{pf}", "--max-time", str(HARD_LIMIT)],
                   capture_output=True)
    dt = time.time() - t0
    sz = os.path.getsize(out) if os.path.exists(out) else 0
    head = open(out, "rb").read(5).decode("latin1") if sz > 5 else ""
    ok = head.startswith("%PDF")
    return {"sec": dt, "ok": ok, "size": sz,
            "pages": pdf_pages(out) if ok else 0,
            "timeout": dt >= HARD_LIMIT - 2}


print("=" * 72)
print(f" ทดสอบเวลา (จำกัดที่ {HARD_LIMIT} วินาทีต่อเคส)")
print("=" * 72)
print()
print(f"{'เคส':<28} {'L (LibreOffice)':>20} {'I (Carbone ICE)':>20}")
print("-" * 72)

cases = [
    ("ปกติ 200 แถว", 200, 0),
    ("ข้อความ 30 KB", 200, 30 * 1024),
    ("ข้อความ 60 KB", 200, 60 * 1024),
    ("ข้อความ 100 KB", 200, 100 * 1024),
    ("ตาราง 1000 แถว", 1000, 0),
    ("ตาราง 2000 แถว", 2000, 0),
]

rows = []
for label, n, tl in cases:
    data = make(n, tl)
    rL = run(data, "L", f"L{n}_{tl}")
    print(f"  {label} ... L", end="", flush=True)
    rI = run(data, "I", f"I{n}_{tl}")
    print(f" ... I", end="", flush=True)

    def cell(r):
        if r["timeout"]:
            return f"หมดเวลา (>={HARD_LIMIT}s)"
        if not r["ok"]:
            return "ผิดพลาด"
        return f"{r['sec']:.1f} วิ {r['pages']} หน้า"

    print(f"\r{label:<28} {cell(rL):>20} {cell(rI):>20}")
    rows.append((label, rL, rI))

print()
print("=" * 72)
print(" สรุป")
print("=" * 72)
print()
l_bad = [x for x in rows if not x[1]["ok"]]
i_bad = [x for x in rows if not x[2]["ok"]]
print(f"  LibreOffice ทำไม่ได้: {len(l_bad)}/{len(rows)} เคส")
for lb in l_bad:
    print(f"      - {lb[0]}")
print(f"  Carbone ICE ทำไม่ได้: {len(i_bad)}/{len(rows)} เคส")
for ib in i_bad:
    print(f"      - {ib[0]}")

print()
if len(i_bad) < len(l_bad):
    print(f"  >>> Carbone ICE ช่วยได้ {len(l_bad) - len(i_bad)} เคส")
elif not i_bad and not l_bad:
    print("  >>> ทั้งคู่ผ่านหมด")
else:
    print("  >>> ต้องแบ่งงานเป็นชิ้น")
print()
print("=" * 72)
