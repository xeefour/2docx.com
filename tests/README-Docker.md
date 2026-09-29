# คู่มือ Docker container

ระบบสร้างเอกสารราชการจากแม่แบบ พร้อมฟอนต์ไทยครบชุด

---

## สรุป

| รายการ | ค่า |
|---|---|
| image | `carbone-thai:5.15.2` |
| ขนาด | 2.12 GB |
| container | `carbone-thai` |
| พอร์ต | 4000 |
| API Key | `carbon-ce` |
| สถานะ | healthy |
| ฟอนต์ไทย | 80 รูปแบบ |

---

## คำสั่งใช้งาน

```powershell
cd D:\2docx.com\tests

.\build.ps1              # สร้าง image + container ใหม่
.\build.ps1 -Check       # ดูสถานะปัจจุบัน (ไม่ต้อง build)
.\build.ps1 -Tag v2      # สร้างด้วยชื่อ image อื่น
.\build.ps1 -Keep        # สร้างโดยไม่ลบ container เก่า
```

### คำสั่ง Docker ตรง ๆ

```powershell
# ดูสถานะ
docker ps --filter 'name=carbone-thai'
docker logs --tail 30 carbone-thai

# หยุด / เริ่ม
docker stop carbone-thai
docker start carbone-thai

# ลบ
docker rm -f carbone-thai

# ดูฟอนต์ที่ติดตั้ง
docker exec carbone-thai fc-list :lang=th

# เข้าไปใน container
docker exec -it carbone-thai bash

# ดูหน่วยความจำ
docker stats carbone-thai --no-stream
```

---

## ที่อยู่

| รายการ | ค่า |
|---|---|
| API | `http://127.0.0.1:4000` |
| ตรวจสถานะ | `http://127.0.0.1:4000/status` |
| โฟลเดอร์ผลลัพธ์ | `D:\2docx.com\tests\output` (mount เข้า `/app/output`) |

> **สำคัญ: ใช้ `127.0.0.1` ไม่ใช่ `localhost`**
> บนเครื่องนี้ `localhost` จะ resolve เป็น IPv6 (`[::1]`) ก่อน
> ซึ่งอาจติด timeout จาก `wslrelay.exe` ที่ค้างอยู่
> ใช้ `127.0.0.1` จะเสถียรกว่าเสมอ

---

## เรียกใช้ API

