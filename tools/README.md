# tools/ — เครื่องมือช่วยงาน

สคริปต์ที่ใช้ **ตอนพัฒนาและตรวจสอบ** ไม่ใช่ส่วนที่ระบบรันอยู่
ย้าย/จัดกลุ่มเมื่อ 5 ต.ค. 2026 — ก่อนหน้านี้ไฟล์ของสองระบบปนกันอยู่ชั้นเดียว
จนแยกไม่ออกว่าตัวไหนของระบบเก่า ตัวไหนของระบบใหม่

**ไม่มีไฟล์ไหนในโฟลเดอร์นี้อยู่ใน Docker image** — ถ้าอยู่ใน image แปลว่าจัดผิดที่

---

## แผนที่

```
tools/
├── README.md                    ไฟล์นี้
│
├── doc_pipeline.py              ตัวเดียวที่ทำได้ครบทั้ง 3 ขั้น (ใช้เป็นโมดูลหรือ CLI)
│
├── docserver/                   ตัวอย่างการเรียก docserver ตรง ๆ
│   ├── docserver_replace_image.py   ตัวอย่าง Python 3 ขั้น (เติมข้อความ → ฉีดรูป → PDF)
│   └── output-example/              ผลลัพธ์จากการรัน (gitignored)
│
├── fonts/                       เครื่องมือเรื่องฟอนต์ไทย
│   ├── check_font_names.py         อ่านชื่อฟอนต์จริงจากในไฟล์ .ttf
│   ├── compare_fonts.py            เทียบ TH Sarabun New กับ PSK
│   ├── compare_fonts_all.py        เทียบ 3 ชุดพร้อมกัน
│   ├── install_fonts.ps1           ติดตั้งลง Windows (ต้องใช้สิทธิ์ Administrator)
│   ├── install_fonts_user.py       ติดตั้งระดับผู้ใช้ (ไม่ต้องใช้สิทธิ์)
│   ├── inspect_docx.py             ดูโครงสร้าง .docx (ฟอนต์, w:jc, ย่อหน้า)
│   └── font-compare-3sets.png      ผลเทียบที่ได้แล้ว (เก็บไว้เทียบกับภายหลัง)
│
├── log-analyzer/                หน้าเว็บอ่าน log แล้วให้ AI สรุป (service ใน stack)
│   ├── server.mjs  index.html  start.cmd
│   ├── README.md                   คู่มือฉบับเต็มของตัวนี้
│   └── .env                        ใส่ MINIMAX_API_KEY (ตอนรันบน host · gitignored)
│
├── docker-logs.ps1              รวม log ดิบจากทุก container เรียงตามเวลา
└── log-report.ps1               สรุป log เป็นรายงาน (อ่านผ่าน Loki, มี noise filter)
```

---

## รายละเอียดแต่ละตัว

### `doc_pipeline.py` — สายงานหลักของการเรนเดอร์

ทำครบทั้ง 3 ขั้นในไฟล์เดียว: ให้ Carbone เติมข้อความ → ฉีดรูป → แตกผลลัพธ์เป็นสองทาง
(`.docx` คง `thaiDistribute` · PDF เปลี่ยนเป็น `both`)

ใช้ได้ทั้งแบบ `import` เป็นโมดูล และแบบ CLI

```powershell
python tools\doc_pipeline.py --help
```

> ตัวนี้เป็น **ต้นแบบเชิงตรรกะ** ของ `apps/worker/src/docserver.ts` ในระบบใหม่
> เวลาแก้พฤติกรรมการเรนเดอร์ ให้แก้ทั้งสองที่ให้ตรงกัน

### `docserver/` — ตัวอย่างการเรียก docserver ตรง

`docserver_replace_image.py` เป็นตัวอย่างที่อ่านง่ายที่สุดของการฉีดรูปผ่าน docserver
3 ขั้น และอธิบายใน docstring ว่าทำไม**ห้ามสลับขั้น 1 กับ 2**

```powershell
python tools\docserver\docserver_replace_image.py
```

ต้องมี docserver รันอยู่ที่ `http://127.0.0.1:4000`
(ปกติ docserver **ไม่เปิดพอร์ตให้ host** — ดูหมายเหตุใน `docgen-platform/README.md`
ต้องใช้ตอน dev ที่ปิด compose หรือทำ bridge ก่อน)

