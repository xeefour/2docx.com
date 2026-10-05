# BAND.md — รูปแบบการทำงานในโปรเจกต์นี้

> **BAND = Bandwidth of Acceptable Norms? ไม่สำคัญ** — ชื่อที่ผู้ใช้ตั้ง
> ของจริงที่อยู่ในไฟล์นี้คือ **"ขอบเขตที่ยอมรับได้"** คือกติกาทุกข้อที่เกิดจาก
> งานจริง ไม่ใช่กติกาสมมติ — เจออะไรพลาด ก็แก้ตรงนี้ทีเดียว อย่าไปแก้ในหัวใจ
>
> `README.md` ตอบว่า **"ระบบนี้คืออะไร"** (สถาปัตยกรรม · ฟีเจอร์ · กับดักของ Carbone/NATS/Mongo)
> ไฟล์นี้ตอบว่า **"จะเขียนและตรวจโค้ดในนี้อย่างไรให้ไม่พัง"**

---

## 0 · เริ่มรอบใหม่ยังไง (อ่าน 90 วินาที)

```bash
cd D:\2docx.com\docgen-platform

# 1. ดูว่าอะไรค้างอยู่
cd D:\2docx.com && git status --short && git log --oneline -3

# 2. บริการต้องครบ (ถ้าไม่ครบ ดู §1)
#    ⚠️ curl บนเครื่องนี้เป็น alias ของ Invoke-WebRequest → ใช้แบบ PowerShell ตรง ๆ
foreach ($p in @(@{n='web';u='http://localhost:3000'},@{n='api';u='http://127.0.0.1:4001/api/health'})) {
  try { $r = Invoke-WebRequest -Uri $p.u -UseBasicParsing -TimeoutSec 20; "$($p.n) HTTP $($r.StatusCode)" }
  catch { "$($p.n) FAIL $($_.Exception.Message)" }
}

# 3. แก้โค้ด → ตรวจ typecheck → รันเทสต์ที่กระทบ → commit
npx.cmd tsc --noEmit -p apps/web/tsconfig.json
node --env-file=.env tools/test-xxx.mjs
```

**กติกาที่พลาดแล้วเสียหายที่สุด** — อย่าเพิ่งสรุปว่าเทสต์ตกเพราะโค้ดพัง
จนกว่าจะรันซ้ำ 1 ครั้ง (ดู §3.2) และอย่า commit ทันทีที่แก้ไฟล์ เพราะ Next dev
จะ recompile กลางคัน ทำให้ผลที่ commit ไม่ตรงกับผลที่ทดสอบ (ดู §3.3)

---

## 1 · บริการและคำสั่ง

| บริการ | ที่อยู่ | หมายเหตุ |
|---|---|---|
| web (Next 15) | `:3000` | Studio อยู่ที่นี่ |
| api (Fastify 5) | `:4001` | `/api/health` |
| worker (NATS consumer) | — | ต้องครู่ ถ้าตาย เอกสารค้างในคิว |
| docserver (Carbone 5.15.2) | `:4000` | ตัวจริงอยู่ใน `../dokploy-infra` |
| MongoDB replica set / NATS / Valkey / RustFS | — | ทั้งหมดอยู่ใน `../dokploy-infra` |

`docgen-platform` เองมีแค่ **API + worker + web** (ดู `docker-compose.yml`)

```bash
npm.cmd run dev            # api
npm.cmd run dev:web        # web :3000
npm.cmd run dev:worker     # worker
npm.cmd run dev:shared     # tsc watch ของ shared
npm.cmd run typecheck      # shared + api + worker  (ไม่รวม web!)
npx.cmd tsc --noEmit -p apps/web/tsconfig.json   # web ต้องรันแยก
```

> ⚠️ เครื่องนี้ PowerShell execution policy บล็อก `npm.ps1` → **ใช้ `npm.cmd` / `npx.cmd` เท่านั้น**
> ⚠️ `npm run typecheck` ทำให้ API restart ชั่วคราว → เทสต์แรกหลังจากนั้นอาจได้ 500/ECONNRESET **ต้องรอนิ่งก่อน**

### 1.1 พอร์ตต้องดูจาก `.env` จริง ไม่ใช่เดา

