@echo off
chcp 65001 >nul
cd /d "%~dp0"
rem Keep this launcher ASCII-only: cmd parses a batch file before chcp can fix UTF-8 text.
echo ============================================
echo   Dual Agent Workbench
echo   Dashboard: http://127.0.0.1:3700
echo   Opening the browser shortly...
echo ============================================
rem Open as soon as the health page responds; do not impose a fixed startup delay.
start "" powershell -NoProfile -WindowStyle Hidden -Command "$u='http://127.0.0.1:3700'; for($i=0;$i -lt 100;$i++){try{$null=Invoke-WebRequest -UseBasicParsing -TimeoutSec 1 $u; Start-Process $u; break}catch{Start-Sleep -Milliseconds 100}}"
node controller\index.mjs
pause
