@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"

echo.
echo ============================================================
echo   Trading AI - SAFE STOP
 echo ============================================================
echo.

if not exist "%~dp0.runtime" (
  echo No local runtime state found. Nothing to stop.
  pause
  exit /b 0
)

if exist "%~dp0.runtime\ai-handoff.pid" (
  for /f %%P in (%~dp0.runtime\ai-handoff.pid) do taskkill /PID %%P /T /F >nul 2>&1
  del "%~dp0.runtime\ai-handoff.pid" >nul 2>&1
)

for %%F in (backend frontend) do (
  if exist "%~dp0.runtime\%%F.pid" (
    for /f %%P in (%~dp0.runtime\%%F.pid) do (
      taskkill /PID %%P /T /F >nul 2>&1
      del "%~dp0.runtime\%%F.pid" >nul 2>&1
    )
  )
)

echo [OK] Only Trading AI local process trees were stopped.
echo.
pause
endlocal
