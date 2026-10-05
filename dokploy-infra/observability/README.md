# Observability — รวบรวม log ให้ LLM อ่าน

log จากทุก container ถูกเก็บรวมไว้ที่เดียว ค้นหาย้อนหลังได้ 14 วัน
**ไม่มีหน้าเว็บสำหรับอ่าน** — อ่านผ่าน LLM เป็นหลัก (เหตุผลการตัด Grafana อยู่ท้ายไฟล์)

```
Alloy  ──อ่านผ่าน Docker API──▶ ตัด noise 84% ──▶  Loki
 (ดูด log ทุกตัว)                                  (เก็บ 14 วัน)
```

| service | พอร์ต | ทำอะไร |
|---|---|---|
| Loki | http://127.0.0.1:3100 | เก็บ log — API เปิดไว้ให้ LLM query (`/ready` เช็คสุขภาพ) |
| Alloy | http://127.0.0.1:12345 | ดูด log + ตัด noise (พอร์ตนี้คือ UI/debug ของ Alloy เอง ไม่ใช่หน้าอ่าน log) |

---

## วิธีอ่าน (ใช้บ่อยที่สุด)

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\tools\log-report.ps1
```

ได้รายงานสรุปประมาณ **9 KB / 100 บรรทัด** แทนการอ่านบรรทัดดิบหลายหมื่นบรรทัด

| ตัวเลือก | ค่าเริ่มต้น | ใช้ทำอะไร |
|---|---|---|
| `-Since` | `24h` | ช่วงเวลา: `30m`, `6h`, `24h`, `7d` |
| `-Container` | ทุกตัว | จำกัดเฉพาะบางตัว เช่น `-Container mongo-1,mongo-3` |
| `-MaxSamples` | `2` | จำนวนตัวอย่างข้อความต่อประเภท |

ตัวอย่าง:

```powershell
.\tools\log-report.ps1 -Since 1h                 # ตอนเจอปัญหากำลังเกิด
.\tools\log-report.ps1 -Since 7d -MaxSamples 1   # ย้อนหลัง 7 วัน แบบสั้น
.\tools\log-report.ps1 -Since 2h -Container mongo-1   # เจาะตัวเดียว
```

รายงานมี 4 ส่วน: สถานะ container + replica set · ปริมาณ log ต่อตัว · เหตุการณ์น่าสงสัย
(จัดกลุ่มตามประเภท พร้อมช่วงเวลา) · ปริมาณ noise ที่ถูกตัด

> ⚠️ ถ้า Loki ไม่ทำงาน ใช้ `tools/docker-logs.ps1` แทน — อ่านจาก Docker ตรง ๆ
> ไม่ต้องพึ่ง stack นี้ (แต่ได้แค่ log ปัจจุบัน ไม่มีย้อนหลัง)

---

## เริ่ม / หยุด

```powershell
cd D:\2docx.com\dokploy-infra

docker compose up -d                  # ทั้ง stack
docker compose up -d loki alloy       # เฉพาะ 2 ตัวนี้
docker compose ps
docker compose logs -f loki
docker compose down                   # ปิด (เก็บข้อมูลไว้)
```

---

## LogQL ที่ใช้บ่อย (ถ้าต้อง query เอง)

```powershell
# helper: เปลี่ยนเป็นช่วงเวลาที่ต้องการ
$S = (Get-Date).AddHours(-6).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
$E = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
$q = [uri]::EscapeDataString('{container="mongo-1"} |= "error"')
Invoke-RestMethod "http://127.0.0.1:3100/loki/api/v1/query_range?query=$q&start=$S&end=$E&limit=50"
```

```
{container="mongo-1"}                                    # ตัวเดียว
{compose_project="dokploy-infra"}                        # ทั้ง stack
{container=~"mongo-.*"}                                  # regex
{container=~".+"} |= "(?i)refused|timeout"               # ค้นหาทั่วเครื่อง
sum by (container) (rate({container=~".+"}[5m]))          # อัตราการรับ log
topk(10, sum by (container) (count_over_time({container=~".+"}[1h])))   # ใครกินพื้นที่
```

> `|=` = ต้องมีข้อความ · `|~` = regex · `(?i)` = ไม่สนตัวพิมพ์
>
> ⚠️ **ต้องใช้ `.ToUniversalTime()`** — ถ้าใช้ `.ToString("...Z")` ตรง ๆ ใน PowerShell
> จะได้เวลาท้องถิ่นติดท้ายด้วยตัวอักษร `Z` (ไม่ใช่ UTC) → ช่วงเวลาเพี้ยน 7 ชม.
> ได้ผลลัพธ์เป็น 0 ทั้งที่มีข้อมูล

---

## เรื่องสำคัญที่ต้องรู้

### noise ของ MongoDB ถูกตัดทิ้ง 84%

mongo-1/2/3 ผลิต log **~99.6% ของทั้งเครื่อง** เกือบทั้งหมดเป็น replication noise
(`Connection accepted` / `client metadata` / `AuthenticationAbandoned` ฯลฯ)

Alloy ตัดก่อนส่งเข้า Loki ดูที่ `alloy/config.alloy` ฟังก์ชัน `stage.drop`

ตัวเลขจริงที่วัดแล้ว:

```
อ่านจาก Docker 1,422,716 บรรทัด → ตัด 1,196,513 (84.1%) → เก็บจริง 226,184
```

ดูตัวเลขสดได้ที่ `tools/log-report.ps1` หัวข้อ [4] หรือ:

```powershell
docker exec alloy wget -qO- http://localhost:12345/metrics | Select-String 'dropped_lines|target_entries'
```

**ถ้าวันไหนอยากดูของเต็ม** (เช่นไล่ปัญหา replica set) ให้ comment `stage.drop` ออกทั้ง 2 บล็อก
แล้ว `docker compose restart alloy` — แต่ระวังพื้นที่ดิสก์

### replica set เคยมีปัญหาค้างจริง

จากการอ่าน log ครั้งแรกพบว่า `NetworkInterfaceTL-ReplNetwork` ตัด connection ทิ้ง
(`Ending connection due to bad connection status`, `Dropping all pooled connections`)
และเคยมี `Host failed in replica set` — ไม่ใช่แค่ตอน restart
ถ้าเจอซ้ำให้ดูช่วงเวลาจากรายงาน ถ้าเกาะกลุ่มเป็นก้อน = restart/deploy
ถ้ากระจายสม่ำเสมอ = ปัญหาจริง ต้องไล่ต่อ

### ความปลอดภัย

- Loki เปิด `auth_enabled: false` และ**ไม่มีหน้าเว็บให้เข้า** อ่านผ่าน API เท่านั้น
- ผูก `127.0.0.1` เท่านั้น **ห้ามเปลี่ยนเป็น `0.0.0.0`**
- Alloy mount `docker.sock` แบบ read-only → **คนที่เข้าถึง Alloy เท่ากับคุมเครื่องนี้ได้**
  อย่าเปิดพอร์ต 12345 ออก

---

## โครงสร้างไฟล์

```
dokploy-infra/
├── docker-compose.yml
├── .env                            # ⚠️ ความลับ
└── observability/
    ├── README.md                   # ไฟล์นี้
    ├── loki/loki-config.yaml       # retention 14 วัน, จำกัดรับ 4 MB/s
    └── alloy/config.alloy          # ดูด log + ตัด noise

