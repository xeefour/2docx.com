# -*- coding: utf-8 -*-
"""
ติดตั้งฟอนต์ไทยลง Windows ระดับผู้ใช้ (ไม่ต้องใช้สิทธิ์ผู้ดูแลระบบ)

วิธีนี้เขียนไฟล์ลง %LOCALAPPDATA%\\Microsoft\\Windows\\Fonts
แล้วลงทะเบียนใน HKCU ซึ่ง Windows จะเห็นฟอนต์ทันที
ใช้ได้กับ Word, LibreOffice และโปรแกรมอื่นที่รันด้วยผู้ใช้คนเดียวกัน

หมายเหตุ: ฟอนต์ที่ติดตั้งด้วยวิธีนี้จะใช้ได้เฉพาะบัญชีนี้
            ถ้าต้องการให้ทุกคนในเครื่องใช้ ต้องติดตั้งระดับเครื่องด้วยสิทธิ์ Administrator
"""
import os
import sys
import shutil
import winreg
from pathlib import Path

# path คำนวณจากตำแหน่งไฟล์นี้ ไม่ hardcode D:\2docx.com
REPO = Path(__file__).resolve().parent.parent.parent
RAR_DIR = str(REPO / "tests" / "lib" / "fonts" / "_จากrar")
USER_FONTS = os.path.join(
    os.environ.get("LOCALAPPDATA", ""), r"Microsoft\Windows\Fonts")
REG_PATH = r"SOFTWARE\Microsoft\Windows NT\CurrentVersion\Fonts"

# ฟอนต์ที่ต้องการติดตั้ง (ข้ามชุดที่ซ้ำกัน)
WANT = [
    # (ชื่อไฟล์ที่ต้องการ, ชื่อที่จะลงทะเบียน)
    ("THSarabunIT๙.ttf",       "TH SarabunPSK (ฉบับซีดีการาชการ)"),
    ("THSarabunIT๙ Bold.ttf",  "TH SarabunPSK Bold (ฉบับซีดีการาชการ)"),
    ("THSarabunIT๙ Italic.ttf", "TH SarabunPSK Italic (ฉบับซีดีการาชการ)"),
    ("THSarabunIT๙ BoldItalic.ttf", "TH SarabunPSK Bold Italic (ฉบับซีดีการาชการ)"),
    ("THSarabunNew.ttf",       "TH Sarabun New"),
    ("THSarabunNew Bold.ttf",  "TH Sarabun New Bold"),
    ("THSarabunNew Italic.ttf", "TH Sarabun New Italic"),
    ("THSarabunNew BoldItalic.ttf", "TH Sarabun New Bold Italic"),
    ("TH NiramitIT๙.ttf",   "TH Niramit AS"),
    ("TH NiramitIT๙ Bold.ttf", "TH Niramit AS Bold"),
    ("TH NiramitIT๙ Italic.ttf", "TH Niramit AS Italic"),
    ("TH Niramit AS-IT๙ Bold Italic.ttf", "TH Niramit AS Bold Italic"),
]


def find_source(fname):
    """หาไฟล์ต้นทาง (ค้นทั้งแบบชื่อไทยและชื่อไม่มีไทย)"""
    for root, dirs, files in os.walk(RAR_DIR):
        if fname in files:
            return os.path.join(root, fname)
    return None


def main():
    print("=" * 66)
    print(" ติดตั้งฟอนต์ไทยลง Windows (ระดับผู้ใช้)")
    print("=" * 66)
    print(f"ปลายทาง: {USER_FONTS}")
    print()

    os.makedirs(USER_FONTS, exist_ok=True)

    ok, skip, fail = 0, 0, 0
    for fname, regname in WANT:
        src = find_source(fname)
        if not src:
            print(f"  [ไม่พบ]  {fname}")
            fail += 1
            continue

        dst = os.path.join(USER_FONTS, fname)

        # ถ้ามีอยู่แล้วและขนาดเท่ากัน ให้ข้าม
        if os.path.exists(dst) and os.path.getsize(dst) == os.path.getsize(src):
            already = True
        else:
            try:
                shutil.copy2(src, dst)
                already = False
            except Exception as e:
                print(f"  [คัดลอกไม่ได้] {fname}: {e}")
                fail += 1
                continue

        # ลงทะเบียนใน HKCU
        try:
            with winreg.OpenKey(winreg.HKEY_CURRENT_USER, REG_PATH, 0,
                                winreg.KEY_SET_VALUE) as k:
                winreg.SetValueEx(k, regname, 0, winreg.REG_SZ, dst)
        except Exception as e:
            print(f"  [ลงทะเบียนไม่ได้] {regname}: {e}")
            fail += 1
            continue

        if already:
            print(f"  [มีอยู่แล้ว] {regname}")
            skip += 1
        else:
            print(f"  [ติดตั้ง] {regname}")
            ok += 1

    print()
    print("=" * 66)
    print(f" ติดตั้งใหม่ {ok} · มีอยู่แล้ว {skip} · ไม่สำเร็จ {fail}")
    print("=" * 66)

    if ok or skip:
        print()
        print("หมายเหตุ: โปรแกรมที่เปิดค้างอยู่ต้องปิดแล้วเปิดใหม่ จึงจะเห็นฟอนต์ใหม่")
    return 0 if fail == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
