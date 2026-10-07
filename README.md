# 2docx.com

ระบบสร้างเอกสารราชการไทยจากแม่แบบอัตโนมัติ — ระบบเก่าเป็น API สำหรับระบบอื่นเรียกใช้
ระบบใหม่เป็นแพลตฟอร์ม SaaS ที่มีหน้าเว็บใช้งานเองได้ ทั้งสองรุ่นใช้แกนหลักเดียวกัน
คือ **Carbone (docserver) + ตัวฉีดรูปที่เขียนเอง**

**สถานะ:** ระบบเก่าผ่านการทดสอบ 8 ส่วน · 196 ข้อตรวจ ·
ระบบใหม่รันอยู่จริงที่ `http://127.0.0.1:8090` (14 container ในโปรเจกต์ Docker เดียว)

---

## แผนที่โปรเจกต์

ราก repo แบ่งเป็น **5 โฟลเดอร์** แต่ละอันมีหน้าที่ของตัวเอง ไม่ปนกัน

| โฟลเดอร์ | ใช้ทำอะไร | เข้า Docker image ไหม |
|---|---|---|
| **`docgen-platform/`** | ระบบใหม่ — SaaS ที่มีหน้าเว็บ, API, worker เรนเดอร์งาน | ✅ ทั้งหมด |
| **`dokploy-infra/`** | Docker stack ทั้งระบบ — compose ไฟล์เดียวของทุก container + ค่ามัธยาศาสตร์ | ✅ ตัวมันเองคือ config ของ stack |
| **`tests/`** | ชุดทดสอบระบบเก่า (Python) — รวม `Dockerfile` ที่สร้าง docserver image | เฉพาะ `Dockerfile` |
| **`tools/`** | สคริปต์ช่วยงาน — ตรวจสอบ เทียบผล วิเคราะห์ log | ❌ ยกเว้น `log-analyzer/` ที่เป็น service ใน stack |
| **`data/`** | ข้อมูลรันจริง + สำรอง (gitignored ยกเว้น README) | ❌ |

```
2docx.com/
├── README.md                    ไฟล์นี้ — แผนที่ + ความรู้ที่ใช้ร่วมกันของทั้งสองระบบ
├── ARCHITECTURE.md              สถาปัตยกรรมและการออกแบบ API (เขียนตอนเริ่มโปรเจกต์)
│
├── docgen-platform/             ── ระบบใหม่ (SaaS) ──
│   ├── apps/
│   │   ├── web/                 หน้าเว็บ Next.js
│   │   ├── api/                 REST API (Fastify) — ผู้ใช้ สิทธิ์ แม่แบบ งานเรนเดอร์
│   │   └── worker/              คนงานเบื้องหลัง — รับงานจาก NATS แล้วเรนเดอร์
│   ├── packages/shared/         โค้ดที่ใช้ร่วมกันทั้ง 3 แอป (ชนิดข้อมูล, env schema)
│   ├── gateway/                 Caddyfile — ทางเข้าเดียวของทั้งระบบ
│   ├── tools/                   สคริปต์ตรวจสอบฝั่งระบบใหม่
│   ├── tests/                   ทดสอบด้วย CDP (ขับ Chrome จริง) + เกณฑ์อัตโนมัติ
│   ├── logs/                    สคริปต์ชั่วคราวที่ใช้ตอนทำงาน (gitignored)
│   ├── BAND.md                  กฎ / บันทึกบทเรียน / สิ่งที่ค้าง — **อ่านก่อนแก้โค้ด**
│   └── README.md                คู่มือระบบใหม่ฉบับเต็ม
│
├── dokploy-infra/               ── Docker stack ทั้งระบบ ──
│   ├── docker-compose.yml           ไฟล์ compose เดียวของทั้ง 14 container
│   ├── docker-compose.dev-ports.yml override ตอน debug (ผูก 127.0.0.1)
│   ├── .env                         ค่ากลางทั้งระบบ (gitignored)
│   ├── .env.example                 ตัวอย่างทุกคีย์
│   ├── observability/               Loki + Alloy + คู่มือ
│   ├── nats/  valkey/  rclone/     config ของ service แต่ละตัว
│   └── README.md                    คู่มือ stack
│
├── tests/                       ── ชุดทดสอบระบบเก่า ──
│   ├── lib/                      โค้ดที่ใช้จริง (docx_image_injector.py, fonts/)
│   ├── part-01-setup/ … part-10-header-footer/   10 ส่วน แต่ละส่วนรันได้เอง
│   ├── run-all.ps1                ตัวรันทดสอบทั้งหมด
│   ├── TEST-PLAN.md               ผลทดสอบ + ข้อค้นพบ + ข้อจำกัด
│   ├── Dockerfile                 Carbone + ฟอนต์ไทย
│   └── README.md                  คู่มือชุดทดสอบ
│
├── tools/                       ── สคริปต์ช่วยงาน ──
│   ├── doc_pipeline.py            สายงานเรนเดอร์ครบวงจร (ต้นแบบของ worker)
│   ├── docserver/                 ตัวอย่างเรียก docserver ตรง
│   ├── fonts/                     เทียบ/ติดตั้งฟอนต์ไทย
│   ├── log-analyzer/              หน้าเว็บอ่าน log + AI (service `log-analyzer` ใน stack)
│   ├── docker-logs.ps1            รวม log ดิบจาก Docker
│   ├── log-report.ps1             สรุป log ผ่าน Loki
│   └── README.md                  อธิบายทุกไฟล์
│
└── data/                        ── ข้อมูล + สำรอง (gitignored) ──
    ├── docserver-backup-20260930/  สำรองแม่แบบ + metadata.db
    └── README.md
```

