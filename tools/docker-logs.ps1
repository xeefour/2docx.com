<#
.SYNOPSIS
  รวม log ของทุก container ในเครื่องเดียว เรียงตามเวลาจริง พร้อมกรอง noise

.DESCRIPTION
  ดึง log จากทุก container ที่กำลังรัน (รวมตัวที่ไม่ได้อยู่ใน compose)
  มาต่อกันเป็น stream เดียว เรียงตาม timestamp จริง แล้วใส่ชื่อ container นำหน้า

  ข้อดีเหนือ `docker compose logs`: ครอบคลุม container ที่ไม่ได้อยู่ใน
  compose file ใด ๆ (เช่น teable-postgres, line-oa-test) ด้วย

.PARAMETER Since
  ช่วงเวลาย้อนหลัง ใช้รูปแบบของ docker (30m, 6h, 24h, 3d)
  ค่าเริ่มต้น 30m — ถ้าใช้ 24h กับ mongo จะดึงข้อมูลหลายร้อย MB

.PARAMETER Container
  ระบุเฉพาะบางตัว ค่าเริ่มต้นคือทุกตัวที่กำลังรัน

.PARAMETER Errors
  แสดงเฉพาะบรรทัดที่น่าสงสัย พร้อมตัด noise ที่รู้จักแล้วออกให้อัตโนมัติ
  (mongo "AuthenticationAbandoned" / "Connection accepted" ฯลฯ)

.PARAMETER Follow
  stream สด รวมทุก container เข้าด้วยกัน (Ctrl+C เพื่อหยุด)

.PARAMETER Stats
  สรุปต่อ container: จำนวนบรรทัด, ขนาด, และข้อความที่พบบ่อยที่สุด 5 อันดับ

.PARAMETER Out
  บันทึกผลลงไฟล์ (เรียงตามเวลา) ในโฟลเดอร์ logs/

.EXAMPLE
  .\tools\docker-logs.ps1
  ดู 30 นาทีล่าสุดของทุก container

.EXAMPLE
  .\tools\docker-logs.ps1 -Since 24h -Errors
  ดูเฉพาะปัญหาใน 24 ชั่วโมงที่ผ่านมา (ตัด noise ออกให้)

.EXAMPLE
  .\tools\docker-logs.ps1 -Container mongo-1,docserver -Since 2h
  เจาะเฉพาะ 2 ตัว

.EXAMPLE
  .\tools\docker-logs.ps1 -Follow
  stream สดทุก container รวมกัน

.EXAMPLE
  .\tools\docker-logs.ps1 -Stats -Since 6h
  ดูว่าตัวไหนกินพื้นที่ log มากที่สุด
#>
[CmdletBinding()]
param(
    [string]    $Since     = '30m',
    [string[]]  $Container,
    [switch]    $Errors,
    [switch]    $Follow,
    [switch]    $Stats,
    [switch]    $Out,
    [int]       $MaxLines  = 50000
)

