# -*- coding: utf-8 -*-
"""หาขนาดข้อความที่ระบบรับได้ (LibreOffice มีลิมิตเวลา 60 วิ)"""
import os, sys, json, time, subprocess

HERE = os.path.dirname(os.path.abspath(__file__))
CURL = os.path.join(os.environ.get("SystemRoot", r"C:\Windows"), "System32", "curl.exe")
BASE = "http://127.0.0.1:4000"
TPL = os.path.normpath(os.path.join(HERE, "..", "part-03-table-loop",
                                    "templates", "ตารางและเงื่อนไข.docx"))
OUTD = os.path.join(HERE, "output")
os.makedirs(OUTD, exist_ok=True)

up = os.path.join(OUTD, "_szup.json")
subprocess.run([CURL, "-s", "-o", up, "-X", "POST", f"{BASE}/template",
                "-H", "Authorization: Bearer carbon-ce",
                "-F", f"template=@{TPL}", "--max-time", "180"], capture_output=True)
tpl_id = json.load(open(up, encoding="utf-8"))["data"]["templateId"]
print(f"templateId: {tpl_id}\n")

print("ขนาดข้อความยาวในช่องตาราง:")
print(f"{'ขนาด':>10} {'HTTP':>6} {'เวลา':>10} {'หน้า':>6}  ผล")
print("-" * 52)

rows = []
for kb in [5, 10, 20, 30, 40, 50, 60, 80, 100]:
    long_text = "ก" * (kb * 1024)
    data = {
        "items": [{"ลำดับ": "1", "รายการ": long_text, "จำนวน": "1 รายการ"}],
        "รายการว่าง": [],
        "เร่งด่วน": True,
        "ปกติ": False,
        "กลุ่ม": [{"ชื่อกลุ่ม": "ก", "รายการ": [{"ชื่อ": "x"}]}],
    }
    pf = os.path.join(OUTD, "_sz.json")
    out = os.path.join(OUTD, f"_sz{kb}.pdf")
    with open(pf, "w", encoding="utf-8") as f:
        json.dump({"data": data, "convertTo": "pdf"}, f, ensure_ascii=False)

    t0 = time.time()
    r = subprocess.run([CURL, "-s", "-o", out, "-w", "%{http_code}",
                        "-X", "POST", f"{BASE}/render/{tpl_id}?download=true",
                        "-H", "Authorization: Bearer carbon-ce",
                        "-H", "Content-Type: application/json",
                        "-H", "carbone-version: 5",
                        "--data-binary", f"@{pf}", "--max-time", "90"],
                       capture_output=True, text=True)
    dt = time.time() - t0
    code = r.stdout.strip()

    head = ""
    if os.path.exists(out) and os.path.getsize(out) > 5:
        head = open(out, "rb").read(5).decode("latin1").rstrip("\x00").strip()

    pages = 0
    if head.startswith("%PDF"):
        try:
            import fitz
            pages = len(fitz.open(out))
        except Exception:
            pages = -1

    ok = head.startswith("%PDF")
    rows.append((kb, code, dt, pages, ok))
    print(f"{kb:>8} KB {code:>6} {dt:>9.1f} วิ {pages:>6}  {'OK' if ok else 'FAIL'}")

print("-" * 52)
last_ok = [r for r in rows if r[4]]
if last_ok:
    best = max(last_ok, key=lambda r: r[0])
    print(f"\nขนาดใหญ่ที่สำเร็จ: {best[0]} KB ({best[3]} หน้า, {best[2]:.1f} วิ)")
    print(f"เกินนี้: LibreOffice หมดเวลา 60 วินาที → error w101")