`output-example/` เก็บผลลัพธ์จากการรันครั้งก่อน ๆ (รวมผลของ `doc_pipeline.py` ด้วย)
ใช้เป็นของเทียบว่า "ผลลัพธ์นี้ถูกต้องแล้ว" — **gitignored** สร้างใหม่ได้เลย

### `fonts/` — เรื่องฟอนต์ไทย

ชุดนี้ตอบคำถามว่า "ฟอนต์ชุดไหนใช้แทนกันได้" และ "ติดตั้งฟอนต์ลงเครื่องยังไง"

| ไฟล์ | คำถามที่ตอบ |
|---|---|
| `check_font_names.py` | ฟอนต์ .ttf ไฟล์นี้ชื่ออะไรจริง ๆ (ชื่อไฟล์อาจโกหก) |
| `compare_fonts.py` | TH Sarabun New กับ PSK หน้าตาเหมือนกันแค่ไหน |
| `compare_fonts_all.py` | เทียบ 3 ชุดพร้อมกัน (มีตัวจาก `.rar` รวมอยู่) |
| `install_fonts_user.py` | ติดตั้งลงเครื่อง **ไม่ต้องใช้สิทธิ์ผู้ดูแลระบบ** ← ใช้ตัวนี้ก่อน |
| `install_fonts.ps1` | ติดตั้งระดับเครื่อง (ต้องใช้สิทธิ์ Administrator) |
| `inspect_docx.py` | เอกสาร .docx นี้ใช้ฟอนต์อะไร จัดย่อหน้าแบบไหน |

```powershell
python tools\fonts\install_fonts_user.py        # ติดตั้งฟอนต์ (แนะนำ)
python tools\fonts\compare_fonts.py            # เทียบ 2 ชุด
python tools\fonts\inspect_docx.py ไฟล์.docx   # ดูโครงสร้างเอกสาร
```

> ⚠️ สคริปต์ติดตั้งสองตัวอ่านฟอนต์จาก `tests/lib/fonts/_จากrar/`
> โฟลเดอร์นี้ **ไม่ได้อยู่ใน git** (ถูก `.gitignore` บรรทัด `tests/lib/fonts/_จากrar/`)
> ต้องแตก `THSarabun.rar` ลงไว้เองก่อนถึงจะรันได้
> `compare_fonts.py` กับ `compare_fonts_all.py` ใช้ได้เลยเพราะอ่านจาก `tests/lib/fonts/`
> ซึ่งมีอยู่จริง

ทุกไฟล์ในโฟลเดอร์นี้คำนวณ path จากตำแหน่งไฟล์ตัวเอง
**ไม่ hardcode `D:\2docx.com`** — เคยพังเงียบ ๆ ตอนย้ายโฟลเดอร์

### `log-analyzer/` — อ่าน log โดยไม่ต้องอ่านเอง

หน้าเว็บรวม log ทุก container จาก Loki แล้วให้ AI สรุปว่าระบบมีปัญหาอะไร

**เข้าที่** http://127.0.0.1:8090/analyze/ (ผ่าน gateway)

> ✅ ตอนนี้เป็น **service ใน Docker stack** ไม่ต้องรัน `start.cmd` อีกต่อไป
> โค้ดอยู่ที่นี่ · Dockerfile และการตั้งค่า stack อยู่ที่
> [`dokploy-infra/README.md`](../dokploy-infra/README.md) → หัวข้อ 5

```powershell
docker compose up -d                                    # จากโฟลเดอร์ dokploy-infra
node docgen-platform\logs\check-log-analyzer.mjs        # ตรวจว่ายังไม่รั่ว
```

คู่มือฉบับเต็มอยู่ที่ [`log-analyzer/README.md`](log-analyzer/README.md)
(ระบุ endpoint, ระดับความคิด, และวิธีตั้ง `MINIMAX_API_KEY`)

> ⚠️ หน้านี้**ไม่มี auth** — จึงไม่ publish พอร์ต ต้องเข้าผ่าน gateway ที่ผูก 127.0.0.1
> ถ้าจะ map โดเมนจริง ต้องเพิ่ม `basic_auth` ก่อน

### `docker-logs.ps1` / `log-report.ps1` — ดู log