`.env` คือ source of truth (ห้าม commit แต่อ่านได้)

```bash
Select-String -Path .env -Pattern '^API_PORT|^DOCSERVER_URL'   # อ่านเฉพาะบรรทัดพอร์ต
```

> ⚠️ **เพิ่งเจอ (2026-10-03):** `.env.example` เขียน `API_PORT=4000` ซึ่ง**ชนกับ docserver**
> ค่าจริงคือ 4001 — ถ้าใคร copy ไฟล์ตัวอย่างไปใช้ API จะไปตอบแทน docserver
> เรนเดอร์เอกสารพังทั้งระบบ แก้แล้ว พร้อมเขียนเหตุผลกันไว้ในไฟล์
> **เป็นบทเรียนว่า `.env.example` ก็ต้องตรวจ ไม่ใช่ตัวอย่างที่ถูกต้องโดยอัตโนมัติ**

---

## 2 · กติกาการแก้ไฟล์

### 2.1 ไฟล์โปรเจกต์ = UTF-8 ไม่มี BOM · ขึ้นบรรทัดด้วย LF

ห้ามใช้ `Out-File -Encoding utf8` (PS 5.1) — มันใส่ BOM
แก้ไฟล์เป็นชุดใหญ่ด้วย Node เสมอ:

```js
writeFileSync(p, Buffer.from(src, 'utf8'))          // ไม่มี BOM, คง LF
```

### 2.2 ข้อความไทยในไฟล์ **อ่านด้วย `read` แล้วไม่ byte-exact**

อักขระไทยบางตัว `read` เรนเดอร์แล้วหายไปหนึ่งตัว → `edit` จะ fail ทั้งที่ดูตรงกัน
**ทางแก้ที่ใช้ได้จริง:** เขียนสคริปต์ patch เป็น `.mjs` ใน `logs/` (gitignored) แล้ว splice ด้วย **anchor ที่เป็น ASCII ล้วน**

```js
const i = src.indexOf('  function flashCopied(next:')     // ASCII เท่านั้น
if (i === -1) throw new Error('ไม่เจอ anchor')
if (src.indexOf(anchor, i + 1) !== -1) throw new Error('เจอหลายครั้ง')  // กัน splice ผิดจุด
```

ใส่ guard ทุกครั้ง:

```js
if (src.includes('\r\n')) throw new Error('เจอ CRLF')
if (src.includes('\uFFFD')) throw new Error('เขียนไทยเพี้ยน')
```

### 2.3 ⚠️ ห้ามใส่ backtick ในคอมเมนต์ไทยของสคริปต์ patch `.mjs`

สคริปต์ patch เอา CSS/JS ไปวางใน **template literal**
คอมเมนต์ที่มี `` `code` `` จะ**ตัด string ทิ้งทันที** แล้วได้ `SyntaxError: missing ) after argument list`

```
ไฟล์: logs/xxx.mjs
  `/**
   * บั๊ก: กฎ .tpllist td { display: block } ชนะ   ← เขียนแบบนี้
   * กับ .tplrow__thumb { display: none }            ← ไม่ต้องใส่ ` เด็ดขาด
   */`
```

> เจอ 3 รอบในงานเดียว — **เขียนคอมเมนต์ใน patch script โดยไม่ใช้ backtick เลย**
> ถ้าจำเป็นต้องโค้ต ก็เขียนเป็น `'code'` หรือไม่โค้ตเลย

### 2.4 ไฟล์ `.cmd` ต้องเป็น CRLF และใช้ `&` ไม่ใช่ `;`

`cmd.exe` ใช้ `&` เป็นตัวคั่น ถ้าส่ง `"a; b"` ผ่าน `Start-Process` ทั้งชุดจะถูก quote
เป็น argument เดียว แล้ว `node` ได้ชื่อไฟล์ท้ายด้วย `;` → `Cannot find module '...tools/test-x.mjs;'`

