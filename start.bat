@echo off
setlocal
chcp 65001 >nul
rem Discover the application directory without embedding a non-ASCII folder name.
set "workbenchAppDir="
for /d %%D in ("%~dp0*") do if exist "%%~fD\controller\index.mjs" set "workbenchAppDir=%%~fD"
if not defined workbenchAppDir (
  echo Application directory not found. Please restore the complete checkout.
  pause
  exit /b 1
)
echo Dual Agent Workbench - the Dashboard address will appear below.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%workbenchAppDir%\start.ps1" %*
set "workbenchExitCode=%errorlevel%"
pause
exit /b %workbenchExitCode%