| ไฟล์ | ต่างกันยังไง |
|---|---|
| `docker-logs.ps1` | อ่าน log ดิบจาก Docker ตรง ๆ · ได้แค่ปัจจุบัน · ใช้เมื่อ Loki ล่ม |
| `log-report.ps1` | อ่านผ่าน Loki · ย้อนหลังได้ · ตัด noise ให้ · เหมาะกับการส่งให้ LLM อ่าน |

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\tools\log-report.ps1 -Since 1h
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\tools\docker-logs.ps1 -Errors
```

> ทั้งสองไฟล์ถูกอ้างถึงจากนอก `tools/` — `dokploy-infra/docker-compose.yml`
> และ `dokploy-infra/observability/README.md` ชี้มาที่ `tools\` จากราก repo
> ถ้าจะย้ายที่ ต้องแก้การอ้างอิงเหล่านั้นด้วย
> (`docker-logs.ps1` เขียนผลลง `logs/` ที่ราก repo จึงคำนวณ path จาก `$PSScriptRoot`)

---

## กติกาเวลาจะเพิ่มไฟล์ใหม่ใน `tools/`

1. **ถ้าเป็นของระบบเก่า** (Python, ทดสอบ docserver ตรง) → `tools/docserver/` หรือ `tools/fonts/`
2. **ถ้าเป็นของระบบใหม่** (Node, แตะ API/หน้าเว็บ) → `docgen-platform/tools/` ไม่ใช่ที่นี่
3. **ถ้าเป็นของทั้ง Docker stack** → `dokploy-infra/` ถ้าเป็น config ถาวร
   หรือ `tools/` ถ้าเป็นสคริปต์ชั่วคราว
4. **อย่า hardcode path ให้คำนวณจาก `__file__` / `$PSScriptRoot` แทน** — บันทึกนี้
   เพราะเจอแล้วว่าพังเงียบ ๆ ทั้งรอบ

---

## เกณฑ์ตรวจว่าการจัดโฟลเดอร์ยังไม่พัง

สองตัวนี้อยู่ใน `docgen-platform/logs/` (ที่เดียวกับเกณฑ์ตัวอื่น) รันได้จากที่ไหนก็ได้

```powershell
node docgen-platform\logs\check-folder-reorg.mjs      # 34 ข้อ
py -3 docgen-platform\logs\check-moved-tool-paths.py # 7 ข้อ
```

| เกณฑ์ | ตรวจอะไร |
|---|---|
| `check-folder-reorg.mjs` | ตำแหน่งใหม่/ของเก่าถูกต้อง · ไม่มี U+FFFD ในเอกสาร · ทุกการอ้างอิงชี้ตำแหน่งใหม่ · `.env` ยังอยู่ · ของที่ลบหายจริง |
| `check-moved-tool-paths.py` | ทุกสคริปต์ที่ย้ายคำนวณ path ถึงราก repo ถูกชั้น · ไม่มี `D:\2docx.com` ที่ hardcode ไว้นอกจากในคอมเมนต์ |

> เกณฑ์ทั้งสองผ่าน **การพิสูจน์ว่าจับบั๊กได้จริงแล้ว** — เคยใส่บั๊ก (ลด `.parent` ทิ้งชั้น ·
> ถอย path กลับไปที่เดิม) แล้วตกจริงทั้งสองกรณี

### เกณฑ์ระดับทั้งระบบ

`docgen-platform/logs/service-report.mjs` — ยิง endpoint จริงของทุก service
แล้วเช็คว่าได้**เนื้อหา** ที่คาด ไม่ใช่แค่สถานะ 200 (เพราะ container ขึ้นแล้วยังตอบไม่ได้
— crash loop ช้า, dependency ตาย, route พัง) พร้อมเช็คว่าไม่มีพอร์ตผูก `0.0.0.0`

```powershell
node --env-file=dokploy-infra/.env --env-file=dokploy-infra/.env.development docgen-platform\logs\service-report.mjs
```

รันจากที่ไหนก็ได้ · ตอนนี้ผ่าน **21/22** — ที่ไม่ผ่านคือ API dev บน host (`:4001`)
ตอบ 503 เพราะ host เข้าถึง docserver ใน container ไม่ได้ (เป็นที่รู้กันอยู่แล้ว)
