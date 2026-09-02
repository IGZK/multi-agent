@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ============================================
echo   双 Agent 协作工作台
echo   Dashboard: http://127.0.0.1:3700
echo   稍后会自动打开浏览器…
echo ============================================
rem 后台等待 4 秒后自动打开 Dashboard（服务启动通常需要几秒）
start "" cmd /c "timeout /t 4 /nobreak >nul & explorer http://127.0.0.1:3700"
node controller\index.mjs
pause
