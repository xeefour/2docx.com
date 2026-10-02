# Docgen Platform

ระบบสร้างเอกสารอัตโนมัติ — รับคำขอ → เข้าคิว → เรนเดอร์ PDF → เก็บลง object storage

```
Next.js (web)  ──►  Fastify API  ──►  NATS JetStream  ──►  worker
                       │                                     │
                       ├──► MongoDB (replica set)            ├──► docserver
                       └──► Valkey (cache)                   └──► RustFS (S3)
```

## Stack

| ชั้น | เลือกใช้ | เหตุผล |
|---|---|---|
| API | **Fastify 5** + **Zod 4** | เร็ว, schema คือ source of truth เดียว, type inference ตรงจาก schema |
| DB | **MongoDB 8** replica set 3 node | transaction + change stream ต้องมี replica set |
| คิว | **NATS JetStream** | ack / redelivery / at-least-once มาให้ |
| Cache | **Valkey** | Redis protocol, เบากว่า Redis เดิม |
| ไฟล์ | **RustFS** | S3-compatible, ไม่เก็บ binary ใน MongoDB |
| เรนเดอร์ | **docserver** (Carbone 5.15.2) | แม่แบบราชการไทย + LibreOffice |

> ตัว NATS / Valkey / RustFS / docserver ใช้จาก stack `../dokploy-infra`
> โปรเจกต์นี้มีแค่ MongoDB replica set + API + worker

## โครงสร้าง

```
docgen-platform/
├── packages/shared/          zod schema + config ที่ทุกฝั่งใช้ร่วมกัน
│   └── src/
│       ├── env.ts            validate .env ตอน import — ขาด = crash ทันที
│       ├── mongo.ts          หา primary จริงก่อนต่อ (ตอนรันบน host)
│       ├── errors.ts         AppError + error ย่อยที่แปลงเป็น HTTP status
│       └── schemas.ts        RenderJob / DocumentRecord / request bodies / health
├── apps/
│   ├── api/                  Fastify 5 + Zod 4
│   │   └── src/
│   │       ├── app.ts        ประกอบ plugin + error handler
│   │       ├── server.ts     entrypoint + graceful shutdown
│   │       ├── plugins/      mongo / valkey / nats(+jsm) / s3 / cookie / multipart
│   │       └── modules/
│   │           ├── auth/       OIDC + session (BFF กับ Casdoor)
│   │           ├── health/     checks.ts (รายการ service) + route.ts
│   │           ├── documents/  route.ts (HTTP) + service.ts (business)
│   │           └── templates/  route.ts (CRUD) + carbone.ts (client) + tags.ts (แกะ docx)
│   ├── worker/               NATS consumer
│   │   └── src/
│   │       ├── index.ts      ลูป consume + heartbeat
│   │       ├── docserver.ts  เรนเดอร์ผ่าน Carbone 2 รอบ (async)
│   │       ├── branding.ts   เขียนทับ metadata เป็น 2docx.com
│   │       └── s3.ts         บันทึกไฟล์
│   └── web/                  Next.js 15 — เว็บสาธารณะ + 2docx Studio
│       ├── next.config.mjs   rewrite /api, /auth, /docs ไป API (ไม่ต้องตั้ง CORS)
│       └── app/
│           ├── page.tsx      หน้าแรก (server component → SEO ได้)
│           └── studio/       Studio (client component → ไม่ต้อง SEO)
├── tools/                    สคริปต์ตรวจและนำเข้าแม่แบบ (รันด้วย `node --env-file=.env`)
└── docker-compose.yml        api + worker เท่านั้น
```

> MongoDB replica set, NATS, Valkey, RustFS และ docserver อยู่ใน stack `../dokploy-infra`
> แยกเป็น **infra** (ของที่ทุกโปรเจกต์ใช้ร่วมกัน) กับ **app** (ตัวแอป)

## เริ่มใช้งาน

### 1. เตรียม network ร่วม

```bash
docker network create infra
```

### 2. เตรียม config

```bash
cp .env.example .env
```

ใส่ค่าให้ตรงกับ stack `dokploy-infra` — ดู `.env` ของ stack นั้นได้เลย

### 3. ขึ้น infrastructure

```bash
cd ../dokploy-infra
docker compose up -d
```

> ⚠️ **ต้องขึ้น stack นี้ก่อนเสมอ** — ทุก service ที่แอปต้องใช้อยู่ที่นี่
> รวมถึง MongoDB replica set ที่ย้ายเข้ามาแล้ว
>
> `mongo-init` จะรันครั้งเดียวแล้วจบ (initiate replica set + สร้าง user `docgen`)
> ถ้ามีอยู่แล้วจะข้ามให้เอง รันซ้ำเพื่อ sync password: `docker compose up mongo-init`
>
> ⚠️ ถ้า `mongo-init` เพิ่ง initiate ใหม่ อาจต้องรอ ~30 วินาทีให้เลือก primary เสร็จ
> ระหว่างนั้น API/worker จะ crash ตอน boot แล้ว restart วนจนกว่าจะสำเร็จ — ไม่เป็นไร

### 4. ขึ้น API + worker

```bash
docker compose up -d api worker
```

API ที่ `http://localhost:4001` · Swagger UI ที่ `/docs` · spec JSON ที่ `/openapi.json`

### 4.1 ขึ้นเว็บ + 2docx Studio

```bash
npm run dev:web        # หรือ cd apps/web && npm run dev
```

เว็บที่ `http://localhost:3000` · Studio ที่ `http://localhost:3000/studio`

> ⚠️ เข้าเว็บด้วย **`localhost`** ไม่ใช่ `127.0.0.1`
> cookie ที่ Casdoor ตั้งไว้ผูกกับ host ถ้าไม่ตรงกันจะล็อกอินไม่ได้
> (cookie ไม่แยกพอร์ต — `:4001` กับ `:3000` ใช้ cookie ชุดเดียวกันได้)

## `/docs` เปิดสาธารณ — ตั้งใจ

Swagger UI ที่ `/docs` **ไม่ต้อง login** เป็นการตัดสินใจ ไม่ใช่ลืม

- ตัว API ยังบังคับ login อยู่เสมอ — กด "Try it out" แล้วยิงก็ได้ 401
- เปิดไว้เพราะเป็น API ภายในองค์กร (ผ่าน tailnet) และการดูเอกสารไม่ควรต้องล็อกอิน
- ถ้าวันหนึ่งเปิดออกสาธารณะจริง (ผ่าน Cloudflare Tunnel) ค่อยล็อกเพิ่ม

จุดที่ต้องรู้: `hook` ใน `app.ts` ตัด `/docs` ออกจาก auth แบบ `startsWith`
เพราะ Swagger UI โหลด static หลายไฟล์ ถ้าบังคับ login หน้าจะโหลดไม่ขึ้นเลย

## ดูสถานะทุก container ในจุดเดียว

`GET /api/health` รวมสถานะทุก service ที่ระบบพึ่งไว้ที่เดียว
โผล่ใน Swagger UI ที่ `/docs` (แท็ก `health`) — กด **Try it out** เห็นสถานะสดทันที

หรือดูเป็นตารางในเทอร์มินัล:

```bash
node --env-file=.env tools/health.mjs
```

```
  2docx · health   HTTP 200 · ok · probe 154ms
  ────────────────────────────────────────────────────────────────────────
  SERVICE                        CONTAINER                   LATENCY  DETAIL
  ────────────────────────────────────────────────────────────────────────
● up       API (Fastify)                   api                          0ms      uptime 54.81s · Node v22.23.2
● up       MongoDB (replica set rs0)       mongo-1 / mongo-2 / mongo-3  108ms    rs0 · primary = mongo-3:27017 · 3 node
● up       Valkey (session + cache)        valkey                       104ms    PONG · ใช้ 1.06M
● up       NATS JetStream (stream JOBS)    nats                         103ms    stream JOBS · 32 ข้อความ · 10689 bytes
● up       RustFS (S3 · bucket documents)  rustfs                       109ms    bucket 'documents' เข้าถึงได้
● up       2docx docserver (เรนเดอร์)      docserver                    127ms    ตอบกลับ · มีแม่แบบ 10 รายการ
● up       worker (เรนเดอร์งาน)            worker                       82ms     heartbeat 21 วิที่แล้ว · คิวค้าง 0 · รอ ack 0
  ────────────────────────────────────────────────────────────────────────
  up 6 · degraded 0 · down 0   ·   API uptime 0น 55ว
```

`label` ในตารางคือชื่อที่ผู้ใช้เห็น · `container` คือชื่อที่ `docker ps` แสดง
เทียบกันได้ตรง ๆ — ถ้าเพิ่ม container ใหม่ให้ใส่ทั้งสองช่อง

| สัญลักษณ์ | หมายถึง | ผลต่อระบบ |
|---|---|---|
| `● up` | probe ผ่าน | ใช้งานได้ |
| `◐ degraded` | ใช้ได้แต่มีเรื่อง | เช่น ยังไม่มี stream, worker ยังไม่ขึ้น |
| `○ down` | probe ไม่ผ่าน | มีตัวล่ม → ตอบ `503` |

- `200` = ทุกตัว `up` · `503` = มีตัว `down` (หรือ `degraded`)
- `latencyMs: null` = probe ไม่ตอบใน 2 วินาที (ไม่ใช่ "ตอบช้า")
- เปิดสาธารณโดยเจตนา เพราะ load balancer กับ Docker healthcheck เรียกโดยไม่มี session
  ถ้าบังคับ login ระบบจะถูกทำให้ unhealthy ทันทีที่ session หมดอายุ — เปิดเผยแค่ชื่อ service + up/down

### `/health` กับ `/api/health` ต่างกันยังไง

| path | ตรวจอะไร | ใช้ทำอะไร |
|---|---|---|
| `GET /health` | มีแค่ process ตัวเอง ไม่แตะ service อื่น | Docker `HEALTHCHECK` — ต้องเร็วและไม่มี dependency |
| `GET /api/health` | ทุก service พร้อมกัน มี timeout 2 วินาทีต่อตัว | คนดูสถานะรวม |

### 🛠 เพิ่ม container ใหม่ → แก้ไฟล์เดียว

รายการ health **ไม่ได้อ่านจาก `docker ps` อัตโนมัติ** ต้องเพิ่มเองที่
`apps/api/src/modules/health/checks.ts`

1. เพิ่ม service ใน docker-compose
2. ถ้าต้องตั้งค่าใหม่ ใส่ env ใน `packages/shared/src/env.ts` + `.env.example`
3. เพิ่ม object หนึ่งตัวใน `buildChecks()` — ใส่ `container` = ชื่อที่ `docker ps` แสดง
   เพื่อให้เทียบกันได้ และเขียน `detail` ให้บอกว่าต้องไปแก้อะไร
4. ไม่ต้องแก้ที่อื่น — route อ่านจาก array นี้อัตโนมัติและโผล่ใน `/docs` ทันที

ถ้าไม่มี client ใน API ให้ probe ด้วย `fetch` ไปที่ endpoint ตรง ๆ แทน

### ทำไม worker ต้องมี heartbeat

เช็คสถานะ consumer ของ NATS ไม่ได้บอกว่า worker ยังรอดอยู่ — **consumer ยังมีอยู่ต่อ
แม้ worker ตายไปแล้ว** จะโชว์ผิดว่าปกติ (เจอกรณีนี้จริงตอน API ล่มจาก timeout 1 ชม.)

worker จึงเขียน heartbeat ลง collection `workers` ทุก 30 วินาที
API ถือว่าตายเมื่อไม่ตอบเกิน 90 วินาที

เขียนลง Mongo ไม่ใช่ Valkey เพราะ worker เปิด Mongo อยู่แล้ว
ต่อ Valkey เพิ่มคือ failure mode ใหม่ที่ไม่จำเป็น

## เข้าสู่ระบบ (Casdoor OIDC)
API ใช้ Casdoor เป็น identity provider แบบ **BFF** — API เป็นคนจัดการ OAuth flow
เก็บ session เป็น cookie `httpOnly` ให้ JavaScript อ่านไม่ได้
หน้าเว็บไม่ต้องแตะ token เลย ยิง API แล้ว browser แนบ cookie ให้เอง

```
browser ──► /auth/login ──► Casdoor ──► /auth/callback
                                            │
                              แลก code → token, verify JWT
                                            │
                              เก็บ session ลง Valkey
                                            │
                              set cookie (httpOnly, SameSite=Lax)
```

| route | ทำอะไร |
|---|---|
| `GET /auth/login` | สุ่ม state + PKCE → redirect ไป Casdoor |
| `GET /auth/callback` | ตรวจ state → แลก code → verify JWT → สร้าง session |
| `POST /auth/logout` | ลบ session ออกจาก Valkey |
| `GET /auth/me` | ข้อมูลผู้ใช้ปัจจุบัน |

### ต้องตั้งค่าอะไรใน Casdoor

**Redirect URL** ต้องเพิ่มบรรทัดนี้ (ตรงทุกตัวอักษร):

```
http://localhost:4001/auth/callback
```

> ⚠️ ของที่ลงทะเบียนไว้เดิมคือ `localhost:9000` (RustFS) กับ `localhost:4000` (docserver)
> ซึ่งไม่ใช่ API — ถ้าใช้ตามนั้น callback จะโดน 404/403 ทันที

### ⚠️ session cookie ต้องอยู่ same site

`SameSite=Lax` ใช้ได้ตราบใดที่หน้าเว็บกับ API อยู่ same site:

- หน้าเว็บ `localhost:3000` + API `localhost:4001` ✓ (port ต่างไม่เป็นไร)
- ทั้งคู่บน Tailscale เดียวกัน ✓

ถ้าข้าม site จริง ๆ (เช่น หน้าเว็บ `localhost` แต่ API `127.0.0.1`) จะต้องใช้
`SameSite=None` ซึ่ง**บังคับต้องมี https** ซึ่ง localhost ไม่มี → login ไม่ติด
นี่คือเหตุผลที่ `CASDOOR_REDIRECT_URI` ต้องใช้ `localhost` ไม่ใช่ `127.0.0.1`

### ทำไมเก็บ session ใน Valkey ไม่ใช่ verify JWT ทุกครั้ง

- เร็วกว่า — ไม่ต้องถอด signature ทุก request
- **revoke ได้ทันที** — ถ้า user ถูกลบ/ระงับจาก Casdoor token ที่ออกไปแล้วยังใช้ได้อยู่
  แต่ session ฝั่ง server ลบทีเดียวจบ

### ข้อควรระวังของ Casdoor

`access_token` กับ `id_token` เป็น **JWT ตัวเดียวกัน** payload เดียวกันเปล่า ๆ มีข้อมูล user อยู่ข้างใน
ถ้าเอาไปเก็บใน `localStorage` ของ browser ข้อมูลผู้ใช้จะรั่นผ่าน XSS ทันที
แบบ BFF ที่ใช้อยู่ตัดปัญหานี้ทิ้งไปเลย

### เอกสารผูกกับผู้สร้าง

ทุกเอกสารเก็บ `createdBy` = `sub` ของผู้สร้าง และทุก query กรองด้วย field นี้
เอกสารเก่าที่ยังไม่มี field = ไม่มีใครเป็นเจ้าของ → ไม่มีใครเห็น

## แบรนด์ที่ฝังในไฟล์ที่ส่งออก

`worker/src/branding.ts` เขียนทับ metadata ของไฟล์**หลังเรนเดอร์เสร็จ ก่อนขึ้น S3**
ค่ามาจาก `OUTPUT_BRAND` (default `2docx.com`) — เว้นว่าง = ปล่อยไว้ตามเดิม

| รูปแบบ | เขียนทับ |
|---|---|
| PDF | `/Producer` · `/Creator` · `/Author` |
| DOCX / XLSX / PPTX | `docProps/core.xml` (creator, lastModifiedBy) · `docProps/app.xml` (Application, Company) |
| ODT | `meta.xml` (initial-creator, generator) |
| รูปภาพ | ไม่แตะ — ไม่มี metadata ให้แก้ |

**ทำไมต้องทำ** — ปล่อยไว้ตามเดิมทุกฉบับจะติดป้ายชื่อเครื่องมือ
(`/Producer = "LibreOffice 26.2.4.2"` · `Application = "Microsoft Office Word"`)
และที่หนักกว่านั้น **`dc:creator` ของ .docx ต้นแบบถูกส่งต่อมาทุกฉบับที่เรนเดอร์**
ของเราเคยเจอชื่อจริงของผู้ทำแม่แบบปนอยู่ในเอกสารทุกฉบับที่ส่งออก

ทดสอบว่า patch แล้วเอกสารยังเปิดได้:

```bash
node --env-file=.env tools/test-branding.mjs    # PDF + DOCX ผ่านสายงานจริง
node --env-file=.env tools/verify-meta.mjs     # PDF อ่านกลับ + ODT ตรวจ mimetype
```

### ⚠️ pdf-lib เขียน `/Producer` ทับเอง

`PDFDocument.load()` เรียก `updateInfoDict()` ตอน constructor ซึ่ง **เขียน `/Producer`
ทับเป็นชื่อ pdf-lib เสมอ** ถ้าไม่ปิด

```ts
// ⚠️ ต้องใส่ที่ save() ด้วย — ใส่แค่ load() ไม่พอ
const pdf = await PDFDocument.load(buf, { updateMetadata: false })
// ...
await pdf.save({ updateMetadata: false } as SaveOptions)
```

ผลคือถ้าไม่ใส่จะได้ `/Producer = "pdf-lib (https://github.com/Hopding/pdf-lib)"`
ซึ่ง**แย่กว่าการไม่ patch เสียอีก** เพราะเดิมเป็น LibreOffice อยู่แล้ว