tools/
├── log-report.ps1                  # รายงานสรุปสำหรับ LLM อ่าน ← ใช้บ่อยสุด
└── docker-logs.ps1                 # ดู log ดิบจาก Docker (ใช้เมื่อ Loki ล่ม)
```

## เปลี่ยนค่าอะไรได้

| อยากเปลี่ยน | แก้ที่ |
|---|---|
| เก็บ log นานกว่า/น้อยกว่า 14 วัน | `loki-config.yaml` → `retention_period` + `max_query_lookback` (ต้องตรงกัน) |
| ไม่ตัด noise | `alloy/config.alloy` → comment `stage.drop` ออก แล้ว restart alloy |
| ตัด noise เพิ่ม/ลด | `alloy/config.alloy` → `stage.drop` (ใช้รูปแบบ `"msg":"..."` ของ mongo) |
| เปลี่ยนพอร์ต | `docker-compose.yml` → ส่วน `ports` ของ loki/alloy |
| เปลี่ยน RAM สูงสุด | `docker-compose.yml` → `deploy.resources.limits.memory` |
| เพิ่ม/ลดรูปแบบที่ทำให้เข้าเงื่อนไข "น่าสงสัย" | `tools/log-report.ps1` → ตัวแปร `$script:SUSPECT` |

---

## เวอร์ชัน

| service | version | หมายเหตุ |
|---|---|---|
| Loki | 3.7.8 | release ล่าสุด ณ 2026-09-17 |
| Alloy | v1.20.1 | **มี prefix `v`** — ไม่งั้น `1.20.1` pull ไม่ได้ |

Promtail เลิกสนับสนุนแล้ว (EOL 2 มี.ค. 2026) ตามเอกสารทางการของ Grafana — ใช้ Alloy แทน

---

## ทำไมถึงตัด Grafana ออก (4 ต.ย. 2026)

เคยตั้ง stack ครบด้วย Grafana 13.0.10 + dashboard + provisioning
แล้วตัดออกเพราะ:

- **ผู้ใช้อ่าน log เองไม่ได้** → dashboard กลายเป็นภาระที่ไม่ได้ใช้
- ใช้ RAM **388.6 MiB** (ตัวที่ 2 ของเครื่อง รองลงมาจาก docserver 620 MiB)
  มากกว่า Loki (103) + Alloy (95) รวมกัน — แลกกับประโยชน์ 0
- ใช้ดิสก์ 50.6 MB + เพิ่ม container ที่ต้องดูแล + ตัวแปรความลับใน `.env`
- LLM อ่าน log ผ่าน **Loki HTTP API** ได้ครบเท่ากัน (ไม่ต้องมีหน้าเว็บ)
  เคยพิสูจน์แล้วด้วยการ query จริงหลายรอบ

ที่เหลือ (Loki 103 MiB + Alloy 95 MiB) คือส่วนที่มีค่าจริง: เก็บ log + ตัด noise
