# 2docx-docserver

ระบบสร้างเอกสารราชการไทยอัตโนมัติจากแม่แบบ (DOCX) ทำเป็น PDF
พร้อมฟอนต์ราชการไทยครบชุดในตัว image — ดึงไปใช้ได้ทันที ไม่ต้องติดตั้งอะไรเพิ่ม

---

## เริ่มใช้

```bash
docker run -d --name docserver -p 4000:4000 xeefour/2docx-docserver:5.15.2
```

ตรวจว่าทำงาน:
```bash
docker ps                              # ดูสถานะ (รอ healthcheck ~30 วิ)
curl http://127.0.0.1:4000/status      # {"success":true,"code":200,"message":"OK","version":"5.15.2"}
```

> **ถ้าเป็นเครื่อง Windows** ใช้ `127.0.0.1` ไม่ใช่ `localhost` เพราะ `localhost`
> อาจ resolve เป็น IPv6 ก่อนแล้วช้าหรือ timeout

แนะนำให้ผูกเฉพาะ localhost (ดูหัวข้อความปลอดภัยด้านล่าง):
```bash
docker run -d --name docserver -p 127.0.0.1:4000:4000 xeefour/2docx-docserver:5.15.2
```

---

## ข้อมูล image

| รายการ | ค่า |
|---|---|
| ชื่อ | `xeefour/2docx-docserver` |
| Digest | `sha256:2c54469422950f8a70f36e73d43e5c08576494142109980eec676eb21e9843a7` |
| ขนาด | 2.12 GB |
| สถาปัตยกรรม | `linux/amd64` เท่านั้น (เครื่อง ARM เช่น Apple Silicon ต้องใช้ `--platform linux/amd64`) |
| ระบบฐาน | Debian GNU/Linux 13 (trixie) |
| ฐานที่ใช้สร้าง | `carbone/carbone-ee:full-5.15.2` |
| ผู้ใช้ | `carbone` (ไม่ใช่ root) |
| พอร์ต | 4000 |
| RAM ขณะว่าง | ~470 MB |

### ตัวแปรสภาพแวดล้อม

| ตัวแปร | ค่า | หมายเหตุ |
|---|---|---|
| `CARBONE_EE_API_KEY` | `carbon-ce` | **ไม่ใช่การป้องกันจริง** ดูหัวข้อความปลอดภัย |
| `TZ` | `Asia/Bangkok` | เวลาไทย |
| `CARBONE_EE_ONLYOFFICEPATH` | `auto` | ตั้งโดย base image |
| `CARBONE_EE_CHROMEPATH` | `/opt/headless-shell/headless-shell` | ตั้งโดย base image |

### ตัวแปรที่เปิดเพิ่มได้เอง (ฟรี ไม่ต้องซื้อ license)

| ตัวแปร | ผล | ทดสอบแล้ว |
|---|---|---|
| `CARBONE_STUDIO=true` | เปิดหน้าเว็บ Carbone Studio ที่ `/` | ใช้ได้ |
| `CARBONE_TEMPLATE_MANAGEMENT=true` | เปิดโหมด stateful — เก็บ metadata แม่แบบใน SQLite, เปิด `/templates` ได้ | ใช้ได้ |
| `CARBONE_USE_S3_PLUGIN=true` | เก็บแม่แบบ/ผลลัพธ์บน S3, Azure Blob, MinIO (ต้องใส่ credential ด้วย) | ยังไม่ได้ทดสอบ |

### การเรียกเข้า container

```
Entrypoint:  ./docker-entrypoint.sh
Cmd:         webserver
```

เครื่องมือแปลงไฟล์ที่ติดมา: LibreOffice 26.2 · headless-shell · onlyoffice-converter-standalone

### Healthcheck

ตรวจว่า API ตอบกลับจริง ไม่ใช่แค่พอร์ตเปิด

```
curl --fail --silent --max-time 4 http://127.0.0.1:4000/status
interval 15s · timeout 5s · retries 3 · start-period 30s
```

สถานะจะเปลี่ยนจาก `starting` เป็น `healthy` ภายใน ~30 วินาที

---

## ใช้งาน API

### 1. อัปโหลดแม่แบบ (ทำครั้งเดียว)

```bash
curl -X POST http://127.0.0.1:4000/template \
  -H "Authorization: Bearer carbon-ce" \
  -F "template=@แม่แบบ.docx"
```

