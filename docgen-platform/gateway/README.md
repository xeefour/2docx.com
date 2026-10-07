# Gateway — ทางเข้าเดียวของทั้งระบบ

ทุกอย่างเข้าผ่าน container เดียว ไม่ต้องเปิดพอร์ตออกเครื่อง

## ทำไมถึงต้องมี

ก่อนหน้านี้สอง service เปิดรับจากทั้งเครื่อง:

| พอร์ต | ผูกกับ | ใครเข้าถึงได้ |
|---|---|---|
| `4001` (API) | `0.0.0.0` | ทุกเครื่องใน LAN → `http://192.168.0.106:4001` |
| `3000` (เว็บ) | `::` | ทุกเครื่องใน LAN → `http://192.168.0.106:3000` |

ตอนนี้ปิดทั้งคู่แล้ว ผู้ใช้เข้าผ่านโดเมนเดียว แล้ว gateway แยกบริการให้

## เส้นทาง

| URL | ไปที่ | หมายเหตุ |
|---|---|---|
| `/` `/studio` `/account` `/teams` | `web:3000` | เว็บ Next.js |
| `/api/*` | `api:4000` | path เต็ม เพราะ Fastify mount ใต้ `/api` |
| `/auth/*` | `api:4000` | Casdoor callback ไม่ได้อยู่ใต้ `/api` |
| `/apis` `/openapi.json` | `api:4000` | เอกสาร API (Swagger UI) |
| `/docs` `/docs/*` | ตัว gateway เอง | คู่มือสร้างแม่แบบ .docx (static จาก `docgen-platform/manual`) |
| `/files/*` | `rustfs-ui:8080` | หน้าไฟล์ใน S3 |
| `/logs/*` | `loki:3100` | ค้น log |
| `/healthz` | ตัว gateway เอง | ใช้ตรวจว่ายังรอด |

### `/docs` เป็นคู่มือ ไม่ใช่ Swagger

เคยสลับกันมาแล้ว เล่าไว้กันลืม:

- เอกสาร API อยู่ที่ **`/apis`** (`routePrefix` ใน `apps/api/src/app.ts`)
- **`/docs`** คือคู่มือสร้างแม่แบบ .docx เสิร์ฟตรงจาก Caddy (`file_server`)
  ไม่ต้อง build ไม่ต้องมี container เพิ่ม

ตอนแก้ `Caddyfile` อย่าลืม mount โฟลเดอร์คู่มือเข้า container ด้วย
(`../docgen-platform/manual:/srv/manual:ro` ใน `docker-compose.yml`)
ถ้าไม่ mount จะได้ 404 ทั้งเว็บโดยไม่มี error ที่ไหนเลย

### ตัวอย่างในคู่มือต้องผ่านการรันจริง

คู่มืออ้างผลลัพธ์ของ tag จำนวนมาก ถ้าเขียนจากการเดา ผู้ใช้จะเสียเอกสารจริง
จึงมีสคริปต์ฝังไว้ใน `docgen-platform/tools/` สามตัวที่ต้องรันทุกครั้งที่แก้คู่มือ:

| สคริปต์ | ตรวจอะไร |
|---|---|
| `docx-lab.mjs` | ตัวเครื่องมือสร้าง `.docx` ยิงเข้า docserver และอ่านข้อความกลับ |
| `verify-manual-examples.mjs` | ทุกตัวอย่างในคู่มือยังให้ผลตามที่เขียนไว้ `--prove` ฉีดบั๊กเพื่อพิสูจน์ว่าตัวตรวจจับผิดได้ |
| `check-manual-tags.mjs` | ทุก tag ในคู่มือต้องมีที่มาจากชุดที่พิสูจน์แล้ว กันตัวอย่างหลุดเข้ามาโดยไม่ได้ทดสอบ |

ข้อสำคัญ: ระบบเรนเดอร์เรียก docserver โดยส่งแค่ `data` กับ `convertTo`
ดู `apps/worker/src/docserver.ts` ฟังก์ชัน `renderDocument`
จึง**ไม่ได้**ส่ง `lang` หรือ `timezone` → ค่าที่ผู้ใช้เห็นคือค่าเริ่มต้นของ docserver
(ชื่อเดือนอังกฤษ สกุลเงินยูโร เขตเวลายุโรป) คู่มือจึงต้องเขียนตามความจริงข้อนี้

