<#
.SYNOPSIS
  เก็บสถานะพอร์ตของ host ลงไฟล์ ให้ container log-watch อ่านไปตรวจ

.DESCRIPTION
  ⚠️ ทำไมต้องมีสคริปต์ฝั่ง host
     ตัว log-watch อยู่ใน container จึงตรวจ "พอร์ตรั่ว" ไม่ได้ด้วยตัวเอง
     วิธีที่คิดว่าใช้ได้ — ต่อ TCP ไปที่ host.docker.internal:<port>
     — ผิดบน Windows Docker Desktop (WSL2)

     วัดแล้ว: ทุกพอร์ตที่ผูกกับ 127.0.0.1 เท่านั้น ก็ต่อถึงจาก container ได้
     เพราะ vpnkit/HNS ใน WSL2 รับการเชื่อมต่อจาก container แล้วส่งต่อเข้า
     loopback ให้ — ทำให้ "รั่ว" ทั้งที่ LAN เข้าไม่ได้จริง (สร้าง false positive
     ทุกชั่วโมงจนผู้ใช้เลิกสนใจ ซึ่งแย่กว่าไม่ตรวจเลย)

     ทางแก้ที่ถูกคืออ่านสถานะ bind จาก host ตรง ๆ แล้วส่งให้ container

.PARAMETER OutDir
  โฟลเดอร์ปลายทาง (ต้องเป็นโฟลเดอร์เดียวกับที่ bind mount เข้า log-watch)
#>
[CmdletBinding()]
param(
  [string]$OutDir = 'D:\2docx.com\dokploy-infra\log-watch\findings'
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

if (-not (Test-Path $OutDir)) { New-Item -ItemType Directory -Path $OutDir -Force | Out-Null }

# ── พอร์ตที่ผูกกับ 0.0.0.0 หรือ :: คือเปิดออก LAN ──────────────────────
$listeners = Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
  Where-Object { $_.LocalPort -in @(80, 3000, 4000, 4001, 3100, 8080, 8090, 12345, 27017, 4222, 6379, 16379, 9000) } |
  ForEach-Object {
    [pscustomobject]@{
      port    = $_.LocalPort
      address = $_.LocalAddress
      exposed = ($_.LocalAddress -ne '127.0.0.1' -and $_.LocalAddress -ne '::1')
    }
  }

# ── container ที่ publish พอร์ตออกมา ────────────────────────────────────
$containers = @()
try {
  $containers = docker ps --format '{{.Names}}|{{.Ports}}' 2>$null |
    ForEach-Object {
      $parts = $_.Split('|', 2)
      [pscustomobject]@{
        name  = $parts[0]
        ports = if ($parts.Count -gt 1) { $parts[1] } else { '' }
        # publish ที่ผูกกับ 0.0.0.0 หรือ IP จริง = รั่ว (127.0.0.1 ปลอดภัย)
        exposed = $parts.Count -gt 1 -and $parts[1] -match '(\d+\.\d+\.\d+\.\d+|\[::\]):\d+->' -and $parts[1] -notmatch '127\.0\.0\.1'
      }
    }
} catch { }

$state = [pscustomobject]@{
  ts          = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
  collectedBy = 'collect-host-state.ps1'
  listeners   = @($listeners)
  containers  = @($containers)
}

$out = Join-Path $OutDir 'host-state.json'
# เขียนเป็น UTF-8 ไม่มี BOM — container อ่านด้วย fs ตรง ๆ
[System.IO.File]::WriteAllText($out, ($state | ConvertTo-Json -Depth 5), (New-Object System.Text.UTF8Encoding $false))

$leaks = @($listeners | Where-Object { $_.exposed })
$leaks += @($containers | Where-Object { $_.exposed })

if ($leaks.Count -eq 0) {
  Write-Host "[$(Get-Date -Format 'HH:mm:ss')] เก็บสถานะ host แล้ว · ไม่พบพอร์ตที่รั่ว · $out" -ForegroundColor Green
} else {
  Write-Host "[$(Get-Date -Format 'HH:mm:ss')] เก็บสถานะ host แล้ว · พบ $($leaks.Count) รายการที่เปิดออก · $out" -ForegroundColor Yellow
  $leaks | ForEach-Object {
    # PowerShell 5.1 ไม่มี ?? — ต้องเขียนแบบเต็ม
    $label = if ($_.PSObject.Properties.Name -contains 'port') { $_.port } else { $_.name }
    $detail = if ($_.PSObject.Properties.Name -contains 'address') { $_.address } else { $_.ports }
    Write-Host ("   [!] {0} {1}" -f $label, $detail) -ForegroundColor Yellow
  }
}