```powershell
# 1. เขียน logs/run-x.cmd (หนึ่งคำสั่งต่อบรรทัด)
# 2. แปลงเป็น CRLF
$p='D:\2docx.com\docgen-platform\logs\run-x.cmd'
$t=[System.IO.File]::ReadAllText($p); $t=($t -replace "`r`n","`n") -replace "`n","`r`n"
[System.IO.File]::WriteAllText($p,$t,(New-Object System.Text.UTF8Encoding $false))
# 3. รันแบบ detached (ไม่ผูกกับ task — เครื่องนี้ task ตายที่ 1 ชม.)
Start-Process -FilePath cmd.exe -ArgumentList "/c","logs\run-x.cmd" -WorkingDirectory 'D:\2docx.com\docgen-platform' -WindowStyle Hidden
```

### 2.5 PowerShell

| ห้าม | ใช้แทน |
|---|---|
| `npm` / `npx` | `npm.cmd` / `npx.cmd` |
| `&&` | `;` แล้วเช็ค `$LASTEXITCODE` |
| `cd X; [System.IO.File]::ReadAllText('logs/a')` | **path ต้องเป็น absolute** — `.NET` ใช้ CWD ของ process ไม่ใช่ของ PowerShell |
| `curl -s -o NUL -w ...` | `curl` บนเครื่องนี้เป็น **alias ของ `Invoke-WebRequest`** → ใช้ `Invoke-WebRequest -UseBasicParsing` |
| `node -e "..."` ที่มี quote ซ้อน | เขียนเป็น `logs/xxx.mjs` เสมอ (PS กัด backtick/quote) |
| `Remove-Item` / `rm` ใน if | `rm -- "<path>"` **ต้องเป็นคำสั่ง top-level เดี่ยว ๆ** (ฝังใน `if` แล้ว policy block) |

---

## 3 · เทสต์ (สำคัญที่สุด)

### 3.1 รันยังไง

```bash
node --env-file=.env tools/test-xxx.mjs
```

`tools/lib/` มีตัวช่วยใช้ซ้ำ:
- `canvas-drawn.mjs` → `canvasDrawnJs()` คืน JS string สำหรับ `waitFor` ว่า pdf.js วาดจบแล้ว
- `pick-template.mjs` → `TEST_TEMPLATES`, `pickTemplate(headers, names)`, `keyOf(tpl)`
- `studio-seed.mjs` → `snapshotForm`, `restoreForm`, `importTags`, `FILL_FIELDS_JS`

รันหลายชุด → เขียนเป็น `logs/run-x.cmd` (§2.4) แล้วรัน detached
log เขียนลง `logs/x.log` (gitignored) แล้วอ่านด้วย `[System.IO.File]::ReadAllText`

### 3.2 ⚠️ คิว NATS — เทสต์เรนเดอร์ตกไม่ใช่แปลว่าโค้ดพัง

**อาการ:** เทสต์ที่ต้องเรนเดอร์เอกสาร (`test-download-pages` `test-preview-ui` `test-fit-page` `test-preview-layout`) ตกตั้งแต่ข้อแรก `✗ เรนเดอร์สำเร็จและ pdf.js วาดเสร็จ` แล้วไหลตามมาว่าไม่มี `.docpage`/canvas

**สาเหตุ:** worker `msg.nak(2_000)` เอกสารที่ถูกลบ → วนกลับมาทั้งสตรีม งานใหม่เลยคิวหลังของเก่า
(เจอจริงใน `logs/worker.log` ว่ามีหมื่นบรรทัด `ยังไม่เจอเอกสารใน Mongo — ขอ NATS ส่งซ้ำ`)

**กติกา:** เจออาการนี้ → **รันซ้ำก่อน** ถ้ารอบสองผ่าน = ไม่ใช่ regression

### 3.3 ⚠️ ห้ามแก้ไฟล์ขณะเทสต์กำลังรัน

Next dev recompile กลางคัน → เทสต์ที่กำลังวิ่งตก
และถ้าแก้ไฟล์**หลัง**ชุดเทสต์นั้นรันไปแล้ว (แม้แต่บรรทัดว่างใน CSS)
**ต้องรันชุดที่กระทบซ้ำอีกครั้งก่อน commit** เพราะไฟล์ที่ commit ต้องตรงกับไฟล์ที่ผ่านเทสต์จริง

### 3.4 CDP conventions