`SaveOptions` ยังไม่ได้ประกาศ `updateMetadata` ใน type — ต้อง cast
(รันจริงได้ผล ทดสอบแล้วทั้ง 3 แบบ)

### ⚠️ อ่าน metadata ของ PDF ด้วย pdf-lib ต้องระวัง

```ts
PDFDocument.load(bytes)                    // ❌ คืนค่าที่ถูกเขียนทับแล้ว
PDFDocument.load(bytes, { updateMetadata: false })  // ✅
```

โหลดแล้วตรวจ `/Producer` จะเจอ `"pdf-lib..."` เสมอ แม้ไฟล์จริงถูก patch ถูกต้องแล้ว
ทำให้เข้าใจผิดว่า patch ไม่ทำงาน — ต้องดูจาก **byte ดิบ** หรือใส่ `updateMetadata: false`

### ⚠️ ODT ต้องเก็บ `mimetype` ไว้ตัวแรกและห้ามบีบอัด

ODF บังคับแบบนี้ ถ้า zip ตามปกติ LibreOffice จะเปิดไม่ได้
`fflate` ให้กำหนดราย entry ได้: `mimetype: [data, { level: 0 }]`

## เส้นตรวจสะกดสีแดงบนข้อความไทย

เอกสาร `.docx` ที่ระบบส่งออก เปิดใน Word/LibreOffice แล้วข้อความไทย
จะขึ้นเส้นหยักสีแดงทั้งบรรทัด (`word/document.xml` เดิมมี `w:lang` = **0 จุด**)

**สาเหตุไม่ใช่ตัวสะกด แต่เป็นภาษาของ run** — ตรวจไฟล์จริงที่ระบบสร้างแล้วพบว่า
`word/styles.xml` ตั้งค่าเริ่มต้นไว้ที่ `<w:lang w:val="en-US" .../>` และไม่มี run ไหน override
Word/LibreOffice จึงเอาพจนานุกรม**อังกฤษ**มาตรวจข้อความไทย

| ไฟล์ | ตรงไหน |
|---|---|
| `packages/shared/src/docx-lang.ts` | `setDocxThaiLanguage()` — ไล่ทุก `<w:r>` แล้วใส่ `<w:lang w:val="th-TH"/>` |
| `apps/worker/src/docserver.ts` | เรียกตอนส่งออก `.docx` (PDF ไม่ต้อง — ไม่มีเส้นตรวจสะกด) |

**ทำไมแก้ทีละ run ไม่แก้ค่าเริ่มต้นของทั้งเอกสาร** — ถ้าแก้ `docDefaults` เป็น `th-TH` ตรง ๆ
ข้อความอังกฤษในเอกสารเดียวกัน (`Ref. No. 1234/2569`, อีเมล) จะกลายเป็นตัวที่โดนตรวจสะกดแทน
การกำหนดตามภาษาของข้อความจริงจึงไม่กระทบส่วนอื่น — ข้อความผสมที่อังกฤษมากกว่าไทยถูกข้าม

### ⚠️ `w:lang` ต้องมาก่อน `w14:ligatures`

แม่แบบราชการเกือบทุกฉบับมี `<w14:ligatures w14:val="none"/>` ในทุก run
(element ของ namespace อื่น ที่ Word คาดว่าอยู่**ท้ายสุด** ของ `w:rPr`)

ถ้าแทรก `w:lang` ไปทีหลัง → Word มองว่าลำดับผิด แล้วขึ้น *"มีเนื้อหาที่อ่านไม่ได้"*
ตอนเปิดไฟล์ (LibreOffice ใจดีกว่า เปิดได้เฉย ๆ ทำให้พลาดได้ง่าย)

```xml
<w:rPr>
  <w:sz w:val="32"/>
  <w:lang w:val="th-TH"/>        <!-- ต้องอยู่ตรงนี้ -->
  <w14:ligatures w14:val="none"/>
</w:rPr>
```

กติกาอื่นที่ต้องระวัง: แก้เฉพาะ `w:val` ของ `w:lang` ที่มีอยู่แล้ว (อย่าเขียนทับทั้งแท็ก เพราะจะทำ
`w:eastAsia` หาย → ฟอนต์เปลี่ยน) · คง attribute ของ `<w:rPr>` ไว้ · ขยาย `<w:rPr/>` แบบว่างก่อนแทรก
· แก้ `document.xml` + `header*` + `footer*` + `footnotes` + `endnotes` · ไฟล์ที่คลายไม่ได้คืนเดิม ไม่ throw

```bash
node --env-file=.env --import tsx tools/test-thai-lang.mjs  # 22 ข้อ กรณีขอบ
node --env-file=.env tools/check-xml.mjs                    # ทุกแม่แบบจริง + ให้ LibreOffice เปิด
node --env-file=.env tools/make-spell-demo.mjs              # ไฟล์ก่อน/หลังเทียบใน Word
```

ผลจริง: ทั้ง 9 แม่แบบ run ภาษาไทยได้ `th-TH` ครบ 100% และ LibreOffice แปลงเป็น PDF ได้ครบ

## 2docx Studio

`https://<host>.ts.net/studio` (หรือ `localhost:3000/studio`) — เครื่องมือจัดการแม่แบบของเราเอง
แทน Carbone Studio · เข้าสู่ระบบด้วย Casdor เดียวกับ API · พอร์ต 3000

| ทำอะไรได้ | รายละเอียด |
|---|---|
| ดูรายการแม่แบบ | ค้นหาจากชื่อ/แท็ก/versionId · กรองตามหมวด |
| อัปโหลด | ลากไฟล์ `.docx/.xlsx/.pptx/.odt` ทิ้ง หรือกดปุ่ม |
| แก้ข้อมูล | ชื่อ · หมวด · แท็ก (คั่นด้วยจุลภาค) |
| ดูแท็กที่ใช้ | อ่านจากไฟล์จริงทุกครั้ง ไม่ต้องเดา |
| เติมชื่ออัตโนมัติ | พิมพ์ในช่อง JSON แล้วกด Tab |
| เรนเดอร์ตัวอย่าง | ได้ PDF ดูเป็นรูปในหน้าเดียว ไม่ต้องออกจากเครื่อง |
| ลบ | ต้องกดยืนยันสองครั้ง |
| บุ๊กมาร์ก | กดดาวที่แถวแม่แบบ แล้วมาเจอในแท็บ "บุ๊กมาร์ก" |

## ฟอร์ม · AI · แชร์ (Studio เวอร์ชันเต็ม)

หน้าแก้ไขแม่แบบหนึ่งตัวแบ่งเป็น 5 แท็บ และหน้ารายการแบ่งเป็น 4 แท็บ

| แท็บ | ทำอะไร |
|---|---|
| **ฟอร์ม** | กรอกข้อมูลตามช่องที่ผู้ใช้ออกแบบ + แผง **AI ช่วยกรอก** + เรนเดอร์เห็นรูป |
| **JSON** | แก้ `data` ตรง ๆ (ทั้งฟอร์มและ JSON ใช้ชุดข้อมูลเดียวกัน) |
| **ช่องฟอร์ม** | ออกแบบช่องเอง — ชนิด · required · integer · regex · กลุ่ม · ลำดับ |
| **แม่แบบ & การแชร์** | metadata + publish/private + เพิ่มคนเข้าใช้ทีละคน + **ดาวน์โหลด / อัปโหลดแทนไฟล์แม่แบบ** |
| **ผู้ใช้แม่แบบนี้** | ใครใช้แม่แบบนี้บ้าง กี่ฉบับ สำเร็จ/ล้มเหลวเท่าไร |

### ดาวน์โหลด / อัปโหลดแทนไฟล์แม่แบบ

อยู่ในการ์ด **ข้อมูลแม่แบบ** หัวข้อ "ไฟล์แม่แบบ"

- **⬇️ ดาวน์โหลดแม่แบบ** — ได้ไฟล์ต้นฉบับกลับไปแก้ใน Word/LibreOffice
  (ทุกคนที่เห็นแม่แบบดาวน์โหลดได้ · แม่แบบส่วนตัวที่ไม่ได้แชร์ให้เรา → 403)
- **⬆️ อัปโหลดแม่แบบใหม่แทน** — กดแล้วเลือกไฟล์ จะขึ้นยืนยันก่อน
  เพราะการเขียนทับกระทบทุกคนที่ใช้แม่แบบนี้
  ผลคือ **เวอร์ชันถัดไปของแม่แบบเดิม** → ช่องฟอร์มและสิทธิ์เดิมยังอยู่ครบ
  (คนที่มีสิทธิ์แค่ดูอย่างเดียว จะเห็นแค่ข้อความบอกเหตุผลแทนปุ่ม)

### ประวัติสองฝั่ง — ต่างกันตรงไหน

| | ซ้าย · **ประวัติ** | ขวา · **ผู้ใช้แม่แบบนี้** |
|---|---|---|
| ขอบเขต | ของ**ฉันเอง** | ทุกคน |
| คืนค่าที่กรอกไว้ | ✅ เอามาแก้ต่อได้ | ❌ ไม่คืน (ข้อมูลส่วนตัวของคนอื่น) |
| ทำอะไรได้ | ค้นหา → กด **แก้ไข** → ค่ากลับเข้าฟอร์ม | ดูภาพรวม · อ่านอย่างเดียว |

ทุกครั้งที่สั่งเรนเดอร์ ระบบเก็บ `data` ที่กรอกไว้กับเอกสาร (`documents.data`)
เพื่อให้กลับมาแก้ต่อได้ — ค่าที่กรอกของคนอื่น **ไม่ถูกส่งออกไป** เพราะ API กรอง `createdBy` เสมอ

> **ทำไมต้องค้นด้วย "ชื่อผู้รับ" ได้**
> ชื่อฉบับคือ `studio: <ชื่อแม่แบบ>` ซึ่ง**เหมือนกันหมดทุกฉบับ**
> คนทำงานจำชื่อฉบับไม่ได้ แต่จำชื่อผู้รับได้
> จึงค้นทั้งชื่อฉบับและค่าที่กรอก แล้วโชว์ตัวอย่างค่าให้เห็นก่อนกดแก้ไข

> **⚠️ Mongo ค้นค่าข้างใน object ไม่ได้** — คีย์ของเราเป็น dot path ของ Carbone
> เช่น `ผู้รับ.ชื่อ` ทำให้ `{ data: { $regex } }` และ `{ 'data.$**': { $regex } }`
> **ไม่เจอแม้แต่เอกสารที่ค่าตรงเป๊ะ** (Mongo แปลงจุดในคีย์เป็นโครงสร้างนิยาม)
> จึงกรองฝั่ง Node แทน จำกัดการสแกนไว้ 500 ฉบับล่าสุด
> ถ้าวันหนึ่งต้องค้นทั้งระบบ ให้เพิ่มคอลัมน์ "ข้อความค้นหา" แยก + text index

### ช่องกรอกที่ผู้ใช้ออกแบบเอง

เก็บใน MongoDB (`form_schemas`) ผูกกับ **templateKey** = `TemplateSummary.id` ของ Carbone
(ไม่ใช่ versionId — เพราะทุกเวอร์ชันควรใช้ชุดช่องเดียวกัน)

| ชนิด | หมายเหตุ |
|---|---|
| `text` `textarea` `email` `date` | ข้อความ |
| `number` `integer` | `integer` บังคับไม่มีจุดทศนิยม + ตรวจ min/max |
| `select` `multiselect` | ตัวเลือกกำหนดเอง และตรวจว่าค่าที่เลือกอยู่ในรายการ |
| `checkbox` | ใช่/ไม่ใช่ |

กติกาที่ตั้งได้: `required` · `integer` · `min`/`max` · `minLength`/`maxLength` ·
`pattern` (regex ของ JavaScript) + ข้อความแจ้ง error และ `ai.enabled` (ให้ AI ช่วยเติมช่องนี้ไหม)

**⚠️ `key` ต้องตรงกับแท็ก `{d.…}` ในไฟล์แม่แบบ** — ถ้าไม่ตรง Carbone จะไม่แทนค่า
จึงมีปุ่ม **เติมช่องอัตโนมัติ** ที่อ่านแท็กจากไฟล์จริงมาสร้างช่องให้ (ปลอดภัยที่สุด)
และรองรับ path แบบ nested ด้วยจุด เช่น `ผู้รับ.ชื่อ`

#### ⚠️ React `key` ของแถวช่องห้ามผูกกับค่าในช่อง — จะทำให้พิมพ์ไทยติดขัด

เคยเขียน `key={`${f.key}-${i}`}` ใน `FieldBuilder` และ `key={f.key}` ใน `FormFields`
ผลคือพอผู้ใช้พิมพ์ในช่อง key **ทุกตัวอักษร** ค่า key เปลี่ยน → React มองว่าเป็น element ใหม่
→ ถอดออกแล้วใส่ใหม่ → **โฟกัสหลุดทันที** และที่แย่กว่านั้น **IME ไทยพังกลางคัน**
เพราะ input ที่กำลัง "เรียงพิมพ์" ถูกทำลาย ผู้ใช้รายงานว่า *"พิมพ์ 1 ครั้งแล้วต้องรอ ใช้งานไม่สะดวก"*

ใช้เลข index ของ draft แทน ซึ่งตรงกับตัวตนของโค้ดอยู่แล้ว (`patch(i, …)` · `editing === i`)

> การเปลี่ยนค่า **กลุ่ม** ก็ทำให้โฟกัสหลุดเหมือนกัน แต่นั่นถูกต้องแล้ว
> เพราะฟิลด์ย้ายไปอยู่กลุ่มอื่นจริง ๆ — เทสต์จึงต้องแยกให้ชัดว่ากำลังทดสอบช่องไหน

#### เพิ่มตัวเลือกของ `select` ได้เอง

เดิมแก้ตัวเลือกได้ทางเดียว: textarea รูปแบบ `ค่า|ป้าย` บรรทัดละหนึ่งค่า
ผู้ใช้บอกว่า *"ใช้งานแล้วไม่พบตัวเลือก ให้สามารถเพิ่มเพิ่มลงไปได้"*

ตอนนี้เป็นรายการ: ช่อง **ค่า** · ช่อง **ป้าย** · ปุ่มลบ · ปุ่ม **+ เพิ่มตัวเลือก**
คงกล่องวางหลายบรรทัดไว้ใน `<details>` สำหรับคนที่มีตัวเลือกเยอะ

> ⚠️ **กล่องวางหลายบรรทัดต้องเป็น uncontrolled**
> ถ้าเขียน `value={options.map(o => `${o.value}|${o.label}`).join('\n')}`
> แล้วยิง onChange ทุกตัวอักษร → พิมพ์ "นาย" กลายเป็น "นาย|นาย" กลางคัน
> ค่ากลับมาเขียนทับสิ่งที่ผู้ใช้พิมพ์ → เคอร์เซอร์กระโดด → พิมพ์ไทยติดขัด
> (อาการเดียวกับที่ผู้ใช้เจอที่ช่อง key พอดี)
> จึงเก็บข้อความดิบไว้ใน state ชื่อ `bulk` แล้วค่อยแปลงเป็น options

```bash
node --env-file=.env tools/test-field-builder.mjs   # 17 ข้อ
```

> ⚠️ **เทสต์พิมพ์ต้องใช้ `data-testid` ของช่องนั้น ๆ** อย่าเดา selector จาก `placeholder`
> ช่อง `field-group-` (กลุ่ม) ย้ายกลุ่มแล้ว remount โดยถูกต้อง → เทสต์จะตกทั้งที่ไม่มีบั๊ก
>
> ⚠️ **`keyDown` ห้ามส่ง `text` ตอนพิมพ์ด้วยปุ่มจริง** — ถ้าส่งจะแทรกอักขระตอนกด
> แล้วพอยิง `char` อีกครั้งมันจะแทรกซ้ำ (ได้ `นนาายย` จาก `นาย`)
> ให้ `keyDown`/`keyUp` ไปแค่บอกว่ากดปุ่ม แล้วให้ `char` เป็นตัวแทรกข้อความ

กติกาถูกตรวจ **ทั้งที่พิมพ์ในเบราว์เซอร์ และที่ API ก่อนเรนเดอร์**
โดยใช้ฟังก์ชันเดียวกัน (`validateFormData`) — ตัวแยกฝั่ง web ซ้ำไว้ใน
`apps/web/app/studio/lib/fields.ts` เพราะ `@docgen/shared` ดึง `env.ts` มาด้วย
ซึ่งอ่าน `process.env` แล้ว `process.exit(1)` ในเบราว์เซอร์

### AI ช่วยกรอกข้อมูล

ผู้ใช้พิมพ์เล่าความต้องการ → AI เติมข้อมูลให้ **เฉพาะช่องที่ยังว่าง**
(ค่าที่คนกรอกเองจะไม่ถูกทับ — `mergeAiData`)

- provider: `minimax` (ค่าเริ่มต้นเมื่อมี key) · `openai` · `mock`
- ทุก provider ใช้ OpenAI Chat Completions ที่ `${base}/chat/completions`
- **กรอง key ที่โมเดลแต่งขึ้นเอง** — เอาเฉพาะ key ที่แม่แบบรู้จักจริง
- ประวัติแชทเก็บเป็นข้อความลง Mongo (`chat_sessions`) กลับมาคุยต่อได้
- เลือก provider ได้ต่อคำขอจากหน้าเว็บ (ค่าหลักของระบบยังคุมด้วย env)

MiniMax: base `https://api.minimax.io/v1` · โมเดล `MiniMax-M3` (จีน: `api.minimaxi.com`)
ส่ง `thinking: {type:'disabled'}` เพราะ M3 คิดโดยค่าเริ่มต้น (ช้ากว่าหลายเท่าตอนเติมค่าในฟอร์ม)

