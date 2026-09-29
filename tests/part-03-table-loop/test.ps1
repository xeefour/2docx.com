# ============================================================
#  ส่วนที่ 3: ตารางซ้ำและเงื่อนไข
# ============================================================
#  รัน:  .\test.ps1
# ============================================================

$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$env:PYTHONIOENCODING = 'utf-8'

$here = $PSScriptRoot
$outDir = Join-Path $here 'output'
New-Item -ItemType Directory -Force -Path $outDir | Out-Null
$tpl = Join-Path $here 'templates\ตารางและเงื่อนไข.docx'
$curl = "$env:SystemRoot\System32\curl.exe"
$base = 'http://localhost:4000'

Write-Host ''
Write-Host 'ส่วนที่ 3: ตารางซ้ำและเงื่อนไข' -ForegroundColor Cyan

if (-not (Test-Path $tpl)) {
    Write-Host '  กำลังสร้างแม่แบบ...' -ForegroundColor DarkGray
    & python (Join-Path $here 'make.py') 2>&1 | ForEach-Object { Write-Host "    $_" -ForegroundColor DarkGray }
}
if (-not (Test-Path $tpl)) {
    Write-Host '  [ไม่ผ่าน] สร้างแม่แบบไม่สำเร็จ' -ForegroundColor Red; exit 1
}

$up = Join-Path $env:TEMP 'p3-up.json'
& $curl -s -o $up -X POST "$base/template" -H 'Authorization: Bearer carbon-ce' `
    -F "template=@$tpl" --max-time 120 2>$null
$tplId = (Get-Content $up -Raw | ConvertFrom-Json).data.templateId
if (-not $tplId) { Write-Host '  [ไม่ผ่าน] อัปโหลดไม่สำเร็จ' -ForegroundColor Red; exit 1 }
Write-Host '  อัปโหลดแม่แบบแล้ว' -ForegroundColor DarkGray

$data = Get-Content (Join-Path $here 'data\ข้อมูล.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$pf = Join-Path $env:TEMP 'p3-payload.json'
foreach ($fmt in @('docx', 'pdf')) {
    $b = ([ordered]@{ data = $data; convertTo = $fmt } | ConvertTo-Json -Depth 20 -Compress)
    [System.IO.File]::WriteAllText($pf, $b, (New-Object System.Text.UTF8Encoding($false)))
    $target = Join-Path $outDir "ตารางและเงื่อนไข-ผลลัพธ์.$fmt"
    & $curl -s -o $target -X POST "$base/render/$tplId`?download=true" `
        -H 'Authorization: Bearer carbon-ce' -H 'Content-Type: application/json' `
        -H 'carbone-version: 5' --data-binary "@$pf" --max-time 200 2>$null
}

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
