"""
doc_pipeline.py
===============
ระบบสร้างเอกสารราชการไทยแบบครบวงจร ต่อ docserver (Carbone)

ทำหน้าที่
--------
    1. ให้ Carbone เติมข้อความลงแม่แบบ          -> .docx
    2. ฉีดรูปลงไฟล์ .docx ที่เติมข้อความแล้ว
    3. แตกผลลัพธ์เป็นสองทาง
         - .docx ฉบับแก้ไข  : คง thaiDistribute ไว้ ให้ Word แสดงผลแบบไทย
         - PDF  ฉบับส่งมอบ   : เปลี่ยนเป็น both   ให้ขอบขวาเรียบสมบูรณ์

ทำไมต้องแยกสองทาง
-----------------
    thaiDistribute  คือการกระจายย่อหน้าแบบไทยที่ Word รองรับ
                    แต่ LibreOffice (ตัวแปลงเป็น PDF) ไม่รู้จัก
                    จะทิ้งค่านี้และกลายเป็นชิดซ้ายทันที

    การแก้แม่แบบเป็น both จะแก้ PDF ได้ แต่ทำให้ .docx ที่ส่งออก
    เสียการกระจายแบบไทยไปด้วย เพราะ Carbone คงค่า w:jc เดิมทุกประการ

    วิธีนี้จึงแก้เฉพาะตอนจะส่งออก PDF ไม่แตะแม่แบบ

ใช้เป็นโมดูล
------------
    from doc_pipeline import DocPipeline

    p = DocPipeline()
    result = p.render(
        template_path='แม่แบบ.docx',
        data={'เรื่อง': '...', 'เรียน': '...'},
        images={'ตราสัญลักษณ์': open('ครุฑ.png','rb').read()},
    )
    open(result.docx_path, 'wb').write(result.docx)
    open(result.pdf_path,  'wb').write(result.pdf)

ใช้จากคอมมานด์ไลน์
--------------------
    python tools/doc_pipeline.py ^
        --template แม่แบบ.docx ^
        --data ข้อมูล.json ^
        --images รูป.json ^
        --out เอาสาร
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import sys
import tempfile
import zipfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import requests

# อ่านไฟล์ข้อความด้วย utf-8-sig เพราะไฟล์ที่สร้างจาก PowerShell บน Windows
# จะมี BOM มาด้วย (utf-8-sig รองรับทั้งไฟล์ที่มีและไม่มี BOM)

# ตัวฉีดรูปอยู่ใน tests/lib ของโปรเจกต์นี้ (ย้ายไป tools/ ได้ภายหลัง)
_REPO = Path(__file__).resolve().parent.parent
_LIB = _REPO / "tests" / "lib"
if str(_LIB) not in sys.path:
    sys.path.insert(0, str(_LIB))

from docx_image_injector import ImageInjector  # noqa: E402


DEFAULT_SERVER = os.environ.get("CARBONE_URL", "http://127.0.0.1:4000")
DEFAULT_API_KEY = os.environ.get("CARBONE_API_KEY", "carbon-ce")

# ค่าการจัดวางที่ LibreOffice แปลงเป็นชิดซ้ายทันที
THAI_DISTRIBUTE = 'thaiDistribute'
# ค่าที่ให้ผลดีที่สุดเมื่อแปลงเป็น PDF
JUSTIFY = 'both'


# ============================================================
#  เครื่องมือจัดการการจัดวางย่อหน้า
# ============================================================
def apply_pdf_alignment(docx_bytes: bytes) -> tuple[bytes, int]:
    """
    แทน thaiDistribute เป็น both เพื่อเตรียมแปลงเป็น PDF

    คืนค่า (ไฟล์ที่แก้แล้ว, จำนวนย่อหน้าที่เปลี่ยน)
    """
    with tempfile.NamedTemporaryFile(suffix=".docx", delete=False) as tf:
        tf.write(docx_bytes)
        src = Path(tf.name)

    dst = src.with_name(src.stem + "-both.docx")
    changed = 0
    try:
        with zipfile.ZipFile(src) as zin:
            with zipfile.ZipFile(dst, "w", zipfile.ZIP_DEFLATED) as zout:
                for item in zin.infolist():
                    data = zin.read(item.filename)
                    if item.filename == "word/document.xml":
                        xml = data.decode("utf8")
                        old = f'<w:jc w:val="{THAI_DISTRIBUTE}"/>'
                        changed = xml.count(old)
                        data = xml.replace(old, f'<w:jc w:val="{JUSTIFY}"/>').encode("utf8")
                    zout.writestr(item, data)
        return dst.read_bytes(), changed
    finally:
        src.unlink(missing_ok=True)
        dst.unlink(missing_ok=True)


# ============================================================
#  ผลลัพธ์
# ============================================================
@dataclass
class RenderResult:
    """ผลลัพธ์การสร้างเอกสาร มีสองทางเสมอ"""

    docx: bytes                      # ฉบับแก้ไข — คง thaiDistribute
    pdf: bytes                       # ฉบับส่งมอบ — ใช้ both
    template_id: str
    image_log: list[str] = field(default_factory=list)
    aligned_paragraphs: int = 0
    out_dir: Path | None = None
    stem: str = "เอกสาร"

    @property
    def docx_path(self) -> Path:
        return (self.out_dir or Path.cwd()) / f"{self.stem}-ฉบับแก้ไข.docx"

    @property
    def pdf_path(self) -> Path:
        return (self.out_dir or Path.cwd()) / f"{self.stem}.pdf"

    def save(self, out_dir: str | Path | None = None, stem: str | None = None) -> RenderResult:
        """เขียนไฟล์ทั้งสองลงดิสก์"""
        if out_dir is not None:
            self.out_dir = Path(out_dir)
        if stem is not None:
            self.stem = stem
        self.out_dir.mkdir(parents=True, exist_ok=True)
        self.docx_path.write_bytes(self.docx)
        self.pdf_path.write_bytes(self.pdf)
        return self


# ============================================================
#  ตัวสร้างเอกสาร
# ============================================================
class DocPipeline:
    """
    ตัวสร้างเอกสารราชการไทย

    ตัวอย่าง::

        p = DocPipeline()
        p.upload_template('แม่แบบ.docx')          # ทำครั้งเดียว เก็บ templateId
        r = p.render(template_id, data, images).save('เอาสาร')
    """

    def __init__(
        self,
        server: str = DEFAULT_SERVER,
        api_key: str = DEFAULT_API_KEY,
        timeout: int = 180,
    ):
        self.server = server.rstrip("/")
        self.api_key = api_key
        self.timeout = timeout
        self._headers = {
            "Authorization": f"Bearer {api_key}",
            "carbone-version": "5",
            "Content-Type": "application/json",
        }

    # ---------- ขั้น 1: อัปโหลดแม่แบบ ----------
    def upload_template(self, template_path: str | Path) -> str:
        """อัปโหลดแม่แบบ คืน templateId (ทำครั้งเดียวแล้วเก็บไว้ใช้ซ้ำ)"""
        path = Path(template_path)
        if not path.exists():
            raise FileNotFoundError(f"ไม่พบไฟล์แม่แบบ: {path}")
        with path.open("rb") as f:
            r = requests.post(
                f"{self.server}/template",
                headers={"Authorization": f"Bearer {self.api_key}"},
                files={"template": (path.name, f,
                                    "application/vnd.openxmlformats-officedocument"
                                    ".wordprocessingml.document")},
                timeout=self.timeout,
            )
        r.raise_for_status()
        return r.json()["data"]["templateId"]

    # ---------- ขั้น 2: เติมข้อความ ----------
    def _fill_text(self, template_b64: str, data: dict) -> bytes:
        r = requests.post(
            f"{self.server}/render/template?download=true",
            headers=self._headers,
            json={"template": template_b64, "data": data, "convertTo": "docx"},
            timeout=self.timeout,
        )
        r.raise_for_status()
        return r.content

    # ---------- ขั้น 3: ฉีดรูป ----------
    def _inject(self, docx_bytes: bytes, images: dict[str, Any]) -> tuple[bytes, list[str]]:
        with tempfile.TemporaryDirectory() as tmp:
            src = Path(tmp) / "ก่อนฉีดรูป.docx"
            dst = Path(tmp) / "หลังฉีดรูป.docx"
            src.write_bytes(docx_bytes)

            inj = ImageInjector(str(src))
            for descr, source in images.items():
                if source is None:
                    inj.hide_row(descr, None)
                elif isinstance(source, (list, tuple)):
                    inj.set_many(descr, list(source))
                else:
                    inj.set(descr, source)
            inj.run()
            inj.save(str(dst))
            log = list(getattr(inj, "log", []) or [])
            return dst.read_bytes(), log

    # ---------- ขั้น 4: แปลงเป็น PDF ----------
    def _to_pdf(self, docx_bytes: bytes) -> bytes:
        r = requests.post(
            f"{self.server}/render/template?download=true",
            headers=self._headers,
            json={"template": base64.b64encode(docx_bytes).decode(),
                  "data": {}, "convertTo": "pdf"},
            timeout=self.timeout,
        )
        r.raise_for_status()
        return r.content

    # ---------- รวมทุกขั้น ----------
    def render(
        self,
        template: str | Path | None = None,
        data: dict | None = None,
        images: dict[str, Any] | None = None,
        template_id: str | None = None,
    ) -> RenderResult:
        """
        สร้างเอกสารครบวงจร

        ระบุ `template` (path) หรือ `template_id` อย่างใดอย่างหนึ่ง
        """
        if not template and not template_id:
            raise ValueError("ต้องระบุ template หรือ template_id")

        if template_id:
            # ใช้แม่แบบที่อัปโหลดไว้แล้ว
            r = requests.get(
                f"{self.server}/template/{template_id}",
                headers={"Authorization": f"Bearer {self.api_key}"},
                timeout=self.timeout,
            )
            r.raise_for_status()
            template_bytes = r.content
        else:
            template_bytes = Path(template).read_bytes()

        template_b64 = base64.b64encode(template_bytes).decode()

        docx = self._fill_text(template_b64, data or {})

        log: list[str] = []
        if images:
            docx, log = self._inject(docx, images)

        # สองทาง: .docx เก็บค่าเดิม (thaiDistribute) / PDF ใช้ both
        pdf_ready, changed = apply_pdf_alignment(docx)
        pdf = self._to_pdf(pdf_ready)

        return RenderResult(
            docx=docx,
            pdf=pdf,
            template_id=template_id or "(ส่งไฟล์ตรง)",
            image_log=log,
            aligned_paragraphs=changed,
        )


# ============================================================
#  คอมมานด์ไลน์
# ============================================================
def _resolve_image(value: str, base: Path) -> bytes:
    """
    หาไฟล์รูปจากค่าที่ระบุ

    ลองตามลำดับ: ข้างถุง JSON -> โฟลเดอร์ปัจจุบัน -> path เต็ม
    ถ้าไม่เจอค่อยลองตีความเป็น base64
    """
    candidates = [base / value, Path(value), Path(value).resolve()]
    for c in candidates:
        try:
            if c.is_file():
                return c.read_bytes()
        except OSError:
            continue
    try:
        return base64.b64decode(value, validate=True)
    except Exception as exc:
        looked = "\n    ".join(str(c) for c in candidates)
        raise FileNotFoundError(
            f"ไม่พบไฟล์รูป: {value!r}\n  ตรวจแล้ว:\n    {looked}"
        ) from exc


def _load_images(spec: str) -> dict[str, Any]:
    """
    โหลดแผนที่รูปจากไฟล์ JSON

        {"ตราสัญลักษณ์": "ครุฑ.png",
         "ภาพแถว1": ["1.jpg", "2.jpg"],
         "ภาพแถว2": null}

    ค่า null = ไม่มีรูป ให้ซ่อนแถวตารางทิ้ง
    """
    spec_path = Path(spec)
    if spec_path.is_file():
        raw = json.loads(spec_path.read_text(encoding="utf-8-sig"))
        base = spec_path.parent
    else:
        raw = json.loads(spec)
        base = Path.cwd()

    out: dict[str, Any] = {}
    for descr, value in raw.items():
        if value is None:
            out[descr] = None
        elif isinstance(value, (list, tuple)):
            out[descr] = [_resolve_image(str(v), base) for v in value]
        else:
            out[descr] = _resolve_image(str(value), base)
    return out


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="สร้างเอกสารราชการไทยผ่าน docserver")
    ap.add_argument("--template", help="ไฟล์แม่แบบ .docx")
    ap.add_argument("--template-id", help="templateId ที่อัปโหลดไว้แล้ว")
    ap.add_argument("--data", help="ไฟล์ JSON ของข้อมูล")
    ap.add_argument("--images", help="ไฟล์ JSON แผนที่รูป")
    ap.add_argument("--out", default="เอาสาร", help="โฟลเดอร์ผลลัพธ์")
    ap.add_argument("--stem", default="เอกสาร", help="ชื่อไฟล์ผลลัพธ์")
    ap.add_argument("--server", default=DEFAULT_SERVER)
    ap.add_argument("--api-key", default=DEFAULT_API_KEY)
    args = ap.parse_args(argv)

    if not args.template and not args.template_id:
        ap.error("ต้องระบุ --template หรือ --template-id")

    data = json.loads(Path(args.data).read_text(encoding="utf-8-sig")) if args.data else {}
    images = _load_images(args.images) if args.images else None

    pipe = DocPipeline(server=args.server, api_key=args.api_key)

    print("1) เติมข้อความด้วย Carbone")
    result = pipe.render(
        template=args.template,
        template_id=args.template_id,
        data=data,
        images=images,
    )

    if result.image_log:
        print("2) ฉีดรูป")
        for line in result.image_log:
            print("   -", line)

    print(f"3) เตรียม PDF — เปลี่ยน thaiDistribute เป็น both "
          f"{result.aligned_paragraphs} ย่อหน้า")

    result.save(args.out, args.stem)

    print(f"\nเสร็จแล้ว")
    print(f"  ฉบับแก้ไข : {result.docx_path}  ({len(result.docx):,} bytes) "
          f"— คง thaiDistribute ไว้")
    print(f"  ฉบับส่งมอบ : {result.pdf_path}  ({len(result.pdf):,} bytes) "
          f"— ใช้ both")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
