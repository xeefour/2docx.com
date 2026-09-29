# -*- coding: utf-8 -*-
"""ฉีดรูปลงแม่แบบของส่วนที่ 4 แล้วบันทึกไฟล์ (เรียกจาก test.ps1)"""
import os, sys, json

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "lib"))
from docx_image_injector import ImageInjector

TPL = os.path.join(HERE, "templates", "รูปภาพ.docx")
DATA = os.path.join(HERE, "data", "ข้อมูล.json")
OUTD = os.path.join(HERE, "output")
os.makedirs(OUTD, exist_ok=True)
OUT = os.path.join(OUTD, "ฉีดรูป.docx")

data = json.load(open(DATA, encoding="utf-8"))

inj = ImageInjector(TPL, fit="contain")
inj.set("ตราสัญลักษณ์", data["ตราสัญลักษณ์"])
inj.set_many("หลักฐานหลายรูป", data["หลักฐานหลายรูป"])
inj.set("ภาพในตาราง", data["ภาพในตาราง"])
inj.set("ภาพแถว1", data["ภาพแถว1"])
inj.run()
inj.hide_row("ภาพแถว2", data["ภาพแถว2"])
inj.remove("รูปที่ไม่ต้องการ")
inj.save(OUT)

for line in inj.log:
    print(line)
print("บันทึก:", os.path.basename(OUT), f"({os.path.getsize(OUT):,} bytes)")