ตอบกลับ:
```json
{ "success": true, "data": { "templateId": "abc123...", "templateExtension": "docx" } }
```

### 2. สร้างเอกสาร

```bash
curl -X POST "http://127.0.0.1:4000/render/abc123...?download=true" \
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
    "จังหวัด": "ชลบุรี",
    "items": [
      { "ลำดับ": "1", "รายการ": "ภาพถ่ายไฟดับ", "จำนวน": "3 ภาพ" }
    ]
  },
  "convertTo": "pdf"
}
```

> สังเกตว่า `data` ต้องอยู่ใต้คีย์ `data` เสมอ ถ้าส่ง JSON ข้อมูลดิบไปตรง ๆ
> ระบบจะถือว่าไม่มีข้อมูลและคืนไฟล์ต้นฉบับมาแทน

---

## ข้อบังคับ 3 ข้อ (ถ้าไม่ส่ง จะได้ผลไม่ถูกต้อง)

| ต้องส่ง | ไม่ส่งจะเป็น |
|---|---|
| `"convertTo": "pdf"` | ได้ไฟล์ต้นฉบับ (.docx) ไม่ใช่ PDF |
| header `carbone-version: 5` | ได้ไฟล์ต้นฉบับ |
| `?download=true` | ได้ JSON `renderId` แทนไฟล์ |

> เวอร์ชัน 5.15.2 ทดสอบแล้วว่า **ไม่ส่ง `carbone-version` ก็ยังได้ PDF**
> เพราะฉบับนี้ผูก major version ไว้แล้ว แต่ควรส่งทุกครั้งเพื่อความชัดเจน
> และให้ตั้งค่ากับเวอร์ชันถัดไปได้

---

## ไวยากรณ์แม่แบบ

| ต้องการ | เขียนแบบนี้ | ไม่ใช่ |
|---|---|---|
| ตัวแปร | `{d.ชื่อฟิลด์}` | `{ชื่อฟิลด์}` |
| ตารางซ้ำ | `{d.items[i].ชื่อ}` + `{d.items[i+1]}` | `{#d.items}...{/d.items}` |
| เงื่อนไข | `{d.ฟิลด์:ifEQ(ค่า):show('ข้อความ')}` | `{#d.เงื่อนไข}...{/d.เงื่อนไข}` |

**กฎตารางซ้ำ:** `[i]` อยู่ช่องแรกของแถวข้อมูล, `[i+1]` อยู่แถวถัดไป
(ตารางซ้อน 2 ชั้นต้องมี `[i+1]` ของทุกชั้น)

**การจัดวางย่อหน้า:** ใช้วิธีแก้การกระจายย่อหน้าไทยด้านล่าง

---

## การกระจายย่อหน้าไทย (thaiDistribute)

### ปัญหา

`thaiDistribute` คือการจัดวางแบบไทยที่ Word รองรับ แต่ **LibreOffice ไม่รู้จักค่านี้**
เมื่อนำเข้าไฟล์ `.docx` ค่าจะถูกตกไปทิ้ง และแปลงเป็น **ชิดซ้าย** ทันที

วัดจาก PDF ที่เรนเดอร์จริง ยืนยันว่า `thaiDistribute` ให้ผลเหมือน `left` ทุกประการ:

| ค่า `w:jc` | ขนาด PDF | บรรทัดที่ยืดเต็มขวา | ห่างตัวอักษร (บรรทัดเต็ม) |
|---|---|---|---|
| `thaiDistribute` | 49,996 | 5/22 | 0.593 |
| `left` | 49,996 | 5/22 | 0.593 |
| `both` | 50,119 | 8/22 | 0.518 |
| `distribute` | 50,119 | 11/22 | **1.675** (ยืดจริง) |

### ทางออก — ใช้ `both`

วัดระยะห่างจากขอบขวาของย่อหน้าเนื้อความในแม่แบบจริง (ค่า 0 = ชนขอบพอดี)

| `w:jc` | บรรทัด 1-5 เนื้อความ | บรรทัดสุดท้าย | ผลลัพธ์ |
|---|---|---|---|
| `thaiDistribute` | 15, 1, 9, 3, **25** | 163 | ขอบขวาไม่เรียบ เท่ากับ `left` |
| **`both`** | -2, 1, 0, 0, **0** | **147** | ขอบขวาเรียบ · บรรทัดสุดท้ายไม่ยืด |
| `distribute` | -2, 1, 0, 0, 0 | 163 | ขอบขวาเรียบ · **แต่ยืดบรรทัดสุดท้ายด้วย** |

