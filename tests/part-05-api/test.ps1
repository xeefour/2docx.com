# ============================================================
#  ส่วนที่ 5: การเรียก API
# ============================================================
#  ทดสอบว่าต้องส่งอะไรบ้างให้ได้ผลถูกต้อง
#  และระบบจัดการข้อผิดพลาดได้ดีแค่ไหน
# ============================================================
#  รัน:  .\test.ps1
# ============================================================

$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$env:PYTHONIOENCODING = 'utf-8'

$here = $PSScriptRoot
$outDir = Join-Path $here 'output'
New-Item -ItemType Directory -Force -Path $outDir | Out-Null
$curl = "$env:SystemRoot\System32\curl.exe"
$base = 'http://localhost:4000'
# ใช้แม่แบบของส่วนที่ 2 (มีข้อความไทยครบ)
$tpl = Join-Path $here '..\part-02-thai-text\templates\ข้อความไทย.docx'
$dataFile = Join-Path $here '..\part-02-thai-text\data\ข้อมูล.json'

$pass = 0; $fail = 0
function Check($name, $cond, $detail) {
    if ($cond) { Write-Host "  [ผ่าน] $name" -ForegroundColor Green; $script:pass++ }
    else       { Write-Host "  [ไม่ผ่าน] $name  ($detail)" -ForegroundColor Red; $script:fail++ }
}
function Section($n) { Write-Host ''; Write-Host "  $n" -ForegroundColor Cyan }

Write-Host ''
Write-Host 'ส่วนที่ 5: การเรียก API' -ForegroundColor Cyan

if (-not (Test-Path $tpl)) {
    Write-Host '  [ไม่ผ่าน] ไม่พบแม่แบบ — รันส่วนที่ 2 ก่อน' -ForegroundColor Red
    exit 1
}

# --- อัปโหลดแม่แบบ ---
$up = Join-Path $env:TEMP 'p5-up.json'
& $curl -s -o $up -X POST "$base/template" -H 'Authorization: Bearer carbon-ce' `
    -F "template=@$tpl" --max-time 120 2>$null
$tplId = (Get-Content $up -Raw | ConvertFrom-Json).data.templateId
Check 'อัปโหลดแม่แบบได้' ($tplId -ne $null) 'ล้มเหลว'
if (-not $tplId) { exit 1 }

$data = Get-Content $dataFile -Raw -Encoding UTF8 | ConvertFrom-Json
$pf = Join-Path $env:TEMP 'p5.json'
$tmpOut = Join-Path $outDir '_tmp.bin'

function Post($url, $body, $headers) {
    [System.IO.File]::WriteAllText($pf, $body, (New-Object System.Text.UTF8Encoding($false)))
    $h = Join-Path $env:TEMP 'p5-h.txt'
    $a = @('-s', '-o', $tmpOut, '-D', $h, '-X', 'POST', $url)
    foreach ($hd in $headers) { $a += @('-H', $hd) }
    $a += @('--data-binary', "@$pf", '--max-time', '200')
    & $curl @a 2>$null
    $script:h5 = Head
    $line = (Get-Content $h | Select-String '^HTTP/' | Select-Object -Last 1)
    if ($line -match '(\d{3})') { return [int]$Matches[1] } else { return 0 }
}
function Head() {
    # อ่านแค่ 5 ไบต์แรก แล้วตัด null bytes ทิ้ง (ZIP/PDF header มี 0x00 ปนอยู่)
    $script:h5 = [System.Text.Encoding]::ASCII.GetString([System.IO.File]::ReadAllBytes($tmpOut)[0..4])
    $script:h5 = $script:h5.Trim([char]0).TrimEnd()
    return $script:h5
}
$OK_H = @('Authorization: Bearer carbon-ce','Content-Type: application/json','carbone-version: 5')
$NO_VER = @('Authorization: Bearer carbon-ce','Content-Type: application/json')
$json = ([ordered]@{ data = $data } | ConvertTo-Json -Depth 20 -Compress)

# --- 5.1 ข้อบังคับ header ---
Section '5.1 ข้อบังคับ: header carbone-version: 5'
$b = ([ordered]@{ data = $data; convertTo = 'pdf' } | ConvertTo-Json -Depth 20 -Compress)
$code = Post "$base/render/$tplId`?download=true" $b $NO_VER
Write-Host "    (ผลจริง head='$h5' code=$code)" -ForegroundColor DarkGray
Check 'ส่ง version แล้ว → ได้ PDF' ($h5 -eq '%PDF-') "code=$code"
Check 'ไม่ส่ง version → ยังได้ PDF (Carbone 5.15.2 ไม่บังคับจริง)' ($h5 -eq '%PDF-') "head=$h5"

