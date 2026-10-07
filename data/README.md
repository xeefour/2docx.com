# data/ — ข้อมูลรันจริงและสำรอง

โฟลเดอร์นี้เก็บ **สิ่งที่ไม่ใช่ซอร์สโค้ด** ทั้งหมดของทั้งระบบ
ย้ายมาจากราก repo เมื่อ 5 ต.ค. 2026 — ก่อนหน้านั้น `docserver-backup-20260930/`
วางอยู่ราก repo ทำให้ดูเหมือนเป็นส่วนหนึ่งของโค้ด แต่จริง ๆ เป็นข้อมูลดิบ

**ทั้งโฟลเดอร์ถูก `.gitignore` ไว้** — ข้อมูลขนาดใหญ่ไม่ควรเข้า git
และมีเอกสาร/ฐานข้อมูลจริงปะปนอยู่

---

## สิ่งที่อยู่ในนี้ตอนนี้

| โฟลเดอร์ | เกิดจาก | ใช้ทำอะไร |
|---|---|---|
| `docserver-backup-20260930/` | ก่อนย้าย docserver เข้า Docker compose | กู้แม่แบบที่หาย และกู้ฐานข้อมูล metadata |

### โครงสร้างของ backup

```
docserver-backup-20260930/
├── template/          แม่แบบ .docx 11 ไฟล์ (ชื่อไฟล์คือ hash SHA-256 ของไฟล์)
│   └── ..._sample.docx   ตัวอย่างแม่แบบที่มีช่องรูป/วันเดือนปี
└── database/
    ├── metadata.db          ฐานข้อมูลหลักของ docserver
    ├── metadata.db-shm
    ├── metadata.db-wal
    └── backup-2135/         สำเนาก่อนมีการเปลี่ยนแปลง
```

---

## ใช้ยังไง

**กู้แม่แบบที่หาย** — คัดลอกไฟล์จาก `template/` ไปวางที่ volume ของ container:

```bash
docker cp data/docserver-backup-20260930/template/<hash>.docx docserver:/app/template/
```

หรือถ้าจะกู้ทั้งชุด ต้องหยุด container ก่อน แล้วคัดลอก `metadata.db` ทับของเดิม
(สำรอง `metadata.db` + `/app/template` ไว้ก่อนทุกครั้งที่จะลบแม่แบบ — ดูเหตุการณ์ที่เกิดจริงใน
[`docgen-platform/README.md`](../docgen-platform/README.md))

**ตรวจว่ามีอะไรอยู่บ้าง**

```powershell
Get-ChildItem data\docserver-backup-20260930\template
```

---

## ทำไมถึงแยกออกมา

ก่อนหน้านี้มีไฟล์สำรองปะปนอยู่ราก repo ทำให้สับสนว่าอะไรคือโค้ดที่ต้องแก้
แยกเป็น `data/` แล้วจึง:

- ราก repo เหลือแต่โฟลเดอร์ที่มีความหมาย (`docgen-platform` `dokploy-infra` `tests` `tools` `data`)
- `git status` ไม่ขึ้นขยะจากไฟล์สำรอง
- ตอนย้ายเครื่องหรือทำ backup แยก รู้ว่า `data/` คือส่วนที่ต้องก๊อปไปด้วย

> ข้อมูลจริงของระบบที่กำลังรันอยู่ **ไม่ได้อยู่ที่นี่** — อยู่ใน Docker volume
> (`docgen-data`, `mongo1` ฯลฯ) โฟลเดอร์นี้มีแค่สำเนาที่ถูก export ออกมาเท่านั้น
