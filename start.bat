@echo off
setlocal
rem Discover the application directory without embedding a non-ASCII folder name.
for /d %%D in ("%~dp0*") do if exist "%%~fD\controller\index.mjs" (
  call "%%~fD\start.bat" %*
  exit /b
)
echo Application directory not found. Please restore the complete checkout.
pause
exit /b 1
