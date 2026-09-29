# ============================================================
#  สคริปต์ push image ขึ้น Docker Hub
# ============================================================
#  ใช้งาน:
#    .\push.ps1              ตรวจสอบความพร้อม
#    .\push.ps1 -Push        ส่งขึ้น Docker Hub
#    .\push.ps1 -Push -Tag v2 ส่งด้วย tag กำหนดเอง
# ============================================================

param(
    [switch]$Push,
    [string]$Tag = '5.15.2'
)

$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$Hub      = 'xeefour'
$Repo     = '2docx-docserver'
$Source   = "carbone-thai:$Tag"
$Full     = "$Hub/$Repo"
$Version  = '5.15.2'

# ============================================================
#  1. ตรวจว่า login แล้วหรือยัง
# ============================================================
function Test-Login {
    $out = docker info --format '{{json .RegistryConfig}}' 2>$null
    return ($LASTEXITCODE -eq 0)
}

function Get-RegistryAuth {
    $cred = @'
{
  "ServerURL": "https://index.docker.io/v1/",
  "Username": "xeefour",
  "Secret": "TOKEN"
}
'@
    try {
        $r = $cred | docker-credential-desktop get 2>$null
        if ($r) { return $true }
    } catch { }
    return $false
}

Write-Host ''
Write-Host 'ตรวจสอบความพร้อมก่อน push' -ForegroundColor Cyan
Write-Host ('-' * 64)

# --- image ---
$img = docker images $Source --format '{{.ID}}|{{.Size}}' 2>$null
if (-not $img) {
    Write-Host "  [ไม่พบ] image $Source" -ForegroundColor Red
    Write-Host '  สร้างก่อน:  .\build.ps1' -ForegroundColor DarkGray
    exit 1
}
$id, $size = $img -split '\|'
Write-Host "  [พบ] image $Source  ($size)" -ForegroundColor Green

# --- tag ---
foreach ($t in @($Tag, 'latest')) {
    $exists = docker images "$Full`:$t" --format '{{.ID}}' 2>$null
    if ($exists -eq $id) {
        Write-Host "  [พบ] tag $Full`:$t" -ForegroundColor Green
    } else {
        Write-Host "  [ยังไม่มี] tag $Full`:$t — จะสร้างให้" -ForegroundColor Yellow
        docker tag $Source "$Full`:$t" 2>&1 | Out-Null
    }
}

# --- login ---
$loggedIn = Get-RegistryAuth
if ($loggedIn) {
    Write-Host '  [พบ] ล็อกอิน Docker Hub แล้ว' -ForegroundColor Green
} else {
    Write-Host '  [ยังไม่ได้ล็อกอิน] Docker Hub' -ForegroundColor Yellow
}
Write-Host ('-' * 64)

# ============================================================
#  2. ถ้ายังไม่ได้ login ให้แนะนำวิธี
# ============================================================
if (-not $loggedIn) {
    Write-Host ''
    Write-Host 'ต้องล็อกอินก่อนจึงจะ push ได้' -ForegroundColor Yellow
    Write-Host ''
    Write-Host '  1. สร้าง Access Token ที่ https://hub.docker.com/settings/tokens' -ForegroundColor White
    Write-Host '     (เลือก Read & Write)' -ForegroundColor DarkGray
    Write-Host ''
    Write-Host '  2. รันคำสั่งนี้ในเทอร์มินัลของคุณเอง (อย่าวางรหัสผ่านในแชท):' -ForegroundColor White
    Write-Host ''
    Write-Host '     docker login -u xeefour' -ForegroundColor Cyan
    Write-Host ''
    Write-Host '  3. แล้วกลับมารัน:' -ForegroundColor White
    Write-Host ''
    Write-Host '     .\push.ps1 -Push' -ForegroundColor Cyan
    Write-Host ''
    exit 2
}

# ============================================================
#  3. Push
# ============================================================
if (-not $Push) {
    Write-Host ''
    Write-Host 'พร้อมแล้ว — สั่ง push ด้วย:' -ForegroundColor Green
    Write-Host ''
    Write-Host "  .\push.ps1 -Push" -ForegroundColor Cyan
    Write-Host ''
    exit 0
}

Write-Host ''
Write-Host "กำลัง push $Full`:$Tag ..." -ForegroundColor Cyan
Write-Host '  ขนาด 2.12 GB อาจใช้เวลา 10-30 นาที ขึ้นอยู่กับความเร็วอินเทอร์เน็ต' -ForegroundColor DarkGray
Write-Host ''

$sw = [Diagnostics.Stopwatch]::StartNew()
docker push "$Full`:$Tag"
$code1 = $LASTEXITCODE

if ($Tag -ne 'latest') {
    Write-Host ''
    Write-Host "กำลัง push $Full`:latest ..." -ForegroundColor Cyan
    docker push "$Full`:latest"
    $code2 = $LASTEXITCODE
} else {
    $code2 = 0
}
$sw.Stop()

Write-Host ''
if ($code1 -eq 0 -and $code2 -eq 0) {
    Write-Host "สำเร็จ ใช้เวลา $([math]::Round($sw.Elapsed.TotalMinutes, 1)) นาที" -ForegroundColor Green
    Write-Host ''
    Write-Host "  $Full`:$Tag" -ForegroundColor White
    Write-Host "  $Full`:latest" -ForegroundColor White
    Write-Host ''
    Write-Host '  เรียกใช้:' -ForegroundColor DarkGray
    Write-Host "  docker run -d --name docserver -p 4000:4000 $Full`:latest" -ForegroundColor DarkGray
    exit 0
} else {
    Write-Host "ไม่สำเร็จ (exit=$code1/$code2)" -ForegroundColor Red
    Write-Host ''
    Write-Host '  สาเหตุที่พบบ่อย:' -ForegroundColor DarkGray
    Write-Host '   - ยังไม่ได้ล็อกอิน หรือ token หมดอายุ' -ForegroundColor DarkGray
    Write-Host '   - ชื่อ repository ไม่ตรงกับที่สร้างไว้บน Docker Hub' -ForegroundColor DarkGray
    exit 1
}