```js
await send('Network.setCacheDisabled', { cacheDisabled: true })   // ต้องมีทุกครั้ง
// ห้ามใช้ element.click() — ใช้เมาส์จริง + ยืนยันว่าไม่มีอะไรบัง
const hit = document.elementFromPoint(x, y)
check('จุดกดโดนปุ่มจริง', !!hit && (hit === el || el.contains(hit)))
await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
// รอเงื่อนไขจริง ไม่ใช่ sleep ตายตัว
await waitFor('!!document.querySelector(\'.dl__btn\')', 45_000)
```

`send()` ต้องมี timeout · ลำดับปิดเทสต์: **`Browser.close` → `chrome.kill()` → `ws.close()`**
(ถ้าปิด socket ก่อน `Browser.close` จะไม่มีวันได้คำตอบ = ค้างถาวร)

### 3.5 กฎความสะอาดของเทสต์

- เทสต์ที่**แก้ฟอร์มแม่แบบ** → ห้ามกดบันทึก · ต้อง `snapshotForm` ก่อนและ `restoreForm` เสมอ
  (คืนทีเดียวตอนจบ ไม่ใช่ทีละตัวในลูป เพราะการคืนกลางลูปจะไปแตะพรีวิวที่เพิ่งได้)
- เทสต์ที่แตะสิทธิ์แม่แบบจริง → ต้องล้าง `template_access` ผ่าน Mongo (ไล่หา primary ด้วย `resolveMongoUrl()`)
- เทสต์ที่สร้างบุ๊กมาร์ก/เอกสาร → เก็บกวาดตัวเองเสมอ และ**ต้องตรวจผลการเก็บกวาดด้วย**
- **ห้ามเลือกแม่แบบด้วย `items[0]`** → ใช้ `pickTemplate(H, [ชื่อ])` เสมอ
- นับไฟล์ที่**เพิ่งโผล่** ไม่ใช่ทั้งโฟลเดอร์ (โฟลเดอร์เดียวกันถูกใช้ซ้ำหลายชุด → เห็นของเก่าปน)
- กดปุ่มต้องคืนสถานะเดิมเสมอ ไม่งั้นรอบถัดไปเจอหน้าที่ไม่ใช่ของมัน

### 3.6 ⚠️ ชื่อแม่แบบไม่บอกจำนวนหน้า

`TEST_TEMPLATES.onepage = 'มีเลขที่หนังสือ'` → จริง ๆ ออกมา **3 หน้า**
เกณฑ์ที่ผูกกับจำนวนหน้า ต้อง**เรนเดอร์แล้ววัดจริง** ไม่ใช่เดาจากชื่อ
(ถ้าเป็นเงื่อนไขของฟีเจอร์ ให้ loop ลองทีละตัวจนกว่าจะเจอตัวที่ตรง)

### 3.7 ชุดเทสต์ที่ใช้บ่อย

| ไฟล์ | ตรวจอะไร | ผ่านล่าสุด |
|---|---|---|
| `test-list-mobile.mjs` | หน้ารายการบนมือถือ + แถบแท็บ 390px | 74 |
| `test-download-pages.mjs` | เลือกหน้า + ดาวน์โหลด PNG/ZIP | 74 |
| `test-share-url.mjs` | แชร์/สิทธิ์/ปุ่มคัดลอก/popup | 53 |
| `test-studio-ui.mjs` | โครง Studio ทั้งหน้า | 30 |
| `test-list-tabs-url.mjs` | แท็บ + URL สะท้อนสถานะ | 29 |
| `test-editor-bookmark.mjs` | ปุ่มดาว + แถบแท็บมือถือ | 27 |
| `test-nav-status.mjs` | แถบสถานะ + ช่องคัดลอก URL | 26 |
| `test-editor-panes.mjs` | สองคอลัมน์ + `?tabs=&pane=` | 24 |
| `test-preview-api.mjs` | REST ของรูปตัวอย่าง | 23 |
| `test-list-view.mjs` | สวิตช์ ชิด/รายการ | 22 |
| `test-row-owner.mjs` | ปุ่มลบ/สำเนาตามสิทธิ์ | 22 |
| `test-preview-ui.mjs` | การ์ดตัวอย่างบนจอ | 21 |

> ตัวเลขนี้เป็นของรอบ 2026-10-03 — ถ้าเพิ่มข้อตรวจจะมากขึ้น

---

## 4 · CSS — กับดักที่เจอจริง

