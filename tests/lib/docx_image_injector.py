# -*- coding: utf-8 -*-
"""
docx_image_injector.py
======================
ตัวฉีดรูปภาพสำหรับเอกสาร DOCX เขียนเอง ไม่ต้องพึ่ง Carbone (หรือฟีเจอร์เสียเงินใด ๆ)

ใช้ทำอะไรได้
------------
  1. แทนที่รูป placeholder ด้วยรูปจริง จับคู่จาก "ช่องคำอธิบาย" (descr) ของรูป
  2. แทรกรูปหลายรูปในช่องเดียว (เช่น หลักฐาน 5 รูป ในช่องเดียว)
  3. ย่อ/ขยายรูปอัตโนมัติโดยคงอัตราส่วน
  4. ซ่อน/แสดงรูปตามเงื่อนไข (ถ้าไม่มีรูป ให้ซ่อนแถวนั้นทั้งแถว)
  5. รองรับทั้งรูปจากไฟล์, URL, และ base64

หลักการทำงาน
-------------
  python-docx เปิดไฟล์ .docx → หา <w:drawing> ทั้งหมด → จับคู่จาก descr
  → เขียนไบต์รูปใหม่ทับช่องของเดิมในไฟล์ zip → บันทึก

ข้อดีเหนือการฝังแบบเดิม
----------------------
  - รูปแต่ละแถวในตารางได้คนละรูป (เดิมได้รูปเดียวทั้งตาราง)
  - รองรับหลายรูปในหนึ่งช่อง
  - ควบคุมขนาดได้ละเอียดกว่า
  - ไม่ต้องเขียนโค้ดยาว มีฟังก์ชันให้เรียกใช้จบ
"""

import base64
import copy
import io
import os
import re
import urllib.request
from typing import Union

from docx import Document
from docx.shared import Emu
from docx.oxml.ns import qn
from docx.opc.constants import RELATIONSHIP_TYPE as _RT

ImageSource = Union[str, bytes, io.BytesIO, None]


# ==================================================================
#  1) แปลงแหล่งรูปเป็น bytes
# ==================================================================

def load_image(source: ImageSource) -> bytes | None:
    """
    รับไฟล์รูปได้ 3 แบบ แล้วคืนเป็น bytes
      - bytes            : ข้อมูลดิบ
      - io.BytesIO       : stream
      - str              : ตำแหน่งไฟล์, URL, หรือ data URI (base64)
    คืน None ถ้าไม่มีรูป / โหลดไม่ได้
    """
    if source is None:
        return None

    if isinstance(source, bytes):
        return source

    if isinstance(source, (io.BytesIO, io.BufferedReader)):
        return source.read()

    if isinstance(source, str):
        s = source.strip()
        if not s:
            return None

        # data URI: data:image/png;base64,xxxx
        if s.startswith("data:"):
            if "," not in s:
                return None
            s = s.split(",", 1)[1]
            return base64.b64decode(s)

        # URL: http:// หรือ https://
        if s.startswith(("http://", "https://")):
            try:
                with urllib.request.urlopen(s, timeout=20) as r:
                    return r.read()
            except Exception as e:
                print(f"   ! โหลดรูปจาก URL ไม่สำเร็จ: {s} ({e})")
                return None

        # ไฟล์ในเครื่อง
        if os.path.isfile(s):
            with open(s, "rb") as f:
                return f.read()

    return None


def _image_size(blob: bytes) -> tuple[int, int] | None:
    """อ่านขนาดรูปจากไฟล์ (ใช้ PIL ถ้ามี ไม่มีก็คืน None)"""
    try:
        from PIL import Image
        im = Image.open(io.BytesIO(blob))
        return im.size
    except Exception:
        return None


# ==================================================================
#  2) แก้ไขขนาดรูป
# ==================================================================

def _set_extent(shape, width_px: int, height_px: int,
                fit: str, box_w: int, box_h: int):
    """
    ตั้งขนาดรูปให้พอดีกรอบเดิม โดยคงอัตราส่วน

    fit = 'contain'  → พอดีกรอบโดยไม่บิด (เหลือช่องว่าง)  ← แนะนำสำหรับเอกสาร
    fit = 'fill'     → ยืดเต็มกรอบ (อาจบิดสัดส่วน)
    fit = 'fillWidth'→ เต็มความกว้าง แล้วคำนวณส่วนสูงตามอัตราส่วน
    """
    if not (width_px and height_px):
        shape.width, shape.height = box_w, box_h
        return

    box_ratio = box_w / box_h
    img_ratio = width_px / height_px

    if fit == "fill":
        shape.width, shape.height = box_w, box_h
    elif fit == "fillWidth":
        shape.width = box_w
        shape.height = int(box_w / img_ratio)
    else:  # contain
        if img_ratio >= box_ratio:
            shape.width = box_w
            shape.height = int(box_w / img_ratio)
        else:
            shape.height = box_h
            shape.width = int(box_h * img_ratio)