> **ค่าเริ่มต้นคือ `LLM_PROVIDER=mock`** เพื่อให้ระบบทำงานได้โดยไม่ต้องมี key
> mock เดาค่าจากชื่อฟิลด์ (ใช้ทดสอบ flow ได้จริง แต่ไม่ใช่ AI)
> ตั้ง `LLM_API_KEY` แล้วเปลี่ยนเป็น `minimax` เพื่อใช้ของจริง

### AI ประจำช่อง (ไอคอนขวาสุดของ input/textarea)

ต่างจากแผง AI ใหญ่ตรงที่ **โฟกัสช่องเดียว** — กดไอคอนดาววิบๆ ที่ขวาสุดของช่อง
แล้วคุยกันใน popover เล็ก ๆ ตรงช่องนั้น

| ปุ่มลัด | ทำอะไร |
|---|---|
| ร่างให้ | เขียนข้อความใหม่ให้ทั้งช่อง |
| แก้ให้สุภาพ | คงสาระเดิมแล้วปรับเป็นภาษาราชการ |
| สั้นลง | ย่อให้สั้นแต่ครบใจความ |
| ขอคำแนะนำ | ถามรูปแบบ/กฎหมาย ได้คำแนะนำกลับมา |

**ช่องที่มีไอคอน** = ทุกช่องที่ผู้ใช้พิมพ์ข้อความเอง
(`text` `textarea` `email` `date` `number` `integer`)
**ไม่มี** ที่ `select` `multiselect` `checkbox` เพราะสามอย่างนั้นผู้ใช้ "เลือก" ไม่ใช่ "เขียน"

**⚠️ AI ไม่เขียนทับช่องเอง** — ทุกครั้งต้องผู้ใช้กด **"ใส่ในช่องนี้"** เอง
ข้อความที่คนพิมพ์เองยากจะแก้ทิ้งไม่ได้ ถ้าให้ AI เขียนทับเงียบ ๆ

ต่างจาก `/api/chat` ปกติตรงที่ (ส่ง `field` ใน body):

- ใช้ system prompt อีกชุด (`buildFieldSystemPrompt`) — บอกให้แตะช่องเดียว
- **กรอง key ให้เหลือช่องนั้น** แม้โมเดลจะแต่ง key อื่นมา
- **ไม่ merge ทับของเดิม** — คืนค่าเป็น "ข้อเสนอ" ให้ผู้ใช้กดยืนยัน
- **ไม่บันทึกลง Mongo** — เป็นเรื่องชั่วคราวของช่องนั้น
  (ถ้าบันทึกจะไปปนกับรายการ "ประวัติแชท" ของแผง AI ใหญ่)
- ช่องตัวเลข/วันที่ต้องผ่าน `coerce()` ก่อน — AI ตอบ "ประมาณห้าพันบาท"
  แล้ว `Number()` ได้ `NaN` แล้วช่องพังทันที

| ไฟล์ | บทบาท |
|---|---|
| `apps/web/app/studio/FieldAi.tsx` | ปุ่มไอคอน + popover + `coerce()` |
| `apps/web/app/globals.css` | `.fieldbox` · `.fieldai*` |
| `apps/api/src/modules/studio/llm.ts` | `buildFieldSystemPrompt` · `mockFieldAnswer` |
| `apps/api/src/modules/studio/service.ts` | `fieldAdvice()` — คืนข้อเสนอ ไม่ทับ ไม่บันทึก |

```bash
node --env-file=.env tools/test-field-ai-api.mjs   # 14 ข้อ — API ชั้นล่าง
node --env-file=.env tools/test-field-ai.mjs       # 29 ข้อ — หน้าเว็บจริง
```

> **⚠️ ห้ามเดา `id` ของช่องในเทสต์** — `id` เกิดจาก hash ของ `key`
> (`fieldDomId`) เพราะของเดิม `key.replace(/[^\w-]/g, '_')` **ชนกันเมื่อ key เป็นภาษาไทย**
> เพราะ `\w` ของ JavaScript ครอบคลุมแค่ ASCII — `เรื่อง` กับ `สิ่งที่ขอ` ได้ id เดียวกัน
> ทำให้ `<label for>` ชี้ผิดช่อง และ `getElementById` คืนตัวแรกเสมอ
> (เคยเจอเทสต์อ่านค่าผิดช่อง แล้วรายงานว่าฟีเจอร์ไม่ทำงาน ทั้งที่มันทำงาน)
> ทางที่ถูกคือหา input จาก**ปุ่มไอคอนตัวเดียวกับที่กด**เสมอ

> **⚠️ Banner แจ้งเตือนต้องเรนเดอร์ทั้งสองหน้า** — `Studio.tsx` `return` ออกไปก่อนถึงจุดที่
> เรนเดอร์ `<Banner>` ตอนเปิดแม่แบบ ทำให้ `notify()` ทุกครั้งจากหน้าแก้ไข
> (บันทึกช่องแล้ว · AI เติมข้อมูล · เรียก AI ไม่สำเร็จ) ไม่เคยโผล่ให้ผู้ใช้เห็น

### การแชร์และสิทธิ์

เก็บใน `template_access` ผูกกับ templateKey

| สถานะ | ใครแตะได้ |
|---|---|
| ยังไม่มีเอกสารสิทธิ์ | ทุกคนที่ล็อกอิน (ตรงกับพฤติกรรมเดิม — ทุกคนเห็นทุกแม่แบบ) |
| `published` | ทุกคนอ่าน · แก้ตามสิทธิ์ที่ถูกแชร์ให้ |
| `private` | เจ้าของ + ผู้ที่ถูกแชร์เท่านั้น |
| ถูกแชร์เป็น `viewer` | ดูอย่างเดียว |
| ถูกแชร์เป็น `editor` | ดูและแก้ได้ |

**เจ้าของ = คนแรกที่ตั้งค่าการแชร์ของแม่แบบนั้น** (การบันทึกฟอร์มไม่ผูกยึดเจ้าของ
เพราะจะทำให้แม่แบบที่ทุกคนแก้ได้กลายเป็นของคนเดียวโดยไม่ได้ตั้งใจ)
`DELETE /api/access/:key` ล้างทั้งหมด → กลับเป็นเปิดสาธารณแบบเริ่มต้น

### API ของฟีเจอร์นี้

| method | path | ทำอะไร |
|---|---|---|
| `GET` | `/api/llm/status` | provider/model ที่ใช้อยู่ + เหตุผลที่ยังใช้ไม่ได้ |
| `GET` | `/api/form/:key` | ฟอร์มของแม่แบบ (ไม่มี = คืน `fields: []`) |
| `PUT` | `/api/form/:key` | บันทึกฟอร์ม (key ซ้ำ → 422) |
| `POST` | `/api/form/:key/import-tags` | สร้างช่องจากแท็ก `{d.*}` ของไฟล์จริง |
| `DELETE` | `/api/form/:key` | ล้างฟอร์ม → กลับไปใช้ช่องจากแท็ก |
| `GET` | `/api/access/:key` | สิทธิ์ของฉันต่อแม่แบบนี้ |
| `PUT` | `/api/access/:key` | ตั้ง publish/private |
| `POST` | `/api/access/:key/share` | เพิ่มคนเข้าใช้ (`sub` + `role`) |
| `DELETE` | `/api/access/:key/share/:sub` | ถอนสิทธิ์ |
| `DELETE` | `/api/access/:key` | ล้างการตั้งค่าทั้งหมด |
| `POST` | `/api/access/resolve` | สิทธิ์หลายแม่แบบพร้อมกัน (กัน N+1) |
| `GET` | `/api/history/:key` | ใครใช้แม่แบบนี้บ้าง + ฉบับล่าสุด (ไม่คืนค่าที่กรอก) |
| `GET` | `/api/history/:key/mine` | ประวัติของฉันเอง + `data` เพื่อกู้ค่ามาแก้ · `?q=` ค้นทั้งชื่อฉบับและค่าที่กรอก |
| `POST` | `/api/chat` | ให้ AI เติมข้อมูล (เก็บประวัติแชท) |
| `GET` | `/api/chat/sessions` | รายการแชทของฉัน |
| `GET`/`DELETE` | `/api/chat/sessions/:id` | ข้อความทั้งหมด / ลบแชท |
| `GET`/`POST` | `/api/bookmarks` | บุ๊กมาร์กของฉัน |
| `DELETE` | `/api/bookmarks/:key` | เอาบุ๊กมาร์กออก |

### รองรับแค่ `{d.}` โดยเจตนา

ไม่รองรับ `c.` · `t()` · `:convEnum` เพราะ worker ยังไม่ได้ส่ง
`complement` / `translations` / `lang` / `enum` ไป docserver
(ดู `apps/worker/src/docserver.ts` — payload มีแค่ `data` กับ `convertTo`)

### ทำไมอ่านแท็กฝั่งเซิร์ฟเวอร์

`GET /api/templates/:id/tags` แกะ `.docx` (ซึ่งคือ zip) ที่ API
เพราะเบราว์เซอร์แกะเองไม่ได้โดยไม่ลาก library หนักมา
แถมไฟล์ได้ถึง 20 MB ยิงผ่านเน็ตไปให้แก้ทุกครั้งก็ช้าเปล่า

**จุดที่ทำให้พลาด** — Word แบ่งข้อความเป็น run หลายก้อน
ข้อความเดียวกันอาจถูกแบ่งข้าม `<w:t>` (เช่น `{d.` อยู่ run แรก แต่ `ชื่อ}` อยู่ run ถัดไป)
regex บน XML ดิบจะ **พลาดทั้งแท็ก** — `tags.ts` จึงต้องดึงทุก `<w:t>` มาต่อกันก่อนแล้วค่อย regex

### ⚠️ rewrite `/api` คือหัวใจที่ทำให้ไม่ต้องตั้ง CORS

`next.config.mjs` ตั้ง rewrite `/api/*` → `127.0.0.1:4001`
เบราว์เซอร์จึงคุยกับ origin เดียว (`localhost:3000`) เสมอ
cookie session ถูกส่งไปด้วยทุกครั้งโดยไม่ต้องพึ่ง `SameSite=None`
และไม่ต้องเพิ่ม `Access-Control-Allow-Credentials` ที่ฝั่ง API

> **cookie ไม่แยกพอร์ต** — cookie ที่ตั้งที่ `localhost:4001` จะถูกส่งไป `localhost:3000` ด้วย
> นี่คือเหตุผลที่ Casdoor callback ชี้ไป API (:4001) ได้ แล้วผู้ใช้ยังล็อกอินอยู่บน Studio (:3000)
>
> ⚠️ **แต่ host ต้องเหมือนกัน** — `localhost` กับ `127.0.0.1` คือคนละโดเมน
> cookie ที่ตั้งที่ `localhost` จะ**ไม่ถูกส่ง**ไป `127.0.0.1` เข้าเว็บด้วย `localhost:3000` ให้ตรงกันเสมอ

### ⚠️ auth route ไม่ได้อยู่ใต้ `/api`

route คือ `/auth/login` · `/auth/logout` · `/auth/callback` — **ไม่ใช่** `/api/auth/...`
ถ้าเรียกผิดจะโดน auth hook บล็อกเป็น 401 ก่อนถึง router
`next.config.mjs` จึงต้อง rewrite `/auth/*` แยกอีกชั้น

### ⚠️ ห้ามส่ง `content-type` เมื่า request ไม่มี body

Fastify ตอบ 500 ทันทีว่า
`Body cannot be empty when content-type is set to 'application/json'`
ทำให้ **DELETE ทุกครั้งพัง** — `lib/api.ts` เลยตั้ง header เฉพาะตอนที่มี body เท่านั้น

### แถบสถานะเวลาเปลี่ยนหน้า + ช่องคัดลอก URL

`app/components/AppStatus.tsx` ครอบทุกหน้าผ่าน `app/layout.tsx` — ไม่ต้องแก้แต่ละหน้า

| เหตุการณ์ | ผู้ใช้เห็น |
|---|---|
| เริ่มเปลี่ยนหน้า | แถบโหลดบนสุดทันที |
| ช้ากว่า 180 ms | ผ้าคลุมหน้าจอบอกปลายทางว่า "กำลังเปิดหน้า Studio · /studio" |
| ค้างเกิน 15 วินาที | ผ้าคลุมถอดเอง ขึ้นคำเตือน + ปุ่ม **รีเฟรชหน้านี้** (ไม่ทิ้งผู้ใช้ไว้กับหน้าที่กดอะไรไม่ได้) |
| รอเรนเดอร์ (ไม่ใช่เปลี่ยนหน้า) | แถบเดินเหมือนกัน ข้อความมาจาก `useAppBusy()` |
| เจอ error ที่หลุดรอด | แผง URL กางเอง พร้อมข้อความ error |

แถบมุมล่างซ้ายมีปุ่ม **คัดลอก URL** และ **คัดลอกข้อมูลแก้ปัญหา**
(URL + เวลา + เบราว์เซอร์ + ขนาดจอ + error ล่าสุด) — กดซ่อนได้ ค่าจำอยู่ใน `localStorage`

**⚠️ ต้องรู้ — ตำแหน่งชั้นของชิ้นส่วน**

`.urlbar` ตั้ง `z-index` **สูงกว่า** `.veil` โดยตั้งใจ
เพราะตอนหน้าค้าง ผ้าคลุมจะบังหน้าเว็บ — ถ้ามันบังแถบ URL ด้วย
ผู้ใช้จะกดคัดลอก URL ไม่ได้**ตอนที่ต้องการที่สุด** ค่านี้มีเทสต์ครอบไว้แล้ว

**⚠️ ห้ามรัน `next build` ทั้งที่ `next dev` ยังรันอยู่**

ทั้งคู่เขียน `.next` โฟลเดอร์เดียวกัน ผลคือ dev server เสิร์ฟ HTML ได้
แต่ JS chunks ตอบ **404 ทั้งชุด** → หน้าไม่ hydrate → ผ้าคลุมค้างครอบหน้าจอ
(อาการเหมือนเว็บพัง แต่จริงๆ แค่ JS ไม่โหลด)
ถ้าเจออาการนี้ให้ kill dev server แล้ว `rm -r apps/web/.next` แล้วค่อยขึ้นใหม่

### ทดสอบ

```bash
node --env-file=.env tools/test-studio.mjs      # 15 ข้อ ผ่านทั้งหมด
node --env-file=.env tools/test-tags.mjs        # อ่านแท็กจากไฟล์จริง
node --env-file=.env tools/test-nav-status.mjs  # 26 ข้อ — แถบโหลด/ผ้าคลุม/คัดลอก URL
node --env-file=.env tools/shot-nav-status.mjs  # ถ่ายภาพหน้าจอไว้ดู
```

`test-nav-status.mjs` จำลองเครือข่ายช้าผ่าน CDP
เพื่อทดสอบช่วงที่ "หน้าค้าง" ซึ่งเกิดจริงเฉพาะตอนเน็ตช้า — ถ้าไม่จำลองจะไม่มีวันเจอ

### หน้าเว็บทนทานต่อการที่ API ล่มชั่วคราว

อาการเดิม: ตอน Fastify กำลังรีสตาร์ท ผู้ใช้เจยกแถบแดงยาว ๆ ว่า
`เชื่อมต่อ API ไม่สำเร็จ — ได้ 500 Internal Server Error แทน JSON (Internal Server Error…)`
ทั้งที่รอ 2 วินาทีก็หายเอง (`app/studio/lib/api.ts` → `call()`)

**ทำไมได้ 500 ทั้งที่ Fastify ไม่ได้ตอบอะไรเลย** — ตอนนั้นไม่มี request ไหนไปถึง Fastify ใน log
เพราะ `next.config.mjs` rewrite `/api/*` ไป `127.0.0.1:4001` แต่ตอนนั้นไม่มีอะไรฟังพอร์ต
Next จึงตอบกลับเองด้วย text ธรรมดา (`next/dist/server/base-server.js`):

```js
res.statusCode = 500
res.body('Internal Server Error').send()   // ← ไม่ใช่ JSON
```

**แก้ที่ `call()` — ลองใหม่เอง ไม่ต้องรีเฟรช**

```ts
const RETRY_DELAYS = [400, 1100, 2400]   // รวม ~3.9 วินาที
```

กติกาที่ทำให้ปลอดภัยแม้กระทั่งกับ `POST` ที่สร้างเอกสาร — **ลองซ้ำเฉพาะกรณีที่บอกได้แน่นอน
ว่า Fastify ยังไม่ได้ประมวลผลคำขอนั้น** ไม่งั้นจะสร้างงานซ้ำ

| ลองซ้ำ | ไม่ลองซ้ำ |
|---|---|
| `fetch` throw (ต่อไม่ได้) | 500 ที่เป็น **JSON** จาก Fastify = ของจริงที่พัง ลองซ้ำจะกลบอาการ |
| 502 / 503 / 504 | ทุกอย่างอื่น |
| ตอบไม่ใช่ JSON (proxy ตอบแทน) | |

**⚠️ API สะดุดทุกครั้งที่รัน `npm run typecheck`** — เป็นเรื่องถูกต้อง ไม่ใช่บั๊ก
`@docgen/shared` ถูก import เป็น `packages/shared/dist/index.js` (`package.json` → `main`)
`tsx --watch` จึงจับตาไฟล์ `.js` ใน `dist` → `tsc -b` เขียนทับ → API รีสตาร์ท
การเขียนทับ `dist` คือสิ่งที่ทำให้โค้ดใหม่มีผลกับ service ที่รันอยู่จริง

แก้ `tsc -b --noEmit` ไม่ได้ — โปรเจกต์นี้ใช้ project references
TS ตอบ `TS6310: Referenced project may not disable emit` (ทดสอบแล้ว TypeScript 5.9.3)
ถ้าแก้ `packages/shared` แล้วอยากให้ service อื่นเห็้ทันที ให้รัน watcher ของ shared คู่ไปด้วย:

