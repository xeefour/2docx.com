# Observability — รวบรวม log ให้ LLM อ่าน

log จาก **container ของ stack `dokploy-infra` เท่านั้น** ถูกเก็บรวมไว้ที่เดียว ค้นหาย้อนหลังได้ 14 วัน
**ไม่มีหน้าเว็บสำหรับอ่าน** — อ่านผ่าน LLM เป็นหลัก (เหตุผลการตัด Grafana อยู่ท้ายไฟล์)

```
Alloy  ──อ่านผ่าน Docker API──▶ กรองเฉพาะ project นี้ ──▶ ตัด noise 84% ──▶  Loki
 (ดูดเฉพาะ dokploy-infra)                                       (เก็บ 14 วัน)
```

| service | พอร์ต | ทำอะไร |
|---|---|---|
| Loki | http://127.0.0.1:3100 | เก็บ log — API เปิดไว้ให้ LLM query (`/ready` เช็คสุขภาพ) |
| Alloy | http://127.0.0.1:12345 | ดูด log + กรอง + ตัด noise (พอร์ตนี้คือ UI/debug ของ Alloy เอง ไม่ใช่หน้าอ่าน log) |

---

## เก็บ log เฉพาะโปรเจกต์นี้

เครื่องนี้มีหลาย compose project ปะปนกัน สำรวจเมื่อ 2026-10-06:

| project | จำนวน container | อยู่ที่ |
|---|---|---|
| **`dokploy-infra`** | **17** ← เก็บ | `D:\2docx.com\dokploy-infra` |
| `dockers` | 2 | `D:\npm\table\dockers` (teable-*) |
| `line-oa` | 1 | (ทดลอง) |

ก่อนหน้านี้ Alloy ดูด **ทุก container บนเครื่อง** ทำให้ log ของโปรเจกต์อื่นปนอยู่ใน Loki
ตอนนี้กรองที่ `discovery.relabel` ใน `alloy/config.alloy`:

```river
rule {
	source_labels = ["__meta_docker_container_label_com_docker_compose_project"]
	regex         = "^dokploy-infra$"
	action        = "keep"
}
```

⚠️ **กฎนี้ต้องอยู่ก่อนกฎแปลง label อื่นทั้งหมด** — เพราะ `keep` ตัด target ทิ้งทันที
ถ้าไปอยู่ท้าย ๆ จะตัดผิดชั้นแล้ว**เงียบแบบไม่มี error**

### ⚠️ ข้อจำกัดที่ต้องรู้

- **container ที่ไม่มี compose project label จะถูกตัดทิ้งเงียบ ๆ** เช่นที่รันด้วย `docker run` ตรง ๆ
  ถ้าเคยมี container แบบนั้นใน stack ต้องเพิ่มชื่อเข้า regex
  ตรวจสอบด้วย `node docgen-platform/logs/inspect-container-projects.mjs`
- **log เก่าของโปรเจกต์อื่นยังอยู่ใน Loki** จนกว่า retention (14 วัน) จะลบ
  → หน้า `/analyze` จึง **กรองซ้ำตอนอ่าน** ด้วย `COMPOSE_PROJECT` (ดูหัวข้อถัดไป) ไม่ต้องรอ log เก่าหมดอายุ

### กรองชั้นที่สอง: ตอนอ่าน (หน้า `/analyze`)

Alloy กรองตั้งแต่ต้น แต่มีผลเฉพาะ log ที่เข้ามา**หลัง** restart · log เก่าที่เก็บไว้แล้วยังอยู่ครบ
เคยเห็น dropdown โผล่ `teable-*` (project `dockers`) และ `docgen-*-1` (project `docgen`) ทั้งที่กรองแล้ว

ตัวแปร `COMPOSE_PROJECT` (ค่าเริ่มต้น `dokploy-infra`) ถูกใช้ใน `tools/log-analyzer/server.mjs` กับ:

| จุดที่ใช้ | ผลของการกรอง |
|---|---|
| รายชื่อใน dropdown (`meta.all`) | เหลือเฉพาะ container ของโปรเจกต์นี้ |
| หัวข้อ 3 (ปริมาณ log) | ไม่รวม log ของโปรเจกต์อื่น |
| หัวข้อ 4 (เหตุการณ์น่าสงสัย) | ไม่รวม log ของโปรเจกต์อื่น |
| หัวข้อ 1 (สถานะ container) | `docker ps --filter label=…` (มีผลตอนรันบน host) |

