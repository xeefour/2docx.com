<#
.SYNOPSIS
  รายงานสุขภาพ log ของทุก container ในรูปแบบสั้น ๆ สำหรับ LLM อ่าน

.DESCRIPTION
  ดึงข้อมูลจาก Loki ผ่าน HTTP API แล้วย่อเหลือรายงานประมาณ 1-2 KB
  แทนที่จะต้องอ่านบรรทัดดิบหลายหมื่นบรรทัด

  รายงานประกอบด้วย 5 ส่วน:
    1. สถานะ container (จาก docker) + replica set
    2. ปริมาณ log ต่อ container ในช่วงเวลาที่เลือก
    3. เหตุการณ์ที่น่าสงสัย แจกแจงตามประเภท พร้อมจังหวะเวลา
    4. ตัวอย่างข้อความจริงของแต่ละประเภท (ไม่เกิน -MaxSamples ตัว)
    5. บรรทัดที่เป็น noise ที่ Alloy ตัดทิ้ง เพื่อให้เห็นว่าเหลืออะไรจริง

  ⚠️ ใช้หลัง Docker Desktop + Loki ขึ้นแล้วเท่านั้น
     ถ้า Loki ไม่ทำงาน ใช้ tools/docker-logs.ps1 แทน (ไม่ต้องพึ่ง stack)

.PARAMETER Since
  ช่วงเวลาย้อนหลัง ใช้รูปแบบของ Loki (30m, 6h, 24h, 7d)
  ค่าเริ่มต้น 24h

.PARAMETER Container
  จำกัดเฉพาะบางตัว ค่าเริ่มต้นคือทุกตัว

.PARAMETER MaxSamples
  จำนวนตัวอย่างข้อความต่อประเภท (ค่าเริ่มต้น 2) — กันรายงานบวม

