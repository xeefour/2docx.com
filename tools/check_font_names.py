# -*- coding: utf-8 -*-
"""ตรวจชื่อฟอนต์จริงข้างในไฟล์ .ttf"""
import os
from PIL import ImageFont

D = r"D:\2docx.com\tests\lib\fonts\_จากrar"
n = 0
for root, dirs, files in os.walk(D):
    for f in sorted(files):
        if not f.lower().endswith(".ttf"):
            continue
        p = os.path.join(root, f)
        n += 1
        try:
            ft = ImageFont.truetype(p)
            fam, sty = ft.getname()
            rel = os.path.relpath(p, D)
            print(f"  {rel:<48} -> {fam!r} / {sty}")
        except Exception as e:
            print(f"  {f:<48} -> err {e}")
print(f"\n  รวม {n} ไฟล์")

