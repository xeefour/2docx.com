"""
docserver_replace_image.py
==========================
ตัวอย่าง Python: เปลี่ยนรูปในเอกสารผ่าน docserver (Carbone)

หลักการสำคัญ
------------
Carbone (Community Edition) ใส่รูปเองไม่ได้ ตัวอย่างนี้จึงแยกเป็น 3 ขั้น:

    1. ให้ Carbone เติมข้อความลงแม่แบบก่อน        -> ได้ .docx
    2. ฉีดรูปลงไฟล์ .docx ที่เติมข้อความแล้ว        -> ได้ .docx ที่มีรูป
    3. ส่งไฟล์นั้นกลับเข้า Carbone แปลงเป็น PDF

ห้ามสลับขั้น 1 กับ 2 เพราะการฉีดรูปเขียนทับ XML ของไฟล์ .docx
ซึ่งเป็นไฟล์เดียวกับที่เก็บข้อความ สลับแล้วข้อความจะหาย

รูปถูกจับคู่ด้วย "ช่องคำอธิบาย" (Alt Text) ของรูปในไฟล์ Word
เตรียมแม่แบบ: คลิกขวารูป -> คุณสมบัติ -> Alt Text -> ใส่ชื่อชอง เช่น "ตราสัญลักษณ์"

ติดตั้ง:  pip install requests python-docx Pillow
รัน:      python tools\docserver\docserver_replace_image.py
"""

import base64
import io
import json
import sys
from pathlib import Path

import requests
from docx import Document
from PIL import Image

# ============================================================
#  ตั้งค่า
# ============================================================
DOCSERVER = "http://127.0.0.1:4000"
API_KEY = "carbon-ce"          # ไม่ได้ตรวจจริงใน Community Edition แต่ควรส่งเสมอ
HERE = Path(__file__).parent
# ไฟล์ที่ต้องใช้ร่วมกับชุดทดสอบอยู่ที่ราก repo จึงต้องขึ้นไป 2 ชั้น
# (ย้ายจากราก repo เดิมที่ HERE คือราก เป็น tools/docserver/)
REPO = HERE.parent.parent
TEMPLATE = REPO / "tests" / "part-04-images" / "templates" / "รูปภาพ.docx"
OUT_DIR = HERE / "output-example"

HEADERS = {
    "Authorization": f"Bearer {API_KEY}",
    "carbone-version": "5",     # จำเป็นสำหรับ v5
    "Content-Type": "application/json",
}


# ============================================================
#  ขั้นที่ 1 — อัปโหลดแม่แบบ (ทำครั้งเดียว)
# ============================================================
def upload_template(path: Path) -> str:
    with path.open("rb") as f:
        r = requests.post(
            f"{DOCSERVER}/template",
            headers={"Authorization": f"Bearer {API_KEY}"},
            files={"template": (path.name, f,
                                "application/vnd.openxmlformats-officedocument.wordprocessingml.document")},
            timeout=60,
        )
    r.raise_for_status()
    return r.json()["data"]["templateId"]


# ============================================================
#  ขั้นที่ 2 — เติมข้อความ ยังไม่มีรูป
# ============================================================
def fill_text(template_id: str, data: dict) -> bytes:
    r = requests.post(
        f"{DOCSERVER}/render/{template_id}?download=true",
        headers=HEADERS,
        json={"data": data, "convertTo": "docx"},
        timeout=180,
    )
    r.raise_for_status()
    return r.content


