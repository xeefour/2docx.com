# ============================================================
#  ตัวรันชุดทดสอบ 2docx.com — รันทุกส่วน
# ============================================================
#  ใช้งาน:
#    .\run-all.ps1                    ทดสอบทั้งหมด
#    .\run-all.ps1 -Part 2           ทดสอบส่วนที่ 2
#    .\run-all.ps1 -Part 1,2,3,4     ทดสอบหลายส่วน
#    .\run-all.ps1 -Part 1,2,3,4,5,6   ข้ามส่วนที่ใช้เวลานาน
#    .\run-all.ps1 -List             ดูรายชื่อส่วนทั้งหมด
#    .\run-all.ps1 -Quick            ข้ามส่วนที่ใช้เวลานาน (7, 8)
# ============================================================

param(
    [string]$Part = 'all',
    [switch]$List,
    [switch]$Quick
)

$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$env:PYTHONIOENCODING = 'utf-8'

$root = $PSScriptRoot

# ---------- รายการส่วนที่มี ----------
$all = @(
    @{ No = 1; Name = 'ติดตั้งและตรวจสอบระบบ';    Dir = 'part-01-setup';      Slow = $false }
    @{ No = 2; Name = 'ข้อความภาษาไทย';            Dir = 'part-02-thai-text';  Slow = $false }
    @{ No = 3; Name = 'ตารางซ้ำและเงื่อนไข';       Dir = 'part-03-table-loop'; Slow = $false }
    @{ No = 4; Name = 'รูปภาพ';                   Dir = 'part-04-images';     Slow = $false }
    @{ No = 5; Name = 'การเรียก API';             Dir = 'part-05-api';        Slow = $false }
    @{ No = 6; Name = 'ตัวฉีดรูป (ไม่ต้อง Docker)'; Dir = 'part-06-injector';  Slow = $false }
    @{ No = 7; Name = 'เอกสารขนาดใหญ่';           Dir = 'part-07-stress';     Slow = $true  }
    @{ No = 8; Name = 'เอกสารจริงครบวงจร';         Dir = 'part-08-full-flow';  Slow = $true  }
)

# ---------- -List ----------
if ($List -or $Part -eq 'list') {
    Write-Host ''
    Write-Host 'ส่วนที่มีให้ทดสอบ:' -ForegroundColor Cyan
    Write-Host ''
    foreach ($p in $all) {
        $tag = if ($p.Slow) { 'ใช้เวลานาน' } else { 'เร็ว' }
        $docker = if ($p.No -eq 6) { 'ไม่ต้อง Docker' } else { 'ต้อง Docker' }
        Write-Host ("  ส่วนที่ {0}  {1,-30} {2,-14} {3}" -f $p.No, $p.Name, $tag, $docker) -ForegroundColor White
    }
    Write-Host ''
    Write-Host 'คำสั่ง:' -ForegroundColor DarkGray
    Write-Host '  .\run-all.ps1                  ทดสอบทั้งหมด (รวมส่วนที่ใช้เวลานาน)' -ForegroundColor DarkGray
    Write-Host '  .\run-all.ps1 -Quick           ทดสอบเฉพาะส่วนที่ทำได้เร็ว' -ForegroundColor DarkGray
    Write-Host '  .\run-all.ps1 -Part 2          ทดสอบส่วนเดียว' -ForegroundColor DarkGray
    Write-Host '  .\run-all.ps1 -Part 1,2,3      ทดสอบหลายส่วน' -ForegroundColor DarkGray
    exit 0
}

# ---------- เลือกส่วน ----------
if ($Quick) {
    $nums = $all | Where-Object { -not $_.Slow } | ForEach-Object { $_.No }
    Write-Host ''
    Write-Host 'โหมดเร็ว: ข้ามส่วนที่ 7 และ 8 (ใช้เวลานาน)' -ForegroundColor DarkGray
} elseif ($Part -eq 'all') {
    $nums = $all | ForEach-Object { $_.No }
} else {
    $nums = $Part -split ',' | ForEach-Object { [int]$_.Trim() }
}

$selected = @()
foreach ($n in $nums) {
    $f = $all | Where-Object { $_.No -eq $n }
    if ($f) { $selected += $f }
    else { Write-Host "ไม่พบส่วนที่ $n" -ForegroundColor Red; exit 1 }
}

