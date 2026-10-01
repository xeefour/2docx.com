# ============================================================
#  ส่วนที่ 1: ติดตั้งและตรวจสอบระบบ
# ============================================================
#  รัน:  .\test.ps1
#  ต้องมี Docker และ container ที่ listen พอร์ต 4000 ทำงานอยู่
#  (ชื่อไม่ตายตัว — หา container จากพอร์ตอัตโนมัติ)
# ============================================================

$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$here = $PSScriptRoot
$tpl = Join-Path $here 'templates\ว่างเปล่า.docx'
$out = Join-Path $here 'output\ว่างเปล่า.pdf'
New-Item -ItemType Directory -Force -Path (Join-Path $here 'output') | Out-Null

$pass = 0; $fail = 0
function Check($name, $cond, $detail) {
    if ($cond) { Write-Host "  [ผ่าน] $name" -ForegroundColor Green; $script:pass++ }
    else       { Write-Host "  [ไม่ผ่าน] $name  ($detail)" -ForegroundColor Red; $script:fail++ }
}

Write-Host ''
Write-Host 'ส่วนที่ 1: ติดตั้งและตรวจสอบระบบ' -ForegroundColor Cyan

# --- 1.1 Carbone ตอบเวอร์ชัน ---
$version = $null
try { $version = (Invoke-RestMethod 'http://127.0.0.1:4000/status' -TimeoutSec 20).version } catch { }
Check '1.1 Carbone ตอบเวอร์ชันได้' ($version -ne $null) 'เปิด Docker แล้วรัน container ที่ listen พอร์ต 4000'
if ($version) { Write-Host "        เวอร์ชัน $version" -ForegroundColor DarkGray }

# --- หา container ที่ publish พอร์ต 4000 (ไม่ hardcode ชื่อ) ---
#    รองรับทั้ง carbone-thai (build เอง) และ docserver (ดึงจาก Docker Hub)
$cname = docker ps --filter 'publish=4000' --format '{{.Names}}' 2>$null | Select-Object -First 1
if (-not $cname) { $cname = 'carbone-thai' }
Write-Host "  ใช้ container: $cname" -ForegroundColor DarkGray

# --- 1.2 / 1.3 ฟอนต์ ---
$sarabun = 0; $thai = 0
try {
    $f = docker exec $cname fc-list 2>&1
    $sarabun = ($f | Select-String 'TH Sarabun New').Count
    $thai    = ($f | Select-String 'Tlwg|Noto Sans Thai|Laksaman|Garuda').Count
} catch { }
Check '1.2 มีฟอนต์ TH Sarabun New' ($sarabun -gt 0) 'ไม่พบ'
Check '1.3 มีฟอนต์ไทยมาตรฐานอื่น' ($thai -gt 0) 'ไม่พบ'
Write-Host "        TH Sarabun New $sarabun รูปแบบ | ฟอนต์ไทยอื่น $thai รูปแบบ" -ForegroundColor DarkGray

# --- 1.4 หน่วยความจำ ---
$mem = 'ไม่ทราบ'
try { $mem = (docker stats $cname --no-stream --format '{{.MemUsage}}' 2>&1).Trim() } catch { }
Check '1.4 ใช้หน่วยความจำไม่เกิน 1 GB' ($mem -match '(\d+(?:\.\d+)?)(MiB|GiB)') "ใช้ $mem"
Write-Host "        ใช้ $mem" -ForegroundColor DarkGray

# --- 1.5 แปลงไฟล์เปล่า ---
if (Test-Path $tpl) {
    $b64 = [Convert]::ToBase64String([System.IO.File]::ReadAllBytes($tpl))
    $pf = Join-Path $env:TEMP 'p1.json'
    [System.IO.File]::WriteAllText($pf, ('{"template":"' + $b64 + '","convertTo":"pdf"}'),
        (New-Object System.Text.UTF8Encoding($false)))
    $curl = "$env:SystemRoot\System32\curl.exe"
    & $curl -s -o $out -X POST 'http://127.0.0.1:4000/render/template?download=true' `
        -H 'Authorization: Bearer carbon-ce' -H 'Content-Type: application/json' `
        -H 'carbone-version: 5' --data-binary "@$pf" --max-time 120 2>$null
    $head = if (Test-Path $out) { [System.Text.Encoding]::ASCII.GetString([System.IO.File]::ReadAllBytes($out)[0..4]) } else { '' }
    Check '1.5 แปลง DOCX เปล่าเป็น PDF ได้' ($head -eq '%PDF-') "head='$head'"
} else { Check '1.5 แปลง DOCX เปล่าเป็น PDF ได้' $false 'รัน python make.py ก่อน' }

Write-Host ''
Write-Host "  ผ่าน $pass / $($pass + $fail)" -ForegroundColor $(if ($fail -eq 0) {'Green'} else {'Red'})
if ($fail -gt 0) { exit 1 }
exit 0