```bash
npm run dev:shared    # tsc -b --watch packages/shared → API/worker รีสตาร์ทเองเมื่อ shared เปลี่ยน
```

### ⚠️ rate limit เดิม 100/นาที แคบเกินไปสำหรับ Studio

เจอระหว่างทดสอบ — API ตอบ `429` ทั้งที่ผู้ใช้ไม่ได้ทำอะไรผิด
เปิดหน้า Studio ครั้งเดียวยิงราว **6 request** (แม่แบบ · ประวัติ · chat · ที่แชร์กับฉัน · สิทธิ์ · LLM)
ผู้ใช้ที่รีเฟรชสัก 5 ครั้งก็ชนเพดาน 100 แล้ว

| ตัวแปร | เดิม | ตอนนี้ |
|---|---|---|
| `RATE_LIMIT_MAX` | ฮาร์ดโค้ด 100 | **600** (ตั้ง `0` = ปิด) |
| `RATE_LIMIT_WINDOW_MS` | ฮาร์ดโค้ด 60000 | **60000** |

`/api/health` อยู่ใน `allowList` — เป็น endpoint ที่ระบบตรวจสุขภาพภายนอกเรียกซ้ำ
ถ้านับรวม การมี monitor วิ่งอยู่สักตัวก็กินโควตาของผู้ใช้จนได้ 429
(มีเทสต์ยืนยัน: ตอนโควตาหมดแล้ว `/api/health` ยังตอบ 200)

> ⚠️ ใน `@fastify/rate-limit` v11 `allowList` อยู่**ระดับบนสุด** ไม่ใช่ใน `config`
> และรับเป็นฟังก์ชัน `(req, key)` ได้ — ตัว plugin ไม่มีออปชัน `routes`

### ⚠️ 429 ไม่ได้ถูก retry — ผู้ใช้กดซ้ำไม่ได้เลย

`call()` ใน `apps/web/app/studio/lib/api.ts` ครอบ retry ไว้เฉพาะ 502/503/504
(สถานะที่แปลว่าเซิร์ฟเวอร์ "ยังไม่ได้ประมวลผล" คำขอ → ทำซ้ำปลอดภัย)
**429 เลยหลุดไปโดยไม่รอ** ทั้งที่เซิร์ฟเวอร์ส่ง `Retry-After` กลับมาแล้ว

อาการที่ผู้ใช้เจอ: กดบุ๊กมาร์กแล้วขึ้น *"ยิงบ่อยเกินไป"* แล้วกดซ้ำก็ไม่ได้

แก้โดยจัดการ 429 **แยกออกมา** ไม่ยัดเข้า `isTransientStatus` เพราะนั่นหมายถึง
"ยังไม่ได้ประมวลผล" ซึ่ง 429 ไม่ใช่ (ถูกปฏิเสธก่อนถึง handler ทำซ้ำแล้วไม่มีผลข้างเคียง):

| เวลาที่เซิร์ฟเวอร์บอกให้รอ | ทำอะไร |
|---|---|
| ≤ 12 วินาที | รอตามนั้น + 0.3 วิ แล้วลองใหม่ **1 ครั้ง** (ผู้ใช้ไม่ต้องรีเฟรช) |
| > 12 วินาที / ไม่บอก / อ่านไม่ออก | ไม่รอ — ขึ้น *"โควตาจะเต็มใหม่ใน N วินาที — กดซ้ำได้เลย ไม่ต้องรีเฟรช"* |

อ่านเวลาจาก `Retry-After` ถ้าไม่มี fallback ไปที่ `X-RateLimit-Reset`
เพดาน 12 วินาทีมีไว้กันหน้าจอค้างเกือบนาทีโดยที่ผู้ใช้ไม่รู้ว่าเกิดอะไร

```bash
node --env-file=.env tools/test-rate-limit-ui.mjs   # 9 ข้อ — 429 ฝั่งหน้าเว็บ
node --env-file=.env tools/test-rate-limit.mjs      # 9 ข้อ — 429 ฝั่งเซิร์ฟเวอร์
```

> ⚠️ `test-rate-limit-ui.mjs` ตอบ 429 ปลอมด้วย CDP `Fetch.fulfillRequest`
> ไม่ยิงจริงจนโควตาหมด — รุ่นแรกยิงจริงแล้วไปตีน้ำนักผู้ใช้เองระหว่างเทสต์
> (ผู้ใช้เปิดหน้าเว็บแล้วเจอ 429 ทันทีโดยไม่ได้ทำอะไรผิด)

### ทดสอบการทนทาน

```bash
node --env-file=.env tools/test-api-retry.mjs   # 8 ข้อ
node --env-file=.env tools/test-rate-limit.mjs  # 9 ข้อ
```

ใช้ CDP `Fetch` domain แยก request `/api/*` แบบสองแบบ —
`Fetch.failRequest` (เหมือนต่อไม่ได้) และ `Fetch.fulfillRequest` (ตอบ 500 text ธรรมดา
ตรงกับอาการที่เจอจริง) จึงไม่ต้องฆ่า API จริงและไม่รบกวนผู้ใช้

> **⚠️ กับดักตอนเขียนเทสต์นี้** — ต้องปิด cache ด้วย `Network.setCacheDisabled`
> เพราะเบราว์เซอร์ cache `GET /api/*` ได้ (Fastify ไม่ได้ส่ง `cache-control`)
> รอบก่อนหน้าที่ API ปกติจะทำให้รอบถัดไปไม่ออกเน็ต → ตัดได้ 0 ครั้ง
> แต่เทสต์กลับ **"ผ่าน"** ทั้งที่ไม่ได้ทดสอบอะไรเลย
>
> และต้องนับช่วงที่ปล่อยให้ล้มเหลว **จากคำขอแรกที่โดนตัด** ไม่ใช่จากตอนกด reload
> เพราะหน้าเว็บ dev โหลดช้าแตกผัน (ปิด cache แล้วดึง JS ใหม่หมด) → ช่วงเวลาที่ตั้งไว้
> หมดไปก่อนหน้าจะยิง API สักครั้ง

## ตัวอย่างเอกสารอยู่ครึ่งขวา · ไม่ต้องเลื่อนหา

**เดิม** ตัวอย่างเอกสารถูกวาง**ใต้**ฟอร์มในคอลัมน์ซ้ายเดียวกัน
ฟอร์มยิ่งยาว ตัวอย่างยิ่งถูกดันลงใต้ขอบจอ → ผู้ใช้ต้องเลื่อนหน้าจอถึงจะเห็น

| | ตำแหน่ง |
|---|---|
| ครึ่งซ้าย | ฟอร์ม (บน) · AI ช่วยกรอก (ล่าง) |
| ครึ่งขวา | **ตัวอย่างเอกสาร** — `position: sticky` เลื่อนฟอร์มยาวแค่ไหนก็ยังอยู่ในสายตา |

จอแคบกว่า 1080px ซ้อนเป็นคอลัมน์เดียวอัตโนมัติ (ตัวอย่างลงใต้ฟอร์มแบบเดิม)

| ไฟล์ | บทบาท |
|---|---|
| `apps/web/app/globals.css` | `.editor-split` (2 คอลัมน์) · `.editor-col` · `.editor-preview` (sticky) · `.docpage` |
| `apps/web/app/studio/TemplateEditor.tsx` | โครงหน้าแท็บฟอร์ม · วัด `--editor-top` |
| `apps/web/app/studio/DocumentPreview.tsx` | พื้นที่รูปหน้าเอกสารใช้ `.docpage` · รับ `toolbarExtra` มาต่อท้ายแถบซูม |

### การ์ดพรีวิวสูงไม่เกินจอ

เอกสารหลายหน้ามีแถบรูปย่อ `.docstrip` สูง ~200px อยู่**ภายใน**การ์ด บวก `.docpage` 620px
แล้วการ์ดสูง 919px เริ่มที่ y=145 → ล้นถึง 1064 ทั้งที่จอสูง 1000px
ผู้ใช้ต้องเลื่อนหน้าจอถึงจะเห็นท้ายเอกสาร ทั้งที่คอลัมน์นี้ `sticky` อยู่แล้ว

| ชิ้นส่วน | ก่อน | หลัง |
|---|---|---|
| แถบเครื่องมือ `.doctools` | 63px | คงที่ |
| พื้นที่รูป `.docpage` | 620px (ตายตัว) | **ยืด/หดตามที่ว่าง** (`flex: 1`, `max-height: none`) |
| แถบรูปย่อ `.docstrip` | 201px | คงที่ |
| คำอธิบายใต้รูป | 33px | คงที่ |
| **รวม** | **919px (ล้นจอ)** | **775px (พอดี)** |

คอลัมน์ขวาตอนแท็บพรีวิว (`.editor-col--preview`) เป็น flex สูงไม่เกิน
`min(100vh - 32px, 100vh - var(--editor-top) - 8px)`

> ⚠️ **CSS อ่านตำแหน่งของตัวเองไม่ได้** — `--editor-top` ต้องวัดใน `TemplateEditor`
> คอลัมน์เป็น `sticky; top: 16px` แต่ตอน `scroll = 0` ยังอยู่ใต้หัวหน้าเว็บ (~145px)
> ถ้า cap แค่ `100vh - 32px` จะยังล้นจอตอนยังไม่เลื่อน (วัดได้ 968px ที่ y=145)
> วัดใหม่เมื่อความสูง `document.body` เปลี่ยน (เช่นมีแถบแจ้งข้อผิดพลาดโผล่)

> ⚠️ **cap เฉพาะแท็บพรีวิว** — แท็บประวัติ/ช่องฟอร์มยาวมาก ถ้ามาจำกัดความสูงที่คอลัมน์
> ผู้ใช้จะต้องเลื่อนอ่านในกล่องแคบ ๆ แทนที่จะเลื่อนหน้า จึงใส่คลาสเงื่อนไขเฉพาะ `pane === 'preview'`

### พรีวิวย่อให้เห็นทั้งหน้ากระดาษ (fit-to-page)

เดิมกระดาษคำนวณจาก**ความกว้าง**อย่างเดียว (`host.clientWidth`)
พอกล่องพรีวิวสูงไม่ถึงสัดส่วน A4 (สูงกว่ากว้าง ~1.41 เท่า) กระดาษก็ล้นลง
→ มี scrollbar ทั้งสองทาง ผู้ใช้**เห็นไม่ครบหน้า** แล้วตัดสินใจไม่ได้ว่าเอกสารหน้าตาย

`DocumentPreview.tsx` คำนวณ `fitScale = Math.min(availW / widthPt, availH / heightPt)`
(contain = ทั้งกว้างและสูง) จากขนาดจริงของกล่อง `.docpage` ที่ `ResizeObserver` รายงาน

| สิ่งที่เปลี่ยน | ก่อน | หลัง |
|---|---|---|
| ขนาดกระดาษ | กว้างเต็มกล่อง ล้นแนวตั้ง | `contain` — เห็นครบทั้งหน้า ไม่มี scrollbar |
| ตัวเลขบนแถบซูม | `zoom × 100` (เช่น 100% ทั้งที่จริงย่ออยู่ 64%) | **เปอร์เซ็นต์จริงเทียบกระดาษจริง** |
| ปุ่มรีเซ็ตซูม | "รีเซ็ต" (กดซ้ำทีละขั้น) | **"พอดีหน้า"** — กลับพอดีกล่องในคลิกเดียว (`zoom-fit`) |
| ปุ่ม −/+ | ไม่มีป้ายกำกับ | มี `title` + `aria-label` (กดด้วยการอ่านหน้าจอได้) |

> ⚠️ **กล่องพรีวิวต้องมีความสูงตายตัว มิฉะนั้นกระดาษย่อตัวเอง**
> `.editor-col--preview` เคยใช้ `max-height` → คอลัมน์สูงตามเนื้อหา → `.docpage` สูงตามกระดาษ
> → กระดาษย่อก็ทำให้กล่องย่อก็ทำให้กระดาษย่ออีก (วงจรป้อนกลับ) แล้วหยุดที่กระดาษจิ๋ว
> เลยเปลี่ยนเป็น `height` และให้ `.docpage` บนจอแคบมี `height` ตายตัวด้วย
>
> ⚠️ **ห้ามมีเพดานความกว้างต่ำ** (เดิมใช้ `Math.max(160, …)`)
> กล่องสั้นคำนวณได้กระดาษ ~115px กว้าง แต่เพดาน 160px ดันให้สูงเกินกล่อง
> → scrollbar แนวตั้งกลับมา และกล่องตรึงที่กระดาษเล็ก ๆ จากวงจรป้อนกลับ

```bash
node --env-file=.env tools/test-fit-page.mjs   # 26 ข้อ
```

> ⚠️ **เกณฑ์ "canvas วาดเสร็จแล้ว" ต้องมาจาก `tools/lib/canvas-drawn.mjs`**
> หลายสคริปต์เขียน `c.width > 400 && c.height > 400` มานาน แล้วพังทั้งชุดตอนกระดาษถูกย่อจริง
> (`<canvas>` ที่ยังไม่วาดมีค่าเริ่มต้น 300×150 → ใช้**ความสูง > 200** เป็นเกณฑ์แทน)

### ปุ่มพิมพ์รูปเอกสาร

ปุ่ม 🖨 อยู่ในแถบซูม ทางซ้ายของปุ่มดาวน์โหลด · พิมพ์ **ทุกหน้า** ไม่ใช่แค่หน้าที่เลือกอยู่บนจอ

⚠️ **ต้องเรนเดอร์ใหม่ที่ความละเอียดสำหรับพิมพ์ ห้ามแอบเอา canvas ที่วาดไว้บนจอ**
canvas บนจอถูกย่อให้พอดีคอลัมน์ (วัดได้ 634px) → พิมพ์แล้วเป็นเส้นหยัก
ใช้ `pdf.toPng(n, 2)` แทน → A4 ≈ 1190px ≈ 144 dpi พอกับกระดาษจริง

⚠️ **ต้องรอ `img.decode()` ทุกหน้าให้เสร็จก่อน `window.print()`**
ไม่งั้นเบราว์เซอร์พิมพ์ออกมาหน้าว่าง ๆ (รู���ยังไม่ถูกถอดรหัส)

⚠️ **กระดาษพิมพ์ต้องอยู่ใต้ `<body>` โดยตรง** จึงใช้ `createPortal`
CSS ตอนพิมพ์ซ่อนแอปด้วย `body > *:not(.printsheet)` — ถ้ากระดาษซ้อนอยู่ใต้ต้นไม้ของแอป
จะถูกซ่อนไปด้วยและได้กระดาษว่าง · ตอนออนไลน์ต้อง `display: none` ไม่งั้นจะกินความสูงเพจ

```css
@media print {
  body > *:not(.printsheet) { display: none !important; }
  .printsheet { display: block !important; }
  .printsheet img { width: 100%; break-after: page; page-break-after: always; }
  @page { margin: 0; }
}
```

> ใช้ `display: none` ไม่ใช่ `visibility: hidden` — visibility ยังกินพื้นที่
> แล้วจะได้กระดาษเปล่าหลายหน้าต่อท้าย

> ⚠️ **ข้อจำกัด** ทุกหน้าต้องถูกถือไว้ในหน่วยความจำพร้อมกันตอนกดพิมพ์
> เอกสารยาวหลายสิบหน้าจะหนัก ถ้าต้องพิมพ์เฉพาะบางหน้าให้ใช้ช่องเลือกหน้าในเมนูดาวน์โหลด
> แล้วเลือกช่วงหน้าในกล่องโต้ตอบพิมพ์ของเบราว์เซอร์

```bash
node --env-file=.env tools/test-print-preview.mjs   # 18 ข้อ
```

> ⚠️ **ตัวแทน `window.print()` ในเทสต์ต้องเป็นฟังก์ชันซิงโครนัส**
> โค้ดแอปเรียก `print()` แล้วล้างกระดาษทันทีใน `finally` ถ้าตัวแทนเป็น async
> จะอ่านกระดาษทันทีหลังแอปล้างเสร็จ → ได้ 0 รูปเสมอ
>
> ⚠️ **อ่านไบต์ดิบจาก blob ในตัวแทนไม่ได้** — `responseType` ตั้งบน sync XHR ไม่ได้
> (InvalidAccessError) เทสต์นี้จึงตรวจว่า "รูปไม่ว่าง" แทน ด้วยการนับพิกเซลที่ไม่ใช่สีขาว
> เกณฑ์ > 0.05% (หน้าหัวกระดาษที่มีข้อความน้อยวัดได้จริงแค่ 0.3% · กระดาษว่างได้ 0.0%)
>
> ⚠️ **อย่าเขียน regex ตรวจ CSS ที่คาดว่า minifier จะตัด `;` ทิ้ง**
> lightningcss เก็บ `;` ท้ายค่าไว้ (`@page{margin:0;}`) ใช้ `/@page\s*\{[^}]*margin:\s*0/` แทน

### ปุ่มดาวน์โหลดเป็นไอคอนในแถบซูม

**เดิม** หัวการ์ดการ์ดพรีวิวมี `h2` "ตัวอย่างเอกสาร" + `<select>` เลือกรูปแบบ + ปุ่ม "ดาวน์โหลด"
`<select>` กว้างเท่าตัวเลือกที่ยาวที่สุด (~290px) และถูก flex ย่อยจน `select` กับปุ่ม
ตกคนละบรรทัด → หัวการ์ดสูงเปล่า ๆ

