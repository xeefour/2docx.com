# 2docx-docserver

ระบบสร้างเอกสารราชการไทยอัตโนมัติจากแม่แบบ (DOCX) ทำเป็น PDF
พร้อมฟอนต์ราชการไทยครบชุดในตัว image

---

## เรียกใช้

```bash
docker run -d --name docserver -p 4000:4000 xeefour/2docx-docserver:latest
```

ตรวจว่าทำงาน:
```bash
docker ps                              # ดูสถานะ
curl http://127.0.0.1:4000/status      # ดูเวอร์ชัน
```

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

---

## ข้อบังคับ 3 ข้อ (ถ้าไม่ส่ง จะได้ผลไม่ถูกต้อง)

| ต้องส่ง | ไม่ส่งจะเป็น |
|---|---|
| `"convertTo": "pdf"` | ได้ไฟล์ต้นฉบับ ไม่ใช่ PDF |
| header `carbone-version: 5` | ได้ไฟล์ต้นฉบับ |
| `?download=true` | ได้ JSON `renderId` แทนไฟล์ |

---

## ไวยากรณ์แม่แบบ

| ต้องการ | เขียนแบบนี้ | ไม่ใช่ |
|---|---|---|
| ตัวแปร | `{d.ชื่อฟิลด์}` | `{ชื่อฟิลด์}` |
| ตารางซ้ำ | `{d.items[i].ชื่อ}` + `{d.items[i+1]}` | `{#d.items}...{/d.items}` |
| เงื่อนไข | `{d.ฟิลด์:ifEQ(ค่า):show('ข้อความ')}` | `{#d.เงื่อนไข}...{/d.เงื่อนไข}` |

**กฎตารางซ้ำ:** `[i]` อยู่ช่องแรกของแถวข้อมูล, `[i+1]` อยู่แถวถัดไป
(ตารางซ้อน 2 ชั้นต้องมี `[i+1]` ของทุกชั้น)

---

## ฟอนต์ที่ติดตั้ง

| ชื่อที่ประกาศ | ใช้กับ |
|---|---|
| `TH Sarabun New` | เอกสารรุ่นใหม่ |
| `TH Sarabun PSK` | เอกสารราชการทั่วไป |
| `TH SarabunPSK` | รองรับทั้ง `TH SarabunPSK` และ `TH SarabunIT๙` |
| `TH Niramit AS` | ฟอนต์ราชการอีกตัว |
| อื่น ๆ 76 รูปแบบ | ฟอนต์สำรอง (Tlwg, Noto) |

**ข้อดี:** `TH SarabunPSK` รองรับชื่อ `TH SarabunIT๙` ด้วย
จึงใช้กับเอกสารราชการรุ่นเก่าได้โดยไม่ต้องแก้ชื่อฟอนต์ในไฟล์

ตรวจดูได้: `docker exec docserver fc-list :lang=th`

---

## การตั้งค่า

ตั้งค่าไว้ใน image แล้ว:

| ค่า | ค่าที่ใช้ | ผล |
|---|---|---|
| `converterFactoryTimeout` | 300000 (5 นาที) | รองรับเอกสารยาวกว่าค่าเริ่มต้น 60 วิ 5 เท่า |
| `factories` | 3 | ประมวลผลพร้อมกันได้ 3 งาน (เร็วกว่า 2.8 เท่า) |

ดูค่าจริง: `docker logs docserver | head -20`

แก้ค่าเอง: mount ไฟล์ config เข้าไป
```bash
docker run -d -p 4000:4000 \
  -v ./carbone-config.json:/app/config/config.json:ro \
  xeefour/2docx-docserver:latest
```

---

## ข้อควรระวังเรื่องความปลอดภัย

**Community Edition ไม่ตรวจ API Key**

ส่ง key ผิดหรือไม่ส่ง ระบบก็ทำงานเหมือนกันหมด
เครื่องหมาย `CARBONE_EE_API_KEY` ใน image เป็นค่าตัวอย่างเท่านั้น ไม่ใช่การป้องกันจริง

**วิธีที่ถูกต้อง:**
1. อย่าเปิดพอร์ต 4000 ออกอินเทอร์เน็ตโดยตรง
2. วาง API Gateway ของคุณไว้ข้างหน้าเพื่อตรวจสิทธิ์
3. ถ้าเปิดบนเซิร์ฟเวอร์จริง ให้ใช้ firewall ปิดพอร์ต

```bash
# ผูกเฉพาะ localhost (ปลอดภัยกว่า)
docker run -d -p 127.0.0.1:4000:4000 xeefour/2docx-docserver:latest
```

---

## ข้อจำกัด

| เรื่อง | ผลกระทบ |
|---|---|
| เวลาสูงสุด 5 นาที | เอกสารซับซ้อนมากอาจหมดเวลา ควรแบ่งเป็นหลายฉบับ |
| หน่วยความจำ | ปกติ ~320 MB · โหมด 3 งานพร้อมกัน ~650 MB |
| รูปภาพ | Carbone เวอร์ชันฟรีใส่รูปเองไม่ได้ ต้องฉีดรูปลงแม่แบบก่อน |
| `thaiDistribute` | LibreOffice ไม่รองรับ ต้องใช้ `both` แทน |

---

## เครื่องมือเสริม (นอก image)

ตัวฉีดรูปต้องรันฝั่งเครื่องคุณ ไม่ได้อยู่ใน image:
https://github.com/xeefour/2docx.com

---

## Tag ที่มี

| Tag | ความหมาย |
|---|---|
| `5.15.2` | เวอร์ชันที่ระบุ (แนะนำ ใช้ใน production) |
| `latest` | ล่าสุด |

---

## สัญญาอนุญาต

- Carbone Community Edition — MIT
- ฟอนต์ TH Sarabun — SIPA / กรมทรัพย์สิทธิ์ทางปัญญา (GPL 2.0 + Font Exception)
- ฟอนต์ Tlwg, Noto — SIL Open Font License