**ให้ใช้ `both`** — ได้ขอบขวาเรียบสมบูรณ์เท่ากับ `distribute`
แต่บรรทัดสุดท้ายของย่อหน้าจบตามธรรมชาติ ไม่ถูกยืดจนแตกเป็นตัว ๆ

เหตุผลที่ `both` ลงลงขอบขวาพอดีโดยไม่ต้องยืด เพราะภาษาไทยตัดบรรทัดได้ที่ทุกตัวอักษร
(ไม่ใช่เฉพาะช่องว่าง) เมื่อตั้งเป็นสองขอบ LibreOffice จะเลื่อนจุดตัดบรรทัดให้เต็มขอบโดยตรง
จึงได้ขอบขวาเรียบโดยไม่ต้องยืดตัวอักษรเลย

**อย่าใช้ `distribute` กับเอกสารราชการ** เพราะยืดบรรทัดสุดท้ายด้วย
ซึ่งไม่ถูกหลักการพิมพ์เอกสารราชการ (บรรทัดสุดท้ายของย่อหน้าต้องชิดซ้าย)

### สำคัญ — อย่าแก้แม่แบบเป็น `both`

ถ้าเปลี่ยนแม่แบบเป็น `both` ทั้งไฟล์ เอกสาร `.docx` ที่ส่งออกจะเป็น `both` ด้วย
เพราะ Carbone **คงค่า `w:jc` เป๊ะ** ทุกค่า ทำให้เสียการกระจายแบบไทยไปเปล่า ๆ
(Word จะแสดงเป็น "ชิดขอบทั้งสองด้าน" ไม่ใช่ "กระจาย")

**ทางแก้: แยกสองทางตอนส่งออก** โดยคงแม่แบบเป็น `thaiDistribute` ไว้เหมือนเดิม

```
แม่แบบ (thaiDistribute)
   └─> Carbone เติมข้อมูล ──> .docx ─┬─> ฉบับแก้ไข   : ส่งต่อได้เลย (คง thaiDistribute)
                                        │                  Word แสดงผลแบบไทยถูกต้อง
                                        └─> แทน thaiDistribute ด้วย both
                                            └─> ฉบับส่งมอบ PDF : ขอบขวาเรียบสมบูรณ์
```

การแทนค่าทำได้ด้วยการแก้ `word/document.xml` ในไฟล์ `.docx` ตรง ๆ
(เป็นไฟล์ ZIP) — ทำให้อัตโนมัติได้ด้วย `tools/doc_pipeline.py` (ดูหัวข้อถัดไป)

---

## doc_pipeline.py — ตัวสร้างเอกสารครบวงจร

`tools/doc_pipeline.py` รวมทุกขั้นตอนไว้ที่เดียว รวมถึงการแตกผลลัพธ์สองทาง

```bash
python tools/doc_pipeline.py ^
    --template แม่แบบ.docx ^
    --data ข้อมูล.json ^
    --images รูป.json ^
    --out เอาสาร
```

| ตัวเลือก | ความหมาย |
|---|---|
| `--template` | ไฟล์แม่แบบ `.docx` |
| `--template-id` | ใช้แม่แบบที่อัปโหลดไว้แล้ว (อัปโหลดครั้งเดียว) |
| `--data` | ไฟล์ JSON ของข้อมูล |
| `--images` | ไฟล์ JSON แผนที่รูป |
| `--out` / `--stem` | โฟลเดอร์และชื่อไฟล์ผลลัพธ์ |
| `--server` / `--api-key` | ที่อยู่ docserver (ค่าเริ่มต้นอ่านจาก env `CARBONE_URL` / `CARBONE_API_KEY`) |

**รูปแบบไฟล์แผนที่รูป** — คีย์คือ Alt Text ของรูปในแม่แบบ

```json
{
  "ตราสัญลักษณ์": "ครุฑ.png",
  "ภาพในตาราง": "หลักฐาน.jpg",
  "ภาพแถว1": ["1.jpg", "2.jpg"],
  "ภาพแถว2": null
}
```

`null` = ไม่มีรูป → ซ่อนทั้งแถวตาราง · ค่าเป็นรายการ = แทรกหลายรูปเรียงกัน
อ่านไฟล์ JSON ได้ทั้งแบบมี BOM และไม่มี BOM

