# ============================================================
#  ส่วนที่ 8: เอกสารจริงแบบครบวงจร
# ============================================================
#  รัน:  .\test.ps1
#  ทดสอบงานจริง: รับข้อมูล → ฉีดรูป → เติมข้อความ → แปลง PDF
# ============================================================

$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$env:PYTHONIOENCODING = 'utf-8'

$here = $PSScriptRoot
$tpl = Join-Path $here 'templates\หนังสือราชการ.docx'

Write-Host ''
Write-Host 'ส่วนที่ 8: เอกสารจริงแบบครบวงจร' -ForegroundColor Cyan

if (-not (Test-Path $tpl)) {
    Write-Host '  กำลังสร้างแม่แบบหนังสือราชการ...' -ForegroundColor DarkGray
    & python (Join-Path $here 'make.py') 2>&1 |
        ForEach-Object { Write-Host "    $_" -ForegroundColor DarkGray }
}
if (-not (Test-Path $tpl)) {
    Write-Host '  [ไม่ผ่าน] สร้างแม่แบบไม่สำเร็จ' -ForegroundColor Red
    exit 1
}

& python (Join-Path $here 'test_full.py') 2>&1 | ForEach-Object { Write-Host "  $_" }
$code = $LASTEXITCODE

if ($code -ne 0) { exit 1 }
exit 0