### 4.1 specificity คือทุกอย่าง

**media query ไม่ได้เพิ่มน้ำหนัก specificity**

```css
@media (max-width: 720px) {
  .tpllist td { display: block; }              /* (0,1,1) */
  .tpllist td.tplrow__thumb { display: none; }  /* (0,2,1) ชนะข้างบน ✓ */
}
```

กฎสองข้อที่ **specificity เท่ากัน** ใน media query ต้องเรียงลำดับให้ถูก
และกฎที่ต้อง "คืนค่าเดิม" ต้องมาทีหลังเสมอ

### 4.2 `td:last-child` อันตรายกว่าคลาส

เพิ่มคอลัมน์ต่อท้ายแล้ว `last-child` เปลี่ยนตัวทันที
กฎจอแคบเดิมเขียน `td:last-child button { min-height: 36px }` → หลุดไปตกที่ช่องรูปใหม่
**ปุ่มจัดการเสียพื้นที่นิ้วขั้นต่องไปเงียบ ๆ ไม่มี error**

> บั๊กนี้หลุดมาตลอดเพราะเทสต์วัดที่จอกว้าง ซึ่งกฎจอแคบไม่ทำงาน
> **กติกา: เกณฑ์ที่ผูกกับ media query ต้องมีข้อตรวจที่ความกว้างที่กระทบ**

### 4.3 `display: contents`

ใช้ให้ลูก ๆ เป็น flex/grid item ของพ่อโดยตรง
**ถ้าตัดทิ้ง ลูกทั้งหมดจะถูกยุบเหลือช่องเดียว** และ `margin-left:auto` / `gap` ของพ่อจะหยุดทำงาน

### 4.4 `position: fixed` ถูกดักได้

ถ้าบรรพบุรุษมี `transform` / `filter` / `backdrop-filter` / `will-change` / `contain: paint`
→ `fixed` จะถูกผูกกับ**การ์ดนั้น**แทนหน้าจอ แล้ว `overflow` ของการ์ดจะตัด popup ทิ้ง
แก้แล้วเขียน guard ไว้กัน (ดู `test-share-url` หัวข้อ 4c)

### 4.5 กฎ `button { color: #fff }` ของโปรเจกต์

component ที่ override สีต้อง**กำหนด `color` เองเสมอ** ไม่งั้นกลายเป็นขาวบนพื้นขาว

### 4.6 กฎประจำโปรเจกต์

- scope กฎตารางด้วย `.tpllist` เสมอ (ตารางใน `HistoryPanel` ยังต้องเป็นตาราง)
- **`.tpllist--grid tr` (การ์ดแม่แบบโหมดชิด) มี `overflow: hidden`**
  → ปุ่มที่ล้นออกไปจะ**ถูกตัดจนกดไม่ได้** ไม่ใช่แค่ "ต้องเลื่อนไปดู"
  `.previews__item` (การ์ดรูปย่อ) ก็เหมือนกัน
  ส่วน `.card` **ไม่มี** `overflow: hidden` — ตรวจซ้ำทุกครั้งที่จะวางอะไรลอย เพราะถ้ามีคนเพิ่มเอง
  ทุกอย่างแบบ `absolute` จะโผล่เงียบ ๆ (จึงต้องมี guard ในเทสต์ ดู §4.4)
- ปุ่มจัดการในแถว: จอ ≤720px ต้องสูง ≥36px (พื้นที่นิ้วขั้นต่ำ WCAG 2.5.8)
- ไอคอนในปุ่มทำเป็น CSS `::before` **ไม่ใช่ `<span>` ใน DOM**
  เพราะเทสต์หลายชุดเลือกปุ่มด้วย `textContent.trim() === 'เปิด'`
  ถ้าใส่ `<span>` จะกลายเป็น `"📂เปิด"` แล้วทุกชุดต้องแก้ selector พร้อมกัน = เทสต์เงียบกว่าที่ควร

---

## 5 · React — กับดักที่เจอจริง

### 5.1 วัดตำแหน่งหลัง DOM อัปเดตเสมอ

```tsx
function flashCopied() {
  setCopied(next)       // React ยังไม่ commit
  measurePop()          // ← วัดได้ค่าปุ่ม**ป้ายเก่า**
}
useEffect(() => { if (!copied) return; re() }, [copied])   // ← วัดซ้ำตรงนี้
```