**ผลลัพธ์สองไฟล์เสมอ**

| ไฟล์ | การจัดวาง | ใช้ทำอะไร |
|---|---|---|
| `<ชื่อ>-ฉบับแก้ไข.docx` | คง `thaiDistribute` | ส่งต่อให้เจ้าหน้าที่แก้ใน Word |
| `<ชื่อ>.pdf` | ใช้ `both` | ฉบับส่งมอบ ขอบขวาเรียบสมบูรณ์ |

ใช้เป็นโมดูลได้เช่นกัน

```python
import sys; sys.path.insert(0, 'tools')
from doc_pipeline import DocPipeline

p = DocPipeline()
tid = p.upload_template('แม่แบบ.docx')          # ครั้งเดียว
r = p.render(template_id=tid,
             data={'เรื่อง': '...', 'เรียน': '...'},
             images={'ตราสัญลักษณ์': open('ครุฑ.png','rb').read()})
r.save('เอาสาร', 'หนังสือ')
```

> ตัวฉีดรูป `docx_image_injector.py` อยู่ใน `tests/lib/` — `doc_pipeline.py` เรียกใช้จากที่นั่น
> ย้ายไป `tools/` ได้ภายหลัง

### ทางเลือกที่ดีกว่า — ส่งออกเป็น .docx

Word รองรับ `thaiDistribute` อยู่แล้ว ถ้าส่งมอบเป็น `.docx` แทน PDF
ค่านี้จะมีผลเต็มที่โดยไม่ต้องแก้แม่แบบเลย

ทดสอบแล้วว่าเอกสาร `.docx` ที่ Carbone ส่งออกยังคง `thaiDistribute` ครบ
และเอาไปส่งกลับเข้าเพื่อแปลง PDF ต่อได้ผลลัพธ์เหมือนเดิมทุกตัวอักษร

### ข้อควรรู้ — การตัดบรรทัดภาษาไทย

ถ้าสร้างไฟล์ `.docx` ด้วยโค้ด (เช่น `python-docx`) ต้องกำหนดภาษาไทยใน run
มิฉะนั้น LibreOffice จะไม่ตัดบรรทัดข้อความไทยเลย ข้อความจะล้นเป็นบรรทัดเดียว

```xml
<w:rPr>
  <w:lang w:val="th-TH" w:eastAsia="th-TH" w:bidi="th-TH"/>
</w:rPr>
```

---

## ฟอนต์ที่ติดตั้ง

รวม **80 รูปแบบฟอนต์ไทย** ในตัว image

| ชื่อที่ประกาศ | ที่มา | ใช้กับ |
|---|---|---|
| `TH Sarabun New` | SIPA / กรมทรัพย์สิทธิ์ทางปัญญา | เอกสารรุ่นใหม่ |
| `TH Sarabun PSK` | GitHub SarabunConsortium | เอกสารราชการทั่วไป |
| `TH SarabunPSK` | ชุดซีดีการาชการ | รองรับทั้ง `TH SarabunPSK` และ `TH SarabunIT๙` |
| อื่น ๆ อีก 77 รูปแบบ | Debian (Tlwg, Noto) | ฟอนต์สำรอง |

**ข้อดีของ `TH SarabunPSK`:** ประกาศชื่อรองรับทั้ง 2 แบบ ทำให้เอกสารราชการรุ่นเก่าที่ใช้ชื่อ
`TH SarabunIT๙` ใช้ได้โดยไม่ต้องแก้ชื่อฟอนต์ในไฟล์

ตรวจดูได้:
```bash
docker exec docserver fc-list :lang=th | wc -l        # ได้ 80
docker exec docserver fc-list | grep -i sarabun        # ดูชื่อที่ประกาศ
```

> `TH Niramit AS` **ไม่ได้** อยู่ใน image นี้
> ถ้าต้องการ ต้อง mount ไฟล์ `.ttf` เข้าไปเอง (ดูหัวข้อการตั้งค่า)

---

## การตั้งค่า

ตั้งค่าไว้ใน image แล้ว (`/app/config/config.json`):