**ใหม่** ถอดหัวการ์ดออกทั้งก้อน เหลือแค่แถบซูมบรรทัดเดียว
ปุ่มดาวน์โหลดเป็นไอคอนวงกลมต่อท้ายแถบซูม (ขวาสุด) · คลิกแล้วค่อยโผล่เมนูให้เลือกรูปแบบ

| รูปแบบ | ทำงานยังไง | เลือกหน้าได้ |
|---|---|---|
| PDF | เรนเดอร์ใหม่ผ่าน worker → ดาวน์โหลด → ตัดหน้าที่เลือกด้วย pdf-lib → ลบเอกสารชั่วคราว | ✅ |
| Word (.docx) | เหมือนกัน — **ต้องเรนเดอร์ใหม่** เพราะตัวอย่างบนจอเป็น PDF ฉบับเดียว DOCX ไม่เคยถูกสร้าง | ❌ |
| รูปภาพ (.png) | ตัดจาก `canvas` ที่พรีวิวโหลดไว้แล้ว หน้าที่เลือกแยกไฟล์ ไม่ต้องเรนเดอร์ใหม่ | ✅ |
| ZIP | รวมรูปทุกหน้าที่เลือกเป็นไฟล์เดียว (fflate, `level: 0`) | ✅ |

**ทำไมต้องเรนเดอร์ใหม่ทุกครั้ง** — ถ้าใช้ไฟล์ที่ผู้ใช้เพิ่งแก้ JSON ไปแล้ว ผลที่ได้จะเป็นไฟล์เก่า
เรนเดอร์ใหม่ทำให้ไฟล์ที่ดาวน์โหลดตรงกับแม่แบบ + JSON ณ ตอนกดเสมอ

#### เลือกหน้า

พิมพ์ช่วงหน้าได้ในช่องด้านบนของเมนู: `1-3, 5, 8-` · ค่าว่าง = ทุกหน้า
ปุ่มลัด: ทุกหน้า · หน้าแรก · ทั้งเล่ม · **ไม่เอาปก** (ตัดหน้า 1 ออก — ใช้ตอนเอกสารมีหน้าปกคั่น)

พิมพ์ผิดแล้วขึ้นเหตุผลตรง ๆ (`“99” เอกสารมีแค่ 3 หน้า`) และ**กดดาวน์โหลดไม่ได้**
แทนที่จะเดาเงียบ ๆ แล้วได้ไฟล์ผิด

**ทำไมใช้ช่องพิมพ์ ไม่ใช่ชิปรายหน้า** — เอกสารราชการมีหลายร้อยหน้า
ชิปหนึ่งร้อยอันกินพื้นที่ในป๊อปโอเวอร์ ซึ่งกดยากกว่าพิมพ์ `1-3` หนึ่งครั้ง

**ทำไม Word ตัดหน้าไม่ได้** — Word จัดหน้าใหม่เองตอนเปิด (ขึ้นกับฟอนต์เครื่องผู้รับ)
ตัดหน้าในไฟล์ไปก็ไม่มีผล → พอชี้ที่ Word จะขึ้นข้อความบอกตรง ๆ แทนที่ปล่อยให้เลือกแล้วไม่เกิดอะไร

**ทำไม ZIP ใช้ `level: 0`** — เนื้อหาคือ PNG ที่บีบอัดมาแล้ว บีบซ้ำไม่ได้ผล
แต่เพิ่มเวลา CPU และหน่วยความจำตอนแตก ZIP (canvas 20 หน้า @2x กินหลายสิบ MB อยู่แล้ว)

**ตัดหน้า PDF ทำฝั่งเบราว์เซอร์ ไม่ยิง API ใหม่** — งานเรนเดอร์ถึงเสร็จแล้ว ไฟล์อยู่ในมือ
การตัดหน้าเป็นงานจัดโครงสร้างเอกสารล้วน ๆ ถ้ายิง API ใหม่ = เพิ่ม round-trip เพิ่ม worker เพิ่มจุดพัง

| ไฟล์ | บทบาท |
|---|---|
| `apps/web/app/studio/DownloadMenu.tsx` | ไอคอน + popover เลือกรูปแบบและหน้า (`.dl*`) |
| `apps/web/app/studio/lib/pages.ts` | `parsePageRange()` + `describeSelection()` + `pageSuffix()` |
| `apps/web/app/studio/lib/pdf-pages.ts` | `pickPdfPages()` — ตัดหน้าด้วย pdf-lib |
| `apps/web/app/studio/lib/zip.ts` | `makeZip()` — รวมเป็น ZIP ด้วย fflate |
| `apps/web/app/globals.css` | `.dl` · `.dl__btn` · `.dl__pop` · `.dl__opt` · `.dl__range*` |

```bash
npx.cmd tsx tools/test-page-range.mjs       # 31 ข้อ — ตัวแยกช่วงหน้า (ล้วน ไม่ต้องมีเบราว์เซอร์)
node --env-file=.env tools/test-download-pages.mjs   # เลือกหน้า · ZIP · ตัด PDF จริง
```

### ไม้บรรทัด (ruler) บนพรีวิว

กดปุ่ม **ไม้บรรทัด** ในแถบเครื่องมือ → ไม้บรรทัดขึ้นเหนือหน้ากระดาษและด้านซ้าย
กดปุ่มหน่วย **ซม. / นิ้ว** เพื่อสลับ · จำค่าไว้ใน `localStorage` ข้ามการรีเฟรช

| ไฟล์ | บทบาท |
|---|---|
| `apps/web/app/studio/Ruler.tsx` | วาดจุดขีดเป็น SVG (ทั้งแนวนอนและแนวตั้ง) |
| `apps/web/app/studio/lib/ruler.ts` | `pageUnits()` · `pickStep()` · `ticks()` · `formatTick()` |
| `apps/web/app/studio/lib/pdf.ts` | `pageSize(n)` — ขนาดหน้าเป็น pt จาก PDF |
| `apps/web/app/globals.css` | `.docstage*` · `.rul*` · `.rulbtn*` |

```bash
npx.cmd tsx tools/test-ruler.mjs          # 27 ข้อ — จุดขีด/หน่วย (ล้วน)
node --env-file=.env tools/test-ruler-ui.mjs     # 44 ข้อ — ตรงขอบกระดาษจริง
```

> **⚠️ `0` ของไม้บรรทัดต้องตรงขอบกระดาศเป๊ะ** ไม่งั้นผู้ใช้วัดผิด
> เทสต์วัด `getBoundingClientRect()` เทียบทั้ง 4 ขอบ ต้องต่างกัน ≤ 1px
>
> **⚠️ ห้ามวัดความกว้างกระดาษจากพ่อของ canvas** — พ่ออยู่ใน grid ที่กว้างตาม canvas
> ถ้า canvas กว้างตามพ่อ ได้วงจรที่ไม่มีวันนิ่ง (หน้าเว็บกระพริบตอนซูม)
> ต้องวัดจาก `.docpage` ที่อยู่นอก grid
>
> **⚠️ ห้าม `await` คาบระหว่าง `setPdf` กับ `setLoading(false)`** — React จะแทรกรอบเรนเดอร์ตรงนั้น
> โดยที่ยัง `loading` → component คืนหน้า "กำลังเปิดเอกสาร…" ที่ไม่มี `.docpage`
> → effect ที่เรียก `drawMain` เจอ `pageRef.current === null` แล้ว return
> → พอ `setLoading(false)` ทำให้หน้าเต็ม `drawMain` ไม่ถูกเรียกซ้ำ (deps ไม่เปลี่ยน)
> → canvas ค้างเป็น 300×150 ค่าเริ่มต้นของ `<canvas>` ไม่เคยวาด
> เคยเจอบั๊กนี้จากการใส่ `await pageSize()` ไว้ผิดที่

> **⚠️ เช็คว่า canvas วาดแล้วด้วย `attrW/attrH` ไม่ใช่ความกว้างที่เห็น**
> `<canvas>` ที่ยังไม่เคยวาดมีค่าเริ่มต้น 300×150
> ถ้าเช็คแค่ `width > 200` เทสต์จะผ่านทั้งที่หน้าว่างเปล่า (เคยเจอ)

> **⚠️ ขนาดกระดาษบนจอต้องมาจาก `ResizeObserver` ไม่ใช่ค่าที่วัดครั้งเดียว**
> `Ruler` คืน `null` ถ้าความกว้าง/สูงเป็น 0
> ตอนเปิดไม้บรรทัดที่บันทึกไว้หลังรีเฟรช เลย์เอาต์ยังไม่ทันนิ่ง วัดแล้วได้ 0
> → ไม้ไม่โผล่จนกว่าจะซูมหรือสลับหน่วย (เคยเจอ)
> `ResizeObserver` รายงานขนาดจริงทุกครั้งที่เปลี่ยน รวมครั้งแรกที่ `observe`
>
> **⚠️ เทสต์ต้องรอ `.rul--h` ไม่ใช่แค่ canvas โผล่**
> pdf.js ตั้ง `canvas.width` ตั้งแต่ต้น ก่อนที่ React จะ commit `stage` เสมอ
> ถ้าเช็คไม้ทันทีที่ canvas ปรากฏ เทสต์จะแพ้เสมอแม้แอปทำถูก (เคยเจอ)

> **⚠️ เทสต์ที่ต้องการเอกสารหลายหน้าจะ "ข้าม" ไม่ใช่ "ผ่าน"**
> ถ้าแม่แบบที่เปิดมีหน้าเดียว ข้อตรวจ ZIP/ตัด PDF จะขึ้น `~ ข้าม` พร้อมเหตุผล
> และไม่ถูกนับเป็นผ่าน — การรายงานว่า "ผ่าน" ทั้งที่ไม่ได้ตรวจคือการโกหกตัวเอง

> **⚠️ ต้องเช็ก `elementFromPoint` ก่อนคลิกในเทสต์** — ป๊อปโอเวอร์เป็น `position: absolute`
> อาจโดนบังด้วยคอลัมน์ข้างเคียง ถ้าคลิกที่พิกัดแล้วไม่ตรง element จะกดไม่ติด
> แล้วเทสต์จะรายงานว่าปุ่มเสีย ทั้งที่โค้ดถูก

> **⚠️ เทสต์ hover ต้องย้ายเมาส์ออกก่อนแล้วค่อยกลับเข้า** — ถ้ายิง `mouseMoved` ไปยังจุดเดิม
> เบราว์เซอร์จะไม่ยิง `mouseover` ซ้ำ → React ไม่อัปเดต state
> เคยเข้าใจผิดว่าเป็นบั๊ก UI ทั้งที่เมาส์จริง hover ได้ปกติ
> (เทสต์แยก `:hover` ออกจาก state เพื่อบอกได้ว่าเป็นฝั่งเบราว์เซอร์หรือฝั่งแอป)

> **⚠️ อย่ารัน `test-rate-limit.mjs` ติดกับสคริปต์อื่นในหน้าต่างเดียวกันทันที**
> มันยิงจนล้นขีดจำกัด (600 req/นาที) ตามที่ตั้งใจทดสอบ
> สคริปต์ถัดไปจะได้ 429 ทั้งชุด แล้วรายงานว่าฟีเจอร์พัง ทั้งที่ไม่ได้แตะฟีเจอร์เลย
> `test-field-ai-api.mjs` มีตัวรอให้แล้ว แต่สคริปต์อื่นควรเว้นหน้าต่างประมาณหนึ่งนาที

> **⚠️ สคริปต์ที่ยิง API เยอะ ๆ ต้องเว้นกันด้วย** — ถ้ารันชุดใหญ่ต่อกันโดยไม่หยุด
> สคริปต์ท้าย ๆ จะได้ 429 แล้วพังกลางคัน (exit=1 โดยไม่มีบรรทัดสรุปให้เห็น)
> เคยเจอ `test-template-file` กับ `test-my-history` พังแบบนี้ตอนรันเป็นชุด
> แต่รันเดี่ยวผ่านหมด (23/23 และ 18/18) — ให้ `Start-Sleep -Seconds 20` ระหว่างสคริปต์

### ⚠️ กล่องข้อความใต้เมนูดาวน์โหลดห้ามสูงตามข้อความ — มันดันปุ่มออกจากใต้เคอร์เซอร์

ข้อความใน `.dl__hint` เปลี่ยนตามตัวที่เมาส์ชี้ และ**ความยาวไม่เท่ากัน**

| ตอนชี้ | ข้อความ | บรรทัด |
|---|---|---|
| PDF / รูป / ZIP | `จะได้ 3 หน้า` | 1 |
| Word | `Word ไม่ใช้การเลือกหน้า — Word จัดหน้าใหม่ตอนเปิด` | 2 |

ถ้ากล่องนี้สูงตามข้อความ → พอชี้ `Word` มันจะสูงขึ้น 1 บรรทัด ดัน `.dl__grid` ลงไป
และ **ปุ่มที่เมาส์ชี้เลื่อนออกจากใต้เคอร์เซอร์ทันที**
ผู้ใช้ที่กำลังจะกด ZIP อาจไปกดรูปภาพแทน

จับได้เพราะ `test-download-pages` ยิงเมาส์ไปที่กลางปุ่ม Word แล้วอ่าน `:hover` ได้ `ZIP`

> หลักฐาน: วัดตอนชี้ → `Word` อยู่ที่ `y=386 h=55` (กลาง = 413) แต่ `:hover` ไปตกที่ `ZIP`
> เพราะหลัง `mouseenter` React เปลี่ยนข้อความ → ตารางเลื่อนลง → ใต้เคอร์เซอร์เดิมกลายเป็น ZIP

แก้ที่ `globals.css` — `.dl__hint` ต้องมี `min-height` ตลอด (ไม่ใช่สูงตามข้อความ)

**⚠️ ต้องกำหนดขนาด SVG ในทุกจุดที่ใช้** — SVG ไม่มี `width`/`height` เอง
ถ้ากำหนดแค่ `.dl__btn svg` ไอคอนในหัวเมนูจะขยายเต็มความกว้างทันทีที่กดเปิด
ต้องมี `.dl__title svg` ด้วย

**⚠️ `.docpage` คือแค่พื้นที่รูป ไม่ใช่ทั้งการ์ด** — ถ้าจะวัดหรือเลือกแถบเครื่องมือ
ให้ใช้ `.doctools` (คลาสที่ใส่ไว้เฉพาะแถบ) ไม่ใช่ `.editor-preview` ที่ครอบทั้งการ์ด

```bash
node --env-file=.env tools/test-ruler-ui.mjs       # 45 ข้อ
node --env-file=.env tools/test-preview-layout.mjs  # 34 ข้อ
```

> **⚠️ ห้ามคลิกปุ่มไอคอนด้วย `element.click()`** — มันยิงแค่ event `click`
> ไม่ยิง `mousedown` ซึ่งเป็น event ที่โค้ดใช้ปิดเมนูเมื่อคลิกที่อื่น
> เทสต์ต้องปล่อยเมาส์จริงผ่าน `Input.dispatchMouseEvent` และค้นปุ่มด้วย selector
> ไม่ใช่ `textContent` (ปุ่มไอคอนไม่มีข้อความ)

> **⚠️ เทสต์นี้เปิดแม่แบบที่ `pickTemplate` เลือก ไม่ใช่แถวแรกในตาราง**
> เคย seed ช่องกรอกให้แม่แบบหนึ่งแต่คลิกเปิดอีกแม่แบบหนึ่ง (`table tbody tr td button.ghost`)
> → รันเดี่ยวผ่าน แต่รันเป็นชุดแล้วแถวแรกเปลี่ยนเป็นแม่แบบหลายหน้า
> → กล่องพรีวิวสูง 1064px ล้นจอ 1000px แล้วเทสต์ตก

**⚠️ การ์ดพรีวิวต้องสูงไม่เกินจอ — `--editor-top`**

เดิมการ์ดสูงตามเนื้อหา เอกสารหลายหน้ามีแถบรูปย่อ `.docstrip` สูง ~200px อยู่**ภายใน**การ์ด
บวก `.docpage` 620px แล้วเกินจอ (วัดได้ 919px เริ่มที่ y=145 → ล้นถึง 1064)
ทั้งที่คอลัมน์นี้ `sticky` อยู่แล้ว ผู้ใช้จึงต้องเลื่อนหน้าจอถึงจะเห็นท้ายเอกสาร

แก้ที่ `globals.css` — คอลัมน์ขวาตอนแท็บพรีวิว (`--preview`) เป็น flex สูงไม่เกิน
`min(100vh - 32px, 100vh - var(--editor-top) - 8px)` แล้วให้ `.docpage` เป็นชิ้นที่ยืด/หด

> ⚠️ **CSS อ่านตำแหน่งของตัวเองไม่ได้** — ต้องวัดใน `TemplateEditor` แล้วส่งเป็น `--editor-top`
> คอลัมน์เป็น `sticky; top: 16px` แต่ตอน `scroll = 0` ยังอยู่ใต้หัวหน้าเว็บ (~145px)
> ถ้า cap แค่ `100vh - 32px` จะยังล้นจอตอนยังไม่เลื่อน (วัดได้ 968px ที่ y=145)
> วัดใหม่ทุกครั้งที่ความสูง `document.body` เปลี่ยน (เช่นมีแถบแจ้งข้อผิดพลาดโผล่)

> ⚠️ **cap เฉพาะแท็บพรีวิว** — แท็บประวัติ/ช่องฟอร์มยาวมาก ถ้ามาจำกัดความสูงที่คอลัมน์
> ผู้ใช้จะต้องเลื่อนอ่านในกล่องแคบ ๆ แทนที่จะเลื่อนหน้า จึงใส่คลาสเงื่อนไขเฉพาะ `pane === 'preview'`