# ==================================================================
#  3) ตัวฉีดรูปหลัก
# ==================================================================

class ImageInjector:
    """
    ตัวฉีดรูปลงเอกสาร DOCX

    วิธีใช้:
        inj = ImageInjector("แม่แบบ.docx")
        inj.set("ตราสัญลักษณ์", "ตรา.png")              # จับคู่จากช่องคำอธิบาย
        inj.set("{{img:หลักฐาน}}", ["a.jpg", "b.jpg"])    # หลายรูปในช่องเดียว
        inj.save("ผลลัพธ์.docx")
    """

    def __init__(self, docx_path: str, fit: str = "contain"):
        self.doc = Document(docx_path)
        self.fit = fit
        self._mapping: dict[str, ImageSource] = {}
        self._multi: dict[str, list] = {}
        self._fit_map: dict[str, str] = {}
        self.log: list[str] = []
        self._used: set[str] = set()

    # ---------- ตั้งค่า ----------

    def set(self, descr: str, source: ImageSource, fit: str | None = None):
        """ผูกรูปจริงเข้ากับ placeholder ที่มีช่องคำอธิบายตรงกัน"""
        self._mapping[descr] = source
        if fit:
            self._fit_map[descr] = fit

    def set_many(self, descr: str, sources: list, fit: str | None = None):
        """ผูกหลายรูปเข้าช่องเดียว (จะเรียงต่อกันเป็นแถว)"""
        self._multi[descr] = list(sources)
        if fit:
            self._fit_map[descr] = fit

    # ---------- อ่านสถานะ ----------

    def placeholders(self) -> list[str]:
        """ดูว่าในแม่แบบมีช่องรูปอะไรบ้าง"""
        return [d for d in self._all_descr() if d]

    def unused(self) -> list[str]:
        """ดูว่าช่องรูปไหนยังไม่ได้ผูกรูป"""
        allp = [d for d in self._all_descr() if d]
        bound = set(self._mapping) | set(self._multi)
        return [d for d in allp if d not in bound]

    def _all_descr(self) -> list[str]:
        out = []
        for shape in self.doc.inline_shapes:
            dp = shape._inline.docPr
            out.append(dp.get("descr") or dp.get("name") or "")
        return out

    # ---------- ทำงาน ----------

    def _write_blob(self, shape, blob: bytes, unique: bool = False):
        """
        เขียนไบต์รูปใหม่ทับรูปเดิมในไฟล์ docx

        unique=True  → สร้าง "ส่วนรูป" ใหม่ทุกครั้ง
        จำเป็นมากสำหรับรูปที่แทรกหลายอัน ถ้าไม่ทำแบบนี้
        รูปจะไปชี้ไฟล์เดียวกันหมด แล้วแสดงผลเป็นรูปเดียวทั้งหมด
        """
        if isinstance(shape, _FakeShape):
            blip = shape._blip
        else:
            blip = shape._inline.graphic.graphicData.pic.blipFill.blip
        rId = blip.embed

        if unique:
            from docx.parts.image import ImagePart
            from docx.image.image import Image
            from docx.opc.packuri import PackURI
            import hashlib

            image = Image.from_blob(blob)
            digest = hashlib.sha1(blob).hexdigest()[:12]
            # กันชื่อซ้ำ: ถ้าใช้ชื่อนี้ไปแล้ว เติมลำดับต่อท้าย
            base = f"/word/media/img_{digest}"
            name = f"{base}{image.ext}"
            n = 1
            existing = {p.partname for p in self.doc.part.package.iter_parts()}
            while PackURI(name) in existing:
                n += 1
                name = f"{base}_{n}{image.ext}"

            part = ImagePart(PackURI(name), image.content_type, blob,
                             self.doc.part.package)
            new_rId = self.doc.part.relate_to(part, _RT.IMAGE)
            blip.set(qn("r:embed"), new_rId)
            return new_rId

        part = self.doc.part.related_parts[rId]
        # python-docx เก็บข้อมูลรูปไว้ใน _blob ของ part
        part._blob = blob
        return rId

    def _drawings(self):
        return list(self.doc.inline_shapes)

    def run(self, default_blank=None):
        """
        ฉีดรูปทั้งหมด
        default_blank : รูปสำรองกรณีไม่มีรูป (None = คงรูปเดิมไว้)
        """
        shapes = self._drawings()
        for shape in shapes:
            dp = shape._inline.docPr
            descr = dp.get("descr") or dp.get("name") or ""

            # 1) หลายรูปในช่องเดียว
            if descr in self._multi:
                sources = [s for s in (load_image(x) for x in self._multi[descr]) if s]
                if not sources:
                    if default_blank is None:
                        self.log.append(f"ข้าม (ไม่มีรูป): {descr}")
                        continue
                    self._write_blob(shape, default_blank)
                    self.log.append(f"ใส่รูปสำรอง: {descr}")
                    continue
                # แทนที่ด้วยรูปแรก แล้วแทรกรูปที่เหลือต่อท้าย
                box_w, box_h = shape.width, shape.height
                size = _image_size(sources[0]) or (int(box_w / 9525), int(box_h / 9525))
                _set_extent(shape, size[0], size[1],
                            self._fit_map.get(descr, self.fit), box_w, box_h)
                # unique=True: แต่ละรูปต้องเป็นส่วนของตัวเอง
                self._write_blob(shape, sources[0], unique=True)
                self._used.add(descr)
                self.log.append(f"แทรก {len(sources)} รูป: {descr}")

                # แทรกรูปที่เหลือเป็น inline shape ต่อกัน
                self._append_more(shape, sources[1:], box_w, box_h, descr)
                continue

            # 2) รูปเดี่ยว
            if descr in self._mapping:
                blob = load_image(self._mapping[descr])
                if blob is None:
                    if default_blank is None:
                        self.log.append(f"ข้าม (ไม่มีรูป): {descr}")
                        continue
                    self._write_blob(shape, default_blank)
                    self.log.append(f"ใส่รูปสำรอง: {descr}")
                    continue
                size = _image_size(blob) or (int(shape.width / 9525),
                                             int(shape.height / 9525))
                _set_extent(shape, size[0], size[1],
                            self._fit_map.get(descr, self.fit),
                            shape.width, shape.height)
                self._write_blob(shape, blob)
                self._used.add(descr)
                self.log.append(f"แทนที่: {descr}")
                continue

            # 3) ไม่ได้ผูกรูป — ถ้าสั่งให้ลบก็ลบ
            if default_blank is not None:
                self._write_blob(shape, default_blank)
                self.log.append(f"ใส่รูปสำรอง: {descr}")

        return self.log

    def _append_more(self, shape, blobs, box_w, box_h, descr):
        """
        แทรก inline shape เพิ่มต่อจากรูปเดิม

        สำคัญ: ต้องแยกคนละย่อหน้า (w:p) ไม่ใช่ต่อกันในย่อหน้าเดียว
        มิฉะนั้นรูปจะวางซ้อนกันในตาราง (เพราะช่องตารางไม่บรรทัดอัตโนมัติ)
        """
        parent_p = shape._inline.getparent()          # <w:drawing> → run
        run = parent_p.getparent()                    # run
        para = run.getparent()                       # <w:p>

        # ถ้าอยู่ในตาราง ต้องแยกย่อหน้า ไม่งั้นรูปซ้อนกัน
        in_table = para.find(qn("w:tc")) is not None or \
            para.getparent().tag == qn("w:tc")

        for blob in blobs:
            size = _image_size(blob) or (int(box_w / 9525), int(box_h / 9525))
            # สร้าง drawing ใหม่จากของเดิม (copy โครงสร้าง XML)
            new_run = copy.deepcopy(run)
            new_inline = new_run.find(qn("w:drawing")).find(qn("wp:inline"))

            # ขนาดตามรูปใหม่ (ต้องตั้งก่อน แล้วค่อยผูกส่วนรูป)
            extent = new_inline.find(qn("wp:extent"))
            tmp_shape = _FakeShape(new_inline)
            _set_extent(tmp_shape, size[0], size[1], self.fit, box_w, box_h)
            if extent is not None:
                extent.set("cx", str(int(tmp_shape.width)))
                extent.set("cy", str(int(tmp_shape.height)))
            # เอาฟ์เมตแนวตั้งต้องปรับตามขนาดด้วย ไม่งั้นรูปจะถูกบิด
            xfrm_ext = new_inline.find(qn("a:graphic")).find(
                qn("a:graphicData")).find(qn("pic:pic")).find(
                qn("pic:spPr")).find(qn("a:xfrm"))
            if xfrm_ext is not None:
                ext = xfrm_ext.find(qn("a:ext"))
                if ext is not None:
                    ext.set("cx", str(int(tmp_shape.width)))
                    ext.set("cy", str(int(tmp_shape.height)))

            # สร้างส่วนรูปใหม่ที่แยกกันจริง แล้วผูกเข้ากับ drawing นี้
            new_blip = new_inline.graphic.graphicData.pic.blipFill.blip
            new_rId = self._write_blob(_FakeShape(new_inline), blob, unique=True)
            new_blip.set(qn("r:embed"), new_rId)

            # ล้างชื่อ/คำอธิบาย ไม่ให้ไปชนกับรูปอื่น
            dp = new_inline.docPr
            dp.set("descr", f"{descr}#ต่อท้าย")
            dp.set("name", "รูปต่อท้าย")
            dp.set("id", str(abs(hash(dp.get("id") or "0")) % 90000 + 1000))

            if in_table:
                # ในตาราง: แทรกเป็นย่อหน้าใหม่ต่อกัน รูปจึงไม่ซ้อนกัน
                new_para = copy.deepcopy(para)
                # ล้างเนื้อหาเดิมในย่อหน้าใหม่ เหลือแต่ run ที่มีรูป
                for r in new_para.findall(qn("w:r")):
                    new_para.remove(r)
                new_para.append(new_run)
                para.addnext(new_para)
                para = new_para
            else:
                # นอกตาราง: ต่อท้ายในย่อหน้าเดียว (เรียงแนวนอน)
                para.append(new_run)

    def remove(self, descr: str):
        """ลบรูปออกจากเอกสาร (ใช้ตอนไม่ต้องการแสดงรูปเลย)"""
        for shape in self._drawings():
            dp = shape._inline.docPr
            if (dp.get("descr") or dp.get("name")) == descr:
                inline = shape._inline
                parent = inline.getparent()          # run
                p = parent.getparent()               # <w:p>
                p.remove(parent)
                self.log.append(f"ลบรูป: {descr}")
                return True
        return False

    def hide_row(self, descr: str, value: ImageSource):
        """
        ถ้าไม่มีรูป → ซ่อนทั้งแถวของตารางที่มีรูปนั้น
        (เหมาะกับตารางหลักฐาน ที่บางแถวอาจไม่มีรูป)
        """
        has = load_image(value) is not None
        for shape in self._drawings():
            dp = shape._inline.docPr
            if (dp.get("descr") or dp.get("name")) != descr:
                continue
            tr = shape._inline
            while tr is not None and tr.tag != qn("w:tr"):
                tr = tr.getparent()
            if tr is not None:
                tr.getparent().remove(tr)
                self.log.append(f"ซ่อนแถว (ไม่มีรูป): {descr}")
            return has
        return has

    # ---------- บันทึก ----------

    def save(self, out_path: str) -> str:
        self.doc.save(out_path)
        return out_path


