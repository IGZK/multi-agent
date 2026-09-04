@echo off
chcp 65001 >nul
cd /d "%~dp0"
rem Keep this launcher ASCII-only: cmd parses a batch file before chcp can fix UTF-8 text.
echo ============================================
echo   Dual Agent Workbench
echo   The Dashboard address will appear below.
echo ============================================
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is missing. Install Node.js 22 or newer, then reopen this window.
  pause
  exit /b 1
)
node -e "import('playwright-core').catch(()=>process.exit(1))" >nul 2>nul
if errorlevel 1 (
  echo Installing workbench dependencies...
  call npm ci
  if errorlevel 1 (
    echo Dependency installation failed. Check your network and npm registry.
    pause
    exit /b 1
  )
)
node controller\index.mjs --open %*
set "workbenchExitCode=%errorlevel%"
pause
exit /b %workbenchExitCode%