**⚠️ `align-items: start` บน grid จำเป็นมาก** — ถ้าไม่ใส่ grid จะยืดไอเทมให้สูงเท่าคอลัมน์อีกฝั่ง
แล้ว `position: sticky` จะไม่มีที่ให้เลื่อน → หน้าจะเหมือนไม่ทำอะไร

**⚠️ `h2` ในหัวการ์ดห้ามใช้ `flex: 1`** — มันจะขโมกพื้นที่ว่างจนกล่องดาวน์โหลดถูกบีบ
(เคยวัดได้ว่าเหลือ 242px ทั้งที่ข้าง ๆ ยังว่าง 310px) แล้ว `select` กับปุ่มถูกบีบให้ตกคนละบรรทัด
หัวการ์ดสูงเปล่า ๆ 106px · ใช้ `flex: 0 1 auto` แทน

**⚠️ `<select>` ต้องล็อก `width` เป็นตัวเลข ไม่ใช่แค่ `max-width`** — browser กว้างเท่าตัวเลือกที่ยาวที่สุด
(~290px) ถ้าใช้แค่ `max-width` flex ยังคำนวณ intrinsic size เองได้ แล้วบีบกล่องพ่ออีก
ทางแก้ที่ได้ผล: ห่อ `select` + ปุ่มไว้ในกลุ่มเดียวกัน แล้วใส่ `width: max-content` · `flexShrink: 0`

```bash
node --env-file=.env tools/test-preview-layout.mjs   # 18 ข้อ
```

วัดตำแหน่งจริงจาก `getBoundingClientRect()` ในเบราว์เซอร์ — ยืนยันว่าตัวอย่างอยู่ครึ่งขวา,
อยู่ในจอตั้งแต่ `scroll = 0`, ยังอยู่ในจอหลังเลื่อนลงสุด, และจอ 900px ซ้อนเป็นคอลัมน์เดียว

> **⚠️ อีกกับดักหนึ่ง** — ต้องรอให้ pdf.js **วาดเสร็จ** ไม่ใช่แค่มี element `<canvas>`
> canvas ถูกสร้างทันทีแต่ยังกว้าง 0 อยู่ ถ้ารอแค่ element จะได้ภาพกระดาษเปล่า
> แล้วเผลอไป "ผ่าน" ทั้งที่พรีวิวไม่ได้วาดอะไรเลย (ตรวจ `canvas.width > 200`)

## URL สะท้อนสิ่งที่เปิดอยู่

คัดลอก URL ไปให้คนอื่นแล้วเปิดต่อได้จริง — รีเฟรชแล้วยังอยู่หน้าเดิม

| URL | หมายถึง |
|---|---|
| `/studio` | หน้ารายการแม่แบบ |
| `/studio/1521017978873838468?tabs=form&pane=preview` | เปิดแม่แบบ · ซ้าย=ฟอร์ม · ขวา=ตัวอย่างเอกสาร |
| `/studio/1521017978873838468?tabs=json&pane=fields` | เปิดแม่แบบ · ซ้าย=JSON · ขวา=ช่องฟอร์ม |
| `/studio/1521017978873838468?tabs=history&pane=preview` | เปิดแม่แบบ · ซ้าย=ประวัติของฉัน · ขวา=ตัวอย่างเอกสาร |

หน้าแก้ไขแบ่งเป็น 2 ฝั่ง แต่ละฝั่งมีแท็บของตัวเอง → ต้องมี query 2 ตัว

| query | หมายถึง | ค่าที่ใช้ได้ |
|---|---|---|
| `tabs` | แท็บฝั่ง**ซ้าย** | `form` · `json` · `history` |
| `pane` | แท็บฝั่ง**ขวา** | `preview` · `template` · `fields` · `history` |

> **⚠️ `history` เป็นชื่อที่ใช้ได้ทั้งสองฝั่ง** (ซ้าย=ประวัติของฉัน · ขวา=ผู้ใช้แม่แบบนี้)
> โค้ดจึงต้องดูว่า `?tabs=` เป็นแท็บซ้ายที่ถูกต้องก่อน แล้วค่อยตีความแบบ URL รุ่นเก่า
> ไม่งั้น `?tabs=history` จะไปเปิดฝั่งขวาด้วย (เพราะ `history` เคยเป็นชื่อแท็บชุดเดียว)

| ไฟล์ | บทบาท |
|---|---|
| `app/studio/lib/urlState.ts` | กติกาอ่าน/เขียน URL จุดเดียว · `studioPath(key, tab, pane)` |
| `app/studio/[key]/page.tsx` | route สำหรับ `/studio/<key>` — มีเพื่อให้**รีเฟรชแล้วยังเปิดแม่แบบเดิม** |
| `app/studio/Studio.tsx` | เปิด/ปิดแม่แบบ → เปลี่ยน URL + ฟัง `popstate` |
| `app/studio/TemplateEditor.tsx` | สลับแท็บของแต่ละฝั่ง → เขียน `?tabs=` และ `?pane=` |

**ทำไมใช้ history API ตรง ๆ ไม่ใช่ router ของ Next** — ไม่ต้องวนกลับเซิร์ฟเวอร์
(URL เปลี่ยนทันที หน้าไม่กะพริบ) และปุ่มย้อนกลับ/ไป-กลับของเบราว์เซอร์ใช้ได้ถูกต้อง
เพราะเราเรียก `pushState` จริง — ถ้าเก็บสถานะไว้แค่ใน React state ปุ่มย้อนกลับจะไม่พากลับไปหน้าก่อนหน้า

**⚠️ `push` กับ `replace` ต้องต่างกัน**

| การกระทำ | โหมด | เหตุผล |
|---|---|---|
| เปิด/ปิดแม่แบบ | `push` | กดย้อนกลับต้องกลับไปหน้ารายการได้ |
| สลับแท็บ | `replace` | ถ้าใช้ `push` ประวัติจะกอง — ผู้ใช้ต้องกดย้อนกลับหลายครั้งถึงจะออกจากแม่แบบ |

**⚠️ Next ไม่ยิง event เมื่อมี `pushState`/`replaceState`** — ต้องฟัง `popstate` เอง
ไม่งั้น URL เปลี่ยนแต่หน้าไม่ตาม (กดย้อนกลับแล้วเห็นหน้าเดิม)

**⚠️ อ่าน `?tabs=` ใน `useEffect` หลัง mount ห้ามอ่านตอนสร้าง state** — component นี้ถูก SSR
ด้วย (เซิร์ฟเวอร์ไม่มี `window`) ถ้าอ่านตอน render ฝั่งเบราว์เซอร์จะได้ค่าคนละอันกับเซิร์ฟเวอร์
→ hydration mismatch

```bash
node --env-file=.env tools/test-studio-url.mjs   # 21 ข้อ
```

ทดสอบทั้ง URL, ปุ่มย้อนกลับ/ไป-กลับ, deep link, และ key ที่ไม่มีอยู่จริง

> **⚠️ ห้ามใช้ `.editor-preview` เป็นตัวตรวจว่าเปิดหน้าแก้ไขแล้ว** — การ์ดตัวอย่างเอกสาร
> มี**เฉพาะแท็บฝั่งขวาที่เปิดอยู่** พอสลับไปแท็บอื่น element นั้นหายจาก DOM แล้ว
> เทสต์จะพลาดทั้งที่หน้าเปิดถูก ใช้จำนวนคอลัมน์ `.editor-split > .editor-col` แทน (ต้องได้ 2)

### แท็บสองฝั่ง ตรงกับสองคอลัมน์

| ฝั่ง | แท็บ | เนื้อหา |
|---|---|---|
| **ซ้าย** | ฟอร์ม · JSON · ประวัติ | สิ่งที่กรอกลงเอกสาร + ประวัติของฉันเอง (กู้ค่าเดิมมาแก้ได้) |
| **ขวา** | ตัวอย่างเอกสาร · แม่แบบ & การแชร์ · ช่องฟอร์ม · ผู้ใช้แม่แบบนี้ | ตัวแม่แบบและผลลัพธ์ |

**เหตุผลที่ "ช่องฟอร์ม" อยู่ฝั่งขวา** — มันเป็นเรื่องของ**ตัวแม่แบบ** (นิยามช่องว่าอะไร)
ไม่ใช่การกรอกข้อมูล ถ้าอยู่ฝั่งซ้ายผู้ใช้จะเข้าใจผิดว่ากำลังกรอกเอกสาร

**เหตุผลที่ "ประวัติ" อยู่ฝั่งซ้าย แต่ "ผู้ใช้แม่แบบนี้" อยู่ฝั่งขวา** — สองอย่างนี้เป็นคนละมุมมอง
"ประวัติ" คือของฉันเองที่จะ**เอามาแก้ต่อ** จึงต้องอยู่ฝั่งที่กำลังกรอกอยู่
ส่วน "ผู้ใช้แม่แบบนี้" เป็นเรื่องของตัวแม่แบบ อยู่ฝั่งเดียวกับช่องฟอร์ม

**⚠️ `sticky` ต้องอยู่ที่คอลัมน์ ไม่ใช่ที่การ์ด** (`.editor-col--right`)
เพราะแท็บถูกย้ายเข้ามาอยู่ในคอลัมน์เดียวกัน ถ้า sticky เฉพาะการ์ด
แท็บจะเลื่อนหายไปทั้งที่เนื้อหายังอยู่บนจอ → ผู้ใช้สับสนว่ากดอะไรไม่ได้

**⚠️ URL รุ่นเก่าต้องยังใช้ได้** — ของเดิมใช้ `?tabs=fields|template|history` ฝั่งเดียว
ตอนอ่าน URL ต้องมองค่าเหล่านั้นเป็น `pane` ด้วย ไม่งั้นลิงก์ที่คนอื่นคัดลอกไว้จะเปิดผิด
แต่ต้อง**ยกเว้น** `history` เพราะตอนนี้เป็นแท็บซ้ายที่ถูกต้องแล้ว

**⚠️ selector ฝั่งซ้ายต้องใช้ `.editor-col:not(.editor-col--right)`**
คอลัมน์ขวามี class `editor-col` ด้วย ถ้าใช้ `.editor-col [role="tab"]` จะไปจับแท็บขวามาด้วย
(ได้ป้าย 6 ตัวรวมสองฝั่งปนกัน) และอย่าเขียน `.editor-col--right:not(.editor-col--right)`
เพราะจะไม่มี element ไหนตรงเลย คลิกไม่ทันแต่เทสต์จะรายงานว่าเปิดไม่ได้

**เรนเดอร์เสร็จแล้วพาผู้ใช้ไปดูผลลัพธ์เอง** — `setPane('preview')` หลังเรนเดอร์สำเร็จ
ไม่งั้นผลลัพธ์จะอยู่ฝั่งขวาที่มองไม่เห็น ผู้ใช้ต้องเดาว่าต้องกดแท็บไหน

```bash
node --env-file=.env tools/test-editor-panes.mjs   # 23 ข้อ
node --env-file=.env tools/test-studio-ui.mjs      # 26 ข้อ (หน้าแก้ไขทั้งหน้า)
node --env-file=.env tools/test-my-history.mjs    # 18 ข้อ — เก็บ/ค้น/กู้ค่า + ไม่รั่วข้ามคน
node --env-file=.env tools/test-my-history-ui.mjs # 19 ข้อ — แท็บซ้าย + ปุ่มแก้ไข
node --env-file=.env tools/test-template-file.mjs # 23 ข้อ — ดาวน์โหลด/อัปโหลดแทน + สิทธิ์
```

> **⚠️ เทสต์ที่เขียนทับของจริงต้องสร้างของชั่วคราวเอง**
> `test-template-file.mjs` เคยใช้แม่แบบจริงของผู้ใช้ตอนทดสอบ
> ทำให้เปลี่ยนไฟล์ของคนอื่นโดยไม่ตั้งใจ (และทิ้งสิทธิ์เจ้าของค้างจนลบแม่แบบไม่ได้)
> ตอนนี้สคริปต์สร้างแม่แบบชั่วคราวจากไฟล์จริง แล้วลบทิ้งพร้อมล้าง `template_access` ตอนจบ

> **⚠️ `test-my-history-ui.mjs` ต้องใช้ key ที่มีช่องจริงในฟอร์ม**
> ค่าที่กู้มาแล้วไม่มีช่องรับจะอยู่แค่ใน state (เห็นในแท็บ JSON เท่านั้น)
> ถ้าใช้ key แต่งเอง เทสต์จะตกทั้งที่ฟีเจอร์ทำงานถูก
> สคริปต์จึงเรียก `import-tags` เพื่อสร้างช่องจากแท็กจริง แล้วลบทิ้งตอนเก็บกวาด

### ⚠️ เทสต์ที่เรนเดอร์ต้องเตรียมฟอร์มก่อนเสมอ

แอปบล็อกปุ่ม "เรนเดอร์ตัวอย่าง" เมื่อช่องบังคับยังว่าง → ถ้าเทสต์กดเรนเดอร์ทันที
จะไม่มี `<canvas>` ให้วัด แล้วตกทั้งชุด **ทั้งที่ของจริงไม่ได้พัง**

> เคยเจอกับ `test-download-pages` — เปิดแม่แบบ `ทดสอบหัวกระดาษ` ที่มีช่องบังคับ "เรื่อง" ค้าง
> ขึ้น *"ยังกรอกไม่ครบ 1 ช่อง — สุ่มเฉพาะในทับหนังสือ"* → ไม่มี canvas → ตก
> รันเดี่ยวผ่าน แต่รันเป็นชุดแล้วตก เพราะ `prefer` เลือกแม่แบบได้ตัวอื่นตามลำดับรายการ

ใช้ตัวช่วยกลาง `tools/lib/studio-seed.mjs` (แทนการเขียนเองทุกสคริปต์):

```js
import { FILL_FIELDS_JS, importTags, restoreForm, snapshotForm } from './lib/studio-seed.mjs'

const snap = await snapshotForm(H, key)   // เก็บฟอร์มเดิมก่อน
await importTags(H, tpl)                 // สร้างช่องจากแท็กจริง (ไม่ต้องเดา)
await evaluate(FILL_FIELDS_JS)           // กรอกทุกช่องที่พิมพ์ได้
// …ทดสอบ…
await restoreForm(H, key, snap)          // คืนสภาพเดิม
```

> ⚠️ **`import-tags` เขียนทับฟอร์มเดิม** — ต้อง `snapshotForm` ก่อนแล้ว `restoreForm` ตอนจบ
> การ `DELETE` ทิ้ง (แบบที่เคยทำ) จะทำให้เทสต์ถัดไปที่ใช้แม่แบบเดียวกันพัง
>
> ⚠️ **`restoreForm` คืนด้วย `PUT` เมื่อเดิมมีฟอร์ม แต่ `DELETE` เมื่อเดิมไม่มี**
> `PUT []` จะทำให้แม่แบบนั้นมี "ฟอร์มว่าง" ซึ่งต่างจากไม่มีฟอร์ม
> แอปจะเลิกแสดงแท็ก `หน่วยงาน`/`เนื้อหา` ให้ยิง import อัตโนมัติ

### ⚠️ เทสต์เลือกแม่แบบตามชื่อ ห้ามใช้ `items[0]`

ลำดับรายการเปลี่ยนได้ทุกครั้งที่มีเทสต์อัปโหลด/ลบแม่แบบชั่วคราว
และ Carbone ลบแม่แบบแบบ soft-delete → รายการที่ "ลบแล้ว" ยังโชว์ในรายการอยู่

`tools/lib/pick-template.mjs` — `TEST_TEMPLATES.multipage` = `ทดสอบหัวกระดาษ`
`TEST_TEMPLATES.onepage` = `มีเลขที่หนังสือ` · มี `pickTemplate()` กับ `keyOf()`

> **⚠️ เลือกตามชื่อแล้วต้อง "เปิด" ตามชื่อด้วย** — ไม่ใช่คลิกแถวแรก
> `test-preview-layout` เคย seed ช่องให้แม่แบบ A แต่คลิก `table tbody tr td button.ghost` (แถวแรก = แม่แบบ B)
> → รันเดี่ยวผ่าน · รันเป็นชุดแล้วแถวแรกเปลี่ยนเป็นแม่แบบหลายหน้า → กล่องพรีวิวสูง 1064px ล้นจอ → ตก

เครื่องมือกวาดแม่แบบทดสอบที่ค้าง: `node --env-file=.env tools/purge-test-templates.mjs`

> **⚠️ selector ของเทสต์ต้องเขียนให้ถูก** — ถ้าเขียน
> `.editor-col--right:not(.editor-col--right)` จะไม่มี element ไหนตรงเลย
> (ตัวเองขัดกับเอง) คลิกไม่ทัน แต่เทสต์จะรายงานว่า"หน้าไม่เปลี่ยน" ซึ่งชวนเข้าใจผิดว่าเป็นบั๊กแอป
>
> **⚠️ `test-studio-ui.mjs` ต้องเตรียมช่องกรอกให้ตัวเอง** — ท้ายสคริปต์มีขั้น "เก็บกวาด"
> ที่ `DELETE /api/form/<key>` ของแม่แบบแรก ถ้าวันหลังไปเรียกสคริปต์นี้อีก
> แม่แบบแรกจะไม่มีช่องกรอก → ตกที่ "ฟอร์มมีช่องให้กรอก" ทั้งที่แอปไม่ได้พัง
> (เทสต์ทำลายสภาวะที่ตัวเองต้องใช้ = รันซ้ำไม่ได้)
> ทางแก้คือ `PUT /api/form/<key>` ใส่ช่องตัวอย่างก่อนเปิดหน้าแก้ไข แล้วโหลดหน้าใหม่

## ช่องว่างระหว่างกล่องบนหน้ารายการ

**อาการ** สลับไปแท็บ "บุ๊กมาร์ก" ตอนที่ยังไม่มีบุ๊กมาร์ก → กล่อง "ยังไม่มีบุ๊กมาร์ก"
ชิดกับกล่องตารางเป๊ะ ไม่มีช่องว่าง

