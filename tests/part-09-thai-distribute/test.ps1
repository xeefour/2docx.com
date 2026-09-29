$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$env:PYTHONIOENCODING = 'utf-8'

$here = $PSScriptRoot
$outDir = Join-Path $here 'output'
New-Item -ItemType Directory -Force -Path $outDir | Out-Null
$curl = "$env:SystemRoot\System32\curl.exe"
$base = 'http://localhost:4000'

Write-Host ''
Write-Host 'ส่วนที่ 9: ทดสอบการกระจายย่อหน้าไทย (thaiDistribute)' -ForegroundColor Cyan

# ---------- 1. เตรียมแม่แบบ ----------
$tpl = Join-Path $here 'templates\หนังสือรับรอง.docx'
if (-not (Test-Path $tpl)) {
    Write-Host '  กำลังสร้างแม่แบบจากไฟล์ต้นฉบับ...' -ForegroundColor DarkGray
    & python (Join-Path $here 'make_template.py') 2>&1 |
        ForEach-Object { Write-Host "    $_" -ForegroundColor DarkGray }
}
& python (Join-Path $here 'make_variants.py') 2>&1 |
    Where-Object { $_ -match 'แก้|ย่อหน้าเนื้อหา' } |
    ForEach-Object { Write-Host "  $_" -ForegroundColor DarkGray }

# ---------- 2. อัปโหลดทั้ง 3 เวอร์ชัน ----------
$data = Get-Content (Join-Path $here 'data\ข้อมูล.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$pf = Join-Path $env:TEMP 'p9.json'

$variants = @(
    @{ Name = 'A-ไม่กระจาย';    File = 'แม่แบบ-A-ไม่กระจาย.docx' }
    @{ Name = 'B-thaiDistribute'; File = 'แม่แบบ-B-thaiDistribute.docx' }
    @{ Name = 'C-both';          File = 'แม่แบบ-C-both.docx' }
)

$ids = @{}
foreach ($v in $variants) {
    $path = Join-Path $outDir $v.File
    $up = Join-Path $env:TEMP "p9-$($v.Name).json"
    & $curl -s -o $up -X POST "$base/template" -H 'Authorization: Bearer carbon-ce' `
        -F "template=@$path" --max-time 120 2>$null
    $id = (Get-Content $up -Raw | ConvertFrom-Json).data.templateId
    $ids[$v.Name] = $id
    Write-Host "  อัปโหลด $($v.Name): $(if($id){'สำเร็จ'}else{'ล้มเหลว'})" -ForegroundColor DarkGray
}

# ---------- 3. สร้างเอกสารทั้ง DOCX และ PDF ----------
foreach ($v in $variants) {
    $id = $ids[$v.Name]
    if (-not $id) { continue }
    foreach ($fmt in @('docx', 'pdf')) {
        $b = ([ordered]@{ data = $data; convertTo = $fmt } | ConvertTo-Json -Depth 20 -Compress)
        [System.IO.File]::WriteAllText($pf, $b, (New-Object System.Text.UTF8Encoding($false)))
        $target = Join-Path $outDir "$($v.Name) ผลลัพธ์.$fmt"
        & $curl -s -o $target -X POST "$base/render/$id`?download=true" `
            -H 'Authorization: Bearer carbon-ce' -H 'Content-Type: application/json' `
            -H 'carbone-version: 5' --data-binary "@$pf" --max-time 200 2>$null
    }
}

# ---------- 4. ตรวจว่า LibreOffice รักษา thaiDistribute ไหม ----------
Write-Host ''
Write-Host '  [ตรวจค่า jc หลังผ่าน Carbone]' -ForegroundColor DarkGray
$check = @'
# -*- coding: utf-8 -*-
import os, re, zipfile
from collections import Counter
out = os.path.dirname(os.path.abspath(__file__))   # = output/
def ptext(p):
    parts = re.findall(r"<w:t(?:\s[^>]*)?>(.*?)</w:t>", p, re.S)
    s = "".join(parts)
    for a, b in [("&amp;","&"),("&lt;","<"),("&gt;",">"),("&quot;",'"'),("&apos;","'")]:
        s = s.replace(a, b)
    return s
for f in sorted(os.listdir(out)):
    if not f.endswith(".docx") or "ผลลัพธ์" not in f:
        continue
    with zipfile.ZipFile(os.path.join(out, f)) as z:
        xml = z.read("word/document.xml").decode("utf-8")
    paras = re.findall(r"<w:p(?:\s[^>]*)?>.*?</w:p>", xml, re.S)
    c = Counter()
    body_jc = "-"
    for px in paras:
        m = re.search(r'<w:jc w:val="([^"]+)"', px)
        if m:
            c[m.group(1)] += 1
        if "กรมการปกครอง" in ptext(px):
            body_jc = m.group(1) if m else "(ค่าเริ่มต้น)"
    print(f"    {f}")
    print(f"      ย่อหน้าเนื้อหาหลัก = {body_jc}")
    print(f"      thaiDistribute={c.get('thaiDistribute',0)}  both={c.get('both',0)}"
          f"  center={c.get('center',0)}")
'@
$ck = Join-Path $outDir '_check9.py'
[System.IO.File]::WriteAllText($ck, $check, (New-Object System.Text.UTF8Encoding($false)))
& python $ck 2>&1 | ForEach-Object { Write-Host $_ }

# ---------- 5. วัดการกระจายจริงจาก PDF ----------
foreach ($v in $variants) {
    $pdf = Join-Path $outDir "$($v.Name) ผลลัพธ์.pdf"
    if (Test-Path $pdf) {
        Write-Host ''
        Write-Host "  [วัดระยะบรรทัด: $($v.Name)]" -ForegroundColor DarkGray
        & python (Join-Path $here 'measure_align.py') $pdf $v.Name 2>&1 |
            Select-String 'บรรทัดที่ยืด|เหลือขวาเฉลี่ย|ไม่พบบรรทัด|เต็มขอบขวา' |
            ForEach-Object { Write-Host "    $($_.Line.Trim())" }
    }
}

Write-Host ''
Write-Host '  ไฟล์ผลลัพธ์อยู่ใน:' -ForegroundColor DarkGray
Write-Host "    $outDir" -ForegroundColor DarkGray
exit 0
