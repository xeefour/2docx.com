# ============================================================
#  ส่วนที่ 4: รูปภาพ (ฉีดรูปเอง แล้วให้ Carbone แปลง PDF)
# ============================================================
#  รัน:  .\test.ps1
#  หมายเหตุ: Carbone เวอร์ชันฟรีใส่รูปเองไม่ได้ (Enterprise Feature)
#           ส่วนนี้ใช้ตัวฉีดรูปที่เขียนเอง อยู่ใน lib/docx_image_injector.py
# ============================================================

$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$env:PYTHONIOENCODING = 'utf-8'

$here = $PSScriptRoot
$outDir = Join-Path $here 'output'
New-Item -ItemType Directory -Force -Path $outDir | Out-Null
$tpl = Join-Path $here 'templates\รูปภาพ.docx'
$curl = "$env:SystemRoot\System32\curl.exe"
$base = 'http://localhost:4000'

Write-Host ''
Write-Host 'ส่วนที่ 4: รูปภาพ' -ForegroundColor Cyan

# --- สร้างแม่แบบถ้ายังไม่มี ---
if (-not (Test-Path $tpl)) {
    Write-Host '  กำลังสร้างแม่แบบและรูปทดสอบ...' -ForegroundColor DarkGray
    & python (Join-Path $here 'make.py') 2>&1 | ForEach-Object { Write-Host "    $_" -ForegroundColor DarkGray }
}
if (-not (Test-Path $tpl)) { Write-Host '  [ไม่ผ่าน] สร้างแม่แบบไม่สำเร็จ' -ForegroundColor Red; exit 1 }

# --- 1) ฉีดรูปด้วยตัวฉีดที่เขียนเอง ---
Write-Host ''
Write-Host '  [ฉีดรูปด้วยตัวฉีดที่เขียนเอง]' -ForegroundColor DarkGray
$injScript = Join-Path $here 'inject.py'
& python $injScript 2>&1 | ForEach-Object { Write-Host "    $_" -ForegroundColor DarkGray }
$injected = Join-Path $outDir 'ฉีดรูป.docx'
if (-not (Test-Path $injected)) {
    Write-Host '  [ไม่ผ่าน] ฉีดรูปไม่สำเร็จ' -ForegroundColor Red; exit 1
}

# --- 2) ให้ Carbone แปลงเป็น PDF ---
$pdfOut = Join-Path $outDir 'รูปภาพ-ผลลัพธ์.pdf'
$b64 = [Convert]::ToBase64String([System.IO.File]::ReadAllBytes($injected))
$pf = Join-Path $env:TEMP 'p4.json'
[System.IO.File]::WriteAllText($pf, ('{"template":"' + $b64 + '","convertTo":"pdf"}'),
    (New-Object System.Text.UTF8Encoding($false)))
& $curl -s -o $pdfOut -X POST "$base/render/template?download=true" `
    -H 'Authorization: Bearer carbon-ce' -H 'Content-Type: application/json' `
    -H 'carbone-version: 5' --data-binary "@$pf" --max-time 200 2>$null

# --- 3) ตรวจผล ---
$out = & python (Join-Path $here 'check.py') 2>&1
$res = $out | Select-String '@@RESULT'
$out | Where-Object { $_ -notmatch '@@RESULT' } | ForEach-Object { Write-Host "  $_" }
if ($res) {
    $n = $res -split '\s+'
    $pass = [int]$n[1]; $total = [int]$n[2]
    Write-Host ''
    Write-Host "  ผ่าน $pass / $total" -ForegroundColor $(if ($pass -eq $total) {'Green'} else {'Yellow'})
    if ($pass -eq $total) { exit 0 }
}
exit 1