---

## สองรุ่นของระบบ

ทั้งสองรุ่นทำงานบนแกนเดียวกัน ต่างกันที่ "ใครเป็นคนใช้"

| | ระบบเก่า | ระบบใหม่ |
|---|---|---|
| อยู่ที่ | `tests/` + `tools/` + `tests/Dockerfile` | `docgen-platform/` |
| ใครใช้ | ระบบอื่นเรียกผ่าน REST API | คนใช้งานผ่านหน้าเว็บ |
| การเรนเดอร์ | เรียก docserver ตรงจาก Python | worker รับงานจาก NATS แล้วเรนเดอร์ |
| ข้อมูล | ไฟล์ในเครื่อง | MongoDB + S3 (RustFS) |
| สิทธิ์ | API Key (จริง ๆ แล้ว Carbone ไม่ตรวจ) | Casdoor (ผู้ใช้ + ทีม + แชร์) |
| คู่มือ | [tests/README.md](tests/README.md) | [docgen-platform/README.md](docgen-platform/README.md) |

> docserver ตัวเดียวกันเป็นแกนกลางของทั้งสองระบบ
> ระบบเก่าเรียกตรง ๆ ส่วนระบบใหม่เรียกผ่าน `apps/worker`

### ทางเข้าของระบบใหม่

| ที่อยู่ | อะไร |
|---|---|
| `http://127.0.0.1:8090` | gateway — **ทางเข้าเดียว** (หน้าเว็บ · API · เอกสาร · ไฟล์ · log) |
| `http://127.0.0.1:8090/analyze/` | หน้าเว็บอ่าน log ทุก container แล้วให้ AI สรุป |
| `http://127.0.0.1:8090/logs/*` | Loki API ดิบ (ค้น log เองละเอียด) |
| `http://127.0.0.1:3000` | Next.js dev server บน host (หน้าเว็บอย่างเดียว ไม่ใช่ gateway) |
| `http://127.0.0.1:4001` | API dev server บน host |

> พอร์ต dev ทั้งสองผูก `127.0.0.1` เท่านั้น เข้าจาก LAN หรือ Tailscale ไม่ได้
> และ **docserver ไม่เปิดพอร์ต 4000 ออกไปเลย** — ต้องเข้าผ่าน gateway เท่านั้น
> `/analyze` และ `/logs` ก็**ไม่มี auth** — อย่า map โดเมนจริงก่อนใส่ basic_auth

เริ่มระบบทั้งหมด:

```powershell
cd dokploy-infra
docker compose up -d          # 15 container
docker compose ps
curl http://127.0.0.1:8090/api/health
```

---

## ระบบนี้ทำอะไร

1. **สร้างเอกสารจากแม่แบบ** — ระบบอื่นส่งข้อมูล JSON มา ระบบเติมลงในเอกสาร Word
   ที่ทำไว้ล่วงหน้า เช่น หนังสือราชการ ใบรับเรื่องร้องเรียน
2. **แปลงเป็น PDF** — แปลงอัตโนมัติ โดยรักษาฟอนต์และรูปแบบเอกสารราชการไทยไว้
3. **ใส่รูป** — ตราสัญลักษณ์ รูปหลักฐานในตาราง รองรับทั้งไฟล์ URL และ base64

---

## เทคโนโลยี