# ---------- เช็ค Docker ----------
$needDocker = @($selected | Where-Object { $_.No -ne 6 }).Count -gt 0
if ($needDocker) {
    $dockerOk = $false
    try { $null = docker info --format '{{.ServerVersion}}' 2>$null; $dockerOk = $true } catch { }
    if (-not $dockerOk) {
        Write-Host ''
        Write-Host 'Docker ยังไม่ทำงาน' -ForegroundColor Yellow
        Write-Host '  เปิดก่อน:  Start-Process "C:\Program Files\Docker\Docker\Docker Desktop.exe"' -ForegroundColor DarkGray
        Write-Host '  หรือใช้:   .\run-all.ps1 -Part 6   (ทดสอบเฉพาะส่วนที่ไม่ต้องใช้ Docker)' -ForegroundColor DarkGray
        exit 2
    }
    $running = docker ps --filter 'name=carbone-thai' --format '{{.Names}}' 2>$null
    if (-not $running) {
        Write-Host ''
        Write-Host 'กำลังเปิด container Carbone...' -ForegroundColor Yellow
        docker rm -f carbone-thai 2>$null | Out-Null
        docker run -d --name carbone-thai -p 4000:4000 -e CARBONE_EE_API_KEY=carbon-ce `
            --restart unless-stopped carbone-thai:5.15.2 | Out-Null
        Start-Sleep -Seconds 10
    }
}

# ---------- รัน ----------
$allStart = Get-Date
$results = @()

foreach ($p in $selected) {
    $label = "ส่วนที่ $($p.No): $($p.Name)"
    Write-Host ''
    Write-Host ('=' * 72) -ForegroundColor DarkGray
    Write-Host " $label" -ForegroundColor White
    Write-Host ('=' * 72) -ForegroundColor DarkGray

    $t0 = Get-Date
    $script = Join-Path $root "$($p.Dir)\test.ps1"
    if (-not (Test-Path $script)) {
        Write-Host "  [ข้าม] ไม่พบ $script" -ForegroundColor Yellow
        $results += [pscustomobject]@{ No=$p.No; Name=$p.Name; Status='ไม่มีสคริปต์'; Sec=0; Pass=0; Total=0 }
        continue
    }

    $out = & $script 2>&1
    $code = $LASTEXITCODE
    $out | ForEach-Object { Write-Host $_ }

    # แยกจำนวนที่ผ่านจากบรรทัดสรุป
    $line = $out | Where-Object { $_ -match 'ผ่าน\s+(\d+)\s*/\s*(\d+)' } | Select-Object -Last 1
    $np = 0; $nt = 0
    if ($line -and $line -match 'ผ่าน\s+(\d+)\s*/\s*(\d+)') { $np = [int]$Matches[1]; $nt = [int]$Matches[2] }

    $sec = [math]::Round(((Get-Date) - $t0).TotalSeconds, 1)
    $status = if ($code -eq 0) { 'ผ่าน' } else { 'มีบางส่วนไม่ผ่าน' }
    $results += [pscustomobject]@{
        No = $p.No; Name = $p.Name; Status = $status; Sec = $sec; Pass = $np; Total = $nt
    }
}

# ---------- สรุป ----------
$totalSec = [math]::Round(((Get-Date) - $allStart).TotalSeconds, 1)
$okCount = @($results | Where-Object { $_.Status -eq 'ผ่าน' }).Count
$sumPass = ($results | Measure-Object Pass -Sum).Sum
$sumTotal = ($results | Measure-Object Total -Sum).Sum

Write-Host ''
Write-Host ('=' * 72) -ForegroundColor DarkGray
Write-Host ' สรุปผลการทดสอบ' -ForegroundColor White
Write-Host ('=' * 72) -ForegroundColor DarkGray
Write-Host ''
$results | ForEach-Object {
    $color = if ($_.Status -eq 'ผ่าน') { 'Green' } else { 'Yellow' }
    $score = if ($_.Total -gt 0) { "$($_.Pass)/$($_.Total)" } else { '' }
    Write-Host ("  ส่วนที่ {0}  {1,-30} {2,-20} {3,8}  {4,5} วิ" -f `
        $_.No, $_.Name, $_.Status, $score, $_.Sec) -ForegroundColor $color
}
Write-Host ''
$allOk = ($okCount -eq $results.Count)
if ($sumTotal -gt 0) {
    Write-Host ("  รวม $okCount/$($results.Count) ส่วน ผ่าน $sumPass/$sumTotal ข้อตรวจ  ใช้เวลา $totalSec วิ") -ForegroundColor $(if ($allOk) {'Green'} else {'Yellow'})
} else {
    Write-Host ("  รวม $okCount/$($results.Count) ส่วน  ใช้เวลา $totalSec วิ") -ForegroundColor $(if ($allOk) {'Green'} else {'Yellow'})
}
Write-Host ''
Write-Host "  ดูรายละเอียดแต่ละส่วน: $root\part-XX-*\output" -ForegroundColor DarkGray
Write-Host "  คู่มือภาพรวม:          $root\TEST-PLAN.md" -ForegroundColor DarkGray

if ($allOk) { exit 0 } else { exit 1 }