**สาเหตุ** กล่องทั้งหมดเป็น block ปกติเรียงต่อกันใน `div` เดียว ไม่มีใครกำหนดระยะห่าง
แก้ด้วย `margin` ทีละกล่องไม่ได้ เพราะ**จำนวนกล่องเปลี่ยนตามเงื่อนไข**
(เช่นตอนมี Banner แทรก ช่องว่างที่เพิ่มด้วย margin จะหายไปอีก)

**วิธีแก้** เปลี่ยนพ่อเป็น `display: flex; flex-direction: column; gap: 14`
ช่องว่างจะเท่ากันทุกคู่ ไม่ว่าจะมีกี่กล่อง — `apps/web/app/studio/Studio.tsx`
(ต้องเอา `margin: '16px 0'` ของแถวตัวกรองออกด้วย ไม่งั้นจะเป็น 14 + 16 = 30px)

```bash
node --env-file=.env tools/test-list-spacing.mjs   # 5 ข้อ
```

วัดระยะห่างจริงจาก `getBoundingClientRect()` ระหว่างกล่อง `.card` ทุกคู่
ใช้ **session ใหม่** เพื่อให้ได้สถานการณ์ "ยังไม่มีบุ๊กมาร์ก" (บุ๊กมาร์กเก็บแยกรายคน)

## จัดการแม่แบบ (Carbone Template Management)

`/api/templates` เป็น CRUD ครบวงจรที่ delegate ไปหา Carbone 5 Template Management API
แม่แบบทุกตัวมี **name / category / tags** ให้ค้นและกรองได้

| method | path | ทำอะไร |
|---|---|---|
| `GET` | `/api/templates` | รายการ — กรองด้วย `category` `search` `versionId` `templateId` |
| `GET` | `/api/templates/categories` | หมวดทั้งหมด |
| `GET` | `/api/templates/tags` | แท็กทั้งหมด |
| `GET` | `/api/templates/:id` | ดาวน์โหลดไฟล์แม่แบบ (content-disposition แบบ RFC 5987) · **ตรวจสิทธิ์** แม่แบบส่วนตัวที่ไม่ได้แชร์ → `403` |
| `POST` | `/api/templates` | อัปโหลด — **multipart** จำกัด 20 MB, 8 นามสกุล |
| `POST` | `/api/templates/:id/replace` | อัปโหลดไฟล์ใหม่**แทนแม่แบบเดิม** → เป็นเวอร์ชันถัดไป · ต้องมีสิทธิ์แก้ (`403`) |
| `PATCH` | `/api/templates/:id` | แก้ metadata → `204` (body ว่างจะได้ `422`) |
| `DELETE` | `/api/templates/:id` | ลบ → `204` |

ทุก endpoint ต้อง login (ยกเว้น `/docs`) และใช้ `id` = **versionId**

> **⚠️ ช่องโหว่ที่เคยเปิดอยู่: ดาวน์โหลดแม่แบบส่วนตัว**
> `GET /api/templates/:id` เดิม**ไม่ตรวจสิทธิ์** → ใครล็อกอินก็เดา URL แล้วดาวน์โหลด
> แม่แบบส่วนตัวของคนอื่นได้ (หน้าเว็บไม่โชว์ปุ่มก็ไม่ช่วย เพราะเดา URL ได้)
> แก้โดยเรียก `assertCanView` ก่อนดาวน์โหลด · เทสต์ `test-template-file.mjs` ยืนยันว่า 403

### อัปโหลดแทนแม่แบบ (เพิ่มเวอร์ชัน)

`POST /api/templates/:id/replace` ต่างจาก `POST /api/templates` ตรงที่ส่ง `id` = templateKey
เดิมไปให้ Carbone → ได้เป็น **เวอร์ชันถัดไปของแม่แบบเดิม** (สิทธิ์ · ประวัติ · ช่องฟอร์ม ยังอยู่ครบ)
ถ้าไม่ส่ง `id` จะกลายเป็นแม่แบบคนละตัวทันที

> **⚠️ ต้องส่ง `deployedAt` เสมอ** ไม่งั้น Carbone ตอบ `400` code **w124**
> เพราะเวอร์ชันเดิมถูกสร้างแบบไม่มีค่านี้ (เป็น 0) และ Carbone บังคับว่า
> ค่าใหม่ต้อง "ต่างจาก" ค่าของเวอร์ชันที่ปล่อยอยู่

> **⚠️ Carbone ต่อเวอร์ชันได้เฉพาะแม่แบบที่ `id` เป็นเลข 64-bit**
> แม่แบบที่ `id` เป็น hash จะโดน 400 — API ดักไว้แล้วและตอบ `NOT_VERSIONABLE`
> พร้อมบอกให้ดาวน์โหลดออกมาแล้วอัปโหลดเป็นแม่แบบใหม่แทน

> **⚠️ ข้อจำกัดของ docserver 5.15.2 ที่ยังหาวิธีแก้ไม่ได้**
> หลังเพิ่มเวอร์ชันใหม่ `GET /api/templates` ยังชี้ `versionId` **เดิม**
> ลองค่า `deployedAt` ครบทุกแบบแล้ว (unix วินาที · unix มิลลิ → 42000000000 ·
> 1000000000000 · 9999999999) ไม่มีค่าไหนทำให้รายการสลับไปเวอร์ชันใหม่
> เทสต์จึงบันทึกข้อเท็จจริงนี้ไว้ตรง ๆ แทนที่จะกลืนเป็น "ผ่าน" — ถ้าวันหนึ่ง docserver แก้ได้
> ข้อนี้จะกลายเป็นตัวเตือนให้อัปเดตเทสต์

### นำเข้าแม่แบบเดิมเข้า DB

แม่แบบที่อัปโหลดครั้งแรกโดย**ไม่เปิด versioning** จะมีแค่ไฟล์บนดิสก์ ไม่มี record ใน DB
→ `GET /templates` ไม่เห็น · `PATCH`/`DELETE` ได้ `404` · เรนเดอร์ได้อย่างเดียว

สคริปต์นี้แก้โดยเอาไฟล์เดิมกลับมาอัปโหลด**พร้อมเปิด versioning**:

```bash
node --env-file=.env tools/import-templates.mjs --dry-run   # ดูก่อน ไม่แก้อะไร
node --env-file=.env tools/import-templates.mjs            # ลงจริง
```

ชื่อ/หมวด/แท็ก อยู่ในตัวแปร `MANIFEST` ที่หัวสคริปต์ — key คือ **sha256 จริงของไฟล์**
อ่านมาจากเนื้อหา `word/document.xml` ไม่ใช่ชื่อที่เดา แก้แล้วรันซ้ำได้
แต่ถ้าลง DB ไปแล้วต้องแก้ผ่าน `PATCH /api/templates/:id` เพราะสคริปต์ข้ามที่นำเข้าแล้ว

> **สคริปต์นี้ไม่ลบอะไรเด็ดขาด** และข้ามไฟล์ที่ไม่มีใน `MANIFEST`
> สถานะที่นำเข้าแล้วเก็บที่ `tools/.imported-templates.json` (อยู่ใน `.gitignore`)

### ตรวจสอบว่าแม่แบบที่นำเข้าใช้ได้จริง

```bash
node --env-file=.env tools/verify-templates.mjs   # ดูรายการ/หมวด/แท็ก
node --env-file=.env tools/render-check.mjs      # เรนเดอร์จริง 2 แม่แบบ แล้วลบทิ้ง
```

### ⚠️ Carbone ลบไฟล์จริงแบบ synchronous

`DELETE /template/{versionId}` **ลบไฟล์ออกจาก `/app/template` ทันที** ไม่ใช่แค่ตั้ง `expireAt`
ถ้าสั่ง DELETE ด้วย `versionId` ของแม่แบบที่ไม่ได้เปิด versioning
→ ไฟล์ต้นฉบับหายถาวร และกู้จาก backup ได้ก็ต่อเมื่อยังมีสำเนา

> เคยเกิดจริงระหว่างทดสอบ — กู้คืนจาก `../docserver-backup-20260930/template/` ได้
> **สำรอง `metadata.db` + `/app/template` ไว้ก่อนทุกครั้งที่จะลบแม่แบบ**

## เข้าจากเครื่องอื่นด้วย Tailscale

`tailscale serve` เป็น reverse proxy ที่ได้ cert จริงจาก Let's Encrypt ฟรี
ต่างจาก `.app` ที่ HSTS บังคับ HTTPS และเป็น TLD จริงของ Google — Tailscale ไม่มีปัญหาทั้งสองอย่าง

```bash
tailscale serve --bg --https=443 --set-path=/        http://127.0.0.1:4000
tailscale serve --bg --https=443 --set-path=/gateway http://127.0.0.1:4001
tailscale serve --bg --https=443 --set-path=/storage  http://127.0.0.1:8080
tailscale serve --bg --https=8443                     http://127.0.0.1:9000

tailscale serve status     # ดูทั้งหมด
tailscale serve reset      # ถอดออกทั้งหมด
```

| URL | ไปที่ |
|---|---|
| `https://<host>.ts.net/` | เว็บ 2docx.com (หน้าแรก) |
| `https://<host>.ts.net/studio` | **2docx Studio** — เครื่องมือจัดการแม่แบบ |
| `https://<host>.ts.net/docs` | Swagger UI (ผ่าน rewrite ของ Next.js) |
| `https://<host>.ts.net/api/...` | API — ผ่าน rewrite ของ Next.js |
| `https://<host>.ts.net/gateway/docs` | API ตรง ๆ (พอร์ต 4001) |
| `https://<host>.ts.net/storage/` | rustfs-ui (ดูไฟล์ใน S3) |
| `https://<host>.ts.net:8443/documents/...` | RustFS ตรง ๆ (สำหรับ presigned URL) |

> ⚠️ **Carbone Studio เดิมถูกถอดออกจาก tailnet แล้ว** เหลือเข้าถึงที่ `localhost:4000` เท่านั้น
> เพราะ root ของโดเมนถูกให้เว็บของเราแล้ว และ `carbone-studio.js` ยิง API ด้วย absolute path
> (`/render/` `/template/`) ถ้าย้ายไป subpath จะพังทันที
> ใช้ **2docx Studio** แทน — ดูที่ `## 2docx Studio`

### presigned URL ต้องชี้ tailnet ไม่ใช่ localhost

`S3_ENDPOINT` ผูกแค่ `127.0.0.1` → ถ้าเรียก API จากเครื่องอื่น ลิงก์ที่ได้จะชี้
`http://127.0.0.1:9000` ซึ่งคือ localhost **ของ client** ไม่ใช่ของเรา → ดาวน์โหลดไม่ได้

แก้ด้วย `S3_PUBLIC_ENDPOINT` (ชี้ endpoint ที่ภายนอกเข้าถึงได้) + `CORS_ORIGINS`
RustFS ยอมรับ `Host` ที่ต่างจากของตัวเอง ทำให้ presigned signature ยังผ่าน

### ⚠️ docserver ไม่มี authentication

`"authentication": false` ใน Carbone config — ทุกคนที่เข้า tailnet ได้ยิงเรนเดอร์ได้
tailnet นี้มีหลายเครื่อง (รวมเครื่องที่อาจไม่ใช่ของเรา) ถ้าไม่สบายใจ ให้ปิดเส้นทาง root:

```bash
tailscale serve --https=443 off
```

แล้วเปิดเฉพาะ `/gateway` ที่จำเป็น

## ใช้งาน

```bash
# สร้างเอกสาร — คืนทันที ไม่รอเรนเดอร์
# templateId = versionId ของแม่แบบ (ดูจาก GET /api/templates)
curl -X POST http://localhost:4001/api/documents \
  -H "Content-Type: application/json" \
  -d '{
    "templateId": "6cbbba683e6b543bbf62581ee04ef1e71531df783520ebab040e6e71e262de96",
    "data": { "เรื่อง": "ขออนุญาตไปราชการ", "เนื้อหา": "ด้วยข้าพเจ้า…" },
    "outputFormat": "pdf",
    "label": "หนังสือรับรอง"
  }'
# {"_id":"doc_xxx","status":"queued",...}

# เช็คสถานะ — ได้ downloadUrl อัตโนมัติตอนเสร็จ
curl "http://localhost:4001/api/documents/doc_xxx?withUrl=true"
# {"status":"done","downloadUrl":"https://rustfs:9000/documents/...?X-Amz-..."}

# รายการ
curl "http://localhost:4001/api/documents?status=done&limit=20"

# รายการพร้อมลิงก์ดาวน์โหลด — ตัดปัญหา N+1 ตอนหน้าเว็บโหลดรายการ
curl "http://localhost:4001/api/documents?withUrl=true&limit=20"
```

วงจรสถานะ: `queued` → `rendering` → `done` | `failed`

### `withUrl` ต่างกันยังไงระหว่างรายการกับรายตัว

| จุดเรียก | ค่า default | ผล |
|---|---|---|
| `GET /api/documents` | `false` | `downloadUrl` เป็น `null` ทุกแถว |
| `GET /api/documents?withUrl=true` | — | ได้ลิงก์เฉพาะแถวที่ `status === 'done'` |
| `GET /api/documents/:id?withUrl=true` | `true` | ได้ลิงก์ (ค่า default เป็น `true`) |

รายการที่ยังไม่เสร็จ (`queued` / `rendering` / `failed`) **ได้ `null` เสมอ** ไม่ว่าจะเปิด flag — เพราะยังไม่มี `storageKey`

**ทำไมรายการ default เป็น false** — การออก presigned URL คือการคำนวณ RSA signature
ซึ่ง CPU-bound ถ้าเปิดทันที หน้าที่โหลด 100 แถวก็ยิง S3 100 รอบ
แตกเป็น `?withUrl=true` เมื่อต้องการ เช่น หน้าเว็บที่ผู้ใช้คลิกดาวน์โหลดได้ทันที

⚠️ URL หมดอายุ **1 ชั่วโมง** (`expiresIn = 3600` ฝังใน `plugins/s3.ts`)
เปิด flag แล้วค้างหน้าจอนานเกินนั้น ลิงก์จะใช้ไม่ได้ต้อง reload

## ทำไมต้องแยก worker

**Carbone เรนเดอร์ช้า** — config ใช้ `converterFactoryTimeout: 300000` (5 นาที)
Next.js Server Action และ Route Handler ทำงานอยู่ใน scope ของ request เดียว งานแบบนี้อยู่ตรงนั้นไม่ได้

```
client ──POST──► API ──XADD──► NATS ──────► worker ──► docserver
       ◄─202────┘                            (5 นาที)      │
       (ทันที)                                             ▼
                                                    S3 + อัปเดต Mongo
```

## เรื่องที่ต้องรู้

### ⚠️ Carbone เรนเดอร์แบบ async — ยิง 2 รอบ

```bash
# รอบ 1 → ได้ renderId
POST /render/{templateId}   →  {"success":true,"data":{"renderId":"xxx.pdf"}}
# รอบ 2 → ได้ไฟล์จริง
GET  /render/{renderId}     →  binary
```

ยิงรอบเดียวจะได้ JSON ~73 bytes ไม่ใช่ PDF — `docserver.ts` เช็ค magic bytes ให้แล้ว

### ⚠️ Carbone Template Management API — 6 กับดักที่ต้องรู้

**1. ห้ามใส่ header `Expect`** — `fetch` ของ Node ใช้ undici ซึ่งไม่รองรับ
→ `NotSupportedError: expect header not supported` ทันที

**2. field ข้อความต้องมาก่อน field ไฟล์** — Carbone บังคับลำดับ
แนบ `template` ไปก่อนแล้ว `versioning` จะได้ error code `w131`
แก้โดยเรียง `versioning` → `name` → `category` → `tags` แล้วค่อยแนบไฟล์ทีหลัง

**3. `createdAt` / `deployedAt` / `expireAt` เป็น unix timestamp ตัวเลข** ไม่ใช่ string
ส่งเป็น ISO string แล้ว Carbone จะ parse ไม่ได้

**4. ชื่อ field คือ `type` ไม่ใช่ `extension`**

**5. categories / tags คืน `[{ name: "..." }]` ไม่ใช่ `["..."]`** — ต้อง map `.name` ก่อน

**6. `versionId` ไม่ใช่ content hash เมื่อเปิด versioning**
อัปโหลดไฟล์เดิมซ้ำแล้วได้ค่าใหม่ทุกครั้ง จึง **ห้ามใช้ `versionId` เป็น idempotency key**
(ถ้าเปิด versioning จะมี `templateId` แยกอีกตัวหนึ่งที่คงที่)

### ⚠️ Zod serializer พังตอนส่ง Buffer

`route` ที่ตอบไฟล์ binary **ต้องไม่ประกาศ `response` schema**
Zod จะพยายาม serialize `Buffer` เป็น JSON แล้วได้ `{}` หรือ error
route `GET /api/templates/:id` จึงตั้ง content-type กับ content-disposition เอง

### ⚠️ ต้องเรียก setValidatorCompiler

```ts
app.setValidatorCompiler(validatorCompiler)
app.setSerializerCompiler(serializerCompiler)
```

Fastify default เป็น Ajv + JSON Schema **ไม่ใช่ Zod**
ถ้าไม่เรียกสองบรรทัดนี้ → schema ที่เขียนไว้จะไม่ถูก validate อะไรเลย แล้วเงียบ ๆ รับ input ผิดเข้าไป

### ⚠️ MongoDB ต้องเป็น replica set

Community Edition แบบ standalone **ไม่มี multi-document transaction และ change stream ที่ใช้ production ได้**
`plugins/mongo.ts` เช็ค `hello.setName` ตอน boot — ถ้าไม่ใช่ replica set จะ log warn

