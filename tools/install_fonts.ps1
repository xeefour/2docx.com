$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

# ติดตั้งฟอนต์ไทยจาก THSarabun.rar ลง Windows
# ใช้วิธี Shell.Application CopyHere ซึ่งเป็นวิธีมาตรฐานของ Windows
# (ไม่ต้องใช้ AddFontResource + registry เพราะเปราะกว่าและไม่ติดตั้งถาวร)

$src = 'D:\2docx.com\tests\lib\fonts\_จากrar'
$dst = "$env:WINDIR\Fonts"
$installed = 0
$failed = @()

Write-Host ''
Write-Host 'ติดตั้งฟอนต์ไทยจาก THSarabun.rar' -ForegroundColor Cyan

# รวบรวมไฟล์ .ttf ทั้งหมด (รวมไฟล์ซ้ำในสองโฟลเดอร์)
$files = @()
foreach ($folder in @("$src\THSarabunNew\THSarabunIT๙",
                     "$src\THSarabunNew\F0nt\THSarabunIT_",
                     "$src\THSarabunNew\F0nt\THSarabunNew")) {
    if (Test-Path $folder) {
        $files += Get-ChildItem $folder -Filter '*.ttf' -ErrorAction SilentlyContinue
    }
}

# ตัดไฟล์ซ้ำออก (ชุดที่มีชื่อไทย หรือชุด F0nt ไม่มีชื่อไทย)
$seen = @{}
$uniq = @()
foreach ($f in $files) {
    $key = (Get-FileHash $f.FullName -Algorithm MD5).Hash
    if (-not $seen.ContainsKey($key)) {
        $seen[$key] = $true
        $uniq += $f
    }
}
Write-Host "  พบ $($files.Count) ไฟล์, ไม่ซ้ำ $($uniq.Count) ไฟล์"
Write-Host ''

$shell = New-Object -ComObject Shell.Application

foreach ($f in $uniq) {
    $target = Join-Path $dst $f.Name
    try {
        # ข้ามถ้ามีอยู่แล้วและขนาดเท่ากัน
        if (Test-Path $target) {
            if ((Get-Item $target).Length -eq $f.Length) {
                Write-Host "  [ข้าม] มีอยู่แล้ว: $($f.Name)" -ForegroundColor DarkGray
                continue
            }
        }
        $folder = $shell.Namespace($f.DirectoryName)
        $item = $folder.ParseName($f.Name)
        $destFolder = $shell.Namespace($dst)
        # 0x14 = ไม่ถาม, ไม่แสดง UI
        $destFolder.CopyHere($item, 0x14)
        $installed++
        Write-Host "  [ติดตั้ง] $($f.Name)" -ForegroundColor Green
    } catch {
        $failed += $f.Name
        Write-Host "  [ล้มเหลว] $($f.Name) : $($_.Exception.Message)" -ForegroundColor Red
    }
}

Write-Host ''
Write-Host "สรุป: ติดตั้ง $installed ไฟล์, ล้มเหลว $($failed.Count) ไฟล์"
if ($failed.Count -gt 0) {
    Write-Host "  ล้มเหลว: $($failed -join ', ')" -ForegroundColor Red
    exit 1
}
exit 0