```bash
# 1. อัปโหลดแม่แบบ (ทำครั้งเดียว)
curl -X POST http://127.0.0.1:4000/template \
  -H "Authorization: Bearer carbon-ce" \
  -F "template=@แม่แบบ.docx"

# 2. สร้างเอกสาร
curl -X POST "http://127.0.0.1:4000/render/{templateId}?download=true" \
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

## ฟอนต์ที่ติดตั้ง

| ชื่อที่ประกาศ | ที่มา | ใช้กับ |
|---|---|---|
| `TH Sarabun New` | SIPA / กรมทรัพย์สิทธิ์ทางปัญญา | เอกสารรุ่นใหม่ |
| `TH Sarabun PSK` | GitHub SarabunConsortium | เอกสารราชการทั่วไป |
| `TH SarabunPSK` | ชุดซีดีการาชการ | รองรับทั้ง `TH SarabunPSK` และ `TH SarabunIT๙` |
| `TH Niramit AS` | ชุดฟอนต์ราชการ | ฟอนต์ราชการอีกตัว |
| อื่น ๆ 76 รูปแบบ | Debian (Tlwg, Noto) | ฟอนต์สำรอง |

**ข้อดีของ `TH SarabunPSK`:** ประกาศชื่อรองรับทั้ง 2 แบบ ทำให้เอกสารราชการรุ่นเก่าที่ใช้ชื่อ
`TH SarabunIT๙` ใช้ได้โดยไม่ต้องแก้ชื่อฟอนต์ในไฟล์

---

## สิ่งที่ Dockerfile ตรวจตอน build

ขั้นตอน build จะตรวจสอบและ**หยุดทันทีถ้าไม่ผ่าน** (ไม่ได้สร้าง image ที่พัง):

| ขั้นตอน | ตรวจอะไร |
|---|---|
| 1 | ติดตั้งแพ็กเกจฟอนต์ + curl |
| 2 | คัดลอกฟอนต์จาก `lib/fonts/*.ttf` |
| 3 | สร้าง font cache ใหม่ |
| 4 | ยืนยันว่ามี `TH Sarabun New`, `TH Sarabun PSK`, `TH SarabunPSK` |
| 5 | ยืนยันสถาปัตยกรรม |
| 6 | ตั้ง healthcheck |

ผลที่ได้จริง: **ฟอนต์ไทย 80 รูปแบบ, สถาปัตยกรรม amd64**

---

## Healthcheck

ตรวจว่า API ตอบกลับจริง (ไม่ใช่แค่พอร์ตเปิด)

```dockerfile
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=3 \
    CMD curl --fail --silent --max-time 4 http://127.0.0.1:4000/status || exit 1
```

**ใช้ `curl` เพราะ container ไม่มี node/python** — Carbone เป็น binary คอมไพล์แล้ว

สถานะที่เห็นได้: `starting` → `healthy` / `unhealthy`

---

## ปัญหาที่เจอระหว่างทำ

### 1. healthcheck เรียก node ไม่ได้

**อาการ:** container รายงาน `unhealthy` ทั้งที่ทำงานปกติ
**สาเหตุ:** Carbone เป็น binary คอมไพล์ (`/app/carbone-ee-linux`) ไม่มี Node.js
**แก้:** ใช้ `curl` แทน และติดตั้ง curl ใน image

### 2. `localhost:4000` ติด timeout

**อาการ:** healthcheck ผ่าน (รันใน container) แต่เรียกจากเครื่อง host ไม่ได้
**สาเหตุ:** `wslrelay.exe` ถือพอร์ต `[::1]:4000` ค้างจาก container เก่า
มี connection ค้างหลายสิบรายการ ทำให้ `localhost` ติด timeout
**แก้:** ใช้ `127.0.0.1` แทน `localhost` ทุกจุด (แก้แล้ว 20 ไฟล์)

### 3. ไฟล์ .ps1 อ่านไทยไม่ได้หลังแก้แบบสคริปต์

**อาการ:** `ParserError` เต็มไปด้วยภาษาไทยเพี้ยน
**สาเหตุ:** PowerShell 5.1 ต้องการไฟล์ UTF-8 **พร้อม BOM**
การเขียนทับแบบ automated ด้วย encoding ที่ไม่มี BOM จะทำให้ไฟล์เสีย
**แก้:** เพิ่ม BOM กลับ 5 ไฟล์ (ตรวจแล้วครบ 13 ไฟล์)

> **บันทึก:** เวลาแก้ไฟล์ `.ps1` ที่มีภาษาไทย ต้องใช้ Edit/Write tool
> หรือเขียนด้วย `New-Object System.Text.UTF8Encoding($true)` เท่านั้น
> ห้ามใช้ encoding ที่ไม่มี BOM

---

## ผลการทดสอบบน container ใหม่

```
ส่วนที่ 1   ติดตั้งและตรวจสอบระบบ      ผ่าน   5/5
ส่วนที่ 2   ข้อความภาษาไทย            ผ่าน  38/38
ส่วนที่ 3   ตารางซ้ำและเงื่อนไข         ผ่าน  31/31
ส่วนที่ 4   รูปภาพ                    ผ่าน  11/11
ส่วนที่ 5   การเรียก API              ผ่าน  26/26
ส่วนที่ 6   ตัวฉีดรูป                 ผ่าน  23/23
ส่วนที่ 9   การกระจายย่อหน้าไทย        ผ่าน  11/11
ส่วนที่ 10  หัวกระดาษและเลขหน้า         ผ่าน  30/30 + 11/11
─────────────────────────────────────────────
รวม 8/8 ส่วน   ใช้เวลา 11.2 วินาที
```

---

## ข้อควรระวังก่อนใช้จริง

| เรื่อง | สถานะ |
|---|---|
| API Key ไม่ถูกตรวจ | **ต้องมี API Gateway คุมสิทธิ์เอง** |
| ขีดจำกัดเวลา 60 วิ | เอกสารยาวเกิน 65 หน้า ใช้โหมด async |
| จำกัดงานพร้อมกัน | 2-3 งาน (งานที่ค้างจะทำให้งานใหม่ช้าลง) |
| RAM | ปกติใช้ ~320 MB จาก 3.7 GB |
