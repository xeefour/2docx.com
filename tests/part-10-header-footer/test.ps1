$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$env:PYTHONIOENCODING = 'utf-8'

Write-Host ''
Write-Host 'ส่วนที่ 10: หัวกระดาษซ้ำและเลขหน้าอัตโนมัติ' -ForegroundColor Cyan
Write-Host '  (รวมการตั้งภาษาไทย เพื่อไม่ให้ Word ตีเส้นหยักแดงใต้ข้อความไทย)' -ForegroundColor DarkGray

$rc1 = 1
$rc2 = 1
$rc3 = 1

Write-Host ''
Write-Host '  [ชุดที่ 1: หัวกระดาษและเลขหน้าทุกหน้า]' -ForegroundColor DarkGray
if (-not (Test-Path (Join-Path $PSScriptRoot 'templates\หัวกระดาษ-เลขหน้า.docx'))) {
    & python (Join-Path $PSScriptRoot 'make.py') 2>&1 |
        ForEach-Object { Write-Host "    $_" -ForegroundColor DarkGray }
}
& python (Join-Path $PSScriptRoot 'test.py') 2>&1 | ForEach-Object { Write-Host $_ }
$rc1 = $LASTEXITCODE

Write-Host ''
Write-Host '  [ชุดที่ 2: หน้าแรกต่างจากหน้าถัดไป]' -ForegroundColor DarkGray
if (-not (Test-Path (Join-Path $PSScriptRoot 'templates\หน้าแรกต่างจากหน้าถัดไป.docx'))) {
    & python (Join-Path $PSScriptRoot 'make_first_page.py') 2>&1 |
        ForEach-Object { Write-Host "    $_" -ForegroundColor DarkGray }
}
& python (Join-Path $PSScriptRoot 'test_first_page.py') 2>&1 | ForEach-Object { Write-Host $_ }
$rc2 = $LASTEXITCODE

Write-Host ''
Write-Host '  [ชุดที่ 3: ตั้งภาษาไทย ไม่ให้ Word ตีเส้นหยักแดง]' -ForegroundColor DarkGray
& python (Join-Path $PSScriptRoot 'test_proofing.py') 2>&1 | ForEach-Object { Write-Host $_ }
$rc3 = $LASTEXITCODE

Write-Host ''
if ($rc1 -eq 0 -and $rc2 -eq 0 -and $rc3 -eq 0) {
    Write-Host '  ผ่านทั้ง 3 ชุด' -ForegroundColor Green
    exit 0
}
exit 1
