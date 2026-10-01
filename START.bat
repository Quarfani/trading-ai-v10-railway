@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"

echo.
echo ============================================================
echo   Trading AI - LOCAL 4GB SAFE MODE (PAPER ONLY)
echo ============================================================
echo.

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\Ensure-LocalEnv.ps1"
if errorlevel 1 (
  echo [ERROR] Could not prepare local environment.
  pause
  exit /b 1
)

if not exist "%~dp0bot\backend\node_modules\tsx\dist\cli.mjs" (
  echo [ERROR] Backend dependencies are not installed.
  echo Run SETUP_WINDOWS.bat once, then rerun START.bat.
  pause
  exit /b 1
)
if not exist "%~dp0bot\frontend\node_modules\vite\bin\vite.js" (
  echo [ERROR] Frontend dependencies are not installed.
  echo Run SETUP_WINDOWS.bat once, then rerun START.bat.
  pause
  exit /b 1
)

if not exist "%~dp0.runtime" mkdir "%~dp0.runtime"

powershell -NoProfile -Command "$p=Start-Process -FilePath 'cmd.exe' -ArgumentList '/k','cd /d \"%~dp0bot\backend\" && set DEPLOYMENT_PROFILE=local && set MODE=paper && npm run dev' -PassThru; Set-Content -Path \"%~dp0.runtime\backend.pid\" -Value $p.Id"
if errorlevel 1 (
  echo [ERROR] Failed to start Trading Backend.
  pause
  exit /b 1
)

timeout /t 8 /nobreak >nul

powershell -NoProfile -Command "$p=Start-Process -FilePath 'cmd.exe' -ArgumentList '/k','cd /d \"%~dp0bot\frontend\" && npm run dev -- --host 127.0.0.1' -PassThru; Set-Content -Path \"%~dp0.runtime\frontend.pid\" -Value $p.Id"
if errorlevel 1 (
  echo [ERROR] Failed to start Dashboard.
  call "%~dp0STOP.bat"
  pause
  exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\AI-Development-Handoff-Watcher.ps1" -IntervalSeconds 60
timeout /t 5 /nobreak >nul
start "" http://localhost:3000

echo.
echo [OK] Local Paper Trading is running.
echo [OK] Trading API: http://localhost:4000
 echo [OK] Dashboard:   http://localhost:3000
echo [INFO] ML is intentionally OFF on the 4GB PC.
echo [INFO] Use STOP.bat to stop only this project's processes.
echo.
pause
endlocal