อาการ: ปุ่มเปลี่ยนป้าย "คัดลอกลิงก์" → "คัดลอกแล้ว ✓" ทำให้**ปุ่มกว้างขึ้น**
กึ่งกลางขยับ → popup ที่วางไว้เลื่อนตามไป 8px (เจอจริงตอนทดสอบ)

### 5.2 อย่าให้ live region ซ้ำซ้อน

เดิมปุ่มคัดลอกมี `aria-live="polite"` เพราะ Banner อยู่ไกลจนใช้ไม่ได้
พอมี popup ติดปุ่มแล้ว ต้อง**ถอด `aria-live` ออกจากปุ่ม** แล้วให้ `role="status"` ที่ popup
ไม่งั้น screen reader อ่านสองข้อความพร้อมกัน

### 5.3 ตัดข้อความออกจากปุ่ม = ต้องย้ายความหมาย

ถ้าตัดป้าย "ชิด/รายการ" ออก (ผู้ใช้สั่ง *"ไม่ต้องใส่ข้อความ"*)
ต้องย้ายเป็น `title` + `aria-label` ไม่งั้นปุ่มไร้ชื่อทั้งสองทาง

---

## 6 · Git

```
repo root : D:\2docx.com          ← ไม่ใช่ docgen-platform
branch    : feat/docgen-platform-studio   (push ที่นี่ที่เดียว)
```

- commit **แยกตามงาน** · ห้าม commit `.env` / secret
- **commit ภาพหน้าจอที่เทสต์สร้างด้วย** (convention โปรเจกต์) — `tests/nav-status/output-*/`
- untracked นอกขอบเขตที่**ต้องปล่อยไว้ ไม่ต้องแตะ**:
  `../docserver_replace_image.py`, `../dokploy-infra/`, `../output-example/`, `../tools/doc_pipeline.py`
- ห้ามสร้างไฟล์นอก `docgen-platform/`

### 6.1 แยก commit ในไฟล์เดียว (`git add -p` ใช้ไม่ได้)

```bash
cmd /c "git --no-pager diff -U3 -- <ไฟล์> > logs/x.diff"   # ห้ามใช้ Out-File (BOM+CRLF)
# แยก hunk ด้วย Node → เขียน logs/x-a.patch / x-b.patch (ต้องมี trailing newline)
git apply --cached logs/x-a.patch
git add <ไฟล์อื่นของงานนั้น>
git commit -F logs/msg.txt
```

### 6.2 ข้อความ commit ภาษาไทยเพี้ยนตอน commit

`git commit -m "…ไทย…"` ผ่าน PowerShell แล้ว encoding เพี้ยน
เขียนข้อความลง `logs/msg.txt` แล้วใช้ `System.Diagnostics.ProcessStartInfo` (UTF-8) แทน

---

## 7 · API / ข้อมูล — กฎที่ต้องจำ

- **ห้ามส่ง `content-type: application/json` กับ DELETE ที่ไม่มี body** → Fastify 500 (`FST_ERR_CTP_EMPTY_JSON_BODY`)
- กติกาสิทธิ์แม่แบบไม่ใช่แค่ `relation === 'owner'`:
  **เจ้าของ หรือ แม่แบบที่ยังไม่มีเจ้าของ** (กติกา "คนแรกที่กดเป็นเจ้าของ")
  ถ้าเช็คแค่ owner แม่แบบเก่าจะลบจากหน้ารายการไม่ได้เลย → รวมเป็น `canDeleteTemplate(view)` จุดเดียว
- `POST /api/templates` ส่ง `id` → 502 · `PATCH /api/templates/:id` ส่ง `id` แต่ Carbone ต้องการ `versionId` → 404
- docserver หลัง `POST /replace` สำเร็จ `GET /api/templates` ยังชี้ `versionId` เดิม (Carbone ไม่มีประวัติเวอร์ชัน)
- RustFS ไม่มี CORS → ส่งรูปผ่าน API เป็นตัวกลาง อย่าใช้ presigned URL ตรง (ชี้ endpoint ภายในผ่าน tailnet)
- ตรวจชนิดไฟล์จาก**ไบต์จริง** (`sniffImage`) ไม่เชื่อ `Content-Type` ที่ client ส่ง — กัน stored XSS
- `resolveMongoUrl()` — primary ของ replica set เคยย้ายไป `127.0.0.1:27019`

