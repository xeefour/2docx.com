# -*- coding: utf-8 -*-
"""
ทดสอบ config ที่ปรับแล้ว: timeout 300 วิ (จาก 60 วิ) + factories 3 (จาก 1)
เทียบกับ container เดิมที่พอร์ต 4000

เปรียบเทียบ:
  container เดิม (port 4000) : timeout 60 วิ,  factories 1
  container ใหม่ (port 4001) : timeout 300 วิ, factories 3
"""
import os, sys, json, time, subprocess
from concurrent.futures import ThreadPoolExecutor

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "lib"))
from helper import pdf_pages

CURL = os.path.join(os.environ.get("SystemRoot", r"C:\Windows"), "System32", "curl.exe")
TPL = os.path.normpath(os.path.join(HERE, "..", "part-03-table-loop",
                                    "templates", "ตารางและเงื่อนไข.docx"))
OUTD = os.path.join(HERE, "output")
os.makedirs(OUTD, exist_ok=True)

OLD = "http://127.0.0.1:4000"    # timeout 60 วิ, factories 1
NEW = "http://127.0.0.1:4001"    # timeout 300 วิ, factories 3


def curl(args):
    return subprocess.run([CURL, "-s"] + args, capture_output=True, text=True,
                          encoding="utf-8", errors="replace").stdout


def tplid(base):
    up = os.path.join(OUTD, f"_cfg_{base[-1]}.json")
    subprocess.run([CURL, "-s", "-o", up, "-X", "POST", f"{base}/template",
                    "-H", "Authorization: Bearer carbon-ce",
                    "-F", f"template=@{TPL}", "--max-time", "120"],
                   capture_output=True)
    return json.load(open(up, encoding="utf-8"))["data"]["templateId"]


def mkdata(n, tl):
    return {"items": [{"ลำดับ": str(i + 1),
                       "รายการ": ("ก" * tl) if i == 0 else f"รายการที่ {i+1}",
                       "จำนวน": f"{i+1} ชิ้น"} for i in range(n)],
            "รายการว่าง": [], "เร่งด่วน": True, "ปกติ": False,
            "กลุ่ม": [{"ชื่อกลุ่ม": "ก", "รายการ": [{"ชื่อ": "x"}]}]}


def render(base, tid, data, tag, timeout):
    pf = os.path.join(OUTD, f"_cfg_pf_{tag}.json")
    with open(pf, "w", encoding="utf-8") as f:
        json.dump({"data": data, "convertTo": "pdf"}, f, ensure_ascii=False)
    out = os.path.join(OUTD, f"_cfg_{tag}.pdf")
    t0 = time.time()
    subprocess.run([CURL, "-s", "-o", out, "-X", "POST",
                    f"{base}/render/{tid}?download=true",
                    "-H", "Authorization: Bearer carbon-ce",
                    "-H", "Content-Type: application/json",
                    "-H", "carbone-version: 5",
                    "--data-binary", f"@{pf}", "--max-time", str(timeout)],
                   capture_output=True)
    dt = time.time() - t0
    sz = os.path.getsize(out) if os.path.exists(out) else 0
    ok = sz > 1000
    return dt, ok, (pdf_pages(out) if ok else 0)


tid_old = tplid(OLD)
tid_new = tplid(NEW)
print(f"templateId เดิม: {tid_old[:16]}...")
print(f"templateId ใหม่: {tid_new[:16]}...")
print()

CASES = [
    ("ข้อความ 60 KB",  200, 60 * 1024),
    ("ข้อความ 100 KB", 200, 100 * 1024),
    ("ข้อความ 200 KB", 200, 200 * 1024),
]

print("=" * 74)
print(" เทียบ: เดิม (60 วิ) กับ ใหม่ (300 วิ)")
print("=" * 74)
print()
print(f"{'เคส':<20} {'เดิม 60 วิ':>22} {'ใหม่ 300 วิ':>22}")
print("-" * 74)

for label, n, tl in CASES:
    d = mkdata(n, tl)
    dOld, okOld, pgOld = render(OLD, tid_old, d, f"old{n}_{tl}", timeout=120)
    dNew, okNew, pgNew = render(NEW, tid_new, d, f"new{n}_{tl}", timeout=330)

    def cell(dt, ok, pg):
        return f"{dt:.1f} วิ {pg} หน้า" if ok else f"หมดเวลา ({dt:.0f} วิ)"

    print(f"{label:<20} {cell(dOld, okOld, pgOld):>22} {cell(dNew, okNew, pgNew):>22}")

print()
print("=" * 74)
print(" ทดสอบประสิทธิภาพ: ยิง 3 งานพร้อมกัน")
print("=" * 74)
print()

d = mkdata(200, 30 * 1024)

# เดิม: factories=1 → ต้องทำทีละงาน
t0 = time.time()
render(OLD, tid_old, d, "par_old_1", timeout=200)
render(OLD, tid_old, d, "par_old_2", timeout=200)
render(OLD, tid_old, d, "par_old_3", timeout=200)
t_old = time.time() - t0

# ใหม่: factories=3 → ทำพร้อมกันได้
t0 = time.time()
with ThreadPoolExecutor(max_workers=3) as ex:
    list(ex.map(lambda i: render(NEW, tid_new, d, f"par_new_{i}", timeout=200),
                range(3)))
t_new = time.time() - t0

print(f"  เดิม (factories=1) 3 งานพร้อมกัน: {t_old:>6.1f} วิ")
print(f"  ใหม่ (factories=3) 3 งานพร้อมกัน: {t_new:>6.1f} วิ")
if t_new < t_old:
    print(f"  เร็วกว่า {t_old / t_new:.1f} เท่า")
else:
    print("  ไม่เร็วขึ้น (งานไม่หนักพอจะเห็นผล)")

print()
print("=" * 74)
