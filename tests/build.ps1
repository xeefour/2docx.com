# ============================================================
#  สคริปต์สร้าง Docker image และ container
# ============================================================
#  ใช้งาน:
#    .\build.ps1                 สร้าง image ใหม่ (ลบตัวเก่าออกก่อน)
#    .\build.ps1 -Tag v2         สร้างด้วยชื่อ image อื่น
#    .\build.ps1 -Keep          สร้างโดยไม่ลบ container เก่า
#    .\build.ps1 -Check         ตรวจสถานะปัจจุบัน (ไม่ต้อง build)
# ============================================================

param(
    [string]$Tag = '5.15.2',
    [string]$Name = 'carbone-thai',
    [switch]$Keep,
    [switch]$Check
)

$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$root = $PSScriptRoot
$image = "$Name`:$Tag"
$port = 4000

# ------------------------------------------------------------------
#  ตรวจสถานะปัจจุบัน
# ------------------------------------------------------------------
function Show-Status {
    Write-Host ''
    Write-Host 'สถานะปัจจุบัน' -ForegroundColor Cyan
    Write-Host ('-' * 60)

    $running = docker ps --filter "name=$Name" --format '{{.Names}}'
    if ($running) {
        $st = docker inspect --format '{{.State.Status}}{{if .State.Health}} ({{.State.Health.Status}}){{end}}' $Name 2>$null
        Write-Host "  container: $Name  [$st]"
        try {
            $v = (Invoke-RestMethod "http://127.0.0.1:$port/status" -TimeoutSec 10).version
            Write-Host "  Carbone  : เวอร์ชัน $v" -ForegroundColor Green
        } catch {
            Write-Host "  Carbone  : ไม่ตอบสนอง"
        }
    } else {
        Write-Host "  container: $Name  [ไม่ได้ทำงาน]"
    }

    $img = docker images $image --format '{{.Repository}}:{{.Tag}} {{.Size}} {{.CreatedSince}}' 2>$null
    if ($img) { Write-Host "  image    : $img" }
    else { Write-Host "  image    : ยังไม่มี $image" }

    if ($running) {
        $n = (docker exec $Name fc-list :lang=th 2>$null | Measure-Object).Count
        Write-Host "  ฟอนต์ไทย : $n รูปแบบ"
    }
    Write-Host ('-' * 60)
}

if ($Check) {
    Show-Status
    exit 0
}

# ------------------------------------------------------------------
#  สร้าง image
# ------------------------------------------------------------------
Write-Host ''
Write-Host "กำลังสร้าง image: $image" -ForegroundColor Cyan
Write-Host '  (อาจใช้เวลา 1-3 นาที)' -ForegroundColor DarkGray
Write-Host ''

Push-Location $root
try {
    $out = docker build -t $image -f Dockerfile . 2>&1
    $code = $LASTEXITCODE
} finally {
    Pop-Location
}

if ($code -ne 0) {
    Write-Host ''
    Write-Host 'สร้าง image ไม่สำเร็จ:' -ForegroundColor Red
    $out | Select-Object -Last 25 | ForEach-Object { Write-Host "  $_" -ForegroundColor Red }
    exit 1
}

# แสดงผลตรวจฟอนต์จากขั้นตอน build
Write-Host ''
Write-Host 'ผลตรวจจากขั้นตอน build:' -ForegroundColor DarkGray
$out | Where-Object { $_ -match 'ติดตั้งแล้ว|ไม่พบ|จำนวนฟอนต์|สถาปัตยกรรม' } |
    ForEach-Object { Write-Host "  $_" -ForegroundColor DarkGray }

# ------------------------------------------------------------------
#  รัน container ใหม่
# ------------------------------------------------------------------
if (-not $Keep) {
    Write-Host ''
    Write-Host 'กำลังลบ container เก่า...' -ForegroundColor DarkGray
    docker rm -f $Name 2>&1 | Out-Null
}

Write-Host ''
Write-Host 'กำลังสร้าง container ใหม่...' -ForegroundColor Cyan
$runId = docker run -d --name $Name -p "${port}:4000" `
    -e CARBONE_EE_API_KEY=carbon-ce `
    -v "${root}\output:/app/output" `
    --restart unless-stopped `
    $image 2>&1

if ($LASTEXITCODE -ne 0) {
    Write-Host "  สร้าง container ไม่สำเร็จ: $runId" -ForegroundColor Red
    exit 1
}

Write-Host ''
Write-Host 'รอ container พร้อมใช้งาน...'
$ok = $false
for ($i = 0; $i -lt 40; $i++) {
    Start-Sleep -Seconds 2
    try {
        $v = (Invoke-RestMethod "http://127.0.0.1:$port/status" -TimeoutSec 5).version
        if ($v) { $ok = $true; break }
    } catch { }
    $h = docker inspect --format '{{.State.Health.Status}}' $Name 2>$null
    Write-Host "  ... $h" -ForegroundColor DarkGray
}

if (-not $ok) {
    Write-Host ''
    Write-Host 'container ไม่ตอบสนอง ดู log:' -ForegroundColor Red
    docker logs --tail 25 $Name 2>&1 | ForEach-Object { Write-Host "  $_" -ForegroundColor Red }
    exit 1
}

Write-Host ''
Write-Host 'สร้างสำเร็จ' -ForegroundColor Green
Show-Status
exit 0
