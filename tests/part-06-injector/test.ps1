# ============================================================
#  ส่วนที่ 6: ตัวฉีดรูป (ไม่ต้องใช้ Docker)
# ============================================================
#  รัน:  .\test.ps1
#  ทดสอบตรรกะของตัวฉีดรูปล้วน ๆ ไม่ต้องเปิด Carbone
# ============================================================

$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$env:PYTHONIOENCODING = 'utf-8'

Write-Host ''
Write-Host 'ส่วนที่ 6: ตัวฉีดรูป (ไม่ต้องใช้ Docker)' -ForegroundColor Cyan
Write-Host '  ทดสอบตัวฉีดรูปโดยตรง ไม่ผ่าน Carbone' -ForegroundColor DarkGray

& python (Join-Path $PSScriptRoot 'test_injector.py') 2>&1 | ForEach-Object { Write-Host "  $_" }
$last = $LASTEXITCODE

if ($last -ne 0) { exit 1 }
exit 0