| ค่า | ค่าที่ใช้ | ผล |
|---|---|---|
| `converterFactoryTimeout` | 300000 (5 นาที) | รองรับเอกสารยาวกว่าค่าเริ่มต้น 60 วิ 5 เท่า |
| `factories` | 3 | ประมวลผลพร้อมกันได้ 3 งาน |
| `maxDataSize` | 62914560 (60 MB) | ขนาด payload สูงสุด |
| `instanceMaxFiles` | 200 | จำนวนไฟล์ที่รอประมวลผลได้สูงสุด |
| `instanceQueueSize` | 10 | ความยาวคิวงานสูงสุด |
| `templatePathRetention` | 0 | ไม่เก็บไฟล์ชั่วคราวไว้บนดิสก์ |
| `authentication` | false | **ไม่ตรวจ API Key** ดูหัวข้อความปลอดภัย |

ดูค่าจริงที่ใช้ตอนรัน:
```bash
docker logs docserver | head -20
docker exec docserver cat /app/config/config.json
```

แก้ค่าเอง — mount ไฟล์ config เข้าไป:
```bash
docker run -d -p 4000:4000 \
  -v ./carbone-config.json:/app/config/config.json:ro \
  xeefour/2docx-docserver:5.15.2
```

เพิ่มฟอนต์เอง — mount โฟลเดอร์ `.ttf` แล้วสั่งสร้าง cache:
```bash
docker run -d -p 4000:4000 \
  -v "$(pwd)/fonts:/usr/local/share/fonts/extra:ro" \
  xeefour/2docx-docserver:5.15.2 \
  bash -c "fc-cache -f && ./docker-entrypoint.sh webserver"
```

เก็บไฟล์ผลลัพธ์ไว้บนเครื่อง:
```bash
docker run -d -p 4000:4000 \
  -v "$(pwd)/output:/app/output" \
  xeefour/2docx-docserver:5.15.2
```

---

## Carbone Studio (หน้าเว็บออกแบบแม่แบบ)

เปิดใช้งานได้ **ฟรี ไม่ต้องซื้อ license** — ทดสอบกับ Community Edition แล้วทำงานครบ

```bash
docker run -d --name docserver -p 4000:4000 --restart unless-stopped \
  -e CARBONE_STUDIO=true \
  -e CARBONE_TEMPLATE_MANAGEMENT=true \
  xeefour/2docx-docserver:5.15.2
```

เปิดที่ `http://127.0.0.1:4000/` — ไม่ต้องมี path เพิ่ม

| ตัวแปร | ให้อะไร |
|---|---|
| `CARBONE_STUDIO=true` | เปิดหน้าเว็บ Studio (ถ้าไม่เปิด หน้า `/` จะตอบเป็น JSON `/status` แทน) |
| `CARBONE_TEMPLATE_MANAGEMENT=true` | เปิดโหมด stateful — Studio จะเห็นรายการแม่แบบที่อัปโหลดไว้ผ่าน API |

ตรวจว่าเปิดแล้ว — ดูบรรทัด `FEATURES` ใน log:
```
docker logs docserver | Select-String 'studio|templateManagement'
```
ต้องขึ้น `studio : enabled` และ `templateManagement : enabled`

**เมื่อเปิด `CARBONE_STUDIO=true` หน้า `/` จะเปลี่ยนจาก JSON เป็นหน้าเว็บ**
ถ้าระบบอื่นของคุณเรียก `/` เพื่อเช็คสถานะ ให้เปลี่ยนไปเรียก `/status` แทน

ข้อจำกัดของ Studio ในเวอร์ชันนี้: ออกแบบและทดลองแม่แบบได้ แต่การจัดการเวอร์ชันและการ deploy
แบบทีละชุด (deployed version) ยังเป็นฟีเจอร์ Enterprise

---

## ความปลอดภัย

**Community Edition ไม่ตรวจ API Key**

ทดสอบแล้วยืนยัน: ส่ง key ผิด ไม่ส่ง key หรือส่ง Authorization มั่ว
ระบบก็ทำงานเหมือนกันหมด ไม่มีการตรวจสิทธิ์ใด ๆ

ค่า `CARBONE_EE_API_KEY=carbon-ce` ใน image เป็นค่าตัวอย่างเท่านั้น ไม่ใช่การป้องกัน

**วิธีที่ถูกต้อง:**
1. อย่าเปิดพอร์ต 4000 ออกอินเทอร์เน็ตโดยตรง
2. วาง API Gateway ของคุณไว้ข้างหน้าเพื่อตรวจสิทธิ์และจำกัดอัตรา
3. ถ้าต้องเปิดบนเซิร์ฟเวอร์จริง ให้ผูกเฉพาะ localhost และใช้ firewall