### ⚠️ ลำดับการเขียน: ลง Mongo ก่อน แล้วค่อย publish

**ห้าม publish ก่อนแล้วค่อยลง Mongo** — จะเกิด race จริง
worker ดึงงานได้ทันทีหลัง publish แล้ว query Mongo ทันก่อนที่ `insertOne` ของ API จะเสร็จ
→ `matchedCount = 0` → **งานหายจริง** ไม่ใช่แค่ข้อมูลผิด

ที่แก้แล้ว (`service.ts`):

1. `insertOne` ก่อน → 2. `publish`
3. ถ้า publish พัง → mark `failed` + error ทันที (ไม่ปล่อยให้ค้าง `queued` เงียบ ๆ)
4. worker ถ้าเจอ `matchedCount = 0` → `nak(2000)` ให้ NATS ส่งซ้ำ ไม่ใช่ `ack()` ทิ้ง

### ⚠️ permissions ของ NATS ต้องมี `$JS.ACK.>`

นี่คือกับดักที่ทำให้ **พังแบบเงียบที่สุด** — client ไม่ได้ error ให้เห็นเลย

`ack`/`nak` คือการ publish ไปที่ subject `$JS.ACK.<stream>.<consumer>...`
ถ้า allowlist มีแค่ `jobs.>` + `_INBOX.>` + `$JS.API.>` → **ack ทุกครั้งถูกปฏิเสธ**
ผลที่เห็น: งานเรนเดอร์สำเร็จ, ขึ้น `done` ใน Mongo, แต่

- ไม่มี retry เลย (เพราะ `nak()` ก็ถูกปฏิเสธเหมือนกัน)
- `consumer.info().ack_floor.consumer_seq` ค้างที่ `0` ตลอด
- `num_ack_pending` โตไม่หยุด

ตรวจด้วย:

```bash
docker logs nats 2>&1 | grep 'JS.ACK'    # ถ้าเจอ Violation = ยังขาด permission
```

### ⚠️ หน่วยเวลาใน nats.js เป็นนาโนวินาที

`max_age` / `ack_wait` ไม่ใช่มิลลิวินาที — `24 * 3600 * 1000` คือ 86.4 มิลลิวินาที
NATS จะตอบ `max age needs to be >= 100ms` และถ้าเผลอใส่ค่าเล็กกว่านั้นใน `ack_wait`
→ NATS ส่งซ้ำทันทีทั้งที่งานยังทำอยู่

```ts
const HOUR_NS = 3600 * 1_000_000_000
```

### ⚠️ bucket หายกลางคันได้ — worker สร้างคืนเอง

`ensureBucket()` ที่ตอน boot ไม่พอ ถ้า bucket ถูกลบทีหลัง (เผลอ purge, restore จาก backup,
RustFS เพิ่งขึ้นใหม่) ทุกงานจะล้มด้วย `NoSuchBucket` ไม่งั้นจนกว่าจะ restart

`worker/src/s3.ts` จับ `NoSuchBucket` แล้วสร้าง bucket ใหม่แล้วลอง `put` อีกครั้งในงานเดิม

⚠️ ระวัง `rclone purge s3rust:documents` — **ลบทั้ง bucket ทิ้ง** ไม่ใช่แค่ไฟล์ข้างใน
ถ้าจะลบแค่เนื้อหาใช้ `rclone delete s3rust:documents --max-depth 1` หรือ `rclone cleanup`

### ⚠️ DELETE ต้องลบไฟล์ใน S3 ด้วย

RustFS ไม่มี API ให้ scan กำพร้า — ถ้าลบ record ใน Mongo ก่อนแล้วค่อยลบ S3 แล้ว S3 พัง
จะเสีย `storageKey` ซึ่งเป็นวิธีเดียวที่จะตามไฟล์นั้นมาลบได้ → orphan ถาวร
`service.ts` จึงลบ S3 ก่อน แล้วค่อยลบ record

### ⚠️ ตอนรันบน host ต้องหา primary เอง

replica set advertise ชื่อ Docker (`mongo-1:27017`) ซึ่ง Windows resolve ไม่ได้
เลยต้องใช้ `directConnection=true` — แต่มันจะ **pin ที่ node เดียวตลอด**
ถ้า node นั้นเป็น SECONDARY ทุกการเขียนจะได้ `not primary` แล้ว crash ตอน boot

`packages/shared/src/mongo.ts` แก้โดยไล่ `MONGO_PRIMARY_CANDIDATES` หา node ที่ writable
แล้วชี้ URL ไปหา (log จะบอกว่าเลือก node ไหน)

**ข้อจำกัดที่ต้องรู้**: ต่อแล้วยัง failover อัตโนมัติไม่ได้ ถ้า primary เปลี่ยนอีกรอบตอนรันอยู่
ต้อง restart แอป ทางแก้จริงมีสองทาง:

1. รันแอปใน Docker → ใช้ชื่อ service แล้ว driver ทำ failover เอง (ทางที่ถูก)
2. เพิ่มใน hosts file (ต้องเป็น admin) แล้ว publish แต่ละ node เป็น loopback IP คนละตัว:
   ```
   127.0.0.2 mongo-1
   127.0.0.3 mongo-2
   127.0.0.4 mongo-3
   ```

### ⚠️ แก้ชื่อ volume ของ MongoDB = ข้อมูลหาย

volume ตั้งชื่อตายตัว `docgen-mongo1/2/3` ไม่ผูกกับชื่อ compose project
จึงย้ายไป stack ไหนก็ได้โดยข้อมูลยังอยู่ — **แต่ถ้าเปลี่ยนเป็นชื่อย่อ**
Docker จะสร้าง volume ใหม่ → replica set มองเป็นคนละชุด → ข้อมูลเดิมหาย

### ⚠️ nats.js 2.x ไม่อ่าน user:pass จาก URL

`servers: ['nats://app:pass@host:4222']` → `ServerImpl` เก็บแค่ hostname/port แล้ว**ทิ้ง credential**
อาการคือ server ตอบ `Authorization Violation` และ log ว่า `authentication error - User ""`
ต้องส่งแยก: `{ ...natsServers(), name: '...' }` — ดู `packages/shared/src/env.ts`

### ข้อมูลที่ไม่เก็บ

เก็บไฟล์ใน S3 เก็บแค่ `storageKey` ใน MongoDB — ไม่เก็บ binary (เกิน 16 MB ต้องใช้ GridFS ซึ่งช้ากว่ามาก)

### Redis cache ไม่ได้อยู่ใน critical path ตอนนี้

`plugins/valkey.ts` เชื่อมไว้พร้อมแล้ว แต่ service ยังไม่ได้ cache อะไรจริง ๆ
เผื่อไว้สำหรับ cache ตาราง, session, rate limit แบบ distributed

## กับดัก

| อาการ | สาเหตุ |
|---|---|
| `variable reference ... can not be found` | `.env` ไม่ครบ — shared validate ตอน import จะบอกชื่อที่ขาด |
| ได้ JSON แทน PDF | ลืมยิงรอบ 2 ของ Carbone |
| MongoDB เชื่อมไม่ได้ | ยังไม่ได้ขึ้น `dokploy-infra` — หรือ `mongo-init` ยังไม่เสร็จ |
| `not primary` ตอน boot | `directConnection=true` ชี้ไป node ที่เป็น SECONDARY — ใส่ `MONGO_PRIMARY_CANDIDATES` ให้ครบทั้ง 3 พอร์ต |
| `Transactions are not supported` | replica set ไม่ครบ 3 node |
| validation ไม่ทำงาน | ลืม `setValidatorCompiler` |
| ไฟล์ไม่ปรากฏใน S3 | ดูว่า `S3_FORCE_PATH_STYLE=true` แล้วหรือยัง |
| `NoSuchBucket` ทุกงาน | bucket ถูกลบ — `docker exec rustfs-ui rclone mkdir s3rust:documents` (worker สร้างให้เองตอนรัน) |
| `Authorization Violation` + log ว่า `User ""` | nats.js ไม่อ่าน credential จาก URL — ใช้ `natsServers()` |
| `subjects overlap with an existing stream` | NATS ไม่ให้สอง stream ใช้ subject ซ้อนกัน — ใช้ stream `JOBS` ที่มีอยู่แล้ว |
| `max age needs to be >= 100ms` | หน่วยเป็นนาโนวินาที ไม่ใช่มิลลิวินาที |
| ไม่มี retry แม้งานพัง | ขาด `$JS.ACK.>` ใน permissions ของ NATS — ดู `docker logs nats \| grep JS.ACK` |
| job ค้าง `queued` ทั้งที่ worker ไม่ error | API publish ก่อน insert (race) — ต้อง insert ก่อน publish |
| job ค้าง `rendering` | worker ตายกลางคัน — NATS จะส่งซ้ำหลัง `ack_wait` (30 นาที) |
| `expect header not supported` | ใส่ header `Expect` ใน request ของ Carbone — `fetch` ของ Node ไม่รองรับ |
| อัปโหลดแม่แบบแล้วไม่เห็นในรายการ | ไม่ได้ส่ง `versioning: true` — ไฟล์อยู่บนดิสก์แต่ไม่มี record ใน DB |
| Carbone ตอบ `w131` | ส่ง field ไฟล์ก่อน field ข้อความ — ต้องเรียงข้อความก่อนแล้วแนบไฟล์ทีหลัง |
| แม่แบบหายจาก `/app/template` | `DELETE` แล้ว Carbone ลบไฟล์จริงทันที — ต้องมี backup |
| `GET /api/templates/:id` ได้ `{}` | ประกาศ `response` schema ใน route ที่ส่ง binary — Zod serialize Buffer ไม่ได้ |

## ผลทดสอบจริง

ยิงผ่าน API → NATS → worker → docserver → RustFS แล้ว บน Windows host

| กรณี | ผล |
|---|---|
| POST → GET → ดาวน์โหลด (pdf) | `done` · 103,621 bytes · magic `%PDF-` · ~250 ms |
| POST → GET → ดาวน์โหลด (docx) | `done` · 45,732 bytes |
| ยิง 5 งานติดกัน | 5/5 `done` |
| templateId ไม่มีจริง | retry 3 ครั้ง แล้ว `failed` + error |
| Zod validation | `422` พร้อมรายละเอียดทุก field ที่ผิด |
| เอกสารไม่มี | `404` |
| DELETE | ลบ record ใน Mongo **และ** ไฟล์ใน S3 — เหลือ 0 ทั้งสองฝั่ง |
| ลบ bucket ทิ้งแล้วยิงงานใหม่ | worker สร้าง bucket คืนเองแล้ว `done` ในงานเดียว |
| `ack_floor` / `ack_pending` | `2` / `0` — ack เดินจริง |

### `/api/templates` — ทุก endpoint ผ่าน

| กรณี | ผล |
|---|---|
| `GET /api/templates` | `200` ครบ 10 รายการ · กรอง category/search ได้ |
| `GET /api/templates/categories` | `200` `["ทดสอบ","หนังสือรับรอง","หนังสือราชการ"]` |
| `GET /api/templates/tags` | `200` 9 แท็ก |
| `GET /api/templates/:id` | `200` ไฟล์จริง 36,170 bytes + content-disposition RFC 5987 |
| `POST /api/templates` (multipart) | `201` · ไม่เปิด versioning จะไม่มี record ใน DB |
| `POST` ที่ไม่ใช่ multipart | `400` `EXPECTED_MULTIPART` |
| `PATCH /api/templates/:id` | `204` · body ว่าง → `422` |
| `DELETE /api/templates/:id` | `204` |
| ไม่ล็อกอิน | `401` |
| กรองรายการซ้ำ | Carbone คืนทั้ง record ใน DB + ไฟล์ดิบ · API กรอง `id === null` ทิ้ง |

### `withUrl` ทดสอบจริง

| กรณี | ผล |
|---|---|
| ไม่ใส่ param (default) | `downloadUrl: null` ทุกแถว — ไม่เปลี่ยนพฤติกรรมเดิม |
| `?withUrl=true` | แถว `done` ได้ลิงก์ · แถว `rendering` ยังเป็น `null` |
| `?withUrl=false` | เหมือน default |
| ยิงลิงก์จากรายการ | `200` · 57,593 bytes · magic `%PDF-` |
| ประหยัดเวลา | 5 ครั้ง: default 112 ms · `withUrl=true` 119 ms |
| Swagger | `withUrl` query param default `"false"` แสดงใน `/docs` |

### นำเข้าแม่แบบเดิม

| กรณี | ผล |
|---|---|
| `--dry-run` | รายงาน 10 ไฟล์ + เตือนไฟล์ที่ชื่อไม่ตรง hash โดยไม่แก้อะไร |
| รันจริง | สำเร็จ 10/10 · ไม่มีไฟล์ใดถูกลบ |
| รันซ้ำ | ข้ามทั้งหมด (idempotent ผ่าน `tools/.imported-templates.json`) |
| ไฟล์ที่ชื่อไม่ตรง hash | `c7b138d5…` คำนวณได้จริงเป็น `6011892a…` — ชื่อผิดมาตั้งแต่ backup เดิม ไม่ใช่ของที่เพิ่งพัง |
| เรนเดอร์แม่แบบที่เพิ่งนำเข้า | PDF 82,571 + 49,912 bytes · magic `%PDF-` ทั้งคู่ |

### แบรนด์ในไฟล์ที่ส่งออก — ทดสอบจริง

| กรณี | ก่อน | หลัง patch |
|---|---|---|
| PDF `/Producer` | `LibreOffice 26.2.4.2 (X86_64)` | `2docx.com` |
| PDF `/Creator` | `Writer` | `2docx.com` |
| PDF `/Author` | ชื่อจริงของผู้ทำแม่แบบ | `2docx.com` |
| DOCX `dc:creator` | ชื่อจริงของผู้ทำแม่แบบ | `2docx.com` |
| DOCX `Application` | `Microsoft Office Word` | `2docx.com` |
| ODT `meta:initial-creator` | — | `2docx.com` |

| กรณี | ผล |
|---|---|
| PDF ยังเปิดได้ | `%PDF-` · 1 หน้า · อ่านกลับด้วย pdf-lib ได้ |
| DOCX ยังเปิดได้ | magic `PK` · เนื้อหา zip ครบ |
| ODT ยังเปิดได้ | `mimetype` เป็น entry แรกและ STORED (ไม่บีบอัด) |
| ไฟล์ใน S3 ตรงกับที่ patch | sha256 ตรงกันทั้งสองฝั่ง |

### ภาษาไทยในไฟล์ที่ส่งออก — ทดสอบจริง

| กรณี | ก่อน | หลัง |
|---|---|---|
| `w:lang` ใน `document.xml` | 0 จุด (สืบทอด `en-US` จาก `styles.xml`) | ครบทุก run ที่เป็นภาษาไทย |
| ตัวอย่างแม่แบบที่ยากที่สุด | 43 run ไทย · 0 จุด | 44 run ไทย · 44 จุด · `w14:ligatures` ยังอยู่ท้ายสุด |
| ข้อความอังกฤษ (`Ref. 1234/2569`) | ตรวจด้วยพจนานุกรมอังกฤษ | ไม่ถูกแตะ (ถือว่าอังกฤษมากกว่า → ข้าม) |
| ทั้ง 9 แม่แบบ | — | ครอบคลุม 100% · LibreOffice แปลงเป็น PDF ได้ครบ |
| กรณีขอบ (22 ข้อ) | — | ผ่านหมด: rPr ไม่มี / มี attribute / แบบว่าง / มี `w:lang` เดิม / ไม่ใช่ zip / เอกสารว่าง |

## สิ่งที่ยังไม่ได้ทำ

- **web** — โฟลเดอร์ `apps/web` ว่าง ใส่ Next.js เอง (ตอนนี้ยังต้องยิง API ผ่าน curl / Swagger UI)
- **MongoDB ไม่มี TTL index** — เอกสารเก่าจะไม่หายเอง ถ้าต้องการเพิ่ม `expireAfterSeconds`
- **retry ยังเป็น delay คงที่** — `nak(2000)` ทุกครั้ง ยังไม่ใช่ exponential backoff
- **ไม่มี tracing** — มีแต่ log ของ NATS consumer ยังไม่มี `jobId` ติดไปทุก layer
- **ยังไม่มี dead-letter** — งานที่ครบ 3 ครั้งแล้วถูก `ack()` ทิ้ง ดูย้อนหลังไม่ได้นอกจาก field `error` ใน Mongo
- **ยังไม่มี refresh token** — session หมดอายุใน 24 ชม. แล้วต้องล็อกอินใหม่ (ยังไม่ได้ทำ silent renewal)
- **docserver ยังไม่มี auth** — เปิดผ่าน Tailscale แล้วทุกเครื่องใน tailnet เข้าได้ (ดูหมายเหตุเรื่องความปลอดภัย)
- **MongoDB ยังไม่เปิด `--auth`** — ผูกแค่ localhost ไว้ก่อน (ดูหมายเหตุท้าย `../dokploy-infra/docker-compose.yml`)
- **ตั้งภาษาไทยยังทำแค่ `.docx`** — ถ้าส่งออก `.odt` แล้วเปิดใน LibreOffice ก็ยังติดเส้นตรวจสะกด (ODT เก็บภาษาไว้ที่ `fo:language` ไม่ใช่ `w:lang`)
- **ไม่ได้ตั้งภาษาให้ข้อความผสม** — run ที่อังกฤษมากกว่าไทย (เช่น `ติดต่อ Email: a@b.com เพื่อทราบ`) ยังไม่ถูกตั้ง ตัวอักษรไทยในนั้นจึงยังโดนตรวจ

## License

MIT