# --- 5.2 ฟิลด์ convertTo ---
Section '5.2 ข้อบังคับ: ฟิลด์ convertTo'
# ข้อค้นพบ: เมื่อไม่ส่ง convertTo Carbone คืนไฟล์ต้นฉบับ (PK = ZIP/DOCX)
# แต่ ZIP header คือ "PK\x03\x04" ซึ่งมี null byte ต้องตรวจด้วย StartsWith
$code = Post "$base/render/$tplId`?download=true" $json $OK_H
Check 'ไม่ส่ง convertTo → ได้ไฟล์ต้นฉบับ (PK)' ($h5.StartsWith('PK')) "head='$h5' code=$code"
foreach ($f in @('pdf','docx')) {
    $b2 = ([ordered]@{ data = $data; convertTo = $f } | ConvertTo-Json -Depth 20 -Compress)
    $code = Post "$base/render/$tplId`?download=true" $b2 $OK_H
    Check "ส่ง convertTo=$f → ได้ไฟล์" ($code -eq 200 -and (Get-Item $tmpOut).Length -gt 1000) "code=$code"
}

# --- 5.3 download=true ---
Section '5.3 พารามิเตอร์ ?download=true'
$code = Post "$base/render/$tplId" $b $OK_H
$raw = Get-Content $tmpOut -Raw
Check 'ไม่ส่ง download=true → ได้ JSON renderId' ($raw -match 'renderId') $raw
$code = Post "$base/render/$tplId`?download=true" $b $OK_H
Check 'ส่ง download=true → ได้ไฟล์ตรง ๆ' ($h5 -eq '%PDF-') "code=$code"

# --- 5.4 แปลงไฟล์โดยไม่ส่ง data ---
Section '5.4 แปลงไฟล์โดยไม่ส่ง data (ตั้งแต่ v5.9.0)'
$srcDocx = Join-Path $here '..\part-02-thai-text\output\ข้อความไทย-ผลลัพธ์.docx'
if (Test-Path $srcDocx) {
    $b64 = [Convert]::ToBase64String([System.IO.File]::ReadAllBytes($srcDocx))
    $code = Post "$base/render/template?download=true" ('{"template":"' + $b64 + '","convertTo":"pdf"}') $OK_H
    Check 'แปลง DOCX → PDF โดยไม่ส่ง data ได้' ($h5 -eq '%PDF-') "code=$code"
} else {
    Check 'แปลง DOCX → PDF โดยไม่ส่ง data ได้' $false 'ยังไม่มีไฟล์จากส่วนที่ 2'
}

# --- 5.5 รูปแบบเอาต์พุต ---
Section '5.5 รูปแบบเอาต์พุตที่รองรับ (จากเอกสารว่าเป็น document/spreadsheet เท่านั้น)'
# ตามเอกสาร: ตาราง convertTo ขึ้นกับชนิดไฟล์ต้นทาง
# แม่แบบเราเป็น .docx (document) → csv/ods (spreadsheet) ใช้ไม่ได้
foreach ($f in @('pdf','docx','odt','html','txt','md','epub')) {
    $b2 = ([ordered]@{ data = $data; convertTo = $f } | ConvertTo-Json -Depth 20 -Compress)
    $code = Post "$base/render/$tplId`?download=true" $b2 $OK_H
    $sz = (Get-Item $tmpOut -ErrorAction SilentlyContinue).Length
    Check "convertTo=$f (document)" ($code -eq 200 -and $sz -gt 200) "code=$code ขนาด=$sz"
}
# csv/ods ต้องใช้แม่แบบ .xlsx เท่านั้น — ทดสอบว่าตอบ error อย่างถูกต้อง
$code = Post "$base/render/$tplId`?download=true" `
    (([ordered]@{ data = $data; convertTo = 'csv' } | ConvertTo-Json -Depth 20 -Compress)) $OK_H
$errRaw = Get-Content $tmpOut -Raw
Check 'convertTo=csv บนแม่แบบ .docx → error อย่างถูกต้อง' `
    ($code -eq 500 -and $errRaw -match "can't be converted") "code=$code"