### ทำไม `/files` ทำงานได้ แต่ Alloy UI ไม่ได้

- **rustfs-ui (rclone)** — วัดแล้วว่าสร้างลิงก์**สัมพัทธ์** (`documents/`, `demo/`)
  เบราว์เซอร์จึงต่อจาก URL ที่มี prefix ให้เอง → ใช้ใต้ `/files` ได้
- **Loki** เป็น HTTP API ล้วน ไม่ใช่หน้าเว็บ → ถอด prefix แล้วยังชี้ถูก
- **Alloy UI** เป็น SPA ที่ดึง asset จาก **ราก** (`/assets/index-….js`)
  พอย้ายไปใต้ prefix มันจะขอ asset ผิดที่ และ `/assets` ของมันชนกับ
  `/_next` ของเว็บอยู่แล้ว → **ปล่อยไว้ที่ `127.0.0.1:12345`** เข้าผ่าน SSH tunnel

## สิ่งที่ตั้งใจไม่เปิด

| service | เหตุผล |
|---|---|
| Carbone Studio (`docserver:4000`) | ผู้ใช้ไม่ได้ใช้ มีระบบของเราเองแล้ว + ตั้ง `"authentication": false` = ไม่มี auth |
| MongoDB / NATS / Valkey / RustFS | เป็นข้อมูล ไม่ใช่หน้าเว็บ |

## ⚠️ ความปลอดภัยของ `/files` และ `/logs`

สองเส้นทางนี้ **ไม่มีการยืนยันตัวตน**:

- `rustfs-ui` = `rclone serve http` ไม่มี auth เลย → ใครก็ดูไฟล์ใน S3 ได้
- `Loki` ตั้ง `auth_enabled: false` → ใครก็ค้น log ได้

เปิดบนโดเมนสาธารณะแล้วถือว่าเปิดข้อมูลให้คนทั้งอินเทอร์เน็ต

แก้ได้สองทาง (เลือกทางใดทางหนึ่ง):

1. **ปิดบังค์ด้วย basic auth** — uncomment บล็อกใน `gateway/Caddyfile`
   เตรียม hash ก่อน:
   ```bash
   docker run --rm caddy:2 caddy hash-password --plaintext 'รหัสผ่าน'
   ```
2. **ไม่เปิดสองเส้นทางนี้เลย** — ลบบล็อกออกจาก `gateway/Caddyfile`
   ผู้ใช้เข้าเว็บผ่าน URL เดียวเหมือนเดิม

## วิธี map โดเมนใน Dokploy

1. Deploy stack นี้ก่อนให้ infra ขึ้น (มี network ชื่อ `infra` อยู่แล้ว):
   ```bash
   cd ../dokploy-infra && docker compose up -d
   cd ../docgen-platform && docker compose up -d --build
   ```
2. ใน Dokploy เพิ่ม **Domain** ให้ service `gateway`
   - **Container/Service** = `gateway`
   - **Port** = `80` (ข้างใน container)
   - **Path** = ว่างไว้ (ถ้าใส่ path จะไปชนกับการแยก prefix ของเรา)
3. Dokploy จะออก cert ให้เองและส่ง HTTP เข้ามาที่พอร์ต 80 ของ gateway

> ไม่ต้องใส่ **Host Port** ใน Dokploy — นั่นคือการเปิดพอร์ตออกเครื่อง
> ซึ่งเป็นสิ่งที่ตั้งใจกำจัดไป

## Debug จากเครื่องนี้

```bash
# ตรวจว่า gateway รอด
curl http://127.0.0.1:8090/healthz

# ยิง API ตรง ๆ (ไม่ผ่าน gateway)
docker compose -f docker-compose.yml -f docker-compose.dev-ports.yml up -d
curl http://127.0.0.1:4001/api/health
```

## แก้ Caddyfile แล้วอย่าลืม

```bash
docker compose restart gateway
```
