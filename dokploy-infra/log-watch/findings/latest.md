# พบความผิดปกติ — 7/10/2569 16:10:44

> ตรวจอัตโนมัติโดย `log-watch` · 3 รายการ

## สิ่งที่พบ
- พอร์ต 6379 ผูกกับ :: — เข้าจาก LAN ได้ ควรผูก 127.0.0.1
- container teable-cache publish พอร์ตออกมา (0.0.0.0:6379->6379/tcp, [::]:6379->6379/tcp) — เข้าจาก LAN ได้
- container teable-postgres publish พอร์ตออกมา (0.0.0.0:5432->5432/tcp, [::]:5432->5432/tcp) — เข้าจาก LAN ได้

## สรุปจาก AI
## สาเหตุที่น่าจะเป็น
- `teable-cache` (Valkey) และ `teable-postgres` ใช้ `0.0.0.0` และ `::` ในการ publish port ทำให้ทั้ง 5432 และ 6379 เปิดให้เครื่องอื่นใน LAN เข้าถึงได้โดยตรง ข้าม reverse proxy/gateway
- พอร์ต 6379 บน host ผูกกับ `::` (IPv6 wildcard) ไม่จำกัดเฉพาะ loopback ทำให้เสี่ยงถูกสแกน/โจมตีจากภายนอก host
- ไม่พบหลักฐานว่า service หลัก (gateway/API/worker) ล่ม — healthz, API, หน้าเว็บ, S3, Loki, render worker ตอบปกติทั้ง 7/7 route · คิวงาน 0 · replica set ปกติ
- เหตุการณ์น่าสงสัย 14 บรรทัด/ชม. (ต่ำกว่าเกณฑ์ 30) กระจุกที่ `docgen-gateway` 9 และ `alloy` 5 — ยังไม่ถึงเกณฑ์เตือน แต่ควรติดตาม

## สิ่งที่ต้องทำ
1. จำกัด Valkey (6379) ให้ผูกเฉพาะ loopback
```bash
docker stop teable-cache
docker run -d --name teable-cache --restart unless-stopped \
  -p 127.0.0.1:6379:6379 \
  <image:tag>   # ใส่ image เดิมของ teable-cache
```
2. ลบ publish port ของ Postgres ออก (ใช้ internal network ผ่าน service name)
```bash
# แก้ compose: เอา "5432:5432" ออกจาก ports ของ teable-postgres
docker compose up -d teable-postgres
```
3. ผูก Valkey ใน container ให้ฟังเฉพาะภายใน container (ไม่ต้องผูก 0.0.0.0 บน host)
   - เพิ่ม `command: ["valkey-server","--bind","127.0.0.1"]` หรือเทียบเท่าใน config ของ teable-cache
4. ตรวจยืนยันหลังแก้
```bash
ss -tlnp | grep -E '6379|5432'   # ควรเห็น 127.0.0.1:6379 เท่านั้น, 5432 ไม่โผล่บน host
docker ps --format '{{.Names}} {{.Ports}}' | grep -E 'teable-(cache|postgres)'
```
5. รีวิว log `docgen-gateway` (9 บรรทัด) และ `alloy` (5 บรรทัด) เพื่อยืนยันว่าเป็น noise ปกติ ไม่ใช่ probe เจาะพอร์ต 6379/5432

## ข้อควรระวัง
- ถ้ามี client ภายนอก host เดิมต่อ `localhost:6379` หรือ `localhost:5432` อยู่ ขั้นตอนที่ 1–2 จะตัดการเข้าถึงทันที — ตรวจรายชื่อ client ก่อนรัน
- ค่า `host-state.json` อายุ 77 นาที (เกิน 1 ชม.) รายการพอร์ตอาจไม่สดเท่าส่วน health — ควรดูเพิ่ม
- ถ้าจะเก็บ Valkey ไว้บน host (ไม่ผ่าน compose) ให้เพิ่ม firewall เช่น `iptables -A INPUT -p tcp --dport 6379 -s 127.0.0.1 -j ACCEPT; iptables -A INPUT -p tcp --dport 6379 -j DROP` เป็นตัวหนุน
- แนะนำตั้ง `requirepass` บน Valkey และเปลี่ยนรหัสผ่าน Postgres หากเคยเปิด 5432 สู่ LAN (ต้องดูเพิ่มจาก log auth ย้อนหลัง)

## ข้อมูลดิบ
```
สุขภาพรวม: up 6 / degraded 0 / down 0
- MongoDB (replica set rs0): up · rs0 · primary = mongo-1:27017 · 3 node · 76ms
- Valkey (session + cache): up · PONG · ใช้ 1.06M · 75ms
- NATS JetStream (stream JOBS): up · stream JOBS · 52 ข้อความ · 26635 bytes · 89ms
- RustFS (S3 · bucket documents): up · bucket 'documents' เข้าถึงได้ · 116ms
- 2docx docserver (เรนเดอร์): up · ตอบกลับ · มีแม่แบบ 90 รายการ · 754ms
- worker (เรนเดอร์งาน): up · heartbeat 6 วิที่แล้ว · คิวค้าง 0 · รอ ack 0 · 85ms
เส้นทาง (7/7 ปกติ):
- healthz /healthz → ปกติ · 1375ms
- หน้าเว็บ / → ปกติ · 2501ms
- API health /api/health → ปกติ · 2174ms
- เอกสาร API /apis → ปกติ · 1708ms
- สเปก API /openapi.json → ปกติ · 1884ms
- ไฟล์ใน S3 /files/ → ปกติ · 2479ms
- Loki /logs/ready → ปกติ · 1679ms
พอร์ต: ตรวจ 12 รายการจาก host-state.json (อายุ 77 นาที) · รั่ว 3
  - 6379 ผูกกับ ::
  - teable-cache → 0.0.0.0:6379->6379/tcp, [::]:6379->6379/tcp
  - teable-postgres → 0.0.0.0:5432->5432/tcp, [::]:5432->5432/tcp
เหตุการณ์น่าสงสัยใน 1 ชม.: 14 บรรทัด (เกณฑ์ต่อ container 30) — mongo นับเฉพาะระดับ Warn/Error/Fatal · ตัด log ของตัวตรวจเองออกแล้ว
    docgen-gateway: 9
    alloy: 5
Alloy: อ่าน 1,131,767 บรรทัด → ส่ง Loki 164,897
```