| ส่วน | ใช้อะไร | หมายเหตุ |
|---|---|---|
| เติมข้อความ + แปลง PDF | Carbone 5.15.2 (Community Edition) | ฟรี ไม่จำกัดไฟล์ |
| ใส่รูป | `docx_image_injector.py` (เขียนเอง) | Carbone เวอร์ชันฟรีใส่รูปเองไม่ได้ |
| ฟอนต์ | TH Sarabun New + ฟอนต์ไทยมาตรฐาน | ติดตั้งใน Docker ผ่าน `tests/Dockerfile` |
| ฐานข้อมูล / คิว / ไฟล์ (ระบบใหม่) | MongoDB replica set · NATS · RustFS (S3) | ดู `dokploy-infra/docker-compose.yml` |

---

## เริ่มใช้งานระบบเก่า (ชุดทดสอบ)

> ระบบใหม่ใช้งานจริงแล้ว — ส่วนนี้มีไว้สำหรับชุดทดสอบและการเรียก docserver ตรง ๆ

### 1. ติดตั้ง

ต้องมี Docker Desktop

```powershell
cd tests
docker build -t carbone-thai:5.15.2 -f Dockerfile .
docker run -d --name carbone-thai -p 4000:4000 `
  -e CARBONE_EE_API_KEY=carbon-ce --restart unless-stopped carbone-thai:5.15.2
```

### 2. ทดสอบว่าใช้ได้

```powershell
cd tests
.\run-all.ps1 -List      # ดูส่วนที่มี
.\run-all.ps1 -Quick     # ทดสอบส่วนที่เร็ว
```

### 3. เรียกใช้ API

```bash
# อัปโหลดแม่แบบ (ทำครั้งเดียว)
curl -X POST http://localhost:4000/template \
  -H "Authorization: Bearer carbon-ce" \
  -F "template=@แม่แบบ.docx"

# สร้างเอกสาร
curl -X POST "http://localhost:4000/render/{templateId}?download=true" \
  -H "Authorization: Bearer carbon-ce" \
  -H "Content-Type: application/json" \
  -H "carbone-version: 5" \
  --data-binary @payload.json \
  --output ผลลัพธ์.pdf