---

## 8 · สิ่งที่ยังค้าง (อย่าแก้เอง ให้ถามผู้ใช้ก่อน)

1. แม่แบบ `.xlsx` เรนเดอร์เป็น PDF ไม่ผ่าน + หน้าแก้ไขค้างจน `Page.navigate` timeout (backfill ได้ 7/10) — ต้องคิดก่อนว่าภาพย่อของตารางควรมาจากไหน
2. สำเนา 3 — ย่อหน้าเนื้อหาหลัก 537 ตัวอักษรไม่มี `w:jc` (รอผู้ใช้ตัดสินใจ)
3. ย้ายเจ้าของย้อนหลัง 21 แม่แบบ · แม่แบบ `1522001636999175194` หายถาวร
4. **หมุน Casdoor client secret** — ถูกเปิดเผยในแชทแล้ว
5. เรื่อง พ.ศ. (`:add(543)`) · `.odt` ยังไม่ตั้ง `fo:language` / `lang: 'th-TH'`
6. Next dev overlay badge "N 1 Issue"
   สืบแล้ว (2026-10-05) — **ไม่ reproduce** ทั้ง `/` และ `/studio`: console ไม่มี
   error/warning เลย (มีแต่ข้อความ React DevTools ปกติ) ไม่มีป้ายใน shadow DOM
   ของ `nextjs-portal` และ `tsc --noEmit` ของเว็บผ่าน · น่าจะเป็น error ชั่วคราว
   ตอน session อื่นแก้โค้ดอยู่ · ถ้ากลับมาให้จับ console ก่อน ไม่ต้องเดา
7. ไฟล์ชั่วคราวใน `.git/` ลบไม่ได้ (permission gate) — ไม่ถูก track

---

## 9 · บันทึกบทเรียน (เพิ่มทุกครั้งที่พลาด)

เจออะไรแปลก ๆ ให้ถาม 3 ข้อก่อนจบงาน:

1. **ทำไมถึงหลุด?** — บั๊กที่ไม่มี error ต้องเขียนกันไว้ในโค้ดด้วย ไม่ใช่แค้แก้
2. **เทสต์ไหนควรจับได้แต่จับไม่ได้?** — ถ้าไม่รู้ ก็ยังไม่มีกันดัก
3. **คอมเมนต์นี้ควรอยู่ที่ไหน?** — README (ระบบคืออะไร) · BAND (ทำอย่างไร) · โค้ด (ทำไมแบบนี้)

### บั๊กที่เจอในรอบ 2026-10-03 — ตัวอย่างว่าข้อ 1 หมายถึงอะไร

| อาการที่ผู้ใช้เจอ | ต้นเหตุจริง | กันไว้ที่ไหน |
|---|---|---|
| ปุ่มจัดการบนจอแคบเล็กจนกดไม่สบาย (20px) | `td:last-child` เปลี่ยนตัวหลังเพิ่มคอลัมน์ภาพย่อ → `min-height:36px` หาย | `globals.css` + `test-list-mobile` |
| เลือก "รายการ" แล้วยังเห็นรูป | `td { display:block }` ใน media query ชน `display:none` ของช่องรูป | `globals.css` + `test-list-mobile` (probe ดู `thumbShown`) |
| popup เลื่อนตามปุ่มไป 8px | วัดตำแหน่งก่อน React commit ปุ่มยังเป็นป้ายเก่า | `measurePop()` + `useEffect` วัดซ้ำ |
| ภาพย่อ 0×0 เทสต์ตก | คิว NATS ค้างจากเอกสารที่ถูกลบแล้ว `nak` วนกลับ | `logs/worker.log` + กติการันซ้ำ §3.2 |
| `SyntaxError` ใน patch script | backtick ในคอมเมนต์ไทนอก template literal | §2.3 |
| "มีเลขที่หนังสือ" ไม่ใช่แม่แบบ 1 หน้า | ชื่อไม่ได้บอกจำนวนหน้า | §3.6 |