# ============================================================
#  ขั้นที่ 3 — ฉีดรูป (ไม่ต้องผ่าน docserver)
# ============================================================
def make_image(color: tuple, label: str, size=(600, 400)) -> bytes:
    """สร้างรูปทดสอบในหน่วยความจำ ไม่ต้องมีไฟล์จริงก็ได้"""
    img = Image.new("RGB", size, color)
    from PIL import ImageDraw
    d = ImageDraw.Draw(img)
    d.rectangle([10, 10, size[0] - 10, size[1] - 10], outline="white", width=8)
    d.text((40, size[1] // 2), label, fill="white")
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def inject_images(docx_bytes: bytes, mapping: dict) -> bytes:
    """
    แทนที่รูปตาม Alt Text

    mapping = {"ชื่อช่อง": ไบต์รูป, ...}
    รองรับไบต์, data URI (base64), และ path ของไฟล์
    """
    tmp = OUT_DIR / "_ชั่วคราว.docx"
    tmp.write_bytes(docx_bytes)

    sys.path.insert(0, str(REPO / "tests" / "lib"))
    from docx_image_injector import ImageInjector

    inj = ImageInjector(str(tmp))

    print("  ช่องรูปในแม่แบบ:", ", ".join(inj.placeholders()) or "(ไม่มี)")

    for descr, blob in mapping.items():
        if blob is None:
            # ไม่มีรูป -> ซ่อนทั้งแถวของตาราง (เหมาะกับตารางหลักฐาน)
            inj.hide_row(descr, None)
        elif isinstance(blob, list):
            # หลายรูปในช่องเดียว เรียงต่อกันเป็นแถว
            inj.set_many(descr, blob)
        else:
            # รูปเดี่ยว
            inj.set(descr, blob)

    inj.run()
    for line in inj.log:
        print("   -", line)

    out = OUT_DIR / "เอกสาร-มีรูป.docx"
    inj.save(str(out))
    tmp.unlink(missing_ok=True)
    return out.read_bytes()


# ============================================================
#  ขั้นที่ 4 — เตรียมไฟล์สำหรับ PDF
# ============================================================
def to_pdf_alignment(docx_bytes: bytes, body_only: bool = True) -> bytes:
    """
    เปลี่ยน thaiDistribute เป็น both ก่อนแปลงเป็น PDF

    ทำไมต้องแยก
    ------------
    LibreOffice (ตัวแปลงเป็น PDF) ไม่รู้จักค่า thaiDistribute
    จะแปลงเป็นชิดซ้ายทันที ทำให้ขอบขวาไม่เรียบ

    แต่ Word รองรับ thaiDistribute อยู่แล้ว
    ดังนั้นแม่แบบต้องเก็บค่าเดิมไว้ แล้วเปลี่ยนเฉพาะตอนจะส่งออก PDF

    ทำแบบนี้จึงได้ทั้งสองทาง:
      - PDF  -> ขอบขวาเรียบสมบูรณ์
      - .docx -> ยังเป็น thaiDistribute ให้ Word แสดงผลแบบไทย

    body_only=True = เปลี่ยนเฉพาะย่อหน้าที่จัดวาง thaiDistribute
    ซึ่งในแม่แบบราชการคือทั้งหัวเรื่องและเนื้อความ
    """
    import re
    import shutil
    import zipfile

    src = OUT_DIR / "_จัดวาง-ต้นทาง.docx"
    src.write_bytes(docx_bytes)
    out = OUT_DIR / "_จัดวาง-สำหรับPDF.docx"
    if out.exists():
        out.unlink()

    zin = zipfile.ZipFile(src)
    zout = zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED)
    for item in zin.infolist():
        data = zin.read(item.filename)
        if item.filename == "word/document.xml":
            xml = data.decode("utf8")
            xml = xml.replace('<w:jc w:val="thaiDistribute"/>',
                              '<w:jc w:val="both"/>')
            data = xml.encode("utf8")
        zout.writestr(item, data)
    zout.close()
    zin.close()
    result = out.read_bytes()
    return result


def to_pdf(docx_bytes: bytes) -> bytes:
    """ส่ง .docx เข้า docserver เพื่อแปลงเป็น PDF"""
    r = requests.post(
        f"{DOCSERVER}/render/template?download=true",
        headers=HEADERS,
        json={"template": base64.b64encode(docx_bytes).decode(), "convertTo": "pdf"},
        timeout=180,
    )
    r.raise_for_status()
    return r.content


# ============================================================
#  ตัวอย่างการเรียกใช้
# ============================================================
def main():
    OUT_DIR.mkdir(exist_ok=True)

    print("1) อัปโหลดแม่แบบ")
    tid = upload_template(TEMPLATE)
    print("   templateId =", tid)

    print("2) ให้ Carbone เติมข้อความ (ยังไม่มีรูป)")
    docx = fill_text(tid, {
        "ชื่อเรื่อง": "บันทึกการตรวจสอบระบบ",
        "วันที่": "30 กันยายน 2569",
        "ผู้ตรวจสอบ": "นายสมชาย ใจดี",
    })
    print(f"   ได้ .docx {len(docx):,} bytes")

    print("3) ฉีดรูป")
    seal = make_image((20, 90, 160), "ตราสัญลักษณ์", (500, 500))
    photos = [make_image(c, f"หลักฐาน {i+1}")
              for i, c in enumerate([(180, 40, 120), (200, 120, 30), (30, 140, 70)])]

    mapping = {
        "ตราสัญลักษณ์": seal,      # รูปเดี่ยว
        "ภาพในตาราง": photos[0],   # รูปเดี่ยวในตาราง
        "ภาพแถว1": photos,          # หลายรูปในช่องเดียว
        "ภาพแถว2": None,           # ไม่มีรูป -> ซ่อนแถวนั้นทิ้ง
    }
    with_img = inject_images(docx, mapping)
    print(f"   ได้ .docx {len(with_img):,} bytes")

    print("4) แตกเป็นสองทาง")
    # 4a) ฉบับแก้ไข — คง thaiDistribute ไว้ ให้ Word แสดงผลแบบไทย
    (OUT_DIR / "ฉบับแก้ไข.docx").write_bytes(with_img)
    print("   .docx ฉบับแก้ไข  (คง thaiDistribute ไว้ให้ Word)")

    # 4b) ฉบับส่งมอบ PDF — เปลี่ยนเป็น both เพื่อให้ขอบขวาเรียบ
    pdf = to_pdf(to_pdf_alignment(with_img))
    (OUT_DIR / "ผลลัพธ์.pdf").write_bytes(pdf)
    print(f"   PDF ฉบับส่งมอบ   {len(pdf):,} bytes  (ใช้ both)")

    print("\nเสร็จแล้ว — ไฟล์อยู่ใน", OUT_DIR)


if __name__ == "__main__":
    main()