```

payload.json:
```json
{
  "data": {
    "ชื่อผู้ร้องเรียน": "นายสมชาย ใจดี",
    "จังหวัด": "ชลบุรี"
  },
  "convertTo": "pdf"
}
```

---

## ความรู้ที่ใช้ร่วมกันของทั้งสองระบบ

ส่วนนี้เป็นหลักการของ Carbone + ตัวฉีดรูป ที่ยังใช้อยู่ทั้งสองทาง

### ไวยากรณ์แม่แบบ Carbone

| ต้องการ | เขียนแบบนี้ | ไม่ใช่แบบนี้ |
|---|---|---|
| ตัวแปรเดี่ยว | `{d.ชื่อฟิลด์}` | `{ชื่อฟิลด์}` |
| ตารางซ้ำ | `{d.items[i].ชื่อ}` + `{d.items[i+1]}` | `{#d.items}...{/d.items}` |
| เงื่อนไข | `{d.ฟิลด์:ifEQ(ค่า):show('ข้อความ')}` | `{#d.เงื่อนไข}...{/d.เงื่อนไข}` |
| แปลงไฟล์ | `"convertTo": "pdf"` | `"format": "pdf"` |

**กฎตารางซ้ำ:** `[i]` ต้องอยู่ช่องแรกของแถวข้อมูล และ `[i+1]` ต้องอยู่ใน**แถวถัดไป**
(ตารางซ้อน 2 ชั้นต้องมี `[i+1]` ของทุกชั้น)

### การใส่รูป

Carbone เวอร์ชันฟรีใส่รูปเองไม่ได้ จึงต้องใช้ตัวฉีดรูปที่เขียนเอง
(`tests/lib/docx_image_injector.py`)

**เตรียมแม่แบบ:** คลิกขวารูป → คุณสมบัติ → Alt Text → ใส่ชื่อชอง

**ลำดับสำคัญ — ห้ามสลับ:**
```
1. ส่งแม่แบบเข้า Carbone ให้เติมข้อความก่อน  →  ได้ DOCX
2. ฉีดรูปลงไฟล์ DOCX ที่เติมข้อความแล้ว
3. ส่งไฟล์นั้นกลับเข้า Carbone แปลงเป็น PDF
```

**สลับขั้น 1 กับ 2 = เติมข้อความไม่ได้** เพราะการฉีดรูปเขียนทับ XML ของไฟล์ docx
ซึ่งเป็นไฟล์เดียวกับที่เก็บข้อความ

```python
from docx_image_injector import ImageInjector

inj = ImageInjector("เอกสาร-ที่เติมข้อความแล้ว.docx")
inj.set("ตราสัญลักษณ์", "ตรา.png")          # รูปเดี่ยว
inj.set_many("หลักฐาน", ["a.jpg", "b.jpg"])   # หลายรูป
inj.run()
inj.hide_row("ภาพแถว2", None)                 # ซ่อนแถวที่ไม่มีรูป
inj.remove("รูปที่ไม่ต้องการ")               # ลบรูป
inj.save("ผลลัพธ์.docx")
```

ตัวอย่างที่รันได้จริง: [`tools/docserver/docserver_replace_image.py`](tools/docserver/docserver_replace_image.py)

### การจัดวางย่อหน้า

เอกสารราชการไทยต้องการกระจายย่อหน้า แต่ต้องใช้ค่าที่ถูกกับตัวแปลง

| ค่า `w:jc` | ใน Word | ใน PDF (LibreOffice) |
|---|---|---|
| `thaiDistribute` (กระจายทั้งบรรทัด) | กระจายสวย | **ไม่มีผล** — กลายเป็นชิดซ้าย |
| `both` (กระจายสองข้าง) | ชิดขอบทั้งสองด้าน | กระจายเต็มขอบขวา |

วัดจาก PDF จริงแล้ว `thaiDistribute` ให้ผลเหมือน `left` ทุกประการ
ส่วน `both` กระจายครบทุกบรรทัด (และไม่ยืดบรรทัดสุดท้าย ตามหลักการพิมพ์)

> อย่าใช้ `distribute` กับเอกสารราชการ — มันยืดบรรทัดสุดท้ายด้วย ซึ่งผิดหลัก

**สองทางตอนส่งออก (ระบบทำให้อัตโนมัติ)**

Carbone **คงค่า `w:jc` เดิมทุกประการ** ในไฟล์ที่ส่งออก
ถ้าแก้แม่แบบเป็น `both` ตั้งแต่ตอนอัปโหลด เอกสาร `.docx` ที่ส่งมอบจะกลายเป็น
"ชิดขอบทั้งสองด้าน" แทน "กระจาย" — เสียการจัดวางแบบไทยของ Word

จึงต้อง **แยกสองทางตอนส่งออก** โดยไม่แตะแม่แบบ:

```
แม่แบบ (คง thaiDistribute)
   └─> Carbone เติมข้อมูล ──> .docx ─┬─> ฉบับส่งมอบ .docx : คง thaiDistribute
                                        │                     Word แสดงผลแบบไทยถูกต้อง
                                        └─> แก้เป็น both
                                            └─> ฉบับส่งมอบ .pdf : ขอบขวาเรียบสมบูรณ์
```

| รูปแบบ | ทำอะไร | โค้ด |
|---|---|---|
| `docx` `odt` … | เรนเดอร์ครั้งเดียว ไม่แก้อะไร | `docgen-platform/apps/worker/src/docserver.ts` |
| `pdf` | เรนเดอร์เป็น `.docx` → แก้ `thaiDistribute`→`both` → แปลงเป็น PDF | เหมือนกัน |

ผู้ใช้**ไม่ต้องทำอะไร** — อัปโหลดแม่แบบที่ตั้ง `thaiDistribute` ใน Word มาตามปกติ
ระบบจัดการทั้งสองทางให้เอง

```python
from docx.enum.text import WD_ALIGN_PARAGRAPH
p.alignment = WD_ALIGN_PARAGRAPH.DISTRIBUTE   # = thaiDistribute (สำหรับแม่แบบ)
```

รายละเอียดและวิธีวัด: [tests/part-09-thai-distribute/README.md](tests/part-09-thai-distribute/README.md)

### ฟอนต์ที่ติดตั้ง

| ฟอนต์ | ที่มา | หมายเหตุ |
|---|---|---|
| `TH SarabunPSK,TH SarabunIT๙` | ชุดฟอนต์ราชการไทย (THSarabun.rar) | รองรับทั้งสองชื่อ — เอกสารราชการรุ่นเก่าใช้ได้ทันทีโดยไม่ต้องแก้ |
| `TH Sarabun New` | SIPA / กรมทรัพย์สิทธิ์ทางปัญญา (GPL 2.0 + Font Exception) | เอกสารรุ่นใหม่ |
| `TH Niramit AS,TH NiramitIT๙` | ชุดฟอนต์ราชการไทย | ฟอนต์ราชการอีกตัว |

**ติดตั้งลงเครื่อง (ไม่ต้องใช้สิทธิ์ Administrator):**
```powershell
python tools\fonts\install_fonts_user.py
```

วัดแล้วทั้ง 3 ชุดหน้าตาและความกว้างข้อความเท่ากัน (204 px ที่ขนาด 16pt)
จึงใช้แทนกันได้โดยไม่กระทบรูปแบบเอกสาร
(เครื่องมือเทียบทั้งหมดอยู่ใน [`tools/fonts/`](tools/fonts/README.md))

---

## ผลการทดสอบระบบเก่า

| ส่วน | หัวข้อ | ผล |
|---|---|---|
| 1 | ติดตั้งและตรวจสอบระบบ | 5/5 |
| 2 | ข้อความภาษาไทย | 38/38 |
| 3 | ตารางซ้ำและเงื่อนไข | 31/31 |
| 4 | รูปภาพ | 11/11 |
| 5 | การเรียก API | 26/26 |
| 6 | ตัวฉีดรูป | 23/23 |
| 7 | เอกสารขนาดใหญ่ | 22/22 |
| 8 | เอกสารจริงครบวงจร | 40/40 |
| | **รวม** | **196/196** |

> รายละเอียดดูที่ [tests/TEST-PLAN.md](tests/TEST-PLAN.md)
> ผลทดสอบระบบใหม่อยู่ที่ `docgen-platform/README.md`

---

## ข้อจำกัดที่ต้องรู้

| เรื่อง | ผลกระทบ |
|---|---|
| **ต้องเติมข้อความก่อนฉีดรูป** | สลับลำดับแล้วเติมข้อความไม่ได้ |
| **LibreOffice หมดเวลา 60 วิ** | เอกสารซับซ้อนมากอาจ timeout (ปรับเป็น 300 วิแล้วใน image) |
| **API Key ไม่ถูกตรวจ** | Carbone Community Edition ไม่ตรวจ key → ห้ามเปิดออกสู่ภายนอกตรง ๆ |
| **รูปต้องฉีดเอง** | Carbone เวอร์ชันฟรีใส่รูปไม่ได้ |
| **ชื่อฟิลด์ต้องมี `d.`** | `{ชื่อ}` ไม่ถูกแทน ต้องเป็น `{d.ชื่อ}` |
| **`thaiDistribute` ไม่มีผลกับ PDF** | LibreOffice ไม่รองรับ — ระบบแก้เป็น `both` ให้ตอนส่งออก PDF อัตโนมัติ |
| **ย่อหน้าที่ไม่ได้ตั้งค่า จะไม่ถูกแก้** | ถ้าอยากให้กระจาย ต้องตั้งค่าใน Word เอง (normalizer ไม่เดาย่อหน้าให้) |
| **`.xlsx` เรนเดอร์เป็น PDF ไม่ผ่าน** | ปิดรับไปแล้ว รอแก้ที่ต้นตอ |

---

## ก่อนใช้งานจริง

1. สร้าง API Gateway คุมสิทธิ์เอง — Carbone ไม่ตรวจ API Key
2. เติมฟอนต์ TH Sarabun PSK ถ้าเอกสารราชการเดิมใช้ชื่อนี้
3. เตรียมตราสัญลักษณ์เป็น PNG โปร่งใส
4. ทดสอบกับเอกสารจริง 3-5 ฉบับ เทียบกับที่ทำใน Word
5. ตั้งระบบลบไฟล์ชั่วคราวอัตโนมัติ

---

## สิ่งที่ยังไม่ได้ทดสอบ

- แม่แบบ `.xlsx` (Excel) และ `.pptx` — เรนเดอร์เป็น PDF ไม่ผ่าน ปิดรับแล้ว
- หัวกระดาษซ้ำและเลขหน้าอัตโนมัติ
- การเรียกขนานพร้อมกันหลายคำขอ
- ตราสัญลักษณ์ PNG โปร่งใส

รายละเอียดทั้งหมดดูที่ [tests/TEST-PLAN.md](tests/TEST-PLAN.md)

---

## สัญญาอนุญาต

- โค้ดในโปรเจกต์นี้ — ใช้ได้ตามการพิจารณา
- Carbone — MIT License (Community Edition)
- TH Sarabun New — กรมทรัพย์สิทธิ์ทางปัญญา อนุญาตให้ใช้ทั้งงานราชการและเชิงพาณิชย์
