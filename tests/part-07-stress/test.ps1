# ============================================================
#  ส่วนที่ 7: เอกสารขนาดใหญ่และความเร็ว
# ============================================================
#  รัน:  .\test.ps1   (ใช้เวลานานหน่า ประมาณ 2-5 นาที)
# ============================================================

$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$env:PYTHONIOENCODING = 'utf-8'

Write-Host ''
Write-Host 'ส่วนที่ 7: เอกสารขนาดใหญ่และความเร็ว' -ForegroundColor Cyan
Write-Host '  ใช้เวลานาน ประมาณ 2-5 นาที' -ForegroundColor DarkGray

# สร้างแม่แบบตารางก่อน (ส่วนที่ 3)
$tpl = Join-Path $PSScriptRoot '..\part-03-table-loop\templates\ตารางและเงื่อนไข.docx'
if (-not (Test-Path $tpl)) {
    Write-Host '  กำลังสร้างแม่แบบตาราง (ส่วนที่ 3)...' -ForegroundColor DarkGray
    & python (Join-Path $PSScriptRoot '..\part-03-table-loop\make.py') 2>&1 |
        ForEach-Object { Write-Host "    $_" -ForegroundColor DarkGray }
}

& python (Join-Path $PSScriptRoot 'test_stress.py') 2>&1 | ForEach-Object { Write-Host "  $_" }
$code = $LASTEXITCODE

if ($code -ne 0) { exit 1 }
exit 0