⚠️ **ต้องตรงกับ regex ใน `alloy/config.alloy`** — ถ้าเปลี่ยนฝั่งเดียว อีกฝั่งจะไม่ตรง
แล้วจะเจออาการแบบหนึ่งในสองแบบ: UI มีชื่อที่ไม่มี log หรือมองของตัวเองไม่เห็น

⚠️ **container ที่เงียบมานานจะไม่อยู่ใน dropdown** — รายชื่อมาจาก
`count_over_time([24h])` ณ เวลาปัจจุบัน ตัวที่ไม่เขียน log เลยใน 24 ชม. จะหายไป
(วัดจริง 2026-10-06: `nats`, `rustfs`, `rustfs-ui` ไม่เขียนอะไรเลย) ถือว่าถูกต้อง
เพราะเลือกไปแล้วรายงานก็ว่างอยู่ดี

### 🚫 ข้อผิดพลาดของ Loki ที่เจอระหว่างทำส่วนนี้

1. **`/loki/api/v1/label/<name>/values` ไม่รับ `match[]` บน Loki 3.7.8**
   ส่งไปก็ถูกเมิน — ไม่ error แต่ไม่กรอง (ทดสอบด้วย selector แคบที่สุด
   `{job="dokploy-infra.gateway"}` ก็ยังคืน 25 ตัวเท่าเดิม) อันตรายกว่า error เพราะดูเหมือนทำงาน
2. **`query_range` จัดตำแหน่งจุดให้ตรงกับหน่วยของ `step`** ไม่ได้เริ่มที่ `start` ที่ส่งไป
   `step=86400` ทำให้จุดสุดท้ายตกลงมาที่เที่ยงคืน UTC — ถามเวลา 08:21Z ได้จุดสุดท้ายที่ 00:00Z
   เอามาเทียบกับ `end` ด้วยเกณฑ์แบบ `end - 5 นาที` ของจริงจะโดนตัดทิ้งหมด
   → **นับรายชื่อที่ "มี log" ต้องใช้ instant query** (`/query` ที่ `time=ตอนนี้`) ไม่ใช่ `query_range`
   → instant query ใช้ได้เฉพาะ metric query · log query ยังต้องใช้ `query_range` เสมอ

### ตรวจว่าตัวกรองทั้งสองชั้นยังทำงาน

```powershell
node docgen-platform\logs\show-alloy-targets.mjs            # ดูเป้าหมายที่ Alloy ดูดอยู่
node docgen-platform\logs\prove-alloy-project-filter.mjs   # พิสูจน์ชั้นที่ 1: ชี้ไป project อื่นแล้วต้องเหลือ 0
node docgen-platform\logs\prove-project-scope.mjs           # พิสูจน์ชั้นที่ 2: dropdown ต้องสะอาด + ตัวควบคุมลบ
```

> ดูเป้าหมายต้องอ่านจาก `/api/v0/web/components/loki.source.docker.containers`
> เพราะ `/metrics` มีแค่ `component_id` ไม่มี label ราย target
> และแต่ละ target เป็นโครงสร้าง `{ type, value: [{key, value:{type,value}}] }` ไม่ใช่ object ธรรมดา

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
├── docker-logs.ps1                 # ดู log ดิบจาก Docker (ใช้เมื่อ Loki ล่ม)
└── log-analyzer/                   # หน้าเว็บวิเคราะห์ log ด้วย AI → เข้าที่ /analyze
```

## ดู log แบบไหนดี

| ต้องการ | ใช้ |
|---|---|
| ค้น log เองละเอียด | `http://127.0.0.1:8090/logs/loki/api/v1/...` (Loki API ดิบ) |
| อ่าน log ตอนเจอปัญหา อยากได้สรุป | `tools\log-report.ps1` |
| **ไม่อยากอ่าน log เอง** | **`http://127.0.0.1:8090/analyze/`** ← ให้ AI สรุปให้ |
| Loki ล่ม / อยากดูดิบสุด | `tools\docker-logs.ps1` |

> `/analyze` เป็น service `log-analyzer` ใน stack เดียวกัน (โค้ดอยู่ที่ `../tools/log-analyzer`)
> ดูรายละเอียด: [`../README.md`](../README.md) → หัวข้อ 5
> ⚠️ หน้านี้ไม่มี auth — ไม่ publish พอร์ต เข้าได้ทาง gateway ที่ผูก 127.0.0.1 เท่านั้น
> ⚠️ ไม่ mount docker.sock → digest จะขึ้นว่า "อ่านสถานะ container ไม่ได้" (ตั้งใจ)

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