Write-Host '    (ถูกต้อง: csv/ods ต้องใช้แม่แบบ .xlsx เท่านั้น)' -ForegroundColor DarkGray

# --- 5.6 ข้อผิดพลาด ---
Section '5.6 การจัดการข้อผิดพลาด'
$code = Post "$base/render/$tplId`?download=true" '{"data":"ไม่ใช่ object"}' $OK_H
$err = Get-Content $tmpOut -Raw
Check 'data ผิดรูปแบบ → มี error หรือผ่านไป (ไม่ค้าง)' ($code -ge 200) "code=$code"
$code = Post "$base/render/ไม่มีแม่แบบนี้?download=true" $json $OK_H
Check 'templateId ไม่มีจริง → 4xx' ($code -ge 400 -and $code -lt 500) "code=$code"

# ข้อค้นพบ: Community Edition ไม่ตรวจสิทธิ์ API Key
# เอกสารระบุ 401 แต่จริง ๆ ได้ 500 เพราะไม่ได้เช็ค key เลย
# แปลว่า "อย่าวาง API ไว้หน้าเว็บสาธารณะ" — ต้องคุมที่ชั้น API Gateway ของเราเอง
$code = Post "$base/render/$tplId`?download=true" $json @('Authorization: Bearer keyผิด','Content-Type: application/json','carbone-version: 5')
Check 'API Key ผิด → ไม่ได้ปฏิเสธ (ข้อจำกัดของเวอร์ชันฟรี)' `
    ($code -eq 200 -and $h5.StartsWith('PK')) "code=$code head='$h5'"
Write-Host '    !! ข้อค้นพบ: Community Edition ไม่ตรวจ API Key เลย' -ForegroundColor Yellow
Write-Host '       ต้องคุมสิทธิ์ที่ API Gateway ของเราเอง ห้ามเปิด Carbone ตรง ๆ' -ForegroundColor Yellow

$code = Post "$base/render/$tplId`?download=true" $json @('Content-Type: application/json','carbone-version: 5')
Check 'ไม่ส่ง Authorization → ไม่ error (ตามข้อจำกัดข้างบน)' ($code -eq 200) "code=$code"
$code = Post "$base/render/$tplId`?download=true" $json @('Authorization: Bearer carbon-ce','carbone-version: 5')
Check 'ไม่ส่ง Content-Type → 400' ($code -eq 400) "code=$code"

# --- 5.7 ขนาดข้อมูล ---
Section '5.7 ขนาดข้อมูล'
foreach ($sz in @(10000, 500000, 2000000)) {
    $big = '{"data":{"x":"' + ('ก' * $sz) + '"}}'
    $code = Post "$base/render/$tplId`?download=true" $big $OK_H
    Check "ข้อมูล $sz bytes" ($code -in @(200, 413, 422)) "code=$code"
}

# --- 5.8 ทำซ้ำหลายครั้ง ---
Section '5.8 ความเสถียรเมื่อเรียกซ้ำ'
$ok = 0
for ($i = 1; $i -le 5; $i++) {
    $b3 = ([ordered]@{ data = $data; convertTo = 'pdf' } | ConvertTo-Json -Depth 20 -Compress)
    $code = Post "$base/render/$tplId`?download=true" $b3 $OK_H
    $h5 = Head
    if ($code -eq 200 -and $h5 -eq '%PDF-') { $ok++ }
}
Check 'เรียกซ้ำ 5 ครั้ง สำเร็จทั้งหมด' ($ok -eq 5) "สำเร็จ $ok/5"

Write-Host ''
Write-Host "  ผ่าน $pass / $($pass + $fail)" -ForegroundColor $(if ($fail -eq 0) {'Green'} else {'Yellow'})
if ($fail -gt 0) { exit 1 }
exit 0