```bash
# ผูกเฉพาะ localhost (ปลอดภัยกว่า)
docker run -d -p 127.0.0.1:4000:4000 xeefour/2docx-docserver:5.15.2
```

อื่น ๆ ที่ควรรู้:
- container รันด้วยผู้ใช้ `carbone` ไม่ใช่ root — ผูกไว้แล้ว
- `templatePathRetention: 0` ทำให้ไม่เหลือไฟล์ชั่วคราวบนดิสก์
- LibreOffice ประมวลผลไฟล์ที่ผู้ใช้ส่งมา — ถ้าเปิดให้บุคคลภายนอกใช้ ให้ถือเป็นความเสี่ยง RCE

---

## ข้อจำกัด

| เรื่อง | ผลกระทบ |
|---|---|
| สถาปัตยกรรม amd64 เท่านั้น | เครื่อง ARM ต้องระบุ `--platform linux/amd64` (ช้าลง) |
| เวลาสูงสุด 5 นาที | เอกสารซับซ้อนมากอาจหมดเวลา ควรแบ่งเป็นหลายฉบับ |
| ขนาด payload สูงสุด 60 MB | เกินนี้จะถูกปฏิเสธ |
| งานพร้อมกัน | 3 งาน (คิวยาว 10) งานที่เกินจะรอ |
| RAM | ~470 MB ขณะว่าง · ~660 MB เมื่อประมวลผลเอกสารใหญ่ |
| รูปภาพ | Carbone เวอร์ชันฟรีใส่รูปเองไม่ได้ ต้องฉีดรูปลงไฟล์ก่อน |
| `thaiDistribute` | ไม่มีผลกับ PDF ให้ใช้วิธีแก้ด้านล่าง |
| ค้นข้อความใน PDF | PDF เก็บสระไทยเป็น glyph แยก ค้นแล้วอาจไม่เจอ แต่เปิดดูด้วยตาถูกต้อง |

---

## เครื่องมือเสริม (นอก image)

ตัวฉีดรูป (`docx_image_injector.py`) ต้องรันฝั่งเครื่องคุณ ไม่ได้อยู่ใน image:
https://github.com/xeefour/2docx.com

ลำดับที่ถูกต้อง — **ห้ามสลับ**:
```
1. ส่งแม่แบบเข้า Carbone ให้เติมข้อความก่อน   → ได้ .docx
2. ฉีดรูปลงไฟล์ .docx ที่เติมข้อความแล้ว
3. ส่งไฟล์นั้นกลับเข้า Carbone แปลงเป็น PDF
```
สลับขั้น 1 กับ 2 = เติมข้อความไม่ได้

---

## Tag

| Tag | ความหมาย |
|---|---|
| `5.15.2` | เวอร์ชันที่ระบุ (แนะนำ ใช้ใน production) |
| `latest` | ล่าสุด |

ทั้งสอง tag ปัจจุบันชี้ digest เดียวกัน

ตรึงเวอร์ชันแบบเข้มงวดที่สุด (แนะนำสำหรับ production):
```bash
docker run -d -p 4000:4000 xeefour/2docx-docserver@sha256:2c54469422950f8a70f36e73d43e5c08576494142109980eec676eb21e9843a7
```

---

## ผลทดสอบที่ยืนยัน

ทดสอบกับ image นี้โดยตรง (pull มาจาก Docker Hub ไม่ได้ build เอง):

| รายการ | ผล |
|---|---|
| container healthcheck | `healthy` |
| `GET /status` | `version: 5.15.2` |
| อัปโหลดแม่แบบ | สำเร็จ ได้ templateId |
| เรนเดอร์เป็น PDF | HTTP 200 · 2 หน้า · อักษรไทย 594 ตัว |
| ฟอนต์ไทย | 80 รูปแบบ |
| RAM ขณะว่าง | 468 MB |

ผลลัพธ์ PDF ตรงกับที่ได้จาก image ที่ build เองทุกตัวเลข

ชุดทดสอบครบชุด (10 ส่วน 197 ข้อตรวจ) อยู่ที่:
https://github.com/xeefour/2docx.com

---

## สัญญาอนุญาต

- Carbone Community Edition — MIT
- ฟอนต์ TH Sarabun — SIPA / กรมทรัพย์สิทธิ์ทางปัญญา (GPL 2.0 + Font Exception)
- ฟอนต์ Tlwg, Noto — SIL Open Font License
