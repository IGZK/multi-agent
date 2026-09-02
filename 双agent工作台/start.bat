@echo off
chcp 65001 >nul
cd /d "%~dp0"
rem Keep this launcher ASCII-only: cmd parses a batch file before chcp can fix UTF-8 text.
echo ============================================
echo   Dual Agent Workbench
echo   Dashboard: http://127.0.0.1:3700
echo   Opening the browser shortly...
echo ============================================
rem Wait four seconds, then open the Dashboard while Node starts.
start "" cmd /c "timeout /t 4 /nobreak >nul & explorer http://127.0.0.1:3700"
node controller\index.mjs
pause
