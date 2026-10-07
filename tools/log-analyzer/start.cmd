@echo off
chcp 65001 >nul
REM ── เริ่ม Log Analyzer UI ───────────────────────────────────────────
REM
REM  ก่อนใช้ปุ่ม "วิเคราะห์ด้วย AI" ต้องมีคีย์ในไฟล์ .env ของตัวเอง
REM    เปิด D:\2docx.com\tools\log-analyzer\.env  แล้วเพิ่มบรรทัดเดียว
REM      MINIMAX_API_KEY=<คีย์ของคุณ>
REM    แล้วปิด-เปิดหน้าต่างนี้ใหม่ (ไฟล์ .env ถูก .gitignore ไว้แล้ว)
REM
setlocal
set "HERE=%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo [x] ไม่พบ node ใน PATH
  pause
  exit /b 1
)
start "" http://127.0.0.1:3110
node "%HERE%server.mjs"
endlocal