.PARAMETER LokiUrl
  ที่อยู่ Loki (ค่าเริ่มต้น http://127.0.0.1:3100)

.EXAMPLE
  .\tools\log-report.ps1
  รายงาน 24 ชั่วโมงล่าสุด

.EXAMPLE
  .\tools\log-report.ps1 -Since 1h
  รายงาน 1 ชั่วโมงล่าสุด (ตอนเจอปัญหากำลังเกิด)

.EXAMPLE
  .\tools\log-report.ps1 -Since 7d -Container mongo-1,mongo-3
  เจาะเฉพาะ 2 ตัว
#>
[CmdletBinding()]
param(
    [string]   $Since      = '24h',
    [string[]] $Container,
    [int]      $MaxSamples = 2,
    [string]   $LokiUrl    = 'http://127.0.0.1:3100'
)

$ErrorActionPreference = 'Continue'
try {
    [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
} catch { }

# ── แปลง "30m"/"6h"/"7d" เป็นนาที เพื่อคำนวณช่วงเวลา ────────────────
$script:Minutes = 60
if ($Since -match '^\s*(\d+)\s*([smhd])\s*$') {
    $n = [int]$matches[1]
    switch ($matches[2].ToLower()) {
        's' { $script:Minutes = [math]::Max(1, $n / 60) }
        'm' { $script:Minutes = $n }
        'h' { $script:Minutes = $n * 60 }
        'd' { $script:Minutes = $n * 60 * 24 }
    }
}

$script:CFilter = 'container=~".+"'
if ($Container) {
    $list = @($Container | ForEach-Object { $_.Trim() } | Where-Object { $_ })
    if ($list.Count -gt 0) {
        $alt = ($list -join '|')
        $script:CFilter = "container=~`"($alt)`""
    }
}

$script:W = [int][math]::Ceiling($script:Minutes)
$script:S = (Get-Date).AddMinutes(-$script:W).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
$script:E = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")

# ── เรียก Loki ────────────────────────────────────────────────────
function Invoke-Loki {
    param([string]$Query, [string]$Path = 'query_range', [int]$Limit = 100)

    $qs = [uri]::EscapeDataString($Query)
    switch ($Path) {
        'query_range' {
            $u = "$script:LokiUrl/loki/api/v1/query_range?query=$qs&start=$($script:S)&end=$($script:E)&limit=$Limit&direction=backward"
        }
        'instant' {
            $u = "$script:LokiUrl/loki/api/v1/query?query=$qs&time=$($script:E)"
        }
    }
    try {
        Invoke-RestMethod -Uri $u -TimeoutSec 45 -ErrorAction Stop
    } catch {
        Write-Host "  x เรียก Loki ไม่สำเร็จ: $($_.Exception.Message)" -ForegroundColor Red
        return $null
    }
}

# ดึงจุดเวลาของแต่ละ stream → แปลงเป็น HH:mm:ss ท้องถิ่น
function Get-Entries {
    param($Res, [int]$Limit = 300)

    $out = New-Object System.Collections.Generic.List[object]
    if (-not $Res -or -not $Res.data) { return $out }

    foreach ($x in @($Res.data.result)) {
        $lbl = $x.stream
        if (-not $lbl) { $lbl = $x.metric }
        $cname = $lbl.container
        foreach ($v in @($x.values)) {
            $ns = 0
            if (-not [int64]::TryParse([string]$v[0], [ref]$ns)) { continue }
            $ms = [int64][math]::Floor($ns / 1000000)
            $t = [DateTimeOffset]::FromUnixTimeMilliseconds($ms).ToLocalTime().ToString('HH:mm:ss')
            $out.Add([pscustomobject]@{ C = $cname; T = $t; L = [string]$v[1] })
            if ($out.Count -ge $Limit) { return $out }
        }
    }
    return $out
}

Write-Host "รายงาน log — ช่วง $($script:W) นาทีที่ผ่านมา (ถึง $($script:E))" -ForegroundColor Cyan
Write-Host ([string]::new('=', 62))

# ═══ 1. สถานะ container ═══════════════════════════════════════════
Write-Host ""
Write-Host "[1] สถานะ container" -ForegroundColor Cyan
try {
    $rows = @()
    foreach ($line in (docker ps --format '{{.Names}}|{{.Status}}' 2>$null)) {
        $p = $line -split '\|'
        $st = $p[1]
        $bad = $st -match 'unhealthy|Restarting|Exited'
        $rows += [pscustomobject]@{
            Name = $p[0]
            Mark = if ($bad) { 'X' } else { 'ok' }
            Status = $st
        }
    }
    if ($rows.Count -eq 0) {
        Write-Host "  ไม่มี container กำลังรัน" -ForegroundColor Yellow
    } else {
        $badCount = @($rows | Where-Object { $_.Mark -eq 'X' }).Count
        Write-Host ("  รวม {0} container, มีปัญหา {1}" -f $rows.Count, $badCount) -ForegroundColor $(if ($badCount) { 'Red' } else { 'Green' })
        foreach ($r in $rows) {
            $c = if ($r.Mark -eq 'X') { 'Red' } else { 'DarkGray' }
            Write-Host ("    [{0}] {1,-20} {2}" -f $r.Mark, $r.Name, $r.Status) -ForegroundColor $c
        }
    }
} catch {
    Write-Host "  อ่านสถานะ docker ไม่ได้: $($_.Exception.Message)" -ForegroundColor Yellow
}

# replica set (ถ้ามี)
try {
    $rs = docker exec mongo-1 mongosh --quiet --eval "const s=rs.status();const p=s.members.find(m=>m.stateStr==='PRIMARY');let o='PRIMARY='+p.name.replace(':27017','');s.members.forEach(m=>{o+=' | '+m.name.replace(':27017','')+'='+m.stateStr+',health='+m.health+',lag='+(p.optime.ts.getHighBits()-m.optime.ts.getHighBits())+'s';});print(o);" 2>&1 | Out-String
    $line = ($rs -split "`n" | Where-Object { $_ -match 'PRIMARY=' } | Select-Object -First 1)
    if ($line) { Write-Host ("  replica set: " + $line.Trim()) -ForegroundColor DarkGray }
} catch { }

# ═══ 2. ปริมาณ log ต่อ container ═══════════════════════════════════
Write-Host ""
Write-Host "[2] ปริมาณ log ที่เก็บไว้ (แยกตาม container)" -ForegroundColor Cyan
$rBytes = Invoke-Loki "sum by (container) (bytes_over_time({$script:CFilter}[$($script:W)m]))" 'query_range' 50
if ($rBytes) {
    $rows2 = @()
    foreach ($x in @($rBytes.data.result)) {
        $v = @($x.values)
        if ($v.Count -eq 0) { continue }
        $last = $v | Select-Object -Last 1
        $b = 0
        if (-not [double]::TryParse([string]$last[1], [ref]$b)) { continue }
        $rows2 += [pscustomobject]@{ C = $x.metric.container; MB = $b / 1MB }
    }
    if ($rows2.Count -eq 0) {
        Write-Host "  ยังไม่มีข้อมูลในช่วงนี้" -ForegroundColor Yellow
    } else {
        $total = ($rows2 | Measure-Object MB -Sum).Sum
        $top = $rows2 | Sort-Object MB -Descending | Select-Object -First 10
        foreach ($r in $top) {
            $pct = if ($total -gt 0) { 100 * $r.MB / $total } else { 0 }
            $bar = '#' * [int][math]::Round($pct / 2)
            Write-Host ("    {0,-18} {1,8:N2} MB  {2,5:N1}%  {3}" -f $r.C, $r.MB, $pct, $bar) -ForegroundColor DarkGray
        }
        if ($rows2.Count -gt $top.Count) {
            Write-Host ("    ...อีก {0} container" -f ($rows2.Count - $top.Count)) -ForegroundColor DarkGray
        }
        Write-Host ("    รวม: {0:N2} MB เฉลี่ย {1:N1} MB/วัน" -f $total, ($total / ($script:W / 1440))) -ForegroundColor DarkGray
    }
}

# ═══ 3-4. เหตุการณ์น่าสงสัย ══════════════════════════════════════
# รูปแบบที่ถือว่าน่าสงสัย — ปรับได้ถ้าพบ noise รบกวน
$script:SUSPECT = '(?i)error|fatal|panic|exception|refused|denied|unauthoriz|forbidden|timeout|timed out|unhealthy|crashloop|out of memory|oom|abort|invalid|cannot|could not|unable|not primary|NotWritablePrimary|heartbeat failed|ReadConcernMajority|topology change|sync source|ReadConcernMajorityNotAvailableYet'

Write-Host ""
Write-Host "[3] เหตุการณ์น่าสงสัย" -ForegroundColor Cyan
$rSusp = Invoke-Loki "{$script:CFilter} |~ `"$script:SUSPECT`"" 'query_range' 500
$entries = Get-Entries -Res $rSusp -Limit 500

if ($entries.Count -eq 0) {
    Write-Host "  ไม่พบเลย ✓" -ForegroundColor Green
} else {
    # จัดกลุ่มตาม container + ข้อความหลัก เพื่อไม่ให้เห็นซ้ำ ๆ
    $groups = @{}
    foreach ($e in $entries) {
        $m = [regex]::Match($e.L, '"msg":"([^"]{1,90})"')
        if ($m.Success) { $k = $m.Groups[1].Value }
        else {
            $m2 = [regex]::Match($e.L, 'msg=("?)([^" ]{1,80})\1')
            if ($m2.Success) { $k = $m2.Groups[2].Value }
            else {
                $k = ($e.L -replace '\s+', ' ').Trim()
                if ($k.Length -gt 80) { $k = $k.Substring(0, 80) + '…' }
            }
        }
        $key = "$($e.C)|$k"
        if (-not $groups.ContainsKey($key)) {
            $groups[$key] = [pscustomobject]@{
                C = $e.C; K = $k; N = 0
                First = $e.T; Last = $e.T; Samples = (New-Object System.Collections.Generic.List[string])
            }
        }
        $g = $groups[$key]
        $g.N++
        if ($e.T -lt $g.First) { $g.First = $e.T }
        if ($e.T -gt $g.Last) { $g.Last = $e.T }
        if ($g.Samples.Count -lt $MaxSamples) { $g.Samples.Add($e.L) }
    }

    Write-Host ("  พบ {0} บรรทัด / {1} ประเภท" -f $entries.Count, $groups.Count) -ForegroundColor Yellow
    Write-Host ""

    # แยกเป็น "เกิดซ้ำ" กับ "เกิดครั้งเดียว" — ประเภทที่เกิดครั้งเดียวส่วนใหญ่คือ
    # เสียงรบกวนจากการ scan log ที่เกิดพร้อมกันทีเดียว ไม่ต้องแสดงทีละบรรทัด
    $all = @($groups.Values | Sort-Object N -Descending)
    $repeat = @($all | Where-Object { $_.N -ge 2 })
    $once = @($all | Where-Object { $_.N -lt 2 })

    foreach ($g in ($repeat | Select-Object -First 12)) {
        # เกาะกลุ่มหมดในช่วงเวลาเดียวกัน = อาจเป็นเหตุการณ์เดียว (เช่นตอน restart)
        $spread = 'กระจาย'
        if ($g.First -eq $g.Last) { $spread = 'จุดเดียว' }
        Write-Host ("    {0,4}x [{1,-12}] {2}" -f $g.N, $g.C, $g.K) -ForegroundColor Yellow
        Write-Host ("           ช่วงเวลา {0}–{1} ({2})" -f $g.First, $g.Last, $spread) -ForegroundColor DarkGray
        foreach ($s in $g.Samples) {
            $clean = ($s -replace '\s+', ' ').Trim()
            if ($clean.Length -gt 190) { $clean = $clean.Substring(0, 190) + '…' }
            Write-Host ("           | " + $clean) -ForegroundColor DarkGray
        }
    }
    if ($repeat.Count -gt 12) {
        Write-Host ("    ...อีก {0} ประเภทที่เกิดซ้ำ" -f ($repeat.Count - 12)) -ForegroundColor DarkGray
    }
    if ($once.Count -gt 0) {
        $onceLines = ($once | Measure-Object N -Sum).Sum
        $onceC = @($once | ForEach-Object { $_.C } | Sort-Object -Unique) -join ', '
        Write-Host ""
        Write-Host ("    + เกิดครั้งเดียวอีก {0} บรรทัด ({1} ประเภท) จาก: {2}" -f $onceLines, $once.Count, $onceC) -ForegroundColor DarkGray
        Write-Host "      (ใช้ -MaxSamples 0 ไม่ได้ — ถ้าอยากดูทั้งหมดให้แก้ $script:SUSPECT ในสคริปต์)" -ForegroundColor DarkGray
    }
}

# ═══ 5. ปริมาณที่ถูกตัดทิ้ง ═════════════════════════════════════════
Write-Host ""
Write-Host "[4] noise ที่ Alloy ตัดก่อนส่งเข้า Loki" -ForegroundColor Cyan
try {
    $m = (Invoke-WebRequest -Uri 'http://127.0.0.1:12345/metrics' -UseBasicParsing -TimeoutSec 20).Content
    $read = 0; $sent = 0; $drop = 0
    foreach ($ln in ($m -split "`n")) {
        if ($ln -match '^loki_source_docker_target_entries_total\{.*\}\s+([0-9.e+]+)') { $read = [double]$matches[1] }
        if ($ln -match '^loki_write_sent_entries_total\{.*\}\s+([0-9.e+]+)')    { $sent = [double]$matches[1] }
        if ($ln -match '^loki_process_dropped_lines_total\{.*reason="mongo-replication-noise"[^}]*\}\s+([0-9.e+]+)') { $drop += [double]$matches[1] }
    }
    $dropAll = 0
    foreach ($ln in ($m -split "`n")) {
        if ($ln -match '^loki_process_dropped_lines_total\{[^}]*\}\s+([0-9.e+]+)') { $dropAll += [double]$matches[1] }
    }
    if ($read -gt 0) {
        $pct = 100 * $dropAll / $read
        Write-Host ("    อ่านจาก Docker {0:N0} บรรทัด → ตัด {1:N0} ({2:N1}%) → เก็บจริง {3:N0}" -f $read, $dropAll, $pct, $sent) -ForegroundColor DarkGray
    } else {
        Write-Host "    (ยังไม่มีตัวเลข — Alloy เพิ่งเริ่มทำงาน)" -ForegroundColor DarkGray
    }
} catch {
    Write-Host "    (อ่าน metrics ของ Alloy ไม่ได้: $($_.Exception.Message))" -ForegroundColor DarkGray
}

# ═══ หมายเหตุ ═════════════════════════════════════════════════════
Write-Host ""
Write-Host "[หมายเหตุ]" -ForegroundColor Cyan
Write-Host "  • ถ้าเหตุการณ์ทั้งหมดอยู่ 'ช่วงเวลาเดียวกัน' แปลว่าเป็นก้อนตอน restart/deploy" -ForegroundColor DarkGray
Write-Host "    ไม่ใช่ปัญหาค้าง — ถ้ากระจายสม่ำเสมอแปลว่าเป็นปัญหาจริง" -ForegroundColor DarkGray
Write-Host "  • mongo ถูกตัด noise ทิ้ง 84% โดย Alloy — ที่เห็นคือส่วนที่มีค่ามากแล้ว" -ForegroundColor DarkGray
Write-Host "  • query ดิบ:  Invoke-RestMethod `"$script:LokiUrl/loki/api/v1/query_range?query=...`"" -ForegroundColor DarkGray
Write-Host ""