$ErrorActionPreference = 'Continue'
# ให้ redirect เป็น UTF-8 ด้วย (ไม่งั้นข้อความไทยกลายเป็น ????)
try {
    [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
    $OutputEncoding = New-Object System.Text.UTF8Encoding $false
} catch { }
$repoRoot = Split-Path -Parent $PSScriptRoot

# ── noise ที่รู้จักแล้วว่าไม่ใช่ปัญหา ───────────────────────────────────
# mongo เปิด replication connection ใหม่ทุกวินาทีแล้ว client ตัดทิ้งเอง
# (AuthenticationAbandoned, conversation_duration 1-2 วินาที) — เป็นเรื่องปกติ
# ตอน mongod ยังไม่ได้ใส่ --auth ตามที่ระบุไว้ใน dokploy-infra/docker-compose.yml
$script:Noise = 'AuthenticationAbandoned|"msg":"client metadata"|"msg":"Connection accepted"|"msg":"Connection ended"|"msg":"Connection not authenticating"|"msg":"Received first command on ingress|"msg":"Successfully authenticated"'

# ── รูปแบบที่ถือว่าเป็นปัญหา ────────────────────────────────────────────
$script:Bad = '\b(error|fatal|panic|exception|refused|denied|unauthoriz|forbidden|failed|failure|timeout|timed\sout|unhealthy|crashloop|out of memory|oom|killed|abort|invalid|cannot|could not|unable)\b'

function Write-Head($t) { Write-Host $t -ForegroundColor Cyan }

# ─────────────────────────────────────────────────────────────────────
#  รวมรายชื่อ container
#
#  แยกด้วย comma อีกชั้น เพราะตอนเรียกด้วย `powershell -File script.ps1 -Container a,b`
#  PowerShell จะส่งค่า "a,b" มาเป็น string เดียว ไม่ใช่ array
# ─────────────────────────────────────────────────────────────────────
$Container = @($Container | ForEach-Object { $_ -split ',' } | ForEach-Object { $_.Trim() } |
               Where-Object { $_ })

if (-not $Container -or $Container.Count -eq 0) {
    $Container = @(docker ps --format '{{.Names}}' 2>$null | Where-Object { $_ })
}
if (-not $Container -or $Container.Count -eq 0) {
    Write-Error "ไม่พบ container ที่กำลังรัน"
    exit 1
}

# ─────────────────────────────────────────────────────────────────────
#  แปลงบรรทัดดิบ (มี timestamp นำหน้า) → record ที่ sort ตามเวลาได้
#
#  K = sort key ความยาวคงที่ (วินาที 6 หลัก + ทศนิยม 9 หลัก) → เรียงแบบ
#      string ก็ได้ตรงตามเวลา ไม่ต้องแปลง DateTime (เร็วกว่ามากตอน
#      ต้องอ่านหลักแสนบรรทัด)
# ─────────────────────────────────────────────────────────────────────
$script:RxLine = '^(?<ts>\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(?<fr>\d+))?Z?\s(?<msg>.*)$'
$script:RxAnsi = "$([char]27)\[[0-9;]*[A-Za-z]"

function ConvertTo-LogRecord {
    param([string]$Line, [string]$Name)

    $m = [regex]::Match($Line, $script:RxLine)
    if ($m.Success) {
        $fr = '000000000'
        if ($m.Groups['fr'].Success -and $m.Groups['fr'].Value) {
            $fr = $m.Groups['fr'].Value
            if ($fr.Length -ge 9) { $fr = $fr.Substring(0, 9) }
            else { $fr = $fr.PadRight(9, '0') }
        }
        return [pscustomobject]@{
            K = $m.Groups['ts'].Value + '.' + $fr
            N = $Name
            M = ($m.Groups['msg'].Value -replace $script:RxAnsi, '')
        }
    }
    # ไม่มี timestamp → จัดไว้ท้ายสุด ไม่ให้ปนหัวตารางเวลา
    return [pscustomobject]@{ K = 'zzz'; N = $Name; M = ($Line -replace $script:RxAnsi, '') }
}

# ─────────────────────────────────────────────────────────────────────
#  ดึง log ของ 1 ตัว → คืน array ของ PSCustomObject (K=sort key, N=ชื่อ, M=ข้อความ)
# ─────────────────────────────────────────────────────────────────────
function Get-LogLines {
    param([string]$Name, [switch]$WithSince, [string]$SinceArg)

    # --timestamps จำเป็น: docker ไม่ใส่เวลาให้ถ้าไม่สั่ง แล้ว merge ข้าม
    # container จะเรียงผิด (ได้แค่ลำดับที่ docker คืนมาทีละตัว)
    $a = @('logs', '--timestamps')
    if ($WithSince) { $a += @('--since', $SinceArg) }
    $a += $Name

    $raw = & docker @a 2>&1

    $res = New-Object System.Collections.Generic.List[object]

    foreach ($item in $raw) {
        $line = [string]$item
        if (-not $line) { continue }
        $res.Add((ConvertTo-LogRecord -Line $line -Name $Name))
    }

    # กันไม่ให้ RAM ตูด — ถ้าเกิน เก็บเฉพาะท้าย ๆ
    if ($MaxLines -gt 0 -and $res.Count -gt $MaxLines) {
        Write-Warning ("[{0}] ได้ {1} บรรทัด เกิน -MaxLines {2} → เก็บเฉพาะ {2} บรรทัดท้ายสุด (ลอง -Since ที่สั้นลง)" -f $Name, $res.Count, $MaxLines)
        $res = @($res | Select-Object -Last $MaxLines)
    }

    return ,$res
}

# ─────────────────────────────────────────────────────────────────────
#  โหมด Stats — สรุปว่าตัวไหนกินพื้นที่ และมีอะไรเกิดขึ้นบ่อย
# ─────────────────────────────────────────────────────────────────────
if ($Stats) {
    Write-Head ("สรุป log {0} — {1} container" -f $Since, $Container.Count)
    $rows = @()

    foreach ($n in $Container) {
        $lines = Get-LogLines -Name $n -WithSince -SinceArg $Since
        $bytes = 0
        foreach ($l in $lines) { $bytes += $l.M.Length + $l.N.Length + 3 }

        $top = @{}
        $rxMsg = '"msg":"([^"]+)"'
        foreach ($l in $lines) {
            $mm = [regex]::Match($l.M, $rxMsg)
            if ($mm.Success) { $k = $mm.Groups[1].Value }
            else {
                $k = $l.M.Trim()
                if ($k.Length -gt 45) { $k = $k.Substring(0, 45) + '…' }
            }
            if ($k) {
                if ($top.ContainsKey($k)) { $top[$k]++ } else { $top[$k] = 1 }
            }
        }

        $rows += [pscustomobject]@{
            Container = $n
            Lines     = $lines.Count
            MB        = [math]::Round($bytes / 1MB, 2)
            Top       = (($top.GetEnumerator() | Sort-Object Value -Descending | Select-Object -First 5 |
                         ForEach-Object { "$($_.Value)x $($_.Key)" }) -join '  |  ')
        }
        Write-Host "  อ่าน $n เสร็จ ($($lines.Count) บรรทัด)" -ForegroundColor DarkGray
    }

    Write-Host ''
    $rows | Sort-Object MB -Descending | Format-Table -AutoSize -Wrap
    exit 0
}

# ─────────────────────────────────────────────────────────────────────
#  โหมด Follow — stream สดจากทุก container รวมกัน
# ─────────────────────────────────────────────────────────────────────
if ($Follow) {
    $fd = Join-Path $repoRoot 'logs\follow'
    if (-not (Test-Path $fd)) { New-Item -ItemType Directory -Path $fd -Force | Out-Null }

    $jobs = @()
    foreach ($n in $Container) {
        $p = Join-Path $fd "$n.log"
        if (Test-Path $p) { Remove-Item $p -Force }
        $jobs += [pscustomobject]@{
            Name = $n
            Path = $p
            Job  = Start-Job -ArgumentList $n, $p -ScriptBlock {
                param($c, $p)
                $enc = New-Object System.Text.UTF8Encoding $false
                $fs  = New-Object System.IO.FileStream($p, [System.IO.FileMode]::Create,
                          [System.IO.FileAccess]::Write, [System.IO.FileShare]::ReadWrite)
                $w   = New-Object System.IO.StreamWriter($fs, $enc)
                $w.AutoFlush = $true
                try {
                    # --tail จำเป็น: ถ้าไม่ใส่ docker จะย้อนส่ง log เก่าทั้งหมดก่อน
                    # (mongo มี history หลายร้อย MB → เครื่องค้างทันที)
                    & docker logs --follow --timestamps --tail 50 $c 2>&1 |
                        ForEach-Object { $w.WriteLine([string]$_) }
                } finally {
                    $w.Dispose(); $fs.Dispose()
                }
            }
        }
    }

    # เปิดไฟล์ทีละตัว แล้วเริ่มอ่านจากท้ายสุด (ไม่ย้อนอดีต)
    $rd = @{}
    foreach ($j in $jobs) {
        $fs = New-Object System.IO.FileStream($j.Path, [System.IO.FileMode]::OpenOrCreate,
                  [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
        $fs.Seek(0, [System.IO.SeekOrigin]::End) | Out-Null
        $rd[$j.Name] = [pscustomobject]@{
            Stream = New-Object System.IO.StreamReader($fs, (New-Object System.Text.UTF8Encoding $false))
            Buffer = New-Object System.Collections.Generic.List[string]
        }
    }

    Write-Host "กำลัง stream สดจาก $($jobs.Count) container — Ctrl+C เพื่อหยุด" -ForegroundColor Green
    Write-Host "  $($Container -join ', ')" -ForegroundColor DarkGray
    Write-Host ''

    try {
        while ($true) {
            $batch = @()
            foreach ($j in $jobs) {
                $r = $rd[$j.Name]
                $txt = $r.Stream.ReadToEnd()
                if ($txt) {
                    foreach ($ln in ($txt -split "`n")) {
                        if ($ln.Trim()) { $batch += (ConvertTo-LogRecord -Line $ln -Name $j.Name) }
                    }
                }
            }
            if ($batch.Count -gt 0) {
                # เรียงด้วย field K เสมอ — อย่าใช้ $matches ใน Sort-Object
                # เพราะ $matches เป็นตัวแปรอัตโนมัติที่ถูกทับข้าม scope
                # ทำให้ key ผิดและสุ่มเรียงไม่ตามเวลา
                foreach ($b in ($batch | Sort-Object K)) {
                    if ($Errors -and ($b.M -match $script:Bad) -and ($b.M -notmatch $script:Noise)) {
                        Write-Host ("{0}  [{1}]  {2}" -f $b.K, $b.N, $b.M) -ForegroundColor Yellow
                    } else {
                        Write-Host ("{0}  [{1}]  {2}" -f $b.K, $b.N, $b.M) -ForegroundColor DarkGray
                    }
                }
            }
            Start-Sleep -Milliseconds 700
        }
    } finally {
        foreach ($j in $jobs) { Stop-Job $j.Job -ErrorAction SilentlyContinue; Remove-Job $j.Job -Force -ErrorAction SilentlyContinue }
        foreach ($n in $rd.Keys) { $rd[$n].Stream.Dispose() }
        Write-Host ''
        Write-Host "หยุดแล้ว" -ForegroundColor Cyan
    }
    exit 0
}

# ─────────────────────────────────────────────────────────────────────
#  โหมดปกติ — ดึงย้อนหลังแล้วเรียงตามเวลา
# ─────────────────────────────────────────────────────────────────────
Write-Head ("ดึง log {0} จาก {1} container…" -f $Since, $Container.Count)

$dockerErrMsg = 'Error response from daemon|No such container'
$all = New-Object System.Collections.Generic.List[object]

foreach ($n in $Container) {
    $got = Get-LogLines -Name $n -WithSince -SinceArg $Since
    $errLine = @($got | Where-Object { $_.K -eq 'zzz' -and $_.M -match $dockerErrMsg })

    if ($errLine.Count -gt 0) {
        # ชื่อผิด — บอกตรง ๆ ว่าตัวนี้ไม่ได้อ่าน ไม่ใช่อ่านแล้ว "สำเร็จ"
        Write-Host ("  x {0} — ไม่พบ container" -f $n) -ForegroundColor Red
        Write-Warning ("    {0}" -f $errLine[0].M)
        continue
    }

    $all.AddRange($got)
    Write-Host ("  ✓ {0}  ({1} บรรทัด)" -f $n, $got.Count) -ForegroundColor DarkGray
}

# @() บังคับให้เป็น array เสมอ — pipeline ที่มีผลลัพธ์เดียวจะคืน scalar
# แล้ว .Count จะกลายเป็นค่าว่าง
$sorted = @($all | Sort-Object K)
Write-Host ("ได้ {0} บรรทัด จาก {1} container" -f $sorted.Count, $Container.Count) -ForegroundColor Cyan
Write-Host ''

# ⚠️ ห้ามตั้งชื่อตัวแปรต่อไปนี้ว่า $bad / $bad2 — PowerShell ไม่สนตัวพิมพ์
#    เล็กใหญ่ ชื่อ $bad จะไปทับ $script:Bad (regex ตัวกรอง) แล้วตัวกรอง
#    จะหลุดทั้งหมดแบบเงียบ ๆ (เคยเจอแล้วระหว่างทดสอบ)

$shown = 0
foreach ($l in $sorted) {
    $skip = $false
    if ($Errors) {
        if (($l.M -notmatch $script:Bad) -or ($l.M -match $script:Noise)) { $skip = $true }
    }
    if (-not $skip) {
        Write-Host ("{0}  [{1}]  {2}" -f $l.K, $l.N, $l.M)
        $shown++
    }
}

if ($Errors) {
    Write-Host ''
    Write-Host ("แสดง {0} จาก {1} บรรทัด (กรอง noise ออกแล้ว)" -f $shown, $sorted.Count) -ForegroundColor Yellow
}

if ($Out) {
    $od = Join-Path $repoRoot 'logs'
    if (-not (Test-Path $od)) { New-Item -ItemType Directory -Path $od -Force | Out-Null }
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $file  = Join-Path $od "all-$stamp.log"

    $lines = New-Object System.Collections.Generic.List[string]
    foreach ($l in $sorted) {
        if ($Errors -and (($l.M -notmatch $script:Bad) -or ($l.M -match $script:Noise))) { continue }
        $lines.Add(("{0}  [{1}]  {2}" -f $l.K, $l.N, $l.M))
    }

    $enc = New-Object System.Text.UTF8Encoding $false
    [System.IO.File]::WriteAllLines($file, $lines, $enc)
    Write-Host ''
    Write-Host ("บันทึก {0} บรรทัด → {1}" -f $lines.Count, $file) -ForegroundColor Green
}
