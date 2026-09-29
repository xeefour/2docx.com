# -*- coding: utf-8 -*-
"""
ทดสอบสมมติฐาน: หลังจากหมดเวลา (timeout) ครั้งหนึ่ง
ระบบจะ "ค้าง" ต่อเนื่องจนเอกสารปกติก็แปลงไม่ได้หรือไม่

ถ้าเป็นจริง = ปัญหาสำคัญมากสำหรับระบบจริง
เพราะเอกสารหนัก 1 ฉบับ จะทำให้ระบบล่มทั้งระบบ
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


def get_tplid():
    up = os.path.join(OUTD, "_zz-up.json")
    subprocess.run([CURL, "-s", "-o", up, "-X", "POST", f"{BASE}/template",
                    "-H", "Authorization: Bearer carbon-ce",
                    "-F", f"template=@{TPL}", "--max-time", "120"],
                   capture_output=True)
    return json.load(open(up, encoding="utf-8"))["data"]["templateId"]


tpl_id = get_tplid()


def run(data, tag, limit=LIMIT):
    pf = os.path.join(OUTD, "_zz-pf.json")
    with open(pf, "w", encoding="utf-8") as f:
        json.dump({"data": data, "convertTo": "pdf"}, f, ensure_ascii=False)
    out = os.path.join(OUTD, f"_zz_{tag}.pdf")
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


def light():
    return {"items": [{"ลำดับ": str(i+1), "รายการ": f"รายการที่ {i+1}",
                       "จำนวน": f"{i+1} ชิ้น"} for i in range(20)],
            "รายการว่าง": [], "เร่งด่วน": True, "ปกติ": False,
            "กลุ่ม": [{"ชื่อกลุ่ม": "ก", "รายการ": [{"ชื่อ": "x"}]}]}


def heavy(tl):
    return {"items": [{"ลำดับ": str(i+1),
                       "รายการ": ("ก" * tl) if i == 0 else f"รายการที่ {i+1}",
                       "จำนวน": f"{i+1} ชิ้น"} for i in range(200)],
            "รายการว่าง": [], "เร่งด่วน": True, "ปกติ": False,
            "กลุ่ม": [{"ชื่อกลุ่ม": "ก", "รายการ": [{"ชื่อ": "x"}]}]}


def mem():
    r = subprocess.run(["docker", "stats", "carbone-thai", "--no-stream",
                        "--format", "{{.MemUsage}}"],
                       capture_output=True, text=True)
    return r.stdout.strip()


print("=" * 70)
print(" ทดสอบ: หลังหมดเวลาแล้วระบบยังทำงานไหม")
print("=" * 70)
print()

# ---------- รอบที่ 1: เอกสารเบา ต้องผ่าน ----------
print("ช่วงที่ 1 — ก่อนมีเอกสารหนัก")
for i in range(3):
    dt, ok, pg = run(light(), f"pre{i}")
    print(f"  เบา #{i+1}: {dt:>6.1f} วิ  {pg:>3} หน้า  {'OK' if ok else 'ล้มเหลว'}")
print(f"  RAM: {mem()}")
print()

# ---------- รอบที่ 2: เอกสารหนักจนหมดเวลา ----------
print("ช่วงที่ 2 — ยิงเอกสารหนักจนหมดเวลา")
dt, ok, pg = run(heavy(200 * 1024), "boom", limit=LIMIT)
print(f"  หนัก: {dt:>6.1f} วิ  {'OK' if ok else 'หมดเวลา'}")
print(f"  RAM: {mem()}")
print()

# ---------- รอบที่ 3: กลับมาเอกสารเบา จะยังผ่านไหม ----------
print("ช่วงที่ 3 — หลังหมดเวลา เอกสารเบายังทำได้ไหม")
results = []
for i in range(4):
    dt, ok, pg = run(light(), f"post{i}")
    results.append(ok)
    print(f"  เบา #{i+1}: {dt:>6.1f} วิ  {pg:>3} หน้า  {'OK' if ok else 'ล้มเหลว'}")
print(f"  RAM: {mem()}")
print()

# ---------- สรุป ----------
print("=" * 70)
n_after = sum(1 for r in results if r)
print(f" ผลหลังหมดเวลา: ผ่าน {n_after}/{len(results)}")
if n_after == len(results):
    print(" >>> ระบบฟื้นตัวเองได้ ไม่มีปัญหาต่อเนื่อง")
else:
    print(" >>> ปัญหา! เอกสารหนักทำให้ระบบค้าง")
    print("     ต้อง restart container หรือแยกงานเป็นชิ้น")
print("=" * 70)
