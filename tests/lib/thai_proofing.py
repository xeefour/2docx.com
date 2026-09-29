# -*- coding: utf-8 -*-
"""
ตัวแก้ภาษาไทยสำหรับเอกสาร Word
================================
แก้ปัญหาเส้นหยักแดงใต้ข้อความไทย โดยเฉพาะในส่วนหัวและท้ายเอกสาร

สาเหตุ
-------
Word ตรวจการสะกดตามภาษาที่ประกาศไว้ในไฟล์ (w:lang)
ถ้าไม่มีการระบุภาษา Word จะค่าเป็นภาษาอังกฤษ (en-US)
แล้วตีเส้นหยักแดงใต้ข้อความภาษาไทยทั้งหมด

ส่วนหัว/ท้าย มักถูกลืมตั้งภาษา เพราะ python-docx ไม่ได้ตั้งค่าให้โดยอัตโนมัติ

การแก้ไข
---------
1. ตั้ง w:lang เป็น th-TH  (ภาษาไทย) — ทำให้ Word ตรวจสะกดถูกต้อง
2. ตั้ง noProof           — บอกว่า "ไม่ต้องตรวจ" เหมาะกับข้อความที่ไม่ใช่ภาษาอังกฤษ

ใช้:  from thai_proofing import fix_document
      fix_document("แม่แบบ.docx", "ผลลัพธ์.docx", skip_proof=False)
"""

import os
import re
import shutil
import zipfile

# ภาษาไทย
TH = "th-TH"
# ภาษาอังกฤษ (ใช้กับตัวเลขและอักษรละติน)
EN = "en-US"


def _lang_xml(rpr: str) -> str:
    """สร้างแท็ก w:lang สำหรับภาษาไทย"""
    return f'<w:lang w:val="{EN}" w:eastAsia="{TH}" w:bidi="{TH}"/>'


def _has_thai(text: str) -> bool:
    """ข้อความมีตัวอักษรไทยหรือไม่"""
    return any("฀" <= ch <= "๿" for ch in text)


def fix_xml(xml: str, apply_noproof: bool) -> tuple[str, int]:
    """
    แก้ w:lang และ noProof ใน XML ของ Word

    ทำงานกับ <w:r> ทุกตัว:
      - ถ้ามีข้อความไทย → ตั้ง w:lang เป็น th-TH
      - ถ้า apply_noproof → เพิ่ม <w:noProof/> (ไม่ต้องตรวจสะกด)
    """
    changed = 0

    def fix_run(m):
        nonlocal changed
        run = m.group(0)
        # ดึงข้อความใน run นี้
        texts = re.findall(r"<w:t(?:\s[^>]*)?>(.*?)</w:t>", run, re.S)
        txt = "".join(texts)
        if not txt.strip():
            return run
        # เฉพาะ run ที่มีข้อความเท่านั้น
        if not _has_thai(txt) and not apply_noproof:
            return run
        changed += 1

        # แยก rPr ออกมา
        rpr_m = re.search(r"<w:rPr>.*?</w:rPr>|<w:rPr/>", run, re.S)
        if rpr_m:
            rpr = rpr_m.group(0)
            body = run.replace(rpr, "", 1)
        else:
            # ไม่มี rPr → สร้างใหม่
            rpr = "<w:rPr></w:rPr>"
            body = run
            open_end = body.index(">") + 1
            body = body[:open_end] + rpr + body[open_end:]

        # 1) ตั้ง w:lang
        if _has_thai(txt) or True:
            rpr = re.sub(r"<w:lang[^>]*/>", "", rpr)
            rpr = rpr.replace("</w:rPr>", _lang_xml(rpr) + "</w:rPr>")
            if rpr == "<w:rPr></w:rPr>":
                rpr = "<w:rPr>" + _lang_xml(rpr) + "</w:rPr>"

        # 2) เพิ่ม noProof (ถ้าเปิดใช้)
        if apply_noproof and "<w:noProof/>" not in rpr:
            rpr = rpr.replace("</w:rPr>", "<w:noProof/></w:rPr>")
            if rpr == "<w:rPr></w:rPr>":
                rpr = "<w:rPr><w:noProof/></w:rPr>"

        return run.replace("<w:rPr></w:rPr>", rpr, 1) if "<w:rPr>" not in run \
            else re.sub(r"<w:rPr>.*?</w:rPr>|<w:rPr/>", lambda _: rpr, run, count=1, flags=re.S)

    xml = re.sub(r"<w:r(?:\s[^>]*)?>.*?</w:r>", fix_run, xml, flags=re.S)
    return xml, changed


def fix_document(src: str, dst: str | None = None,
                 skip_proof: bool = False,
                 parts: tuple[str, ...] = ("document", "header", "footer")) -> dict:
    """
    แก้ภาษาไทยในไฟล์ .docx

    src          : ไฟล์ต้นฉบับ
    dst          : ไฟล์ผลลัพธ์ (ถ้าไม่ระบุจะเขียนทับ src)
    skip_proof   : True  = ใส่ noProof (ไม่ต้องตรวจสะกดเลย)
                   False = ตั้งภาษาไทย (Word ยังตรวจสะกด แต่เป็นภาษาไทย)
    parts        : ส่วนที่จะแก้

    คืนค่า: สรุปจำนวน run ที่แก้
    """
    if dst is None:
        dst = src

    pattern = re.compile(r"word/(" + "|".join(parts) + r")\d*\.xml$")

    stats = {"document": 0, "header": 0, "footer": 0}
    tmp = dst + ".tmp"

    with zipfile.ZipFile(src) as zin, \
         zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as zout:
        for item in zin.infolist():
            data = zin.read(item.filename)
            m = pattern.search(item.filename)
            if m:
                key = m.group(1)
                xml = data.decode("utf-8")
                xml, n = fix_xml(xml, skip_proof)
                stats[key] = n
                data = xml.encode("utf-8")
            zout.writestr(item, data)

    if src == dst:
        os.replace(tmp, dst)
    else:
        shutil.move(tmp, dst)

    return stats


def check_document(path: str) -> dict:
    """ตรวจสอบว่าไฟล์ตั้งภาษาไทยแล้วหรือยัง"""
    result = {"document": {"th": 0, "en": 0, "noproof": 0},
              "header": {"th": 0, "en": 0, "noproof": 0},
              "footer": {"th": 0, "en": 0, "noproof": 0}}

    with zipfile.ZipFile(path) as z:
        for n in z.namelist():
            m = re.search(r"word/(document|header\d*|footer\d*)\.xml$", n)
            if not m:
                continue
            key = m.group(1).rstrip("0123456789")
            xml = z.read(n).decode("utf-8")
            for lm in re.finditer(r"<w:lang([^>]*)/>", xml):
                attrs = lm.group(1)
                if 'w:eastAsia="th-TH"' in attrs or 'w:val="th-TH"' in attrs:
                    result[key]["th"] += 1
                else:
                    result[key]["en"] += 1
            result[key]["noproof"] += len(re.findall(r"<w:noProof/>", xml))

    return result


if __name__ == "__main__":
    import sys
    if len(sys.argv) < 2:
        print("ใช้: python thai_proofing.py <ไฟล์.docx> [skip_proof]")
        sys.exit(1)
    path = sys.argv[1]
    skip = len(sys.argv) > 2 and sys.argv[2].lower() in ("skip", "noproof", "1", "true")
    s = fix_document(path, skip_proof=skip)
    print("แก้แล้ว:", s)