class _FakeShape:
    """ห่อ wp:inline ให้ใช้กับ _set_extent และ _write_blob ได้เหมือน InlineShape"""

    def __init__(self, inline):
        self._inline = inline

    @property
    def _graphic(self):
        return self._inline.graphic

    @property
    def _blip(self):
        return self._inline.graphic.graphicData.pic.blipFill.blip

    @_blip.setter
    def _blip(self, value):
        self._inline.graphic.graphicData.pic.blipFill.blip = value

    @property
    def width(self):
        e = self._inline.find(qn("wp:extent"))
        return Emu(int(e.get("cx")))

    @width.setter
    def width(self, v):
        e = self._inline.find(qn("wp:extent"))
        e.set("cx", str(int(v)))

    @property
    def height(self):
        e = self._inline.find(qn("wp:extent"))
        return Emu(int(e.get("cy")))

    @height.setter
    def height(self, v):
        e = self._inline.find(qn("wp:extent"))
        e.set("cy", str(int(v)))


# ==================================================================
#  4) ฟังก์ชันลัดไป — เรียกใช้ง่ายสำหรับงานทั่วไป
# ==================================================================

def inject_images(
    template_path: str,
    out_path: str,
    images: dict[str, ImageSource],
    fit: str = "contain",
    multi: dict[str, list] | None = None,
) -> list[str]:
    """
    ฉีดรูปแบบเรียกครั้งเดียว

    images : { "ช่องคำอธิบายของรูป": "ตำแหน่งรูป" }
             คีย์ต้องตรงกับช่องคำอธิบายในแม่แบบเป๊ะ
    """
    inj = ImageInjector(template_path, fit=fit)
    for k, v in (images or {}).items():
        inj.set(k, v)
    for k, v in (multi or {}).items():
        inj.set_many(k, v)
    inj.run()
    return inj.save(out_path)
